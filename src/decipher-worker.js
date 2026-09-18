import readline from 'node:readline';
import process from 'node:process';
import { Platform, Player } from 'youtubei.js';

Platform.shim.eval = async (data) => new Function(data.output)();

const idleExitMs = Number(process.env.INTERNAL_DECIPHER_IDLE_EXIT_MS || 90_000);
const playerCache = new Map();
let idleTimer = null;
let chain = Promise.resolve();

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function validateInput(body) {
  const playerId = String(body.playerId ?? '');
  if (playerId && !/^[A-Za-z0-9_-]{6,32}$/u.test(playerId)) fail('Invalid playerId');
  const directUrl = typeof body.url === 'string' && body.url ? body.url : undefined;
  const signatureCipher = typeof body.signatureCipher === 'string' && body.signatureCipher
    ? body.signatureCipher
    : undefined;
  const cipher = typeof body.cipher === 'string' && body.cipher ? body.cipher : undefined;
  const cipherValue = signatureCipher || cipher;
  const embeddedUrl = cipherValue ? new URLSearchParams(cipherValue).get('url') : null;
  if (!directUrl && !cipherValue) fail('url, signatureCipher, or cipher is required');
  let rawUrl;
  try {
    rawUrl = new URL(directUrl || embeddedUrl || '');
  } catch {
    fail('Invalid stream URL');
  }
  if (rawUrl.protocol !== 'https:' || !/(^|\.)googlevideo\.com$/iu.test(rawUrl.hostname)) {
    fail('Only HTTPS googlevideo.com URLs are accepted');
  }
  if (!rawUrl.searchParams.get('n')) fail('Stream URL has no n parameter');
  return { playerId, directUrl, signatureCipher, cipher, rawUrl };
}

async function decipher(body) {
  const input = validateInput(body);
  const cacheKey = input.playerId || 'auto';
  if (!playerCache.has(cacheKey)) {
    playerCache.set(cacheKey, Player.create(undefined, fetch, undefined, input.playerId || undefined)
      .catch((error) => {
        playerCache.delete(cacheKey);
        throw error;
      }));
  }
  const player = await playerCache.get(cacheKey);
  const decipheredUrl = await player.decipher(
    input.directUrl,
    input.signatureCipher,
    input.cipher,
  );
  const deciphered = new URL(decipheredUrl);
  return {
    playerId: player.player_id,
    nChanged: input.rawUrl.searchParams.get('n') !== deciphered.searchParams.get('n'),
    url: decipheredUrl,
  };
}

function scheduleIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), idleExitMs);
  idleTimer.unref();
}

async function processLine(line) {
  let id = null;
  try {
    const envelope = JSON.parse(line);
    id = envelope.id;
    const result = await decipher(envelope.body);
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id,
      ok: false,
      statusCode: Number(error?.statusCode) || 500,
      error: error?.message || 'Internal decipher error',
    })}\n`);
  } finally {
    scheduleIdleExit();
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  clearTimeout(idleTimer);
  chain = chain.then(() => processLine(line));
});
lines.on('close', () => {
  chain.finally(() => process.exit(0));
});
