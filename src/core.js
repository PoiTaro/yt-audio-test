import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Constants, Innertube, UniversalCache } from 'youtubei.js';

export const SUPPORTED_CLIENTS = [
  'ANDROID_VR',
  'IOS',
  'WEB',
  'MWEB',
  'ANDROID',
  'TV',
];

export function extractVideoId(input) {
  const value = String(input ?? '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProbeError('INVALID_URL', 'YouTube URLまたは11文字のVideo IDを指定してください。');
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let candidate = null;

  if (host === 'youtu.be') {
    candidate = parsed.pathname.split('/').filter(Boolean)[0];
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (parsed.pathname === '/watch') candidate = parsed.searchParams.get('v');
    else {
      const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      candidate = match?.[1] ?? null;
    }
  }

  if (!candidate || !/^[A-Za-z0-9_-]{11}$/.test(candidate)) {
    throw new ProbeError('INVALID_URL', 'URLから有効なYouTube Video IDを取得できませんでした。');
  }
  return candidate;
}

export class ProbeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
    this.details = details;
  }
}

export function classifyError(error) {
  if (error instanceof ProbeError) {
    return { code: error.code, message: error.message, details: error.details };
  }

  const message = String(error?.message ?? error ?? 'Unknown error');
  const upper = `${error?.info?.error_type ?? ''} ${message}`.toUpperCase();
  let code = 'UNKNOWN';

  if (upper.includes('LOGIN_REQUIRED') || upper.includes('SIGN IN')) code = 'LOGIN_REQUIRED';
  else if (upper.includes('UNPLAYABLE') || upper.includes('VIDEO IS UNAVAILABLE')) code = 'UNPLAYABLE';
  else if (upper.includes('PO TOKEN') || upper.includes('POTOKEN') || upper.includes('PROOF OF ORIGIN')) code = 'PO_TOKEN_REQUIRED';
  else if (upper.includes('DECIPHER') || upper.includes('SIGNATURE') || upper.includes('NSIG')) code = 'SIGNATURE_DECIPHER';
  else if (upper.includes('403')) code = 'HTTP_403';
  else if (upper.includes('TIMEOUT') || upper.includes('ABORT')) code = 'TIMEOUT';
  else if (upper.includes('ENOTFOUND') || upper.includes('ECONN') || upper.includes('FETCH FAILED')) code = 'NETWORK_ERROR';

  return { code, message };
}

export function describeFormat(format) {
  const codecs = /codecs="([^"]+)"/.exec(format.mime_type ?? '')?.[1] ?? null;
  return {
    itag: format.itag,
    mime: format.mime_type ?? null,
    codec: codecs,
    bitrate: format.bitrate ?? null,
    averageBitrate: format.average_bitrate ?? null,
    contentLength: format.content_length ?? null,
    durationMs: format.approx_duration_ms ?? null,
    sampleRate: format.audio_sample_rate ?? null,
    channels: format.audio_channels ?? null,
    audioQuality: format.audio_quality ?? null,
    language: format.language ?? null,
    isOriginal: format.is_original ?? null,
    isDrc: format.is_drc ?? false,
    hasUrl: Boolean(format.url || format.signature_cipher || format.cipher),
  };
}

export function selectBestAudio(formats) {
  const candidates = formats.filter((format) => format.has_audio && !format.has_video);
  if (!candidates.length) {
    throw new ProbeError('NO_AUDIO_FORMAT', 'audio-only formatが見つかりませんでした。');
  }

  return [...candidates].sort((a, b) => {
    const originalScore = Number(Boolean(b.is_original)) - Number(Boolean(a.is_original));
    if (originalScore) return originalScore;
    const drcScore = Number(Boolean(a.is_drc)) - Number(Boolean(b.is_drc));
    if (drcScore) return drcScore;
    return (b.average_bitrate ?? b.bitrate ?? 0) - (a.average_bitrate ?? a.bitrate ?? 0);
  })[0];
}

export function inspectExpiry(streamUrl) {
  try {
    const raw = new URL(streamUrl).searchParams.get('expire');
    const epochSeconds = raw ? Number(raw) : NaN;
    if (!Number.isFinite(epochSeconds)) return null;
    return {
      epochSeconds,
      iso: new Date(epochSeconds * 1000).toISOString(),
      secondsRemaining: Math.floor(epochSeconds - Date.now() / 1000),
    };
  } catch {
    return null;
  }
}

export async function createResolver(cacheDirectory) {
  await mkdir(cacheDirectory, { recursive: true });
  return Innertube.create({
    cache: new UniversalCache(true, cacheDirectory),
    lang: 'ja',
    location: 'JP',
  });
}

