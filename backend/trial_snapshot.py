"""Content-addressed immutable SQLite evidence, without authorization changes.

Only newly stored snapshots use references. Existing raw SQLite BLOBs remain
byte-identical; their original gate still checks SQLite integrity and history.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat

__all__ = ["store_snapshot", "load_snapshot"]

_SQLITE_HEADER = b"SQLite format 3\x00"
_REFERENCE_HEADER = b"NoReset-snapshot-reference-v1\n"
_SCHEMA = "noreset-sqlite-snapshot-reference-v1"
_MAX_ENVELOPE_BYTES = 4096
_MAX_REFERENCED_BYTES = (1 << 31) - 1
_CHUNK = 1024 * 1024


def _sqlite_header(raw):
    if not isinstance(raw, bytes) or len(raw) < 100 or not raw.startswith(_SQLITE_HEADER):
        raise ValueError("original_sqlite_snapshot_required")
    page_size = int.from_bytes(raw[16:18], "big")
    page_size = 65536 if page_size == 1 else page_size
    if (page_size not in {512, 1024, 2048, 4096, 8192, 16384, 32768, 65536}
            or len(raw) % page_size or raw[18] not in {1, 2} or raw[19] not in {1, 2}):
        raise ValueError("complete_sqlite_snapshot_header_required")


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("ascii")


def _root_path(root):
    try:
        path = Path(root)
    except TypeError:
        raise ValueError("absolute_snapshot_root_required") from None
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("absolute_snapshot_root_without_parent_escape_required")
    try:
        resolved = path.resolve()
    except RuntimeError:
        raise ValueError("snapshot_root_symlink_loop_rejected") from None
    if resolved != path:
        raise ValueError("canonical_snapshot_root_without_symlinks_required")
    return path


def _directory_fd(path):
    """Anchor every directory component; never follow an ancestor symlink."""
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise OSError("safe_snapshot_directory_operations_unavailable")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(path.anchor, flags)
    try:
        for component in path.parts[1:]:
            next_fd = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextmanager
def _snapshot_directory(root, *, create):
    path = _root_path(root)
    root_fd = _directory_fd(path)
    snapshot_fd = None
    try:
        if create:
            try:
                os.mkdir("snapshots", mode=0o700, dir_fd=root_fd)
            except FileExistsError:
                pass
            os.fsync(root_fd)
        snapshot_fd = os.open("snapshots", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=root_fd)
        yield path / "snapshots", snapshot_fd
    finally:
        if snapshot_fd is not None:
            os.close(snapshot_fd)
        os.close(root_fd)


def _file_identity(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mode, value.st_nlink,
            value.st_mtime_ns, value.st_ctime_ns)


def _verify_file(fd, directory_fd, filename, length, digest, *, expected=None):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != length:
        raise ValueError("exact_regular_snapshot_file_required")
    os.lseek(fd, 0, os.SEEK_SET)
    if expected is None:
        with os.fdopen(fd, "rb", closefd=False) as stream:
            result = stream.read(length + 1)
        if len(result) != length or hashlib.sha256(result).hexdigest() != digest:
            raise ValueError("snapshot_content_or_length_changed")
        _sqlite_header(result)
    else:
        result = None
        offset = 0
        observed = hashlib.sha256()
        original = memoryview(expected)
        while offset < length:
            chunk = os.read(fd, min(_CHUNK, length - offset))
            if not chunk or chunk != original[offset:offset + len(chunk)]:
                raise ValueError("existing_snapshot_bytes_must_be_identical")
            observed.update(chunk)
            offset += len(chunk)
        if os.read(fd, 1) or observed.hexdigest() != digest:
            raise ValueError("snapshot_content_or_length_changed")
    after = os.fstat(fd)
    current = os.stat(filename, dir_fd=directory_fd, follow_symlinks=False)
    if _file_identity(before) != _file_identity(after) or _file_identity(after) != _file_identity(current):
        raise ValueError("snapshot_changed_during_read")
    return result


def store_snapshot(raw: bytes, root: Path) -> bytes:
    """Return a small reference only after a durable, exact exclusive write.

    Failed or preexisting partial files stay untouched and cannot be reused.
    The caller must supply an existing absolute directory with no symlinks.
    """
    _sqlite_header(raw)
    if len(raw) > _MAX_REFERENCED_BYTES:
        raise ValueError("referenced_snapshot_size_exceeds_engineering_bound")
    digest = hashlib.sha256(raw).hexdigest()
    filename = digest + ".sqlite3"
    with _snapshot_directory(root, create=True) as (directory, directory_fd):
        envelope = _REFERENCE_HEADER + _canonical({
            "schema_version": _SCHEMA, "sha256": digest, "byte_length": len(raw),
            "path": str(directory / filename),
        })
        if len(envelope) > _MAX_ENVELOPE_BYTES:
            raise ValueError("snapshot_reference_too_large")
        try:
            fd = os.open(filename, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory_fd)
            created = True
        except FileExistsError:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=directory_fd)
            created = False
        try:
            if created:
                view = memoryview(raw)
                offset = 0
                while offset < len(raw):
                    count = os.write(fd, view[offset:offset + _CHUNK])
                    if count <= 0:
                        raise OSError("snapshot_write_did_not_progress")
                    offset += count
                os.fsync(fd)
            _verify_file(fd, directory_fd, filename, len(raw), digest, expected=raw)
            if created:
                os.fchmod(fd, 0o400)
            os.fsync(fd)
            os.fsync(directory_fd)
        finally:
            os.close(fd)
    return envelope


def load_snapshot(encoded: bytes, root: Path) -> bytes:
    """Return original bytes after strict reference/file checks, or legacy raw."""
    if not isinstance(encoded, bytes):
        raise ValueError("snapshot_encoding_must_be_bytes")
    if encoded.startswith(_SQLITE_HEADER):
        _sqlite_header(encoded)
        return encoded
    if not encoded.startswith(_REFERENCE_HEADER) or len(encoded) > _MAX_ENVELOPE_BYTES:
        raise ValueError("snapshot_reference_format_invalid")
    payload = encoded[len(_REFERENCE_HEADER):]
    try:
        value = json.loads(payload.decode("ascii"))
    except (UnicodeError, ValueError):
        raise ValueError("snapshot_reference_format_invalid") from None
    if (not isinstance(value, dict) or set(value) != {"schema_version", "sha256", "byte_length", "path"}
            or value["schema_version"] != _SCHEMA or _canonical(value) != payload
            or not isinstance(value["sha256"], str) or not re.fullmatch("[0-9a-f]{64}", value["sha256"])
            or type(value["byte_length"]) is not int
            or not 0 < value["byte_length"] <= _MAX_REFERENCED_BYTES
            or not isinstance(value["path"], str)):
        raise ValueError("snapshot_reference_fields_invalid")
    filename = value["sha256"] + ".sqlite3"
    directory = _root_path(root) / "snapshots"
    if value["path"] != str(directory / filename):
        raise ValueError("snapshot_reference_path_invalid")
    with _snapshot_directory(root, create=False) as (_, directory_fd):
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
        try:
            return _verify_file(fd, directory_fd, filename, value["byte_length"], value["sha256"])
        finally:
            os.close(fd)
