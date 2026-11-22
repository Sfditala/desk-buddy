import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUser, device, linkChat, minutes, service, sql, type TestUser } from './env';

interface Row {
  id: string;
  status: string;
  remind_at: string;
  snooze_until: string | null;
  fired_at: string | null;
  repeat_anchor: string | null;
}

const fixtures = JSON.parse(
  readFileSync(new URL('../../packages/core/test/repeat-cases.json', import.meta.url), 'utf8'),
) as {
  timeZone: string;
  cases: { name: string; rule: string; anchor: string; after: string; expected: string | null }[];
  invalid: string[];
};

let owner: TestUser;
let chat: number;
let client: SupabaseClient;

/** Insert directly as postgres (bypasses bot validation) to set up scheduler states. */
function insertRaw(columns = '', values = ''): string {
  const id = sql(
    `insert into public.reminders (user_id, title, remind_at, source${columns ? `, ${columns}` : ''})
     values ('${owner.id}', 't', now() - interval '1 minute', 'api'${values ? `, ${values}` : ''})
     returning id`,
  ).split('\n')[0];
  if (!id) throw new Error('insert failed');
  return id;
}

async function row(id: string): Promise<Row> {
  const { data, error } = await service().from('reminders').select('*').eq('id', id).single();
  if (error) throw error;
  return data as Row;
}

beforeAll(async () => {
  owner = await createUser('sched');
  chat = linkChat(owner);
  client = await device(owner);
});

describe('next_occurrence in SQL matches the TypeScript fixtures', () => {
  it.each(fixtures.cases)('$name', ({ rule, anchor, after, expected }) => {
    const tz = fixtures.timeZone;
    const got = sql(
      `select to_char(public.next_occurrence('${rule}', '${anchor}'::timestamp at time zone '${tz}', '${after}'::timestamp at time zone '${tz}', '${tz}') at time zone '${tz}', 'YYYY-MM-DD HH24:MI')`,
    );
    expect(got === '' ? null : got).toBe(expected);
  });

  it.each(fixtures.invalid)('rejects %j', (rule) => {
    expect(sql(`select public.is_valid_repeat_rule($$${rule}$$)`)).toBe('f');
  });
});

describe('fire_due_reminders', () => {
  it('fires due pending and due snoozed reminders exactly once', async () => {
    const pending = insertRaw();
    const snoozed = insertRaw('status, snooze_until', `'snoozed', now() - interval '10 seconds'`);
    const future = insertRaw('status', `'pending'`);
    sql(`update public.reminders set remind_at = now() + interval '1 hour' where id = '${future}'`);

    // Two concurrent scheduler runs must not double-fire (FOR UPDATE SKIP LOCKED).
    const [a, b] = await Promise.all([
      service().rpc('fire_due_reminders'),
      service().rpc('fire_due_reminders'),
    ]);
    const fired = [...(a.data as { id: string }[]), ...(b.data as { id: string }[])].map(
      (r) => r.id,
    );
    expect(fired.filter((id) => id === pending)).toHaveLength(1);
    expect(fired.filter((id) => id === snoozed)).toHaveLength(1);
    expect(fired).not.toContain(future);

    expect((await row(pending)).status).toBe('fired');
    const s = await row(snoozed);
    expect(s.status).toBe('fired');
    expect(s.snooze_until).toBeNull();
    expect((await row(future)).status).toBe('pending');

    const again = await service().rpc('fire_due_reminders');
    expect((again.data as { id: string }[]).map((r) => r.id)).not.toContain(pending);
  });

  it('returns the owner chat id for a Telegram backup notification', async () => {
    const id = insertRaw();
    const { data } = await service().rpc('fire_due_reminders');
    const hit = (data as { id: string; chat_id: number; kind: string }[]).find((r) => r.id === id);
    expect(hit).toMatchObject({ chat_id: chat, kind: 'due' });
  });

  it('rolls an unacknowledged daily repeat forward to the latest occurrence, skipping missed days', async () => {
    const id = sql(
      `insert into public.reminders (user_id, title, remind_at, repeat_rule, status, fired_at, source)
       values ('${owner.id}', 'daily', now() - interval '3 days 1 hour', 'FREQ=DAILY', 'fired', now() - interval '3 days', 'api')
       returning id`,
    ).split('\n')[0]!;
    const { data } = await service().rpc('fire_due_reminders');
    expect((data as { id: string; kind: string }[]).find((r) => r.id === id)?.kind).toBe('repeat');
    const r = await row(id);
    const lag = Date.now() - new Date(r.remind_at).getTime();
    expect(lag).toBeGreaterThan(55 * 60_000); // latest occurrence: ~1h ago, not 3 days ago
    expect(lag).toBeLessThan(65 * 60_000);
    expect(r.status).toBe('fired');
  });

  it('skips soft-deleted reminders', async () => {
    const id = insertRaw('deleted_at', 'now()');
    const { data } = await service().rpc('fire_due_reminders');
    expect((data as { id: string }[]).map((r) => r.id)).not.toContain(id);
  });
});

