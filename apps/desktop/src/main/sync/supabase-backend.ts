import type { ReminderAction } from '@desk-buddy/core';
import {
  REALTIME_SUBSCRIBE_STATES,
  type PostgrestError,
  type RealtimeChannel,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { DeviceRevokedError, NotFoundError, type Backend } from './engine';

const COLUMNS =
  'id,title,notes,remind_at,status,repeat_rule,repeat_anchor,snooze_until,fired_at,acknowledged_at,source,created_at,updated_at,deleted_at';

export class RequestError extends Error {
  override name = 'RequestError';
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

function fail(error: PostgrestError | { message: string; code?: string }): never {
  // Messages are logged by name/code only (see engine), never the row content.
  if (error.code === 'P0002') throw new NotFoundError(error.message);
  throw new RequestError(error.message, error.code);
}

const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Supabase-backed sync. Uses the signed-in user's session only (publishable key + user JWT);
 * RLS decides what this device may see. No service key ever exists in the desktop app.
 */
export class SupabaseBackend implements Backend {
  constructor(
    private readonly client: SupabaseClient,
    private readonly deviceName: string,
  ) {}

  async snapshot(): Promise<unknown[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.client
      .from('reminders')
      .select(COLUMNS)
      .is('deleted_at', null)
      .or(`status.neq.done,updated_at.gte.${since}`)
      .order('remind_at', { ascending: true })
      .limit(1000);
    if (error) fail(error);
    return data;
  }

  async ack(id: string, action: ReminderAction, occurrence: string): Promise<unknown> {
    const res = await this.client.rpc('ack_reminder', {
      p_id: id,
      p_action: action,
      p_occurrence: occurrence,
    });
    if (res.error) fail(res.error);
    return res.data as unknown;
  }

  async heartbeat(): Promise<void> {
    // Idempotent: registers this session on first call, then just bumps last_seen_at.
    const { error } = await this.client.rpc('register_device', {
      p_name: this.deviceName,
      p_kind: 'desktop',
    });
    if (!error) return;
    if (error.code === '42501') throw new DeviceRevokedError(error.message);
    fail(error);
  }

  subscribe(handlers: {
    onChange: (row: unknown) => void;
    onStatus: (status: 'live' | 'down') => void;
  }): () => void {
    let channel: RealtimeChannel | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = async () => {
      if (closed) return;
      const { data } = await this.client.auth.getSession();
      await this.client.realtime.setAuth(data.session?.access_token ?? null);
      channel = this.client
        .channel(`reminders:${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reminders' }, (p) => {
          if (p.eventType !== 'DELETE') handlers.onChange(p.new);
        })
        // `SUBSCRIBED` can precede server-side readiness; this system message confirms it.
        .on('system', {}, (msg: { extension?: string; status?: string }) => {
          if (msg.extension === 'postgres_changes' && msg.status === 'ok') {
            retry = 0;
            handlers.onStatus('live');
          }
        })
        .subscribe((status) => {
          if (status !== REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
            handlers.onStatus('down');
            if (!closed) scheduleReconnect();
          }
        });
    };

    const scheduleReconnect = () => {
      if (timer || closed) return;
      const wait = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)] ?? 30_000;
      retry += 1;
      timer = setTimeout(() => {
        timer = null;
        const old = channel;
        channel = null;
        void (old ? this.client.removeChannel(old) : Promise.resolve()).then(connect);
      }, wait);
    };

    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (channel) void this.client.removeChannel(channel);
    };
  }
}
