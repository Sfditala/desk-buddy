import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoped } from './logger';

const log = scoped('secure-store');
const KEY_RE = /^[a-z0-9.-]{1,64}$/i;

/**
 * Small encrypted key/value files under userData/secure/*.bin, encrypted by the OS
 * (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux) via safeStorage.
 *
 * Values are decrypted once into memory by `init()`; `get` is synchronous, `set` updates memory
 * and writes the encrypted file in the background (serialised + coalesced per key, atomic
 * rename). If the OS cannot provide a real key (Linux "basic_text"), nothing is written to disk:
 * we never fall back to plaintext and the user simply signs in again on the next launch.
 */
export class SecureStore {
  private readonly dir = join(app.getPath('userData'), 'secure');
  private readonly memory = new Map<string, string>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private persistent = false;

  get isPersistent(): boolean {
    return this.persistent;
  }

  async init(): Promise<void> {
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
    this.persistent = (await safeStorage.isAsyncEncryptionAvailable()) && backend !== 'basic_text';
    if (!this.persistent) {
      log.warn('OS encryption unavailable: secrets kept in memory only', { backend });
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.bin')) continue;
      const key = file.slice(0, -4);
      if (!KEY_RE.test(key)) continue;
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(
          await readFile(join(this.dir, file)),
        );
        this.memory.set(key, result);
        if (shouldReEncrypt) this.set(key, result);
      } catch {
        log.warn('could not decrypt, discarding', { key });
        rmSync(join(this.dir, file), { force: true });
      }
    }
  }

  get(key: string): string | null {
    this.check(key);
    return this.memory.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.check(key);
    this.memory.set(key, value);
    this.schedule(key);
  }

  remove(key: string): void {
    this.check(key);
    this.memory.delete(key);
    this.schedule(key);
  }

  /** Wait for pending writes (call before quit). */
  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }

  private check(key: string): void {
    if (!KEY_RE.test(key)) throw new Error('invalid secure-store key');
  }

  private schedule(key: string): void {
    if (!this.persistent) return;
    this.dirty.add(key);
    if (this.writes.has(key)) return; // the running write loop will pick up the latest value
    const run = async () => {
      while (this.dirty.has(key)) {
        this.dirty.delete(key);
        const file = join(this.dir, `${key}.bin`);
        const value = this.memory.get(key);
        try {
          if (value === undefined) {
            if (existsSync(file)) rmSync(file, { force: true });
          } else {
            const tmp = `${file}.tmp`;
            await writeFile(tmp, await safeStorage.encryptStringAsync(value), { mode: 0o600 });
            await rename(tmp, file);
          }
        } catch (err) {
          log.error('encrypted write failed', {
            key,
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
    };
    const p = run().finally(() => this.writes.delete(key));
    this.writes.set(key, p);
  }
}
