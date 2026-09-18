const apiBaseSetting = (document.querySelector('meta[name="api-base-url"]')?.content || '').trim();
const configuredApiBase = (
  apiBaseSetting === '__LOCAL_API__'
    ? `${window.location.protocol}//${window.location.hostname}:5000`
    : apiBaseSetting
).replace(/\/+$/, '');
const API_ORIGIN = configuredApiBase || window.location.origin;

function apiUrl(path) {
  if (!path) return '';
  return new URL(path, `${API_ORIGIN}/`).href;
}

const uploadForm = document.getElementById('uploadForm');
const downloadForm = document.getElementById('downloadForm');
const videoEl = document.getElementById('video');
// iPhone / iPadでもページ内のプレイヤーのまま再生する。
videoEl.playsInline = true;
videoEl.setAttribute('webkit-playsinline', '');
videoEl.crossOrigin = 'anonymous';
const playerArea = document.getElementById('playerArea');
const mixSlider = document.getElementById('mixSlider');
const mixVal = document.getElementById('mixVal');
const scaleVal = document.getElementById('scaleVal');
const reextractBtn = document.getElementById('reextractBtn');
const status = document.getElementById('status');
const extractSubmit = document.getElementById('extractSubmit');
const downloadSubmit = document.getElementById('downloadSubmit');
const resultNote = document.getElementById('resultNote');
const videoUrlInput = document.getElementById('videoUrlInput');
const karaokeUrlInput = document.getElementById('karaUrlInput');
const videoModeBtn = document.getElementById('videoModeBtn');
const audioModeBtn = document.getElementById('audioModeBtn');
const videoPreviewPanel = document.getElementById('videoPreviewPanel');
const audioPreviewPanel = document.getElementById('audioPreviewPanel');
const vocalAudio = document.getElementById('vocalAudio');
const originalAudio = document.getElementById('originalAudio');
vocalAudio.crossOrigin = 'anonymous';
originalAudio.crossOrigin = 'anonymous';
const videoDownloadBtn = document.getElementById('videoDownloadBtn');
const audioDownloadBtn = document.getElementById('audioDownloadBtn');
const vocalEnhanceToggle = document.getElementById('vocalEnhanceToggle');
const progressPanel = document.getElementById('progressPanel');
const progressLabel = document.getElementById('progressLabel');
const progressValue = document.getElementById('progressValue');
const progressTrack = document.getElementById('progressTrack');
const progressBar = document.getElementById('progressBar');
const postModeBtn = document.getElementById('postModeBtn');
const postMode = document.getElementById('postMode');
const postCloseBtn = document.getElementById('postCloseBtn');
const postVideoMount = document.getElementById('postVideoMount');
const postMixSlider = document.getElementById('postMixSlider');
const postMixValue = document.getElementById('postMixValue');
const postAppLink = document.getElementById('postAppLink');
const postAppUrl = document.getElementById('postAppUrl');
const postBlurStrength = document.getElementById('postBlurStrength');
const postBlurValue = document.getElementById('postBlurValue');

let audioCtx = null;
let videoSource = null;
let vocalBufferSource = null;
let videoGain = null;
let vocalGain = null;
let vocalBuffer = null;
let storedVideoAudioFilename = null;
let storedVideoFilename = null;
let storedKaraokeFilename = null;
let storedOffsetSeconds = 0;
let storedEnhancedVocalUrl = null;
let storedNaturalVocalUrl = null;
let storedEnhancedVideoUrl = null;
let storedNaturalVideoUrl = null;
let extractionStrength = 1.0;
let progressHideTimer = null;
let audioSyncFrame = null;
let videoSyncFrame = null;
let vocalStartContextTime = 0;
let vocalStartBufferOffset = 0;
let lastVideoSyncCheck = 0;
let videoMixStartRequest = 0;
let videoHomeParent = null;
let videoHomeNextSibling = null;
let backendWarmPromise = null;
let backendReady = API_ORIGIN === window.location.origin;

function sourceTimelineOffset() {
  // 一定オフセット方式では、抽出音声の0秒がステージ音源の途中に対応する。
  return Math.max(0, storedOffsetSeconds);
}

function log(message, state = 'idle') {
  status.textContent = message;
  status.dataset.state = state;
}

