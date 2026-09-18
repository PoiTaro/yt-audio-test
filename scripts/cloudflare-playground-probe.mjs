import { randomUUID } from 'node:crypto';

const VIDEO_ID = process.argv[2] ?? 'jNQXAC9IVRw';
const DECIPHER_URL = process.argv[3] ?? 'https://yt-audio-test.onrender.com/api/decipher';
const REPLICAS = Math.max(1, Math.min(8, Number(process.argv[4] ?? 1) || 1));
const DECIPHER_TOKEN = process.argv[5] ?? '';
const PLAYGROUND_URL = 'https://workers.cloudflare.com/playground';
const WORKER_API_URL = `${PLAYGROUND_URL}/api/worker`;

const workerSource = String.raw`
const VIDEO_ID = ${JSON.stringify(VIDEO_ID)};
const DECIPHER_URL = ${JSON.stringify(DECIPHER_URL)};
const DECIPHER_TOKEN = ${JSON.stringify(DECIPHER_TOKEN)};
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const USER_AGENTS = [
  MOBILE_UA,
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
];
const WATCH_VARIANTS = [
  { name: 'www-watch', url: 'https://www.youtube.com/watch?v=' + VIDEO_ID + '&hl=en&gl=US&has_verified=1&bpctr=9999999999' },
  { name: 'm-watch', url: 'https://m.youtube.com/watch?v=' + VIDEO_ID + '&hl=en&gl=US' },
  { name: 'www-embed', url: 'https://www.youtube.com/embed/' + VIDEO_ID + '?hl=en' },
  { name: 'nocookie-embed', url: 'https://www.youtube-nocookie.com/embed/' + VIDEO_ID + '?hl=en' },
  { name: 'music-watch', url: 'https://music.youtube.com/watch?v=' + VIDEO_ID + '&hl=en&gl=US' }
];
const INNERTUBE_CLIENTS = [
  {
    name: 'ANDROID_VR', id: '28', version: '1.65.10',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    extra: { androidSdkVersion: 32, osName: 'Android', osVersion: '12L', platform: 'MOBILE', deviceMake: 'Oculus', deviceModel: 'Quest 3' }
  },
  {
    name: 'iOS', id: '5', version: '20.11.6',
    userAgent: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)',
    extra: { osName: 'iOS', osVersion: '16.7.7.20H330', platform: 'MOBILE', deviceMake: 'Apple', deviceModel: 'iPhone10,4' }
  },
  {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', id: '85', version: '2.0',
    userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
    extra: { clientScreen: 'EMBED' }, thirdParty: { embedUrl: 'https://www.youtube.com/' }
  },
  {
    name: 'WEB_EMBEDDED_PLAYER', id: '56', version: '1.20260206.01.00',
    userAgent: USER_AGENTS[2], extra: { clientScreen: 'EMBED' }, thirdParty: { embedUrl: 'https://www.google.com/' }
  }
];
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

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
    const diagnostics = { videoId: VIDEO_ID, watchAttempts: [] };
    try {
      let html;
      let playerResponse;
      let discoveredPlayerId;
      for (let attempt = 0; attempt < WATCH_VARIANTS.length; attempt += 1) {
        const variant = WATCH_VARIANTS[attempt];
        const watchUrl = variant.url + '&probe=' + crypto.randomUUID();
        const watchResponse = await fetch(watchUrl, {
          headers: {
            'User-Agent': USER_AGENTS[attempt % USER_AGENTS.length],
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache'
          }
        });
        const candidateHtml = await watchResponse.text();
        html = candidateHtml;
        discoveredPlayerId ||= candidateHtml.match(/\/s\/player\/([A-Za-z0-9_-]+)\//)?.[1];
        let candidateResponse;
        try { candidateResponse = extractPlayerResponse(candidateHtml); } catch {}
        const candidateFormats = candidateResponse?.streamingData?.adaptiveFormats ?? [];
        diagnostics.watchAttempts.push({
          variant: variant.name,
          status: watchResponse.status,
          bytes: candidateHtml.length,
          playability: candidateResponse?.playabilityStatus?.status ?? null,
          formats: candidateFormats.length
        });
        if (candidateFormats.some((format) => format.mimeType?.startsWith('audio/'))) {
          html = candidateHtml;
          playerResponse = candidateResponse;
          diagnostics.selectedVariant = variant.name;
          break;
        }
      }
      if (!playerResponse) {
        diagnostics.innerTubeAttempts = [];
        for (const client of INNERTUBE_CLIENTS) {
          const clientContext = {
            hl: 'en', gl: 'US', clientName: client.name, clientVersion: client.version,
            userAgent: client.userAgent, ...client.extra
          };
          const innerResponse = await fetch(
            'https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=' + INNERTUBE_API_KEY,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': client.userAgent,
                'X-Youtube-Client-Name': client.id,
                'X-Youtube-Client-Version': client.version,
                'Origin': 'https://www.youtube.com'
              },
              body: JSON.stringify({
                context: { client: clientContext, ...(client.thirdParty ? { thirdParty: client.thirdParty } : {}) },
                videoId: VIDEO_ID,
                contentCheckOk: true,
                racyCheckOk: true,
                playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } }
              })
            }
          );
          let innerJson;
          try { innerJson = await innerResponse.json(); } catch { innerJson = {}; }
          const innerFormats = innerJson?.streamingData?.adaptiveFormats ?? [];
          diagnostics.innerTubeAttempts.push({
            client: client.name,
            status: innerResponse.status,
            playability: innerJson?.playabilityStatus?.status ?? null,
            formats: innerFormats.length,
            audioFormats: innerFormats.filter((format) => format.mimeType?.startsWith('audio/')).length
          });
          if (innerFormats.some((format) => format.mimeType?.startsWith('audio/'))) {
            playerResponse = innerJson;
            diagnostics.selectedVariant = 'innertube-' + client.name;
            break;
          }
        }
      }
      if (!playerResponse) throw new Error('No playable response across watch hosts or InnerTube clients');
      diagnostics.watch = diagnostics.watchAttempts.at(-1);
      diagnostics.playability = playerResponse?.playabilityStatus?.status ?? null;
      const format = chooseAudio(playerResponse);
      diagnostics.format = { itag: format.itag, mimeType: format.mimeType, bitrate: format.bitrate };
      const playerId = playerResponse?.assets?.js?.match(/\/s\/player\/([A-Za-z0-9_-]+)\//)?.[1]
        || discoveredPlayerId
        || html?.match(/\/s\/player\/([A-Za-z0-9_-]+)\//)?.[1];
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
        headers: {
          'Content-Type': 'application/json',
          ...(DECIPHER_TOKEN ? { Authorization: 'Bearer ' + DECIPHER_TOKEN } : {})
        },
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

async function runReplica(index) {
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
    throw new Error(`Worker ${index} upload failed (${createResponse.status}): ${createText.slice(0, 2000)}`);
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
    throw new Error(`Worker ${index} invocation failed (${invokeResponse.status}): ${resultText.slice(0, 2000)}`);
  }
  return JSON.parse(resultText);
}

const results = await Promise.all(Array.from({ length: REPLICAS }, (_, index) => runReplica(index + 1)));
const output = REPLICAS === 1 ? results[0] : {
  replicas: REPLICAS,
  successes: results.filter((result) => result.success).length,
  anySuccess: results.some((result) => result.success),
  results,
};
console.log(JSON.stringify(output, null, 2));
