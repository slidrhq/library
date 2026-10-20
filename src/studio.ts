/**
 * Slidr Studio (github.com/slidrhq/studio), when it runs on this machine: the designs it made and
 * published, so a design of the library links to the request it came from, and the library the
 * studio publishes to. The library reads nothing else from it, and works the same without it.
 */
import { useEffect, useState } from 'react';

/** Where the studio's server answers (`VITE_SLIDR_STUDIO_URL`). */
export const STUDIO_URL = (
  (import.meta.env.VITE_SLIDR_STUDIO_URL as string | undefined) ?? 'http://127.0.0.1:8765'
).replace(/\/?$/, '/');

/** What the library needs of a variant of the studio. */
export interface Variant {
  id: string;
  requestId: string;
  designId?: string;
  published?: boolean;
}

export interface Studio {
  /** The studio's variants, by id; none when the studio is not running. */
  variants: Record<string, Variant>;
  /** The library the studio publishes to (its `SLIDR_MEDIA_URL`). */
  mediaUrl?: string;
}

const NONE: Studio = { variants: {} };

async function read<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, STUDIO_URL), { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()) as T;
}

async function readStudio(): Promise<Studio> {
  const [state, status] = await Promise.all([
    read<{ variants: Variant[] }>('api/state'),
    read<{ media?: { url?: string } }>('api/status'),
  ]);
  return {
    variants: Object.fromEntries(state.variants.map((variant) => [variant.id, variant])),
    mediaUrl: status.media?.url,
  };
}

/** The studio, read once when the page loads; nothing when it does not answer. */
export function useStudio(): Studio {
  const [studio, setStudio] = useState(NONE);
  useEffect(() => {
    let live = true;
    readStudio().then(
      (found) => live && setStudio(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return studio;
}

/** Opens a variant in the studio, in a tab of its own. */
export function openInStudio(variant: Variant) {
  const params = new URLSearchParams({ tab: variant.requestId, v: variant.id });
  window.open(`${STUDIO_URL}#${params}`, 'slidr-studio');
}