function setProgress(value, message, indeterminate = false) {
  if (progressHideTimer) clearTimeout(progressHideTimer);
  progressPanel.classList.remove('hidden', 'is-error');
  progressPanel.classList.toggle('is-indeterminate', indeterminate);
  progressLabel.textContent = message;
  if (indeterminate) {
    progressValue.textContent = '';
    progressTrack.removeAttribute('aria-valuenow');
    progressTrack.setAttribute('aria-valuetext', message);
  } else {
    const safeValue = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    progressBar.style.width = `${safeValue}%`;
    progressValue.textContent = `${safeValue}%`;
    progressTrack.setAttribute('aria-valuenow', String(safeValue));
    progressTrack.setAttribute('aria-valuetext', message);
  }
}

function finishProgress(message = '完了しました') {
  setProgress(100, message);
  progressHideTimer = setTimeout(() => progressPanel.classList.add('hidden'), 2200);
}

function failProgress(message) {
  if (progressHideTimer) clearTimeout(progressHideTimer);
  progressPanel.classList.remove('hidden', 'is-indeterminate');
  progressPanel.classList.add('is-error');
  progressLabel.textContent = message;
  progressValue.textContent = '';
  progressTrack.removeAttribute('aria-valuenow');
  progressBar.style.width = '100%';
}