describe('ack_reminder (desktop Done / Snooze)', () => {
  it('snooze sets snooze_until ~10 minutes out', async () => {
    const id = insertRaw('status', `'fired'`);
    const { data, error } = await client.rpc('ack_reminder', { p_id: id, p_action: 'snooze' });
    expect(error).toBeNull();
    const r = data as Row;
    expect(r.status).toBe('snoozed');
    const mins = (new Date(r.snooze_until!).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(9.5);
    expect(mins).toBeLessThan(10.5);
  });

  it('done completes a one-off reminder', async () => {
    const id = insertRaw('status', `'fired'`);
    const { data } = await client.rpc('ack_reminder', { p_id: id, p_action: 'done' });
    expect((data as Row).status).toBe('done');
  });

  it('done on a repeating reminder schedules the next occurrence', async () => {
    const id = sql(
      `insert into public.reminders (user_id, title, remind_at, repeat_rule, status, source)
       values ('${owner.id}', 'weekly', now() - interval '5 minutes', 'FREQ=WEEKLY', 'fired', 'api') returning id`,
    ).split('\n')[0]!;
    const { data } = await client.rpc('ack_reminder', { p_id: id, p_action: 'done' });
    const r = data as Row;
    expect(r.status).toBe('pending');
    const days = (new Date(r.remind_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('is idempotent: a retried ack for an old occurrence is a no-op', async () => {
    const id = sql(
      `insert into public.reminders (user_id, title, remind_at, repeat_rule, status, source)
       values ('${owner.id}', 'daily', now() - interval '1 minute', 'FREQ=DAILY', 'fired', 'api') returning id`,
    ).split('\n')[0]!;
    const before = await row(id);
    const first = await client.rpc('ack_reminder', {
      p_id: id,
      p_action: 'done',
      p_occurrence: before.remind_at,
    });
    const second = await client.rpc('ack_reminder', {
      p_id: id,
      p_action: 'done',
      p_occurrence: before.remind_at,
    });
    expect((first.data as Row).remind_at).toBe((second.data as Row).remind_at);
    expect(new Date((second.data as Row).remind_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects bad input', async () => {
    const id = insertRaw('status', `'fired'`);
    expect((await client.rpc('ack_reminder', { p_id: id, p_action: 'delete' })).error?.code).toBe(
      '22023',
    );
    expect(
      (await client.rpc('ack_reminder', { p_id: id, p_action: 'snooze', p_minutes: 100000 })).error
        ?.code,
    ).toBe('22023');
  });
});

describe('bot RPCs', () => {
  it('bot_login_email returns the linked account only, for service_role only', async () => {
    const ok = await service().rpc('bot_login_email', { p_chat_id: chat });
    expect(ok.data).toEqual([{ email: owner.email }]);
    const stranger = await service().rpc('bot_login_email', { p_chat_id: 987654321 });
    expect(stranger.error?.message).toMatch(/chat not allowed/);
    const asUser = await client.rpc('bot_login_email', { p_chat_id: chat });
    expect(asUser.error?.code).toBe('42501');
  });

  it('validates times and rules', async () => {
    const past = await service().rpc('bot_create_reminder', {
      p_chat_id: chat,
      p_title: 'x',
      p_remind_at: minutes(-60),
    });
    expect(past.error?.code).toBe('22023');
    const badRule = await service().rpc('bot_create_reminder', {
      p_chat_id: chat,
      p_title: 'x',
      p_remind_at: minutes(5),
      p_repeat_rule: 'FREQ=HOURLY',
    });
    expect(badRule.error).not.toBeNull();
    const empty = await service().rpc('bot_create_reminder', {
      p_chat_id: chat,
      p_title: '   ',
      p_remind_at: minutes(5),
    });
    expect(empty.error).not.toBeNull();
  });

  it('create → list → update → snooze → delete round trip', async () => {
    const created = await service().rpc('bot_create_reminder', {
      p_chat_id: chat,
      p_title: '  اجتماع الفريق  ',
      p_remind_at: minutes(30),
      p_repeat_rule: 'FREQ=WEEKLY;BYDAY=SU',
    });
    expect(created.error).toBeNull();
    const c = created.data as Row & { title: string; repeat_anchor: string };
    expect(c.title).toBe('اجتماع الفريق');
    expect(c.repeat_anchor).toBe(c.remind_at);

    const list = await service().rpc('bot_list_reminders', { p_chat_id: chat });
    expect((list.data as Row[]).map((r) => r.id)).toContain(c.id);

    const newAt = minutes(90);
    const upd = await service().rpc('bot_update_reminder', {
      p_chat_id: chat,
      p_id: c.id,
      p_remind_at: newAt,
    });
    expect(new Date((upd.data as Row).remind_at).toISOString()).toBe(newAt);
    expect((upd.data as Row).repeat_anchor).toBe((upd.data as Row).remind_at);

    const snz = await service().rpc('bot_snooze_reminder', {
      p_chat_id: chat,
      p_id: c.id,
      p_minutes: 15,
    });
    expect((snz.data as Row).status).toBe('snoozed');

    const del = await service().rpc('bot_delete_reminder', { p_chat_id: chat, p_id: c.id });
    expect(del.error).toBeNull();
    const after = await service().rpc('bot_list_reminders', { p_chat_id: chat });
    expect((after.data as Row[]).map((r) => r.id)).not.toContain(c.id);
  });

  it('cannot touch another user’s reminder even with a valid chat', async () => {
    const stranger = await createUser('stranger');
    const strangerChat = linkChat(stranger);
    const mine = await service().rpc('bot_create_reminder', {
      p_chat_id: chat,
      p_title: 'mine',
      p_remind_at: minutes(5),
    });
    const id = (mine.data as Row).id;
    const hijack = await service().rpc('bot_delete_reminder', {
      p_chat_id: strangerChat,
      p_id: id,
    });
    expect(hijack.error?.code).toBe('P0002');
  });
});
