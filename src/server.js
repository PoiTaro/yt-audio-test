import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Platform } from 'youtubei.js';
import { buildSummary, classifyError, createResolver, extractVideoId, probeClient, probeHttp, runFfmpeg } from './core.js';
import { extractInitialPlayerResponse, selectHtmlAudioFormat } from './html.js';
import { createWebPoMinter } from './pot.js';

Platform.shim.eval = async (data) => new Function(data.output)();

const port = Number(process.env.PORT || 10000);
const clients = (process.env.TEST_CLIENTS || 'ANDROID_VR,IOS,WEB,MWEB,ANDROID,TV,TV_SIMPLY,TV_EMBEDDED,WEB_EMBEDDED,VISIONOS,YTMUSIC,YTMUSIC_ANDROID,YTKIDS,WEB_CREATOR,YTSTUDIO_ANDROID')
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const inputs = (process.env.TEST_VIDEO_IDS || 'M7lc1UVf-VE,aqz-KE-bpKQ,jNQXAC9IVRw')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const outputDirectory = path.join(os.tmpdir(), 'youtube-audio-stream-probe');
const sessionMode = process.env.SESSION_MODE || 'dedicated';
const generateSessionLocally = process.env.GENERATE_SESSION_LOCALLY === 'true';
const poTokenMode = process.env.PO_TOKEN_MODE || 'none';
const sessionTokenUrl = process.env.SESSION_TOKEN_URL || '';

const state = {
  status: 'starting',
  startedAt: new Date().toISOString(),
  completedAt: null,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    render: Boolean(process.env.RENDER),
    renderServiceName: process.env.RENDER_SERVICE_NAME || null,
    renderRegion: process.env.RENDER_REGION || null,
    renderInstanceId: process.env.RENDER_INSTANCE_ID || null,
  },
  options: {
    videos: inputs,
    clients,
    seconds: 10,
    cookie: false,
    login: false,
    poToken: poTokenMode === 'webpo',
    poTokenMode,
    trustedSession: Boolean(sessionTokenUrl),
    sessionMode,
    generateSessionLocally,
  },
  progress: { completedAttempts: 0, totalAttempts: inputs.length * clients.length },
  results: [],
  htmlProbe: null,
  summary: null,
  error: null,
};

async function runWatchPageProbe(videoId) {
  const result = {
    videoId,
    watchPageStatus: null,
    watchPageBytes: 0,
    playability: null,
    formats: 0,
    selectedFormat: null,
    deciphered: false,
    googlevideo: null,
    ffmpeg: null,
    success: false,
    error: null,
  };
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36',
        'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(20_000),
    });
    const html = await response.text();
    result.watchPageStatus = response.status;
    result.watchPageBytes = Buffer.byteLength(html);
    const playerResponse = extractInitialPlayerResponse(html);
    result.playability = {
      status: playerResponse.playabilityStatus?.status ?? null,
      reason: playerResponse.playabilityStatus?.reason ?? null,
    };
    if (result.playability.status !== 'OK') {
      const error = new Error(result.playability.reason || `Playability: ${result.playability.status}`);
      error.code = result.playability.status || 'UNPLAYABLE';
      throw error;
    }
    const format = selectHtmlAudioFormat(playerResponse);
    result.formats = playerResponse.streamingData?.adaptiveFormats?.length ?? 0;
    result.selectedFormat = {
      itag: format.itag,
      mime: format.mimeType,
      bitrate: format.averageBitrate ?? format.bitrate ?? null,
    };
    const resolver = await createResolver(path.join(outputDirectory, '.cache', 'watch-page'), {
      generateSessionLocally: true,
      enableSessionCache: false,
    });
    const streamUrl = await resolver.session.player.decipher(format.url, format.signatureCipher, format.cipher);
    result.deciphered = Boolean(streamUrl);
    result.googlevideo = await probeHttp(streamUrl, 20_000);
    if (!result.googlevideo.success) throw Object.assign(new Error(result.googlevideo.error?.message || 'GoogleVideo probe failed'), result.googlevideo.error);
    result.ffmpeg = await runFfmpeg(
      streamUrl,
      path.join(outputDirectory, `${videoId}_HTML_3s.wav`),
      3,
      45_000,
      result.selectedFormat.bitrate ?? 192_000,
    );
    if (!result.ffmpeg.success) throw Object.assign(new Error(result.ffmpeg.error?.message || 'FFmpeg failed'), result.ffmpeg.error);
    result.success = true;
  } catch (error) {
    result.error = classifyError(error);
  }
  if (result.ffmpeg) {
    const { outputFile: _outputFile, stderr: _stderr, ...safeFfmpeg } = result.ffmpeg;
    result.ffmpeg = safeFfmpeg;
  }
  return result;
}

function sanitizeAttempt(attempt) {
  const { streamUrl: _streamUrl, ...safe } = attempt;
  if (safe.ffmpeg) {
    const { outputFile: _outputFile, stderr: _stderr, ...safeFfmpeg } = safe.ffmpeg;
    safe.ffmpeg = safeFfmpeg;
  }
  return safe;
}

