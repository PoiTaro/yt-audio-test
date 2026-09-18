import { ProbeError } from './core.js';

const PLAYER_RESPONSE_MARKERS = [
  'var ytInitialPlayerResponse = ',
  'window["ytInitialPlayerResponse"] = ',
  "window['ytInitialPlayerResponse'] = ",
];

function parseJsonObjectAt(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      return JSON.parse(source.slice(start, index + 1));
    }
  }
  return null;
}

export function extractInitialPlayerResponse(html) {
  const candidates = [];
  for (const marker of PLAYER_RESPONSE_MARKERS) {
    let offset = 0;
    while (true) {
      const index = html.indexOf(marker, offset);
      if (index < 0) break;
      candidates.push({ index, marker });
      offset = index + marker.length;
    }
  }
  candidates.sort((a, b) => b.index - a.index);

  for (const candidate of candidates) {
    const valueStart = candidate.index + candidate.marker.length;
    const objectStart = html.indexOf('{', valueStart);
    if (objectStart < 0 || objectStart - valueStart > 32) continue;
    try {
      const parsed = parseJsonObjectAt(html, objectStart);
      if (parsed) return parsed;
    } catch {
      // Some pages contain an earlier placeholder assignment. Try the next candidate.
    }
  }
  throw new ProbeError('NO_PLAYER_RESPONSE', '視聴ページHTMLからPlayer応答を抽出できませんでした。');
}

export function selectHtmlAudioFormat(playerResponse) {
  const formats = (playerResponse?.streamingData?.adaptiveFormats ?? [])
    .filter((format) => format.mimeType?.startsWith('audio/') && (format.url || format.signatureCipher || format.cipher));
  if (!formats.length) {
    throw new ProbeError('NO_AUDIO_FORMAT', '視聴ページHTMLにaudio-only formatがありませんでした。');
  }
  return [...formats].sort((a, b) => {
    const drcScore = Number(Boolean(a.isDrc)) - Number(Boolean(b.isDrc));
    if (drcScore) return drcScore;
    return (b.averageBitrate ?? b.bitrate ?? 0) - (a.averageBitrate ?? a.bitrate ?? 0);
  })[0];
}

