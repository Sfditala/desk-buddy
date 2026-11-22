import { z } from 'zod';

/**
 * The complete IPC surface. Anything not listed here is rejected by both preload and main.
 * main -> renderer channels are push-only; renderer -> main channels are fire-and-forget `send`
 * (no `invoke`), so the renderer can never pull data it was not given.
 */
export const ToRenderer = {
  init: 'pet:init',
  state: 'pet:state',
  reminderShow: 'reminder:show',
  reminderHide: 'reminder:hide',
  reminderNag: 'reminder:nag',
  settings: 'app:settings',
} as const;

export const ToMain = {
  ready: 'renderer:ready',
  interactive: 'pet:interactive',
  action: 'reminder:action',
  poke: 'pet:poke',
  error: 'renderer:error',
} as const;

export const PET_MODES = ['idle', 'walk', 'sit', 'sleep', 'alert', 'happy'] as const;
export const PetMode = z.enum(PET_MODES);
export type PetMode = z.infer<typeof PetMode>;

export const CHARACTER_IDS = ['girl', 'robot'] as const;
export const CharacterId = z.enum(CHARACTER_IDS);
export type CharacterId = z.infer<typeof CharacterId>;

/** Window geometry in DIPs; the character stands on the bottom edge. */
export const PET_WINDOW = { width: 380, height: 430 } as const;

export const InitMsg = z.object({
  character: CharacterId,
  muted: z.boolean(),
  window: z.object({ width: z.number(), height: z.number() }),
});
export type InitMsg = z.infer<typeof InitMsg>;

export const StateMsg = z.object({
  mode: PetMode,
  dir: z.union([z.literal(1), z.literal(-1)]),
  /** Character centre X inside the window, in DIPs. */
  offsetX: z.number(),
});
export type StateMsg = z.infer<typeof StateMsg>;

export const SettingsMsg = z.object({ character: CharacterId, muted: z.boolean() });
export type SettingsMsg = z.infer<typeof SettingsMsg>;

/** Opaque id: a reminder uuid, or `local-…` for the built-in test reminder. */
export const AlertId = z.string().regex(/^(?:[0-9a-f-]{36}|local-[a-z0-9-]{1,40})$/);

export const ReminderView = z.object({
  id: AlertId,
  title: z.string().min(1).max(500),
  notes: z.string().max(4000).nullable(),
  /** Pre-formatted local time label, e.g. "09:00 · Sun 22 Nov". */
  when: z.string().max(80),
  /** Other alerts waiting behind this one. */
  queued: z.number().int().min(0),
});
export type ReminderView = z.infer<typeof ReminderView>;

export const ActionMsg = z.object({ id: AlertId, action: z.enum(['done', 'snooze']) });
export type ActionMsg = z.infer<typeof ActionMsg>;

export const InteractiveMsg = z.boolean();
export const ErrorMsg = z.object({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
});

/** Validation for every channel the renderer may send on. */
export const ToMainSchemas = {
  [ToMain.ready]: z.undefined(),
  [ToMain.interactive]: InteractiveMsg,
  [ToMain.action]: ActionMsg,
  [ToMain.poke]: z.undefined(),
  [ToMain.error]: ErrorMsg,
} as const;

export const ToRendererSchemas = {
  [ToRenderer.init]: InitMsg,
  [ToRenderer.state]: StateMsg,
  [ToRenderer.reminderShow]: ReminderView,
  [ToRenderer.reminderHide]: z.object({ id: AlertId }),
  [ToRenderer.reminderNag]: z.object({ id: AlertId }),
  [ToRenderer.settings]: SettingsMsg,
} as const;

export type ToRendererChannel = keyof typeof ToRendererSchemas;
export type ToRendererPayload<C extends ToRendererChannel> = z.infer<(typeof ToRendererSchemas)[C]>;
export type ToMainChannel = keyof typeof ToMainSchemas;
export type ToMainPayload<C extends ToMainChannel> = z.infer<(typeof ToMainSchemas)[C]>;
