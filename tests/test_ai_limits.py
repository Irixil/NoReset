from concurrent.futures import ThreadPoolExecutor

from backend.ai_limits import AIRequestLimiter


def test_session_and_instance_sliding_windows_expire():
    limiter = AIRequestLimiter(session_requests=2, instance_requests=2)
    assert limiter.acquire("session-a", now=100) is None
    limiter.release("session-a")
    assert limiter.acquire("session-a", now=101) is None
    limiter.release("session-a")
    assert limiter.acquire("session-a", now=102) == 58
    assert limiter.acquire("session-b", now=102) == 58
    assert limiter.acquire("session-a", now=160) is None


def test_concurrency_limits_apply_per_session_and_instance():
    limiter = AIRequestLimiter(
        session_requests=100,
        instance_requests=100,
        session_concurrency=1,
        instance_concurrency=2,
    )
    assert limiter.acquire("session-a", now=100) is None
    assert limiter.acquire("session-a", now=100) == 1
    assert limiter.acquire("session-b", now=100) is None
    assert limiter.acquire("session-c", now=100) == 1
    limiter.release("session-a")
    assert limiter.acquire("session-a", now=100) is None


def test_session_table_stays_bounded_and_frees_expired_sessions():
    limiter = AIRequestLimiter(max_sessions=1)
    assert limiter.acquire("session-a", now=100) is None
    limiter.release("session-a")
    assert limiter.acquire("session-b", now=101) == 60
    assert limiter.acquire("session-b", now=161) is None


def test_acquire_is_thread_safe_under_same_session_burst():
    limiter = AIRequestLimiter(
        session_requests=100,
        instance_requests=100,
        session_concurrency=3,
        instance_concurrency=100,
    )
    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda _: limiter.acquire("session-a", now=100), range(20)))
    assert results.count(None) == 3
    assert all(value == 1 for value in results if value is not None)
