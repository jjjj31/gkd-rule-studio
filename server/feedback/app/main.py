from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import html
import ipaddress
import json
import logging
import os
import re
import secrets
import shutil
import smtplib
import sqlite3
import ssl
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager, closing
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import parseaddr
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import quote, urljoin, urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles


APP_DIR = Path(__file__).resolve().parent
WEB_DIR = APP_DIR / "web"
LOGGER = logging.getLogger("feedback")

FEEDBACK_BODY_LIMIT = 12 * 1024 * 1024
ATTACHMENT_BYTE_LIMIT = 8 * 1024 * 1024
ATTACHMENT_COUNT_LIMIT = 4
PBKDF2_ITERATIONS = 600_000
PBKDF2_MIN_ITERATIONS = 100_000
SESSION_COOKIE = "feedback_admin_session"
SESSION_SECONDS = 8 * 60 * 60
IP_HASH_SALT_BYTES = 32
DAILY_BUDGET_RETENTION_DAYS = 2
MAX_SUBMIT_CONCURRENCY = 2
CONTENT_TYPES = {
    "image/png": (b"\x89PNG\r\n\x1a\n", "png"),
    "text/plain": (None, "txt"),
    "application/json": (None, "json"),
    "application/zip": (b"PK", "zip"),
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('tool', 'rule', 'feature')),
    description TEXT NOT NULL,
    contact TEXT NOT NULL,
    context_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'resolved')),
    total_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_created_at_idx
    ON feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    storage_name TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS attachments_feedback_idx
    ON attachments(feedback_id);

CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id TEXT NOT NULL UNIQUE REFERENCES feedback(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    sent_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due_idx
    ON outbox(sent_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx
    ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS feedback_budget (
    utc_day TEXT NOT NULL,
    scope TEXT NOT NULL,
    entry_count INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    PRIMARY KEY (utc_day, scope)
);
CREATE INDEX IF NOT EXISTS feedback_budget_day_idx
    ON feedback_budget(utc_day);

CREATE TABLE IF NOT EXISTS announcement (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('notice', 'update')),
    forced INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    version_name TEXT,
    version_code INTEGER,
    apk_url TEXT,
    mirrors_json TEXT,
    sha256 TEXT,
    action_url TEXT,
    action_text TEXT
);

CREATE TABLE IF NOT EXISTS announcement_history (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL,
    forced INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    version_name TEXT,
    version_code INTEGER,
    apk_url TEXT,
    mirrors_json TEXT,
    sha256 TEXT,
    action_url TEXT,
    action_text TEXT,
    published_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS announcement_history_published_idx
    ON announcement_history(published_at DESC);
"""


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} 必须是整数") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} 超出允许范围")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, "true" if default else "false").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} 必须是布尔值")


def _single_line_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if "\r" in value or "\n" in value:
        raise RuntimeError(f"{name} 不能包含换行")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    data_dir: Path
    admin_username: str = ""
    admin_password_hash: str = ""
    session_secure: bool = True
    trusted_proxy_ips: str = ""
    public_base_url: str = "https://feedback.kmttjnm.me"
    allowed_origins: str = ""
    submit_rate_count: int = 30
    submit_rate_window: int = 60
    submit_daily_ip_count: int = 20
    submit_daily_ip_bytes: int = 16 * 1024 * 1024
    submit_daily_global_count: int = 200
    submit_daily_global_bytes: int = 64 * 1024 * 1024
    submit_concurrency: int = MAX_SUBMIT_CONCURRENCY
    login_rate_count: int = 10
    login_rate_window: int = 15 * 60
    max_feedback_count: int = 10_000
    max_storage_bytes: int = 512 * 1024 * 1024
    min_free_disk_bytes: int = 64 * 1024 * 1024
    retention_days: int = 90
    maintenance_interval: int = 60 * 60
    outbox_poll_interval: int = 30
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_security: str = "starttls"
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_to: str = "3428864257@qq.com"
    smtp_timeout: int = 15

    @property
    def db_path(self) -> Path:
        return self.data_dir / "feedback.sqlite3"

    @property
    def attachments_dir(self) -> Path:
        return self.data_dir / "attachments"

    @property
    def ip_hash_salt_path(self) -> Path:
        return self.data_dir / "ip_hash_salt"

    @property
    def public_origin(self) -> str:
        parsed = urlsplit(self.public_base_url)
        return f"{parsed.scheme}://{parsed.netloc}"

    @property
    def public_path_prefix(self) -> str:
        return urlsplit(self.public_base_url).path.rstrip("/")

    @property
    def admin_cookie_path(self) -> str:
        return self.public_path_prefix + "/admin"

    def __post_init__(self) -> None:
        parsed = urlsplit(self.public_base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("PUBLIC_BASE_URL 必须是无查询参数的 HTTP(S) 基础 URL")
        if not 1 <= self.submit_concurrency <= MAX_SUBMIT_CONCURRENCY:
            raise ValueError("SUBMIT_CONCURRENCY 必须在 1 到 2 之间")
        for name, value in (
            ("SUBMIT_DAILY_IP_COUNT", self.submit_daily_ip_count),
            ("SUBMIT_DAILY_IP_BYTES", self.submit_daily_ip_bytes),
            ("SUBMIT_DAILY_GLOBAL_COUNT", self.submit_daily_global_count),
            ("SUBMIT_DAILY_GLOBAL_BYTES", self.submit_daily_global_bytes),
        ):
            if value <= 0:
                raise ValueError(f"{name} 必须大于 0")

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            data_dir=Path(os.getenv("FEEDBACK_DATA_DIR", "./data")).resolve(),
            admin_username=_single_line_env("ADMIN_USERNAME"),
            admin_password_hash=_single_line_env("ADMIN_PASSWORD_HASH"),
            session_secure=_env_bool("SESSION_COOKIE_SECURE", True),
            trusted_proxy_ips=_single_line_env("TRUSTED_PROXY_IPS"),
            public_base_url=_single_line_env("PUBLIC_BASE_URL")
            or "https://feedback.kmttjnm.me",
            allowed_origins=_single_line_env("ALLOWED_ORIGINS"),
            submit_rate_count=_env_int("SUBMIT_RATE_COUNT", 30, 1, 10_000),
            submit_rate_window=_env_int("SUBMIT_RATE_WINDOW", 60, 1, 86_400),
            submit_daily_ip_count=_env_int(
                "SUBMIT_DAILY_IP_COUNT", 20, 1, 1_000_000
            ),
            submit_daily_ip_bytes=_env_int(
                "SUBMIT_DAILY_IP_BYTES", 16 * 1024 * 1024, 1, 2**50
            ),
            submit_daily_global_count=_env_int(
                "SUBMIT_DAILY_GLOBAL_COUNT", 200, 1, 1_000_000
            ),
            submit_daily_global_bytes=_env_int(
                "SUBMIT_DAILY_GLOBAL_BYTES", 64 * 1024 * 1024, 1, 2**50
            ),
            submit_concurrency=_env_int(
                "SUBMIT_CONCURRENCY", MAX_SUBMIT_CONCURRENCY, 1, MAX_SUBMIT_CONCURRENCY
            ),
            login_rate_count=_env_int("LOGIN_RATE_COUNT", 10, 1, 1_000),
            login_rate_window=_env_int("LOGIN_RATE_WINDOW", 900, 1, 86_400),
            max_feedback_count=_env_int("MAX_FEEDBACK_COUNT", 10_000, 1, 1_000_000),
            max_storage_bytes=_env_int(
                "MAX_STORAGE_BYTES", 512 * 1024 * 1024, 1024 * 1024, 2**50
            ),
            min_free_disk_bytes=_env_int(
                "MIN_FREE_DISK_BYTES", 64 * 1024 * 1024, 0, 2**50
            ),
            retention_days=_env_int("RETENTION_DAYS", 90, 1, 3650),
            maintenance_interval=_env_int(
                "MAINTENANCE_INTERVAL_SECONDS", 3600, 30, 86_400
            ),
            outbox_poll_interval=_env_int(
                "OUTBOX_POLL_INTERVAL_SECONDS", 30, 5, 3600
            ),
            smtp_host=_single_line_env("SMTP_HOST"),
            smtp_port=_env_int("SMTP_PORT", 587, 1, 65_535),
            smtp_security=_single_line_env("SMTP_SECURITY").lower() or "starttls",
            smtp_username=_single_line_env("SMTP_USERNAME"),
            smtp_password=_single_line_env("SMTP_PASSWORD"),
            smtp_from=_single_line_env("SMTP_FROM"),
            smtp_to=_single_line_env("SMTP_TO") or "3428864257@qq.com",
            smtp_timeout=_env_int("SMTP_TIMEOUT", 15, 1, 120),
        )


def _now() -> int:
    return int(time.time())


def hash_password(password: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    if not isinstance(password, str) or not password:
        raise ValueError("密码不能为空")
    if not PBKDF2_MIN_ITERATIONS <= iterations <= 2_000_000:
        raise ValueError("PBKDF2 迭代次数超出范围")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations
    )
    return (
        "pbkdf2_sha256$"
        + str(iterations)
        + "$"
        + base64.b64encode(salt).decode("ascii")
        + "$"
        + base64.b64encode(digest).decode("ascii")
    )


def parse_password_hash(encoded: str) -> tuple[int, bytes, bytes] | None:
    try:
        algorithm, iterations_text, salt_text, digest_text = encoded.split("$", 3)
        iterations = int(iterations_text)
        if algorithm != "pbkdf2_sha256":
            return None
        if not PBKDF2_MIN_ITERATIONS <= iterations <= 2_000_000:
            return None
        salt = base64.b64decode(salt_text, validate=True)
        digest = base64.b64decode(digest_text, validate=True)
        if len(salt) < 16 or len(digest) != 32:
            return None
        return iterations, salt, digest
    except (ValueError, binascii.Error):
        return None


def verify_password(password: str, encoded: str) -> bool:
    parsed = parse_password_hash(encoded)
    if parsed is None:
        return False
    iterations, salt, expected = parsed
    actual = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, iterations
    )
    return hmac.compare_digest(actual, expected)


def admin_configured(settings: Settings) -> bool:
    return bool(
        settings.admin_username
        and parse_password_hash(settings.admin_password_hash) is not None
    )


def _valid_email_address(value: str) -> bool:
    if not value or "\r" in value or "\n" in value:
        return False
    name, address = parseaddr(value)
    return not name and address == value and "@" in address


def smtp_configured(settings: Settings) -> bool:
    credentials_valid = bool(settings.smtp_username) == bool(settings.smtp_password)
    return bool(
        settings.smtp_host
        and _valid_email_address(settings.smtp_from)
        and _valid_email_address(settings.smtp_to)
        and settings.smtp_security in {"starttls", "ssl", "none"}
        and credentials_valid
    )


def _allowed_origins(settings: Settings) -> set[str]:
    origins = {settings.public_origin}
    for value in settings.allowed_origins.split(","):
        value = value.strip()
        if not value:
            continue
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise RuntimeError("ALLOWED_ORIGINS 只能包含不带路径的 scheme://host")
        origins.add(f"{parsed.scheme}://{parsed.netloc}")
    return origins


def connect_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute("PRAGMA secure_delete = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _migrate_feedback_category(db: sqlite3.Connection) -> None:
    row = db.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'feedback'"
    ).fetchone()
    if row is None or "feature" in (row["sql"] or ""):
        return

    # SQLite cannot alter a CHECK constraint in place. Rebuild the parent table
    # while preserving attachments/outbox and their foreign-key relationships.
    db.commit()
    db.execute("PRAGMA foreign_keys = OFF")
    try:
        db.execute("DROP TABLE IF EXISTS feedback_new")
        db.execute(
            """
            CREATE TABLE feedback_new (
                id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL UNIQUE,
                payload_hash TEXT NOT NULL,
                category TEXT NOT NULL CHECK (category IN ('tool', 'rule', 'feature')),
                description TEXT NOT NULL,
                contact TEXT NOT NULL,
                context_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'resolved')),
                total_bytes INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            )
            """
        )
        db.execute(
            """
            INSERT INTO feedback_new (
                id, client_id, payload_hash, category, description, contact,
                context_json, status, total_bytes, created_at
            )
            SELECT
                id, client_id, payload_hash, category, description, contact,
                context_json, status, total_bytes, created_at
            FROM feedback
            """
        )
        db.execute("DROP TABLE feedback")
        db.execute("ALTER TABLE feedback_new RENAME TO feedback")
        db.execute(
            "CREATE INDEX IF NOT EXISTS feedback_created_at_idx "
            "ON feedback(created_at DESC)"
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.execute("PRAGMA foreign_keys = ON")


def initialize_storage(settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings.attachments_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    for directory in (settings.data_dir, settings.attachments_dir):
        try:
            directory.chmod(0o700)
        except OSError:
            pass
    with closing(connect_db(settings.db_path)) as db:
        db.executescript(SCHEMA)
        _migrate_feedback_category(db)
    _load_or_create_ip_hash_salt(settings)


def _load_or_create_ip_hash_salt(settings: Settings) -> bytes:
    path = settings.ip_hash_salt_path
    if path.exists():
        value = path.read_bytes()
        if len(value) == IP_HASH_SALT_BYTES:
            try:
                path.chmod(0o600)
            except OSError:
                pass
            return value

    value = secrets.token_bytes(IP_HASH_SALT_BYTES)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
        os.replace(temporary, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
    return value


def _read_ip_hash_salt(settings: Settings) -> bytes:
    value = settings.ip_hash_salt_path.read_bytes()
    if len(value) != IP_HASH_SALT_BYTES:
        raise RuntimeError("IP 摘要盐文件无效")
    return value


def _ip_budget_scope(settings: Settings, ip: str) -> str:
    digest = hmac.new(
        _read_ip_hash_salt(settings), ip.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return "ip:" + digest


def _utc_day(timestamp: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(timestamp))


def _retry_after_next_utc_day(timestamp: int) -> int:
    return max(1, 86_400 - timestamp % 86_400)


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def strict_json_loads(value: str) -> Any:
    def reject_constant(constant: str) -> None:
        raise ValueError(f"invalid JSON constant: {constant}")

    return json.loads(
        value,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=reject_constant,
    )


def _valid_text(value: Any, limit: int, field: str, allow_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, f"{field} 必须是字符串")
    if len(value) > limit:
        raise HTTPException(422, f"{field} 超出长度限制")
    if not allow_empty and not value.strip():
        raise HTTPException(422, f"{field} 不能为空")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise HTTPException(422, f"{field} 包含无效字符") from exc
    return value


def _exact_keys(value: dict[str, Any], keys: set[str], field: str) -> None:
    if set(value) != keys:
        raise HTTPException(422, f"{field} 字段不符合合同")


def validate_feedback_payload(
    value: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not isinstance(value, dict):
        raise HTTPException(422, "请求体必须是 JSON 对象")
    _exact_keys(
        value,
        {
            "version",
            "clientId",
            "category",
            "description",
            "contact",
            "context",
            "attachments",
        },
        "请求体",
    )
    if type(value["version"]) is not int or value["version"] != 1:
        raise HTTPException(422, "version 必须为 1")
    if not isinstance(value["clientId"], str):
        raise HTTPException(422, "clientId 必须是 UUID 字符串")
    try:
        client_id = str(uuid.UUID(value["clientId"]))
    except (ValueError, AttributeError) as exc:
        raise HTTPException(422, "clientId 必须是 UUID 字符串") from exc
    category = value["category"]
    if not isinstance(category, str) or category not in {"tool", "rule", "feature"}:
        raise HTTPException(422, "category 必须为 tool、rule 或 feature")
    description = _valid_text(value["description"], 4000, "description", allow_empty=False)
    contact = _valid_text(value["contact"], 200, "contact")

    context = value["context"]
    if not isinstance(context, dict):
        raise HTTPException(422, "context 必须是对象")
    required_context_keys = {"appVersion", "systemVersion", "page", "error"}
    allowed_context_keys = required_context_keys | {"gkdVersion", "gkdChannel"}
    if (
        not required_context_keys.issubset(context)
        or not set(context).issubset(allowed_context_keys)
    ):
        raise HTTPException(422, "context 字段不完整或包含未知字段")
    context_limits = {
        "appVersion": 200,
        "systemVersion": 500,
        "gkdVersion": 200,
        "gkdChannel": 20,
        "page": 200,
        "error": 4000,
    }
    normalized_context = {
        key: _valid_text(
            context[key], context_limits[key], f"context.{key}"
        )
        for key in context
    }

    raw_attachments = value["attachments"]
    if not isinstance(raw_attachments, list):
        raise HTTPException(422, "attachments 必须是数组")
    if len(raw_attachments) > ATTACHMENT_COUNT_LIMIT:
        raise HTTPException(422, "附件最多 4 个")

    normalized_attachments: list[dict[str, Any]] = []
    attachment_total = 0
    for index, attachment in enumerate(raw_attachments):
        if not isinstance(attachment, dict):
            raise HTTPException(422, f"attachments[{index}] 必须是对象")
        _exact_keys(
            attachment,
            {"name", "mimeType", "data"},
            f"attachments[{index}]",
        )
        name = _valid_text(attachment["name"], 255, f"attachments[{index}].name")
        mime_type = attachment["mimeType"]
        if not isinstance(mime_type, str) or mime_type not in CONTENT_TYPES:
            raise HTTPException(422, f"attachments[{index}].mimeType 不受支持")
        encoded = attachment["data"]
        if not isinstance(encoded, str):
            raise HTTPException(422, f"attachments[{index}].data 必须是 base64")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise HTTPException(
                422, f"attachments[{index}].data 不是有效 base64"
            ) from exc
        attachment_total += len(content)
        if attachment_total > ATTACHMENT_BYTE_LIMIT:
            raise HTTPException(422, "附件解码后总大小超过 8 MiB")
        signature = CONTENT_TYPES[mime_type][0]
        if signature is not None and not content.startswith(signature):
            raise HTTPException(422, f"attachments[{index}] 文件签名无效")
        if mime_type == "image/png":
            if len(content) < 24 or content[12:16] != b"IHDR":
                raise HTTPException(422, f"attachments[{index}] PNG 头无效")
            width, height = int.from_bytes(content[16:20]), int.from_bytes(content[20:24])
            if not (0 < width <= 8192 and 0 < height <= 8192 and width * height <= 12_000_000):
                raise HTTPException(422, f"attachments[{index}] PNG 像素尺寸超限")
        if mime_type == "application/json":
            try:
                strict_json_loads(content.decode("utf-8"))
            except (UnicodeDecodeError, ValueError, RecursionError) as exc:
                raise HTTPException(
                    422, f"attachments[{index}] JSON 内容无效"
                ) from exc
        normalized_attachments.append(
            {
                "name": name,
                "mimeType": mime_type,
                "data": base64.b64encode(content).decode("ascii"),
                "content": content,
            }
        )

    normalized = {
        "version": 1,
        "clientId": client_id,
        "category": category,
        "description": description,
        "contact": contact,
        "context": normalized_context,
        "attachments": [
            {
                "name": attachment["name"],
                "mimeType": attachment["mimeType"],
                "data": attachment["data"],
            }
            for attachment in normalized_attachments
        ],
    }
    return normalized, normalized_attachments


async def read_json_body(request: Request, limit: int = FEEDBACK_BODY_LIMIT) -> Any:
    content_type = (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    )
    if content_type != "application/json":
        raise HTTPException(415, "Content-Type 必须为 application/json")
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared = int(content_length)
        except ValueError as exc:
            raise HTTPException(400, "Content-Length 无效") from exc
        if declared < 0:
            raise HTTPException(400, "Content-Length 无效")
        if declared > limit:
            raise HTTPException(413, "请求体过大")

    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "请求体过大")
        body.extend(chunk)
    if not body:
        raise HTTPException(400, "请求体为空")
    try:
        return strict_json_loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise HTTPException(400, "请求体不是有效 JSON") from exc


class SlidingWindowLimiter:
    def __init__(
        self, count: int, window_seconds: int, max_buckets: int = 10_000
    ) -> None:
        self.count = count
        self.window_seconds = window_seconds
        self.max_buckets = max(1, min(max_buckets, 10_000))
        self.events: dict[str, deque[float]] = {}
        self.lock = asyncio.Lock()

    async def allow(self, key: str) -> tuple[bool, int]:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        async with self.lock:
            for event_key, timestamps in list(self.events.items()):
                while timestamps and timestamps[0] < cutoff:
                    timestamps.popleft()
                if not timestamps:
                    del self.events[event_key]
            bucket = self.events.get(key)
            if bucket is None:
                if len(self.events) >= self.max_buckets:
                    return False, self.window_seconds
                bucket = deque()
                self.events[key] = bucket
            if len(bucket) >= self.count:
                retry_after = max(
                    1, int(bucket[0] + self.window_seconds - now) + 1
                )
                return False, retry_after
            bucket.append(now)
            return True, 0


def _trusted_networks(
    value: str,
) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError as exc:
            raise RuntimeError("TRUSTED_PROXY_IPS 包含无效 IP 或 CIDR") from exc
    return networks


def _parse_ip(value: str) -> str | None:
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def client_ip(request: Request, trusted: list[Any]) -> str:
    direct = request.client.host if request.client else ""
    parsed_direct = _parse_ip(direct)
    if parsed_direct is None or not trusted:
        return parsed_direct or "unknown"
    try:
        direct_address = ipaddress.ip_address(parsed_direct)
    except ValueError:
        return "unknown"
    if not any(direct_address in network for network in trusted):
        return parsed_direct

    forwarded = request.headers.get("x-forwarded-for", "")
    candidates = [_parse_ip(item) for item in forwarded.split(",")]
    valid = [item for item in candidates if item is not None]
    for candidate in reversed(valid):
        address = ipaddress.ip_address(candidate)
        if not any(address in network for network in trusted):
            return candidate
    return valid[0] if valid else parsed_direct


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _write_attachment_files(
    settings: Settings, attachments: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    written: list[dict[str, Any]] = []
    try:
        for attachment in attachments:
            _, extension = CONTENT_TYPES[attachment["mimeType"]]
            storage_name = f"{uuid.uuid4().hex}.{extension}"
            path = settings.attachments_dir / storage_name
            with path.open("xb") as handle:
                handle.write(attachment["content"])
            try:
                path.chmod(0o600)
            except OSError:
                pass
            written.append(
                {
                    "id": str(uuid.uuid4()),
                    "name": attachment["name"],
                    "mimeType": attachment["mimeType"],
                    "size": len(attachment["content"]),
                    "storageName": storage_name,
                    "path": path,
                }
            )
        return written
    except Exception:
        for item in written:
            _safe_unlink(item["path"])
        raise


def _consume_daily_budget(
    db: sqlite3.Connection,
    settings: Settings,
    utc_day: str,
    ip_scope: str | None,
    total_bytes: int,
    retry_after: int,
) -> None:
    limits = [
        (
            "global",
            settings.submit_daily_global_count,
            settings.submit_daily_global_bytes,
        )
    ]
    if ip_scope is not None:
        limits.append(
            (
                ip_scope,
                settings.submit_daily_ip_count,
                settings.submit_daily_ip_bytes,
            )
        )

    scopes = [scope for scope, _, _ in limits]
    placeholders = ",".join("?" for _ in scopes)
    rows = db.execute(
        f"""
        SELECT scope, entry_count, total_bytes
        FROM feedback_budget
        WHERE utc_day = ? AND scope IN ({placeholders})
        """,
        (utc_day, *scopes),
    ).fetchall()
    current = {
        row["scope"]: (row["entry_count"], row["total_bytes"]) for row in rows
    }
    for scope, count_limit, byte_limit in limits:
        entry_count, stored_bytes = current.get(scope, (0, 0))
        if entry_count + 1 > count_limit or stored_bytes + total_bytes > byte_limit:
            raise HTTPException(
                429,
                "今日反馈提交额度已用完",
                headers={"Retry-After": str(retry_after)},
            )

    for scope, _, _ in limits:
        db.execute(
            """
            INSERT INTO feedback_budget (
                utc_day, scope, entry_count, total_bytes
            ) VALUES (?, ?, 1, ?)
            ON CONFLICT(utc_day, scope) DO UPDATE SET
                entry_count = feedback_budget.entry_count + 1,
                total_bytes = feedback_budget.total_bytes + excluded.total_bytes
            """,
            (utc_day, scope, total_bytes),
        )


def persist_feedback(
    settings: Settings,
    normalized: dict[str, Any],
    decoded_attachments: list[dict[str, Any]],
    ip: str | None = None,
) -> tuple[str, bool]:
    feedback_id = str(uuid.uuid4())
    payload_hash = hashlib.sha256(
        _canonical_json(normalized).encode("utf-8")
    ).hexdigest()
    attachment_bytes = sum(len(item["content"]) for item in decoded_attachments)
    metadata_for_storage = {
        "version": normalized["version"],
        "clientId": normalized["clientId"],
        "category": normalized["category"],
        "description": normalized["description"],
        "contact": normalized["contact"],
        "context": normalized["context"],
        "attachments": [
            {
                "name": item["name"],
                "mimeType": item["mimeType"],
                "byteSize": len(item["content"]),
            }
            for item in decoded_attachments
        ],
    }
    total_bytes = attachment_bytes + len(
        _canonical_json(metadata_for_storage).encode("utf-8")
    )

    db = connect_db(settings.db_path)
    written: list[dict[str, Any]] = []
    try:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT id, payload_hash FROM feedback WHERE client_id = ?",
            (normalized["clientId"],),
        ).fetchone()
        if existing is not None:
            db.rollback()
            if hmac.compare_digest(existing["payload_hash"], payload_hash):
                return existing["id"], False
            raise HTTPException(409, "同一 clientId 已提交不同内容")

        count = db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        if count >= settings.max_feedback_count:
            db.rollback()
            raise HTTPException(507, "反馈存储数量已达上限")
        stored_bytes = db.execute(
            "SELECT COALESCE(SUM(total_bytes), 0) FROM feedback"
        ).fetchone()[0]
        if stored_bytes + total_bytes > settings.max_storage_bytes:
            db.rollback()
            raise HTTPException(507, "反馈存储容量已达上限")
        free_bytes = shutil.disk_usage(settings.data_dir).free
        if free_bytes - attachment_bytes < settings.min_free_disk_bytes:
            db.rollback()
            raise HTTPException(507, "服务器磁盘余量不足")

        created_at = _now()
        retry_after = _retry_after_next_utc_day(created_at)
        ip_scope = _ip_budget_scope(settings, ip) if ip is not None else None
        _consume_daily_budget(
            db,
            settings,
            _utc_day(created_at),
            ip_scope,
            total_bytes,
            retry_after,
        )

        written = _write_attachment_files(settings, decoded_attachments)
        db.execute(
            """
            INSERT INTO feedback (
                id, client_id, payload_hash, category, description,
                contact, context_json, status, total_bytes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            """,
            (
                feedback_id,
                normalized["clientId"],
                payload_hash,
                normalized["category"],
                normalized["description"],
                normalized["contact"],
                _canonical_json(normalized["context"]),
                total_bytes,
                created_at,
            ),
        )
        for item in written:
            db.execute(
                """
                INSERT INTO attachments (
                    id, feedback_id, original_name, mime_type,
                    byte_size, storage_name
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    item["id"],
                    feedback_id,
                    item["name"],
                    item["mimeType"],
                    item["size"],
                    item["storageName"],
                ),
            )
        db.execute(
            """
            INSERT INTO outbox (feedback_id, attempts, next_attempt_at, created_at)
            VALUES (?, 0, ?, ?)
            """,
            (feedback_id, created_at, created_at),
        )
        db.commit()
        return feedback_id, True
    except Exception:
        try:
            db.rollback()
        except sqlite3.Error:
            pass
        for item in written:
            _safe_unlink(item["path"])
        raise
    finally:
        db.close()