export async function probeHttp(streamUrl, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('HTTP probe timeout')), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(streamUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        ...Constants.STREAM_HEADERS,
        range: 'bytes=0-65535',
      },
      signal: controller.signal,
    });

    let bytesRead = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const { value } = await reader.read();
      bytesRead = value?.byteLength ?? 0;
      await reader.cancel();
    }

    const result = {
      success: response.ok && bytesRead > 0,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      bytesRead,
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
    if (!response.ok) {
      result.error = {
        code: response.status === 403 ? 'HTTP_403' : `HTTP_${response.status}`,
        message: `GoogleVideo returned HTTP ${response.status}`,
      };
    }
    return result;
  } catch (error) {
    return {
      success: false,
      status: null,
      bytesRead: 0,
      elapsedMs: Date.now() - startedAt,
      error: classifyError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runFfmpeg(streamUrl, outputFile, seconds = 10, timeoutMs = 45_000, bitrate = 192_000) {
  await mkdir(path.dirname(outputFile), { recursive: true });
  const startedAt = Date.now();
  const estimatedBytes = Math.ceil((seconds * bitrate) / 8);
  const targetBytes = Math.max(2 * 1024 * 1024, estimatedBytes * 6);
  const chunkBytes = 1024 * 1024;
  const controller = new AbortController();
  const initialFetchTimer = setTimeout(() => controller.abort(new Error('FFmpeg input timeout')), Math.min(timeoutMs, 15_000));
  let firstResponse;
  try {
    firstResponse = await fetch(streamUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        ...Constants.STREAM_HEADERS,
        range: `bytes=0-${Math.min(chunkBytes, targetBytes) - 1}`,
      },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(initialFetchTimer);
    return {
      success: false,
      exitCode: null,
      error: classifyError(error),
      stderr: '',
      elapsedMs: Date.now() - startedAt,
      outputFile,
      inputHttpStatus: null,
    };
  }
  clearTimeout(initialFetchTimer);

  if (!firstResponse.ok || !firstResponse.body) {
    return {
      success: false,
      exitCode: null,
      error: {
        code: firstResponse.status === 403 ? 'HTTP_403' : `HTTP_${firstResponse.status}`,
        message: `FFmpeg input stream returned HTTP ${firstResponse.status}`,
      },
      stderr: '',
      elapsedMs: Date.now() - startedAt,
      outputFile,
      inputHttpStatus: firstResponse.status,
    };
  }

  async function* rangeChunks() {
    let offset = 0;
    let response = firstResponse;
    while (offset < targetBytes) {
      if (offset > 0) {
        const end = Math.min(offset + chunkBytes, targetBytes) - 1;
        response = await fetch(streamUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            ...Constants.STREAM_HEADERS,
            range: `bytes=${offset}-${end}`,
          },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new ProbeError(
            response.status === 403 ? 'HTTP_403' : `HTTP_${response.status}`,
            `FFmpeg input stream returned HTTP ${response.status} at byte ${offset}`,
          );
        }
      }
      for await (const chunk of Readable.fromWeb(response.body)) yield chunk;
      offset += chunkBytes;
    }
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    '-i', 'pipe:0',
    '-t', String(seconds),
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '44100',
    '-ac', '2',
    outputFile,
  ];
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      resolve({ ...result, elapsedMs: Date.now() - startedAt, outputFile, inputHttpStatus: firstResponse.status });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ success: false, exitCode: null, error: { code: 'TIMEOUT', message: 'FFmpeg timeout' }, stderr });
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (error) => {
      finish({ success: false, exitCode: null, error: { code: 'FFMPEG_ERROR', message: error.message }, stderr });
    });
    child.on('close', (exitCode) => {
      const success = exitCode === 0;
      finish({
        success,
        exitCode,
        error: success ? null : { code: 'FFMPEG_ERROR', message: stderr.trim() || `FFmpeg exited with ${exitCode}` },
        stderr: stderr.trim(),
      });
    });
    const input = Readable.from(rangeChunks());
    input.on('error', (error) => {
      child.kill('SIGKILL');
      finish({ success: false, exitCode: null, error: classifyError(error), stderr });
    });
    input.pipe(child.stdin).on('error', () => {});
  });
}

