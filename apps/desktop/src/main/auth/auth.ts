import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config';
import { fetchWithTimeout } from '../http';
import { scoped } from '../logger';
import type { SecureStore } from '../secure-store';

// Untyped schema on purpose: rows are validated with zod at the boundary (see sync/engine.ts).
type Client = SupabaseClient;

const log = scoped('auth');
const AUTH_KEY = 'auth-session';
const CODE_COOLDOWN_MS = 30_000;

export type AuthState = { signedIn: false } | { signedIn: true; account: string };

/** "safadi@gmail.com" -> "s•••@gmail.com" for the tray; the full address is never logged. */
export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}•••@${domain}`;
}

/**
 * Supabase Auth in the main process. The session (access + refresh token) is persisted only
 * through SecureStore (OS-encrypted). Sign-in is a 6-digit email code for an existing user:
 * `shouldCreateUser: false`, and sign-ups are disabled on the project.
 */
export class AuthManager {
  readonly client: Client;
  private lastCodeAt = 0;
  private readonly listeners = new Set<(s: AuthState) => void>();

  constructor(cfg: Config, store: SecureStore) {
    this.client = createClient<unknown>(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: {
        storageKey: AUTH_KEY,
        storage: {
          getItem: (k) => store.get(k),
          setItem: (k, v) => {
            store.set(k, v);
          },
          removeItem: (k) => {
            store.remove(k);
          },
        },
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
      global: {
        fetch: fetchWithTimeout(15_000),
        headers: { 'x-client-info': 'desk-buddy-desktop' },
      },
      realtime: { heartbeatIntervalMs: 15_000 },
    });
    this.client.auth.onAuthStateChange((event, session) => {
      log.info('auth event', { event });
      this.emit(session);
    });
  }

  async current(): Promise<AuthState> {
    const { data } = await this.client.auth.getSession();
    return toState(data.session);
  }

  onChange(cb: (s: AuthState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async requestCode(email: string): Promise<{ ok: boolean; error?: string }> {
    if (Date.now() - this.lastCodeAt < CODE_COOLDOWN_MS) {
      return { ok: false, error: 'Please wait 30 seconds before requesting another code.' };
    }
    this.lastCodeAt = Date.now();
    const { error } = await this.client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) {
      log.warn('code request failed', { status: error.status, code: error.code });
      // Same message whether or not the account exists (no account enumeration).
      if (error.status === 429) return { ok: false, error: 'Too many attempts. Try again later.' };
    }
    return { ok: true };
  }

  async verify(email: string, code: string): Promise<{ ok: boolean; error?: string }> {
    const { error } = await this.client.auth.verifyOtp({ email, token: code, type: 'email' });
    if (error) {
      log.warn('code verification failed', { status: error.status, code: error.code });
      return { ok: false, error: 'That code is invalid or expired.' };
    }
    return { ok: true };
  }

  /** Ends this device's session server-side and wipes the local copy. */
  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) log.warn('server sign-out failed, cleared locally', { code: error.code });
  }

  private emit(session: Session | null): void {
    const state = toState(session);
    for (const l of this.listeners) l(state);
  }
}

function toState(session: Session | null): AuthState {
  if (!session?.user.email) return { signedIn: false };
  return { signedIn: true, account: maskEmail(session.user.email) };
}
