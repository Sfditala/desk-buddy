/**
 * Accepts the sign-in link from Supabase's email (as an alternative to typing the 6-digit code).
 * Only links that point at *our* project's `/auth/v1/verify` endpoint are accepted; the token is
 * then verified in-app with `verifyOtp({ token_hash })`, so the browser never has to open it.
 */
export interface SignInLink {
  tokenHash: string;
  type: 'magiclink' | 'email';
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function parseSignInLink(input: string, supabaseUrl: string): SignInLink | null {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(input.trim());
    expected = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if (url.origin !== expected.origin) return null;
  if (!url.pathname.endsWith('/auth/v1/verify')) return null;
  const token = url.searchParams.get('token') ?? '';
  const type = url.searchParams.get('type');
  if (!TOKEN_RE.test(token)) return null;
  if (type !== 'magiclink' && type !== 'email') return null;
  return { tokenHash: token, type };
}

export function isSixDigitCode(input: string): boolean {
  return /^\d{6}$/.test(input.trim());
}
