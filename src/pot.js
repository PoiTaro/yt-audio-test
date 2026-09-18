import { BotGuardClient } from 'bgutils-js/botguard';
import { buildURL, getHeaders, parseLooseJSON, USER_AGENT } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';
import { Platform } from 'youtubei.js';

const YOUTUBE_HOME = 'https://www.youtube.com';
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

function installBrowserGlobals(dom, config) {
  dom.window.yt = { config_: config };
  Object.assign(globalThis, {
    yt: dom.window.yt,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
  }
}

export async function createWebPoMinter() {
  Platform.shim.eval = async (data) => new Function(data.output)();

  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head></head><body></body></html>', {
    url: YOUTUBE_HOME,
    referrer: `${YOUTUBE_HOME}/`,
    userAgent: USER_AGENT,
  });
  const pageResponse = await fetch(YOUTUBE_HOME, {
    headers: {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.7',
      'user-agent': USER_AGENT,
    },
  });
  if (!pageResponse.ok) throw new Error(`YouTube homepage returned HTTP ${pageResponse.status}`);

  const pageHtml = await pageResponse.text();
  const configText = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
  if (!configText) throw new Error('YouTube homepage did not contain ytcfg');
  installBrowserGlobals(dom, JSON.parse(configText));

  const initialDataText = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/)?.[1];
  if (!initialDataText) throw new Error('YouTube homepage did not contain a BotGuard challenge');
  const challengeResponse = parseLooseJSON(initialDataText).R;
  if (!challengeResponse?.bgChallenge) throw new Error('BotGuard challenge payload was missing');

  const interpreterPath = challengeResponse.bgChallenge.interpreterUrl
    ?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  if (!interpreterPath) throw new Error('BotGuard challenge did not contain an interpreter URL');
  const scriptResponse = await fetch(`https:${interpreterPath}`);
  if (!scriptResponse.ok) throw new Error(`BotGuard interpreter returned HTTP ${scriptResponse.status}`);
  const interpreterJavascript = await scriptResponse.text();
  new Function(interpreterJavascript)();

  const botGuardClient = await BotGuardClient.create({
    program: challengeResponse.bgChallenge.program,
    globalName: challengeResponse.bgChallenge.globalName,
    globalObject: globalThis,
  });
  const webPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

  const integrityResponse = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!integrityResponse.ok) {
    throw new Error(`GenerateIT returned HTTP ${integrityResponse.status}`);
  }
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
    await integrityResponse.json();

  return WebPoMinter.create({
    integrityToken,
    estimatedTtlSecs,
    mintRefreshThreshold,
    websafeFallbackToken,
  }, webPoSignalOutput);
}
