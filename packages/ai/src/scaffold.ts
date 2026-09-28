/**
 * Deterministic scaffolding for Python/FastAPI services. Infrastructure with a fixed shape
 * (database wiring, the side-effect outbox, test fixtures) is templated, not generated —
 * the model writes domain code and test cases against these known interfaces.
 */
export const PY_SCAFFOLD: Record<string, string> = {
  "db.py": `import os
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./dev.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
`,
  "outbox.py": `"""Side effects (emails, webhooks) are recorded here instead of leaving the process."""
import logging
from typing import Dict, List

log = logging.getLogger("outbox")
OUTBOX: List[Dict[str, str]] = []


def send(to: str, subject: str, body: str) -> None:
    OUTBOX.append({"to": to, "subject": subject, "body": body})
    log.info("outbox → %s: %s", to, subject)


def latest(subject_contains: str = "") -> Dict[str, str]:
    """Most recent message whose subject contains the given text."""
    for message in reversed(OUTBOX):
        if subject_contains.lower() in message["subject"].lower():
            return message
    raise LookupError(f"no message matching {subject_contains!r}")


def reset_memory() -> None:
    OUTBOX.clear()
`,
  "kv.py": `"""Key-value store for sessions, refresh tokens, rate limits and caches.

Uses Redis when REDIS_URL is set; otherwise an in-memory store with the same interface,
so the service runs (and tests pass) with no infrastructure at all.
"""
import os
import threading
import time
from typing import Dict, Optional, Tuple


class MemoryStore:
    def __init__(self) -> None:
        self._data: Dict[str, Tuple[str, Optional[float]]] = {}
        self._lock = threading.Lock()

    def _live(self, key: str) -> Optional[str]:
        item = self._data.get(key)
        if item is None:
            return None
        value, expires = item
        if expires is not None and expires <= time.time():
            self._data.pop(key, None)
            return None
        return value

    def get(self, key: str) -> Optional[str]:
        with self._lock:
            return self._live(key)

    def set(self, key: str, value, ex: Optional[int] = None) -> bool:
        with self._lock:
            self._data[key] = (str(value), time.time() + ex if ex else None)
            return True

    def incr(self, key: str) -> int:
        with self._lock:
            current = self._live(key)
            expires = self._data[key][1] if current is not None else None
            value = int(current or 0) + 1
            self._data[key] = (str(value), expires)
            return value

    def expire(self, key: str, seconds: int) -> bool:
        with self._lock:
            value = self._live(key)
            if value is None:
                return False
            self._data[key] = (value, time.time() + seconds)
            return True

    def ttl(self, key: str) -> int:
        with self._lock:
            if self._live(key) is None:
                return -2
            expires = self._data[key][1]
            return -1 if expires is None else max(0, int(expires - time.time()))

    def delete(self, *keys: str) -> int:
        with self._lock:
            return sum(1 for k in keys if self._data.pop(k, None) is not None)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


REDIS_URL = os.getenv("REDIS_URL")
if REDIS_URL:
    import redis

    client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
else:
    client = MemoryStore()


def reset_memory() -> None:
    if isinstance(client, MemoryStore):
        client.clear()
`,
  "tests/conftest.py": `import os
import sys
import tempfile
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
os.environ["DATABASE_URL"] = f"sqlite:///{Path(tempfile.mkdtemp()) / 'test.db'}"
os.environ["BCRYPT_ROUNDS"] = "4"
os.environ.pop("REDIS_URL", None)
sys.path.insert(0, str(SERVICE_DIR))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from db import Base, engine  # noqa: E402
from main import app  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_state():
    """Fresh database and empty in-memory state (outbox, sessions, rate limits) for every test."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    for module in list(sys.modules.values()):
        if str(getattr(module, "__file__", "") or "").startswith(str(SERVICE_DIR)):
            reset = getattr(module, "reset_memory", None)
            if callable(reset):
                reset()
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)
`,
}
