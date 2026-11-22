import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import {
  ToMainSchemas,
  ToRendererSchemas,
  type ToMainChannel,
  type ToMainPayload,
  type ToRendererChannel,
  type ToRendererPayload,
} from '../shared/ipc';
import { scoped } from './logger';

const log = scoped('ipc');

/**
 * Typed, validated IPC bound to a single trusted window. Messages from any other webContents or
 * frame, or failing schema validation, are dropped and logged (channel name only).
 */
export class PetIpc {
  private readonly registered: ToMainChannel[] = [];

  constructor(
    private readonly win: BrowserWindow,
    private readonly isTrustedUrl: (url: string) => boolean,
  ) {}

  on<C extends ToMainChannel>(channel: C, handler: (payload: ToMainPayload<C>) => void): void {
    const listener = (event: IpcMainEvent, raw: unknown) => {
      if (!this.isTrustedSender(event)) {
        log.warn('rejected ipc from untrusted sender', { channel });
        return;
      }
      const parsed = ToMainSchemas[channel].safeParse(raw);
      if (!parsed.success) {
        log.warn('rejected invalid ipc payload', { channel });
        return;
      }
      try {
        handler(parsed.data as ToMainPayload<C>);
      } catch (err) {
        log.error('ipc handler failed', { channel }, err);
      }
    };
    ipcMain.on(channel, listener);
    this.registered.push(channel);
  }

  send<C extends ToRendererChannel>(channel: C, payload: ToRendererPayload<C>): void {
    if (this.win.isDestroyed()) return;
    // Validate outbound too: catches main-process bugs before they reach the page.
    const parsed = ToRendererSchemas[channel].parse(payload);
    this.win.webContents.send(channel, parsed);
  }

  dispose(): void {
    for (const c of this.registered) ipcMain.removeAllListeners(c);
    this.registered.length = 0;
  }

  private isTrustedSender(event: IpcMainEvent): boolean {
    if (this.win.isDestroyed() || event.sender.id !== this.win.webContents.id) return false;
    const frame = event.senderFrame;
    return !!frame && frame === this.win.webContents.mainFrame && this.isTrustedUrl(frame.url);
  }
}
