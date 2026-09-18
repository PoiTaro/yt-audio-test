#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  SUPPORTED_CLIENTS,
  buildSummary,
  createResolver,
  extractVideoId,
  probeClient,
} from './core.js';

function usage() {
  return `
YouTube audio-only stream probe (yt-dlp不使用)

Usage:
  npm run probe -- <YouTube URL or Video ID> [more URLs...] [options]

Options:
  --clients auto              ANDROID_VR → IOS → WEB の順で成功まで試す（既定）
  --clients A,B               指定クライアントをすべて比較する
  --seconds N                 FFmpeg変換秒数（既定: 10）
  --output DIR                出力先（既定: output）
  --http-timeout MS           HTTP確認タイムアウト（既定: 15000）
  --ffmpeg-timeout MS         FFmpegタイムアウト（既定: 45000）
  --skip-http                 GoogleVideo HTTP確認を省略
  --skip-ffmpeg               WAV変換を省略
  --json-only                 進捗ログを抑止
  --help                      このヘルプを表示

Supported clients: ${SUPPORTED_CLIENTS.join(', ')}
`;
}

function parseArgs(argv) {
  const options = {
    inputs: [],
    clients: ['ANDROID_VR', 'IOS', 'WEB'],
    auto: true,
    seconds: 10,
    output: 'output',
    httpTimeoutMs: 15_000,
    ffmpegTimeoutMs: 45_000,
    skipHttp: false,
    skipFfmpeg: false,
    jsonOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} の値がありません。`);
      return argv[index];
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--clients') {
      const value = next();
      options.auto = value.toLowerCase() === 'auto';
      options.clients = options.auto ? ['ANDROID_VR', 'IOS', 'WEB'] : value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
    } else if (arg === '--seconds') options.seconds = Number(next());
    else if (arg === '--output') options.output = next();
    else if (arg === '--http-timeout') options.httpTimeoutMs = Number(next());
    else if (arg === '--ffmpeg-timeout') options.ffmpegTimeoutMs = Number(next());
    else if (arg === '--skip-http') options.skipHttp = true;
    else if (arg === '--skip-ffmpeg') options.skipFfmpeg = true;
    else if (arg === '--json-only') options.jsonOnly = true;
    else if (arg.startsWith('-')) throw new Error(`不明なオプション: ${arg}`);
    else options.inputs.push(arg);
  }

  const invalidClients = options.clients.filter((client) => !SUPPORTED_CLIENTS.includes(client));
  if (invalidClients.length) throw new Error(`未対応クライアント: ${invalidClients.join(', ')}`);
  if (!Number.isFinite(options.seconds) || options.seconds <= 0 || options.seconds > 60) throw new Error('--seconds は1〜60で指定してください。');
  if (!Number.isFinite(options.httpTimeoutMs) || options.httpTimeoutMs < 1000) throw new Error('--http-timeout は1000ms以上で指定してください。');
  if (!Number.isFinite(options.ffmpegTimeoutMs) || options.ffmpegTimeoutMs < 1000) throw new Error('--ffmpeg-timeout は1000ms以上で指定してください。');
  return options;
}

function percentage(entry) {
  return `${entry.successes}/${entry.total} (${(entry.rate * 100).toFixed(1)}%)`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help || !options.inputs.length) {
    console.log(usage());
    process.exitCode = options.help ? 0 : 2;
    return;
  }

  const outputDirectory = path.resolve(options.output);
  const cacheDirectory = path.resolve('.cache', 'youtubei');
  await mkdir(outputDirectory, { recursive: true });
  const log = options.jsonOnly ? () => {} : (message) => console.error(message);

  log('youtubei.js sessionを初期化しています...');
  const youtube = await createResolver(cacheDirectory);
  const results = [];

  for (const input of options.inputs) {
    const videoId = extractVideoId(input);
    const entry = { input, videoId, attempts: [] };
    log(`\n=== ${videoId} ===`);

    for (const client of options.clients) {
      log(`\n[${client}]`);
      const attempt = await probeClient({
        youtube,
        videoId,
        client,
        outputDirectory,
        seconds: options.seconds,
        httpTimeoutMs: options.httpTimeoutMs,
        ffmpegTimeoutMs: options.ffmpegTimeoutMs,
        skipHttp: options.skipHttp,
        skipFfmpeg: options.skipFfmpeg,
        log: (message) => log(`  ${message}`),
      });
      entry.attempts.push(attempt);
      if (options.auto && attempt.success) break;
    }
    results.push(entry);
  }

  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ffmpegRequested: !options.skipFfmpeg,
    },
    options: {
      clients: options.clients,
      automaticFallback: options.auto,
      seconds: options.seconds,
      httpProbe: !options.skipHttp,
      ffmpegProbe: !options.skipFfmpeg,
    },
    results,
    summary: buildSummary(results),
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = path.join(outputDirectory, `probe-${stamp}.json`);
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (!options.jsonOnly) {
    log('\n=== Summary ===');
    log(`Full success: ${percentage(report.summary.fullSuccess)}`);
    log(`Direct URL:   ${percentage(report.summary.directUrl)}`);
    log(`GoogleVideo:  ${percentage(report.summary.googlevideo)}`);
    log(`FFmpeg:       ${percentage(report.summary.ffmpeg)}`);
    log(`JSON: ${reportFile}`);
  }
  console.log(JSON.stringify({ reportFile, summary: report.summary }, null, 2));
  process.exitCode = report.summary.fullSuccess.successes > 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
