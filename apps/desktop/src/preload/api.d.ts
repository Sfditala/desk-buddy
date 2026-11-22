import type { InitMsg, ReminderView, SettingsMsg, StateMsg } from '../shared/ipc';

type Unsubscribe = () => void;

export interface DeskBuddyApi {
  ready(): void;
  setInteractive(value: boolean): void;
  act(id: string, action: 'done' | 'snooze'): void;
  poke(): void;
  reportError(message: string, stack?: string): void;
  onInit(cb: (msg: InitMsg) => void): Unsubscribe;
  onState(cb: (msg: StateMsg) => void): Unsubscribe;
  onSettings(cb: (msg: SettingsMsg) => void): Unsubscribe;
  onReminderShow(cb: (msg: ReminderView) => void): Unsubscribe;
  onReminderHide(cb: (msg: { id: string }) => void): Unsubscribe;
  onReminderNag(cb: (msg: { id: string }) => void): Unsubscribe;
}

declare global {
  interface Window {
    readonly deskBuddy: DeskBuddyApi;
  }
}
