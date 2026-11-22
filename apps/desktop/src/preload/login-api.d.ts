import type { LoginResult } from '../shared/login-ipc';

declare global {
  interface Window {
    readonly deskBuddyLogin: {
      requestCode(email: string): Promise<LoginResult>;
      verify(email: string, code: string): Promise<LoginResult>;
    };
  }
}
export {};
