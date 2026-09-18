import { randomUUID } from 'node:crypto';

const VIDEO_ID = process.argv[2] ?? 'jNQXAC9IVRw';
const DECIPHER_URL = process.argv[3] ?? 'https://yt-audio-test.onrender.com/api/decipher';
const PLAYGROUND_URL = 'https://workers.cloudflare.com/playground';
const WORKER_API_URL = `${PLAYGROUND_URL}/api/worker`;

const workerSource = String.raw`
const VIDEO_ID = ${JSON.stringify(VIDEO_ID)};
const DECIPHER_URL = ${JSON.stringify(DECIPHER_URL)};
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';

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
  throw new Error('Unterminated player response JSON');
}

function extractPlayerResponse(html) {
  const marker = 'var ytInitialPlayerResponse = ';
  let position = html.lastIndexOf(marker);
  while (position >= 0) {
    const start = html.indexOf('{', position + marker.length);
    if (start >= 0 && start - position < marker.length + 32) {
      try { return parseJsonObjectAt(html, start); } catch {}
    }
    position = html.lastIndexOf(marker, position - 1);
  }
  throw new Error('ytInitialPlayerResponse not found');
}

function chooseAudio(response) {
  const formats = (response?.streamingData?.adaptiveFormats ?? [])
    .filter((format) => format.mimeType?.startsWith('audio/') && (format.url || format.signatureCipher || format.cipher))
    .sort((a, b) => (b.averageBitrate ?? b.bitrate ?? 0) - (a.averageBitrate ?? a.bitrate ?? 0));
  if (!formats.length) throw new Error('No audio-only formats');
  return formats[0];
}

export default {
  async fetch() {
    const diagnostics = { videoId: VIDEO_ID };
    try {
      const watchResponse = await fetch('https://www.youtube.com/watch?v=' + VIDEO_ID, {
        headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'en-US,en;q=0.9' }
      });
      const html = await watchResponse.text();
      diagnostics.watch = { status: watchResponse.status, bytes: html.length };
      const playerResponse = extractPlayerResponse(html);
      diagnostics.playability = playerResponse?.playabilityStatus?.status ?? null;
      const format = chooseAudio(playerResponse);
      diagnostics.format = { itag: format.itag, mimeType: format.mimeType, bitrate: format.bitrate };
      const playerId = html.match(/\/s\/player\/([A-Za-z0-9_-]+)\//)?.[1];
      if (!playerId) throw new Error('Player ID not found');
      diagnostics.playerId = playerId;

      const rawUrl = format.url || new URLSearchParams(format.signatureCipher || format.cipher).get('url');
      diagnostics.rawHasN = Boolean(rawUrl && new URL(rawUrl).searchParams.get('n'));
      if (rawUrl) {
        const rawStartedAt = Date.now();
        const rawResponse = await fetch(rawUrl, { headers: { Range: 'bytes=0-1048575' } });
        const rawBytes = await rawResponse.arrayBuffer();
        diagnostics.rawStream = {
          status: rawResponse.status,
          bytes: rawBytes.byteLength,
          elapsedMs: Date.now() - rawStartedAt,
          contentType: rawResponse.headers.get('content-type'),
          contentRange: rawResponse.headers.get('content-range')
        };
      }
      const decipherResponse = await fetch(DECIPHER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, url: rawUrl })
      });
      const decipherResult = await decipherResponse.json();
      diagnostics.decipher = {
        status: decipherResponse.status,
        nChanged: decipherResult.nChanged ?? null,
        error: decipherResult.error ?? null
      };
      if (!decipherResponse.ok || !decipherResult.url) throw new Error(decipherResult.error || 'Render decipher failed');
      const streamUrl = decipherResult.url;
      diagnostics.nChanged = rawUrl ? new URL(rawUrl).searchParams.get('n') !== new URL(streamUrl).searchParams.get('n') : null;

      const streamStartedAt = Date.now();
      const streamResponse = await fetch(streamUrl, { headers: { Range: 'bytes=0-1048575' } });
      const bytes = await streamResponse.arrayBuffer();
      diagnostics.stream = {
        status: streamResponse.status,
        bytes: bytes.byteLength,
        elapsedMs: Date.now() - streamStartedAt,
        contentType: streamResponse.headers.get('content-type'),
        contentRange: streamResponse.headers.get('content-range')
      };
      diagnostics.success = streamResponse.ok && bytes.byteLength > 0;
    } catch (error) {
      diagnostics.success = false;
      diagnostics.error = { name: error?.name, message: error?.message, stack: error?.stack?.split('\n').slice(0, 4) };
    }
    return Response.json(diagnostics, { headers: { 'Cache-Control': 'no-store' } });
  }
};
`;

const playgroundResponse = await fetch(PLAYGROUND_URL);
const cookies = (playgroundResponse.headers.getSetCookie?.() ?? [])
  .map((cookie) => cookie.split(';', 1)[0])
  .join('; ');
if (!playgroundResponse.ok || !cookies) {
  throw new Error(`Could not initialize Playground session (${playgroundResponse.status}).`);
}

const form = new FormData();
form.set('index.js', new Blob([workerSource], { type: 'application/javascript+module' }), 'index.js');
form.set('metadata', new Blob([JSON.stringify({
  main_module: 'index.js',
  compatibility_date: '2026-09-18'
})], { type: 'application/json' }));

const createResponse = await fetch(WORKER_API_URL, {
  method: 'POST',
  headers: {
    Cookie: cookies,
    Origin: 'https://workers.cloudflare.com',
    Referer: PLAYGROUND_URL
  },
  body: form
});
const createText = await createResponse.text();
if (!createResponse.ok) {
  throw new Error(`Worker upload failed (${createResponse.status}): ${createText.slice(0, 2000)}`);
}
const created = JSON.parse(createText);

const invokeResponse = await fetch(`https://${randomUUID()}.cloudflarepreviews.com/`, {
  method: 'POST',
  headers: {
    'X-CF-Token': created.preview,
    'cf-raw-http': 'true',
    'X-CF-HTTP-Method': 'GET'
  }
});
const resultText = await invokeResponse.text();
if (!invokeResponse.ok) {
  throw new Error(`Worker invocation failed (${invokeResponse.status}): ${resultText.slice(0, 2000)}`);
}
console.log(JSON.stringify(JSON.parse(resultText), null, 2));
