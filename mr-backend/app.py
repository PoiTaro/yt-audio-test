"""MR除去 Web UI のローカル Flask サーバー。"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import math
import gc
import ctypes
import ipaddress
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict, deque
from pathlib import Path
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

from flask import Flask, jsonify, redirect, render_template, request, send_from_directory
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
        import numpy as numpy_module
        import scipy.ndimage as ndimage_module
        import scipy.signal as signal_module
        import soundfile as soundfile_module

        if not LOW_MEMORY_MODE:
            import librosa as librosa_module

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
RESULT_VIDEO_CACHE: dict[tuple[str, str, float], str] = {}
RESULT_VIDEO_CACHE_LOCK = threading.Lock()


@app.after_request
def _add_frontend_cors_headers(response):
    """許可した静的UIからだけAPIと一時メディアを読めるようにする。"""
    origin = (request.headers.get("Origin") or "").rstrip("/")
    allowed = origin in FRONTEND_ORIGINS
    if origin and not allowed:
        parsed = urlparse.urlparse(origin)
        hostname = (parsed.hostname or "").lower()
        if parsed.scheme == "http" and hostname == "localhost":
            allowed = True
        elif parsed.scheme == "http":
            try:
                address = ipaddress.ip_address(hostname)
                allowed = address.is_private or address.is_loopback
            except ValueError:
                pass
    if allowed:
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


def _trim_process_memory() -> None:
    """大きな解析行列を解放し、LinuxではヒープをOSへ返す。"""
    gc.collect()
    if os.name == "posix":
        try:
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except (AttributeError, OSError):
            pass


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


def _read_audio_low_memory(path: Path) -> np.ndarray:
    """librosa/Numbaを起動せず、解析用のmono float32音声を読む。"""
    samples, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = np.mean(samples, axis=1, dtype=np.float32)
    if sample_rate != SAMPLE_RATE:
        divisor = math.gcd(sample_rate, SAMPLE_RATE)
        samples = sps.resample_poly(
            samples,
            SAMPLE_RATE // divisor,
            sample_rate // divisor,
        ).astype(np.float32, copy=False)
    if not len(samples):
        raise ValueError("空の音声ファイルは処理できません。")
    return _normalise(samples).astype(np.float32, copy=False)


def _spectral_features_low_memory(
    samples: np.ndarray,
    sample_rate: int,
    hop_length: int,
) -> np.ndarray:
    """局所補正用の対数周波数＋発音特徴量を小さい区間だけ計算する。"""
    n_fft = 1_024
    if len(samples) < n_fft:
        return np.empty((80, 0), dtype=np.float32)
    frequencies, _, spectrum = sps.stft(
        samples,
        fs=sample_rate,
        window="hann",
        nperseg=n_fft,
        noverlap=n_fft - hop_length,
        nfft=n_fft,
        boundary=None,
        padded=False,
    )
    magnitude = np.abs(spectrum).astype(np.float32, copy=False)
    usable = np.flatnonzero(
        (frequencies >= 55) & (frequencies <= min(7_500, sample_rate / 2))
    )
    bands = np.zeros((40, magnitude.shape[1]), dtype=np.float32)
    if usable.size:
        edges = np.geomspace(55, min(7_500, sample_rate / 2), 41)
        for band in range(40):
            selected = usable[
                (frequencies[usable] >= edges[band])
                & (frequencies[usable] < edges[band + 1])
            ]
            if selected.size:
                bands[band] = np.mean(magnitude[selected], axis=0)
    log_bands = np.log1p(bands * np.float32(12.0)).astype(np.float32, copy=False)
    spectral_flux = np.maximum(
        np.diff(log_bands, axis=1, prepend=log_bands[:, :1]),
        0,
    ).astype(np.float32, copy=False)
    features = np.vstack((log_bands, spectral_flux * np.float32(1.35))).astype(
        np.float32, copy=False
    )
    norms = np.linalg.norm(features, axis=0, keepdims=True)
    return features / np.maximum(norms, np.float32(1e-7))


def _chroma_low_memory(
    samples: np.ndarray,
    sample_rate: int,
    n_fft: int,
    hop_length: int,
) -> tuple[np.ndarray, np.ndarray]:
    """DTW用クロマをSciPyだけで生成する。"""
    frequencies, frame_times, spectrum = sps.stft(
        samples,
        fs=sample_rate,
        window="hann",
        nperseg=n_fft,
        noverlap=n_fft - hop_length,
        nfft=n_fft,
        boundary=None,
        padded=False,
    )
    magnitude = np.abs(spectrum).astype(np.float32, copy=False)
    valid = frequencies >= 27.5
    midi = np.rint(69 + 12 * np.log2(frequencies[valid] / 440.0)).astype(np.int16)
    pitch_classes = np.mod(midi, 12)
    chroma = np.zeros((12, magnitude.shape[1]), dtype=np.float32)
    valid_magnitude = magnitude[valid]
    for pitch_class in range(12):
        selected = pitch_classes == pitch_class
        if np.any(selected):
            chroma[pitch_class] = np.sum(valid_magnitude[selected], axis=0)
    chroma = np.log1p(chroma).astype(np.float32, copy=False)
    norms = np.linalg.norm(chroma, axis=0, keepdims=True)
    chroma /= np.maximum(norms, np.float32(1e-7))
    return chroma, frame_times.astype(np.float64, copy=False)


def _dtw_path_low_memory(
    original_features: np.ndarray,
    karaoke_features: np.ndarray,
) -> tuple[list[tuple[int, int]], np.ndarray]:
    """小さなクロマ行列上で標準DTWを行い、経路と類似度を返す。"""
    similarity = np.clip(
        original_features.T @ karaoke_features,
        -1.0,
        1.0,
    ).astype(np.float32, copy=False)
    rows, columns = similarity.shape
    accumulated = np.full((rows, columns), np.inf, dtype=np.float32)
    direction = np.zeros((rows, columns), dtype=np.uint8)
    accumulated[0, 0] = np.float32(1.0) - similarity[0, 0]
    # 反対角線上のセルは互いに依存しないため、NumPyでまとめて更新する。
    # Pythonの二重ループと同じDTW経路を保ったまま、弱いCPUでも高速にする。
    for diagonal_index in range(1, rows + columns - 1):
        row_start = max(0, diagonal_index - (columns - 1))
        row_end = min(rows - 1, diagonal_index)
        row_indices = np.arange(row_start, row_end + 1, dtype=np.int32)
        column_indices = diagonal_index - row_indices
        candidate_costs = np.full((3, len(row_indices)), np.inf, dtype=np.float32)
        has_diagonal = (row_indices > 0) & (column_indices > 0)
        candidate_costs[0, has_diagonal] = accumulated[
            row_indices[has_diagonal] - 1,
            column_indices[has_diagonal] - 1,
        ]
        has_upward = row_indices > 0
        candidate_costs[1, has_upward] = accumulated[
            row_indices[has_upward] - 1,
            column_indices[has_upward],
        ]
        has_leftward = column_indices > 0
        candidate_costs[2, has_leftward] = accumulated[
            row_indices[has_leftward],
            column_indices[has_leftward] - 1,
        ]
        best_direction = np.argmin(candidate_costs, axis=0).astype(np.uint8)
        previous_cost = np.take_along_axis(
            candidate_costs,
            best_direction[np.newaxis, :],
            axis=0,
        )[0]
        accumulated[row_indices, column_indices] = (
            previous_cost
            + np.float32(1.0)
            - similarity[row_indices, column_indices]
        )
        direction[row_indices, column_indices] = best_direction

    row, column = rows - 1, columns - 1
    path = [(row, column)]
    while row or column:
        step = int(direction[row, column])
        if row and column and step == 0:
            row -= 1
            column -= 1
        elif row and (not column or step == 1):
            row -= 1
        else:
            column -= 1
        path.append((row, column))
    path.reverse()
    return path, similarity


def _refine_time_map_low_memory(
    original: np.ndarray,
    karaoke: np.ndarray,
    sample_rate: int,
    original_times: np.ndarray,
    karaoke_times: np.ndarray,
    confidence: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """各アンカー周辺だけ高解像度STFTを作り、約5.8ms単位で補正する。"""
    fine_hop = 64
    frame_seconds = fine_hop / sample_rate
    window_seconds = 0.48
    search_seconds = 0.32
    anchors = np.arange(0.8, len(original) / sample_rate - 0.8, 0.75)
    accepted_times: list[float] = []
    accepted_corrections: list[float] = []
    accepted_refined_times: list[float] = []
    accepted_scores: list[float] = []

    for anchor_time in anchors:
        coarse_confidence = float(np.interp(anchor_time, original_times, confidence))
        if coarse_confidence < 0.12:
            continue
        predicted_time = float(np.interp(anchor_time, original_times, karaoke_times))
        original_start_time = anchor_time - window_seconds
        original_end_time = anchor_time + window_seconds
        region_start_time = predicted_time - search_seconds - window_seconds
        region_end_time = predicted_time + search_seconds + window_seconds
        if original_start_time < 0 or region_start_time < 0:
            continue
        if original_end_time > len(original) / sample_rate:
            continue
        if region_end_time > len(karaoke) / sample_rate:
            continue
        original_segment = original[
            round(original_start_time * sample_rate) : round(original_end_time * sample_rate)
        ]
        karaoke_region = karaoke[
            round(region_start_time * sample_rate) : round(region_end_time * sample_rate)
        ]
        original_features = _spectral_features_low_memory(
            original_segment, sample_rate, fine_hop
        )
        karaoke_features = _spectral_features_low_memory(
            karaoke_region, sample_rate, fine_hop
        )
        window_length = original_features.shape[1]
        if window_length < 3 or karaoke_features.shape[1] < window_length:
            continue
        candidate_windows = np.lib.stride_tricks.sliding_window_view(
            karaoke_features,
            window_length,
            axis=1,
        )
        scores = np.einsum(
            "ft,fct->c",
            original_features,
            candidate_windows,
            optimize=True,
        ) / window_length
        best_index = int(np.argmax(scores))
        best_score = float(scores[best_index])
        margin = best_score - float(np.percentile(scores, 75))
        if best_score < 0.42 or (margin < 0.006 and best_score < 0.68):
            continue
        subframe = 0.0
        if 0 < best_index < len(scores) - 1:
            left = float(scores[best_index - 1])
            center = float(scores[best_index])
            right = float(scores[best_index + 1])
            denominator = left - 2 * center + right
            if abs(denominator) > 1e-9:
                subframe = float(
                    np.clip(0.5 * (left - right) / denominator, -0.5, 0.5)
                )
        refined_time = (
            predicted_time
            - search_seconds
            + (best_index + subframe) * frame_seconds
        )
        correction = float(np.clip(refined_time - predicted_time, -0.32, 0.32))
        accepted_times.append(float(anchor_time))
        accepted_corrections.append(correction)
        accepted_refined_times.append(refined_time)
        accepted_scores.append(best_score)

    if len(accepted_times) < 3:
        return karaoke_times, confidence
    anchor_times = np.asarray(accepted_times, dtype=np.float64)
    anchor_refined = np.maximum.accumulate(
        np.asarray(accepted_refined_times, dtype=np.float64)
    )
    corrections = np.asarray(accepted_corrections, dtype=np.float64)
    refined_times = karaoke_times.copy()
    inside = (original_times >= anchor_times[0]) & (original_times <= anchor_times[-1])
    refined_times[inside] = np.interp(
        original_times[inside], anchor_times, anchor_refined
    )
    refined_times[original_times < anchor_times[0]] += corrections[0]
    refined_times[original_times > anchor_times[-1]] += corrections[-1]
    refined_times = np.maximum.accumulate(
        np.clip(refined_times, 0, len(karaoke) / sample_rate)
    )
    fine_confidence = np.interp(
        original_times,
        anchor_times,
        np.asarray(accepted_scores, dtype=np.float64),
    )
    return refined_times, np.maximum(confidence, np.clip(fine_confidence, 0, 1))


def _piecewise_time_map_low_memory(
    original: np.ndarray,
    karaoke: np.ndarray,
    sample_rate: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Render向けにメモリを抑えたクロマDTW＋局所補正を行う。"""
    analysis_sr = 11_025
    analysis_hop = 2_048
    divisor = math.gcd(sample_rate, analysis_sr)
    original_small = sps.resample_poly(
        original, analysis_sr // divisor, sample_rate // divisor
    ).astype(np.float32, copy=False)
    karaoke_small = sps.resample_poly(
        karaoke, analysis_sr // divisor, sample_rate // divisor
    ).astype(np.float32, copy=False)
    if min(len(original_small), len(karaoke_small)) < analysis_sr * 4:
        raise ValueError("動的な位置合わせには音声が短すぎます。")

    original_chroma, original_times = _chroma_low_memory(
        original_small, analysis_sr, 4_096, analysis_hop
    )
    karaoke_chroma, karaoke_frame_times = _chroma_low_memory(
        karaoke_small, analysis_sr, 4_096, analysis_hop
    )
    path, similarity = _dtw_path_low_memory(original_chroma, karaoke_chroma)
    frame_count = original_chroma.shape[1]
    mapped_frames = np.full(frame_count, np.nan, dtype=np.float64)
    confidence = np.zeros(frame_count, dtype=np.float32)
    candidates: list[list[tuple[int, float]]] = [[] for _ in range(frame_count)]
    for original_frame, karaoke_frame in path:
        candidates[original_frame].append(
            (karaoke_frame, float(similarity[original_frame, karaoke_frame]))
        )
    for frame, matches in enumerate(candidates):
        if matches:
            best_frame, best_similarity = max(matches, key=lambda match: match[1])
            mapped_frames[frame] = best_frame
            confidence[frame] = best_similarity
    known = np.flatnonzero(np.isfinite(mapped_frames))
    if known.size < 2:
        raise ValueError("区間別の位置合わせを推定できませんでした。")
    mapped_frames = np.interp(np.arange(frame_count), known, mapped_frames[known])
    if frame_count >= 9:
        mapped_frames = sps.medfilt(mapped_frames, kernel_size=9)
        confidence = sps.medfilt(confidence, kernel_size=5)
    mapped_frames = np.maximum.accumulate(mapped_frames)
    karaoke_times = np.interp(
        mapped_frames,
        np.arange(len(karaoke_frame_times)),
        karaoke_frame_times,
    )
    karaoke_times, confidence = _refine_time_map_low_memory(
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
        # 同じ区間別DTW＋約5.8ms局所補正を、SciPyの小分け計算で行う。
        original = _read_audio_low_memory(original_file)
        karaoke = _read_audio_low_memory(karaoke_file)
        time_map = _piecewise_time_map_low_memory(
            original,
            karaoke,
            SAMPLE_RATE,
        )
        return original, karaoke, SAMPLE_RATE, 0.0, time_map

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


def _extract_vocals_chunked(
    original: np.ndarray,
    karaoke: np.ndarray,
    scale_factor: float,
    time_map: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
) -> tuple[np.ndarray, np.ndarray]:
    """重なり付き小区間STFTで、周波数別差分を512MB内に収める。"""
    output_length = len(original) if time_map is not None else min(len(original), len(karaoke))
    if output_length < 2_048:
        raise ValueError("差分抽出に必要な音声が短すぎます。")
    original = np.asarray(original[:output_length], dtype=np.float32)
    karaoke = np.asarray(karaoke, dtype=np.float32)
    natural_output = np.zeros(output_length, dtype=np.float32)
    enhanced_output = np.zeros(output_length, dtype=np.float32)
    # 8秒ごとに処理し、前後0.75秒をクロスフェードする。
    # STFT条件と重なり幅は維持しつつ、区間境界の重複計算だけを減らす。
    # 最大メモリはRender Freeの512MB内に収まる。
    chunk_samples = 8 * SAMPLE_RATE
    overlap_samples = 3 * SAMPLE_RATE // 4
    step_samples = chunk_samples - overlap_samples
    starts = list(range(0, output_length, step_samples))
    if starts and output_length - starts[-1] < 2_048:
        starts[-1] = max(0, output_length - chunk_samples)
        starts = sorted(set(starts))
    n_fft = 2_048
    hop_length = 512
    original_map_times = karaoke_map_times = map_confidence = None
    if time_map is not None:
        original_map_times, karaoke_map_times, map_confidence = time_map
    filled_until = 0

    for start in starts:
        end = min(output_length, start + chunk_samples)
        original_chunk = original[start:end]
        sample_times = (
            start + np.arange(end - start, dtype=np.float64)
        ) / SAMPLE_RATE
        if time_map is None:
            karaoke_chunk = karaoke[start:end]
            if len(karaoke_chunk) < len(original_chunk):
                karaoke_chunk = np.pad(
                    karaoke_chunk,
                    (0, len(original_chunk) - len(karaoke_chunk)),
                )
        else:
            mapped_times = np.interp(
                sample_times,
                original_map_times,
                karaoke_map_times,
                left=karaoke_map_times[0],
                right=karaoke_map_times[-1],
            )
            mapped_positions = np.clip(
                mapped_times * SAMPLE_RATE,
                0,
                max(0, len(karaoke) - 1),
            )
            left_indices = np.floor(mapped_positions).astype(np.int64)
            right_indices = np.minimum(left_indices + 1, len(karaoke) - 1)
            fractions = (mapped_positions - left_indices).astype(np.float32)
            karaoke_chunk = (
                karaoke[left_indices] * (np.float32(1.0) - fractions)
                + karaoke[right_indices] * fractions
            ).astype(np.float32, copy=False)

        frequencies, frame_times, original_stft = sps.stft(
            original_chunk,
            fs=SAMPLE_RATE,
            window="hann",
            nperseg=n_fft,
            noverlap=n_fft - hop_length,
            nfft=n_fft,
            boundary="zeros",
            padded=True,
        )
        _, _, karaoke_stft = sps.stft(
            karaoke_chunk,
            fs=SAMPLE_RATE,
            window="hann",
            nperseg=n_fft,
            noverlap=n_fft - hop_length,
            nfft=n_fft,
            boundary="zeros",
            padded=True,
        )
        original_stft = original_stft.astype(np.complex64, copy=False)
        karaoke_stft = karaoke_stft.astype(np.complex64, copy=False)
        original_magnitude = np.abs(original_stft).astype(np.float32, copy=False)
        karaoke_magnitude = np.abs(karaoke_stft).astype(np.float32, copy=False)
        if time_map is None:
            subtraction_weight: float | np.ndarray = 1.0
        else:
            global_frame_times = frame_times + start / SAMPLE_RATE
            frame_confidence = np.interp(
                global_frame_times,
                original_map_times,
                map_confidence,
                left=0.0,
                right=0.0,
            ).astype(np.float32, copy=False)
            subtraction_weight = np.clip(
                (frame_confidence - np.float32(0.35)) / np.float32(0.35),
                0.0,
                1.0,
            )
            if subtraction_weight.size >= 31:
                subtraction_weight = sps.medfilt(
                    subtraction_weight, kernel_size=31
                ).astype(np.float32, copy=False)
            subtraction_weight = subtraction_weight[np.newaxis, :]

        effective_karaoke = karaoke_magnitude * subtraction_weight
        subtraction_scale = np.float32(
            scale_factor * (1.18 if scale_factor > 0.3 else 1.0)
        )
        vocal_magnitude = np.maximum(
            original_magnitude - effective_karaoke * subtraction_scale,
            0,
        ).astype(np.float32, copy=False)
        voice_likelihood: np.ndarray | None = None
        if scale_factor > 0.3:
            baseline_magnitude = np.maximum(
                original_magnitude - effective_karaoke * np.float32(0.3),
                0,
            ).astype(np.float32, copy=False)
            epsilon = max(float(np.max(original_magnitude)) * 1e-7, 1e-10)
            evidence_magnitude = np.maximum(
                original_magnitude - effective_karaoke * np.float32(0.85),
                0,
            ).astype(np.float32, copy=False)
            residual_ratio = np.clip(
                evidence_magnitude / (original_magnitude + np.float32(epsilon)),
                0,
                1,
            ).astype(np.float32, copy=False)
            smooth_ratio = ndi.uniform_filter(
                residual_ratio,
                size=(5, 9),
                mode="nearest",
            ).astype(np.float32, copy=False)
            voice_evidence = np.maximum(
                smooth_ratio,
                residual_ratio * np.float32(0.72),
            )
            vocal_band_prior = np.interp(
                frequencies,
                [0, 70, 120, 5_500, 9_000, SAMPLE_RATE / 2],
                [0.18, 0.35, 1.0, 1.0, 0.55, 0.18],
            ).astype(np.float32)[:, np.newaxis]
            voice_likelihood = np.clip(
                (voice_evidence - np.float32(0.08)) / np.float32(0.62),
                0,
                1,
            ) * vocal_band_prior
            protection_floor = np.float32(0.10) + np.float32(0.84) * np.power(
                voice_likelihood,
                np.float32(0.6),
            )
            vocal_magnitude = np.maximum(
                vocal_magnitude,
                baseline_magnitude * protection_floor,
            ).astype(np.float32, copy=False)

        phase = original_stft / np.maximum(
            original_magnitude,
            np.float32(1e-12),
        )
        natural_stft = (vocal_magnitude * phase).astype(np.complex64, copy=False)
        _, natural_chunk = sps.istft(
            natural_stft,
            fs=SAMPLE_RATE,
            window="hann",
            nperseg=n_fft,
            noverlap=n_fft - hop_length,
            nfft=n_fft,
            input_onesided=True,
            boundary=True,
        )
        if voice_likelihood is None:
            voice_likelihood = np.interp(
                frequencies,
                [0, 70, 120, 5_500, 9_000, SAMPLE_RATE / 2],
                [0.0, 0.2, 0.75, 0.75, 0.3, 0.0],
            ).astype(np.float32)[:, np.newaxis]
        vocal_emphasis_gain = np.power(
            np.float32(10.0),
            (
                np.float32(3.0)
                * np.power(voice_likelihood, np.float32(0.8))
                / np.float32(20.0)
            ),
        ).astype(np.float32, copy=False)
        enhanced_stft = (
            vocal_magnitude * vocal_emphasis_gain * phase
        ).astype(np.complex64, copy=False)
        _, enhanced_chunk = sps.istft(
            enhanced_stft,
            fs=SAMPLE_RATE,
            window="hann",
            nperseg=n_fft,
            noverlap=n_fft - hop_length,
            nfft=n_fft,
            input_onesided=True,
            boundary=True,
        )
        segment_length = end - start
        natural_chunk = np.asarray(natural_chunk[:segment_length], dtype=np.float32)
        enhanced_chunk = np.asarray(enhanced_chunk[:segment_length], dtype=np.float32)
        if len(natural_chunk) < segment_length:
            natural_chunk = np.pad(
                natural_chunk, (0, segment_length - len(natural_chunk))
            )
        if len(enhanced_chunk) < segment_length:
            enhanced_chunk = np.pad(
                enhanced_chunk, (0, segment_length - len(enhanced_chunk))
            )
        overlap_length = max(0, min(filled_until, end) - start)
        if overlap_length:
            fade = np.linspace(0, np.pi / 2, overlap_length, dtype=np.float32)
            fade_in = np.sin(fade) ** 2
            fade_out = np.cos(fade) ** 2
            natural_output[start : start + overlap_length] = (
                natural_output[start : start + overlap_length] * fade_out
                + natural_chunk[:overlap_length] * fade_in
            )
            enhanced_output[start : start + overlap_length] = (
                enhanced_output[start : start + overlap_length] * fade_out
                + enhanced_chunk[:overlap_length] * fade_in
            )
        remainder_start = start + overlap_length
        if remainder_start < end:
            natural_output[remainder_start:end] = natural_chunk[overlap_length:]
            enhanced_output[remainder_start:end] = enhanced_chunk[overlap_length:]
        filled_until = max(filled_until, end)

    return (
        _normalise(natural_output).astype(np.float32, copy=False),
        _normalise(enhanced_output).astype(np.float32, copy=False),
    )


def extract_vocals(
    original: np.ndarray,
    karaoke: np.ndarray,
    scale_factor: float,
    time_map: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """区間別の時刻対応を反映したSTFTスペクトル減算でMR成分を抑える。"""
    if LOW_MEMORY_MODE:
        return _extract_vocals_chunked(
            original,
            karaoke,
            scale_factor,
            time_map,
        )

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
    if LOW_MEMORY_MODE:
        # FFmpegのloudnormは弱いCPUでは音声実時間の約1/6を要する。
        # 同じ仕上げ（70Hz整理、2.2:1 RMS圧縮、-16 dBFS正規化、
        # -1.5 dBFSピーク制限）をSciPyのベクトル演算で行う。
        source = np.asarray(samples, dtype=np.float32)
        highpass = sps.butter(
            2,
            70.0,
            btype="highpass",
            fs=sample_rate,
            output="sos",
        )
        processed = sps.sosfilt(highpass, source).astype(np.float32, copy=False)

        rms_window = max(3, int(round(sample_rate * 0.020)))
        threshold = np.float32(0.0631)
        ratio = np.float32(2.2)
        # 短い先読みでピークを確実に捕捉し、120msで滑らかに戻す。
        attack_samples = max(3, int(round(sample_rate * 0.015)))
        release_samples = max(3, int(round(sample_rate * 0.120)))
        compressor_padding = max(rms_window, attack_samples, release_samples)
        compressor_chunk = 8 * sample_rate
        compressed = np.empty_like(processed)
        for center_start in range(0, len(processed), compressor_chunk):
            center_end = min(len(processed), center_start + compressor_chunk)
            source_start = max(0, center_start - compressor_padding)
            source_end = min(len(processed), center_end + compressor_padding)
            segment = processed[source_start:source_end]
            power = np.square(segment, dtype=np.float32)
            envelope = ndi.uniform_filter1d(
                power,
                size=rms_window,
                mode="nearest",
            ).astype(np.float32, copy=False)
            del power
            np.maximum(envelope, np.float32(1e-12), out=envelope)
            np.sqrt(envelope, out=envelope)
            target_gain = np.full(envelope.shape, np.float32(1.4125), dtype=np.float32)
            above_threshold = envelope > threshold
            if np.any(above_threshold):
                target_gain[above_threshold] = (
                    threshold
                    * np.power(
                        envelope[above_threshold] / threshold,
                        np.float32(1.0) / ratio,
                    )
                    / envelope[above_threshold]
                    * np.float32(1.4125)
                )
            target_gain = ndi.minimum_filter1d(
                target_gain,
                size=attack_samples,
                mode="nearest",
            ).astype(np.float32, copy=False)
            target_gain = ndi.uniform_filter1d(
                target_gain,
                size=release_samples,
                mode="nearest",
            ).astype(np.float32, copy=False)
            local_start = center_start - source_start
            local_end = local_start + (center_end - center_start)
            compressed[center_start:center_end] = (
                segment[local_start:local_end] * target_gain[local_start:local_end]
            )
        processed = compressed

        # 無音を除いた400msブロックでラウドネスを見積もる。
        # さらに相対-10dBゲートを掛け、曲間の無音で音量が上がり過ぎないようにする。
        block_samples = max(1, int(round(sample_rate * 0.400)))
        complete_samples = len(processed) - (len(processed) % block_samples)
        if complete_samples:
            blocks = processed[:complete_samples].reshape(-1, block_samples)
            block_power = (
                np.einsum("ij,ij->i", blocks, blocks, dtype=np.float64)
                / block_samples
            )
            audible = block_power > 10.0 ** (-70.0 / 10.0)
            if np.any(audible):
                preliminary_power = float(np.mean(block_power[audible]))
                relative_gate = preliminary_power * 0.1
                gated = block_power[audible & (block_power >= relative_gate)]
                loudness_power = float(np.mean(gated)) if gated.size else preliminary_power
                target_rms = 10.0 ** (-16.0 / 20.0)
                loudness_gain = target_rms / math.sqrt(max(loudness_power, 1e-12))
                processed *= np.float32(loudness_gain)

        peak = max(
            abs(float(np.max(processed, initial=0.0))),
            abs(float(np.min(processed, initial=0.0))),
        )
        peak_limit = 10.0 ** (-1.5 / 20.0)
        if peak > peak_limit:
            # 全体を下げず、-3dBFSより上の瞬間的なピークだけを滑らかに制限する。
            # loudnorm同様、目標ラウドネスを保ったままクリップを防ぐ。
            limiter_knee = 10.0 ** (-3.0 / 20.0)
            limiter_width = peak_limit - limiter_knee
            for start in range(0, len(processed), 8 * sample_rate):
                block = processed[start : start + 8 * sample_rate]
                magnitudes = np.abs(block)
                limited = magnitudes > limiter_knee
                if np.any(limited):
                    block[limited] = (
                        np.sign(block[limited])
                        * (
                            limiter_knee
                            + limiter_width
                            * np.tanh(
                                (magnitudes[limited] - limiter_knee)
                                / limiter_width
                            )
                        )
                    )
        np.nan_to_num(processed, copy=False)
        sf.write(output_path, processed, sample_rate, subtype="PCM_16")
        return
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
    _trim_process_memory()
    if progress:
        progress(82, "生歌の差分を抽出しています")
    natural_vocals, enhanced_vocals = extract_vocals(
        original,
        karaoke,
        scale_factor,
        time_map,
    )
    has_time_map = time_map is not None
    # 仕上げ処理には抽出済み波形だけあればよい。長尺入力と時刻対応を先に解放し、
    # 512MB環境でも高速なベクトル処理用の余白を確保する。
    del original, karaoke, time_map
    _trim_process_memory()
    if progress:
        progress(91, "ボーカルを聴きやすく整えています")
    natural_name = _unique_name("extracted_vocals_natural.wav")
    enhanced_name = _unique_name("extracted_vocals_enhanced.wav")
    natural_path = MEDIA_DIR / natural_name
    enhanced_path = MEDIA_DIR / enhanced_name
    sf.write(natural_path, natural_vocals, sample_rate)
    del natural_vocals
    _trim_process_memory()
    _finish_vocal_enhancement(enhanced_vocals, sample_rate, enhanced_path)
    if progress:
        progress(96, "再生データを仕上げています")
    result = {
        "vocal_url": f"/media/{enhanced_name}",
        "vocal_natural_url": f"/media/{natural_name}",
        "vocal_enhanced": True,
        "offset_seconds": offset,
        "alignment_mode": "hierarchical_fine" if has_time_map else "global",
        "alignment_resolution_ms": round(64 / 11_025 * 1_000, 2)
        if has_time_map
        else None,
    }
    if video_name and FFMPEG_PATH:
        # プレビューは元動画＋抽出音声をブラウザで同期再生できる。
        # ダウンロード用動画は利用者が押した時だけ生成し、初回結果を45秒待たせない。
        result["result_video_url"] = "/render-video?" + urlparse.urlencode(
            {
                "video": video_name,
                "audio": enhanced_name,
                "offset": offset,
                "variant": "enhanced",
            }
        )
        result["result_video_natural_url"] = "/render-video?" + urlparse.urlencode(
            {
                "video": video_name,
                "audio": natural_name,
                "offset": offset,
                "variant": "natural",
            }
        )
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
            if total_bytes is not None:
                if total_bytes > app.config["MAX_CONTENT_LENGTH"]:
                    raise RuntimeError(f"取得メディアが上限（{MAX_CONTENT_MB} MB）を超えています。")
                ranges = [
                    (start, min(start + chunk_bytes - 1, total_bytes - 1))
                    for start in range(0, total_bytes, chunk_bytes)
                ]

                def fetch_part(byte_range: tuple[int, int]):
                    start, end = byte_range
                    try:
                        return _fetch_worker_range_with_retry(
                            endpoint,
                            url,
                            token,
                            start,
                            end,
                            region,
                            format_hint,
                        )
                    except RuntimeError:
                        # 選択地域が一時的に拒否した範囲だけ、自動選択で取り直す。
                        return _fetch_worker_range_with_retry(
                            endpoint,
                            url,
                            token,
                            start,
                            end,
                            None,
                            format_hint,
                        )

                # 4範囲ずつ並列取得し、書込み順とメモリ上限は維持する。
                with ThreadPoolExecutor(max_workers=4) as executor:
                    for batch_start in range(0, len(ranges), 4):
                        batch = ranges[batch_start : batch_start + 4]
                        parts = list(executor.map(fetch_part, batch))
                        for expected_range, part in zip(batch, parts):
                            payload, actual_start, actual_end, part_total, part_region, part_type = part
                            if part_total != total_bytes or actual_start != expected_range[0]:
                                raise RuntimeError(
                                    "地域Resolverの総サイズまたは分割位置が途中で変わりました。"
                                )
                            if actual_end != expected_range[1]:
                                raise RuntimeError("地域Resolverの分割終端が要求と一致しません。")
                            content_type = part_type
                            output.write(payload)
                            position = actual_end + 1
            else:
                # サイズを事前取得できない短い素材だけ、従来どおり直列で読む。
                while total_bytes is None or position < total_bytes:
                    requested_end = (
                        position + chunk_bytes - 1
                        if total_bytes is None
                        else min(position + chunk_bytes - 1, total_bytes - 1)
                    )
                    part = _fetch_worker_range_with_retry(
                        endpoint, url, token, position, requested_end, region, format_hint
                    )
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


@app.get("/render-video")
def render_video():
    """ダウンロード用の音声差替え動画を、要求された時だけ生成する。"""
    video_name = Path(str(request.args.get("video", ""))).name
    audio_name = Path(str(request.args.get("audio", ""))).name
    variant = "natural" if request.args.get("variant") == "natural" else "enhanced"
    try:
        offset = max(0.0, min(60.0, float(request.args.get("offset", "0"))))
        video_path = _media_path(video_name)
        audio_path = _media_path(audio_name)
    except (ValueError, FileNotFoundError) as error:
        return jsonify(error=str(error)), 404
    cache_key = (video_name, audio_name, round(offset, 4))
    with RESULT_VIDEO_CACHE_LOCK:
        cached_name = RESULT_VIDEO_CACHE.get(cache_key)
        if cached_name and (MEDIA_DIR / cached_name).is_file():
            return redirect(f"/media/{cached_name}", code=302)
        result_url = _mux_result_video(
            video_path,
            audio_path,
            offset,
            f"mr_removal_video_{variant}.mp4",
        )
        if not result_url:
            return jsonify(error="結果動画を生成できませんでした。"), 500
        result_name = Path(result_url).name
        RESULT_VIDEO_CACHE[cache_key] = result_name
    return redirect(result_url, code=302)


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
    started_at = time.perf_counter()

    def report(value: int, message: str) -> None:
        app.logger.info(
            "pipeline progress=%s elapsed=%.2fs stage=%s",
            value,
            time.perf_counter() - started_at,
            message,
        )
        if progress:
            progress(value, message)

    # ステージ音声・プレビュー動画・比較音源は互いに独立しているため、
    # Resolver取得とFFmpeg変換を同時に進める。
    report(7, "必要な動画と音声を同時に取得しています")
    with ThreadPoolExecutor(max_workers=3) as executor:
        original_future = executor.submit(_download_audio, video_url, "original")
        preview_future = executor.submit(_download_video, video_url)
        karaoke_future = (
            executor.submit(_download_audio, karaoke_url, "karaoke")
            if karaoke_url
            else None
        )
        original_name = original_future.result()
        report(26, "ステージ音声を取得しました")
        preview_name = original_name
        preview_is_audio_only = True
        try:
            preview_name = preview_future.result()
            preview_is_audio_only = False
        except Exception:
            pass
        report(43, "動画プレビューを取得しました")
        karaoke_name = karaoke_future.result() if karaoke_future else None

    response = {
        "video_url": f"/media/{preview_name}",
        "video_audio_url": f"/media/{original_name}",
        "video_filename": preview_name,
        "video_audio_filename": original_name,
        "preview_is_audio_only": preview_is_audio_only,
    }
    if karaoke_name:
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
