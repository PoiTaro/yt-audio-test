import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = 18181;

function send(response, status, type, body) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/' || request.url === '/index.html') {
      return send(response, 200, 'text/html; charset=utf-8', await readFile(path.join(directory, 'index.html')));
    }
    if (request.url === '/full-client.js') {
      return send(response, 200, 'text/javascript; charset=utf-8', await readFile(path.join(directory, 'full-client.js')));
    }
    if (request.url === '/youtubei.js') {
      return send(response, 200, 'text/javascript; charset=utf-8', await readFile(path.join(directory, '..', 'node_modules', 'youtubei.js', 'bundle', 'browser.js')));
    }
    if (request.url === '/result' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      console.log(`BROWSER_PROBE_RESULT=${JSON.stringify(result)}`);
      send(response, 200, 'application/json', '{"ok":true}');
      setTimeout(() => {
        server.closeAllConnections();
        server.close();
      }, 250);
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
