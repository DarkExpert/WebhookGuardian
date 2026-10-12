import { createHmac, timingSafeEqual } from 'node:crypto';

export function requireSecret(secret: string | undefined): string {
  if (!secret || !secret.trim() || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('MOCK_WEBHOOK_SECRET must contain at least 32 UTF-8 bytes and not be whitespace-only');
  }
  return secret;
}

// v1 is the signature format version, independent of the event schema version.
export function verifySignature(body: Buffer, header: unknown, secret: string): boolean {
  if (typeof header !== 'string' || !/^v1=[0-9a-fA-F]{64}$/.test(header)) return false;
  const supplied = Buffer.from(header.slice(3), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(supplied, expected);
}
