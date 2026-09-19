import io
import subprocess
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

    def test_mixed_job_accepts_stage_file_and_youtube_mv(self):
        captured = {}

        def fake_sources(**kwargs):
            captured.update(kwargs)
            return {"mixed": True}

        with backend.RATE_LIMITS_LOCK:
            backend.RATE_LIMITS.clear()
            backend.GLOBAL_RATE_LIMITS.clear()
        with (
            mock.patch.object(backend, "_validate_media_duration", return_value=30.0),
            mock.patch.object(backend, "_run_sources", side_effect=fake_sources),
        ):
            response = self.client.post(
                "/mixed/start",
                data={
                    "video": (io.BytesIO(b"stage-audio"), "stage.mp3"),
                    "kara_url": "https://youtu.be/jNQXAC9IVRw",
                },
                content_type="multipart/form-data",
            )
            self.assertEqual(response.status_code, 202)
            job_id = response.get_json()["job_id"]
            deadline = time.time() + 3
            while time.time() < deadline:
                state = backend._job_snapshot(job_id)
                if state and state.get("status") == "complete":
                    break
                time.sleep(0.02)
            else:
                self.fail("mixed-source job did not finish")

        self.assertTrue(captured["video_name"].endswith(".mp3"))
        self.assertEqual(captured["video_url"], "")
        self.assertIsNone(captured["karaoke_name"])
        self.assertEqual(captured["karaoke_url"], "https://youtu.be/jNQXAC9IVRw")
        (backend.MEDIA_DIR / captured["video_name"]).unlink(missing_ok=True)

    def test_mixed_job_accepts_youtube_stage_and_mv_file(self):
        captured = {}

        def fake_sources(**kwargs):
            captured.update(kwargs)
            return {"mixed": True}

        with backend.RATE_LIMITS_LOCK:
            backend.RATE_LIMITS.clear()
            backend.GLOBAL_RATE_LIMITS.clear()
        with (
            mock.patch.object(backend, "_validate_media_duration", return_value=30.0),
            mock.patch.object(backend, "_run_sources", side_effect=fake_sources),
        ):
            response = self.client.post(
                "/mixed/start",
                data={
                    "video_url": "https://youtu.be/jNQXAC9IVRw",
                    "karaoke": (io.BytesIO(b"mv-audio"), "mv.mp3"),
                },
                content_type="multipart/form-data",
            )
            self.assertEqual(response.status_code, 202)
            job_id = response.get_json()["job_id"]
            deadline = time.time() + 3
            while time.time() < deadline:
                state = backend._job_snapshot(job_id)
                if state and state.get("status") == "complete":
                    break
                time.sleep(0.02)
            else:
                self.fail("reverse mixed-source job did not finish")

        self.assertIsNone(captured["video_name"])
        self.assertEqual(captured["video_url"], "https://youtu.be/jNQXAC9IVRw")
        self.assertTrue(captured["karaoke_name"].endswith(".mp3"))
        self.assertEqual(captured["karaoke_url"], "")
        (backend.MEDIA_DIR / captured["karaoke_name"]).unlink(missing_ok=True)

    def test_mixed_job_requires_exactly_one_source_for_each_side(self):
        response = self.client.post(
            "/mixed/start",
            data={
                "video": (io.BytesIO(b"stage-audio"), "stage.mp3"),
                "video_url": "https://youtu.be/jNQXAC9IVRw",
                "kara_url": "https://youtu.be/jNQXAC9IVRw",
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("どちらか一方", response.get_json()["error"])

    def test_mixed_job_rejects_non_youtube_url(self):
        response = self.client.post(
            "/mixed/start",
            data={
                "video_url": "https://example.com/video",
                "kara_url": "https://youtu.be/jNQXAC9IVRw",
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("YouTube", response.get_json()["error"])

    def test_uploaded_stage_video_is_split_into_preview_and_analysis_audio(self):
        video_name = f"stage_{uuid.uuid4().hex}.mp4"
        karaoke_name = f"mv_{uuid.uuid4().hex}.wav"
        video_path = backend.MEDIA_DIR / video_name
        karaoke_path = backend.MEDIA_DIR / karaoke_name
        video_path.write_bytes(b"video")
        karaoke_path.write_bytes(b"audio")
        try:
            with (
                mock.patch.object(
                    backend,
                    "_extract_uploaded_video_audio",
                    return_value="stage_audio_test.wav",
                ) as split_audio,
                mock.patch.object(
                    backend,
                    "_extract",
                    return_value={"vocal_url": "/media/vocal.wav"},
                ) as extract,
            ):
                result = backend._run_sources(
                    video_name=video_name,
                    karaoke_name=karaoke_name,
                    preview_is_audio_only=False,
                )

            split_audio.assert_called_once_with(video_name)
            self.assertEqual(result["video_filename"], video_name)
            self.assertEqual(result["video_audio_filename"], "stage_audio_test.wav")
            self.assertFalse(result["preview_is_audio_only"])
            self.assertEqual(extract.call_args.args[0], "stage_audio_test.wav")
            self.assertEqual(extract.call_args.args[1], karaoke_name)
            self.assertEqual(extract.call_args.args[4], video_name)
        finally:
            video_path.unlink(missing_ok=True)
            karaoke_path.unlink(missing_ok=True)

    @unittest.skipUnless(
        backend.FFMPEG_PATH and backend.FFPROBE_PATH,
        "FFmpeg and FFprobe are required",
    )
    def test_video_audio_split_produces_mono_44100_wav(self):
        video_name = f"split_source_{uuid.uuid4().hex}.mp4"
        video_path = backend.MEDIA_DIR / video_name
        audio_path = None
        try:
            subprocess.run(
                [
                    backend.FFMPEG_PATH,
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=black:s=160x90:d=1",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-shortest",
                    "-c:v",
                    "mpeg4",
                    "-c:a",
                    "aac",
                    str(video_path),
                ],
                check=True,
                capture_output=True,
                timeout=30,
            )
            self.assertTrue(backend._media_has_video_stream(video_path))
            audio_name = backend._extract_uploaded_video_audio(video_name)
            audio_path = backend.MEDIA_DIR / audio_name
            self.assertFalse(backend._media_has_video_stream(audio_path))
            probe = subprocess.run(
                [
                    backend.FFPROBE_PATH,
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=sample_rate,channels,codec_name",
                    "-of",
                    "default=noprint_wrappers=1",
                    str(audio_path),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=20,
            )
            self.assertIn("codec_name=pcm_s16le", probe.stdout)
            self.assertIn("sample_rate=44100", probe.stdout)
            self.assertIn("channels=1", probe.stdout)
        finally:
            video_path.unlink(missing_ok=True)
            if audio_path:
                audio_path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
