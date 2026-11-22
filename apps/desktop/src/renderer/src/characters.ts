import type { CharacterId, PetMode } from '../../shared/ipc';

/**
 * Character pack format (src/renderer/characters/<id>/manifest.json):
 *  - `src` is either a single image (motion is derived procedurally), or a horizontal sprite sheet
 *    when `frames` > 1 (frames are equal-width cells played at `fps`).
 *  - `blink` is an optional closed-eyes variant of `src`.
 *  - `facing` is the direction the art looks; it is mirrored when walking the other way.
 */
export interface StateSpec {
  src: string;
  blink?: string;
  facing?: 'left' | 'right' | 'none';
  frames?: number;
  fps?: number;
}

export interface Manifest {
  id: CharacterId;
  name: string;
  pixelated: boolean;
  /** Image px -> CSS px. Art is exported at 2x for HiDPI. */
  scale: number;
  states: Record<PetMode, StateSpec>;
  avatar: { default: string; happy: string };
}

export interface LoadedState {
  spec: StateSpec;
  image: HTMLImageElement;
  blink: HTMLImageElement | null;
}

export interface Character {
  manifest: Manifest;
  states: Record<PetMode, LoadedState>;
  avatarUrl: (kind: 'default' | 'happy') => string;
}

const manifests = import.meta.glob<Manifest>('../characters/*/manifest.json', {
  eager: true,
  import: 'default',
});
const images = import.meta.glob<string>('../characters/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

function url(id: string, file: string): string {
  const u = images[`../characters/${id}/${file}`];
  if (!u) throw new Error(`missing asset ${id}/${file}`);
  return u;
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      resolve(img);
    };
    img.onerror = () => {
      reject(new Error(`failed to load ${src}`));
    };
    img.src = src;
  });
}

const cache = new Map<CharacterId, Promise<Character>>();

export function loadCharacter(id: CharacterId): Promise<Character> {
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      const manifest = manifests[`../characters/${id}/manifest.json`];
      if (!manifest) throw new Error(`unknown character ${id}`);
      const entries = await Promise.all(
        Object.entries(manifest.states).map(async ([mode, spec]) => {
          const [image, blink] = await Promise.all([
            load(url(id, spec.src)),
            spec.blink ? load(url(id, spec.blink)) : Promise.resolve(null),
          ]);
          return [mode, { spec, image, blink }] as const;
        }),
      );
      return {
        manifest,
        states: Object.fromEntries(entries) as Record<PetMode, LoadedState>,
        avatarUrl: (kind) => url(id, manifest.avatar[kind]),
      };
    })();
    cache.set(id, p);
  }
  return p;
}
