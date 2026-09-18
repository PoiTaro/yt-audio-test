import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildSummary, createResolver, extractVideoId, probeClient } from './core.js';

const port = Number(process.env.PORT || 10000);
const clients = ['ANDROID_VR', 'IOS'];
const inputs = (process.env.TEST_VIDEO_IDS || 'M7lc1UVf-VE,aqz-KE-bpKQ,jNQXAC9IVRw')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const outputDirectory = path.join(os.tmpdir(), 'youtube-audio-stream-probe');

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
    poToken: false,
  },
  progress: { completedAttempts: 0, totalAttempts: inputs.length * clients.length },
  results: [],
  summary: null,
  error: null,
};

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
<p>RenderのデータセンターIPから、固定3動画をANDROID_VR／IOSで検証します。Cookie・ログイン・PO Token・yt-dlpは使用しません。</p>
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
    const youtube = await createResolver(path.join(outputDirectory, '.cache'));
    for (const input of inputs) {
      const videoId = extractVideoId(input);
      const entry = { input, videoId, attempts: [] };
      for (const client of clients) {
        const attempt = await probeClient({
          youtube,
          videoId,
          client,
          outputDirectory,
          seconds: 10,
          log: (message) => console.log(`[${videoId}][${client}] ${message}`),
        });
        entry.attempts.push(sanitizeAttempt(attempt));
        state.progress.completedAttempts += 1;
      }
      state.results.push(entry);
    }
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
