import { readMediaJson } from '@slidr/media-library';
import { managedSize, type ManagedDesignCatalog } from './designCatalog';

/**
 * The designs Slidr Studio publishes, `elements/designs/managed.json` (docs/media-library.md),
 * read once for the catalog (`designs.ts`) and for the sizes of their pictures (`designAssets.ts`).
 * Without the file there are none.
 */
export const MANAGED_DESIGNS = await readMediaJson<Partial<ManagedDesignCatalog>>(
  'elements/designs/managed.json',
);

/** The pixel size of a managed design's picture, by its file name without `.webp`. */
export const managedPictureSize = (name: string) => managedSize(MANAGED_DESIGNS, name);
