import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInitialPlayerResponse,
  extractVideoId,
  selectBestAudio,
} from '../cloudflare-worker/src/resolver.js';

test('extractVideoId accepts common YouTube URL forms', () => {
  const id = 'jNQXAC9IVRw';
  assert.equal(extractVideoId(id), id);
  assert.equal(extractVideoId(`https://youtu.be/${id}?si=test`), id);
  assert.equal(extractVideoId(`https://www.youtube.com/watch?v=${id}&t=1`), id);
  assert.equal(extractVideoId(`https://youtube.com/shorts/${id}`), id);
});

test('extractVideoId rejects non-YouTube URLs', () => {
  assert.throws(() => extractVideoId('https://example.com/watch?v=jNQXAC9IVRw'), /対応するYouTube URL/);
});

test('extractInitialPlayerResponse uses the last valid assignment', () => {
  const html = [
    'var ytInitialPlayerResponse = {broken};',
    'var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"streamingData":{"adaptiveFormats":[]}};',
  ].join('\n');
  assert.equal(extractInitialPlayerResponse(html).playabilityStatus.status, 'OK');
});

test('selectBestAudio prefers non-DRC and then highest bitrate', () => {
  const selected = selectBestAudio({ streamingData: { adaptiveFormats: [
    { itag: 1, mimeType: 'video/mp4', url: 'https://example.test/video' },
    { itag: 2, mimeType: 'audio/webm', url: 'https://example.test/drc', bitrate: 200_000, isDrc: true },
    { itag: 3, mimeType: 'audio/mp4', signatureCipher: 'url=x', bitrate: 100_000 },
    { itag: 4, mimeType: 'audio/webm', cipher: 'url=x', bitrate: 150_000 },
  ] } });
  assert.equal(selected.itag, 4);
});
