import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/internal-cli.js', import.meta.url));
const gatewayPath = fileURLToPath(new URL('../src/internal-gateway.js', import.meta.url));

function runCli(operation, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, operation], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('one-shot helper rejects invalid decipher input before network access', async () => {
  const result = await runCli('decipher', {});
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    statusCode: 400,
    error: 'url, signatureCipher, or cipher is required',
  });
});

test('lightweight gateway is healthy and rejects unsigned work', async () => {
  const port = 20_000 + (process.pid % 10_000);
  const child = spawn(process.execPath, [gatewayPath], {
    env: { ...process.env, INTERNAL_GATEWAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('gateway startup timed out')), 5_000);
      child.once('error', reject);
      child.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('Internal Node gateway listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/pot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: 'jNQXAC9IVRw' }),
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    child.kill();
  }
});
