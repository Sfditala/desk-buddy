// Full flow against a LOCAL Supabase stack (never production):
//   bot RPC (what n8n calls) -> Postgres -> Realtime -> desktop alert -> Done/Snooze -> Postgres
//
// Prereqs: `npm run db:start` at the repo root, then build the app against the local stack:
//   MAIN_VITE_SUPABASE_URL=http://127.0.0.1:54321 MAIN_VITE_SUPABASE_PUBLISHABLE_KEY=<local publishable> npm run build
// Run:  xvfb-run -a node e2e/sync.mjs
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'e2e', 'artifacts');
mkdirSync(artifacts, { recursive: true });

const status = JSON.parse(
  execFileSync('npx', ['supabase', 'status', '-o', 'json'], {
    cwd: join(root, '..', '..'),
    encoding: 'utf8',
  }),
);
assert.match(status.API_URL, /^http:\/\/127\.0\.0\.1/, 'refusing to run against a non-local stack');
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const psql = (q) =>
  execFileSync(
    'docker',
    ['exec', '-i', 'supabase_db_desk-buddy', 'psql', '-U', 'postgres', '-At', '-c', q],
    {
      encoding: 'utf8',
    },
  ).trim();

// Owner account + Telegram link (what the one-time production setup does).
const email = `owner-${Date.now()}@test.local`;
const { data: created, error: cErr } = await admin.auth.admin.createUser({
  email,
  email_confirm: true,
});
if (cErr) throw cErr;
const userId = created.user.id;
const chatId = Math.floor(Math.random() * 1e12);
psql(`insert into private.telegram_links (chat_id, user_id) values (${chatId}, '${userId}')`);

const results = [];
const check = async (name, fn) => {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push(['PASS', name, detail ?? `${Date.now() - t} ms`]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
};

const args = [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'deskbuddy-e2e-'))}`];
if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox');
const app = await electron.launch({
  args,
  env: { ...process.env, NODE_ENV: 'test' },
  timeout: 30_000,
});

const pageWithUrl = async (part) => {
  for (let i = 0; i < 100; i++) {
    const p = app.windows().find((w) => w.url().includes(part));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no window ${part}`);
};

try {
  await check('login window opens when signed out; email-code sign-in works', async () => {
    const login = await pageWithUrl('login.html');
    await login.fill('#email', email);
    await login.click('#email-form button[type=submit]');
    await login.waitForSelector('#code-form:not([hidden])');
    // In production the code arrives by email; locally we mint one with the admin API.
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw error;
    await login.screenshot({ path: join(artifacts, 'sync-1-login.png') });
    await login.fill('#code', data.properties.email_otp);
    await login.click('#code-form button[type=submit]');
    await login.waitForSelector('#ok:not([hidden])', { timeout: 10_000 });
  });

  await check('device registered for this session', async () => {
    for (let i = 0; i < 50; i++) {
      const n = Number(
        psql(
          `select count(*) from public.devices where user_id='${userId}' and revoked_at is null`,
        ),
      );
      if (n === 1) return '1 active device';
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('device row not created');
  });

  const pet = await pageWithUrl('index.html');
  await pet.waitForTimeout(2_000); // let Realtime join

  let firstId;
  await check('bot-created reminder alerts on the desktop at its due time', async () => {
    const dueIn = 6_000;
    const dueAt = new Date(Date.now() + dueIn);
    const { data, error } = await admin.rpc('bot_create_reminder', {
      p_chat_id: chatId,
      p_title: 'ذكّريني أتصل بماما ☎️',
      p_remind_at: dueAt.toISOString(),
      p_notes: 'created by the bot RPC',
    });
    if (error) throw error;
    firstId = data.id;
    await pet.waitForSelector('#bubble:not([hidden])', { timeout: dueIn + 10_000 });
    const lateMs = Date.now() - dueAt.getTime();
    assert.ok(lateMs >= -50, `alert fired early by ${-lateMs} ms`);
    assert.ok(lateMs < 3_000, `alert ${lateMs} ms late`);
    assert.equal(await pet.textContent('.bubble__title'), 'ذكّريني أتصل بماما ☎️');
    await pet.waitForTimeout(500);
    await pet.screenshot({ path: join(artifacts, 'sync-2-alert.png'), omitBackground: true });
    return `shown ${lateMs} ms after due time`;
  });

  await check('Done is written back to Supabase', async () => {
    await pet.click('button[data-action="done"]');
    for (let i = 0; i < 50; i++) {
      const s = psql(
        `select status || ',' || (acknowledged_at is not null) from public.reminders where id='${firstId}'`,
      );
      if (s === 'done,true') return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('status not updated');
  });

  await check('Snooze 10 min is written back to Supabase', async () => {
    const { data } = await admin.rpc('bot_create_reminder', {
      p_chat_id: chatId,
      p_title: 'Stand-up in 5',
      p_remind_at: new Date(Date.now() + 2_000).toISOString(),
    });
    await pet.waitForSelector('#bubble:not([hidden])', { timeout: 12_000 });
    await pet.click('button[data-action="snooze"]');
    for (let i = 0; i < 50; i++) {
      const s = psql(
        `select status || ',' || round(extract(epoch from snooze_until - now()) / 60) from public.reminders where id='${data.id}'`,
      );
      if (s === 'snoozed,10') return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('not snoozed');
  });

  await check('deleting from Telegram retracts an alert already on screen', async () => {
    const { data } = await admin.rpc('bot_create_reminder', {
      p_chat_id: chatId,
      p_title: 'will be deleted',
      p_remind_at: new Date(Date.now() + 1_500).toISOString(),
    });
    await pet.waitForSelector('#bubble:not([hidden])', { timeout: 12_000 });
    await admin.rpc('bot_delete_reminder', { p_chat_id: chatId, p_id: data.id });
    await pet.waitForSelector('#bubble[hidden]', { state: 'attached', timeout: 5_000 });
  });

  await check('revoking the device signs the app out and stops sync', async () => {
    psql(
      `update public.devices set revoked_at = now() where user_id='${userId}';
       delete from auth.sessions where user_id='${userId}';`,
    );
    // The next heartbeat (<= 30s poll) notices, wipes local data and reopens the login window.
    await pageWithUrl('login.html').catch(async () => {
      for (let i = 0; i < 400; i++) {
        if (app.windows().some((w) => w.url().includes('login.html'))) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('login window did not reopen');
    });
  });
} finally {
  await app.close().catch(() => undefined);
}

for (const [s, name, detail] of results) process.stdout.write(`${s}  ${name}\n      ${detail}\n`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