async function warmBackend(showStatus = true) {
  if (backendReady) return true;
  if (backendWarmPromise) return backendWarmPromise;
  if (showStatus) {
    setProgress(1, '処理サーバーを準備しています', true);
    log('処理サーバーを起動しています。URLを入力しながらお待ちください。', 'working');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  backendWarmPromise = fetch(apiUrl('/health'), {
    cache: 'no-store',
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.json();
      backendReady = true;
      if (showStatus) {
        log('処理サーバーの準備ができました。', 'success');
        finishProgress('サーバー準備完了');
      }
      return true;
    })
    .catch((error) => {
      backendWarmPromise = null;
      if (showStatus) {
        const message = error.name === 'AbortError'
          ? '処理サーバーの起動に時間がかかっています。もう一度お試しください。'
          : '処理サーバーを起動できませんでした。通信状態を確認してください。';
        log(message, 'error');
        failProgress(message);
      }
      throw error;
    })
    .finally(() => clearTimeout(timeout));
  return backendWarmPromise;
}

function startBackendWarmup() {
  warmBackend(true).catch((error) => console.warn('Backend warmup failed:', error));
}

[videoUrlInput, karaokeUrlInput].forEach((input) => {
  input.addEventListener('focus', startBackendWarmup, { once: true });
  input.addEventListener('input', startBackendWarmup, { once: true });
  input.addEventListener('paste', startBackendWarmup, { once: true });
});

async function waitForDownloadJob(jobId) {
  while (true) {
    const response = await fetch(apiUrl(`/jobs/${encodeURIComponent(jobId)}`), { cache: 'no-store' });
    const job = await readJson(response);
    if (job.error && job.status !== 'error') throw new Error(job.error);
    if (job.status === 'complete') {
      setProgress(97, '抽出結果を受け取っています');
      return job.result;
    }
    setProgress(job.progress || 0, job.message || '処理しています');
    if (job.status === 'error') throw new Error(job.error || job.message || '処理に失敗しました。');
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
}

function setBusy(button, busy, workingLabel) {
  const labelNode = button.querySelector('span:first-child');
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = (labelNode || button).textContent.trim();
  }
  button.disabled = busy;
  (labelNode || button).textContent = busy ? workingLabel : button.dataset.defaultLabel;
}

function setPlaybackMode(mode) {
  const showVideo = mode === 'video' && !videoModeBtn.disabled;
  videoPreviewPanel.classList.toggle('hidden', !showVideo);
  audioPreviewPanel.classList.toggle('hidden', showVideo);
  videoModeBtn.classList.toggle('is-active', showVideo);
  audioModeBtn.classList.toggle('is-active', !showVideo);
  videoModeBtn.setAttribute('aria-pressed', String(showVideo));
  audioModeBtn.setAttribute('aria-pressed', String(!showVideo));
  if (showVideo) {
    vocalAudio.pause();
    originalAudio.pause();
  } else {
    videoEl.pause();
    stopVocal();
  }
}

function updatePostMixDisplay() {
  const percent = Math.round(Number(postMixSlider.value) * 100);
  postMixValue.value = `VOICE ${percent}%`;
  postMixSlider.style.setProperty('--mix-progress', String(percent));
}

function updatePostAppLink() {
  const appUrl = window.location.origin;
  postAppLink.href = appUrl;
  postAppUrl.textContent = window.location.host;
}

const POST_BLUR_STORAGE_KEY = 'mr-removal-post-preview-blur-strength';
const LEGACY_POST_BLUR_STORAGE_KEY = 'mr-removal-post-preview-blur';

function applyPostBlurStrength(value) {
  const strength = Math.max(0, Math.min(12, Math.round(Number(value) || 0)));
  postBlurStrength.value = String(strength);
  postBlurValue.value = strength === 0 ? 'なし' : `${strength}px`;
  postVideoMount.style.setProperty('--post-blur-strength', `${strength}px`);
  postVideoMount.classList.toggle('is-blurred', strength > 0);
}

try {
  const savedStrength = localStorage.getItem(POST_BLUR_STORAGE_KEY);
  const legacyEnabled = localStorage.getItem(LEGACY_POST_BLUR_STORAGE_KEY) === 'true';
  applyPostBlurStrength(savedStrength === null ? (legacyEnabled ? 4 : 0) : savedStrength);
} catch (_) {
  applyPostBlurStrength(0);
}

postBlurStrength.addEventListener('input', () => {
  applyPostBlurStrength(postBlurStrength.value);
  try {
    localStorage.setItem(POST_BLUR_STORAGE_KEY, postBlurStrength.value);
  } catch (_) { /* ストレージを使えない環境でも設定自体は反映する。 */ }
});

function openPostMode() {
  if (videoModeBtn.disabled || !videoEl.currentSrc) {
    log('投稿モードには動画の抽出結果が必要です。', 'error');
    return;
  }
  vocalAudio.pause();
  originalAudio.pause();
  videoEl.pause();
  stopVocal();
  videoHomeParent = videoEl.parentNode;
  videoHomeNextSibling = videoEl.nextSibling;
  postVideoMount.appendChild(videoEl);
  videoEl.controls = true;
  postMixSlider.value = mixSlider.value;
  updatePostMixDisplay();
  updatePostAppLink();
  postMode.classList.remove('hidden');
  document.documentElement.classList.add('post-mode-open');
  document.body.classList.add('post-mode-open');
  postCloseBtn.focus();
}

function closePostMode() {
  if (postMode.classList.contains('hidden')) return;
  videoEl.pause();
  stopVocal();
  videoEl.controls = true;
  if (videoHomeParent) {
    if (videoHomeNextSibling && videoHomeNextSibling.parentNode === videoHomeParent) {
      videoHomeParent.insertBefore(videoEl, videoHomeNextSibling);
    } else {
      videoHomeParent.appendChild(videoEl);
    }
  }
  postMode.classList.add('hidden');
  document.documentElement.classList.remove('post-mode-open');
  document.body.classList.remove('post-mode-open');
  postModeBtn.focus();
}

postModeBtn.addEventListener('click', openPostMode);
postCloseBtn.addEventListener('click', closePostMode);
postMixSlider.addEventListener('input', () => {
  mixSlider.value = postMixSlider.value;
  mixSlider.dispatchEvent(new Event('input'));
  updatePostMixDisplay();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !postMode.classList.contains('hidden')) closePostMode();
});

function storeVocalVariants(payload, resetToEnhanced = false) {
  storedEnhancedVocalUrl = payload.vocal_url ? apiUrl(payload.vocal_url) : null;
  storedNaturalVocalUrl = payload.vocal_natural_url
    ? apiUrl(payload.vocal_natural_url)
    : storedEnhancedVocalUrl;
  storedEnhancedVideoUrl = payload.result_video_url ? apiUrl(payload.result_video_url) : null;
  storedNaturalVideoUrl = payload.result_video_natural_url
    ? apiUrl(payload.result_video_natural_url)
    : storedEnhancedVideoUrl;
  if (resetToEnhanced) vocalEnhanceToggle.checked = true;
  vocalEnhanceToggle.disabled = !storedEnhancedVocalUrl
    || storedNaturalVocalUrl === storedEnhancedVocalUrl;
}

function selectedVocalUrl() {
  return vocalEnhanceToggle.checked ? storedEnhancedVocalUrl : storedNaturalVocalUrl;
}

