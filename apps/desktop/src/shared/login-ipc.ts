import { z } from 'zod';

export const LoginChannel = {
  requestCode: 'login:request-code',
  verify: 'login:verify',
} as const;

export const Email = z.email().max(254);
export const RequestCodeMsg = z.object({ email: Email });
/** `code` is the 6-digit code, or the sign-in link from the email (validated again in main). */
export const VerifyMsg = z.object({
  /** Required for the 6-digit code; not needed for a sign-in link. */
  email: z.union([Email, z.literal('')]),
  code: z
    .string()
    .trim()
    .min(6)
    .max(2048)
    // Shape check only; main verifies the link's origin equals the configured project URL.
    .refine((v) => /^\d{6}$/.test(v) || /^https?:\/\/\S+$/.test(v), 'Enter the code or the link'),
});

export const LoginResult = z.object({
  ok: z.boolean(),
  /** User-safe message (never raw server errors). */
  error: z.string().max(200).optional(),
});
export type LoginResult = z.infer<typeof LoginResult>;
