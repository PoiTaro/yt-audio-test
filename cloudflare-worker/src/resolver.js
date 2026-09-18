const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENTS = [
  {
    name: 'ANDROID_VR',
    id: '28',
    version: '1.65.10',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    extra: { androidSdkVersion: 32, osName: 'Android', osVersion: '12L', platform: 'MOBILE', deviceMake: 'Oculus', deviceModel: 'Quest 3' },
  },
  {
    name: 'IOS',
    id: '5',
    version: '20.11.6',
    userAgent: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
    extra: { osName: 'iOS', osVersion: '16.7.7.20H330', platform: 'MOBILE', deviceMake: 'Apple', deviceModel: 'iPhone10,4' },
  },
];

class ResolverError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResolverError';
    this.code = code;
    this.details = details;
  }
}

function parseJsonObjectAt(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(source.slice(start, index + 1));
  }
  return null;
}

export function extractVideoId(input) {
  const value = String(input ?? '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ResolverError('INVALID_VIDEO_URL', 'YouTube URLまたは11文字のVideo IDを指定してください。');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let candidate = null;
  if (host === 'youtu.be') candidate = url.pathname.split('/').filter(Boolean)[0];
  else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (url.pathname === '/watch') candidate = url.searchParams.get('v');
    else candidate = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(candidate || '')) {
    throw new ResolverError('INVALID_VIDEO_URL', '対応するYouTube URLではありません。');
  }
  return candidate;
}

export function extractInitialPlayerResponse(html) {
  const markers = [
    'var ytInitialPlayerResponse = ',
    'window["ytInitialPlayerResponse"] = ',
    "window['ytInitialPlayerResponse'] = ",
  ];
  const candidates = [];
  for (const marker of markers) {
    let offset = 0;
    while (true) {
      const index = html.indexOf(marker, offset);
      if (index < 0) break;
      candidates.push({ index, marker });
      offset = index + marker.length;
    }
  }
  candidates.sort((a, b) => b.index - a.index);
  for (const candidate of candidates) {
    const start = html.indexOf('{', candidate.index + candidate.marker.length);
    if (start < 0 || start - candidate.index > candidate.marker.length + 32) continue;
    try {
      const result = parseJsonObjectAt(html, start);
      if (result) return result;
    } catch {
      // YouTube can include an invalid placeholder before the useful response.
    }
  }
  throw new ResolverError('NO_PLAYER_RESPONSE', '視聴ページからPlayer応答を抽出できませんでした。');
}

export function selectBestAudio(playerResponse) {
  const formats = (playerResponse?.streamingData?.adaptiveFormats ?? [])
    .filter((format) => format.mimeType?.startsWith('audio/') && (format.url || format.signatureCipher || format.cipher));
  if (!formats.length) throw new ResolverError('NO_AUDIO_FORMAT', 'audio-only formatがありません。');
  return [...formats].sort((a, b) => {
    const drcScore = Number(Boolean(a.isDrc)) - Number(Boolean(b.isDrc));
    if (drcScore) return drcScore;
    return (b.averageBitrate ?? b.bitrate ?? 0) - (a.averageBitrate ?? a.bitrate ?? 0);
  })[0];
}

