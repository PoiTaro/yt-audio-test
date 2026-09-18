import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProbeError,
  buildSummary,
  classifyError,
  extractVideoId,
  inspectExpiry,
  selectBestAudio,
} from '../src/core.js';

test('extractVideoId supports common YouTube URL forms', () => {
  const id = 'M7lc1UVf-VE';
  assert.equal(extractVideoId(id), id);
  assert.equal(extractVideoId(`https://www.youtube.com/watch?v=${id}&t=1`), id);
  assert.equal(extractVideoId(`https://youtu.be/${id}?si=test`), id);
  assert.equal(extractVideoId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(extractVideoId(`https://www.youtube.com/embed/${id}`), id);
  assert.equal(extractVideoId(`https://www.youtube.com/live/${id}`), id);
});

test('extractVideoId rejects non-YouTube input', () => {
  assert.throws(() => extractVideoId('https://example.com/watch?v=M7lc1UVf-VE'), ProbeError);
  assert.throws(() => extractVideoId('definitely-not-a-video-id'), ProbeError);
});

test('selectBestAudio prefers original, non-DRC audio, then bitrate', () => {
  const formats = [
    { itag: 1, has_audio: true, has_video: false, is_original: true, is_drc: true, bitrate: 256000 },
    { itag: 2, has_audio: true, has_video: false, is_original: true, is_drc: false, bitrate: 128000 },
    { itag: 3, has_audio: true, has_video: false, is_original: false, is_drc: false, bitrate: 320000 },
    { itag: 4, has_audio: true, has_video: true, is_original: true, is_drc: false, bitrate: 999000 },
  ];
  assert.equal(selectBestAudio(formats).itag, 2);
});

test('inspectExpiry reads the expire query parameter', () => {
  const result = inspectExpiry('https://example.googlevideo.com/videoplayback?expire=2000000000');
  assert.equal(result.epochSeconds, 2000000000);
  assert.equal(result.iso, '2033-05-18T03:33:20.000Z');
});

test('classifyError preserves explicit codes and recognizes common failures', () => {
  assert.equal(classifyError(new ProbeError('NO_URL', 'missing')).code, 'NO_URL');
  assert.equal(classifyError(new Error('HTTP 403 Forbidden')).code, 'HTTP_403');
  assert.equal(classifyError(new Error('LOGIN_REQUIRED')).code, 'LOGIN_REQUIRED');
  assert.equal(classifyError(new Error('This video is unavailable')).code, 'UNPLAYABLE');
  assert.equal(classifyError(new Error('signature decipher failed')).code, 'SIGNATURE_DECIPHER');
});

test('buildSummary keeps stages separate', () => {
  const summary = buildSummary([{ attempts: [
    { client: 'IOS', success: false, metadataSuccess: true, streamUrlSuccess: true, googlevideoSuccess: false, ffmpegSuccess: false },
    { client: 'ANDROID_VR', success: true, metadataSuccess: true, streamUrlSuccess: true, googlevideoSuccess: true, ffmpegSuccess: true },
  ] }]);
  assert.deepEqual(summary.directUrl, { successes: 2, total: 2, rate: 1 });
  assert.deepEqual(summary.googlevideo, { successes: 1, total: 2, rate: 0.5 });
  assert.equal(summary.byClient.IOS.directUrlSuccesses, 1);
  assert.equal(summary.byClient.IOS.googlevideoSuccesses, 0);
});
