import { base64Url, randomToken, s256Challenge } from './pkce';

describe('PKCE', () => {
  it('derives the S256 challenge of RFC 7636, appendix B', async () => {
    expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes a 43-character base64url verifier', () => {
    const verifier = randomToken();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(verifier);
  });

  it('writes base64url without padding', () => {
    expect(base64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });
});