def _redacted_summary(description: str) -> str:
    summary = re.sub(r"\s+", " ", description).strip()
    summary = re.sub(
        r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])",
        "[邮箱]",
        summary,
    )
    summary = re.sub(r"(?<!\w)(?:\+?\d[\s-]?){7,}\d(?!\w)", "[数字]", summary)
    summary = re.sub(r"[A-Za-z0-9_-]{24,}", "[长串]", summary)
    return summary[:160] + ("…" if len(summary) > 160 else "")


def _feedback_admin_link(settings: Settings, feedback_id: str) -> str:
    return urljoin(
        settings.public_base_url.rstrip("/") + "/",
        f"admin?feedback={quote(feedback_id)}",
    )


def _send_notification(settings: Settings, row: sqlite3.Row) -> None:
    message = EmailMessage()
    message["Subject"] = f"[GKD 反馈] {row['feedback_id']}"
    message["From"] = settings.smtp_from
    message["To"] = settings.smtp_to
    feedback_link = _feedback_admin_link(settings, row["feedback_id"])
    summary = _redacted_summary(row["description"])
    message.set_content(
        "收到一条新反馈。\n\n"
        f"编号: {row['feedback_id']}\n"
        f"摘要: {summary or '（空）'}\n"
        f"后台: {feedback_link}\n"
    )

    server: smtplib.SMTP | smtplib.SMTP_SSL | None = None
    try:
        if settings.smtp_security == "ssl":
            server = smtplib.SMTP_SSL(
                settings.smtp_host,
                settings.smtp_port,
                timeout=settings.smtp_timeout,
                context=ssl.create_default_context(),
            )
        else:
            server = smtplib.SMTP(
                settings.smtp_host,
                settings.smtp_port,
                timeout=settings.smtp_timeout,
            )
            server.ehlo()
            if settings.smtp_security == "starttls":
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
        if settings.smtp_username:
            server.login(settings.smtp_username, settings.smtp_password)
        server.send_message(message)
    finally:
        if server is not None:
            try:
                server.quit()
            except (OSError, smtplib.SMTPException):
                pass


