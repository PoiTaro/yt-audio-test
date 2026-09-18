import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver, describeFormat, selectBestAudio } from '../src/core.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = 18181;
let resolved = null;

async function resolveAudio() {
  if (resolved) return resolved;
  const youtube = await createResolver(path.join(directory, '.cache'), {
    client: 'IOS',
    generateSessionLocally: true,
    enableSessionCache: false,
  });
  const info = await youtube.getBasicInfo('jNQXAC9IVRw');
  if (info.playability_status?.status !== 'OK') {
    throw new Error(info.playability_status?.reason || info.playability_status?.status || 'Player failed');
  }
  const format = selectBestAudio(info.streaming_data?.adaptive_formats ?? []);
  const streamUrl = await format.decipher(youtube.session.player);
  const description = describeFormat(format);
  resolved = { success: true, streamUrl, itag: description.itag, codec: description.codec };
  return resolved;
}

function send(response, status, type, body) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/' || request.url === '/index.html') {
      return send(response, 200, 'text/html; charset=utf-8', await readFile(path.join(directory, 'index.html')));
    }
    if (request.url === '/client.js') {
      return send(response, 200, 'text/javascript; charset=utf-8', await readFile(path.join(directory, 'client.js')));
    }
    if (request.url === '/resolve') {
      const body = JSON.stringify(await resolveAudio());
      return send(response, 200, 'application/json; charset=utf-8', body);
    }
    if (request.url === '/result' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      console.log(`BROWSER_PROBE_RESULT=${JSON.stringify(result)}`);
      send(response, 200, 'application/json', '{"ok":true}');
      setTimeout(() => server.close(), 250);
      return;
    }
    send(response, 404, 'text/plain', 'Not found');
  } catch (error) {
    send(response, 500, 'application/json', JSON.stringify({ success: false, error: error.message }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`BROWSER_PROBE_URL=http://127.0.0.1:${port}`);
});
