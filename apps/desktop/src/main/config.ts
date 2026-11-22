import { app } from 'electron';
import { z } from 'zod';

const Config = z.object({
  supabaseUrl: z.url(),
  supabaseKey: z
    .string()
    .min(20)
    // Defence in depth: a secret/service key must never ship in the desktop app.
    .refine((k) => !k.startsWith('sb_secret_') && !isServiceRoleJwt(k), {
      message: 'refusing to use a secret/service-role key in the desktop app',
    }),
});
export type Config = z.infer<typeof Config>;

function isServiceRoleJwt(key: string): boolean {
  const payload = key.split('.')[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role?: unknown;
    };
    return claims.role === 'service_role';
  } catch {
    return false;
  }
}

/** Returns null when the build has no backend configured (the app then runs pet-only). */
export function loadConfig(): Config | null {
  const raw = {
    supabaseUrl: import.meta.env.MAIN_VITE_SUPABASE_URL,
    supabaseKey: import.meta.env.MAIN_VITE_SUPABASE_PUBLISHABLE_KEY,
  };
  if (!raw.supabaseUrl || !raw.supabaseKey) return null;
  const cfg = Config.parse(raw);
  const url = new URL(cfg.supabaseUrl);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (app.isPackaged && (url.protocol !== 'https:' || local)) {
    throw new Error('packaged builds must use an https Supabase URL');
  }
  return cfg;
}
