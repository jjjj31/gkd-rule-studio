from __future__ import annotations

import asyncio
import base64
import json
import sqlite3
import tempfile
import time
import unittest
import uuid
from collections import deque
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from fastapi import Request

from app.main import (
    FEEDBACK_BODY_LIMIT,
    Settings,
    SlidingWindowLimiter,
    cleanup_expired,
    client_ip,
    connect_db,
    create_app,
    _feedback_admin_link,
    _redacted_summary,
    hash_password,
    persist_feedback,
    process_outbox,
    validate_feedback_payload,
)


PNG_BYTES = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdosAAAAASUVORK5CYII=")


class ASGIResponse:
    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):
        return json.loads(self.body.decode("utf-8"))


async def asgi_request(
    app,
    method: str,
    path: str,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
    client: str = "198.51.100.10",
    include_content_length: bool = True,
) -> ASGIResponse:
    request_headers = {
        key.lower().encode("latin-1"): value.encode("latin-1")
        for key, value in (headers or {}).items()
    }
    if (
        body
        and include_content_length
        and not any(key == b"content-length" for key in request_headers)
    ):
        request_headers[b"content-length"] = str(len(body)).encode("ascii")
    if not any(key == b"host" for key in request_headers):
        request_headers[b"host"] = b"testserver"
    path_only, _, query_string = path.partition("?")
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path_only,
        "raw_path": path_only.encode("ascii"),
        "query_string": query_string.encode("ascii"),
        "root_path": "",
        "headers": list(request_headers.items()),
        "client": (client, 54321),
        "server": ("testserver", 80),
        "app": app,
    }
    incoming = deque(
        [
            {
                "type": "http.request",
                "body": body,
                "more_body": False,
            }
        ]
    )
    status = 500
    response_headers: dict[str, str] = {}
    response_body = bytearray()

    async def receive():
        if incoming:
            return incoming.popleft()
        await asyncio.Future()

    async def send(message):
        nonlocal status
        if message["type"] == "http.response.start":
            status = message["status"]
            response_headers.update(
                {
                    key.decode("latin-1").lower(): value.decode("latin-1")
                    for key, value in message.get("headers", [])
                }
            )
        elif message["type"] == "http.response.body":
            response_body.extend(message.get("body", b""))

    await app(scope, receive, send)
    return ASGIResponse(status, response_headers, bytes(response_body))


def feedback_payload(
    *,
    client_id: str | None = None,
    category: str = "tool",
    description: str = "界面崩溃",
    contact: str = "user@example.invalid",
    attachments: list[dict] | None = None,
) -> dict:
    return {
        "version": 1,
        "clientId": client_id or str(uuid.uuid4()),
        "category": category,
        "description": description,
        "contact": contact,
        "context": {
            "appVersion": "1.2.3",
            "systemVersion": "Android 16",
            "gkdVersion": "1.13.0-beta-5",
            "gkdChannel": "测试版",
            "page": "规则编辑",
            "error": "NullPointerException",
        },
        "attachments": attachments or [],
    }


def json_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    result = {"Content-Type": "application/json"}
    if extra:
        result.update(extra)
    return result


class FeedbackServiceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.settings = Settings(
            data_dir=Path(self.temp_dir.name),
            admin_username="admin-test",
            admin_password_hash=hash_password("correct-test-password", 100_000),
            session_secure=False,
            public_base_url="https://120.25.221.144/gkd-feedback/",
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        self.app = create_app(self.settings)
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()

    async def asyncTearDown(self) -> None:
        await self.lifespan.__aexit__(None, None, None)
        self.temp_dir.cleanup()

    async def request(self, method: str, path: str, **kwargs) -> ASGIResponse:
        return await asgi_request(self.app, method, path, **kwargs)

    async def post_feedback(
        self,
        payload: dict,
        *,
        headers: dict[str, str] | None = None,
        client: str = "198.51.100.10",
    ) -> ASGIResponse:
        return await self.request(
            "POST",
            "/api/feedback",
            body=json.dumps(payload).encode("utf-8"),
            headers=json_headers(headers),
            client=client,
        )

    async def login(self) -> tuple[str, str]:
        response = await self.request(
            "POST",
            "/admin/api/login",
            body=json.dumps(
                {
                    "username": "admin-test",
                    "password": "correct-test-password",
                }
            ).encode("utf-8"),
            headers=json_headers(),
        )
        self.assertEqual(response.status, 200)
        cookie = response.headers["set-cookie"].split(";", 1)[0]
        session = await self.request(
            "GET",
            "/admin/api/session",
            headers={"Cookie": cookie},
        )
        self.assertEqual(session.status, 200)
        return cookie, session.json()["csrfToken"]

    async def test_health_cors_and_security_headers(self) -> None:
        health = await self.request("GET", "/healthz")
        self.assertEqual(health.status, 200)
        self.assertEqual(
            health.json(), {"status": "ok", "smtp_configured": False}
        )

        preflight = await self.request(
            "OPTIONS",
            "/api/feedback",
            headers={
                "Origin": "null",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertEqual(preflight.status, 204)
        self.assertEqual(preflight.headers["access-control-allow-origin"], "null")
        self.assertIn(
            "Idempotency-Key",
            preflight.headers["access-control-allow-headers"],
        )

        no_origin_preflight = await self.request(
            "OPTIONS",
            "/api/feedback",
            headers={"Access-Control-Request-Method": "POST"},
        )
        self.assertEqual(no_origin_preflight.status, 204)
        self.assertEqual(
            no_origin_preflight.headers["access-control-allow-origin"], "null"
        )
        self.assertNotIn("access-control-allow-credentials", no_origin_preflight.headers)

        invalid_origin_preflight = await self.request(
            "OPTIONS",
            "/api/feedback",
            headers={
                "Origin": "https://untrusted.invalid",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertEqual(invalid_origin_preflight.status, 405)
        self.assertNotIn("access-control-allow-origin", invalid_origin_preflight.headers)

        admin_preflight = await self.request(
            "OPTIONS",
            "/admin/api/login",
            headers={"Access-Control-Request-Method": "POST"},
        )
        self.assertEqual(admin_preflight.status, 405)
        self.assertNotIn("access-control-allow-origin", admin_preflight.headers)

        production_origin = await self.request(
            "OPTIONS",
            "/api/feedback",
            headers={
                "Origin": "https://120.25.221.144",
                "Access-Control-Request-Method": "POST",
            },
        )
        self.assertEqual(production_origin.status, 204)
        self.assertEqual(
            production_origin.headers["access-control-allow-origin"],
            "https://120.25.221.144",
        )

        admin = await self.request(
            "GET",
            "/admin/api/session",
            headers={"Origin": "https://120.25.221.144"},
        )
        self.assertEqual(admin.status, 401)
        self.assertNotIn("access-control-allow-origin", admin.headers)

        page = await self.request("GET", "/admin")
        self.assertEqual(page.status, 200)
        self.assertIn("frame-ancestors 'none'", page.headers["content-security-policy"])
        self.assertIn("base-uri 'self'", page.headers["content-security-policy"])
        self.assertEqual(page.headers["x-frame-options"], "DENY")
        self.assertIn(
            '<base href="/gkd-feedback/">',
            page.body.decode("utf-8"),
        )
        trailing_page = await self.request("GET", "/admin/")
        self.assertEqual(trailing_page.status, 200)
        self.assertIn(
            '<base href="/gkd-feedback/">',
            trailing_page.body.decode("utf-8"),
        )
        self.assertEqual(
            _feedback_admin_link(self.settings, "feedback-id"),
            "https://120.25.221.144/gkd-feedback/admin?feedback=feedback-id",
        )
        self.assertEqual(
            _redacted_summary("联系 user@example.invalid 或 13800138000"),
            "联系 [邮箱] 或 [数字]",
        )

    async def test_idempotency_and_conflict(self) -> None:
        client_id = str(uuid.uuid4())
        payload = feedback_payload(
            client_id=client_id,
            category="feature",
            description="希望增加反馈分类筛选",
        )
        first = await self.post_feedback(payload)
        self.assertEqual(first.status, 201)
        feedback_id = first.json()["id"]

        duplicate = await self.post_feedback(payload)
        self.assertEqual(duplicate.status, 200)
        self.assertEqual(duplicate.json()["id"], feedback_id)

        changed = feedback_payload(
            client_id=client_id,
            category="feature",
            description="不同内容",
        )
        conflict = await self.post_feedback(changed)
        self.assertEqual(conflict.status, 409)
        with closing(connect_db(self.settings.db_path)) as db:
            category = db.execute(
                "SELECT category FROM feedback WHERE id = ?", (feedback_id,)
            ).fetchone()[0]
        self.assertEqual(category, "feature")

    async def test_daily_budget_survives_restart_and_feedback_deletion(self) -> None:
        fixed_now = 1_900_000_000
        settings = Settings(
            data_dir=Path(self.temp_dir.name) / "budget-restart",
            submit_rate_count=100,
            submit_daily_ip_count=2,
            submit_daily_global_count=20,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        settings.data_dir.mkdir(parents=True)
        settings.attachments_dir.mkdir(parents=True)
        legacy_attachment = settings.attachments_dir / "legacy.txt"
        legacy_attachment.write_bytes(b"legacy")
        with closing(sqlite3.connect(settings.db_path)) as db:
            db.execute("PRAGMA foreign_keys = ON")
            db.executescript(
                """
                CREATE TABLE feedback (
                    id TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL UNIQUE,
                    payload_hash TEXT NOT NULL,
                    category TEXT NOT NULL CHECK (category IN ('tool', 'rule')),
                    description TEXT NOT NULL,
                    contact TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'resolved')),
                    total_bytes INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE attachments (
                    id TEXT PRIMARY KEY,
                    feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
                    original_name TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    byte_size INTEGER NOT NULL,
                    storage_name TEXT NOT NULL UNIQUE
                );
                CREATE TABLE outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    feedback_id TEXT NOT NULL UNIQUE REFERENCES feedback(id) ON DELETE CASCADE,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at INTEGER NOT NULL,
                    sent_at INTEGER,
                    last_error TEXT,
                    created_at INTEGER NOT NULL
                );
                """
            )
            db.execute(
                """
                INSERT INTO feedback (
                    id, client_id, payload_hash, category, description, contact,
                    context_json, status, total_bytes, created_at
                ) VALUES (
                    'legacy-feedback', 'legacy-client-id', 'legacy-hash', 'rule',
                    '旧库反馈', '', '{}', 'pending', 6, ?
                );
                """,
                (fixed_now,),
            )
            db.execute(
                """
                INSERT INTO attachments (
                    id, feedback_id, original_name, mime_type, byte_size, storage_name
                ) VALUES (
                    'legacy-attachment', 'legacy-feedback', 'legacy.txt',
                    'text/plain', 6, 'legacy.txt'
                );
                """
            )
            db.execute(
                """
                INSERT INTO outbox (
                    feedback_id, attempts, next_attempt_at, created_at
                ) VALUES ('legacy-feedback', 0, ?, ?);
                """,
                (fixed_now, fixed_now),
            )
            db.commit()
        first_payload = feedback_payload(category="feature", description="first")
        second_payload = feedback_payload(description="second")
        third_payload = feedback_payload(description="third")

        with patch("app.main._now", return_value=fixed_now):
            first_app = create_app(settings)
            async with first_app.router.lifespan_context(first_app):
                first = await asgi_request(
                    first_app,
                    "POST",
                    "/api/feedback",
                    body=json.dumps(first_payload).encode("utf-8"),
                    headers=json_headers(),
                    client="198.51.100.10",
                )
                self.assertEqual(first.status, 201)
                with closing(connect_db(settings.db_path)) as db:
                    legacy_category = db.execute(
                        "SELECT category FROM feedback WHERE id = 'legacy-feedback'"
                    ).fetchone()[0]
                    self.assertEqual(legacy_category, "rule")
                    self.assertEqual(
                        db.execute(
                            "SELECT feedback_id FROM attachments WHERE id = 'legacy-attachment'"
                        ).fetchone()[0],
                        "legacy-feedback",
                    )
                    self.assertEqual(
                        db.execute(
                            "SELECT feedback_id FROM outbox WHERE feedback_id = 'legacy-feedback'"
                        ).fetchone()[0],
                        "legacy-feedback",
                    )
                    db.execute("DELETE FROM feedback")
                    db.commit()
                    self.assertEqual(
                        db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0], 0
                    )
                    self.assertEqual(
                        db.execute("SELECT COUNT(*) FROM attachments").fetchone()[0], 0
                    )
                    self.assertEqual(
                        db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0
                    )

            restarted_app = create_app(settings)
            async with restarted_app.router.lifespan_context(restarted_app):
                second = await asgi_request(
                    restarted_app,
                    "POST",
                    "/api/feedback",
                    body=json.dumps(second_payload).encode("utf-8"),
                    headers=json_headers(),
                    client="198.51.100.10",
                )
                self.assertEqual(second.status, 201)
                third = await asgi_request(
                    restarted_app,
                    "POST",
                    "/api/feedback",
                    body=json.dumps(third_payload).encode("utf-8"),
                    headers=json_headers(),
                    client="198.51.100.10",
                )
                self.assertEqual(third.status, 429)
                self.assertEqual(
                    third.headers["retry-after"],
                    str(86_400 - fixed_now % 86_400),
                )

        with closing(connect_db(settings.db_path)) as db:
            budget_rows = db.execute(
                "SELECT scope, entry_count FROM feedback_budget ORDER BY scope"
            ).fetchall()
            self.assertEqual(len(budget_rows), 2)
            self.assertTrue(all(row["entry_count"] == 2 for row in budget_rows))
            self.assertTrue(all("198.51.100.10" not in row["scope"] for row in budget_rows))
            self.assertTrue(any(row["scope"].startswith("ip:") for row in budget_rows))
        self.assertEqual(len(settings.ip_hash_salt_path.read_bytes()), 32)

    async def test_daily_budget_idempotency_does_not_consume_quota(self) -> None:
        settings = Settings(
            data_dir=Path(self.temp_dir.name) / "budget-idempotency",
            submit_rate_count=100,
            submit_daily_ip_count=1,
            submit_daily_global_count=1,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        payload = feedback_payload()
        app = create_app(settings)
        async with app.router.lifespan_context(app):
            first = await asgi_request(
                app,
                "POST",
                "/api/feedback",
                body=json.dumps(payload).encode("utf-8"),
                headers=json_headers(),
                client="198.51.100.20",
            )
            duplicate = await asgi_request(
                app,
                "POST",
                "/api/feedback",
                body=json.dumps(payload).encode("utf-8"),
                headers=json_headers(),
                client="198.51.100.20",
            )
            exhausted = await asgi_request(
                app,
                "POST",
                "/api/feedback",
                body=json.dumps(feedback_payload()).encode("utf-8"),
                headers=json_headers(),
                client="198.51.100.20",
            )
        self.assertEqual(first.status, 201)
        self.assertEqual(duplicate.status, 200)
        self.assertEqual(exhausted.status, 429)
        with closing(connect_db(settings.db_path)) as db:
            counts = [
                row[0]
                for row in db.execute(
                    "SELECT entry_count FROM feedback_budget ORDER BY scope"
                ).fetchall()
            ]
        self.assertEqual(counts, [1, 1])

    async def test_daily_budget_failed_transaction_does_not_consume_quota(self) -> None:
        settings = Settings(
            data_dir=Path(self.temp_dir.name) / "budget-rollback",
            submit_daily_ip_count=1,
            submit_daily_global_count=1,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        normalized, decoded = validate_feedback_payload(feedback_payload())
        app = create_app(settings)
        async with app.router.lifespan_context(app):
            with closing(connect_db(settings.db_path)) as db:
                db.execute(
                    """
                    CREATE TRIGGER fail_outbox
                    BEFORE INSERT ON outbox
                    BEGIN
                        SELECT RAISE(ABORT, 'synthetic outbox failure');
                    END
                    """
                )
                db.commit()
            with self.assertRaises(sqlite3.IntegrityError):
                persist_feedback(
                    settings,
                    normalized,
                    decoded,
                    ip="198.51.100.30",
                )
            with closing(connect_db(settings.db_path)) as db:
                self.assertEqual(
                    db.execute("SELECT COUNT(*) FROM feedback_budget").fetchone()[0],
                    0,
                )
                self.assertEqual(
                    db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0], 0
                )
                db.execute("DROP TRIGGER fail_outbox")
                db.commit()

            _, created = persist_feedback(
                settings,
                normalized,
                decoded,
                ip="198.51.100.30",
            )
            _, duplicate_created = persist_feedback(
                settings,
                normalized,
                decoded,
                ip="198.51.100.30",
            )
            self.assertTrue(created)
            self.assertFalse(duplicate_created)
            with closing(connect_db(settings.db_path)) as db:
                counts = [
                    row[0]
                    for row in db.execute(
                        "SELECT entry_count FROM feedback_budget ORDER BY scope"
                    ).fetchall()
                ]
            self.assertEqual(counts, [1, 1])

    async def test_daily_budget_counts_metadata_and_global_limit(self) -> None:
        byte_settings = Settings(
            data_dir=Path(self.temp_dir.name) / "budget-metadata",
            submit_daily_ip_bytes=64,
            submit_daily_global_bytes=1024 * 1024,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        byte_app = create_app(byte_settings)
        async with byte_app.router.lifespan_context(byte_app):
            metadata_limited = await asgi_request(
                byte_app,
                "POST",
                "/api/feedback",
                body=json.dumps(
                    feedback_payload(description="metadata " * 50)
                ).encode("utf-8"),
                headers=json_headers(),
                client="198.51.100.40",
            )
        self.assertEqual(metadata_limited.status, 429)
        with closing(connect_db(byte_settings.db_path)) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM feedback_budget").fetchone()[0], 0
            )

        global_byte_settings = Settings(
            data_dir=Path(self.temp_dir.name) / "budget-global-bytes",
            submit_daily_ip_bytes=1024 * 1024,
            submit_daily_global_bytes=64,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        global_byte_app = create_app(global_byte_settings)
        async with global_byte_app.router.lifespan_context(global_byte_app):
            global_metadata_limited = await asgi_request(
                global_byte_app,
                "POST",
                "/api/feedback",
                body=json.dumps(
                    feedback_payload(description="metadata " * 50)
                ).encode("utf-8"),
                headers=json_headers(),
                client="198.51.100.45",
            )
        self.assertEqual(global_metadata_limited.status, 429)
        with closing(connect_db(global_byte_settings.db_path)) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM feedback_budget").fetchone()[0], 0
            )

        global_settings = Settings(
            data_dir=Path(self.temp_dir.name) / "budget-global",
            submit_rate_count=100,
            submit_daily_ip_count=100,
            submit_daily_global_count=2,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        global_app = create_app(global_settings)
        async with global_app.router.lifespan_context(global_app):
            responses = []
            for suffix in (40, 41, 42):
                responses.append(
                    await asgi_request(
                        global_app,
                        "POST",
                        "/api/feedback",
                        body=json.dumps(feedback_payload()).encode("utf-8"),
                        headers=json_headers(),
                        client=f"198.51.100.{suffix}",
                    )
                )
        self.assertEqual([response.status for response in responses], [201, 201, 429])

    async def test_malformed_values_are_rejected_without_internal_errors(self) -> None:
        for category in ([], {}, None, "suggestion", "FEATURE"):
            payload = feedback_payload()
            payload["category"] = category
            self.assertEqual((await self.post_feedback(payload)).status, 422)
        for mime_type in ([], {}, None):
            payload = feedback_payload(attachments=[{"name": "bad.txt", "mimeType": mime_type, "data": ""}])
            self.assertEqual((await self.post_feedback(payload)).status, 422)
        self.assertEqual((await self.post_feedback(feedback_payload(description="  "))).status, 422)
        oversized_png = bytearray(PNG_BYTES)
        oversized_png[16:20] = (100000).to_bytes(4, "big")
        result = await self.post_feedback(feedback_payload(attachments=[{
            "name": "oversized.png", "mimeType": "image/png", "data": base64.b64encode(oversized_png).decode()}]))
        self.assertEqual(result.status, 422)
        for username, password in (("管理员", "wrong"), ("\ud800", "wrong"), ("admin-test", "\ud800")):
            result = await self.request("POST", "/admin/api/login",
                body=json.dumps({"username": username, "password": password}).encode(), headers=json_headers())
            self.assertEqual(result.status, 401)
        created = await self.post_feedback(feedback_payload())
        cookie, csrf = await self.login()
        result = await self.request("PATCH", "/admin/api/feedback/" + created.json()["id"],
            body=b'{"status":{}}', headers=json_headers({"Cookie": cookie, "X-CSRF-Token": csrf}))
        self.assertEqual(result.status, 422)

        with closing(connect_db(self.settings.db_path)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 1)

    async def test_context_field_limits(self) -> None:
        app_version_too_long = feedback_payload()
        app_version_too_long["context"]["appVersion"] = "a" * 201
        response = await self.post_feedback(app_version_too_long)
        self.assertEqual(response.status, 422)

        error_too_long = feedback_payload()
        error_too_long["context"]["error"] = "e" * 4001
        response = await self.post_feedback(error_too_long)
        self.assertEqual(response.status, 422)

        gkd_channel_too_long = feedback_payload()
        gkd_channel_too_long["context"]["gkdChannel"] = "x" * 21
        response = await self.post_feedback(gkd_channel_too_long)
        self.assertEqual(response.status, 422)

    async def test_attachment_validation_safe_storage_and_download(self) -> None:
        bad_png = feedback_payload(
            attachments=[
                {
                    "name": "../../evil.png",
                    "mimeType": "image/png",
                    "data": base64.b64encode(b"not a png").decode("ascii"),
                }
            ]
        )
        invalid = await self.post_feedback(bad_png)
        self.assertEqual(invalid.status, 422)

        five = [
            {
                "name": f"{index}.txt",
                "mimeType": "text/plain",
                "data": base64.b64encode(b"text").decode("ascii"),
            }
            for index in range(5)
        ]
        too_many = await self.post_feedback(feedback_payload(attachments=five))
        self.assertEqual(too_many.status, 422)

        invalid_json = await self.post_feedback(
            feedback_payload(
                attachments=[
                    {
                        "name": "nodes.json",
                        "mimeType": "application/json",
                        "data": base64.b64encode(b"{invalid").decode("ascii"),
                    }
                ]
            )
        )
        self.assertEqual(invalid_json.status, 422)

        with patch("app.main.ATTACHMENT_BYTE_LIMIT", 64):
            too_large = await self.post_feedback(
                feedback_payload(
                    attachments=[
                        {
                            "name": "large.txt",
                            "mimeType": "text/plain",
                            "data": base64.b64encode(b"x" * 65).decode("ascii"),
                        }
                    ]
                )
            )
        self.assertEqual(too_large.status, 422)

        accepted_payload = feedback_payload(
            attachments=[
                {
                    "name": "../../界面截图.png",
                    "mimeType": "image/png",
                    "data": base64.b64encode(PNG_BYTES).decode("ascii"),
                },
                {
                    "name": "log.txt",
                    "mimeType": "text/plain",
                    "data": base64.b64encode(b"synthetic log").decode("ascii"),
                },
                {
                    "name": "nodes.json",
                    "mimeType": "application/json",
                    "data": base64.b64encode(b'{"nodes":[]}').decode("ascii"),
                },
                {
                    "name": "gkd-log.zip",
                    "mimeType": "application/zip",
                    "data": base64.b64encode(b"PK\x03\x04synthetic").decode("ascii"),
                },
            ]
        )
        accepted = await self.post_feedback(accepted_payload)
        self.assertEqual(accepted.status, 201)
        files = list(self.settings.attachments_dir.iterdir())
        self.assertEqual(len(files), 4)
        self.assertTrue(all(".." not in item.name for item in files))

        cookie, _ = await self.login()
        detail = await self.request(
            "GET",
            f"/admin/api/feedback/{accepted.json()['id']}",
            headers={"Cookie": cookie},
        )
        self.assertEqual(detail.status, 200)
        attachment = detail.json()["attachments"][0]
        download = await self.request(
            "GET",
            (
                f"/admin/api/feedback/{accepted.json()['id']}"
                f"/attachments/{attachment['id']}"
            ),
            headers={"Cookie": cookie},
        )
        self.assertEqual(download.status, 200)
        self.assertEqual(download.body, PNG_BYTES)
        self.assertTrue(
            download.headers["content-disposition"].startswith("attachment;")
        )
        self.assertIn("sandbox", download.headers["content-security-policy"])

    async def test_streamed_body_cap(self) -> None:
        body = b"{" + b" " * FEEDBACK_BODY_LIMIT + b"}"
        response = await self.request(
            "POST",
            "/api/feedback",
            body=body,
            headers={"Content-Type": "application/json"},
            include_content_length=False,
        )
        self.assertEqual(response.status, 413)

    async def test_rate_limit_and_trusted_proxy_boundary(self) -> None:
        limited_settings = Settings(
            data_dir=Path(self.temp_dir.name) / "rate-test",
            submit_rate_count=1,
            submit_rate_window=60,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
            trusted_proxy_ips="10.0.0.0/8",
        )
        limited_app = create_app(limited_settings)
        async with limited_app.router.lifespan_context(limited_app):
            first = await asgi_request(
                limited_app,
                "POST",
                "/api/feedback",
                body=json.dumps(feedback_payload()).encode("utf-8"),
                headers=json_headers({"X-Forwarded-For": "198.51.100.50"}),
                client="10.0.0.2",
            )
            self.assertEqual(first.status, 201)
            second_client = await asgi_request(
                limited_app,
                "POST",
                "/api/feedback",
                body=json.dumps(feedback_payload()).encode("utf-8"),
                headers=json_headers({"X-Forwarded-For": "198.51.100.51"}),
                client="10.0.0.2",
            )
            self.assertEqual(second_client.status, 201)
            repeated = await asgi_request(
                limited_app,
                "POST",
                "/api/feedback",
                body=json.dumps(feedback_payload()).encode("utf-8"),
                headers=json_headers({"X-Forwarded-For": "198.51.100.50"}),
                client="10.0.0.2",
            )
            self.assertEqual(repeated.status, 429)

        request = Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/",
                "headers": [(b"x-forwarded-for", b"203.0.113.99")],
                "client": ("198.51.100.8", 1234),
            }
        )
        self.assertEqual(client_ip(request, limited_app.state.trusted_proxies), "198.51.100.8")

    async def test_sliding_window_limiter_caps_bucket_count(self) -> None:
        limiter = SlidingWindowLimiter(10, 60, max_buckets=2)
        with patch("app.main.time.monotonic", return_value=1_000.0):
            self.assertEqual(await limiter.allow("first"), (True, 0))
            self.assertEqual(await limiter.allow("second"), (True, 0))
            self.assertEqual(await limiter.allow("third"), (False, 60))
            self.assertEqual(len(limiter.events), 2)
            self.assertNotIn("third", limiter.events)

        with patch("app.main.time.monotonic", return_value=1_061.0):
            self.assertEqual(await limiter.allow("third"), (True, 0))
            self.assertEqual(len(limiter.events), 1)

    async def test_submission_parser_concurrency_is_bounded(self) -> None:
        settings = Settings(
            data_dir=Path(self.temp_dir.name) / "submit-concurrency",
            submit_rate_count=100,
            submit_daily_ip_count=100,
            submit_daily_global_count=100,
            submit_concurrency=2,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        app = create_app(settings)
        active = 0
        maximum = 0
        both_started = asyncio.Event()
        release = asyncio.Event()

        async def delayed_json_body(request):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            if active == 2:
                both_started.set()
            await release.wait()
            active -= 1
            return feedback_payload()

        async with app.router.lifespan_context(app):
            with patch("app.main.read_json_body", delayed_json_body):
                tasks = [
                    asyncio.create_task(
                        asgi_request(
                            app,
                            "POST",
                            "/api/feedback",
                            body=b"{}",
                            headers=json_headers(),
                            client=f"198.51.100.{50 + index}",
                        )
                    )
                    for index in range(3)
                ]
                try:
                    await asyncio.wait_for(both_started.wait(), timeout=2)
                    await asyncio.sleep(0.05)
                    self.assertEqual(active, 2)
                    self.assertEqual(maximum, 2)
                finally:
                    release.set()
                responses = await asyncio.gather(*tasks)
        self.assertEqual([response.status for response in responses], [201, 201, 201])

    async def test_admin_auth_csrf_status_delete_and_cookie(self) -> None:
        payload = feedback_payload(
            category="feature",
            attachments=[
                {
                    "name": "capture.png",
                    "mimeType": "image/png",
                    "data": base64.b64encode(PNG_BYTES).decode("ascii"),
                }
            ]
        )
        created = await self.post_feedback(payload)
        self.assertEqual(created.status, 201)
        feedback_id = created.json()["id"]

        wrong = await self.request(
            "POST",
            "/admin/api/login",
            body=json.dumps(
                {"username": "admin-test", "password": "wrong"}
            ).encode("utf-8"),
            headers=json_headers(),
        )
        self.assertEqual(wrong.status, 401)

        login = await self.request(
            "POST",
            "/admin/api/login",
            body=json.dumps(
                {
                    "username": "admin-test",
                    "password": "correct-test-password",
                }
            ).encode("utf-8"),
            headers=json_headers(),
        )
        self.assertEqual(login.status, 200)
        cookie_header = login.headers["set-cookie"]
        self.assertIn("HttpOnly", cookie_header)
        self.assertIn("SameSite=strict", cookie_header)
        self.assertIn("Path=/gkd-feedback/admin", cookie_header)
        self.assertNotIn("Secure", cookie_header)
        cookie = cookie_header.split(";", 1)[0]

        session = await self.request(
            "GET", "/admin/api/session", headers={"Cookie": cookie}
        )
        csrf = session.json()["csrfToken"]

        no_csrf = await self.request(
            "PATCH",
            f"/admin/api/feedback/{feedback_id}",
            body=b'{"status":"resolved"}',
            headers=json_headers({"Cookie": cookie}),
        )
        self.assertEqual(no_csrf.status, 403)

        resolved = await self.request(
            "PATCH",
            f"/admin/api/feedback/{feedback_id}",
            body=b'{"status":"resolved"}',
            headers=json_headers(
                {"Cookie": cookie, "X-CSRF-Token": csrf}
            ),
        )
        self.assertEqual(resolved.status, 200)
        detail = await self.request(
            "GET",
            f"/admin/api/feedback/{feedback_id}",
            headers={"Cookie": cookie},
        )
        self.assertEqual(detail.json()["category"], "feature")
        self.assertEqual(detail.json()["status"], "resolved")
        listed = await self.request(
            "GET",
            "/admin/api/feedback?status=resolved&page=1&limit=50",
            headers={"Cookie": cookie},
        )
        self.assertEqual(listed.json()["items"][0]["category"], "feature")
        self.assertEqual(len(list(self.settings.attachments_dir.iterdir())), 1)

        deleted = await self.request(
            "DELETE",
            f"/admin/api/feedback/{feedback_id}",
            headers={"Cookie": cookie, "X-CSRF-Token": csrf},
        )
        self.assertEqual(deleted.status, 204)
        self.assertEqual(list(self.settings.attachments_dir.iterdir()), [])

        with closing(connect_db(self.settings.db_path)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)

    async def test_quota_count_and_outbox_failure_retry(self) -> None:
        quota_settings = Settings(
            data_dir=Path(self.temp_dir.name) / "quota-test",
            max_feedback_count=1,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        quota_app = create_app(quota_settings)
        async with quota_app.router.lifespan_context(quota_app):
            first = await asgi_request(
                quota_app,
                "POST",
                "/api/feedback",
                body=json.dumps(feedback_payload()).encode("utf-8"),
                headers=json_headers(),
            )
            self.assertEqual(first.status, 201)
            second = await asgi_request(
                quota_app,
                "POST",
                "/api/feedback",
                body=json.dumps(feedback_payload()).encode("utf-8"),
                headers=json_headers(),
            )
            self.assertEqual(second.status, 507)

        storage_settings = Settings(
            data_dir=Path(self.temp_dir.name) / "storage-test",
            max_storage_bytes=1,
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        storage_app = create_app(storage_settings)
        async with storage_app.router.lifespan_context(storage_app):
            storage_full = await asgi_request(
                storage_app,
                "POST",
                "/api/feedback",
                body=json.dumps(feedback_payload()).encode("utf-8"),
                headers=json_headers(),
            )
            self.assertEqual(storage_full.status, 507)

        smtp_settings = Settings(
            data_dir=Path(self.temp_dir.name) / "smtp-test",
            smtp_host="smtp.invalid",
            smtp_from="sender@example.invalid",
            smtp_to="3428864257@qq.com",
            smtp_security="starttls",
            maintenance_interval=3600,
            outbox_poll_interval=3600,
        )
        smtp_app = create_app(smtp_settings)
        async def idle_outbox_loop(settings, stop_event):
            await stop_event.wait()

        with patch("app.main.outbox_loop", idle_outbox_loop):
            async with smtp_app.router.lifespan_context(smtp_app):
                created = await asgi_request(
                    smtp_app,
                    "POST",
                    "/api/feedback",
                    body=json.dumps(feedback_payload()).encode("utf-8"),
                    headers=json_headers(),
                )
                self.assertEqual(created.status, 201)
                with patch(
                    "app.main._send_notification", side_effect=OSError("synthetic")
                ):
                    process_outbox(smtp_settings)
                with closing(connect_db(smtp_settings.db_path)) as db:
                    row = db.execute(
                        "SELECT attempts, next_attempt_at, sent_at, last_error FROM outbox"
                    ).fetchone()
            self.assertEqual(row["attempts"], 1)
            self.assertIsNone(row["sent_at"])
            self.assertEqual(row["last_error"], "OSError")
            self.assertGreater(row["next_attempt_at"], int(time.time()))

    async def test_retention_removes_feedback_contact_attachment_and_outbox(self) -> None:
        payload = feedback_payload(
            contact="must-disappear@example.invalid",
            attachments=[
                {
                    "name": "old.txt",
                    "mimeType": "text/plain",
                    "data": base64.b64encode(b"old attachment").decode("ascii"),
                }
            ],
        )
        created = await self.post_feedback(payload)
        self.assertEqual(created.status, 201)
        files = list(self.settings.attachments_dir.iterdir())
        self.assertEqual(len(files), 1)

        now = int(time.time())
        old = now - 91 * 86400
        with closing(sqlite3.connect(self.settings.db_path)) as db:
            db.execute("UPDATE feedback SET created_at = ?", (old,))
            for offset in range(3):
                day = time.strftime("%Y-%m-%d", time.gmtime(now - offset * 86400))
                db.execute(
                    """
                    INSERT INTO feedback_budget (utc_day, scope, entry_count, total_bytes)
                    VALUES (?, ?, 1, 1)
                    """,
                    (day, f"test-{offset}"),
                )
            db.commit()
        with patch("app.main._now", return_value=now):
            deleted = cleanup_expired(self.settings)
        self.assertEqual(deleted, 1)
        self.assertFalse(files[0].exists())
        with closing(connect_db(self.settings.db_path)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM feedback").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0], 0)
            budget_days = {
                row[0]
                for row in db.execute(
                    "SELECT DISTINCT utc_day FROM feedback_budget"
                ).fetchall()
            }
            self.assertEqual(
                budget_days,
                {
                    time.strftime("%Y-%m-%d", time.gmtime(now)),
                    time.strftime("%Y-%m-%d", time.gmtime(now - 86400)),
                },
            )
            schema = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='feedback'"
            ).fetchone()[0]
        self.assertIn("contact", schema)

    def announcement_payload(self, **overrides) -> dict:
        payload = {
            "enabled": True,
            "type": "notice",
            "title": "测试公告",
            "content": "这是一条测试公告正文。",
            "forced": False,
            "versionName": "",
            "versionCode": "",
            "apkUrl": "",
            "sha256": "",
            "actionText": "",
            "actionUrl": "",
        }
        payload.update(overrides)
        return payload

    async def publish_announcement(self, cookie: str, csrf: str, **overrides) -> ASGIResponse:
        return await self.request(
            "POST",
            "/admin/api/announcement",
            body=json.dumps(self.announcement_payload(**overrides)).encode("utf-8"),
            headers=json_headers({"Cookie": cookie, "X-CSRF-Token": csrf}),
        )

    async def test_announcement_public_endpoint_and_cors(self) -> None:
        response = await self.request("GET", "/api/announcement")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "*")
        self.assertIn("max-age=15", response.headers["cache-control"])
        data = response.json()
        self.assertFalse(data["enabled"])
        self.assertEqual(data["type"], "notice")

        preflight = await self.request(
            "OPTIONS",
            "/api/announcement",
            headers={"Origin": "null", "Access-Control-Request-Method": "GET"},
        )
        self.assertEqual(preflight.status, 204)
        self.assertEqual(preflight.headers["access-control-allow-origin"], "*")
        self.assertIn("GET", preflight.headers["access-control-allow-methods"])

    async def test_announcement_publish_requires_login_and_csrf(self) -> None:
        unauthenticated = await self.request(
            "POST",
            "/admin/api/announcement",
            body=json.dumps(self.announcement_payload()).encode("utf-8"),
            headers=json_headers(),
        )
        self.assertEqual(unauthenticated.status, 401)

        cookie, _csrf = await self.login()
        missing_csrf = await self.request(
            "POST",
            "/admin/api/announcement",
            body=json.dumps(self.announcement_payload()).encode("utf-8"),
            headers=json_headers({"Cookie": cookie}),
        )
        self.assertEqual(missing_csrf.status, 403)

    async def test_announcement_publish_history_and_toggle(self) -> None:
        cookie, csrf = await self.login()
        published = await self.publish_announcement(cookie, csrf)
        self.assertEqual(published.status, 200)
        first = published.json()["announcement"]
        self.assertTrue(first["id"].startswith("ann-"))
        self.assertEqual(first["title"], "测试公告")
        self.assertTrue(first["enabled"])

        public = await self.request("GET", "/api/announcement")
        self.assertEqual(public.json()["id"], first["id"])
        self.assertEqual(public.json()["content"], "这是一条测试公告正文。")

        status = await self.request(
            "GET",
            "/admin/api/announcement",
            headers={"Cookie": cookie},
        )
        self.assertEqual(status.status, 200)
        self.assertEqual(status.json()["current"]["id"], first["id"])
        self.assertEqual(len(status.json()["history"]), 1)
        self.assertTrue(status.json()["publicUrl"].endswith("/api/announcement"))

        toggled = await self.request(
            "POST",
            "/admin/api/announcement/toggle",
            body=json.dumps({"enabled": False}).encode("utf-8"),
            headers=json_headers({"Cookie": cookie, "X-CSRF-Token": csrf}),
        )
        self.assertEqual(toggled.status, 200)
        self.assertFalse(toggled.json()["enabled"])
        public = await self.request("GET", "/api/announcement")
        self.assertFalse(public.json()["enabled"])
        self.assertEqual(public.json()["id"], first["id"])

        republished = await self.publish_announcement(cookie, csrf, title="第二条公告")
        self.assertEqual(republished.status, 200)
        self.assertNotEqual(republished.json()["announcement"]["id"], first["id"])
        status = await self.request(
            "GET",
            "/admin/api/announcement",
            headers={"Cookie": cookie},
        )
        self.assertEqual(len(status.json()["history"]), 2)

    async def test_announcement_validation(self) -> None:
        cookie, csrf = await self.login()
        empty_title = await self.publish_announcement(cookie, csrf, title="   ")
        self.assertEqual(empty_title.status, 422)

        update_without_apk = await self.publish_announcement(
            cookie, csrf, type="update", versionName="0.2.2"
        )
        self.assertEqual(update_without_apk.status, 422)

        bad_url = await self.publish_announcement(
            cookie,
            csrf,
            type="update",
            versionName="0.2.2",
            apkUrl="javascript:alert(1)",
        )
        self.assertEqual(bad_url.status, 422)

        bad_code = await self.publish_announcement(cookie, csrf, versionCode="abc")
        self.assertEqual(bad_code.status, 422)

    async def test_announcement_update_adds_github_mirrors(self) -> None:
        cookie, csrf = await self.login()
        checksum = "a" * 64
        published = await self.publish_announcement(
            cookie,
            csrf,
            type="update",
            versionName="0.2.2",
            versionCode="202",
            apkUrl="https://github.com/jjjj31/gkd-rule-studio/releases/download/v0.2.2/app-release.apk",
            sha256=checksum,
        )
        self.assertEqual(published.status, 200)
        mirrors = published.json()["announcement"]["mirrors"]
        self.assertEqual(len(mirrors), 3)
        self.assertTrue(mirrors[0].startswith("https://ghproxy.net/https://github.com/"))

        public = await self.request("GET", "/api/announcement")
        self.assertEqual(public.json()["versionName"], "0.2.2")
        self.assertEqual(public.json()["versionCode"], 202)
        self.assertEqual(len(public.json()["mirrors"]), 3)
        self.assertEqual(public.json()["sha256"], checksum)

        bad_checksum = await self.publish_announcement(
            cookie,
            csrf,
            type="update",
            versionName="0.2.2",
            apkUrl="https://example.com/app.apk",
            sha256="not-a-checksum",
        )
        self.assertEqual(bad_checksum.status, 422)

    async def test_announcement_toggle_without_publish_returns_404(self) -> None:
        cookie, csrf = await self.login()
        response = await self.request(
            "POST",
            "/admin/api/announcement/toggle",
            body=json.dumps({"enabled": True}).encode("utf-8"),
            headers=json_headers({"Cookie": cookie, "X-CSRF-Token": csrf}),
        )
        self.assertEqual(response.status, 404)


if __name__ == "__main__":
    unittest.main()
