"""Immutable synthetic snapshot references; temporary files, no transport."""
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import stat

import pytest


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("snapshot tests cannot use network transport")

    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)


@pytest.fixture
def raw_snapshot():
    with sqlite3.connect(":memory:") as connection:
        connection.execute("CREATE TABLE synthetic_evidence (quote TEXT NOT NULL)")
        connection.execute("INSERT INTO synthetic_evidence VALUES (?)", ("原创虚构记录，不含真实患者资料",))
        connection.commit()
        return connection.serialize()


@pytest.fixture
def snapshot_root(tmp_path):
    root = tmp_path.resolve() / "exclusive-synthetic-claims"
    root.mkdir()
    return root


def test_failed_write_keeps_partial_file_without_returning_reference(
    raw_snapshot, snapshot_root, monkeypatch
):
    from backend.trial_snapshot import store_snapshot

    filename = hashlib.sha256(raw_snapshot).hexdigest() + ".sqlite3"
    expected = snapshot_root / "snapshots" / filename
    original_write = os.write
    writes = 0

    def interrupted_write(fd, data):
        nonlocal writes
        writes += 1
        if writes == 1:
            return original_write(fd, data[:64])
        raise OSError("injected synthetic disk write failure")

    reference = None
    with monkeypatch.context() as patch:
        patch.setattr(os, "write", interrupted_write)
        with pytest.raises(OSError):
            reference = store_snapshot(raw_snapshot, snapshot_root)

    assert reference is None
    assert expected.read_bytes() == raw_snapshot[:64]
    before = expected.read_bytes()
    with pytest.raises((ValueError, OSError)):
        store_snapshot(raw_snapshot, snapshot_root)
    assert expected.read_bytes() == before


def decode_reference(reference):
    header, payload = reference.split(b"\n", 1)
    return header, json.loads(payload)


