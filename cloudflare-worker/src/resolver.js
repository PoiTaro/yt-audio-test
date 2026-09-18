const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CLIENTS = [
  {
    name: 'ANDROID',
    id: '3',
    version: '21.26.364',
    userAgent: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
    extra: { androidSdkVersion: 30, osName: 'Android', osVersion: '11', platform: 'MOBILE' },
  },
  {
    name: 'IOS',
    id: '5',
    version: '21.26.4',
    userAgent: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    extra: { osName: 'iPhone', osVersion: '18.3.2.22D82', platform: 'MOBILE', deviceMake: 'Apple', deviceModel: 'iPhone16,2' },
  },
  {
    name: 'VISIONOS',
    id: '101',
    version: '1.02',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    extra: { osName: 'visionOS', osVersion: '26.5.23O471', platform: 'DESKTOP', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1' },
  },
  {
    name: 'MWEB',
    id: '2',
    version: '2.20260708.05.00',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
    extra: { osName: 'iOS', osVersion: '16.7.10', platform: 'MOBILE' },
  },
  {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    id: '85',
    version: '2.0',
    userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    extra: { platform: 'TV' },
    embedUrl: 'https://www.youtube.com/',
  },
  {
    name: 'WEB_EMBEDDED_PLAYER',
    id: '56',
    version: '2.20260708.00.00',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)',
    extra: { platform: 'DESKTOP' },
    embedUrl: 'https://www.youtube.com/',
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

function base64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signedInternalHeaders(urlValue, body, privateJwkValue) {
  if (!privateJwkValue) {
    throw new ResolverError(
      'INTERNAL_AUTH_MISCONFIGURED',
      '内部API署名鍵が設定されていません。',
    );
  }
  let privateJwk;
  try {
    privateJwk = typeof privateJwkValue === 'string'
      ? JSON.parse(privateJwkValue)
      : privateJwkValue;
  } catch {
    throw new ResolverError('INTERNAL_AUTH_MISCONFIGURED', '内部API署名鍵が不正です。');
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const url = new URL(urlValue);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = crypto.randomUUID();
  const message = `${timestamp}\n${nonce}\n${url.pathname}\n${await sha256Hex(body)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(message),
  );
  return {
    'X-Resolver-Timestamp': timestamp,
    'X-Resolver-Nonce': nonce,
    'X-Resolver-Signature': base64Url(signature),
  };
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

export function selectBestAudio(playerResponse, preferredContainer = 'auto') {
  const formats = (playerResponse?.streamingData?.adaptiveFormats ?? [])
    .filter((format) => format.mimeType?.startsWith('audio/') && (format.url || format.signatureCipher || format.cipher));
  if (!formats.length) throw new ResolverError('NO_AUDIO_FORMAT', 'audio-only formatがありません。');
  return [...formats].sort((a, b) => {
    const drcScore = Number(Boolean(a.isDrc)) - Number(Boolean(b.isDrc));
    if (drcScore) return drcScore;
    if (preferredContainer === 'webm' || preferredContainer === 'mp4') {
      const mimePrefix = `audio/${preferredContainer}`;
      const preferredScore = Number(!a.mimeType?.startsWith(mimePrefix))
        - Number(!b.mimeType?.startsWith(mimePrefix));
      if (preferredScore) return preferredScore;
    }
    const webmScore = Number(!a.mimeType?.startsWith('audio/webm'))
      - Number(!b.mimeType?.startsWith('audio/webm'));
    if (webmScore) return webmScore;
    if (a.mimeType?.startsWith('audio/mp4') && b.mimeType?.startsWith('audio/mp4')) {
      return (b.averageBitrate ?? b.bitrate ?? 0) - (a.averageBitrate ?? a.bitrate ?? 0);
    }
    return (b.averageBitrate ?? b.bitrate ?? 0) - (a.averageBitrate ?? a.bitrate ?? 0);
  })[0];
}

export function selectBestVideo(playerResponse) {
  const formats = (playerResponse?.streamingData?.formats ?? [])
    .filter((format) => format.mimeType?.startsWith('video/')
      && (format.audioQuality || format.audioChannels)
      && (format.url || format.signatureCipher || format.cipher));
  if (!formats.length) throw new ResolverError('NO_VIDEO_FORMAT', '音声付き動画formatがありません。');
  return [...formats].sort((a, b) => {
    const mp4Score = Number(!a.mimeType?.startsWith('video/mp4'))
      - Number(!b.mimeType?.startsWith('video/mp4'));
    if (mp4Score) return mp4Score;
    const aHeight = a.height ?? 0;
    const bHeight = b.height ?? 0;
    const boundedScore = Number(aHeight > 720) - Number(bHeight > 720);
    if (boundedScore) return boundedScore;
    return bHeight - aHeight || (b.bitrate ?? 0) - (a.bitrate ?? 0);
  })[0];
}

function selectBestMedia(playerResponse, mediaType, preferredAudioContainer = 'auto') {
  return mediaType === 'video'
    ? selectBestVideo(playerResponse)
    : selectBestAudio(playerResponse, preferredAudioContainer);
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

async function fetchInnerTubeResponse(videoId, diagnostics, integrity, mediaType) {
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
        context: {
          client: {
            hl: 'en',
            gl: 'US',
            clientName: client.name,
            clientVersion: client.version,
            userAgent: client.userAgent,
            ...(integrity?.visitorData ? { visitorData: integrity.visitorData } : {}),
            ...client.extra,
          },
          ...(client.embedUrl ? { thirdParty: { embedUrl: client.embedUrl } } : {}),
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
        ...(integrity?.playerPoToken
          ? { serviceIntegrityDimensions: { poToken: integrity.playerPoToken } }
          : {}),
      }),
    });
    let result = {};
    try { result = await response.json(); } catch { /* Record the empty response below. */ }
    const audioFormats = (result?.streamingData?.adaptiveFormats ?? [])
      .filter((format) => format.mimeType?.startsWith('audio/'));
    const usableAudioFormats = audioFormats
      .filter((format) => format.url || format.signatureCipher || format.cipher);
    const videoFormats = (result?.streamingData?.formats ?? [])
      .filter((format) => format.mimeType?.startsWith('video/') && (format.audioQuality || format.audioChannels));
    const usableVideoFormats = videoFormats
      .filter((format) => format.url || format.signatureCipher || format.cipher);
    diagnostics.innerTube.push({
      client: client.name,
      status: response.status,
      playability: result?.playabilityStatus?.status ?? null,
      reason: result?.playabilityStatus?.reason ?? null,
      audioFormats: audioFormats.length,
      usableAudioFormats: usableAudioFormats.length,
      videoFormats: videoFormats.length,
      usableVideoFormats: usableVideoFormats.length,
    });
    if (mediaType === 'video' ? usableVideoFormats.length > 0 : usableAudioFormats.length > 0) return result;
  }
  return null;
}

async function fetchPoTokens(
  videoId,
  renderDecipherUrl,
  decipherToken,
  decipherSigningPrivateJwk,
  diagnostics,
) {
  const poTokenUrl = new URL(renderDecipherUrl);
  poTokenUrl.pathname = '/api/pot';
  poTokenUrl.search = '';
  const body = JSON.stringify({ videoId });
  const signatureHeaders = decipherToken
    ? {}
    : await signedInternalHeaders(poTokenUrl, body, decipherSigningPrivateJwk);
  const response = await fetch(poTokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(decipherToken ? { Authorization: `Bearer ${decipherToken}` } : {}),
      ...signatureHeaders,
    },
    body,
  });
  let result = {};
  try { result = await response.json(); } catch { /* Normalize below. */ }
  diagnostics.poToken = {
    status: response.status,
    gvs: Boolean(result.poToken),
    player: Boolean(result.playerPoToken),
    visitorData: Boolean(result.visitorData),
  };
  if (!response.ok || !result.poToken || !result.playerPoToken || !result.visitorData) {
    throw new ResolverError('PO_TOKEN_FAILED', result.error || `PO Token APIがHTTP ${response.status}を返しました。`, diagnostics);
  }
  return result;
}

async function fetchFallbackPlayerId() {
  const response = await fetch('https://www.youtube.com/iframe_api', {
    headers: { 'User-Agent': MOBILE_USER_AGENT, 'Cache-Control': 'no-cache' },
  });
  return playerIdFrom(await response.text());
}

function safeContentType(value, mediaType) {
  const expected = mediaType === 'video' ? /^video\//i : /^audio\//i;
  return value && expected.test(value) ? value : 'application/octet-stream';
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

export async function resolveAndFetchMedia({
  videoId,
  mediaType = 'audio',
  audioContainer = 'auto',
  renderDecipherUrl,
  decipherToken,
  decipherSigningPrivateJwk,
  range,
  cachedResolution = null,
}) {
  const startedAt = Date.now();
  const diagnostics = { videoId, mediaType };
  let resolution = cachedResolution;
  if (!resolution) {
    const integrity = await fetchPoTokens(
      videoId,
      renderDecipherUrl,
      decipherToken,
      decipherSigningPrivateJwk,
      diagnostics,
    );
    const watch = await fetchWatchResponse(videoId, diagnostics);
    // PO TokenとVisitor IDを付けたInnerTube応答を優先する。watchページ由来の
    // URLは別Visitorへ結び付くことがあり、同じTokenを付けても403になる。
    let playerResponse = await fetchInnerTubeResponse(videoId, diagnostics, integrity, mediaType);
    if (!playerResponse) {
      playerResponse = watch.playerResponse;
      try { selectBestMedia(playerResponse, mediaType, audioContainer); } catch { playerResponse = null; }
    }
    if (!playerResponse) {
      const status = diagnostics.watch?.playability || diagnostics.innerTube?.at(-1)?.playability || 'UNPLAYABLE';
      throw new ResolverError(status, 'この実行地域では再生可能な応答を取得できませんでした。', diagnostics);
    }

    const format = selectBestMedia(playerResponse, mediaType, audioContainer);
    const playerId = playerIdFrom(playerResponse?.assets?.js) || watch.playerId || await fetchFallbackPlayerId();
    diagnostics.format = {
      itag: format.itag ?? null,
      mimeType: format.mimeType ?? null,
      bitrate: format.averageBitrate ?? format.bitrate ?? null,
      width: format.width ?? null,
      height: format.height ?? null,
      requestedContainer: mediaType === 'audio' ? audioContainer : null,
    };

    let deciphered = {};
    let directStreamUrl = null;
    try { directStreamUrl = format.url ? new URL(format.url) : null; } catch { /* Use the decipher service below. */ }
    if (directStreamUrl && !directStreamUrl.searchParams.get('n')
        && !format.signatureCipher && !format.cipher) {
      deciphered = { url: format.url, nChanged: false };
      diagnostics.decipher = { status: 200, nChanged: false, bypassed: true };
    } else {
      const decipherBody = JSON.stringify({
        ...(playerId ? { playerId } : {}),
        ...(format.url ? { url: format.url } : {}),
        ...(format.signatureCipher ? { signatureCipher: format.signatureCipher } : {}),
        ...(format.cipher ? { cipher: format.cipher } : {}),
      });
      const signatureHeaders = decipherToken
        ? {}
        : await signedInternalHeaders(
          renderDecipherUrl,
          decipherBody,
          decipherSigningPrivateJwk,
        );
      const decipherResponse = await fetch(renderDecipherUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(decipherToken ? { Authorization: `Bearer ${decipherToken}` } : {}),
          ...signatureHeaders,
        },
        body: decipherBody,
      });
      try { deciphered = await decipherResponse.json(); } catch { /* Normalize below. */ }
      diagnostics.decipher = { status: decipherResponse.status, nChanged: deciphered.nChanged ?? null };
      if (!decipherResponse.ok || !deciphered.url) {
        throw new ResolverError('DECIPHER_FAILED', deciphered.error || `変換APIがHTTP ${decipherResponse.status}を返しました。`, diagnostics);
      }
    }
    const resolvedStreamUrl = new URL(deciphered.url);
    const cpn = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    let totalBytes = Number(format.contentLength || resolvedStreamUrl.searchParams.get('clen'));
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      const lengthProbeUrl = new URL(resolvedStreamUrl);
      lengthProbeUrl.searchParams.set('pot', integrity.poToken);
      lengthProbeUrl.searchParams.append('cpn', cpn);
      const lengthProbe = await fetch(lengthProbeUrl, {
        headers: googleVideoHeaders('bytes=0-0'),
        redirect: 'follow',
      });
      const probedRange = parseContentRange(lengthProbe.headers.get('content-range'));
      diagnostics.lengthProbe = {
        status: lengthProbe.status,
        contentLength: lengthProbe.headers.get('content-length'),
        contentRange: lengthProbe.headers.get('content-range'),
      };
      await lengthProbe.body?.cancel();
      if (lengthProbe.status === 206 && probedRange) totalBytes = probedRange.total;
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new ResolverError('NO_CONTENT_LENGTH', 'メディアストリームの全体サイズを取得できませんでした。', diagnostics);
    }
    resolution = {
      streamUrl: deciphered.url,
      format: diagnostics.format,
      totalBytes,
      cpn,
      poToken: integrity.poToken,
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
  streamUrl.searchParams.set('pot', resolution.poToken);
  if (requestedBytes) {
    // 既存値は署名対象になり得るため置換しない。YouTube.jsと同様に末尾へ追加し、
    // GoogleVideoに最後のrangeを実際の取得区間として解釈させる。
    streamUrl.searchParams.append('cpn', resolution.cpn);
    streamUrl.searchParams.append('range', `${requestedBytes[1]}-${requestedBytes[2]}`);
  }
  diagnostics.streamRequest = {
    client: streamUrl.searchParams.get('c'),
    originalRanges: new URL(resolution.streamUrl).searchParams.getAll('range'),
    effectiveRanges: streamUrl.searchParams.getAll('range'),
    cpnCount: streamUrl.searchParams.getAll('cpn').length,
    rn: streamUrl.searchParams.get('rn'),
    rbuf: streamUrl.searchParams.get('rbuf'),
  };
  let streamResponse = await fetch(streamUrl, {
    // YouTube.jsも分割取得ではHTTP Rangeを送らず、URLのrangeだけを使う。
    headers: googleVideoHeaders(requestedBytes ? null : range),
    redirect: 'follow',
  });
  const streamAttempts = [{
    mode: requestedBytes ? 'query-range' : 'http-range',
    status: streamResponse.status,
    contentLength: streamResponse.headers.get('content-length'),
    contentRange: streamResponse.headers.get('content-range'),
  }];
  // 配信URLによってはqueryのrangeが403になる一方、標準のHTTP Rangeは通る。
  // 失敗時だけ、元URLからrangeクエリを除いてHTTP Rangeで取り直す。
  if (!streamResponse.ok && requestedBytes) {
    await streamResponse.body?.cancel();
    const headerRangeUrl = new URL(resolution.streamUrl);
    headerRangeUrl.searchParams.delete('range');
    headerRangeUrl.searchParams.set('pot', resolution.poToken);
    headerRangeUrl.searchParams.append('cpn', resolution.cpn);
    streamResponse = await fetch(headerRangeUrl, {
      headers: googleVideoHeaders(range),
      redirect: 'follow',
    });
    streamAttempts.push({
      mode: 'http-range-fallback',
      status: streamResponse.status,
      contentLength: streamResponse.headers.get('content-length'),
      contentRange: streamResponse.headers.get('content-range'),
    });
  }
  diagnostics.googlevideo = {
    status: streamResponse.status,
    contentType: streamResponse.headers.get('content-type'),
    contentLength: streamResponse.headers.get('content-length'),
    contentRange: streamResponse.headers.get('content-range'),
    attempts: streamAttempts,
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
    contentType: safeContentType(streamResponse.headers.get('content-type'), mediaType),
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