function jsonResponse(response, statusCode, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function htmlResponse(response) {
  const body = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>YouTube Audio Stream Probe</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.65}code{background:#eee;padding:.2em .4em;border-radius:4px}.ok{color:#087f23}.run{color:#9a6700}.ng{color:#c62828}</style></head>
<body><h1>YouTube Audio Stream Probe</h1>
<p>Status: <strong class="${state.status === 'complete' ? 'ok' : state.status === 'error' ? 'ng' : 'run'}">${state.status}</strong></p>
<p>RenderのデータセンターIPから、固定動画を複数のInnerTubeクライアントで検証します。Cookie・ログイン・yt-dlpは使用しません。PO Token: <code>${poTokenMode}</code></p>
<ul><li><a href="/health">/health</a></li><li><a href="/report">/report</a></li></ul>
</body></html>`;
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method !== 'GET') return jsonResponse(response, 405, { error: 'Method not allowed' });
  if (url.pathname === '/health') {
    return jsonResponse(response, 200, {
      status: state.status,
      progress: state.progress,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    });
  }
  if (url.pathname === '/report') return jsonResponse(response, state.status === 'running' ? 202 : 200, state);
  if (url.pathname === '/') return htmlResponse(response);
  return jsonResponse(response, 404, { error: 'Not found' });
});

async function runValidation() {
  state.status = 'running';
  console.log(`Starting ${state.progress.totalAttempts} Render validation attempts`);
  try {
    const poMinter = poTokenMode === 'webpo' ? await createWebPoMinter() : null;
    let trustedSession = null;
    if (sessionTokenUrl) {
      const deadline = Date.now() + 9 * 60_000;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(sessionTokenUrl, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error(`Session token server returned HTTP ${response.status}`);
          const value = await response.json();
          const sessionPoToken = value.po_token || value.potoken;
          if (!sessionPoToken || !value.visitor_data) throw new Error('Session token response was incomplete');
          trustedSession = { poToken: sessionPoToken, visitorData: value.visitor_data };
          console.log('Trusted session token and visitor data: OK');
          break;
        } catch (error) {
          lastError = error;
          console.log(`Waiting for trusted session generator: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
      if (!trustedSession) throw lastError || new Error('Trusted session generator timed out');
    }
    let sharedYoutube = null;
    const dedicatedSessions = new Map();
    if (sessionMode === 'override') {
      sharedYoutube = await createResolver(path.join(outputDirectory, '.cache', 'shared'), {
        generateSessionLocally,
        enableSessionCache: false,
        visitorData: trustedSession?.visitorData,
        poToken: trustedSession?.poToken,
      });
    }
    for (const input of inputs) {
      const videoId = extractVideoId(input);
      const poToken = poMinter ? await poMinter.mintAsWebsafeString(videoId) : null;
      const entry = { input, videoId, attempts: [] };
      for (const client of clients) {
        let attempt;
        try {
          let youtube = sharedYoutube;
          if (sessionMode === 'dedicated') {
            if (!dedicatedSessions.has(client)) {
              dedicatedSessions.set(client, await createResolver(path.join(outputDirectory, '.cache', client), {
                client,
              generateSessionLocally,
              enableSessionCache: false,
              visitorData: trustedSession?.visitorData,
              poToken: trustedSession?.poToken,
            }));
            }
            youtube = dedicatedSessions.get(client);
          }
          attempt = await probeClient({
            youtube,
            videoId,
            client,
            outputDirectory,
            seconds: 10,
            requestClientOverride: sessionMode !== 'dedicated',
            poToken: poToken || trustedSession?.poToken || null,
            log: (message) => console.log(`[${videoId}][${client}] ${message}`),
          });
        } catch (error) {
          const classified = classifyError(error);
          console.error(`[${videoId}][${client}] Session failure: ${classified.code} - ${classified.message}`);
          attempt = {
            client,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            success: false,
            metadataSuccess: false,
            streamUrlSuccess: false,
            googlevideoSuccess: null,
            ffmpegSuccess: null,
            playability: null,
            video: null,
            formats: [],
            selectedFormat: null,
            streamExpiry: null,
            http: null,
            ffmpeg: null,
            error: classified,
          };
        }
        entry.attempts.push(sanitizeAttempt(attempt));
        state.progress.completedAttempts += 1;
      }
      state.results.push(entry);
    }
    state.htmlProbe = await runWatchPageProbe('jNQXAC9IVRw');
    state.summary = buildSummary(state.results);
    state.status = 'complete';
    console.log(`Validation complete: ${state.summary.fullSuccess.successes}/${state.summary.fullSuccess.total}`);
  } catch (error) {
    state.status = 'error';
    state.error = { name: error?.name || 'Error', message: error?.message || String(error) };
    console.error(error?.stack || error);
  } finally {
    state.completedAt = new Date().toISOString();
  }
}

server.listen(port, '0.0.0.0', () => {
  console.log(`Listening on 0.0.0.0:${port}`);
  runValidation();
});
