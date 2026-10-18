"""Bounded in-process request limits for metered AI routes.

ponytail: one process-local window avoids dependencies; it is not a cross-instance
or durable billing quota. Use gateway/provider budgets for that ceiling.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque


class AIRequestLimiter:
    def __init__(
        self,
        *,
        window_seconds: int = 60,
        session_requests: int = 12,
        instance_requests: int = 120,
        session_concurrency: int = 2,
        instance_concurrency: int = 8,
        max_sessions: int = 4096,
    ) -> None:
        values = (window_seconds, session_requests, instance_requests, session_concurrency, instance_concurrency, max_sessions)
        if any(type(value) is not int or value < 1 for value in values):
            raise ValueError("AI limits must be positive integers")
        self.window_seconds = window_seconds
        self.session_requests = session_requests
        self.instance_requests = instance_requests
        self.session_concurrency = session_concurrency
        self.instance_concurrency = instance_concurrency
        self.max_sessions = max_sessions
        self._lock = threading.Lock()
        self._events: deque[float] = deque()
        self._sessions: dict[str, deque[float]] = {}
        self._active_by_session: dict[str, int] = {}
        self._active = 0

    @staticmethod
    def _prune_events(events: deque[float], cutoff: float) -> None:
        while events and events[0] <= cutoff:
            events.popleft()

    def _prune_sessions(self, cutoff: float) -> None:
        for key, events in tuple(self._sessions.items()):
            self._prune_events(events, cutoff)
            if not events and not self._active_by_session.get(key):
                self._sessions.pop(key, None)

    def acquire(self, session_key: str, now: float | None = None) -> int | None:
        """Return None when admitted, otherwise a minimum Retry-After in seconds."""
        if not isinstance(session_key, str) or not session_key:
            return self.window_seconds
        current = time.monotonic() if now is None else now
        cutoff = current - self.window_seconds
        with self._lock:
            self._prune_events(self._events, cutoff)
            events = self._sessions.get(session_key)
            if events is None and len(self._sessions) >= self.max_sessions:
                self._prune_sessions(cutoff)
                events = self._sessions.get(session_key)
                if events is None and len(self._sessions) >= self.max_sessions:
                    return self.window_seconds
            if events is not None:
                self._prune_events(events, cutoff)
            if events and len(events) >= self.session_requests:
                return max(1, math.ceil(self.window_seconds - (current - events[0])))
            if len(self._events) >= self.instance_requests:
                return max(1, math.ceil(self.window_seconds - (current - self._events[0])))
            active = self._active_by_session.get(session_key, 0)
            if active >= self.session_concurrency or self._active >= self.instance_concurrency:
                return 1
            if events is None:
                events = self._sessions[session_key] = deque()
            events.append(current)
            self._events.append(current)
            self._active_by_session[session_key] = active + 1
            self._active += 1
            return None

    def release(self, session_key: str) -> None:
        with self._lock:
            active = self._active_by_session.get(session_key, 0)
            if active <= 1:
                self._active_by_session.pop(session_key, None)
            else:
                self._active_by_session[session_key] = active - 1
            self._active = max(0, self._active - 1)

    def reset(self) -> None:
        with self._lock:
            self._events.clear()
            self._sessions.clear()
            self._active_by_session.clear()
            self._active = 0
