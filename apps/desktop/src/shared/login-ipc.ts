import { z } from 'zod';

export const LoginChannel = {
  requestCode: 'login:request-code',
  verify: 'login:verify',
} as const;

export const Email = z.email().max(254);
export const RequestCodeMsg = z.object({ email: Email });
export const VerifyMsg = z.object({ email: Email, code: z.string().regex(/^\d{6}$/) });

export const LoginResult = z.object({
  ok: z.boolean(),
  /** User-safe message (never raw server errors). */
  error: z.string().max(200).optional(),
});
export type LoginResult = z.infer<typeof LoginResult>;
