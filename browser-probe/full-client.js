import { ClientType, Constants, Innertube, UniversalCache } from '/youtubei.js';

const statusNode = document.querySelector('#status');

function update(value) {
  statusNode.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function waitForBridge(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (window.ytcBridge?.installed && typeof window.proxyFetch === 'function') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('ytc-bridge extension was not detected');
}

async function bridgeFetch(input, init = {}) {
  const request = new Request(input, init);
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  let body;
  if (!['GET', 'HEAD'].includes(request.method)) body = await request.clone().arrayBuffer();
  const proxied = await window.proxyFetch(request.url, {
    method: request.method,
    headers,
    body,
  });
  const contentType = proxied.headers.get('content-type') || '';
  let responseBody;
  if (contentType.includes('application/json')) {
    responseBody = JSON.stringify(await proxied.json());
  } else if (contentType.includes('text/') || contentType.includes('javascript')) {
    responseBody = await proxied.text();
  } else {
    responseBody = await proxied.arrayBuffer();
  }
  if (!proxied.ok) {
    const detail = typeof responseBody === 'string' ? responseBody.slice(0, 300) : '';
    throw new Error(`Proxy ${request.method} ${new URL(request.url).pathname} returned HTTP ${proxied.status}: ${detail}`);
  }
  return new Response(responseBody, {
    status: proxied.status,
    statusText: proxied.statusText,
    headers: proxied.headers,
  });
}

function bestAudio(formats) {
  return formats
    .filter((format) => format.has_audio && !format.has_video)
    .sort((a, b) => (b.average_bitrate ?? b.bitrate ?? 0) - (a.average_bitrate ?? a.bitrate ?? 0))[0];
}

async function report(result) {
  update(result);
  await fetch('/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
}

async function run() {
  await waitForBridge();
  update('extension detected; resolving through browser-side InnerTube...');
  const clients = [
    ['WEB', ClientType.WEB],
    ['MWEB', ClientType.MWEB],
    ['ANDROID_VR', ClientType.ANDROID_VR],
    ['IOS', ClientType.IOS],
    ['TV', ClientType.TV],
    ['WEB_EMBEDDED', ClientType.WEB_EMBEDDED],
    ['TV_EMBEDDED', ClientType.TV_EMBEDDED],
    ['YTMUSIC', ClientType.MUSIC],
  ];
  const failures = [];
  let youtube;
  let info;
  let client;
  let format;
  let streamUrl;
  for (const [name, clientType] of clients) {
    try {
      update(`trying browser-side InnerTube client: ${name}`);
      const candidate = await Innertube.create({
        cache: new UniversalCache(true),
        client_type: clientType,
        generate_session_locally: name !== 'WEB',
        enable_session_cache: false,
        fetch: bridgeFetch,
      });
      const candidateInfo = await candidate.getBasicInfo('jNQXAC9IVRw');
      const status = candidateInfo.playability_status?.status ?? null;
      if (status !== 'OK') throw new Error(candidateInfo.playability_status?.reason || status || 'Player failed');
      const candidateFormat = bestAudio(candidateInfo.streaming_data?.adaptive_formats ?? []);
      if (!candidateFormat) throw new Error('No audio-only format');
      const candidateUrl = await candidateFormat.decipher(candidate.session.player);
      youtube = candidate;
      info = candidateInfo;
      client = name;
      format = candidateFormat;
      streamUrl = candidateUrl;
      break;
    } catch (error) {
      failures.push({ client: name, error: error.message });
    }
  }
  if (!info) throw new Error(JSON.stringify(failures));
  const playability = info.playability_status?.status ?? null;

  update('audio URL resolved; fetching first 8 KiB through extension...');
  const response = await window.proxyFetch(streamUrl, {
    method: 'GET',
    headers: { ...Constants.STREAM_HEADERS, range: 'bytes=0-8191' },
  });
  const data = await response.arrayBuffer();
  await report({
    success: response.ok && data.byteLength > 0,
    extensionDetected: true,
    browserResolved: true,
    client,
    playability,
    status: response.status,
    bytes: data.byteLength,
    contentType: response.headers.get('content-type'),
    itag: format.itag,
    codec: /codecs="([^"]+)"/.exec(format.mime_type ?? '')?.[1] ?? null,
  });
}

run().catch((error) => report({
  success: false,
  extensionDetected: Boolean(window.ytcBridge?.installed),
  browserResolved: false,
  error: error.message,
}));
