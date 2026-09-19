import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('../mr-backend/static/progress-model.js');

const model = globalThis.MRRemovalProgress;

test('time estimate moves steadily toward the expected 90-second finish', () => {
  assert.equal(model.estimateProgress(0), 2);
  assert.equal(model.estimateProgress(45_000), 48.5);
  assert.equal(model.estimateProgress(90_000), 95);
  assert.ok(model.estimateProgress(150_000) > 96);
  assert.ok(model.estimateProgress(3_600_000) <= 98);
});

test('progress advancement is smooth, monotonic, and never reaches completion early', () => {
  const next = model.advanceProgress(20, 80, 200);
  assert.equal(next, 21.6);
  assert.equal(model.advanceProgress(next, 10, 200), next);
  assert.equal(model.advanceProgress(97.8, 100, 1_000), 98);
});

test('the page loads the progress model first and scrolls only after successful results', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../mr-backend/templates/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../mr-backend/static/app.js', import.meta.url), 'utf8'),
  ]);
  assert.ok(html.indexOf('/static/progress-model.js') < html.indexOf('/static/app.js'));
  assert.match(app, /playerArea\.scrollIntoView\(/);
  assert.match(app, /if \(success\) \{\s*finishProgress\('再生の準備ができました'\);\s*scrollToResults\(\);/);
});

test('saved-file mode supports a YouTube source on either side', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../mr-backend/templates/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../mr-backend/static/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="videoFileUrlInput"/);
  assert.match(html, /id="karaFileUrlInput"/);
  assert.equal((html.match(/data-source-mode="url"/g) || []).length, 2);
  assert.match(app, /fetch\(apiUrl\('\/mixed\/start'\)/);
  assert.match(app, /form\.append\('video_url', videoUrl\)/);
  assert.match(app, /form\.append\('kara_url', karaokeUrl\)/);
});