function selectedResultVideoUrl() {
  return vocalEnhanceToggle.checked ? storedEnhancedVideoUrl : storedNaturalVideoUrl;
}

function updateVariantDownloadLinks() {
  const vocalUrl = selectedVocalUrl();
  audioDownloadBtn.classList.toggle('hidden', !vocalUrl);
  if (vocalUrl) audioDownloadBtn.href = vocalUrl;
  const resultVideoUrl = selectedResultVideoUrl();
  videoDownloadBtn.classList.toggle('hidden', !resultVideoUrl);
  if (resultVideoUrl) videoDownloadBtn.href = resultVideoUrl;
}

async function loadSelectedVocalVariant() {
  const vocalUrl = selectedVocalUrl();
  if (!vocalUrl) return;
  videoEl.pause();
  vocalAudio.pause();
  originalAudio.pause();
  stopVocal();
  const previousTime = vocalAudio.currentTime || 0;
  vocalAudio.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(vocalAudio.duration)) {
      vocalAudio.currentTime = Math.min(previousTime, Math.max(0, vocalAudio.duration - 0.05));
    }
  }, { once: true });
  vocalAudio.src = vocalUrl;
  vocalAudio.load();
  const response = await fetch(vocalUrl);
  if (!response.ok) throw new Error('ボーカル音声を読み込めませんでした。');
  initialiseAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  vocalBuffer = await audioCtx.decodeAudioData(await response.arrayBuffer());
  updateVariantDownloadLinks();
}

videoModeBtn.addEventListener('click', () => setPlaybackMode('video'));
audioModeBtn.addEventListener('click', () => setPlaybackMode('audio'));
vocalEnhanceToggle.addEventListener('change', async () => {
  vocalEnhanceToggle.disabled = true;
  try {
    await loadSelectedVocalVariant();
    log(
      vocalEnhanceToggle.checked
        ? 'ボーカル強調をオンにしました。声を前に出して再生します。'
        : 'ボーカル強調をオフにしました。自然な差分を再生します。',
      'success',
    );
  } catch (error) {
    console.error(error);
    vocalEnhanceToggle.checked = !vocalEnhanceToggle.checked;
    log(`音声の切り替えに失敗しました: ${error.message}`, 'error');
  } finally {
    vocalEnhanceToggle.disabled = !storedEnhancedVocalUrl
      || storedNaturalVocalUrl === storedEnhancedVocalUrl;
  }
});

function updateFileName(inputId, nameId) {
  const input = document.getElementById(inputId);
  const name = document.getElementById(nameId);
  const control = input.closest('.file-control');
  const file = input.files[0];
  name.textContent = file ? file.name : '未選択';
  control.classList.toggle('is-selected', Boolean(file));
}

function youtubeVideoId(value) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let videoId = null;
    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || null;
    } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      if (url.pathname === '/watch') videoId = url.searchParams.get('v');
      if (!videoId) {
        const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
        videoId = match ? match[1] : null;
      }
    }
    return videoId && /^[A-Za-z0-9_-]{6,20}$/.test(videoId) ? videoId : null;
  } catch (_) {
    return null;
  }
}

function setupUrlPreview(input, previewId, imageId, label) {
  const preview = document.getElementById(previewId);
  const image = document.getElementById(imageId);

  const update = () => {
    const videoId = youtubeVideoId(input.value);
    if (!videoId) {
      preview.hidden = true;
      image.removeAttribute('src');
      image.alt = '';
      return;
    }
    image.alt = `${label}のサムネイル`;
    image.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    preview.hidden = false;
  };

  input.addEventListener('input', update);
  input.addEventListener('change', update);
  update();
}

setupUrlPreview(videoUrlInput, 'videoUrlPreview', 'videoUrlPreviewImage', 'ステージ動画');
setupUrlPreview(karaokeUrlInput, 'karaUrlPreview', 'karaUrlPreviewImage', 'MV・公式音源');

document.querySelectorAll('[data-paste-target]').forEach((button) => {
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.pasteTarget);
    const defaultLabel = button.textContent;
    button.disabled = true;
    button.textContent = '読取中';
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error('このブラウザーではクリップボードを直接読み取れません。');
      }
      const pastedText = await navigator.clipboard.readText();
      if (!pastedText.trim()) {
        log('クリップボードにURLがありません。', 'error');
        input.focus();
        return;
      }
      input.value = pastedText.trim();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    } catch (error) {
      console.error(error);
      log('クリップボードを読み取れませんでした。ブラウザーの権限を確認してください。', 'error');
      input.focus();
    } finally {
      button.disabled = false;
      button.textContent = defaultLabel;
    }
  });
});

