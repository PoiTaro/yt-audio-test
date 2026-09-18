import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

export const INTERNAL_SIGNATURE_PUBLIC_JWK = Object.freeze({
  kty: 'EC',
  x: 'b2knW-trbiUqA0TefFt6KdS88WQAO_2UX8VZIGTzKcg',
  y: 'u_Y1QENU9zf392J2vs6oeHWd2kZyitT--bziQ3v41_4',
  crv: 'P-256',
});

const PUBLIC_KEY = createPublicKey({ key: INTERNAL_SIGNATURE_PUBLIC_JWK, format: 'jwk' });

export function internalSignatureMessage(timestamp, nonce, pathname, rawBody) {
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  return `${timestamp}\n${nonce}\n${pathname}\n${bodyHash}`;
}

export function verifyInternalSignature({
  timestamp,
  nonce,
  pathname,
  rawBody,
  signature,
  nowSeconds = Math.floor(Date.now() / 1_000),
  maxClockSkewSeconds = 120,
  publicKey = PUBLIC_KEY,
}) {
  if (!/^\d{10}$/u.test(timestamp || '')) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(nonce || '')) {
    return false;
  }
  const requestTime = Number(timestamp);
  if (!Number.isSafeInteger(requestTime) || Math.abs(nowSeconds - requestTime) > maxClockSkewSeconds) {
    return false;
  }
  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature || '', 'base64url');
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;
  const message = internalSignatureMessage(timestamp, nonce, pathname, rawBody);
  return verifySignature(
    'sha256',
    Buffer.from(message),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signatureBytes,
  );
}
