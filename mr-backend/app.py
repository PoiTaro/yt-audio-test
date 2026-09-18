"""MR除去 Web UI のローカル Flask サーバー。"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename


BASE_DIR = Path(__file__).resolve().parent


def _load_local_environment(path: Path) -> None:
    """Git管理外のローカル設定を既存の環境変数より低い優先度で読む。"""
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


_load_local_environment(BASE_DIR / ".env.local")
MEDIA_DIR = BASE_DIR / "web_media"
MEDIA_DIR.mkdir(exist_ok=True)
SAMPLE_RATE = 44_100
FFMPEG_PATH = shutil.which("ffmpeg")
FFPROBE_PATH = shutil.which("ffprobe")
YT_AUDIO_WORKER_URL = os.environ.get(
    "YT_AUDIO_WORKER_URL",
    "https://yt-audio-regional-resolver.youtube-audio-stream-probe.workers.dev/audio",
).strip()


def _integer_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    """環境変数の整数設定を安全な範囲で読み込む。"""
    raw_value = os.environ.get(name, "").strip()
    try:
        value = int(raw_value) if raw_value else default
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


MAX_CONTENT_MB = _integer_setting("MAX_CONTENT_MB", 200, 25, 500)
MAX_MEDIA_DURATION_SECONDS = _integer_setting("MAX_MEDIA_DURATION_SECONDS", 10 * 60, 60, 60 * 60)
MEDIA_TTL_SECONDS = _integer_setting("MEDIA_TTL_SECONDS", 30 * 60, 5 * 60, 24 * 60 * 60)
MAX_CONCURRENT_JOBS = _integer_setting("MAX_CONCURRENT_JOBS", 1, 1, 4)
RATE_LIMIT_REQUESTS = _integer_setting("RATE_LIMIT_REQUESTS", 5, 1, 100)
RATE_LIMIT_WINDOW_SECONDS = _integer_setting("RATE_LIMIT_WINDOW_SECONDS", 60 * 60, 60, 24 * 60 * 60)
CLEANUP_INTERVAL_SECONDS = _integer_setting("CLEANUP_INTERVAL_SECONDS", 60, 15, 10 * 60)
LOW_MEMORY_MODE = os.environ.get("LOW_MEMORY_MODE", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
YOUTUBE_HOSTS = {"youtube.com", "youtu.be", "youtube-nocookie.com"}
FRONTEND_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get(
        "FRONTEND_ORIGINS",
        "http://127.0.0.1:4173,http://localhost:4173",
    ).split(",")
    if origin.strip()
}

# 画面とhealth checkを素早く返せるよう、重い音声解析ライブラリは
# 実際に処理を開始するまで読み込まない。
librosa = None
np = None
ndi = None
sps = None
sf = None
ANALYSIS_IMPORT_LOCK = threading.Lock()


def _load_analysis_dependencies() -> None:
    global librosa, np, ndi, sps, sf
    if np is not None:
        return
    with ANALYSIS_IMPORT_LOCK:
        if np is not None:
            return
        import librosa as librosa_module
        import numpy as numpy_module
        import scipy.ndimage as ndimage_module
        import scipy.signal as signal_module
        import soundfile as soundfile_module

        librosa = librosa_module
        np = numpy_module
        ndi = ndimage_module
        sps = signal_module
        sf = soundfile_module

app = Flask(__name__)
# Renderなどのリバースプロキシ1段を信頼し、利用者IPとHTTPS URLを正しく扱う。
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_MB * 1_024 * 1_024
ALIGNMENT_CACHE: dict[
    tuple[str, int, int, str, int, int],
    tuple[np.ndarray, np.ndarray, np.ndarray],
] = {}
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
PROCESSING_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_JOBS)
PROCESSING_STATE_LOCK = threading.Lock()
ACTIVE_PROCESSING = 0
RATE_LIMITS: dict[str, deque[float]] = defaultdict(deque)
RATE_LIMITS_LOCK = threading.Lock()


@app.after_request
def _add_frontend_cors_headers(response):
    """許可した静的UIからだけAPIと一時メディアを読めるようにする。"""
    origin = (request.headers.get("Origin") or "").rstrip("/")
    if origin in FRONTEND_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Range"
        response.headers["Access-Control-Expose-Headers"] = (
            "Accept-Ranges, Content-Length, Content-Range, Retry-After"
        )
    return response


def _update_job(job_id: str, **changes) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            changes["updated_at"] = time.time()
            JOBS[job_id].update(changes)


def _job_snapshot(job_id: str) -> dict | None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return dict(job) if job else None


def _acquire_processing_slot() -> bool:
    global ACTIVE_PROCESSING
    if not PROCESSING_SEMAPHORE.acquire(blocking=False):
        return False
    with PROCESSING_STATE_LOCK:
        ACTIVE_PROCESSING += 1
    return True


def _release_processing_slot() -> None:
    global ACTIVE_PROCESSING
    with PROCESSING_STATE_LOCK:
        ACTIVE_PROCESSING = max(0, ACTIVE_PROCESSING - 1)
    PROCESSING_SEMAPHORE.release()


def _processing_is_active() -> bool:
    with PROCESSING_STATE_LOCK:
        return ACTIVE_PROCESSING > 0


def _consume_rate_limit() -> int:
    """許可時は0、超過時は再試行までのおおよその秒数を返す。"""
    now = time.time()
    client_ip = request.remote_addr or "unknown"
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    with RATE_LIMITS_LOCK:
        attempts = RATE_LIMITS[client_ip]
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if len(attempts) >= RATE_LIMIT_REQUESTS:
            return max(1, int(RATE_LIMIT_WINDOW_SECONDS - (now - attempts[0])))
        attempts.append(now)
    return 0


def _begin_processing():
    if not _acquire_processing_slot():
        return jsonify(error="現在ほかの処理を実行中です。完了後にもう一度お試しください。"), 503
    retry_after = _consume_rate_limit()
    if retry_after:
        _release_processing_slot()
        response = jsonify(
            error=f"利用回数の上限（{RATE_LIMIT_REQUESTS}回／{RATE_LIMIT_WINDOW_SECONDS // 60}分）に達しました。しばらくしてからお試しください。"
        )
        response.status_code = 429
        response.headers["Retry-After"] = str(retry_after)
        return response
    return None


def _cleanup_expired_state(now: float | None = None) -> int:
    """処理中を避けて、期限切れメディアとジョブ情報を削除する。"""
    if _processing_is_active():
        return 0
    current_time = now if now is not None else time.time()
    cutoff = current_time - MEDIA_TTL_SECONDS
    removed = 0
    for path in MEDIA_DIR.iterdir():
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
                removed += 1
        except OSError:
            continue
    with JOBS_LOCK:
        expired_jobs = [
            job_id
            for job_id, job in JOBS.items()
            if float(job.get("updated_at", current_time)) < cutoff
        ]
        for job_id in expired_jobs:
            JOBS.pop(job_id, None)
    with RATE_LIMITS_LOCK:
        rate_cutoff = current_time - RATE_LIMIT_WINDOW_SECONDS
        for client_ip in list(RATE_LIMITS):
            attempts = RATE_LIMITS[client_ip]
            while attempts and attempts[0] <= rate_cutoff:
                attempts.popleft()
            if not attempts:
                RATE_LIMITS.pop(client_ip, None)
    return removed


def _cleanup_loop() -> None:
    while True:
        time.sleep(CLEANUP_INTERVAL_SECONDS)
        _cleanup_expired_state()


def _validate_youtube_url(value: str) -> str:
    url = value.strip()
    try:
        parsed = urlparse.urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise ValueError("YouTube URLの形式が正しくありません。") from error
    hostname = (parsed.hostname or "").rstrip(".").lower()
    allowed_host = any(hostname == host or hostname.endswith(f".{host}") for host in YOUTUBE_HOSTS)
    if (
        parsed.scheme not in {"https", "http"}
        or not allowed_host
        or parsed.username
        or parsed.password
        or port not in {None, 80, 443}
    ):
        raise ValueError("YouTubeの動画URLだけを利用できます。")
    return url


def _media_duration(path: Path) -> float:
    if not FFPROBE_PATH:
        raise RuntimeError("メディアの長さを確認するFFprobeが見つかりません。")
    result = subprocess.run(
        [
            FFPROBE_PATH,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if result.returncode != 0:
        raise ValueError("動画・音声ファイルを確認できませんでした。対応形式をお使いください。")
    try:
        duration = float(result.stdout.strip())
    except ValueError as error:
        raise ValueError("動画・音声の長さを確認できませんでした。") from error
    if duration <= 0:
        raise ValueError("動画・音声の長さが正しくありません。")
    return duration


def _validate_media_duration(path: Path) -> float:
    duration = _media_duration(path)
    if duration > MAX_MEDIA_DURATION_SECONDS:
        raise ValueError(
            f"動画・音声は{MAX_MEDIA_DURATION_SECONDS // 60}分以内のものを使用してください。"
        )
    return duration


def _unique_name(filename: str, fallback_extension: str = "") -> str:
    """衝突とパストラバーサルを防いだ、保存用のファイル名を返す。"""
    safe_name = secure_filename(filename) or "upload"
    suffix = Path(safe_name).suffix or fallback_extension
    stem = Path(safe_name).stem or "upload"
    return f"{stem}_{uuid.uuid4().hex[:12]}{suffix.lower()}"


def _media_path(filename: str) -> Path:
    """web_media 直下にある既存ファイルだけを参照する。"""
    name = Path(filename).name
    path = MEDIA_DIR / name
    if name != filename or not path.is_file():
        raise FileNotFoundError("指定されたファイルが見つかりません。")
    return path


def _normalise(samples: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    return samples / peak if peak > 1e-12 else samples


def _fine_alignment_features(samples: np.ndarray, sample_rate: int, hop_length: int) -> np.ndarray:
    """ミリ秒級の局所位置合わせに使う、音色差に比較的強い特徴量を作る。"""
    mel = librosa.feature.melspectrogram(
        y=samples,
        sr=sample_rate,
        n_fft=1_024,
        hop_length=hop_length,
        n_mels=40,
        fmin=55,
        fmax=min(7_500, sample_rate / 2),
        power=1.0,
    )
    log_mel = np.log1p(mel * 12.0)
    spectral_flux = np.maximum(
        np.diff(log_mel, axis=1, prepend=log_mel[:, :1]),
        0,
    )
    # 音色そのものと発音タイミングを併用する。各フレームを正規化し、
    # ライブとMVの音圧差が相関値へ影響しにくいようにする。
    features = np.vstack((log_mel, spectral_flux * 1.35)).astype(np.float32)
    norms = np.linalg.norm(features, axis=0, keepdims=True)
    return features / np.maximum(norms, 1e-7)


def _refine_time_map(
    original: np.ndarray,
    karaoke: np.ndarray,
    sample_rate: int,
    original_times: np.ndarray,
    karaoke_times: np.ndarray,
    confidence: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """粗いDTW経路の周辺だけを高解像度で探索し、局所的なズレを詰める。"""
    fine_hop = 64  # 11,025 Hzでは約5.8 ms。ピーク補間でサブフレーム化する。
    frame_seconds = fine_hop / sample_rate
    original_features = _fine_alignment_features(original, sample_rate, fine_hop)
    karaoke_features = _fine_alignment_features(karaoke, sample_rate, fine_hop)
    window_radius = max(8, round(0.48 / frame_seconds))
    search_radius = max(4, round(0.32 / frame_seconds))
    window_length = window_radius * 2 + 1

    max_original_time = (original_features.shape[1] - window_radius - 2) * frame_seconds
    anchors = np.arange(0.8, max_original_time, 0.75)
    accepted_times: list[float] = []
    accepted_corrections: list[float] = []
    accepted_refined_times: list[float] = []
    accepted_scores: list[float] = []

    for anchor_time in anchors:
        coarse_confidence = float(np.interp(anchor_time, original_times, confidence))
        if coarse_confidence < 0.12:
            continue
        predicted_time = float(np.interp(anchor_time, original_times, karaoke_times))
        original_center = round(anchor_time / frame_seconds)
        predicted_center = round(predicted_time / frame_seconds)
        candidate_start = predicted_center - search_radius
        region_start = candidate_start - window_radius
        region_end = predicted_center + search_radius + window_radius + 1
        if (
            original_center - window_radius < 0
            or original_center + window_radius >= original_features.shape[1]
            or region_start < 0
            or region_end > karaoke_features.shape[1]
        ):
            continue

        original_window = original_features[
            :, original_center - window_radius : original_center + window_radius + 1
        ]
        karaoke_region = karaoke_features[:, region_start:region_end]
        candidate_windows = np.lib.stride_tricks.sliding_window_view(
            karaoke_region,
            window_length,
            axis=1,
        )
        scores = np.einsum(
            "ft,fct->c",
            original_window,
            candidate_windows,
            optimize=True,
        ) / window_length
        best_index = int(np.argmax(scores))
        best_score = float(scores[best_index])
        margin = best_score - float(np.percentile(scores, 75))
        if best_score < 0.42 or (margin < 0.006 and best_score < 0.68):
            continue

        # 相関ピークを放物線補間し、5.8 msのフレーム間隔より細かく推定する。
        subframe = 0.0
        if 0 < best_index < len(scores) - 1:
            left, center, right = (
                float(scores[best_index - 1]),
                float(scores[best_index]),
                float(scores[best_index + 1]),
            )
            denominator = left - 2 * center + right
            if abs(denominator) > 1e-9:
                subframe = float(np.clip(0.5 * (left - right) / denominator, -0.5, 0.5))

        refined_center = candidate_start + best_index + subframe
        refined_time = refined_center * frame_seconds
        correction = float(np.clip(refined_time - predicted_time, -0.32, 0.32))
        accepted_times.append(float(anchor_time))
        accepted_corrections.append(correction)
        accepted_refined_times.append(refined_time)
        accepted_scores.append(best_score)

    if len(accepted_times) < 3:
        return karaoke_times, confidence

    anchor_times_array = np.asarray(accepted_times)
    anchor_refined_array = np.asarray(accepted_refined_times)
    anchor_refined_array = np.maximum.accumulate(anchor_refined_array)
    corrections = np.asarray(accepted_corrections, dtype=np.float64)
    refined_times = karaoke_times.copy()
    inside = (original_times >= anchor_times_array[0]) & (
        original_times <= anchor_times_array[-1]
    )
    # 採用した高精度アンカーを直接つなぎ、粗いDTWのフレーム段差を残さない。
    refined_times[inside] = np.interp(
        original_times[inside],
        anchor_times_array,
        anchor_refined_array,
    )
    refined_times[original_times < anchor_times_array[0]] += corrections[0]
    refined_times[original_times > anchor_times_array[-1]] += corrections[-1]
    refined_times = np.clip(refined_times, 0, len(karaoke) / sample_rate)
    refined_times = np.maximum.accumulate(refined_times)
    fine_confidence = np.interp(
        original_times,
        anchor_times_array,
        np.asarray(accepted_scores),
    )
    return refined_times, np.maximum(confidence, np.clip(fine_confidence, 0, 1))


def _piecewise_time_map(
    original: np.ndarray, karaoke: np.ndarray, sample_rate: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """クロマ特徴量のDTWから、ステージ音源→MV音源の区間別時刻対応を作る。"""
    analysis_sr = 11_025
    analysis_hop = 2_048
    original_small = librosa.resample(original, orig_sr=sample_rate, target_sr=analysis_sr)
    karaoke_small = librosa.resample(karaoke, orig_sr=sample_rate, target_sr=analysis_sr)
    if min(len(original_small), len(karaoke_small)) < analysis_sr * 4:
        raise ValueError("動的な位置合わせには音声が短すぎます。")

    original_chroma = librosa.feature.chroma_stft(
        y=original_small, sr=analysis_sr, n_fft=4_096, hop_length=analysis_hop
    )
    karaoke_chroma = librosa.feature.chroma_stft(
        y=karaoke_small, sr=analysis_sr, n_fft=4_096, hop_length=analysis_hop
    )
    # 無音フレームでもcosine距離がNaNにならないよう、ごく小さな値を足す。
    original_chroma = librosa.util.normalize(
        np.nan_to_num(original_chroma, nan=0.0) + 1e-7, axis=0
    )
    karaoke_chroma = librosa.util.normalize(
        np.nan_to_num(karaoke_chroma, nan=0.0) + 1e-7, axis=0
    )

    _, warping_path = librosa.sequence.dtw(
        X=original_chroma,
        Y=karaoke_chroma,
        metric="cosine",
        backtrack=True,
    )
    warping_path = warping_path[::-1]
    frame_count = original_chroma.shape[1]
    mapped_frames = np.full(frame_count, np.nan, dtype=np.float64)
    confidence = np.zeros(frame_count, dtype=np.float64)
    candidates: list[list[tuple[int, float]]] = [[] for _ in range(frame_count)]

    for original_frame, karaoke_frame in warping_path:
        similarity = float(
            np.dot(
                original_chroma[:, original_frame],
                karaoke_chroma[:, karaoke_frame],
            )
        )
        candidates[int(original_frame)].append((int(karaoke_frame), similarity))

    for frame, matches in enumerate(candidates):
        if not matches:
            continue
        best_frame, best_similarity = max(matches, key=lambda match: match[1])
        mapped_frames[frame] = best_frame
        confidence[frame] = best_similarity

    known = np.flatnonzero(np.isfinite(mapped_frames))
    if known.size < 2:
        raise ValueError("区間別の位置合わせを推定できませんでした。")
    mapped_frames = np.interp(np.arange(frame_count), known, mapped_frames[known])
    # 小さな揺れだけを平滑化し、カット位置の大きなジャンプは残す。
    if frame_count >= 9:
        mapped_frames = sps.medfilt(mapped_frames, kernel_size=9)
        confidence = sps.medfilt(confidence, kernel_size=5)
    mapped_frames = np.maximum.accumulate(mapped_frames)

    original_times = librosa.frames_to_time(
        np.arange(frame_count), sr=analysis_sr, hop_length=analysis_hop
    )
    karaoke_times = librosa.frames_to_time(
        mapped_frames, sr=analysis_sr, hop_length=analysis_hop
    )
    karaoke_times, confidence = _refine_time_map(
        original_small,
        karaoke_small,
        analysis_sr,
        original_times,
        karaoke_times,
        confidence,
    )
    return original_times, karaoke_times, np.clip(confidence, 0.0, 1.0)


def align_audio(
    original_file: Path, karaoke_file: Path
) -> tuple[
    np.ndarray,
    np.ndarray,
    int,
    float,
    tuple[np.ndarray, np.ndarray, np.ndarray] | None,
]:
    """区間別DTWを優先し、失敗時は従来の一定オフセットで音源を揃える。"""
    if LOW_MEMORY_MODE:
        # Render Free (512 MB) ではlibrosa/Numbaの初回JITコンパイルが
        # メモリ上限に達するため、WAV読込と全体位置合わせをSciPyだけで行う。
        original, original_sr = sf.read(original_file, dtype="float32", always_2d=False)
        karaoke, karaoke_sr = sf.read(karaoke_file, dtype="float32", always_2d=False)
        if original.ndim > 1:
            original = np.mean(original, axis=1, dtype=np.float32)
        if karaoke.ndim > 1:
            karaoke = np.mean(karaoke, axis=1, dtype=np.float32)
        if original_sr != SAMPLE_RATE:
            divisor = __import__("math").gcd(original_sr, SAMPLE_RATE)
            original = sps.resample_poly(
                original,
                SAMPLE_RATE // divisor,
                original_sr // divisor,
            ).astype(np.float32, copy=False)
        if karaoke_sr != SAMPLE_RATE:
            divisor = __import__("math").gcd(karaoke_sr, SAMPLE_RATE)
            karaoke = sps.resample_poly(
                karaoke,
                SAMPLE_RATE // divisor,
                karaoke_sr // divisor,
            ).astype(np.float32, copy=False)
        if not len(original) or not len(karaoke):
            raise ValueError("空の音声ファイルは処理できません。")

        original = _normalise(original).astype(np.float32, copy=False)
        karaoke = _normalise(karaoke).astype(np.float32, copy=False)
        analysis_sr = 2_000
        divisor = __import__("math").gcd(SAMPLE_RATE, analysis_sr)
        original_small = sps.resample_poly(
            original,
            analysis_sr // divisor,
            SAMPLE_RATE // divisor,
        )
        karaoke_small = sps.resample_poly(
            karaoke,
            analysis_sr // divisor,
            SAMPLE_RATE // divisor,
        )
        max_lag = min(
            30 * analysis_sr,
            max(len(original_small), len(karaoke_small)) - 1,
        )
        correlation = sps.correlate(
            original_small,
            karaoke_small,
            mode="full",
            method="fft",
        )
        lags = sps.correlation_lags(
            len(original_small), len(karaoke_small), mode="full"
        )
        usable = np.abs(lags) <= max_lag
        lag_small = int(lags[usable][np.argmax(correlation[usable])])
        lag = int(round(lag_small * SAMPLE_RATE / analysis_sr))
        if lag > 0:
            original = original[lag:]
        elif lag < 0:
            karaoke = karaoke[-lag:]
        length = min(len(original), len(karaoke))
        if length < 2_048:
            raise ValueError("位置合わせ後の音声が短すぎます。")
        return original[:length], karaoke[:length], SAMPLE_RATE, lag / SAMPLE_RATE, None

    original, sr = librosa.load(original_file, sr=SAMPLE_RATE, mono=True)
    karaoke, _ = librosa.load(karaoke_file, sr=SAMPLE_RATE, mono=True)
    if not len(original) or not len(karaoke):
        raise ValueError("空の音声ファイルは処理できません。")

    original = _normalise(original)
    karaoke = _normalise(karaoke)
    try:
        original_stat = original_file.stat()
        karaoke_stat = karaoke_file.stat()
        cache_key = (
            str(original_file),
            original_stat.st_mtime_ns,
            original_stat.st_size,
            str(karaoke_file),
            karaoke_stat.st_mtime_ns,
            karaoke_stat.st_size,
        )
        time_map = ALIGNMENT_CACHE.get(cache_key)
        if time_map is None:
            time_map = _piecewise_time_map(original, karaoke, sr)
            if len(ALIGNMENT_CACHE) >= 8:
                ALIGNMENT_CACHE.pop(next(iter(ALIGNMENT_CACHE)))
            ALIGNMENT_CACHE[cache_key] = time_map
        # 時刻対応に沿ってMVスペクトルを並べ替えるため、原音は切り詰めない。
        return original, karaoke, sr, 0.0, time_map
    except Exception:
        # 特徴量が取れない短い音源などでは、従来方式へ安全に戻す。
        pass

    # 位置合わせの計算量を抑えるため、解析時だけ低いサンプルレートに落とす。
    analysis_sr = 8_000
    original_small = librosa.resample(original, orig_sr=sr, target_sr=analysis_sr)
    karaoke_small = librosa.resample(karaoke, orig_sr=sr, target_sr=analysis_sr)
    max_lag = min(30 * analysis_sr, max(len(original_small), len(karaoke_small)) - 1)
    correlation = sps.correlate(original_small, karaoke_small, mode="full", method="fft")
    lags = sps.correlation_lags(len(original_small), len(karaoke_small), mode="full")
    usable = np.abs(lags) <= max_lag
    lag_small = int(lags[usable][np.argmax(correlation[usable])])
    lag = int(round(lag_small * sr / analysis_sr))

    if lag > 0:
        original = original[lag:]
    elif lag < 0:
        karaoke = karaoke[-lag:]
    length = min(len(original), len(karaoke))
    if length < 2_048:
        raise ValueError("位置合わせ後の音声が短すぎます。")
    return original[:length], karaoke[:length], sr, lag / sr, None


def extract_vocals(
    original: np.ndarray,
    karaoke: np.ndarray,
    scale_factor: float,
    time_map: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """区間別の時刻対応を反映したSTFTスペクトル減算でMR成分を抑える。"""
    if LOW_MEMORY_MODE:
        # 仮運用中のRender Freeでは、librosa/NumbaのJIT初期化だけで
        # 512 MBを超えるため、位置合わせ済み波形を直接減算する。
        # float32のまま処理し、中間スペクトル行列を作らない。
        length = min(len(original), len(karaoke))
        if length < 2_048:
            raise ValueError("差分抽出に必要な音声が短すぎます。")
        original_low_memory = np.asarray(original[:length], dtype=np.float32)
        karaoke_low_memory = np.asarray(karaoke[:length], dtype=np.float32)
        subtraction_scale = np.float32(scale_factor * 0.92)
        natural_vocals = _normalise(
            original_low_memory - karaoke_low_memory * subtraction_scale
        ).astype(np.float32, copy=False)
        # 軽いソフトクリップで小さい声を前に出し、ピークだけを抑える。
        emphasis = np.float32(1.35)
        enhanced_vocals = np.tanh(natural_vocals * emphasis).astype(
            np.float32, copy=False
        )
        enhanced_vocals = _normalise(enhanced_vocals).astype(
            np.float32, copy=False
        )
        return natural_vocals, enhanced_vocals

    n_fft, hop_length = 2_048, 512
    original_stft = librosa.stft(original, n_fft=n_fft, hop_length=hop_length)
    karaoke_stft = librosa.stft(karaoke, n_fft=n_fft, hop_length=hop_length)
    original_magnitude = np.abs(original_stft)

    if time_map is None:
        frame_count = min(original_stft.shape[1], karaoke_stft.shape[1])
        original_stft = original_stft[:, :frame_count]
        original_magnitude = original_magnitude[:, :frame_count]
        karaoke_magnitude = np.abs(karaoke_stft[:, :frame_count])
        subtraction_weight: float | np.ndarray = 1.0
        output_length = min(len(original), len(karaoke))
    else:
        original_map_times, karaoke_map_times, map_confidence = time_map
        original_frame_times = librosa.frames_to_time(
            np.arange(original_stft.shape[1]), sr=SAMPLE_RATE, hop_length=hop_length
        )
        mapped_times = np.interp(
            original_frame_times,
            original_map_times,
            karaoke_map_times,
            left=karaoke_map_times[0],
            right=karaoke_map_times[-1],
        )
        mapped_frames = np.rint(mapped_times * SAMPLE_RATE / hop_length).astype(np.int64)
        mapped_frames = np.clip(mapped_frames, 0, karaoke_stft.shape[1] - 1)
        karaoke_magnitude = np.abs(karaoke_stft[:, mapped_frames])

        frame_confidence = np.interp(
            original_frame_times,
            original_map_times,
            map_confidence,
            left=0.0,
            right=0.0,
        )
        # 一致度が低い（MC、歓声、別アレンジ等）区間では誤減算を弱める。
        subtraction_weight = np.clip((frame_confidence - 0.35) / 0.35, 0.0, 1.0)
        if subtraction_weight.size >= 31:
            subtraction_weight = sps.medfilt(subtraction_weight, kernel_size=31)
        subtraction_weight = subtraction_weight[np.newaxis, :]
        output_length = len(original)

    effective_karaoke = karaoke_magnitude * subtraction_weight
    # 1.00以上では伴奏優勢セルの減算を内部的に少し強める。
    # 後段の声保護マスクがあるため、声らしいセルの細りはそこで抑える。
    subtraction_scale = scale_factor * (1.18 if scale_factor > 0.3 else 1.0)
    vocal_magnitude = np.maximum(
        original_magnitude - effective_karaoke * subtraction_scale,
        0,
    )

    voice_likelihood: np.ndarray | None = None
    if scale_factor > 0.3:
        # 基準強度で残った成分から声らしさを推定し、強い除去でも声の芯を残す。
        # 単純な一律減算では、伴奏と周波数が重なる声まで細くなるため、
        # 時間周波数マスクに応じた下限を設ける。
        baseline_magnitude = np.maximum(
            original_magnitude - effective_karaoke * 0.3,
            0,
        )
        eps = max(float(np.max(original_magnitude)) * 1e-7, 1e-10)
        evidence_magnitude = np.maximum(
            original_magnitude - effective_karaoke * 0.85,
            0,
        )
        residual_ratio = np.clip(
            evidence_magnitude / (original_magnitude + eps),
            0,
            1,
        ).astype(np.float32, copy=False)
        smooth_ratio = ndi.uniform_filter(
            residual_ratio,
            size=(5, 9),
            mode="nearest",
        )
        # 子音など短い成分を平滑化だけで見落とさないよう、瞬時値も残す。
        voice_evidence = np.maximum(smooth_ratio, residual_ratio * 0.72)
        frequencies = librosa.fft_frequencies(sr=SAMPLE_RATE, n_fft=n_fft)
        vocal_band_prior = np.interp(
            frequencies,
            [0, 70, 120, 5_500, 9_000, SAMPLE_RATE / 2],
            [0.18, 0.35, 1.0, 1.0, 0.55, 0.18],
        )[:, np.newaxis]
        voice_likelihood = np.clip(
            (voice_evidence - 0.08) / 0.62,
            0,
            1,
        ) * vocal_band_prior
        # 声らしいセルは基準抽出の最大94%を保護し、伴奏優勢セルは
        # 10%まで落とす。中間セルも少し厳しくして声とのコントラストを上げる。
        protection_floor = 0.10 + 0.84 * np.power(voice_likelihood, 0.6)
        vocal_magnitude = np.maximum(
            vocal_magnitude,
            baseline_magnitude * protection_floor,
        )
    original_phase = np.exp(1j * np.angle(original_stft))
    natural_stft = vocal_magnitude * original_phase
    natural_vocals = _normalise(
        librosa.istft(natural_stft, hop_length=hop_length, length=output_length)
    )

    if voice_likelihood is None:
        frequencies = librosa.fft_frequencies(sr=SAMPLE_RATE, n_fft=n_fft)
        voice_likelihood = np.interp(
            frequencies,
            [0, 70, 120, 5_500, 9_000, SAMPLE_RATE / 2],
            [0.0, 0.2, 0.75, 0.75, 0.3, 0.0],
        )[:, np.newaxis]
    # 声と判断できたセルだけ最大3 dB前へ出し、残留楽器や歓声の
    # 全体音量を一緒に持ち上げない。
    vocal_emphasis_gain = np.power(10.0, (3.0 * np.power(voice_likelihood, 0.8)) / 20.0)
    enhanced_stft = vocal_magnitude * vocal_emphasis_gain * original_phase
    enhanced_vocals = _normalise(
        librosa.istft(enhanced_stft, hop_length=hop_length, length=output_length)
    )
    return natural_vocals, enhanced_vocals


def _finish_vocal_enhancement(samples: np.ndarray, sample_rate: int, output_path: Path) -> None:
    """低域整理・緩やかな圧縮・ラウドネス正規化で声を聴きやすくする。"""
    if not FFMPEG_PATH:
        sf.write(output_path, samples, sample_rate)
        return
    raw_path = MEDIA_DIR / _unique_name("vocal_enhancement_source.wav")
    sf.write(raw_path, samples, sample_rate)
    filters = (
        "highpass=f=70,"
        "acompressor=threshold=0.0631:ratio=2.2:attack=15:release=120:"
        "makeup=1.4125:knee=2.8:detection=rms,"
        "loudnorm=I=-16:TP=-1.5:LRA=7"
    )
    try:
        subprocess.run(
            [
                FFMPEG_PATH,
                "-y",
                "-i",
                str(raw_path),
                "-af",
                filters,
                "-ar",
                str(sample_rate),
                "-c:a",
                "pcm_s16le",
                str(output_path),
            ],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError:
        sf.write(output_path, samples, sample_rate)
    finally:
        raw_path.unlink(missing_ok=True)


def _mux_result_video(
    video_path: Path,
    audio_path: Path,
    offset: float,
    filename: str,
) -> str | None:
    if not FFMPEG_PATH:
        return None
    result_name = _unique_name(filename)
    result_path = MEDIA_DIR / result_name
    try:
        subprocess.run(
            [
                FFMPEG_PATH,
                "-y",
                "-i",
                str(video_path),
                "-itsoffset",
                str(max(0.0, offset)),
                "-i",
                str(audio_path),
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                str(result_path),
            ],
            check=True,
            capture_output=True,
        )
        return f"/media/{result_name}"
    except (FileNotFoundError, subprocess.CalledProcessError):
        result_path.unlink(missing_ok=True)
        return None


def _extract(
    original_name: str,
    karaoke_name: str,
    scale_factor: float,
    progress=None,
    video_name: str | None = None,
) -> dict:
    _load_analysis_dependencies()
    if not 0 <= scale_factor <= 3:
        raise ValueError("除去強度は0〜3の範囲で指定してください。")
    if progress:
        progress(64, "カット・テンポ差・細かなズレを解析しています")
    original, karaoke, sample_rate, offset, time_map = align_audio(
        _media_path(original_name), _media_path(karaoke_name)
    )
    if progress:
        progress(82, "生歌の差分を抽出しています")
    natural_vocals, enhanced_vocals = extract_vocals(
        original,
        karaoke,
        scale_factor,
        time_map,
    )
    if progress:
        progress(91, "ボーカルを聴きやすく整えています")
    natural_name = _unique_name("extracted_vocals_natural.wav")
    enhanced_name = _unique_name("extracted_vocals_enhanced.wav")
    natural_path = MEDIA_DIR / natural_name
    enhanced_path = MEDIA_DIR / enhanced_name
    sf.write(natural_path, natural_vocals, sample_rate)
    _finish_vocal_enhancement(enhanced_vocals, sample_rate, enhanced_path)
    if progress:
        progress(96, "再生データを仕上げています")
    result = {
        "vocal_url": f"/media/{enhanced_name}",
        "vocal_natural_url": f"/media/{natural_name}",
        "vocal_enhanced": True,
        "offset_seconds": offset,
        "alignment_mode": "hierarchical_fine" if time_map is not None else "global",
        "alignment_resolution_ms": round(64 / 11_025 * 1_000, 2)
        if time_map is not None
        else None,
    }
    if video_name and FFMPEG_PATH:
        try:
            video_path = _media_path(video_name)
            enhanced_video_url = _mux_result_video(
                video_path,
                enhanced_path,
                offset,
                "mr_removal_video_enhanced.mp4",
            )
            natural_video_url = _mux_result_video(
                video_path,
                natural_path,
                offset,
                "mr_removal_video_natural.mp4",
            )
            if enhanced_video_url:
                result["result_video_url"] = enhanced_video_url
            if natural_video_url:
                result["result_video_natural_url"] = natural_video_url
        except FileNotFoundError:
            # 音声結果は完成しているため、動画化だけ失敗しても抽出結果は返す。
            pass
    return result


def _download_audio_from_worker(url: str, label: str) -> str:
    """音声形式を切り替え、最後は音声付き動画からWAVを作る。"""
    failures: list[str] = []
    for format_hint in ("webm", "mp4"):
        try:
            return _download_media_from_worker(
                url, label, "audio", format_hint=format_hint
            )
        except RuntimeError as error:
            failures.append(f"audio/{format_hint}: {error}")
    try:
        return _download_audio_from_video_fallback(url, label)
    except RuntimeError as error:
        failures.append(f"video fallback: {error}")
    summary = " | ".join(failures)
    raise RuntimeError(f"すべての音声取得経路に失敗しました: {summary[:2400]}")


def _worker_endpoint(media_type: str) -> str:
    if media_type == "audio":
        return YT_AUDIO_WORKER_URL
    configured = os.environ.get("YT_VIDEO_WORKER_URL", "").strip()
    if configured:
        return configured
    parsed = urlparse.urlsplit(YT_AUDIO_WORKER_URL)
    path = parsed.path[:-6] + "/video" if parsed.path.endswith("/audio") else "/video"
    return urlparse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _parse_worker_range(value: str | None) -> tuple[int, int, int]:
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", value or "", re.IGNORECASE)
    if not match:
        raise RuntimeError(f"地域ResolverのContent-Rangeが不正です: {value!r}")
    start, end, total = map(int, match.groups())
    if start > end or end >= total:
        raise RuntimeError(f"地域ResolverのContent-Rangeが矛盾しています: {value!r}")
    return start, end, total


def _fetch_worker_range(
    endpoint: str,
    source_url: str,
    token: str,
    start: int,
    end: int,
    region: str | None,
    format_hint: str | None,
) -> tuple[bytes, int, int, int, str, str]:
    params = {"url": source_url}
    if region:
        params["region"] = region
    if media_format := (format_hint or "").strip().lower():
        params["format"] = media_format
    request_object = urlrequest.Request(
        f"{endpoint}?{urlparse.urlencode(params)}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "audio/*,video/*",
            "Range": f"bytes={start}-{end}",
            "User-Agent": "mr-removal-web/2.0",
        },
    )
    try:
        with urlrequest.urlopen(request_object, timeout=180) as response:
            payload = response.read()
            if getattr(response, "status", None) != 206:
                raise RuntimeError(f"地域ResolverがHTTP {getattr(response, 'status', '?')}を返しました。")
            actual_start, actual_end, total = _parse_worker_range(
                response.headers.get("Content-Range")
            )
            expected_bytes = actual_end - actual_start + 1
            if actual_start != start or len(payload) != expected_bytes:
                raise RuntimeError(
                    "地域Resolverの分割データが一致しません: "
                    f"requested={start}-{end}, actual={actual_start}-{actual_end}, bytes={len(payload)}"
                )
            resolver_region = response.headers.get("X-Resolver-Region", "").strip()
            content_type = response.headers.get_content_type()
            return payload, actual_start, actual_end, total, resolver_region, content_type
    except urlerror.HTTPError as error:
        detail = error.read(8_192).decode("utf-8", errors="replace")
        raise RuntimeError(f"地域ResolverがHTTP {error.code}を返しました: {detail[:1200]}") from error
    except urlerror.URLError as error:
        raise RuntimeError(f"地域Resolverへ接続できませんでした: {error.reason}") from error


def _fetch_worker_range_with_retry(*args) -> tuple[bytes, int, int, int, str, str]:
    last_error: Exception | None = None
    for _ in range(3):
        try:
            return _fetch_worker_range(*args)
        except Exception as error:
            last_error = error
    raise RuntimeError(str(last_error or "地域Resolverの分割取得に失敗しました。")) from last_error


def _download_media_from_worker(
    url: str,
    label: str,
    media_type: str,
    format_hint: str | None = None,
) -> str:
    url = _validate_youtube_url(url)
    token = os.environ.get("YT_AUDIO_WORKER_TOKEN", "").strip()
    if not token:
        raise RuntimeError("YT_AUDIO_WORKER_TOKENが設定されていません。")
    endpoint = _worker_endpoint(media_type)
    if not endpoint.startswith("https://"):
        raise RuntimeError("YouTube地域ResolverにはHTTPS URLを設定してください。")
    if media_type == "audio" and not FFMPEG_PATH:
        raise RuntimeError("FFmpegが見つかりません。")

    chunk_bytes = 1_024 * 1_024
    probe_start = chunk_bytes
    region: str | None = None
    total_bytes: int | None = None
    content_type = "application/octet-stream"
    # 先頭だけ通る地域を選ばないよう、まず1 MiB以降を試す。
    try:
        probe = _fetch_worker_range_with_retry(
            endpoint,
            url,
            token,
            probe_start,
            probe_start + chunk_bytes - 1,
            None,
            format_hint,
        )
        total_bytes = probe[3]
        region = probe[4] or None
        content_type = probe[5]
    except RuntimeError:
        # 1 MiB未満の短い動画・音声では範囲外になるため、先頭から取得する。
        pass

    source_path = MEDIA_DIR / f".{label}_{uuid.uuid4().hex[:12]}.source"
    output_suffix = ".wav" if media_type == "audio" else ".mp4"
    output_path = MEDIA_DIR / f"{label}_{uuid.uuid4().hex[:12]}{output_suffix}"
    completed = False
    try:
        position = 0
        with source_path.open("wb") as output:
            while total_bytes is None or position < total_bytes:
                requested_end = (
                    position + chunk_bytes - 1
                    if total_bytes is None
                    else min(position + chunk_bytes - 1, total_bytes - 1)
                )
                try:
                    part = _fetch_worker_range_with_retry(
                        endpoint, url, token, position, requested_end, region, format_hint
                    )
                except RuntimeError as original_error:
                    # 選択地域が途中で拒否された場合、1 MiB以降を再試験して切り替える。
                    if total_bytes and total_bytes > probe_start:
                        probe = _fetch_worker_range_with_retry(
                            endpoint,
                            url,
                            token,
                            probe_start,
                            min(probe_start + chunk_bytes - 1, total_bytes - 1),
                            None,
                            format_hint,
                        )
                        if probe[3] != total_bytes or not probe[4]:
                            raise original_error
                        region = probe[4]
                        part = _fetch_worker_range_with_retry(
                            endpoint, url, token, position, requested_end, region, format_hint
                        )
                    else:
                        raise
                payload, actual_start, actual_end, part_total, part_region, part_type = part
                if total_bytes is None:
                    total_bytes = part_total
                if part_total != total_bytes or actual_start != position:
                    raise RuntimeError("地域Resolverの総サイズまたは分割位置が途中で変わりました。")
                if total_bytes > app.config["MAX_CONTENT_LENGTH"]:
                    raise RuntimeError(f"取得メディアが上限（{MAX_CONTENT_MB} MB）を超えています。")
                if part_region:
                    region = part_region
                content_type = part_type
                output.write(payload)
                position = actual_end + 1

        if total_bytes is None or source_path.stat().st_size != total_bytes:
            raise RuntimeError("地域Resolverから取得したメディアが不完全です。")
        if media_type == "video":
            if not content_type.startswith("video/"):
                raise RuntimeError(f"地域Resolverが動画以外を返しました: {content_type}")
            source_path.replace(output_path)
        else:
            if not content_type.startswith("audio/"):
                raise RuntimeError(f"地域Resolverが音声以外を返しました: {content_type}")
            conversion = subprocess.run(
                [
                    FFMPEG_PATH,
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(source_path),
                    "-vn",
                    "-ar",
                    str(SAMPLE_RATE),
                    "-ac",
                    "2",
                    "-c:a",
                    "pcm_s16le",
                    str(output_path),
                ],
                capture_output=True,
                timeout=180,
            )
            if conversion.returncode != 0:
                message = conversion.stderr.decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"地域Resolver音声のWAV変換に失敗しました: {message[-800:]}")
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError("地域Resolverの出力ファイルを作成できませんでした。")
        _validate_media_duration(output_path)
        completed = True
        return output_path.name
    finally:
        source_path.unlink(missing_ok=True)
        if not completed:
            output_path.unlink(missing_ok=True)


def _download_audio_from_video_fallback(url: str, label: str) -> str:
    """audio-onlyが全滅した場合、音声付きMP4からWAVを抽出する。"""
    if not FFMPEG_PATH:
        raise RuntimeError("FFmpegが見つかりません。")
    video_name = _download_media_from_worker(
        url, f"{label}_audio_fallback", "video"
    )
    video_path = _media_path(video_name)
    output_path = MEDIA_DIR / f"{label}_{uuid.uuid4().hex[:12]}.wav"
    completed = False
    try:
        conversion = subprocess.run(
            [
                FFMPEG_PATH,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video_path),
                "-vn",
                "-ar",
                str(SAMPLE_RATE),
                "-ac",
                "2",
                "-c:a",
                "pcm_s16le",
                str(output_path),
            ],
            capture_output=True,
            timeout=180,
        )
        if conversion.returncode != 0:
            message = conversion.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"動画からのWAV抽出に失敗しました: {message[-800:]}")
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError("動画から音声ファイルを作成できませんでした。")
        _validate_media_duration(output_path)
        completed = True
        return output_path.name
    finally:
        video_path.unlink(missing_ok=True)
        if not completed:
            output_path.unlink(missing_ok=True)


def _download_audio(url: str, label: str) -> str:
    return _download_audio_from_worker(url, label)


def _download_video(url: str) -> str:
    return _download_media_from_worker(url, "video", "video")


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    """静的UIが処理サーバーを先に起こすための軽量エンドポイント。"""
    return jsonify(
        status="ok",
        analysis_ready=np is not None,
        limits={
            "max_content_mb": MAX_CONTENT_MB,
            "max_duration_seconds": MAX_MEDIA_DURATION_SECONDS,
            "max_concurrent_jobs": MAX_CONCURRENT_JOBS,
        },
    )


@app.get("/media/<path:filename>")
def media(filename: str):
    response = send_from_directory(MEDIA_DIR, Path(filename).name, conditional=True)
    response.headers["Cache-Control"] = "private, no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


@app.post("/upload")
def upload():
    video = request.files.get("video")
    karaoke = request.files.get("karaoke")
    if not video or not video.filename:
        return jsonify(error="歌声入りのステージ映像・音源を選択してください。"), 400
    rejection = _begin_processing()
    if rejection is not None:
        return rejection
    saved_paths: list[Path] = []
    try:
        preview_is_audio_only = not (video.mimetype or "").startswith("video/")
        video_name = _unique_name(video.filename)
        video_path = MEDIA_DIR / video_name
        video.save(video_path)
        saved_paths.append(video_path)
        _validate_media_duration(video_path)
        response = {
            "video_url": f"/media/{video_name}",
            "video_audio_url": f"/media/{video_name}",
            "video_audio_filename": video_name,
            "video_filename": video_name,
            "preview_is_audio_only": preview_is_audio_only,
        }
        if karaoke and karaoke.filename:
            karaoke_name = _unique_name(karaoke.filename)
            karaoke_path = MEDIA_DIR / karaoke_name
            karaoke.save(karaoke_path)
            saved_paths.append(karaoke_path)
            _validate_media_duration(karaoke_path)
            response["karaoke_filename"] = karaoke_name
            response.update(
                _extract(
                    video_name,
                    karaoke_name,
                    1.0,
                    video_name=video_name if not preview_is_audio_only else None,
                )
            )
        return jsonify(response)
    except Exception as error:
        for path in saved_paths:
            path.unlink(missing_ok=True)
        return jsonify(error=str(error)), 400
    finally:
        _release_processing_slot()


@app.post("/extract")
def extract():
    payload = request.get_json(silent=True) or {}
    rejection = _begin_processing()
    if rejection is not None:
        return rejection
    try:
        original_name = str(payload["video_audio_filename"])
        video_name = str(payload.get("video_filename") or "") or None
        karaoke_name = str(payload["karaoke_filename"])
        scale = float(payload.get("scale_factor", 1.0))
        return jsonify(
            _extract(
                original_name,
                karaoke_name,
                scale,
                video_name=video_name,
            )
        )
    except (KeyError, TypeError, ValueError, FileNotFoundError) as error:
        return jsonify(error=str(error)), 400
    except Exception as error:
        return jsonify(error=f"抽出中にエラーが発生しました: {error}"), 500
    finally:
        _release_processing_slot()


@app.post("/download")
def download():
    payload = request.get_json(silent=True) or {}
    video_url = str(payload.get("video_url", "")).strip()
    karaoke_url = str(payload.get("kara_url", "")).strip()
    if not video_url:
        return jsonify(error="歌声入りステージ動画のURLを入力してください。"), 400
    try:
        video_url = _validate_youtube_url(video_url)
        karaoke_url = _validate_youtube_url(karaoke_url) if karaoke_url else ""
    except ValueError as error:
        return jsonify(error=str(error)), 400
    rejection = _begin_processing()
    if rejection is not None:
        return rejection
    try:
        return jsonify(_run_download(video_url, karaoke_url))
    except Exception as error:
        return jsonify(error=str(error)), 400
    finally:
        _release_processing_slot()


def _run_download(video_url: str, karaoke_url: str, progress=None) -> dict:
    video_url = _validate_youtube_url(video_url)
    karaoke_url = _validate_youtube_url(karaoke_url) if karaoke_url else ""

    def report(value: int, message: str) -> None:
        if progress:
            progress(value, message)

    # まず抽出に必要な音声を取得する。動画取得はプレビュー用の補助機能。
    report(7, "ステージ動画の音声を取得しています")
    original_name = _download_audio(video_url, "original")
    report(26, "動画プレビューを取得しています")
    preview_name = original_name
    preview_is_audio_only = True
    try:
        preview_name = _download_video(video_url)
        preview_is_audio_only = False
    except Exception:
        pass

    response = {
        "video_url": f"/media/{preview_name}",
        "video_audio_url": f"/media/{original_name}",
        "video_filename": preview_name,
        "video_audio_filename": original_name,
        "preview_is_audio_only": preview_is_audio_only,
    }
    if karaoke_url:
        report(43, "MV・公式音源を取得しています")
        karaoke_name = _download_audio(karaoke_url, "karaoke")
        response["karaoke_filename"] = karaoke_name
        response.update(
            _extract(
                original_name,
                karaoke_name,
                1.0,
                progress,
                preview_name if not preview_is_audio_only else None,
            )
        )
    report(99, "結果を表示する準備をしています")
    return response


def _download_worker(job_id: str, video_url: str, karaoke_url: str) -> None:
    def progress(value: int, message: str) -> None:
        _update_job(job_id, progress=value, message=message)

    try:
        result = _run_download(video_url, karaoke_url, progress)
        _update_job(
            job_id,
            status="complete",
            progress=100,
            message="抽出が完了しました",
            result=result,
        )
    except Exception as error:
        _update_job(
            job_id,
            status="error",
            message=str(error),
            error=str(error),
        )
    finally:
        _release_processing_slot()


@app.post("/download/start")
def download_start():
    payload = request.get_json(silent=True) or {}
    video_url = str(payload.get("video_url", "")).strip()
    karaoke_url = str(payload.get("kara_url", "")).strip()
    if not video_url or not karaoke_url:
        return jsonify(error="ステージ動画とMV・公式音源のURLを入力してください。"), 400

    try:
        video_url = _validate_youtube_url(video_url)
        karaoke_url = _validate_youtube_url(karaoke_url)
    except ValueError as error:
        return jsonify(error=str(error)), 400
    rejection = _begin_processing()
    if rejection is not None:
        return rejection

    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        if len(JOBS) >= 40:
            completed = [key for key, job in JOBS.items() if job.get("status") != "working"]
            for key in completed[:20]:
                JOBS.pop(key, None)
        JOBS[job_id] = {
            "status": "working",
            "progress": 2,
            "message": "処理を準備しています",
            "updated_at": time.time(),
        }
    try:
        threading.Thread(
            target=_download_worker,
            args=(job_id, video_url, karaoke_url),
            daemon=True,
        ).start()
    except Exception:
        with JOBS_LOCK:
            JOBS.pop(job_id, None)
        _release_processing_slot()
        raise
    return jsonify(job_id=job_id), 202


@app.get("/jobs/<job_id>")
def job_status(job_id: str):
    job = _job_snapshot(job_id)
    if job is None:
        return jsonify(error="処理状況が見つかりません。"), 404
    return jsonify(job)


@app.errorhandler(413)
def file_too_large(_error):
    return jsonify(error=f"ファイルサイズが上限（合計{MAX_CONTENT_MB} MB）を超えています。"), 413


# 起動時に期限切れファイルを掃除し、その後も一定間隔で確認する。
_cleanup_expired_state()
threading.Thread(target=_cleanup_loop, name="media-cleanup", daemon=True).start()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
