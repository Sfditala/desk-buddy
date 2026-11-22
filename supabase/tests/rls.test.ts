import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  anon,
  createUser,
  device,
  linkChat,
  minutes,
  service,
  signIn,
  sql,
  type TestUser,
} from './env';

/**
 * RLS / privilege matrix. Each `it` is one row of the evidence table in docs/SECURITY.md.
 */
let owner: TestUser;
let other: TestUser;
let ownerDevice: SupabaseClient;
let otherDevice: SupabaseClient;
let ownerChat: number;
let ownerReminderId: string;

beforeAll(async () => {
  owner = await createUser('owner');
  other = await createUser('other');
  ownerDevice = await device(owner);
  otherDevice = await device(other);
  ownerChat = linkChat(owner);
  const { data, error } = await service().rpc('bot_create_reminder', {
    p_chat_id: ownerChat,
    p_title: 'سر: موعد البنك',
    p_remind_at: minutes(60),
  });
  if (error) throw error;
  ownerReminderId = (data as { id: string }).id;
});

describe('unauthenticated (anon key only)', () => {
  it('cannot read reminders', async () => {
    const { data, error } = await anon().from('reminders').select('*');
    expect(error?.code).toBe('42501'); // permission denied: privileges revoked from anon
    expect(data).toBeNull();
  });

  it('cannot insert reminders', async () => {
    const { error } = await anon()
      .from('reminders')
      .insert({ user_id: owner.id, title: 'x', remind_at: minutes(5), source: 'desktop' });
    expect(error?.code).toBe('42501');
  });

  it('cannot read devices', async () => {
    const { error } = await anon().from('devices').select('*');
    expect(error?.code).toBe('42501');
  });

  it.each([
    ['bot_create_reminder', { p_chat_id: 1, p_title: 'x', p_remind_at: minutes(5) }],
    ['bot_list_reminders', { p_chat_id: 1 }],
    ['fire_due_reminders', {}],
    ['purge_deleted_reminders', {}],
    ['bot_login_email', { p_chat_id: 1 }],
    ['ack_reminder', { p_id: '00000000-0000-0000-0000-000000000000', p_action: 'done' }],
    ['register_device', { p_name: 'x' }],
    ['revoke_device', { p_device_id: '00000000-0000-0000-0000-000000000000' }],
    ['next_occurrence', { p_rule: 'FREQ=DAILY', p_anchor: minutes(0), p_after: minutes(0) }],
  ])('cannot call %s', async (fn, args) => {
    const { error } = await anon().rpc(fn, args);
    // Must be a privilege error, not a check inside the function body.
    expect(error?.code).toBe('42501');
    expect(error?.message).toMatch(/permission denied/);
  });

  it('cannot reach the private schema', async () => {
    const { error } = await anon().schema('private').from('telegram_links').select('*');
    expect(error).not.toBeNull();
  });
});

describe('signed in, but session not registered as a device', () => {
  it('sees nothing and cannot write', async () => {
    const client = await signIn(owner);
    const read = await client.from('reminders').select('id');
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);
    const write = await client
      .from('reminders')
      .insert({ user_id: owner.id, title: 'x', remind_at: minutes(5), source: 'desktop' });
    expect(write.error?.code).toBe('42501');
  });
});

