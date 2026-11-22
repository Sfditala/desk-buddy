import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { LoginChannel, RequestCodeMsg, VerifyMsg, type LoginResult } from '../../shared/login-ipc';
import { scoped } from '../logger';
import { APP_ORIGIN } from '../security';
import type { AuthManager } from './auth';

const log = scoped('login');

/** Small, sandboxed sign-in window. Only two validated invoke channels exist while it is open. */
export class LoginWindow {
  private win: BrowserWindow | null = null;

  constructor(
    private readonly auth: AuthManager,
    private readonly preloadDir: string,
    private readonly devServer: string | undefined,
  ) {}

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 400,
      height: 600,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      title: 'Sign in · Desk Buddy',
      autoHideMenuBar: true,
      show: false,
      backgroundColor: '#fffdf8',
      webPreferences: {
        preload: join(this.preloadDir, 'login.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        devTools: !!this.devServer,
      },
    });
    win.setMenu(null);
    win.once('ready-to-show', () => {
      win.show();
    });
    win.on('closed', () => {
      this.unregister();
      this.win = null;
    });
    this.win = win;
    this.register();
    void (this.devServer
      ? win.loadURL(`${this.devServer}/login.html`)
      : win.loadURL(`${APP_ORIGIN}/login.html`));
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }

  private trusted(event: IpcMainInvokeEvent): boolean {
    const win = this.win;
    if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return false;
    const url = event.senderFrame?.url ?? '';
    return (
      url.startsWith(`${APP_ORIGIN}/login.html`) ||
      (!!this.devServer && url.startsWith(this.devServer))
    );
  }

  private register(): void {
    ipcMain.handle(LoginChannel.requestCode, async (event, raw: unknown): Promise<LoginResult> => {
      const msg = RequestCodeMsg.safeParse(raw);
      if (!this.trusted(event) || !msg.success) return { ok: false, error: 'Invalid request' };
      try {
        return await this.auth.requestCode(msg.data.email);
      } catch (err) {
        log.warn('request code error', err instanceof Error ? err.name : 'unknown');
        return { ok: false, error: 'Could not reach the server. Check your connection.' };
      }
    });
    ipcMain.handle(LoginChannel.verify, async (event, raw: unknown): Promise<LoginResult> => {
      const msg = VerifyMsg.safeParse(raw);
      if (!this.trusted(event) || !msg.success) return { ok: false, error: 'Invalid request' };
      try {
        const res = await this.auth.verify(msg.data.email, msg.data.code);
        if (res.ok) {
          setTimeout(() => {
            this.close();
          }, 900);
        }
        return res;
      } catch (err) {
        log.warn('verify error', err instanceof Error ? err.name : 'unknown');
        return { ok: false, error: 'Could not reach the server. Check your connection.' };
      }
    });
  }

  private unregister(): void {
    ipcMain.removeHandler(LoginChannel.requestCode);
    ipcMain.removeHandler(LoginChannel.verify);
  }
}
