import { describe, expect, it } from 'vitest';
import { isSixDigitCode, parseSignInLink } from '../src/main/auth/sign-in-link';

const PROJECT = 'https://abcd1234.supabase.co';
// Synthetic, obviously-fake token (no entropy), so secret scanners do not flag the test.
const TOKEN = 'test_token_'.padEnd(40, 'x');
const link = (over: Partial<{ origin: string; path: string; token: string; type: string }> = {}) =>
  `${over.origin ?? PROJECT}${over.path ?? '/auth/v1/verify'}?token=${over.token ?? TOKEN}&type=${over.type ?? 'magiclink'}&redirect_to=http://localhost:3000`;

describe('parseSignInLink', () => {
  it('accepts the magic link from our project', () => {
    expect(parseSignInLink(link(), PROJECT)).toEqual({ tokenHash: TOKEN, type: 'magiclink' });
  });

  it('tolerates surrounding whitespace from copy/paste', () => {
    expect(parseSignInLink(`  ${link()}\n`, PROJECT)?.tokenHash).toBe(TOKEN);
  });

  it.each([
    ['another host', link({ origin: 'https://evil.example' })],
    ['a look-alike host', link({ origin: 'https://abcd1234.supabase.co.evil.example' })],
    ['plain http downgrade', link({ origin: 'http://abcd1234.supabase.co' })],
    ['another path', link({ path: '/auth/v1/recover' })],
    ['a recovery token', link({ type: 'recovery' })],
    ['a malformed token', link({ token: 'abc"><script>' })],
    ['not a URL', 'hello'],
  ])('rejects %s', (_name, input) => {
    expect(parseSignInLink(input, PROJECT)).toBeNull();
  });
});

describe('isSixDigitCode', () => {
  it.each([
    ['123456', true],
    [' 123456 ', true],
    ['12345', false],
    ['1234567', false],
    ['12a456', false],
  ])('%j -> %s', (input, expected) => {
    expect(isSixDigitCode(input)).toBe(expected);
  });
});
