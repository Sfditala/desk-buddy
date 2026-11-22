import { app } from 'electron';
import electronUpdater from 'electron-updater';
import log from 'electron-log/main';
import { scoped } from './logger';

const ulog = scoped('updater');
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Auto-update from GitHub Releases (configured by `publish` in electron-builder.yml).
 * electron-updater verifies the Windows publisher signature of the downloaded installer against
 * the running app's certificate before installing.
 */
export class Updater {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onReady: () => void) {}

  start(): void {
    if (!app.isPackaged) {
      ulog.info('updates disabled in development');
      return;
    }
    const { autoUpdater } = electronUpdater;
    autoUpdater.logger = log.scope('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('update-downloaded', (info) => {
      ulog.info('update downloaded', { version: info.version });
      this.onReady();
    });
    autoUpdater.on('error', (err) => {
      ulog.warn('update check failed', err.message);
    });
    this.check();
    this.timer = setInterval(() => {
      this.check();
    }, CHECK_EVERY_MS);
  }

  check(): void {
    if (!app.isPackaged) return;
    electronUpdater.autoUpdater.checkForUpdates().catch((err: unknown) => {
      ulog.warn('update check failed', err instanceof Error ? err.message : String(err));
    });
  }

  install(): void {
    electronUpdater.autoUpdater.quitAndInstall(true, true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
