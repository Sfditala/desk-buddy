import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  ToMain,
  ToMainSchemas,
  ToRenderer,
  ToRendererSchemas,
  type ToMainChannel,
  type ToMainPayload,
  type ToRendererChannel,
  type ToRendererPayload,
} from '../shared/ipc';
import type { DeskBuddyApi } from './api';

/**
 * Sandboxed preload. Exposes a closed set of typed functions: no raw ipcRenderer, no channel
 * names chosen by the page, and every payload is validated in both directions.
 */
function send<C extends ToMainChannel>(channel: C, payload: ToMainPayload<C>): void {
  const parsed = ToMainSchemas[channel].safeParse(payload);
  if (!parsed.success) return;
  ipcRenderer.send(channel, parsed.data);
}

function on<C extends ToRendererChannel>(
  channel: C,
  listener: (payload: ToRendererPayload<C>) => void,
): () => void {
  const handler = (_event: IpcRendererEvent, raw: unknown) => {
    const parsed = ToRendererSchemas[channel].safeParse(raw);
    if (parsed.success) listener(parsed.data as ToRendererPayload<C>);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DeskBuddyApi = {
  ready: () => {
    send(ToMain.ready, undefined);
  },
  setInteractive: (value) => {
    send(ToMain.interactive, value);
  },
  act: (id, action) => {
    send(ToMain.action, { id, action });
  },
  poke: () => {
    send(ToMain.poke, undefined);
  },
  reportError: (message, stack) => {
    send(ToMain.error, stack === undefined ? { message } : { message, stack });
  },
  onInit: (cb) => on(ToRenderer.init, cb),
  onState: (cb) => on(ToRenderer.state, cb),
  onSettings: (cb) => on(ToRenderer.settings, cb),
  onReminderShow: (cb) => on(ToRenderer.reminderShow, cb),
  onReminderHide: (cb) => on(ToRenderer.reminderHide, cb),
  onReminderNag: (cb) => on(ToRenderer.reminderNag, cb),
};

contextBridge.exposeInMainWorld('deskBuddy', Object.freeze(api));