def changed_reference(reference, mutation):
    header, value = decode_reference(reference)
    mutation(value)
    return header + b"\n" + json.dumps(
        value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("ascii")


def test_new_reference_roundtrip_keeps_original_source_and_only_small_blob(
    raw_snapshot, snapshot_root, tmp_path
):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    original = tmp_path / "original-closed-synthetic.sqlite3"
    original.write_bytes(raw_snapshot)
    reference = store_snapshot(raw_snapshot, snapshot_root)
    header, value = decode_reference(reference)
    assert header == b"NoReset-snapshot-reference-v1"
    assert set(value) == {"schema_version", "sha256", "byte_length", "path"}
    assert value["schema_version"] == "noreset-sqlite-snapshot-reference-v1"
    assert value["sha256"] == hashlib.sha256(raw_snapshot).hexdigest()
    assert value["byte_length"] == len(raw_snapshot)
    assert value["path"] == str(snapshot_root / "snapshots" / (value["sha256"] + ".sqlite3"))
    assert len(reference) < 4096 and len(reference) < len(raw_snapshot)
    assert Path(value["path"]).read_bytes() == raw_snapshot
    assert load_snapshot(reference, snapshot_root) == raw_snapshot
    assert original.read_bytes() == raw_snapshot


def test_legacy_raw_returns_identical_bytes_without_creating_reference_files(raw_snapshot, tmp_path):
    from backend.trial_snapshot import load_snapshot

    unused_root = tmp_path / "legacy-does-not-need-file-storage"
    assert load_snapshot(raw_snapshot, unused_root) is raw_snapshot
    assert not unused_root.exists()


def test_existing_exact_file_is_reused_without_changes(raw_snapshot, snapshot_root):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    reference = store_snapshot(raw_snapshot, snapshot_root)
    file = Path(decode_reference(reference)[1]["path"])
    before = file.stat()
    assert store_snapshot(raw_snapshot, snapshot_root) == reference
    after = file.stat()
    assert (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_mode) == (
        after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_mode
    )
    assert list(file.parent.iterdir()) == [file]
    assert load_snapshot(reference, snapshot_root) == raw_snapshot


def test_distinct_snapshot_keeps_previous_file_and_reference(raw_snapshot, snapshot_root):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    first = store_snapshot(raw_snapshot, snapshot_root)
    with sqlite3.connect(":memory:") as connection:
        connection.deserialize(raw_snapshot)
        connection.execute("INSERT INTO synthetic_evidence VALUES (?)", ("另一条原创虚构证据",))
        connection.commit()
        second_raw = connection.serialize()
    second = store_snapshot(second_raw, snapshot_root)
    assert second != first
    assert load_snapshot(first, snapshot_root) == raw_snapshot
    assert load_snapshot(second, snapshot_root) == second_raw
    assert len(list((snapshot_root / "snapshots").iterdir())) == 2


@pytest.mark.parametrize("damage", ["same_length_corruption", "partial", "trailing"])
def test_damaged_file_is_rejected_and_never_overwritten(raw_snapshot, snapshot_root, damage):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    reference = store_snapshot(raw_snapshot, snapshot_root)
    file = Path(decode_reference(reference)[1]["path"])
    damaged = {
        "same_length_corruption": raw_snapshot[:-1] + bytes([raw_snapshot[-1] ^ 1]),
        "partial": raw_snapshot[:64],
        "trailing": raw_snapshot + b"extra bytes",
    }[damage]
    file.chmod(0o600)
    file.write_bytes(damaged)
    with pytest.raises(ValueError):
        load_snapshot(reference, snapshot_root)
    with pytest.raises(ValueError):
        store_snapshot(raw_snapshot, snapshot_root)
    assert file.read_bytes() == damaged


def test_missing_file_does_not_create_or_substitute_evidence(raw_snapshot, snapshot_root):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    reference = store_snapshot(raw_snapshot, snapshot_root)
    file = Path(decode_reference(reference)[1]["path"])
    held = file.with_name("held-original.sqlite3")
    file.rename(held)
    with pytest.raises(OSError):
        load_snapshot(reference, snapshot_root)
    assert not file.exists()
    assert held.read_bytes() == raw_snapshot


@pytest.mark.parametrize("target", ["inside", "outside"])
def test_snapshot_symlink_is_rejected_for_loading_and_reuse(
    raw_snapshot, snapshot_root, tmp_path, target
):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    reference = store_snapshot(raw_snapshot, snapshot_root)
    file = Path(decode_reference(reference)[1]["path"])
    held = file.with_name("held-original.sqlite3")
    file.rename(held)
    outside = tmp_path / "outside-synthetic.sqlite3"
    outside.write_bytes(raw_snapshot)
    file.symlink_to(held if target == "inside" else outside)
    with pytest.raises(OSError):
        load_snapshot(reference, snapshot_root)
    with pytest.raises(OSError):
        store_snapshot(raw_snapshot, snapshot_root)
    assert file.is_symlink()
    assert held.read_bytes() == outside.read_bytes() == raw_snapshot


@pytest.mark.parametrize("level", ["root", "snapshots", "ancestor"])
def test_symlink_directory_cannot_redirect_snapshot_evidence(
    raw_snapshot, snapshot_root, tmp_path, level
):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    reference = store_snapshot(raw_snapshot, snapshot_root)
    root = snapshot_root
    if level == "root":
        root = tmp_path / "symlinked-root"
        root.symlink_to(snapshot_root, target_is_directory=True)
        reference = changed_reference(reference, lambda d: d.update(path=str(root / "snapshots" / (d["sha256"] + ".sqlite3"))))
    elif level == "ancestor":
        alias = tmp_path / "symlinked-parent"
        alias.symlink_to(tmp_path, target_is_directory=True)
        root = alias / snapshot_root.name
        reference = changed_reference(reference, lambda d: d.update(path=str(root / "snapshots" / (d["sha256"] + ".sqlite3"))))
    else:
        original_directory = root / "snapshots"
        held = root / "held-snapshots"
        original_directory.rename(held)
        original_directory.symlink_to(held, target_is_directory=True)
    with pytest.raises((ValueError, OSError)):
        load_snapshot(reference, root)
    with pytest.raises((ValueError, OSError)):
        store_snapshot(raw_snapshot, root)


@pytest.mark.parametrize("kind", ["directory", "fifo", "hardlink"])
def test_nonregular_or_aliased_file_cannot_be_a_snapshot(
    raw_snapshot, snapshot_root, tmp_path, kind
):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    reference = store_snapshot(raw_snapshot, snapshot_root)
    file = Path(decode_reference(reference)[1]["path"])
    file.rename(file.with_name("held-original.sqlite3"))
    if kind == "directory":
        file.mkdir()
    elif kind == "fifo":
        os.mkfifo(file)
    else:
        outside = tmp_path / "outside-hardlink.sqlite3"
        outside.write_bytes(raw_snapshot)
        os.link(outside, file)
    with pytest.raises((ValueError, OSError)):
        load_snapshot(reference, snapshot_root)
    with pytest.raises((ValueError, OSError)):
        store_snapshot(raw_snapshot, snapshot_root)


@pytest.mark.parametrize("mutation", [
    lambda d: d.update(schema_version="noreset-sqlite-snapshot-reference-v2"),
    lambda d: d.update(extra="not allowed"),
    lambda d: d.pop("sha256"),
    lambda d: d.update(sha256=d["sha256"].upper()),
    lambda d: d.update(sha256="0" * 64),
    lambda d: d.update(byte_length=True),
    lambda d: d.update(byte_length=0),
    lambda d: d.update(byte_length=-1),
    lambda d: d.update(byte_length=1.5),
    lambda d: d.update(byte_length="8192"),
    lambda d: d.update(byte_length=1 << 31),
    lambda d: d.update(path="../outside.sqlite3"),
    lambda d: d.update(path=d["path"] + "/../different.sqlite3"),
    lambda d: d.update(path=42),
])
def test_reference_fields_are_strict_and_cannot_escape_root(raw_snapshot, snapshot_root, mutation):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    reference = store_snapshot(raw_snapshot, snapshot_root)
    before = Path(decode_reference(reference)[1]["path"]).read_bytes()
    with pytest.raises(ValueError):
        load_snapshot(changed_reference(reference, mutation), snapshot_root)
    assert Path(decode_reference(reference)[1]["path"]).read_bytes() == before


@pytest.mark.parametrize("encoding", ["trailing_space", "trailing_JSON", "noncanonical", "duplicate", "bad_magic", "oversized"])
def test_reference_encoding_has_no_alternate_or_trailing_form(raw_snapshot, snapshot_root, encoding):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    reference = store_snapshot(raw_snapshot, snapshot_root)
    header, value = decode_reference(reference)
    malformed = {
        "trailing_space": reference + b"\n ",
        "trailing_JSON": reference + b"{}",
        "noncanonical": header + b"\n" + json.dumps(value, indent=2).encode(),
        "duplicate": header + b"\n" + b'{"sha256":"' + value["sha256"].encode() + b'",' + reference.split(b"\n", 1)[1][1:],
        "bad_magic": reference.replace(b"reference-v1\n", b"reference-v2\n", 1),
        "oversized": header + b"\n" + b"x" * 4096,
    }[encoding]
    with pytest.raises(ValueError):
        load_snapshot(malformed, snapshot_root)
    assert load_snapshot(reference, snapshot_root) == raw_snapshot


@pytest.mark.parametrize("bad", [None, bytearray(b"x"), b"", b"SQLite format 3\x00", b"SQLite format 3\x00" + b"\x00" * 4080])
def test_invalid_raw_header_or_type_never_creates_snapshot_files(snapshot_root, bad):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    with pytest.raises(ValueError):
        store_snapshot(bad, snapshot_root)
    with pytest.raises(ValueError):
        load_snapshot(bad, snapshot_root)
    assert not (snapshot_root / "snapshots").exists()


@pytest.mark.parametrize("root", [None, False, Path("relative"), Path("/tmp/../outside")])
def test_new_storage_requires_explicit_absolute_root(raw_snapshot, root):
    from backend.trial_snapshot import store_snapshot

    with pytest.raises(ValueError):
        store_snapshot(raw_snapshot, root)


def test_fsync_failure_returns_no_pointer_and_preserves_written_file(
    raw_snapshot, snapshot_root, monkeypatch
):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    (snapshot_root / "snapshots").mkdir()
    file = snapshot_root / "snapshots" / (hashlib.sha256(raw_snapshot).hexdigest() + ".sqlite3")
    original_fsync = os.fsync

    def failing_fsync(fd):
        if stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("injected synthetic file fsync failure")
        return original_fsync(fd)

    reference = None
    with monkeypatch.context() as patch:
        patch.setattr(os, "fsync", failing_fsync)
        with pytest.raises(OSError):
            reference = store_snapshot(raw_snapshot, snapshot_root)
    assert reference is None
    assert file.read_bytes() == raw_snapshot
    inode = file.stat().st_ino
    reference = store_snapshot(raw_snapshot, snapshot_root)
    assert file.stat().st_ino == inode
    assert load_snapshot(reference, snapshot_root) == raw_snapshot


def test_noncanonical_double_slash_root_cannot_create_a_reference(raw_snapshot, snapshot_root):
    from backend.trial_snapshot import store_snapshot

    noncanonical = Path("/" + str(snapshot_root))
    assert noncanonical != snapshot_root
    with pytest.raises(ValueError):
        store_snapshot(raw_snapshot, noncanonical)
    assert not (snapshot_root / "snapshots").exists()


def test_symlink_loop_root_is_rejected_without_changing_original_snapshot(
    raw_snapshot, snapshot_root, tmp_path
):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    original = store_snapshot(raw_snapshot, snapshot_root)
    loop = tmp_path / "loop-root"
    loop.symlink_to(loop, target_is_directory=True)
    reference = changed_reference(original, lambda d: d.update(path=str(loop / "snapshots" / (d["sha256"] + ".sqlite3"))))
    with pytest.raises((ValueError, OSError)):
        store_snapshot(raw_snapshot, loop)
    with pytest.raises((ValueError, OSError)):
        load_snapshot(reference, loop)
    assert loop.is_symlink()
    assert load_snapshot(original, snapshot_root) == raw_snapshot


def test_failed_parent_directory_sync_is_not_bypassed_when_directory_already_exists(
    raw_snapshot, snapshot_root, monkeypatch
):
    from backend.trial_snapshot import load_snapshot, store_snapshot

    file = snapshot_root / "snapshots" / (hashlib.sha256(raw_snapshot).hexdigest() + ".sqlite3")

    def failing_parent_sync(fd):
        raise OSError("injected synthetic parent-directory sync failure")

    with monkeypatch.context() as patch:
        patch.setattr(os, "fsync", failing_parent_sync)
        for _ in range(2):
            with pytest.raises(OSError):
                store_snapshot(raw_snapshot, snapshot_root)
            assert (snapshot_root / "snapshots").is_dir()
            assert not file.exists(), "the parent must be durable before evidence file creation"

    reference = store_snapshot(raw_snapshot, snapshot_root)
    assert load_snapshot(reference, snapshot_root) == raw_snapshot
