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

async function run() {
  await waitForBridge();
  update('extension detected; resolving audio URL locally...');
  const resolved = await fetch('/resolve').then((response) => response.json());
  if (!resolved.success) throw new Error(resolved.error || 'resolution failed');

  update('fetching first 8 KiB through extension...');
  const response = await window.proxyFetch(resolved.streamUrl, {
    method: 'GET',
    headers: { range: 'bytes=0-8191' },
  });
  const data = await response.arrayBuffer();
  const result = {
    success: response.ok && data.byteLength > 0,
    extensionDetected: true,
    status: response.status,
    bytes: data.byteLength,
    contentType: response.headers.get('content-type'),
    itag: resolved.itag,
    codec: resolved.codec,
  };
  update(result);
  await fetch('/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
}

run().catch(async (error) => {
  const result = { success: false, extensionDetected: Boolean(window.ytcBridge?.installed), error: error.message };
  update(result);
  await fetch('/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  }).catch(() => {});
});
