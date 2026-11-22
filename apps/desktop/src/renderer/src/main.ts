import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import type { CharacterId, ReminderView, StateMsg } from '../../shared/ipc';
import { Stage } from './animator';
import { loadCharacter, type Character } from './characters';
import { playChime } from './chime';

const api = window.deskBuddy;

window.addEventListener('error', (e) => {
  api.reportError(e.message, e.error instanceof Error ? e.error.stack : undefined);
});
window.addEventListener('unhandledrejection', (e) => {
  api.reportError(e.reason instanceof Error ? e.reason.message : String(e.reason));
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed DOM lookup
function $<T extends Element>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

const stage = new Stage($<HTMLCanvasElement>('#stage'));
const bubble = $<HTMLElement>('#bubble');
const ui = {
  avatar: $<HTMLImageElement>('.bubble__avatar', bubble),
  when: $<HTMLTimeElement>('.bubble__when', bubble),
  queued: $<HTMLElement>('.bubble__queued', bubble),
  title: $<HTMLElement>('.bubble__title', bubble),
  notes: $<HTMLElement>('.bubble__notes', bubble),
};

let character: Character | null = null;
let characterId: CharacterId | null = null;
let muted = false;
let current: ReminderView | null = null;
let view: StateMsg = { mode: 'idle', dir: -1, offsetX: 190 };
let interactive = false;

async function useCharacter(id: CharacterId): Promise<void> {
  if (id === characterId) return;
  characterId = id;
  character = await loadCharacter(id);
  stage.setCharacter(character);
  ui.avatar.classList.toggle('is-pixelated', character.manifest.pixelated);
  ui.avatar.src = character.avatarUrl('default');
  placeBubble();
}

function placeBubble(): void {
  if (!character || bubble.hidden) return;
  const idle = character.states.idle.image;
  const headTop = idle.naturalHeight * character.manifest.scale;
  const width = bubble.offsetWidth || 300;
  const left = Math.min(Math.max(view.offsetX - width / 2, 8), window.innerWidth - width - 8);
  bubble.style.left = `${left}px`;
  bubble.style.bottom = `${headTop + 34}px`;
  bubble.style.setProperty(
    '--tail-x',
    `${Math.min(Math.max(view.offsetX - left, 24), width - 24)}px`,
  );
}

function restartAnimation(el: HTMLElement, cls: string): void {
  el.classList.remove('is-entering', 'is-nagging');
  el.getBoundingClientRect(); // force reflow so the animation restarts
  el.classList.add(cls);
}

function showReminder(r: ReminderView): void {
  const isNew = current?.id !== r.id;
  current = r;
  // textContent only: reminder text is untrusted (it came from a chat message).
  ui.title.textContent = r.title;
  ui.notes.textContent = r.notes ?? '';
  ui.notes.hidden = !r.notes;
  ui.when.textContent = r.when;
  ui.queued.textContent = r.queued > 0 ? `+${r.queued} more waiting` : '';
  ui.queued.hidden = r.queued === 0;
  if (character) ui.avatar.src = character.avatarUrl('default');
  bubble.hidden = false;
  placeBubble();
  if (isNew) {
    restartAnimation(bubble, 'is-entering');
    if (!muted) playChime();
  }
}

function hideReminder(id: string): void {
  if (current?.id !== id) return;
  current = null;
  bubble.hidden = true;
  setInteractive(false);
}

function setInteractive(on: boolean): void {
  if (on === interactive) return;
  interactive = on;
  api.setInteractive(on);
}

// Pixel-accurate click-through: interactive only over the bubble or opaque character pixels.
window.addEventListener('mousemove', (e) => {
  let over = stage.hit(e.clientX, e.clientY);
  if (!over && !bubble.hidden) {
    const r = bubble.getBoundingClientRect();
    over =
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom + 12;
  }
  setInteractive(over);
});
// The window is hidden between reminders; forget hover state so the next show starts clean.
document.addEventListener('visibilitychange', () => {
  interactive = false;
});
document.addEventListener('mouseleave', () => {
  setInteractive(false);
});

$<HTMLCanvasElement>('#stage').addEventListener('click', (e) => {
  if (stage.hit(e.clientX, e.clientY)) api.poke();
});

bubble.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!btn || !current) return;
  const action = btn.dataset.action;
  if (action !== 'done' && action !== 'snooze') return;
  if (action === 'done' && character) ui.avatar.src = character.avatarUrl('happy');
  api.act(current.id, action);
});

api.onInit((msg) => {
  muted = msg.muted;
  void useCharacter(msg.character);
});
api.onSettings((msg) => {
  muted = msg.muted;
  void useCharacter(msg.character);
});
api.onState((msg) => {
  view = msg;
  stage.setView(msg);
  placeBubble();
});
api.onReminderShow(showReminder);
api.onReminderHide(({ id }) => {
  hideReminder(id);
});
api.onReminderNag(({ id }) => {
  if (current?.id !== id) return;
  stage.replay();
  restartAnimation(bubble, 'is-nagging');
  if (!muted) playChime();
});

stage.run();
await document.fonts.ready;
api.ready();
