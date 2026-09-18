# Regional Cloudflare resolver

This Worker is the account-free network layer for the URL-only web app. The Python application calls `/audio`; users do not install an extension or sign in to Google.

The coordinator tries stable Durable Object instances in `apac-ne`, `apac-se`, `weur`, and `enam`. Each object performs the complete network-sensitive sequence in one location:

1. fetch the public YouTube watch/player response;
2. select an audio-only format;
3. ask the Render service to apply the current YouTube player transform;
4. fetch and stream the resulting GoogleVideo response.

Location hints are best effort and apply when an object is first created. Increment `PLACEMENT_EPOCH` if the region layout changes so Cloudflare creates new objects.

## Configure and deploy

```powershell
npx wrangler secret put WORKER_TOKEN --config cloudflare-worker/wrangler.jsonc
npx wrangler secret put DECIPHER_TOKEN --config cloudflare-worker/wrangler.jsonc
npx wrangler deploy --config cloudflare-worker/wrangler.jsonc
```

Set the same `DECIPHER_TOKEN` on Render. Store `WORKER_TOKEN` only in the Python backend; it must not be exposed to browser JavaScript.

Smoke test (use a public video you are authorized to process):

```powershell
curl.exe -H "Authorization: Bearer YOUR_WORKER_TOKEN" -H "Range: bytes=0-1048575" "https://YOUR_WORKER.workers.dev/audio?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw" --output sample.bin
```

The successful response includes `X-Resolver-Region` and `X-Resolver-Itag`. A total failure returns sanitized per-region diagnostics and never exposes a GoogleVideo URL.
