// Password hashing using Web Crypto PBKDF2-SHA256 (available natively in the
// Workers runtime — no external deps, no plaintext ever touches storage).
// Also used identically from Node (scripts/generate-seed.mjs) since Node 19+
// exposes the same `crypto.subtle` global.

// Capped at 100000 — the maximum PBKDF2 iteration count the Cloudflare
// Workers runtime's WebCrypto implementation allows (higher values throw
// "NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
// supported" at verify time in production, even though Node has no such cap).
const ITERATIONS = 100000;
const KEY_LENGTH_BITS = 256;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export function randomSaltHex() {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return toHex(salt);
}

export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: fromHex(saltHex),
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_LENGTH_BITS
  );
  return toHex(derived);
}

export async function verifyPassword(password, saltHex, expectedHashHex) {
  const actual = await hashPassword(password, saltHex);
  return timingSafeEqualHex(actual, expectedHashHex);
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toHex(arr);
}