document.getElementById('videoInput').addEventListener('change', () => updateFileName('videoInput', 'videoFileName'));
document.getElementById('karaInput').addEventListener('change', () => updateFileName('karaInput', 'karaFileName'));

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !payload.error) payload.error = `サーバーエラー (${response.status})`;
  return payload;
}

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const videoFile = document.getElementById('videoInput').files[0];
  const karaokeFile = document.getElementById('karaInput').files[0];
  if (!videoFile) {
    log('まず歌声入りのステージ映像・音源を選択してください。', 'error');
    document.getElementById('videoInput').focus();
    return;
  }
  const form = new FormData();
  form.append('video', videoFile);
  if (!karaokeFile) {
    log('差分を抽出するには、比較用のMV・公式音源も選択してください。', 'error');
    document.getElementById('karaInput').focus();
    return;
  }
  form.append('karaoke', karaokeFile);
  setBusy(extractSubmit, true, '生歌の差分を抽出しています…');
  setProgress(0, 'ファイルを送り、位置合わせしています', true);
  log('ステージ映像と比較用音源を位置合わせして、生歌の差分を抽出しています。', 'working');
  try {
    await warmBackend(true);
    setProgress(2, 'ファイルを送り、位置合わせしています', true);
    const response = await fetch(apiUrl('/upload'), { method: 'POST', body: form });
    const success = await handleServerResponse(await readJson(response));
    if (success) finishProgress('抽出が完了しました');
    else failProgress(status.textContent);
  } catch (error) {
    console.error(error);
    log(`アップロードまたは処理に失敗しました: ${error.message}`, 'error');
    failProgress('処理に失敗しました');
  } finally {
    setBusy(extractSubmit, false);
  }
});

downloadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const videoUrl = videoUrlInput.value.trim();
  const karaokeUrl = karaokeUrlInput.value.trim();
  if (!videoUrl) {
    log('歌声入りステージ動画のURLを入力してください。', 'error');
    videoUrlInput.focus();
    return;
  }
  if (!karaokeUrl) {
    log('生歌の差分を抽出するには、同じ曲のMV・公式音源URLも必要です。', 'error');
    karaokeUrlInput.focus();
    return;
  }
  setBusy(downloadSubmit, true, '取得しています…');
  setProgress(2, '処理を準備しています');
  log('ステージ動画と比較用音源を取得して、位置を合わせています。しばらくお待ちください。', 'working');
  try {
    await warmBackend(true);
    setProgress(2, '処理を準備しています');
    const response = await fetch(apiUrl('/download/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: videoUrl, kara_url: karaokeUrl }),
    });
    const started = await readJson(response);
    if (started.error) throw new Error(started.error);
    const result = await waitForDownloadJob(started.job_id);
    setProgress(99, '抽出結果を読み込んでいます');
    const success = await handleServerResponse(result);
    if (success) finishProgress('再生の準備ができました');
    else failProgress(status.textContent);
  } catch (error) {
    console.error(error);
    log(`取得または処理に失敗しました: ${error.message}`, 'error');
    failProgress('取得または処理に失敗しました');
  } finally {
    setBusy(downloadSubmit, false);
  }
});

function initialiseAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!videoSource) {
    videoSource = audioCtx.createMediaElementSource(videoEl);
    videoGain = audioCtx.createGain();
    videoGain.gain.setValueAtTime(1 - Number(mixSlider.value), audioCtx.currentTime);
    videoSource.connect(videoGain).connect(audioCtx.destination);
  }
}

