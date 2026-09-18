import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInitialPlayerResponse, selectHtmlAudioFormat } from '../src/html.js';

test('extracts the final non-null initial player response', () => {
  const html = '<script>var ytInitialPlayerResponse = null;</script><script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"nested":{"text":"} escaped \\\" quote"}};</script>';
  assert.equal(extractInitialPlayerResponse(html).playabilityStatus.status, 'OK');
});

test('selects the highest bitrate non-DRC audio format', () => {
  const selected = selectHtmlAudioFormat({
    streamingData: {
      adaptiveFormats: [
        { itag: 251, mimeType: 'audio/webm', bitrate: 160000, isDrc: true, url: 'https://example.test/drc' },
        { itag: 140, mimeType: 'audio/mp4', bitrate: 128000, url: 'https://example.test/aac' },
        { itag: 18, mimeType: 'video/mp4', bitrate: 500000, url: 'https://example.test/video' },
      ],
    },
  });
  assert.equal(selected.itag, 140);
});

