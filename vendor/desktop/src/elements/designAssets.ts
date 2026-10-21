import { mediaFiles, mediaUrl, readMediaJson } from '@slidr/media-library';
import type { AssetMeta } from '@slidr/model';
import type { DesignId } from './designs';

const sizes =
  (await readMediaJson<Record<string, number[] | undefined>>('images/designs/sizes.json')) ?? {};

/**
 * The originals in the media library, by file name: `<id>.webp` is a design's picture, and
 * `<id>-bg.webp` the photographic backdrop a few designs lay under their subject. They are
 * imported into the document when a design is chosen. Where a design has a subject of its own (a
 * person, a product), the picture is the subject alone on a transparent ground, so it stays usable
 * when the background behind it is changed.
 */
const files = await mediaFiles();
const url = (name: string) => {
  const path = `images/designs/${name}.webp`;
  return files.has(path) ? mediaUrl(path) : undefined;
};

export const previewAssetId = (id: DesignId) => `design-preview-${id}`;
export const previewBackdropId = (id: DesignId) => `design-preview-${id}-bg`;

/** A picture's width and height in pixels. */
type Size = readonly [number, number];

/**
 * The record of a bundled picture, for the gallery. It carries the picture's size in pixels
 * (`scripts/design-asset-sizes.mjs`; a managed design's, which `managed.json` gives, from the
 * caller): a cropped picture cannot be drawn without it.
 */
function meta(id: string, name: string, managed?: Size): AssetMeta {
  const size = sizes[name] ?? managed;
  const file = `${name}.webp`;
  return {
    id,
    file,
    mime: 'image/webp',
    kind: 'image',
    origin: 'import',
    bytes: 0,
    name: file,
    ...(size ? { width: size[0], height: size[1] } : {}),
  };
}

/** The preview record of a design's picture; `managed`, its size as `managed.json` gives it. */
export const previewAsset = (id: DesignId, managed?: Size) => meta(previewAssetId(id), id, managed);

/** The preview record of a design's backdrop, when it has one. */
export function previewBackdrop(id: DesignId, managed?: Size): AssetMeta | undefined {
  return url(`${id}-bg`) ? meta(previewBackdropId(id), `${id}-bg`, managed) : undefined;
}

export function designAssetUrl(asset: AssetMeta): string | undefined {
  const name = asset.id.replace(/^design-preview-/, '');
  return name === asset.id ? undefined : url(name);
}

async function bundled(name: string): Promise<File> {
  const address = url(name);
  const response = address ? await fetch(address) : undefined;
  if (!response?.ok) throw new Error(`Could not load design image: ${name}.webp`);
  return new File([await response.blob()], `${name}.webp`, { type: 'image/webp' });
}

export const designAssetFile = (id: DesignId) => bundled(id);

/** The file of a design's backdrop, when it has one. */
export function designBackdropFile(id: DesignId): Promise<File> | undefined {
  return url(`${id}-bg`) ? bundled(`${id}-bg`) : undefined;
}
