import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifyInternalSignature } from './internal-auth.js';

const host = process.env.INTERNAL_GATEWAY_HOST || '127.0.0.1';
const port = Number(process.env.INTERNAL_GATEWAY_PORT || 10001);
const helperTimeoutMs = Number(process.env.INTERNAL_HELPER_TIMEOUT_MS || 75_000);
const maxQueue = Number(process.env.INTERNAL_HELPER_MAX_QUEUE || 8);
const poCacheTtlMs = Number(process.env.INTERNAL_PO_CACHE_TTL_MS || 240_000);
const helperMaxOldSpaceMb = Number(process.env.INTERNAL_HELPER_MAX_OLD_SPACE_MB || 224);
const bearerToken = process.env.DECIPHER_TOKEN || '';
const cliPath = fileURLToPath(new URL('./internal-cli.js', import.meta.url));
const decipherWorkerPath = fileURLToPath(new URL('./decipher-worker.js', import.meta.url));
const signatureNonces = new Map();
const pending = [];
const poTokenCache = new Map();
const poTokenInFlight = new Map();
let active = false;
let decipherWorker = null;
let decipherWorkerBuffer = '';
let decipherWorkerNextId = 1;
const decipherWorkerRequests = new Map();

function jsonResponse(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readRawBody(request, maxBytes = 16_384) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bearerMatches(request) {
  if (!bearerToken) return false;
  const actual = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${bearerToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signedRequestMatches(request, rawBody, pathname) {
  const timestamp = request.headers['x-resolver-timestamp'];
  const nonce = request.headers['x-resolver-nonce'];
  const signature = request.headers['x-resolver-signature'];
  const valid = verifyInternalSignature({
    timestamp: typeof timestamp === 'string' ? timestamp : '',
    nonce: typeof nonce === 'string' ? nonce : '',
    pathname,
    rawBody,
    signature: typeof signature === 'string' ? signature : '',
  });
  if (!valid || signatureNonces.has(nonce)) return false;
  const nowSeconds = Math.floor(Date.now() / 1_000);
  for (const [seenNonce, seenAt] of signatureNonces) {
    if (nowSeconds - seenAt > 180) signatureNonces.delete(seenNonce);
  }
  signatureNonces.set(nonce, nowSeconds);
  return true;
}

function runChild(operation, rawBody) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${helperMaxOldSpaceMb}`, cliPath, operation], {
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Internal helper timed out'), { statusCode: 504 }));
    }, helperTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1_048_576) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_096);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
      try {
        const parsed = JSON.parse(lines.at(-1) || '');
        if (!parsed.ok) {
          reject(Object.assign(new Error(parsed.error || 'Internal helper failed'), {
            statusCode: Number(parsed.statusCode) || 502,
          }));
          return;
        }
        resolve(parsed.result);
      } catch (error) {
        console.error('Internal helper output was invalid', stderr || error?.message || error);
        reject(Object.assign(new Error('Internal helper returned an invalid response'), { statusCode: 502 }));
      }
    });
    child.stdin.end(rawBody);
  });
}

function rejectDecipherWorkerRequests(error) {
  for (const request of decipherWorkerRequests.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  decipherWorkerRequests.clear();
}

function ensureDecipherWorker() {
  if (decipherWorker && !decipherWorker.killed) return decipherWorker;
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${helperMaxOldSpaceMb}`, decipherWorkerPath],
    { env: { ...process.env, NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  decipherWorker = child;
  decipherWorkerBuffer = '';
  child.stdout.on('data', (chunk) => {
    decipherWorkerBuffer += chunk.toString('utf8');
    let newline = decipherWorkerBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = decipherWorkerBuffer.slice(0, newline).trim();
      decipherWorkerBuffer = decipherWorkerBuffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          const request = decipherWorkerRequests.get(message.id);
          if (request) {
            decipherWorkerRequests.delete(message.id);
            clearTimeout(request.timer);
            if (message.ok) request.resolve(message.result);
            else request.reject(Object.assign(new Error(message.error || 'Internal decipher failed'), {
              statusCode: Number(message.statusCode) || 502,
            }));
          }
        } catch (error) {
          console.error('Invalid decipher worker response', error?.message || error);
        }
      }
      newline = decipherWorkerBuffer.indexOf('\n');
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_096);
  });
  child.on('error', (error) => {
    rejectDecipherWorkerRequests(error);
  });
  child.on('close', (code) => {
    if (decipherWorker === child) decipherWorker = null;
    decipherWorkerBuffer = '';
    if (decipherWorkerRequests.size) {
      if (stderr) console.error('Decipher worker stopped', stderr);
      rejectDecipherWorkerRequests(Object.assign(
        new Error(`Internal decipher worker stopped (${code ?? 'unknown'})`),
        { statusCode: 502 },
      ));
    }
  });
  return child;
}

