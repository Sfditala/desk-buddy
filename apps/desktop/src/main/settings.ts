import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CharacterId } from '../shared/ipc';
import { scoped } from './logger';

const log = scoped('settings');

/** Non-sensitive preferences only. Secrets live in secure-store.ts (OS-encrypted). */
const Settings = z.object({
  character: CharacterId.default('girl'),
  muted: z.boolean().default(false),
  paused: z.boolean().default(false),
});
export type Settings = z.infer<typeof Settings>;

type Listener = (s: Settings) => void;

export class SettingsStore {
  private value: Settings;
  private readonly listeners = new Set<Listener>();
  private readonly file = join(app.getPath('userData'), 'settings.json');

  constructor() {
    this.value = this.load();
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): Settings {
    this.value = Settings.parse({ ...this.value, ...patch });
    this.save();
    for (const l of this.listeners) l(this.value);
    return this.value;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): Settings {
    try {
      if (existsSync(this.file)) {
        return Settings.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      }
    } catch (err) {
      log.warn('settings unreadable, using defaults', err);
    }
    return Settings.parse({});
  }

  private save(): void {
    // Atomic write so a crash mid-write cannot corrupt the file.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