def process_outbox(settings: Settings) -> None:
    if not smtp_configured(settings):
        return
    now = _now()
    db = connect_db(settings.db_path)
    try:
        row = db.execute(
            """
            SELECT o.id AS outbox_id, o.attempts, f.id AS feedback_id,
                   f.description
            FROM outbox o
            JOIN feedback f ON f.id = o.feedback_id
            WHERE o.sent_at IS NULL AND o.next_attempt_at <= ?
            ORDER BY o.next_attempt_at ASC
            LIMIT 1
            """,
            (now,),
        ).fetchone()
        if row is None:
            return
        claimed = db.execute(
            """
            UPDATE outbox
            SET attempts = attempts + 1,
                next_attempt_at = ?
            WHERE id = ? AND sent_at IS NULL AND next_attempt_at <= ?
            """,
            (now + 120, row["outbox_id"], now),
        )
        db.commit()
        if claimed.rowcount != 1:
            return
        try:
            _send_notification(settings, row)
        except Exception as exc:
            attempts = row["attempts"] + 1
            retry_delay = min(3600, 30 * (2 ** min(attempts - 1, 7)))
            db.execute(
                """
                UPDATE outbox
                SET next_attempt_at = ?, last_error = ?
                WHERE id = ? AND sent_at IS NULL
                """,
                (now + retry_delay, type(exc).__name__, row["outbox_id"]),
            )
            db.commit()
            LOGGER.warning("SMTP 发送失败，已进入重试队列")
        else:
            db.execute(
                """
                UPDATE outbox
                SET sent_at = ?, next_attempt_at = 0, last_error = NULL
                WHERE id = ?
                """,
                (_now(), row["outbox_id"]),
            )
            db.commit()
    finally:
        db.close()


