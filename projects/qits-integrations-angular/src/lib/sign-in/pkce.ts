/**
 * PKCE (RFC 7636) for the bearer sign-in (`qits-tokens.ts`): a random verifier, and its S256
 * challenge.
 */

/** Bytes as base64url, without padding. */
export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `size` random bytes as base64url. 32 bytes give a 43-character verifier, the shortest allowed. */
export function randomToken(size = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

/** The S256 challenge: base64url(SHA-256(ASCII(verifier))). */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
