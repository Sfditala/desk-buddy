import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, device, linkChat, minutes, service, signIn, type TestUser } from './env';

interface Change {
  eventType: string;
  new: { id?: string; status?: string; title?: string };
}

/** Subscribe the way the desktop app does and collect events. */
async function listen(
  client: SupabaseClient,
): Promise<{ events: Change[]; channel: RealtimeChannel }> {
  const { data } = await client.auth.getSession();
  await client.realtime.setAuth(data.session?.access_token ?? null);
  const events: Change[] = [];
  let channel!: RealtimeChannel;
  // `SUBSCRIBED` can precede the server-side postgres_changes setup; Realtime confirms readiness
  // with a `system` message, which is what we wait for (the desktop client does the same).
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error('subscribe timeout'));
    }, 15_000);
    channel = client
      .channel(`reminders-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reminders' }, (p) => {
        events.push(p);
      })
      .on('system', {}, (msg: { extension?: string; status?: string }) => {
        if (msg.extension === 'postgres_changes' && msg.status === 'ok') {
          clearTimeout(t);
          resolve();
        }
      })
      .subscribe();
  });
  return { events, channel };
}

async function waitFor<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let owner: TestUser;
let other: TestUser;
let chat: number;
const clients: SupabaseClient[] = [];

beforeAll(async () => {
  owner = await createUser('rt-owner');
  other = await createUser('rt-other');
  chat = linkChat(owner);
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.removeAllChannels()));
});

// Realtime can need a few seconds after `supabase db reset`; allow retries in CI.
describe('Realtime delivery (Telegram → DB → desktop)', { retry: 2 }, () => {
  it('owner device receives the bot insert and the scheduler fire; others receive nothing', async () => {
    const ownerDev = await device(owner);
    const otherDev = await device(other);
    const unregistered = await signIn(owner); // logged in, but not a registered device
    clients.push(ownerDev, otherDev, unregistered);

    const mine = await listen(ownerDev);
    const theirs = await listen(otherDev);
    const ghost = await listen(unregistered);

    const t0 = performance.now();
    const created = await service().rpc('bot_create_reminder', {
      p_chat_id: chat,
      p_title: 'ذكّرني أشرب مي',
      p_remind_at: minutes(1),
    });
    expect(created.error).toBeNull();
    const id = (created.data as { id: string }).id;

    const insert = await waitFor(() =>
      mine.events.find((e) => e.eventType === 'INSERT' && e.new.id === id),
    );
    const latencyMs = Math.round(performance.now() - t0);
    expect(insert.new.title).toBe('ذكّرني أشرب مي');
    process.stdout.write(`realtime INSERT latency: ${latencyMs} ms\n`);
    expect(latencyMs).toBeLessThan(5_000);

    // Scheduler marks it fired -> UPDATE reaches the device. (Make it due now first.)
    await service()
      .from('reminders')
      .update({ remind_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', id);
    await service().rpc('fire_due_reminders');
    await waitFor(() =>
      mine.events.find(
        (e) => e.eventType === 'UPDATE' && e.new.id === id && e.new.status === 'fired',
      ),
    );

    await new Promise((r) => setTimeout(r, 1_000));
    expect(theirs.events.filter((e) => e.new.id === id)).toEqual([]);
    expect(ghost.events.filter((e) => e.new.id === id)).toEqual([]);
  });

  it('a revoked device stops receiving events', async () => {
    const keep = await device(owner, 'keep');
    const lost = await device(owner, 'lost');
    clients.push(keep, lost);
    const lostDevice = (await lost.from('devices').select('id').eq('name', 'lost')).data![0]!;
    const lostEvents = await listen(lost);
    const keepEvents = await listen(keep);

    await keep.rpc('revoke_device', { p_device_id: lostDevice.id });
    const created = await service().rpc('bot_create_reminder', {
      p_chat_id: chat,
      p_title: 'after revoke',
      p_remind_at: minutes(5),
    });
    const id = (created.data as { id: string }).id;

    await waitFor(() => keepEvents.events.find((e) => e.new.id === id));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(lostEvents.events.filter((e) => e.new.id === id)).toEqual([]);
  });
});
