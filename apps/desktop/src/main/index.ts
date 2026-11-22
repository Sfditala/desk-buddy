import { app, dialog, powerMonitor, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { AuthManager } from './auth/auth';
import { LoginWindow } from './auth/login-window';
import { loadConfig } from './config';
import { initLogger, logger as log } from './logger';
import { PetIpc } from './ipc';
import { PetController } from './pet/controller';
import { PetVisibility } from './pet/visibility';
import { createPetWindow } from './pet/window';
import { AlertPresenter, type Alert } from './reminders/presenter';
import { APP_ORIGIN, hardenApp, registerAppScheme, serveRenderer } from './security';
import { SecureStore } from './secure-store';
import { SettingsStore } from './settings';
import { ReminderSync } from './sync';
import { AppTray } from './tray';
import { Updater } from './updater';

initLogger();

process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason instanceof Error ? reason : String(reason));
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerAppScheme();
  app.setAppUserModelId('app.deskbuddy.desktop');
  // The alert chime plays without a click; the window is never focused.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app
    .whenReady()
    .then(main)
    .catch((err: unknown) => {
      log.error('startup failed', err instanceof Error ? err : String(err));
      dialog.showErrorBox(
        'Desk Buddy',
        'Desk Buddy could not start. See the log file for details.',
      );
      app.exit(1);
    });
}

const DEV_SERVER = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
const OUT_DIR = join(import.meta.dirname, '..');
const RESOURCES_DIR = app.isPackaged ? process.resourcesPath : join(OUT_DIR, '..', 'resources');

function isTrustedUrl(url: string): boolean {
  return url.startsWith(`${APP_ORIGIN}/`) || (!!DEV_SERVER && url.startsWith(DEV_SERVER));
}

const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_CRASHES = 5;

