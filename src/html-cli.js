#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Innertube, Platform } from 'youtubei.js';
import { classifyError, extractVideoId, probeHttp, runFfmpeg } from './core.js';
import { extractInitialPlayerResponse, selectHtmlAudioFormat } from './html.js';

const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36';

Platform.shim.eval = async (data) => new Function(data.output)();

async function main() {
  const videoId = extractVideoId(process.argv[2] || 'jNQXAC9IVRw');
  const outputDirectory = path.resolve(process.argv[3] || 'output-html');
  await mkdir(outputDirectory, { recursive: true });
  const result = {
    videoId,
    startedAt: new Date().toISOString(),
    watchPageStatus: null,
    watchPageBytes: 0,
    playability: null,
    formats: 0,
    selectedFormat: null,
    deciphered: false,
    googlevideo: null,
    ffmpeg: null,
    success: false,
    error: null,
  };

  try {
    const watchResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'user-agent': MOBILE_USER_AGENT,
        'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const html = await watchResponse.text();
    result.watchPageStatus = watchResponse.status;
    result.watchPageBytes = Buffer.byteLength(html);
    const playerResponse = extractInitialPlayerResponse(html);
    result.playability = {
      status: playerResponse.playabilityStatus?.status ?? null,
      reason: playerResponse.playabilityStatus?.reason ?? null,
    };
    if (result.playability.status !== 'OK') {
      const error = new Error(result.playability.reason || `Playability: ${result.playability.status}`);
      error.code = result.playability.status || 'UNPLAYABLE';
      throw error;
    }

    const formats = playerResponse.streamingData?.adaptiveFormats ?? [];
    result.formats = formats.length;
    const format = selectHtmlAudioFormat(playerResponse);
    result.selectedFormat = {
      itag: format.itag,
      mime: format.mimeType,
      bitrate: format.averageBitrate ?? format.bitrate ?? null,
      hasDirectUrl: Boolean(format.url),
    };

    const youtube = await Innertube.create({
      generate_session_locally: true,
      enable_session_cache: false,
      retrieve_innertube_config: false,
    });
    const streamUrl = await youtube.session.player.decipher(format.url, format.signatureCipher, format.cipher);
    result.deciphered = Boolean(streamUrl);
    result.googlevideo = await probeHttp(streamUrl, 20_000);
    if (!result.googlevideo.success) throw Object.assign(new Error(result.googlevideo.error?.message || 'GoogleVideo probe failed'), result.googlevideo.error);

    const outputFile = path.join(outputDirectory, `${videoId}_HTML_3s.wav`);
    result.ffmpeg = await runFfmpeg(streamUrl, outputFile, 3, 45_000, result.selectedFormat.bitrate ?? 192_000);
    if (!result.ffmpeg.success) throw Object.assign(new Error(result.ffmpeg.error?.message || 'FFmpeg failed'), result.ffmpeg.error);
    result.success = true;
  } catch (error) {
    result.error = classifyError(error);
  }
  result.completedAt = new Date().toISOString();
  const reportFile = path.join(outputDirectory, `html-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(reportFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ reportFile, result }, null, 2));
  process.exitCode = result.success ? 0 : 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

