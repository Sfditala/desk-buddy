import type { ReminderAction } from '@desk-buddy/core';
import { hostname } from 'node:os';
import type { AuthManager } from '../auth/auth';
import { scoped } from '../logger';
import type { Alert } from '../reminders/presenter';
import type { SecureStore } from '../secure-store';
import { SyncEngine, type PersistedState, type SyncStatus } from './engine';
import { SupabaseBackend } from './supabase-backend';

const log = scoped('sync');
const CACHE_KEY = 'reminder-cache';

export type ConnectionLabel = 'Live' | 'Syncing (polling)' | 'Offline' | 'Not signed in';

const LABEL: Record<SyncStatus, ConnectionLabel> = {
  live: 'Live',
  polling: 'Syncing (polling)',
  offline: 'Offline',
};

export interface SyncPorts {
  due(alerts: Alert[]): void;
  retract(ids: string[]): void;
  retractAll(): void;
  status(label: ConnectionLabel, account: string | null): void;
}

/** Ties auth state to the sync engine: one engine per signed-in session. */
export class ReminderSync {
  private engine: SyncEngine | null = null;
  private account: string | null = null;

  constructor(
    private readonly auth: AuthManager,
    private readonly store: SecureStore,
    private readonly ports: SyncPorts,
  ) {}

  async start(): Promise<void> {
    this.auth.onChange((s) => {
      if (s.signedIn) this.onSignedIn(s.account);
      else this.onSignedOut();
    });
    const s = await this.auth.current();
    if (s.signedIn) this.onSignedIn(s.account);
    else this.ports.status('Not signed in', null);
  }

  act(alert: Alert, action: ReminderAction): void {
    this.engine?.act(alert, action);
  }

  nudge(): void {
    this.engine?.nudge();
  }

  stop(): void {
    this.engine?.stop();
  }

  private onSignedIn(account: string): void {
    this.account = account;
    if (this.engine) return;
    const deviceName = `Desk Buddy · ${hostname().slice(0, 40)}`;
    const backend = new SupabaseBackend(this.auth.client, deviceName);
    this.engine = new SyncEngine(
      backend,
      {
        load: () => {
          const raw = this.store.get(CACHE_KEY);
          return raw ? (JSON.parse(raw) as unknown) : null;
        },
        save: (state: PersistedState) => {
          this.store.set(CACHE_KEY, JSON.stringify(state));
        },
      },
      {
        due: (alerts) => {
          this.ports.due(alerts);
        },
        retract: (ids) => {
          if (ids.length) this.ports.retract(ids);
        },
        status: (s) => {
          this.ports.status(LABEL[s], this.account);
        },
        revoked: () => {
          void this.auth.signOut();
        },
        log: (level, msg, meta) => {
          log[level](msg, meta ?? {});
        },
      },
    );
    this.engine.start();
    log.info('sync started');
  }

  private onSignedOut(): void {
    this.account = null;
    if (this.engine) {
      this.engine.stop();
      this.engine.clear();
      this.engine = null;
    }
    this.store.remove(CACHE_KEY);
    this.ports.retractAll();
    this.ports.status('Not signed in', null);
    log.info('sync stopped (signed out)');
  }
}