async function main(): Promise<void> {
  log.info('starting', { version: app.getVersion(), packaged: app.isPackaged });
  hardenApp(DEV_SERVER);
  if (!DEV_SERVER) serveRenderer(join(OUT_DIR, 'renderer'));

  const settings = new SettingsStore();
  const secure = new SecureStore();
  await secure.init();
  const config = loadConfig();
  if (!config) log.warn('no Supabase config in this build: running without sync');
  const auth = config ? new AuthManager(config, secure) : null;
  const login = auth ? new LoginWindow(auth, join(OUT_DIR, 'preload'), DEV_SERVER) : null;
  let sync: ReminderSync | null = null;
  const crashes: number[] = [];

  let win: BrowserWindow;
  let ipc: PetIpc;
  let pet: PetController;
  let trayRef: AppTray | null = null;
  let alerting = false;

  /**
   * While a reminder is on screen the whole pet window takes clicks, so Done/Snooze always work.
   * Otherwise it is click-through; hover forwarding (Windows/macOS) re-enables clicks over the
   * pet itself. Re-applied on every show because Windows can drop forwarding after hide/show.
   */
  const applyMouseMode = (): void => {
    if (win.isDestroyed()) return;
    // Reminders-only mode (default): the window is only visible for a reminder (plus a short
    // hello/goodbye), so it never needs to be click-through. Not toggling the ignore state at all
    // avoids a Windows issue where clicks stop registering after repeated toggles.
    const clickable = alerting || settings.get().onlyForReminders;
    if (clickable) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
    log.debug('mouse mode', { clickable });
  };
  const updateTrayAlert = (): void => {
    const a = presenter.showing;
    trayRef?.setStatus({ alert: a ? { title: a.title } : null });
  };

  const visibility = new PetVisibility(
    {
      show: () => {
        if (win.isDestroyed()) return;
        win.showInactive();
        applyMouseMode();
        pet.start();
      },
      hide: () => {
        pet.stop();
        if (!win.isDestroyed()) win.hide();
      },
    },
    { onlyForReminders: settings.get().onlyForReminders },
  );

  const presenter = new AlertPresenter({
    show: (view) => {
      ipc.send('reminder:show', view);
      updateTrayAlert();
    },
    hide: (id) => {
      ipc.send('reminder:hide', { id });
      updateTrayAlert();
    },
    nag: (id) => {
      ipc.send('reminder:nag', { id });
    },
    setAlerting: (on) => {
      alerting = on;
      pet.alerting = on;
      applyMouseMode();
      visibility.setAlerting(on);
      updateTrayAlert();
    },
    onAction: (alert: Alert, action) => {
      log.info('alert action', { id: alert.id, action });
      if (action === 'done') pet.celebrate();
      if (!alert.id.startsWith('local-')) sync?.act(alert, action);
    },
  });

  function createWindow(): void {
    win = createPetWindow(join(OUT_DIR, 'preload'), DEV_SERVER);
    ipc = new PetIpc(win, isTrustedUrl);
    pet = new PetController(win, ipc);
    pet.paused = settings.get().paused;

    ipc.on('renderer:ready', () => {
      const s = settings.get();
      ipc.send('pet:init', { character: s.character, muted: s.muted, window: win.getBounds() });
      visibility.setReady(true);
      // Re-show whatever was on screen before a renderer crash.
      presenter.redisplay();
    });
    ipc.on('pet:interactive', (on) => {
      // During an alert the window must stay clickable regardless of hover state.
      if (!alerting && !settings.get().onlyForReminders) {
        win.setIgnoreMouseEvents(!on, { forward: true });
      }
    });
    ipc.on('reminder:action', (msg) => {
      presenter.handleAction(msg);
    });
    ipc.on('pet:poke', () => {
      if (pet.mode !== 'alert') pet.celebrate();
    });
    ipc.on('renderer:error', (e) => {
      log.error('renderer error', e.message);
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('renderer gone', { reason: details.reason, exitCode: details.exitCode });
      const now = Date.now();
      crashes.push(now);
      while (crashes.length && now - (crashes[0] ?? now) > CRASH_WINDOW_MS) crashes.shift();
      visibility.setReady(false);
      pet.dispose();
      ipc.dispose();
      if (!win.isDestroyed()) win.destroy();
      if (crashes.length > MAX_CRASHES) {
        log.error('renderer keeps crashing, giving up');
        dialog.showErrorBox(
          'Desk Buddy',
          'The character window keeps crashing. Please restart Desk Buddy.',
        );
        return;
      }
      setTimeout(createWindow, 1_000);
    });
  }

  createWindow();

  settings.onChange((s) => {
    pet.paused = s.paused;
    presenter.setPaused(s.paused);
    visibility.setOnlyForReminders(s.onlyForReminders);
    applyMouseMode();
    ipc.send('app:settings', { character: s.character, muted: s.muted });
  });
  presenter.setPaused(settings.get().paused);

  const updater = new Updater(() => {
    tray.setStatus({ updateReady: true });
  });

  let testSeq = 0;
  const tray = new AppTray(RESOURCES_DIR, settings, {
    alertDone: () => {
      const a = presenter.showing;
      if (a) presenter.handleAction({ id: a.id, action: 'done' });
    },
    alertSnooze: () => {
      const a = presenter.showing;
      if (a) presenter.handleAction({ id: a.id, action: 'snooze' });
    },
    testReminder: () => {
      testSeq += 1;
      const id = `local-test-${testSeq}`;
      presenter.push([
        {
          id,
          key: id,
          title: testSeq % 2 ? 'اشرب مي واتمشّى خمس دقايق 💧' : 'Review the n8n workflow PR',
          notes: testSeq % 2 ? 'تذكير تجريبي من Desk Buddy' : 'Test reminder from the tray menu',
          dueAt: new Date(),
        },
      ]);
    },
    signIn: () => {
      login?.open();
    },
    signOut: () => {
      void auth?.signOut();
    },
    checkForUpdates: () => {
      updater.check();
    },
    installUpdate: () => {
      updater.install();
    },
    quit: () => {
      app.quit();
    },
  });
  trayRef = tray;
  updateTrayAlert();
  updater.start();

  if (auth) {
    sync = new ReminderSync(auth, secure, {
      due: (alerts) => {
        presenter.push(alerts);
      },
      retract: (ids) => {
        for (const id of ids) presenter.retract(id);
      },
      retractAll: () => {
        for (const a of [presenter.showing, ...presenter.pending]) {
          if (a && !a.id.startsWith('local-')) presenter.retract(a.id);
        }
      },
      status: (connection, account) => {
        tray.setStatus({ connection, account });
      },
    });
    void sync.start().then(async () => {
      let signedIn = (await auth.current()).signedIn;
      if (!signedIn) login?.open();
      auth.onChange((state) => {
        // Signed out later (device revoked, refresh token expired): ask to sign in again.
        if (!state.signedIn) login?.open();
        // Just signed in: the buddy pops up to say hi, so the user knows it worked even in
        // reminders-only mode. (Token refreshes keep signedIn=true and do not trigger this.)
        if (state.signedIn && !signedIn) {
          visibility.peek();
          pet.celebrate();
        }
        signedIn = state.signedIn;
      });
    });
  } else {
    tray.setStatus({ connection: 'Sync not configured' });
  }

  powerMonitor.on('resume', () => {
    log.info('system resumed');
    sync?.nudge();
  });
  powerMonitor.on('unlock-screen', () => {
    sync?.nudge();
  });

  // Launching the app again (e.g. from the Start menu) says hello even in reminders-only mode.
  app.on('second-instance', () => {
    visibility.peek();
    if (pet.mode !== 'alert') pet.celebrate();
  });
  // Tray app: closing the window must not quit.
  app.on('window-all-closed', () => undefined);
  app.on('before-quit', () => {
    presenter.dispose();
    sync?.stop();
    void secure.flush();
    pet.stop();
    updater.stop();
    tray.destroy();
  });

  // Hardcoded test reminder on first launch in development, so step 2 is verifiable.
  if (DEV_SERVER || process.env.DESK_BUDDY_DEMO === '1') {
    setTimeout(
      () => {
        presenter.push([
          {
            id: 'local-demo',
            key: 'local-demo',
            title: 'موعد الطبيب الساعة ٤ — لا تنسي البطاقة 🩺',
            notes: 'Hardcoded test reminder (step 2)',
            dueAt: new Date(),
          },
        ]);
      },
      Number(process.env.DESK_BUDDY_DEMO_DELAY_MS ?? 8_000),
    );
  }
}
