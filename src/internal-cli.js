import process from 'node:process';

function fail(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

async function readInput(maxBytes = 16_384) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail('Request body too large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('Invalid JSON body');
  }
}

function validateStreamInput(body) {
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
  const input = validateStreamInput(body);
  const { Platform, Player } = await import('youtubei.js');
  Platform.shim.eval = async (data) => new Function(data.output)();
  const player = await Player.create(undefined, fetch, undefined, input.playerId || undefined);
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

async function mintPoToken(body) {
  const videoId = String(body.videoId ?? '');
  if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) fail('Invalid videoId');
  const { createWebPoMinter } = await import('./pot.js');
  const poMinter = await createWebPoMinter();
  const visitorData = poMinter.visitorData;
  if (!visitorData) fail('BotGuard session has no visitor data', 502);
  return {
    poToken: await poMinter.mintAsWebsafeString(videoId),
    playerPoToken: await poMinter.mintAsWebsafeString(visitorData),
    visitorData,
  };
}

async function main() {
  const operation = process.argv[2];
  const body = await readInput();
  let result;
  if (operation === 'decipher') result = await decipher(body);
  else if (operation === 'pot') result = await mintPoToken(body);
  else fail('Unknown operation');
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    statusCode: Number(error?.statusCode) || 500,
    error: error?.message || 'Internal helper error',
  })}\n`);
  process.exitCode = 1;
});