async function handleServerResponse(payload) {
  if (payload.error) {
    log(`処理できませんでした: ${payload.error}`, 'error');
    return false;
  }
  storeVocalVariants(payload, true);
  const activeVocalUrl = selectedVocalUrl();
  if (activeVocalUrl) {
    // 新しい抽出は保護マスクを適用した1.00と、抽出した差分だけを聴く状態から始める。
    extractionStrength = 1.0;
    scaleVal.value = extractionStrength.toFixed(2);
    mixSlider.value = '1';
    mixSlider.dispatchEvent(new Event('input'));
  }
  videoEl.src = apiUrl(payload.video_url);
  videoEl.load();
  originalAudio.src = apiUrl(payload.video_audio_url || payload.video_url);
  originalAudio.load();
  const hasVideoPreview = !payload.preview_is_audio_only;
  videoModeBtn.disabled = !hasVideoPreview;
  postModeBtn.disabled = !hasVideoPreview;
  audioModeBtn.disabled = !activeVocalUrl;
  if (activeVocalUrl) {
    vocalAudio.src = activeVocalUrl;
    vocalAudio.load();
  } else {
    vocalAudio.removeAttribute('src');
    vocalAudio.load();
  }
  updateVariantDownloadLinks();
  setPlaybackMode(hasVideoPreview ? 'video' : 'audio');
  playerArea.classList.remove('hidden');
  storedVideoAudioFilename = payload.video_audio_filename || payload.video_filename || null;
  storedVideoFilename = payload.video_filename || null;
  storedKaraokeFilename = payload.karaoke_filename || null;
  storedOffsetSeconds = Number(payload.offset_seconds || 0);
  initialiseAudio();
  if (activeVocalUrl) {
    log('抽出結果を読み込んでいます。', 'working');
    const response = await fetch(activeVocalUrl);
    vocalBuffer = await audioCtx.decodeAudioData(await response.arrayBuffer());
    stopVocal();
    createVocalSource();
    reextractBtn.disabled = false;
    resultNote.textContent = payload.preview_is_audio_only
      ? '映像は取得できなかったため、音声プレビューで抽出した差分を確認できます。'
      : '動画と音声のみを切り替えて確認できます。';
    log('抽出が完了しました。生歌の差分を再生して確認してください。', 'success');
  } else {
    vocalBuffer = null;
    reextractBtn.disabled = true;
    resultNote.textContent = '比較用のMV・公式音源を追加すると、ここで生歌の差分を確認できます。';
    log('読み込みが完了しました。比較用のMV・公式音源を追加すると生歌の差分を抽出できます。', 'idle');
  }
  return true;
}

function stopVocal() {
  videoMixStartRequest += 1;
  if (videoSyncFrame) cancelAnimationFrame(videoSyncFrame);
  videoSyncFrame = null;
  if (!vocalBufferSource) return;
  try { vocalBufferSource.stop(); } catch (_) { /* Already stopped. */ }
  vocalBufferSource.disconnect();
  vocalBufferSource = null;
}

function createVocalSource() {
  if (!audioCtx || !vocalBuffer) return;
  stopVocal();
  vocalBufferSource = audioCtx.createBufferSource();
  vocalBufferSource.buffer = vocalBuffer;
  vocalBufferSource.playbackRate.value = videoEl.playbackRate || 1;
  vocalGain = audioCtx.createGain();
  vocalGain.gain.setValueAtTime(Number(mixSlider.value), audioCtx.currentTime);
  vocalBufferSource.connect(vocalGain).connect(audioCtx.destination);
}

function startVocalForVideo() {
  if (!audioCtx || !vocalBuffer || videoEl.paused) return;
  createVocalSource();
  const rate = videoEl.playbackRate || 1;
  const targetOffset = videoEl.currentTime - sourceTimelineOffset();
  if (targetOffset >= vocalBuffer.duration) {
    stopVocal();
    return;
  }
  const delay = targetOffset < 0 ? -targetOffset / rate : 0;
  vocalStartContextTime = audioCtx.currentTime + delay;
  vocalStartBufferOffset = Math.max(0, targetOffset);
  vocalBufferSource.start(vocalStartContextTime, vocalStartBufferOffset);
  lastVideoSyncCheck = performance.now();
  monitorVideoSync();
}

async function startVideoMixWhenReady() {
  const request = ++videoMixStartRequest;
  initialiseAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (
    request !== videoMixStartRequest
    || videoEl.paused
    || videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    || !vocalBuffer
  ) return;
  startVocalForVideo();
}

