import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-log/main', () => ({
  default: { transports: { file: {}, console: {} }, hooks: [], scope: () => ({}) },
}));

const { redact } = await import('../src/main/logger');

// Built at runtime so no token-shaped literal lives in the repo (keeps secret scanners quiet).
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = `${b64({ alg: 'HS256' })}.${b64({ sub: 'test-user-0000' })}.${'x'.repeat(16)}`;

describe('log redaction', () => {
  it.each([
    ['JWT', `token ${fakeJwt}`, fakeJwt.slice(0, 12)],
    ['Supabase secret key', 'key=sb_secret_FAKEfakeFAKEfake0000', 'FAKEfake'],
    ['Supabase publishable key', 'sb_publishable_FAKEfakeFAKEfake0000', 'FAKEfake'],
    ['Bearer header', 'Authorization: Bearer abc.def.ghi-123', 'abc.def'],
    ['refresh_token JSON', '{"refresh_token":"v1.MRq8f9aZ"}', 'MRq8f9aZ'],
    ['email', 'user owner@example.com signed in', 'owner@example.com'],
    ['token in URL', 'GET https://x.test/cb?access_token=abc123&x=1', 'abc123'],
  ])('removes %s', (_name, input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
  });

  it('keeps ordinary diagnostic text intact', () => {
    expect(redact('sync offline {"error":"TypeError"} id=0a1b2c3d')).toBe(
      'sync offline {"error":"TypeError"} id=0a1b2c3d',
    );
  });
});
