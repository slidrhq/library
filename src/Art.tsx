import { mediaJson } from './media';
import { Markup } from './Svg';
import { useRead } from './shared';

/** An art set as its package stores it (Iconify): a drawing is the inside of an `<svg>`. */
interface ArtSet {
  icons: Record<string, { body: string; width?: number; height?: number }>;
  width?: number;
  height?: number;
}

/** The side of a drawing's box when neither it nor its set states one (`stickers.ts`). */
const DEFAULT_BOX = 16;

const readSet = (set: string) => mediaJson<ArtSet>(`elements/art/${set}.json`);

function markupOf(art: ArtSet, name: string): string | undefined {
  const drawing = art.icons[name];
  if (!drawing) return undefined;
  const width = drawing.width ?? art.width ?? DEFAULT_BOX;
  const height = drawing.height ?? art.height ?? DEFAULT_BOX;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${drawing.body}</svg>`;
}

/**
 * A few drawings of an art set, the ones named that it has, else its first: what the overview
 * shows of the graphics and the emoji, without the app's code that reads their catalogs.
 */
export function ArtPeek({ set, names: wanted }: { set: string; names?: string[] }) {
  const art = useRead(() => readSet(set), [set]);
  if (!art.value) return <span className="peek" />;
  const named = wanted?.filter((name) => art.value!.icons[name]) ?? [];
  // As many as a card of the overview holds.
  const names = (named.length > 0 ? named : Object.keys(art.value.icons)).slice(0, 6);
  return (
    <span className="peek">
      {names.map((name) => (
        <Markup key={name} svg={markupOf(art.value!, name)} className="peek-art" />
      ))}
    </span>
  );
}