def cleanup_expired(settings: Settings) -> int:
    now = _now()
    cutoff = now - settings.retention_days * 86_400
    db = connect_db(settings.db_path)
    deleted = 0
    try:
        db.execute("DELETE FROM admin_sessions WHERE expires_at <= ?", (now,))
        retained_days = {
            _utc_day(now - offset * 86_400)
            for offset in range(DAILY_BUDGET_RETENTION_DAYS)
        }
        placeholders = ",".join("?" for _ in retained_days)
        db.execute(
            f"DELETE FROM feedback_budget WHERE utc_day NOT IN ({placeholders})",
            tuple(retained_days),
        )
        db.commit()
        rows = db.execute(
            """
            SELECT f.id, a.storage_name
            FROM feedback f
            LEFT JOIN attachments a ON a.feedback_id = f.id
            WHERE f.created_at < ?
            """,
            (cutoff,),
        ).fetchall()
        by_feedback: dict[str, list[str]] = {}
        for row in rows:
            by_feedback.setdefault(row["id"], [])
            if row["storage_name"]:
                by_feedback[row["id"]].append(row["storage_name"])
        for feedback_id, storage_names in by_feedback.items():
            paths = [settings.attachments_dir / name for name in storage_names]
            try:
                for path in paths:
                    path.unlink(missing_ok=True)
            except OSError:
                LOGGER.warning("过期附件暂未删除，将在下次维护重试")
                continue
            db.execute("DELETE FROM feedback WHERE id = ?", (feedback_id,))
            deleted += 1
        db.commit()

        referenced = {
            row[0]
            for row in db.execute("SELECT storage_name FROM attachments").fetchall()
        }
        orphan_cutoff = _now() - 3600
        for path in settings.attachments_dir.iterdir():
            if not path.is_file() or path.name in referenced:
                continue
            try:
                if path.stat().st_mtime < orphan_cutoff:
                    path.unlink(missing_ok=True)
            except OSError:
                LOGGER.warning("孤立附件暂未删除，将在下次维护重试")

        if deleted:
            try:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                db.execute("VACUUM")
            except sqlite3.Error:
                LOGGER.warning("数据库空间压缩将在下次维护重试")
    finally:
        db.close()
    return deleted


async def maintenance_loop(settings: Settings, stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            work = asyncio.create_task(asyncio.to_thread(cleanup_expired, settings))
            try:
                await asyncio.shield(work)
            except asyncio.CancelledError:
                await work
                raise
        except Exception:
            LOGGER.exception("维护任务失败")
        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=settings.maintenance_interval
            )
        except TimeoutError:
            pass


async def outbox_loop(settings: Settings, stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            work = asyncio.create_task(asyncio.to_thread(process_outbox, settings))
            try:
                await asyncio.shield(work)
            except asyncio.CancelledError:
                await work
                raise
        except Exception:
            LOGGER.exception("通知队列任务失败")
        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=settings.outbox_poll_interval
            )
        except TimeoutError:
            pass


def _context_from_db(value: str) -> dict[str, str]:
    try:
        parsed = json.loads(value)
        if isinstance(parsed, dict):
            return {str(key): str(item) for key, item in parsed.items()}
    except (TypeError, json.JSONDecodeError):
        pass
    return {}


