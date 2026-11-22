import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

interface LocalStatus {
  API_URL: string;
  DB_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

let cached: LocalStatus | null = null;

/** Reads the LOCAL stack's URL/keys. Refuses to run against anything that is not localhost. */
export function local(): LocalStatus {
  if (cached) return cached;
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
    cwd: new URL('../..', import.meta.url).pathname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const json = JSON.parse(out.slice(out.indexOf('{'))) as LocalStatus;
  const host = new URL(json.API_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`refusing to run DB tests against non-local Supabase (${host})`);
  }
  cached = json;
  return json;
}

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;

export function anon(): SupabaseClient {
  return createClient(local().API_URL, local().ANON_KEY, noPersist);
}

export function service(): SupabaseClient {
  return createClient(local().API_URL, local().SERVICE_ROLE_KEY, noPersist);
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export async function createUser(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID().slice(0, 8)}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const { data, error } = await service().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return { id: data.user.id, email, password };
}

/** A fresh Auth session (= a fresh "device") for the user. */
export async function signIn(user: TestUser): Promise<SupabaseClient> {
  const client = anon();
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  if (error) throw error;
  return client;
}

export async function device(user: TestUser, name = 'test-desktop'): Promise<SupabaseClient> {
  const client = await signIn(user);
  const { error } = await client.rpc('register_device', { p_name: name, p_kind: 'desktop' });
  if (error) throw error;
  return client;
}

export function linkChat(user: TestUser): number {
  const chatId = Math.floor(Math.random() * 1e12);
  sql(`insert into private.telegram_links (chat_id, user_id) values (${chatId}, '${user.id}')`);
  return chatId;
}

/** Runs SQL as postgres through psql inside the db container (test setup only). */
export function sql(query: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_desk-buddy',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  ).trim();
}

export const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
