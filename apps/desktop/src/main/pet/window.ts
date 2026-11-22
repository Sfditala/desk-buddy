import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { PET_WINDOW } from '../../shared/ipc';
import { APP_ORIGIN } from '../security';

export function createPetWindow(preloadDir: string, devServer: string | undefined): BrowserWindow {
  const win = new BrowserWindow({
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never steal focus from what the user is typing in, even when an alert pops.
    focusable: false,
    alwaysOnTop: true,
    title: 'Desk Buddy',
    webPreferences: {
      preload: join(preloadDir, 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      // Keep animating while other apps are focused.
      backgroundThrottling: false,
      devTools: !!devServer,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // Click-through by default; the renderer turns interaction on only over opaque UI.
  win.setIgnoreMouseEvents(true, { forward: true });

  void (devServer ? win.loadURL(devServer) : win.loadURL(`${APP_ORIGIN}/index.html`));
  return win;
}