function playerIdFrom(value) {
  return value?.match?.(/\/s\/player\/([A-Za-z0-9_-]+)\//)?.[1] ?? null;
}

async function fetchWatchResponse(videoId, diagnostics) {
  const url = new URL('https://www.youtube.com/watch');
  url.searchParams.set('v', videoId);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', 'US');
  url.searchParams.set('has_verified', '1');
  url.searchParams.set('bpctr', '9999999999');
  url.searchParams.set('probe', crypto.randomUUID());
  const response = await fetch(url, {
    headers: {
      'User-Agent': MOBILE_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
  });
  const html = await response.text();
  let playerResponse = null;
  try {
    playerResponse = extractInitialPlayerResponse(html);
  } catch {
    // The InnerTube fallback below records the final failure.
  }
  diagnostics.watch = {
    status: response.status,
    bytes: html.length,
    playability: playerResponse?.playabilityStatus?.status ?? null,
    reason: playerResponse?.playabilityStatus?.reason ?? null,
    formats: playerResponse?.streamingData?.adaptiveFormats?.length ?? 0,
  };
  return { html, playerResponse, playerId: playerIdFrom(playerResponse?.assets?.js) || playerIdFrom(html) };
}

async function fetchInnerTubeResponse(videoId, diagnostics) {
  diagnostics.innerTube = [];
  for (const client of INNERTUBE_CLIENTS) {
    const response = await fetch(`https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=${INNERTUBE_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.userAgent,
        'X-Youtube-Client-Name': client.id,
        'X-Youtube-Client-Version': client.version,
        Origin: 'https://www.youtube.com',
      },
      body: JSON.stringify({
        context: { client: { hl: 'en', gl: 'US', clientName: client.name, clientVersion: client.version, userAgent: client.userAgent, ...client.extra } },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
      }),
    });
    let result = {};
    try { result = await response.json(); } catch { /* Record the empty response below. */ }
    const audioFormats = (result?.streamingData?.adaptiveFormats ?? []).filter((format) => format.mimeType?.startsWith('audio/')).length;
    diagnostics.innerTube.push({
      client: client.name,
      status: response.status,
      playability: result?.playabilityStatus?.status ?? null,
      reason: result?.playabilityStatus?.reason ?? null,
      audioFormats,
    });
    if (audioFormats > 0) return result;
  }
  return null;
}

async function fetchFallbackPlayerId() {
  const response = await fetch('https://www.youtube.com/iframe_api', {
    headers: { 'User-Agent': MOBILE_USER_AGENT, 'Cache-Control': 'no-cache' },
  });
  return playerIdFrom(await response.text());
}

function safeContentType(value) {
  return value && /^audio\//i.test(value) ? value : 'application/octet-stream';
}

export function parseContentRange(value) {
  const match = String(value ?? '').match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const result = { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
  if (!Number.isSafeInteger(result.start) || !Number.isSafeInteger(result.end)
      || !Number.isSafeInteger(result.total) || result.start > result.end || result.end >= result.total) {
    return null;
  }
  return result;
}

function googleVideoHeaders(range) {
  return {
    ...(range ? { Range: range } : {}),
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
    'User-Agent': MOBILE_USER_AGENT,
  };
}

export async function resolveAndFetchAudio({
  videoId,
  renderDecipherUrl,
  decipherToken,
  range,
  cachedResolution = null,
}) {
  const startedAt = Date.now();
  const diagnostics = { videoId };
  let resolution = cachedResolution;
  if (!resolution) {
    const watch = await fetchWatchResponse(videoId, diagnostics);
    let playerResponse = watch.playerResponse;
    try {
      selectBestAudio(playerResponse);
    } catch {
      playerResponse = await fetchInnerTubeResponse(videoId, diagnostics);
    }
    if (!playerResponse) {
      const status = diagnostics.watch?.playability || diagnostics.innerTube?.at(-1)?.playability || 'UNPLAYABLE';
      throw new ResolverError(status, 'この実行地域では再生可能な応答を取得できませんでした。', diagnostics);
    }

    const format = selectBestAudio(playerResponse);
    const playerId = playerIdFrom(playerResponse?.assets?.js) || watch.playerId || await fetchFallbackPlayerId();
    diagnostics.format = {
      itag: format.itag ?? null,
      mimeType: format.mimeType ?? null,
      bitrate: format.averageBitrate ?? format.bitrate ?? null,
    };

    const decipherResponse = await fetch(renderDecipherUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(decipherToken ? { Authorization: `Bearer ${decipherToken}` } : {}),
      },
      body: JSON.stringify({
        ...(playerId ? { playerId } : {}),
        ...(format.url ? { url: format.url } : {}),
        ...(format.signatureCipher ? { signatureCipher: format.signatureCipher } : {}),
        ...(format.cipher ? { cipher: format.cipher } : {}),
      }),
    });
    let deciphered = {};
    try { deciphered = await decipherResponse.json(); } catch { /* Normalize below. */ }
    diagnostics.decipher = { status: decipherResponse.status, nChanged: deciphered.nChanged ?? null };
    if (!decipherResponse.ok || !deciphered.url) {
      throw new ResolverError('DECIPHER_FAILED', deciphered.error || `変換APIがHTTP ${decipherResponse.status}を返しました。`, diagnostics);
    }
    const resolvedStreamUrl = new URL(deciphered.url);
    const totalBytes = Number(format.contentLength || resolvedStreamUrl.searchParams.get('clen'));
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new ResolverError('NO_CONTENT_LENGTH', '音声ストリームの全体サイズを取得できませんでした。', diagnostics);
    }
    resolution = {
      streamUrl: deciphered.url,
      format: diagnostics.format,
      totalBytes,
      cpn: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
    };
  } else {
    diagnostics.cacheHit = true;
    diagnostics.format = resolution.format;
  }

  const streamUrl = new URL(resolution.streamUrl);
  if (streamUrl.protocol !== 'https:' || !/(^|\.)googlevideo\.com$/i.test(streamUrl.hostname)) {
    throw new ResolverError('INVALID_STREAM_HOST', '変換APIが不正な配信先を返しました。', diagnostics);
  }
  // Player応答のURLには先頭1 MiB用のrangeクエリが含まれる場合がある。
  // HTTP Rangeだけを変更してもクエリ側が優先され、1 MiB以降が403になるため、
  // 呼び出し元が要求した区間へ両方を揃える。
  const requestedBytes = String(range ?? '').match(/^bytes=(\d+)-(\d+)$/i);
  if (requestedBytes) {
    streamUrl.searchParams.set('cpn', resolution.cpn);
    streamUrl.searchParams.set('range', `${requestedBytes[1]}-${requestedBytes[2]}`);
  }
  let streamResponse = await fetch(streamUrl, {
    // YouTube.jsも分割取得ではHTTP Rangeを送らず、URLのrangeだけを使う。
    headers: googleVideoHeaders(requestedBytes ? null : range),
    redirect: 'follow',
  });
  diagnostics.googlevideo = {
    status: streamResponse.status,
    contentType: streamResponse.headers.get('content-type'),
    contentLength: streamResponse.headers.get('content-length'),
    contentRange: streamResponse.headers.get('content-range'),
  };
  diagnostics.elapsedMs = Date.now() - startedAt;
  if (!streamResponse.ok || !streamResponse.body) {
    throw new ResolverError(`GOOGLEVIDEO_${streamResponse.status}`, `GoogleVideoがHTTP ${streamResponse.status}を返しました。`, diagnostics);
  }
  if (requestedBytes) {
    const start = Number(requestedBytes[1]);
    const requestedEnd = Number(requestedBytes[2]);
    const end = Math.min(requestedEnd, resolution.totalBytes - 1);
    const expectedBytes = end - start + 1;
    const receivedBytes = Number(streamResponse.headers.get('content-length'));
    if (start < 0 || start >= resolution.totalBytes || end < start
        || (Number.isFinite(receivedBytes) && receivedBytes !== expectedBytes)) {
      throw new ResolverError('INVALID_RANGE_RESPONSE', 'GoogleVideoのRange応答サイズが一致しません。', {
        ...diagnostics,
        requestedRange: range,
        expectedBytes,
        receivedBytes,
        totalBytes: resolution.totalBytes,
      });
    }
    const headers = new Headers(streamResponse.headers);
    headers.set('content-range', `bytes ${start}-${end}/${resolution.totalBytes}`);
    headers.set('content-length', String(expectedBytes));
    headers.set('accept-ranges', 'bytes');
    streamResponse = new Response(streamResponse.body, { status: 206, headers });
  }
  return {
    response: streamResponse,
    diagnostics,
    contentType: safeContentType(streamResponse.headers.get('content-type')),
    resolution,
  };
}

export function serializeResolverError(error) {
  return {
    code: error?.code || error?.name || 'RESOLVER_ERROR',
    message: error?.message || 'Unknown resolver error',
    ...(error?.details ? { details: error.details } : {}),
  };
}