describe('owner device', () => {
  it('reads own reminders', async () => {
    const { data, error } = await ownerDevice.from('reminders').select('id,title');
    expect(error).toBeNull();
    expect(data?.map((r) => r.id)).toContain(ownerReminderId);
  });

  it('creates and soft-deletes own reminders', async () => {
    const ins = await ownerDevice
      .from('reminders')
      .insert({
        user_id: owner.id,
        title: 'from desktop',
        remind_at: minutes(5),
        source: 'desktop',
      })
      .select('id')
      .single();
    expect(ins.error).toBeNull();
    const del = await ownerDevice
      .from('reminders')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', ins.data!.id)
      .select('id');
    expect(del.data).toHaveLength(1);
  });

  it('cannot hard-delete (no DELETE privilege)', async () => {
    const { error } = await ownerDevice.from('reminders').delete().eq('id', ownerReminderId);
    expect(error?.code).toBe('42501');
  });

  it('cannot insert a row for someone else, or spoof the telegram source', async () => {
    const forOther = await ownerDevice
      .from('reminders')
      .insert({ user_id: other.id, title: 'x', remind_at: minutes(5), source: 'desktop' });
    expect(forOther.error?.code).toBe('42501');
    const spoof = await ownerDevice
      .from('reminders')
      .insert({ user_id: owner.id, title: 'x', remind_at: minutes(5), source: 'telegram' });
    expect(spoof.error?.code).toBe('42501');
  });

  it('cannot move own row to another user', async () => {
    const { error } = await ownerDevice
      .from('reminders')
      .update({ user_id: other.id })
      .eq('id', ownerReminderId);
    expect(error?.code).toBe('42501');
  });

  it('cannot call bot or scheduler functions', async () => {
    const bot = await ownerDevice.rpc('bot_list_reminders', { p_chat_id: ownerChat });
    expect(bot.error?.code).toBe('42501');
    const fire = await ownerDevice.rpc('fire_due_reminders');
    expect(fire.error?.code).toBe('42501');
  });
});

describe('different user (own valid device)', () => {
  it('cannot see the owner’s reminders', async () => {
    const { data } = await otherDevice.from('reminders').select('id');
    expect(data?.map((r) => r.id)).not.toContain(ownerReminderId);
  });

  it('cannot update the owner’s reminders (0 rows affected)', async () => {
    const { data, error } = await otherDevice
      .from('reminders')
      .update({ title: 'pwned' })
      .eq('id', ownerReminderId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(sql(`select title from public.reminders where id = '${ownerReminderId}'`)).toBe(
      'سر: موعد البنك',
    );
  });

  it('cannot ack the owner’s reminder', async () => {
    const { error } = await otherDevice.rpc('ack_reminder', {
      p_id: ownerReminderId,
      p_action: 'done',
    });
    expect(error?.code).toBe('P0002');
  });

  it('cannot see or revoke the owner’s devices', async () => {
    const ownerDeviceId = sql(
      `select id from public.devices where user_id = '${owner.id}' limit 1`,
    );
    const list = await otherDevice.from('devices').select('id');
    expect(list.data?.map((d) => d.id)).not.toContain(ownerDeviceId);
    const revoke = await otherDevice.rpc('revoke_device', { p_device_id: ownerDeviceId });
    expect(revoke.error?.code).toBe('P0002');
  });

  it('cannot use a chat id that is not linked to it (bot path is service-only anyway)', async () => {
    const { error } = await service().rpc('bot_list_reminders', { p_chat_id: 424242 });
    expect(error?.message).toMatch(/chat not allowed/);
  });
});

describe('device revocation', () => {
  it('revoked device loses access immediately and cannot refresh or re-register', async () => {
    const laptop = await device(owner, 'old-laptop');
    expect((await laptop.from('reminders').select('id')).data?.length).toBeGreaterThan(0);

    const { data: me } = await laptop
      .from('devices')
      .select('id,session_id,name')
      .eq('name', 'old-laptop');
    const target = me![0]!;
    const revoke = await ownerDevice.rpc('revoke_device', { p_device_id: target.id });
    expect(revoke.error).toBeNull();

    // Access token is still cryptographically valid, but RLS rejects the session.
    const after = await laptop.from('reminders').select('id');
    expect(after.data).toEqual([]);
    const again = await laptop.rpc('register_device', { p_name: 'old-laptop' });
    expect(again.error?.code).toBe('42501');
    // Refresh token is gone with the Auth session.
    const refreshed = await laptop.auth.refreshSession();
    expect(refreshed.error).not.toBeNull();
  });
});