function monitorVideoSync(timestamp = performance.now()) {
  if (videoEl.paused || !vocalBufferSource || !vocalBuffer) return;
  if (timestamp - lastVideoSyncCheck >= 180 && audioCtx.currentTime >= vocalStartContextTime) {
    const actualOffset = vocalStartBufferOffset
      + (audioCtx.currentTime - vocalStartContextTime) * (videoEl.playbackRate || 1);
    const expectedOffset = videoEl.currentTime - sourceTimelineOffset();
    if (expectedOffset >= 0 && Math.abs(actualOffset - expectedOffset) > 0.045) {
      startVocalForVideo();
      return;
    }
    lastVideoSyncCheck = timestamp;
  }
  videoSyncFrame = requestAnimationFrame(monitorVideoSync);
}

function stopAudioSync() {
  if (audioSyncFrame) cancelAnimationFrame(audioSyncFrame);
  audioSyncFrame = null;
  originalAudio.playbackRate = vocalAudio.playbackRate || 1;
}

function syncOriginalAudio(force = false) {
  // currentTime の変更は非同期シークになる。シーク中に毎フレーム
  // currentTime を設定し直すと完了が先延ばしになり、STAGE 側だけが
  // 遅れて聞こえるため、進行中のシークは必ず完了させる。
  if (originalAudio.seeking || originalAudio.readyState === 0) return;
  const target = Math.min(
    Math.max(0, vocalAudio.currentTime + sourceTimelineOffset()),
    Number.isFinite(originalAudio.duration) ? originalAudio.duration : Infinity,
  );
  const drift = target - originalAudio.currentTime;
  if ((force && Math.abs(drift) > 0.012) || Math.abs(drift) > 0.35) {
    originalAudio.currentTime = target;
    originalAudio.playbackRate = vocalAudio.playbackRate || 1;
  } else if (Math.abs(drift) > 0.012) {
    // 小さなズレは再シークせず、短時間の速度補正で静かに追いつかせる。
    const correction = Math.max(0.94, Math.min(1.06, 1 + drift * 0.6));
    originalAudio.playbackRate = (vocalAudio.playbackRate || 1) * correction;
  } else {
    originalAudio.playbackRate = vocalAudio.playbackRate || 1;
  }
}

function monitorAudioSync() {
  audioSyncFrame = null;
  if (vocalAudio.paused) return;
  syncOriginalAudio();
  audioSyncFrame = requestAnimationFrame(monitorAudioSync);
}

function startAudioSyncMonitor() {
  if (audioSyncFrame) cancelAnimationFrame(audioSyncFrame);
  audioSyncFrame = requestAnimationFrame(monitorAudioSync);
}

videoEl.addEventListener('play', () => {
  vocalAudio.pause();
  startVideoMixWhenReady().catch(console.error);
});

// play は再生要求の時点で発火するため、映像音声が実際に動き始める
// playing を基準に差分音声を開始する。これでバッファ開始時のズレを防ぐ。
videoEl.addEventListener('playing', () => {
  startVideoMixWhenReady().catch(console.error);
});

videoEl.addEventListener('pause', stopVocal);
videoEl.addEventListener('seeking', stopVocal);
videoEl.addEventListener('waiting', stopVocal);
videoEl.addEventListener('stalled', stopVocal);
vocalAudio.addEventListener('play', () => {
  videoEl.pause();
  stopVocal();
  stopAudioSync();
  syncOriginalAudio(true);
  originalAudio.playbackRate = vocalAudio.playbackRate;
  originalAudio.play().then(() => {
    // play() の待機中に進んだ分は、再シークせず速度補正へ渡す。
    syncOriginalAudio();
  }).catch(() => {
    log('ステージ音源を同時再生できませんでした。もう一度再生してください。', 'error');
  });
  startAudioSyncMonitor();
});
vocalAudio.addEventListener('pause', () => { originalAudio.pause(); stopAudioSync(); });
vocalAudio.addEventListener('ended', () => { originalAudio.pause(); stopAudioSync(); });
vocalAudio.addEventListener('seeking', () => { originalAudio.pause(); stopAudioSync(); });
vocalAudio.addEventListener('seeked', () => {
  syncOriginalAudio(true);
  if (!vocalAudio.paused) {
    originalAudio.play().catch(() => {});
    startAudioSyncMonitor();
  }
});
vocalAudio.addEventListener('ratechange', () => {
  originalAudio.playbackRate = vocalAudio.playbackRate;
});
videoEl.addEventListener('seeked', () => {
  if (!videoEl.paused && videoEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && vocalBuffer) {
    startVideoMixWhenReady().catch(console.error);
  }
});
videoEl.addEventListener('ratechange', () => {
  if (!videoEl.paused && vocalBuffer) startVideoMixWhenReady().catch(console.error);
});
videoEl.addEventListener('ended', stopVocal);
mixSlider.addEventListener('input', () => {
  const value = Number(mixSlider.value);
  mixVal.value = value.toFixed(2);
  postMixSlider.value = String(value);
  updatePostMixDisplay();
  vocalAudio.volume = value;
  originalAudio.volume = 1 - value;
  if (audioCtx && vocalGain) vocalGain.gain.setValueAtTime(value, audioCtx.currentTime);
  if (audioCtx && videoGain) videoGain.gain.setValueAtTime(1 - value, audioCtx.currentTime);
});