def _feedback_list_item(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "category": row["category"],
        "description": row["description"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "hasContact": bool(row["contact"]),
        "attachmentCount": row["attachment_count"],
    }


def _attachment_headers(name: str) -> dict[str, str]:
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    ascii_name = (ascii_name or "attachment")[:120]
    encoded_name = quote(name, safe="")
    return {
        "Content-Disposition": (
            "attachment; filename=\""
            + ascii_name
            + "\"; filename*=UTF-8''"
            + encoded_name
        ),
        "Content-Security-Policy": "sandbox; default-src 'none'",
    }


ANNOUNCEMENT_TITLE_LIMIT = 120
ANNOUNCEMENT_CONTENT_LIMIT = 8000
ANNOUNCEMENT_URL_LIMIT = 500
ANNOUNCEMENT_MIRROR_LIMIT = 5
ANNOUNCEMENT_HISTORY_LIMIT = 50
GITHUB_MIRROR_PREFIXES = (
    "https://ghproxy.net/",
    "https://gh-proxy.com/",
    "https://ghfast.top/",
)
ANNOUNCEMENT_FIELDS = (
    "enabled",
    "type",
    "title",
    "content",
    "forced",
    "versionName",
    "versionCode",
    "apkUrl",
    "sha256",
    "actionText",
    "actionUrl",
)
ANNOUNCEMENT_DEFAULT = {
    "id": "init",
    "enabled": False,
    "title": "暂无公告",
    "content": "作者暂时没有发布新的公告。",
    "type": "notice",
    "forced": False,
    "updatedAt": "",
}


def _http_url(value: str, field: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(422, f"{field} 必须是 HTTP(S) 链接")
    if parsed.username or parsed.password:
        raise HTTPException(422, f"{field} 不能包含账号信息")
    return value


def _announcement_public(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return dict(ANNOUNCEMENT_DEFAULT)
    mirrors: list[str] = []
    if row["mirrors_json"]:
        try:
            parsed = json.loads(row["mirrors_json"])
            if isinstance(parsed, list):
                mirrors = [item for item in parsed if isinstance(item, str)]
        except (TypeError, json.JSONDecodeError):
            mirrors = []
    result: dict[str, Any] = {
        "id": row["id"],
        "enabled": bool(row["enabled"]),
        "title": row["title"],
        "content": row["content"],
        "type": row["type"],
        "forced": bool(row["forced"]),
        "updatedAt": row["updated_at"],
    }
    if row["version_name"]:
        result["versionName"] = row["version_name"]
    if row["version_code"]:
        result["versionCode"] = row["version_code"]
    if row["apk_url"]:
        result["apkUrl"] = row["apk_url"]
    if mirrors:
        result["mirrors"] = mirrors
    if row["sha256"]:
        result["sha256"] = row["sha256"]
    if row["action_url"]:
        result["actionUrl"] = row["action_url"]
    if row["action_text"]:
        result["actionText"] = row["action_text"]
    return result


def _current_announcement_row(settings: Settings) -> sqlite3.Row | None:
    with closing(connect_db(settings.db_path)) as db:
        return db.execute(
            "SELECT * FROM announcement WHERE slot = 1"
        ).fetchone()


def _announcement_history(settings: Settings) -> list[dict[str, Any]]:
    with closing(connect_db(settings.db_path)) as db:
        rows = db.execute(
            """
            SELECT * FROM announcement_history
            ORDER BY published_at DESC
            LIMIT ?
            """,
            (ANNOUNCEMENT_HISTORY_LIMIT,),
        ).fetchall()
    return [_announcement_public(row) for row in rows]


def validate_announcement_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HTTPException(422, "请求体必须是 JSON 对象")
    _exact_keys(value, set(ANNOUNCEMENT_FIELDS), "请求体")
    if type(value["enabled"]) is not bool:
        raise HTTPException(422, "enabled 必须是布尔值")
    if type(value["forced"]) is not bool:
        raise HTTPException(422, "forced 必须是布尔值")
    kind = value["type"]
    if not isinstance(kind, str) or kind not in {"notice", "update"}:
        raise HTTPException(422, "type 必须为 notice 或 update")
    title = _valid_text(value["title"], ANNOUNCEMENT_TITLE_LIMIT, "title", allow_empty=False).strip()
    content = _valid_text(
        value["content"], ANNOUNCEMENT_CONTENT_LIMIT, "content", allow_empty=False
    ).strip()

    version_name = _valid_text(value["versionName"], 40, "versionName").strip()
    apk_url = _valid_text(value["apkUrl"], ANNOUNCEMENT_URL_LIMIT, "apkUrl").strip()
    sha256 = _valid_text(value["sha256"], 64, "sha256").strip().lower()
    action_text = _valid_text(value["actionText"], 20, "actionText").strip()
    action_url = _valid_text(value["actionUrl"], ANNOUNCEMENT_URL_LIMIT, "actionUrl").strip()
    if sha256 and not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise HTTPException(422, "sha256 必须是 64 位十六进制字符串")

    raw_code = value["versionCode"]
    version_code: int | None = None
    if isinstance(raw_code, str) and raw_code.strip():
        if not raw_code.strip().isdigit():
            raise HTTPException(422, "versionCode 必须是正整数")
        version_code = int(raw_code.strip())
    elif isinstance(raw_code, int) and type(raw_code) is int:
        version_code = raw_code
    elif raw_code not in (None, ""):
        raise HTTPException(422, "versionCode 必须是正整数")
    if version_code is not None and not 1 <= version_code <= 2_100_000_000:
        raise HTTPException(422, "versionCode 超出范围")

    if kind == "update":
        if not version_name:
            raise HTTPException(422, "版本更新必须填写 versionName")
        if not apk_url:
            raise HTTPException(422, "版本更新必须填写 apkUrl")
    if apk_url:
        _http_url(apk_url, "apkUrl")
    if action_url:
        _http_url(action_url, "actionUrl")
    if action_text and not action_url:
        raise HTTPException(422, "填写按钮名称时必须同时填写链接")
    if action_url and not action_text:
        raise HTTPException(422, "填写链接时必须同时填写按钮名称")

    mirrors: list[str] = []
    if apk_url.startswith("https://github.com/"):
        mirrors = [prefix + apk_url for prefix in GITHUB_MIRROR_PREFIXES]
    if len(mirrors) > ANNOUNCEMENT_MIRROR_LIMIT:
        mirrors = mirrors[:ANNOUNCEMENT_MIRROR_LIMIT]

    return {
        "enabled": value["enabled"],
        "type": kind,
        "title": title,
        "content": content,
        "forced": value["forced"],
        "versionName": version_name or None,
        "versionCode": version_code,
        "apkUrl": apk_url or None,
        "sha256": sha256 or None,
        "mirrors": mirrors,
        "actionText": action_text or None,
        "actionUrl": action_url or None,
    }


def publish_announcement(
    settings: Settings, payload: dict[str, Any]
) -> dict[str, Any]:
    now = time.gmtime()
    stamp = time.strftime("%Y%m%d%H%M%S", now)
    announcement_id = "ann-" + stamp + "-" + secrets.token_hex(2)
    updated_at = time.strftime("%Y-%m-%d %H:%M:%S", now)
    mirrors_json = (
        json.dumps(payload["mirrors"], ensure_ascii=False)
        if payload["mirrors"]
        else None
    )
    with closing(connect_db(settings.db_path)) as db:
        db.execute(
            """
            INSERT INTO announcement (
                slot, id, enabled, title, content, type, forced, updated_at,
                version_name, version_code, apk_url, mirrors_json, sha256,
                action_url, action_text
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slot) DO UPDATE SET
                id = excluded.id,
                enabled = excluded.enabled,
                title = excluded.title,
                content = excluded.content,
                type = excluded.type,
                forced = excluded.forced,
                updated_at = excluded.updated_at,
                version_name = excluded.version_name,
                version_code = excluded.version_code,
                apk_url = excluded.apk_url,
                mirrors_json = excluded.mirrors_json,
                sha256 = excluded.sha256,
                action_url = excluded.action_url,
                action_text = excluded.action_text
            """,
            (
                announcement_id,
                int(payload["enabled"]),
                payload["title"],
                payload["content"],
                payload["type"],
                int(payload["forced"]),
                updated_at,
                payload["versionName"],
                payload["versionCode"],
                payload["apkUrl"],
                mirrors_json,
                payload["sha256"],
                payload["actionUrl"],
                payload["actionText"],
            ),
        )
        db.execute(
            """
            INSERT OR REPLACE INTO announcement_history (
                id, enabled, title, content, type, forced, updated_at,
                version_name, version_code, apk_url, mirrors_json, sha256,
                action_url, action_text, published_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                announcement_id,
                int(payload["enabled"]),
                payload["title"],
                payload["content"],
                payload["type"],
                int(payload["forced"]),
                updated_at,
                payload["versionName"],
                payload["versionCode"],
                payload["apkUrl"],
                mirrors_json,
                payload["sha256"],
                payload["actionUrl"],
                payload["actionText"],
                _now(),
            ),
        )
        db.execute(
            """
            DELETE FROM announcement_history WHERE id NOT IN (
                SELECT id FROM announcement_history
                ORDER BY published_at DESC
                LIMIT ?
            )
            """,
            (ANNOUNCEMENT_HISTORY_LIMIT,),
        )
        db.commit()
    return {
        "id": announcement_id,
        "enabled": payload["enabled"],
        "title": payload["title"],
        "content": payload["content"],
        "type": payload["type"],
        "forced": payload["forced"],
        "updatedAt": updated_at,
        **(
            {"versionName": payload["versionName"]}
            if payload["versionName"]
            else {}
        ),
        **(
            {"versionCode": payload["versionCode"]}
            if payload["versionCode"]
            else {}
        ),
        **({"apkUrl": payload["apkUrl"]} if payload["apkUrl"] else {}),
        **({"mirrors": payload["mirrors"]} if payload["mirrors"] else {}),
        **({"sha256": payload["sha256"]} if payload["sha256"] else {}),
        **({"actionUrl": payload["actionUrl"]} if payload["actionUrl"] else {}),
        **({"actionText": payload["actionText"]} if payload["actionText"] else {}),
    }


def _session_from_request(
    request: Request, settings: Settings
) -> tuple[sqlite3.Row | None, str | None]:
    raw_token = request.cookies.get(SESSION_COOKIE)
    if not raw_token:
        return None, None
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    with closing(connect_db(settings.db_path)) as db:
        row = db.execute(
            """
            SELECT token_hash, csrf_token, expires_at
            FROM admin_sessions
            WHERE token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
        if row is None:
            return None, raw_token
        if row["expires_at"] <= _now():
            db.execute(
                "DELETE FROM admin_sessions WHERE token_hash = ?", (token_hash,)
            )
            db.commit()
            return None, raw_token
        return row, raw_token


def _require_session(request: Request, settings: Settings) -> sqlite3.Row:
    session, _ = _session_from_request(request, settings)
    if session is None:
        raise HTTPException(401, "需要管理员登录")
    return session


def _require_csrf(request: Request, session: sqlite3.Row) -> None:
    supplied = request.headers.get("x-csrf-token", "")
    if not supplied or not hmac.compare_digest(supplied.encode("utf-8"), session["csrf_token"].encode("utf-8")):
        raise HTTPException(403, "CSRF 校验失败")


def _set_session_cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_SECONDS,
        httponly=True,
        secure=settings.session_secure,
        samesite="strict",
        path=settings.admin_cookie_path,
    )


def _clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        SESSION_COOKIE,
        path=settings.admin_cookie_path,
        secure=settings.session_secure,
        httponly=True,
        samesite="strict",
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    trusted_proxies = _trusted_networks(settings.trusted_proxy_ips)
    allowed_origins = _allowed_origins(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        initialize_storage(settings)
        if not admin_configured(settings):
            LOGGER.warning("管理员登录未配置，管理后台保持不可用")
        await asyncio.to_thread(cleanup_expired, settings)
        stop_event = asyncio.Event()
        tasks = [
            asyncio.create_task(maintenance_loop(settings, stop_event)),
            asyncio.create_task(outbox_loop(settings, stop_event)),
        ]
        try:
            yield
        finally:
            stop_event.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    app = FastAPI(
        title="GKD Feedback",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings
    app.state.trusted_proxies = trusted_proxies
    app.state.submit_limiter = SlidingWindowLimiter(
        settings.submit_rate_count, settings.submit_rate_window
    )
    app.state.login_limiter = SlidingWindowLimiter(
        settings.login_rate_count, settings.login_rate_window
    )
    app.state.submit_slots = asyncio.Semaphore(settings.submit_concurrency)

    @app.middleware("http")
    async def browser_boundaries(request: Request, call_next: Any) -> Response:
        origin = request.headers.get("origin")
        origin_allowed = origin is not None and bool(origin) and (
            origin == "null" or origin in allowed_origins
        )
        public_feedback = request.url.path == "/api/feedback"
        public_cors = public_feedback and origin_allowed
        public_announcement = request.url.path == "/api/announcement"
        announcement_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Accept",
            "Access-Control-Max-Age": "600",
        }
        cors_headers = {
            "Access-Control-Allow-Origin": origin or "null",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Accept, Idempotency-Key",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }
        if public_feedback and origin is None and request.method == "OPTIONS":
            return Response(status_code=204, headers=cors_headers)
        if public_cors and request.method == "OPTIONS":
            return Response(status_code=204, headers=cors_headers)
        if public_announcement and request.method == "OPTIONS":
            return Response(status_code=204, headers=announcement_headers)

        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Permissions-Policy"] = (
            "camera=(), microphone=(), geolocation=()"
        )
        if settings.session_secure:
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )
        if request.url.path.startswith("/admin"):
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self'; "
                "img-src 'self'; connect-src 'self'; object-src 'none'; "
                "base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
            )
            if request.url.path.startswith("/admin/api/"):
                response.headers["Cache-Control"] = "no-store"
        if public_cors:
            response.headers.update(cors_headers)
        if public_announcement:
            response.headers.update(announcement_headers)
            response.headers["Cache-Control"] = (
                "public, max-age=15, stale-while-revalidate=60"
            )
        return response

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {
            "status": "ok",
            "smtp_configured": smtp_configured(settings),
        }

    @app.get("/api/announcement")
    async def public_announcement() -> dict[str, Any]:
        row = await asyncio.to_thread(_current_announcement_row, settings)
        return _announcement_public(row)

    @app.post("/api/feedback")
    async def submit_feedback(request: Request) -> JSONResponse:
        ip = client_ip(request, trusted_proxies)
        allowed, retry_after = await request.app.state.submit_limiter.allow(ip)
        if not allowed:
            raise HTTPException(
                429,
                "请求过于频繁",
                headers={"Retry-After": str(retry_after)},
            )
        async with request.app.state.submit_slots:
            raw_payload = await read_json_body(request)
            normalized, decoded_attachments = validate_feedback_payload(raw_payload)
            feedback_id, created = await asyncio.to_thread(
                persist_feedback,
                settings,
                normalized,
                decoded_attachments,
                ip,
            )
        return JSONResponse(
            {"id": feedback_id},
            status_code=201 if created else 200,
        )

    @app.get("/admin")
    @app.get("/admin/")
    async def admin_page() -> Response:
        page = (WEB_DIR / "admin.html").read_text(encoding="utf-8")
        base_href = html.escape(settings.public_path_prefix + "/", quote=True)
        return Response(
            page.replace("__ADMIN_BASE_HREF__", base_href),
            media_type="text/html; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/admin/api/login")
    async def admin_login(request: Request) -> JSONResponse:
        if not admin_configured(settings):
            raise HTTPException(503, "管理后台未配置")
        ip = client_ip(request, trusted_proxies)
        allowed, retry_after = await request.app.state.login_limiter.allow(ip)
        if not allowed:
            raise HTTPException(
                429,
                "登录尝试过多",
                headers={"Retry-After": str(retry_after)},
            )
        payload = await read_json_body(request, limit=16 * 1024)
        if not isinstance(payload, dict) or set(payload) != {"username", "password"}:
            raise HTTPException(401, "用户名或密码错误")
        username = payload.get("username")
        password = payload.get("password")
        if not isinstance(username, str) or not isinstance(password, str):
            raise HTTPException(401, "用户名或密码错误")
        try:
            username_ok = hmac.compare_digest(username.encode("utf-8"), settings.admin_username.encode("utf-8"))
            password_ok = verify_password(password, settings.admin_password_hash)
        except UnicodeEncodeError:
            raise HTTPException(401, "用户名或密码错误")
        if not (username_ok and password_ok):
            raise HTTPException(401, "用户名或密码错误")

        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        csrf_token = secrets.token_urlsafe(32)
        now = _now()
        with closing(connect_db(settings.db_path)) as db:
            db.execute(
                """
                INSERT INTO admin_sessions (
                    token_hash, csrf_token, expires_at, created_at
                ) VALUES (?, ?, ?, ?)
                """,
                (token_hash, csrf_token, now + SESSION_SECONDS, now),
            )
            db.commit()
        response = JSONResponse({"ok": True})
        _set_session_cookie(response, raw_token, settings)
        return response

    @app.get("/admin/api/session")
    async def admin_session(request: Request) -> dict[str, Any]:
        session = _require_session(request, settings)
        return {"authenticated": True, "csrfToken": session["csrf_token"]}

    @app.post("/admin/api/logout")
    async def admin_logout(request: Request) -> Response:
        session = _require_session(request, settings)
        _require_csrf(request, session)
        with closing(connect_db(settings.db_path)) as db:
            db.execute(
                "DELETE FROM admin_sessions WHERE token_hash = ?",
                (session["token_hash"],),
            )
            db.commit()
        response = Response(status_code=204)
        _clear_session_cookie(response, settings)
        return response

    @app.get("/admin/api/announcement")
    async def admin_announcement(request: Request) -> dict[str, Any]:
        _require_session(request, settings)
        row = await asyncio.to_thread(_current_announcement_row, settings)
        history = await asyncio.to_thread(_announcement_history, settings)
        return {
            "current": _announcement_public(row),
            "history": history,
            "publicUrl": urljoin(
                settings.public_base_url, "api/announcement"
            ),
        }

    @app.post("/admin/api/announcement")
    async def admin_publish_announcement(request: Request) -> dict[str, Any]:
        session = _require_session(request, settings)
        _require_csrf(request, session)
        payload = await read_json_body(request, limit=64 * 1024)
        normalized = validate_announcement_payload(payload)
        announcement = await asyncio.to_thread(
            publish_announcement, settings, normalized
        )
        return {"ok": True, "announcement": announcement}

    @app.post("/admin/api/announcement/toggle")
    async def admin_toggle_announcement(request: Request) -> dict[str, Any]:
        session = _require_session(request, settings)
        _require_csrf(request, session)
        payload = await read_json_body(request, limit=4096)
        if not isinstance(payload, dict) or set(payload) != {"enabled"}:
            raise HTTPException(422, "只接受 enabled 字段")
        if type(payload["enabled"]) is not bool:
            raise HTTPException(422, "enabled 必须是布尔值")

        def apply_toggle() -> bool:
            with closing(connect_db(settings.db_path)) as db:
                updated = db.execute(
                    "UPDATE announcement SET enabled = ? WHERE slot = 1",
                    (int(payload["enabled"]),),
                )
                db.commit()
                return updated.rowcount == 1

        exists = await asyncio.to_thread(apply_toggle)
        if not exists:
            raise HTTPException(404, "还没有发布过公告")
        return {"ok": True, "enabled": payload["enabled"]}

    @app.get("/admin/api/feedback")
    async def admin_feedback_list(
        request: Request,
        page: int = 1,
        limit: int = 50,
        status: str = "all",
    ) -> dict[str, Any]:
        _require_session(request, settings)
        if page < 1:
            raise HTTPException(422, "page 必须大于 0")
        if not 1 <= limit <= 100:
            raise HTTPException(422, "limit 必须在 1 到 100 之间")
        if status not in {"all", "pending", "resolved"}:
            raise HTTPException(422, "status 无效")
        offset = (page - 1) * limit
        where = "" if status == "all" else "WHERE f.status = ?"
        params: tuple[Any, ...] = () if status == "all" else (status,)
        with closing(connect_db(settings.db_path)) as db:
            total = db.execute(
                f"SELECT COUNT(*) FROM feedback f {where}", params
            ).fetchone()[0]
            rows = db.execute(
                f"""
                SELECT f.*, COUNT(a.id) AS attachment_count
                FROM feedback f
                LEFT JOIN attachments a ON a.feedback_id = f.id
                {where}
                GROUP BY f.id
                ORDER BY f.created_at DESC
                LIMIT ? OFFSET ?
                """,
                params + (limit, offset),
            ).fetchall()
        return {
            "items": [_feedback_list_item(row) for row in rows],
            "total": total,
            "page": page,
            "limit": limit,
        }

    @app.get("/admin/api/feedback/{feedback_id}")
    async def admin_feedback_detail(
        feedback_id: str, request: Request
    ) -> dict[str, Any]:
        _require_session(request, settings)
        with closing(connect_db(settings.db_path)) as db:
            row = db.execute(
                "SELECT * FROM feedback WHERE id = ?", (feedback_id,)
            ).fetchone()
            if row is None:
                raise HTTPException(404, "反馈不存在")
            attachments = db.execute(
                """
                SELECT id, original_name, mime_type, byte_size
                FROM attachments
                WHERE feedback_id = ?
                ORDER BY rowid
                """,
                (feedback_id,),
            ).fetchall()
        return {
            "id": row["id"],
            "category": row["category"],
            "description": row["description"],
            "contact": row["contact"],
            "context": _context_from_db(row["context_json"]),
            "status": row["status"],
            "createdAt": row["created_at"],
            "attachments": [
                {
                    "id": item["id"],
                    "name": item["original_name"],
                    "mimeType": item["mime_type"],
                    "size": item["byte_size"],
                }
                for item in attachments
            ],
        }

    @app.patch("/admin/api/feedback/{feedback_id}")
    async def admin_update_feedback(
        feedback_id: str, request: Request
    ) -> dict[str, Any]:
        session = _require_session(request, settings)
        _require_csrf(request, session)
        payload = await read_json_body(request, limit=4096)
        if not isinstance(payload, dict) or set(payload) != {"status"}:
            raise HTTPException(422, "只接受 status 字段")
        status = payload["status"]
        if not isinstance(status, str) or status not in {"pending", "resolved"}:
            raise HTTPException(422, "status 必须为 pending 或 resolved")
        with closing(connect_db(settings.db_path)) as db:
            updated = db.execute(
                "UPDATE feedback SET status = ? WHERE id = ?",
                (status, feedback_id),
            )
            db.commit()
        if updated.rowcount != 1:
            raise HTTPException(404, "反馈不存在")
        return {"ok": True, "status": status}

    @app.delete("/admin/api/feedback/{feedback_id}")
    async def admin_delete_feedback(feedback_id: str, request: Request) -> Response:
        session = _require_session(request, settings)
        _require_csrf(request, session)
        with closing(connect_db(settings.db_path)) as db:
            row = db.execute(
                "SELECT id FROM feedback WHERE id = ?", (feedback_id,)
            ).fetchone()
            if row is None:
                raise HTTPException(404, "反馈不存在")
            attachments = db.execute(
                "SELECT storage_name FROM attachments WHERE feedback_id = ?",
                (feedback_id,),
            ).fetchall()
        try:
            for attachment in attachments:
                (settings.attachments_dir / attachment["storage_name"]).unlink(
                    missing_ok=True
                )
        except OSError as exc:
            raise HTTPException(500, "附件删除失败，请重试") from exc
        with closing(connect_db(settings.db_path)) as db:
            deleted = db.execute("DELETE FROM feedback WHERE id = ?", (feedback_id,))
            db.commit()
            try:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                db.execute("VACUUM")
            except sqlite3.Error:
                LOGGER.warning("删除后数据库空间压缩将在维护时重试")
        if deleted.rowcount != 1:
            raise HTTPException(404, "反馈不存在")
        return Response(status_code=204)

    @app.get(
        "/admin/api/feedback/{feedback_id}/attachments/{attachment_id}"
    )
    async def admin_download_attachment(
        feedback_id: str, attachment_id: str, request: Request
    ) -> FileResponse:
        _require_session(request, settings)
        with closing(connect_db(settings.db_path)) as db:
            row = db.execute(
                """
                SELECT original_name, mime_type, storage_name
                FROM attachments
                WHERE id = ? AND feedback_id = ?
                """,
                (attachment_id, feedback_id),
            ).fetchone()
        if row is None:
            raise HTTPException(404, "附件不存在")
        path = settings.attachments_dir / row["storage_name"]
        try:
            resolved = path.resolve(strict=True)
            resolved.relative_to(settings.attachments_dir.resolve())
        except (OSError, ValueError) as exc:
            raise HTTPException(404, "附件不存在") from exc
        return FileResponse(
            resolved,
            media_type=row["mime_type"],
            headers=_attachment_headers(row["original_name"]),
        )

    app.mount("/admin/static", StaticFiles(directory=WEB_DIR), name="admin-static")
    return app


app = create_app()
