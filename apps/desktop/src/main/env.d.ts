/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public project URL, baked in at build time. */
  readonly MAIN_VITE_SUPABASE_URL?: string;
  /** Publishable (public, RLS-bound) key, baked in at build time. Never the secret/service key. */
  readonly MAIN_VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
