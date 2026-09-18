import { DurableObject } from 'cloudflare:workers';
import { extractVideoId, resolveAndFetchMedia, serializeResolverError } from './resolver.js';

const DEFAULT_REGIONS = ['apac-ne', 'apac-se', 'weur', 'enam'];
const VALID_REGIONS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me']);

function json(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

function configuredRegions(env) {
  const requested = String(env.RESOLVER_REGIONS || DEFAULT_REGIONS.join(','))
    .split(',')
    .map((region) => region.trim())
    .filter((region) => VALID_REGIONS.has(region));
  return [...new Set(requested)].slice(0, 6);
}

function authorized(request, env) {
  return Boolean(env.WORKER_TOKEN) && request.headers.get('Authorization') === `Bearer ${env.WORKER_TOKEN}`;
}

export class RegionalResolver extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.resolutionCache = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const videoId = url.searchParams.get('videoId');
    const mediaType = url.searchParams.get('mediaType') === 'video' ? 'video' : 'audio';
    const region = request.headers.get('X-Resolver-Region') || 'unknown';
    if (!videoId) return json({ error: { code: 'MISSING_VIDEO_ID', message: 'videoId is required' }, region }, 400);
    if (!this.env.RENDER_DECIPHER_URL) {
      return json({ error: { code: 'MISSING_DECIPHER_URL', message: 'RENDER_DECIPHER_URL is not configured' }, region }, 503);
    }
    try {
      const cacheKey = `${mediaType}:${videoId}`;
      const cached = this.resolutionCache.get(cacheKey);
      const run = (cachedResolution) => resolveAndFetchMedia({
          videoId,
          mediaType,
          renderDecipherUrl: this.env.RENDER_DECIPHER_URL,
          decipherToken: this.env.DECIPHER_TOKEN,
          range: request.headers.get('Range'),
          cachedResolution,
        });
      let result;
      try {
        result = await run(cached?.expiresAt > Date.now() ? cached.resolution : null);
      } catch (error) {
        if (!cached) throw error;
        this.resolutionCache.delete(cacheKey);
        result = await run(null);
      }
      const expireSeconds = Number(new URL(result.resolution.streamUrl).searchParams.get('expire'));
      const expiresAt = Number.isFinite(expireSeconds)
        ? Math.min(expireSeconds * 1_000 - 60_000, Date.now() + 10 * 60_000)
        : Date.now() + 5 * 60_000;
      this.resolutionCache.set(cacheKey, { resolution: result.resolution, expiresAt });
      const headers = new Headers();
      for (const name of ['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified']) {
        const value = result.response.headers.get(name);
        if (value) headers.set(name, value);
      }
      headers.set('Content-Type', result.contentType);
      headers.set('Cache-Control', 'private, no-store');
      headers.set('X-Resolver-Region', region);
      if (result.diagnostics.format?.itag) headers.set('X-Resolver-Itag', String(result.diagnostics.format.itag));
      return new Response(result.response.body, { status: result.response.status, headers });
    } catch (error) {
      return json({ success: false, region, error: serializeResolverError(error) }, 502);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({
        status: 'ok',
        regions: configuredRegions(env),
        placementEpoch: env.PLACEMENT_EPOCH || 'v1',
        decipherConfigured: Boolean(env.RENDER_DECIPHER_URL),
        authConfigured: Boolean(env.WORKER_TOKEN),
      });
    }
    if (url.pathname !== '/audio' && url.pathname !== '/video') return json({ error: 'Not found' }, 404);
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);

    let videoId;
    try {
      videoId = extractVideoId(url.searchParams.get('url') || url.searchParams.get('videoId'));
    } catch (error) {
      return json({ error: serializeResolverError(error) }, 400);
    }
    const requestedRegion = url.searchParams.get('region');
    if (requestedRegion && !VALID_REGIONS.has(requestedRegion)) {
      return json({ error: 'Invalid resolver region' }, 400);
    }
    const regions = requestedRegion ? [requestedRegion] : configuredRegions(env);
    if (!regions.length) return json({ error: 'No valid resolver regions are configured' }, 503);

    const failures = [];
    for (const region of regions) {
      const objectName = `${env.PLACEMENT_EPOCH || 'v1'}:${region}`;
      const stub = env.REGIONAL_RESOLVER.getByName(objectName, { locationHint: region });
      const regionalUrl = new URL('https://regional-resolver.internal/resolve');
      regionalUrl.searchParams.set('videoId', videoId);
      regionalUrl.searchParams.set('mediaType', url.pathname === '/video' ? 'video' : 'audio');
      try {
        const response = await stub.fetch(regionalUrl, {
          headers: {
            ...(request.headers.get('Range') ? { Range: request.headers.get('Range') } : {}),
            'X-Resolver-Region': region,
          },
        });
        if (response.ok) return response;
        let body = {};
        try { body = await response.json(); } catch { /* Preserve the HTTP status below. */ }
        failures.push({ region, status: response.status, error: body.error || 'Unknown regional failure' });
      } catch (error) {
        failures.push({ region, status: null, error: serializeResolverError(error) });
      }
    }
    return json({
      success: false,
      videoId,
      error: 'All regional resolvers failed',
      attempts: failures,
    }, 502);
  },
};
