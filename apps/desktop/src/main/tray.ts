import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { CharacterId } from '../shared/ipc';
import type { SettingsStore } from './settings';

export interface TrayStatus {
  connection: string;
  updateReady: boolean;
  account: string | null;
}

export interface TrayActions {
  testReminder(): void;
  signIn(): void;
  signOut(): void;
  checkForUpdates(): void;
  installUpdate(): void;
  quit(): void;
}

const CHARACTERS: { id: CharacterId; label: string }[] = [
  { id: 'girl', label: 'Me' },
  { id: 'robot', label: 'Robo' },
];

export class AppTray {
  private readonly tray: Tray;
  private status: TrayStatus = { connection: 'Not signed in', updateReady: false, account: null };

  constructor(
    resourcesDir: string,
    private readonly settings: SettingsStore,
    private readonly actions: TrayActions,
  ) {
    const icon = nativeImage.createFromPath(join(resourcesDir, 'tray.png'));
    this.tray = new Tray(icon);
    this.tray.setToolTip('Desk Buddy');
    settings.onChange(() => {
      this.render();
    });
    this.render();
  }

  setStatus(patch: Partial<TrayStatus>): void {
    this.status = { ...this.status, ...patch };
    this.render();
  }

  destroy(): void {
    this.tray.destroy();
  }

  private render(): void {
    const s = this.settings.get();
    const atLogin = app.getLoginItemSettings().openAtLogin;
    const template: MenuItemConstructorOptions[] = [
      { label: `Desk Buddy · ${this.status.connection}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Pause reminders',
        type: 'checkbox',
        checked: s.paused,
        click: (item) => {
          this.settings.update({ paused: item.checked });
        },
      },
      {
        label: 'Mute sound',
        type: 'checkbox',
        checked: s.muted,
        click: (item) => {
          this.settings.update({ muted: item.checked });
        },
      },
      {
        label: 'Show character only for reminders',
        type: 'checkbox',
        checked: s.onlyForReminders,
        click: (item) => {
          this.settings.update({ onlyForReminders: item.checked });
        },
      },
      {
        label: 'Character',
        submenu: CHARACTERS.map((c) => ({
          label: c.label,
          type: 'radio' as const,
          checked: s.character === c.id,
          click: () => {
            this.settings.update({ character: c.id });
          },
        })),
      },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: atLogin,
        enabled: app.isPackaged,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          this.render();
        },
      },
      { type: 'separator' },
      {
        label: 'Show test reminder',
        click: () => {
          this.actions.testReminder();
        },
      },
      this.status.account
        ? {
            label: `Sign out (${this.status.account})`,
            click: () => {
              this.actions.signOut();
            },
          }
        : {
            label: 'Sign in…',
            click: () => {
              this.actions.signIn();
            },
          },
      { type: 'separator' },
      this.status.updateReady
        ? {
            label: 'Restart to update',
            click: () => {
              this.actions.installUpdate();
            },
          }
        : {
            label: 'Check for updates',
            enabled: app.isPackaged,
            click: () => {
              this.actions.checkForUpdates();
            },
          },
      {
        label: 'Open logs folder',
        click: () => {
          void shell.openPath(app.getPath('logs'));
        },
      },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      {
        label: 'Quit Desk Buddy',
        click: () => {
          this.actions.quit();
        },
      },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}
