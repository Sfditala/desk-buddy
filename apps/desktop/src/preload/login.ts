import { contextBridge, ipcRenderer } from 'electron';
import { LoginChannel, LoginResult, RequestCodeMsg, VerifyMsg } from '../shared/login-ipc';

async function call(channel: string, payload: unknown): Promise<LoginResult> {
  const raw: unknown = await ipcRenderer.invoke(channel, payload);
  const parsed = LoginResult.safeParse(raw);
  return parsed.success ? parsed.data : { ok: false, error: 'Unexpected response' };
}

contextBridge.exposeInMainWorld(
  'deskBuddyLogin',
  Object.freeze({
    requestCode: (email: string) => {
      const msg = RequestCodeMsg.safeParse({ email });
      return msg.success
        ? call(LoginChannel.requestCode, msg.data)
        : Promise.resolve({ ok: false, error: 'Enter a valid email' });
    },
    verify: (email: string, code: string) => {
      const msg = VerifyMsg.safeParse({ email, code });
      return msg.success
        ? call(LoginChannel.verify, msg.data)
        : Promise.resolve({ ok: false, error: 'Enter the 6-digit code' });
    },
  }),
);