export async function probeClient({
  youtube,
  videoId,
  client,
  outputDirectory,
  seconds = 10,
  httpTimeoutMs = 15_000,
  ffmpegTimeoutMs = 45_000,
  skipHttp = false,
  skipFfmpeg = false,
  log = () => {},
}) {
  const result = {
    client,
    startedAt: new Date().toISOString(),
    metadataSuccess: false,
    streamUrlSuccess: false,
    googlevideoSuccess: null,
    ffmpegSuccess: null,
    playability: null,
    video: null,
    formats: [],
    selectedFormat: null,
    streamUrl: null,
    streamExpiry: null,
    http: null,
    ffmpeg: null,
    error: null,
  };

  try {
    log(`InnerTube ${client}: 接続中`);
    const info = await youtube.getBasicInfo(videoId, { client });
    result.metadataSuccess = true;
    result.playability = {
      status: info.playability_status?.status ?? null,
      reason: info.playability_status?.reason ?? null,
      embeddable: info.playability_status?.embeddable ?? null,
    };
    result.video = {
      id: info.basic_info.id ?? videoId,
      title: info.basic_info.title ?? null,
      author: info.basic_info.author ?? null,
      durationSeconds: info.basic_info.duration ?? null,
      isLive: info.basic_info.is_live ?? false,
      isPrivate: info.basic_info.is_private ?? false,
    };
    log(`動画情報: OK (${result.playability.status ?? 'status不明'})`);

    if (result.playability.status && result.playability.status !== 'OK') {
      throw new ProbeError(
        result.playability.status,
        result.playability.reason || `Playability: ${result.playability.status}`,
      );
    }

    const audioFormats = (info.streaming_data?.adaptive_formats ?? [])
      .filter((format) => format.has_audio && !format.has_video);
    result.formats = audioFormats.map(describeFormat);
    log(`audio-only format: ${audioFormats.length}件`);

    const selected = selectBestAudio(audioFormats);
    result.selectedFormat = describeFormat(selected);
    log(`選択: itag ${selected.itag}, ${result.selectedFormat.codec ?? result.selectedFormat.mime}, ${selected.bitrate ?? '?'} bps`);

    const streamUrl = await selected.decipher(youtube.session.player);
    if (!streamUrl) throw new ProbeError('NO_URL', 'formatのストリームURLを解決できませんでした。');
    result.streamUrl = streamUrl;
    result.streamUrlSuccess = true;
    result.streamExpiry = inspectExpiry(streamUrl);
    log(`ストリームURL: OK${result.streamExpiry ? ` (期限 ${result.streamExpiry.iso})` : ''}`);

    if (!skipHttp) {
      result.http = await probeHttp(streamUrl, httpTimeoutMs);
      result.googlevideoSuccess = result.http.success;
      log(`GoogleVideo: ${result.http.success ? 'OK' : 'NG'}${result.http.status ? ` (HTTP ${result.http.status})` : ''}`);
    }

    if (!skipFfmpeg) {
      const outputFile = path.join(outputDirectory, `${videoId}_${client}_${seconds}s.wav`);
      result.ffmpeg = await runFfmpeg(
        streamUrl,
        outputFile,
        seconds,
        ffmpegTimeoutMs,
        selected.average_bitrate ?? selected.bitrate ?? 192_000,
      );
      result.ffmpegSuccess = result.ffmpeg.success;
      log(`FFmpeg ${seconds}秒変換: ${result.ffmpeg.success ? 'OK' : 'NG'}`);
    }

    const checks = [result.streamUrlSuccess];
    if (!skipHttp) checks.push(result.googlevideoSuccess);
    if (!skipFfmpeg) checks.push(result.ffmpegSuccess);
    if (!checks.every(Boolean)) {
      result.error = result.ffmpeg?.error ?? result.http?.error ?? { code: 'PROBE_FAILED', message: '検証工程の一部が失敗しました。' };
    }
  } catch (error) {
    result.error = classifyError(error);
    log(`失敗: ${result.error.code} - ${result.error.message}`);
  }

  result.success = !result.error;
  result.completedAt = new Date().toISOString();
  return result;
}

export function buildSummary(results) {
  const attempts = results.flatMap((entry) => entry.attempts);
  const ratio = (predicate) => {
    const total = attempts.length;
    const successes = attempts.filter(predicate).length;
    return { successes, total, rate: total ? successes / total : 0 };
  };
  const byClient = {};
  for (const client of new Set(attempts.map((attempt) => attempt.client))) {
    const clientAttempts = attempts.filter((attempt) => attempt.client === client);
    byClient[client] = {
      attempts: clientAttempts.length,
      successes: clientAttempts.filter((attempt) => attempt.success).length,
      metadataSuccesses: clientAttempts.filter((attempt) => attempt.metadataSuccess).length,
      directUrlSuccesses: clientAttempts.filter((attempt) => attempt.streamUrlSuccess).length,
      googlevideoSuccesses: clientAttempts.filter((attempt) => attempt.googlevideoSuccess === true).length,
      ffmpegSuccesses: clientAttempts.filter((attempt) => attempt.ffmpegSuccess === true).length,
    };
  }
  return {
    attempts: attempts.length,
    fullSuccess: ratio((attempt) => attempt.success),
    metadata: ratio((attempt) => attempt.metadataSuccess),
    directUrl: ratio((attempt) => attempt.streamUrlSuccess),
    googlevideo: ratio((attempt) => attempt.googlevideoSuccess === true),
    ffmpeg: ratio((attempt) => attempt.ffmpegSuccess === true),
    byClient,
  };
}