function runDecipherWorker(rawBody) {
  return new Promise((resolve, reject) => {
    const child = ensureDecipherWorker();
    const id = decipherWorkerNextId++;
    const timer = setTimeout(() => {
      decipherWorkerRequests.delete(id);
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Internal decipher helper timed out'), { statusCode: 504 }));
    }, helperTimeoutMs);
    decipherWorkerRequests.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, body: JSON.parse(rawBody) })}\n`);
  });
}

async function releaseDecipherWorker() {
  const child = decipherWorker;
  if (!child || child.killed) return false;
  if (decipherWorkerRequests.size) {
    throw Object.assign(new Error('Decipher worker is still processing'), { statusCode: 409 });
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3_000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
  return true;
}

function drainQueue() {
  if (active || pending.length === 0) return;
  active = true;
  const job = pending.shift();
  const operation = job.operation === 'decipher'
    ? runDecipherWorker(job.rawBody)
    : runChild(job.operation, job.rawBody);
  operation
    .then(job.resolve, job.reject)
    .finally(() => {
      active = false;
      drainQueue();
    });
}

function enqueue(operation, rawBody) {
  if (pending.length >= maxQueue) {
    throw Object.assign(new Error('Internal helper queue is full'), { statusCode: 503 });
  }
  return new Promise((resolve, reject) => {
    pending.push({ operation, rawBody, resolve, reject });
    drainQueue();
  });
}

function prunePoTokenCache(now = Date.now()) {
  for (const [key, entry] of poTokenCache) {
    if (entry.expiresAt <= now) poTokenCache.delete(key);
  }
  while (poTokenCache.size > 32) poTokenCache.delete(poTokenCache.keys().next().value);
}

function enqueuePoToken(rawBody, parsedBody) {
  const videoId = String(parsedBody?.videoId ?? '');
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) return enqueue('pot', rawBody);
  prunePoTokenCache();
  const cached = poTokenCache.get(videoId);
  if (cached) return Promise.resolve(cached.result);
  if (poTokenInFlight.has(videoId)) return poTokenInFlight.get(videoId);
  const operation = enqueue('pot', rawBody)
    .then((result) => {
      poTokenCache.set(videoId, { result, expiresAt: Date.now() + poCacheTtlMs });
      prunePoTokenCache();
      return result;
    })
    .finally(() => poTokenInFlight.delete(videoId));
  poTokenInFlight.set(videoId, operation);
  return operation;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(response, 200, {
        status: 'ok',
        active,
        waiting: pending.length,
        poTokenCacheEntries: poTokenCache.size,
        poTokenInFlight: poTokenInFlight.size,
        helperMaxOldSpaceMb,
        decipherWorkerActive: Boolean(decipherWorker && !decipherWorker.killed),
      });
    }
    if (request.method === 'POST' && url.pathname === '/release') {
      return jsonResponse(response, 200, { released: await releaseDecipherWorker() });
    }
    const operations = new Map([
      ['/api/pot', 'pot'],
      ['/api/decipher', 'decipher'],
    ]);
    if (request.method !== 'POST' || !operations.has(url.pathname)) {
      return jsonResponse(response, request.method === 'POST' ? 404 : 405, { error: 'Not found' });
    }
    const rawBody = await readRawBody(request);
    if (!bearerMatches(request) && !signedRequestMatches(request, rawBody, url.pathname)) {
      return jsonResponse(response, 401, { error: 'Unauthorized' });
    }
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return jsonResponse(response, 400, { error: 'Invalid JSON body' });
    }
    const operation = operations.get(url.pathname);
    const result = operation === 'pot'
      ? await enqueuePoToken(rawBody, parsedBody)
      : await enqueue(operation, rawBody);
    return jsonResponse(response, 200, result);
  } catch (error) {
    if ((Number(error?.statusCode) || 500) >= 500) console.error(error?.stack || error);
    if (!response.headersSent) {
      jsonResponse(response, Number(error?.statusCode) || 500, {
        error: error?.message || 'Internal gateway error',
      });
    } else {
      response.destroy();
    }
  }
});

server.listen(port, host, () => {
  console.log(`Internal Node gateway listening on http://${host}:${port}`);
});

function shutdown() {
  decipherWorker?.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
