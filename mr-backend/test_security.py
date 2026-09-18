import time
import threading
import unittest
import uuid
from unittest import mock

import app as backend


class SecurityBoundaryTests(unittest.TestCase):
    def setUp(self):
        backend.app.config.update(TESTING=True)
        self.client = backend.app.test_client()

    def test_security_headers_are_present(self):
        response = self.client.get("/", base_url="https://example.test")
        self.assertEqual(response.status_code, 200)
        self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertEqual(response.headers["Cross-Origin-Opener-Policy"], "same-origin")
        self.assertIn("max-age=31536000", response.headers["Strict-Transport-Security"])

    def test_untrusted_browser_origin_cannot_start_processing(self):
        response = self.client.post(
            "/download/start",
            json={"video_url": "https://youtu.be/jNQXAC9IVRw", "kara_url": "https://youtu.be/jNQXAC9IVRw"},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(response.status_code, 403)

    def test_private_network_origin_is_not_implicitly_trusted(self):
        response = self.client.options(
            "/health",
            headers={"Origin": "http://192.168.1.50:9999"},
        )
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_large_json_body_is_rejected_before_parsing(self):
        response = self.client.post(
            "/extract",
            data=b"x" * (backend.MAX_JSON_BODY_BYTES + 1),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 413)

    def test_integrated_helper_routes_are_hidden_when_not_configured(self):
        with mock.patch.object(backend, "INTEGRATED_NODE_GATEWAY_URL", ""):
            response = self.client.post("/api/pot", json={"videoId": "jNQXAC9IVRw"})
        self.assertEqual(response.status_code, 404)

    def test_integrated_helper_body_limit_is_enforced(self):
        response = self.client.post(
            "/api/decipher",
            data=b"x" * (backend.MAX_JSON_BODY_BYTES + 1),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 413)

    def test_media_requires_a_valid_expiring_signature(self):
        name = f"security_test_{uuid.uuid4().hex}.txt"
        path = backend.MEDIA_DIR / name
        path.write_bytes(b"ok")
        try:
            unsigned = self.client.get(f"/media/{name}")
            self.assertEqual(unsigned.status_code, 403)
            unsigned.close()
            signed = self.client.get(backend._media_url(name))
            self.assertEqual(signed.status_code, 200)
            self.assertEqual(signed.data, b"ok")
            signed.close()
            expired = backend._signed_url(f"/media/{name}")
            expired = expired.replace(
                f"expires={int(time.time()) + backend.MEDIA_TTL_SECONDS}",
                "expires=1",
            )
            expired_response = self.client.get(expired)
            self.assertEqual(expired_response.status_code, 403)
            expired_response.close()
        finally:
            path.unlink(missing_ok=True)

    def test_video_rendering_requires_signature(self):
        response = self.client.get("/render-video?video=a.mp4&audio=b.wav&offset=0")
        self.assertEqual(response.status_code, 403)

    def test_public_defaults_fit_the_free_instance_budget(self):
        self.assertLessEqual(backend.MAX_CONTENT_MB, 80)
        self.assertLessEqual(backend.MAX_MEDIA_DURATION_SECONDS, 240)
        self.assertEqual(backend.MAX_CONCURRENT_JOBS, 1)
        self.assertLessEqual(backend.MAX_QUEUED_JOBS, 5)

    def test_health_exposes_the_single_worker_queue_limits(self):
        response = self.client.get("/health")
        payload = response.get_json()
        self.assertEqual(payload["limits"]["max_concurrent_jobs"], 1)
        self.assertEqual(payload["limits"]["max_queued_jobs"], backend.MAX_QUEUED_JOBS)
        self.assertIn("waiting", payload["queue"])
        self.assertEqual(payload["node_gateway"]["status"], "disabled")

    def test_health_fails_when_configured_node_gateway_is_down(self):
        with mock.patch.object(backend, "INTEGRATED_NODE_GATEWAY_URL", "http://127.0.0.1:1"):
            response = self.client.get("/health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["node_gateway"]["status"], "unavailable")

    def test_queued_url_jobs_never_overlap(self):
        running = 0
        max_running = 0
        lock = threading.Lock()

        def fake_download(_video_url, _karaoke_url, progress=None):
            nonlocal running, max_running
            with lock:
                running += 1
                max_running = max(max_running, running)
            if progress:
                progress(50, "test")
            time.sleep(0.08)
            with lock:
                running -= 1
            return {"test": True}

        payload = {
            "video_url": "https://youtu.be/jNQXAC9IVRw",
            "kara_url": "https://youtu.be/jNQXAC9IVRw",
        }
        with backend.RATE_LIMITS_LOCK:
            backend.RATE_LIMITS.clear()
            backend.GLOBAL_RATE_LIMITS.clear()
        with mock.patch.object(backend, "_run_download", side_effect=fake_download):
            first = self.client.post("/download/start", json=payload).get_json()
            second = self.client.post("/download/start", json=payload).get_json()
            deadline = time.time() + 3
            while time.time() < deadline:
                states = [backend._job_snapshot(first["job_id"]), backend._job_snapshot(second["job_id"])]
                if all(state and state.get("status") == "complete" for state in states):
                    break
                time.sleep(0.02)
            else:
                self.fail("queued jobs did not finish")

        self.assertEqual(max_running, 1)


if __name__ == "__main__":
    unittest.main()