reextractBtn.addEventListener('click', async () => {
  if (!storedVideoAudioFilename || !storedKaraokeFilename) {
    log('再抽出には、歌声入りステージ映像と比較用のMV・公式音源の両方が必要です。', 'error');
    return;
  }
  const nextStrength = Math.min(3, Math.round((extractionStrength + 0.1) * 100) / 100);
  if (nextStrength === extractionStrength) {
    log('これ以上は強くできません。', 'error');
    return;
  }
  extractionStrength = nextStrength;
  scaleVal.value = extractionStrength.toFixed(2);
  setBusy(reextractBtn, true, '差分を強くして再抽出中…');
  setProgress(0, '位置合わせ結果を使って再抽出しています', true);
  log(`差分抽出強度を ${extractionStrength.toFixed(2)} にして再抽出しています。`, 'working');
  try {
    const response = await fetch(apiUrl('/extract'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_audio_filename: storedVideoAudioFilename,
        video_filename: storedVideoFilename,
        karaoke_filename: storedKaraokeFilename,
        scale_factor: extractionStrength,
      }),
    });
    const payload = await readJson(response);
    if (payload.error) throw new Error(payload.error);
    storeVocalVariants(payload);
    const activeVocalUrl = selectedVocalUrl();
    const audioResponse = await fetch(activeVocalUrl);
    vocalBuffer = await audioCtx.decodeAudioData(await audioResponse.arrayBuffer());
    vocalAudio.src = activeVocalUrl;
    vocalAudio.load();
    updateVariantDownloadLinks();
    storedOffsetSeconds = Number(payload.offset_seconds || 0);
    stopVocal();
    createVocalSource();
    log('再抽出が完了しました。生歌の差分を再生して確認してください。', 'success');
    finishProgress('再抽出が完了しました');
  } catch (error) {
    console.error(error);
    log(`再抽出に失敗しました: ${error.message}`, 'error');
    failProgress('再抽出に失敗しました');
  } finally {
    setBusy(reextractBtn, false);
  }
});

mixSlider.dispatchEvent(new Event('input'));

const policyOpenButtons = document.querySelectorAll('[data-policy-open]');
const policyCloseButtons = document.querySelectorAll('[data-policy-close]');
const policyDialogs = document.querySelectorAll('.policy-dialog');
let policyReturnFocus = null;

function finishPolicyClose() {
  if (![...policyDialogs].some((dialog) => dialog.hasAttribute('open'))) {
    document.body.classList.remove('policy-dialog-open');
  }
  if (policyReturnFocus instanceof HTMLElement) policyReturnFocus.focus();
  policyReturnFocus = null;
}

function closePolicyDialog(dialog) {
  if (!(dialog instanceof HTMLElement) || dialog.tagName !== 'DIALOG') return;
  if (dialog.hasAttribute('open') && typeof dialog.close === 'function') dialog.close();
  else {
    dialog.removeAttribute('open');
    finishPolicyClose();
  }
}

policyOpenButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const dialog = document.getElementById(button.dataset.policyOpen || '');
    if (!(dialog instanceof HTMLElement) || dialog.tagName !== 'DIALOG') return;
    policyReturnFocus = button;
    document.body.classList.add('policy-dialog-open');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
});

policyCloseButtons.forEach((button) => {
  button.addEventListener('click', () => closePolicyDialog(button.closest('.policy-dialog')));
});

policyDialogs.forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closePolicyDialog(dialog);
  });
  dialog.addEventListener('close', finishPolicyClose);
});
