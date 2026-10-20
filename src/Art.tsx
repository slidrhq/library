import { useMemo } from 'react';
import { useT } from './i18n';
import { WhenSeen } from './Lazy';
import { manifest, mediaJson, mediaUrl, size } from './media';
import { ItemOverlay, stepper } from './Overlay';
import { DrawingStage, Markup, NoticeFacts, Paged } from './Svg';
import { matches, useRead, type LibraryRoute } from './shared';

/** An art set as its package stores it (Iconify): a drawing is the inside of an `<svg>`. */
interface ArtSet {
  icons: Record<string, { body: string; width?: number; height?: number }>;
  width?: number;
  height?: number;
}

const FOLDER = 'elements/art/';
/** The side of a drawing's box when neither it nor its set states one (`stickers.ts`). */
const DEFAULT_BOX = 16;

const setPath = (set: string) => `${FOLDER}${set}.json`;
const readSet = (set: string) => mediaJson<ArtSet>(setPath(set));

function markupOf(art: ArtSet, name: string): string | undefined {
  const drawing = art.icons[name];
  if (!drawing) return undefined;
  const width = drawing.width ?? art.width ?? DEFAULT_BOX;
  const height = drawing.height ?? art.height ?? DEFAULT_BOX;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${drawing.body}</svg>`;
}

/** The sets the library publishes, from its manifest. */
const loadSets = () =>
  manifest().then((read) =>
    Object.entries(read.files)
      .filter(
        ([path]) =>
          path.startsWith(FOLDER) && path.endsWith('.json') && !path.endsWith('.notice.json'),
      )
      .map(([path, file]) => ({ id: path.slice(FOLDER.length, -'.json'.length), bytes: file.size }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

/** A few drawings of a set: the ones named that it has, else its first. */
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

function SetView({
  set,
  route,
  go,
  query,
}: {
  set: string;
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
}) {
  const t = useT();
  const art = useRead(() => readSet(set), [set]);
  const names = useMemo(
    () =>
      Object.keys(art.value?.icons ?? {}).filter((name) =>
        matches(query, name, name.replaceAll('-', ' ')),
      ),
    [art.value, query],
  );
  if (art.error) return <p className="error-text">{art.error}</p>;
  if (!art.value) return <p className="muted">{t('library.art.loadingSet')}</p>;
  const open = (name: string) => go({ section: 'art', group: set, item: name });
  const opened = route.item && art.value.icons[route.item] ? route.item : undefined;

  return (
    <>
      <nav className="crumbs">
        <button type="button" className="link" onClick={() => go({ section: 'art' })}>
          {t('library.art.allSets')}
        </button>
        <span dir="ltr">
          {' / '}
          <a href={mediaUrl(setPath(set))} target="_blank" rel="noreferrer">
            {set}
          </a>
        </span>
        <span className="muted small">
          {' '}
          · {t('library.art.count', { count: Object.keys(art.value.icons).length })}
        </span>
      </nav>
      {names.length === 0 && <p className="muted">{t('library.art.noMatch')}</p>}
      <Paged
        key={query}
        items={names}
        render={(name) => (
          <button type="button" key={name} className="tile" onClick={() => open(name)} title={name}>
            <Markup svg={markupOf(art.value!, name)} className="tile-art" />
            <span className="tile-label" dir="ltr">
              {name}
            </span>
          </button>
        )}
      />
      {opened && (
        <ItemOverlay
          key={opened}
          title={<span dir="ltr">{opened}</span>}
          subtitle={<span dir="ltr">{setPath(set)}</span>}
          onClose={() => go({ section: 'art', group: set })}
          onStep={stepper(names, opened, open)}
          side={
            <section>
              <h3>{t('library.art.license')}</h3>
              <NoticeFacts path={`${FOLDER}${set}.notice.json`} />
            </section>
          }
        >
          <DrawingStage svg={markupOf(art.value, opened)} />
        </ItemOverlay>
      )}
    </>
  );
}

/** The colour art sets the graphics and emoji are drawn from, set by set. */
export function Art({
  route,
  go,
  query,
}: {
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
}) {
  const t = useT();
  const sets = useRead(loadSets, []);
  if (route.group) return <SetView set={route.group} route={route} go={go} query={query} />;
  if (sets.error) return <p className="error-text">{sets.error}</p>;
  if (!sets.value) return <p className="muted">{t('library.loading')}</p>;
  const shown = sets.value.filter(({ id }) => matches(query, id));

  return (
    <div className="lib-grid">
      {shown.map(({ id, bytes }) => (
        <button
          type="button"
          key={id}
          className="lib-card"
          onClick={() => go({ section: 'art', group: id })}
        >
          <WhenSeen ratio="4 / 1">
            <ArtPeek set={id} />
          </WhenSeen>
          <span className="lib-card-body">
            <span className="lib-card-title">
              <bdi>{id}</bdi>
            </span>
            <span className="lib-card-meta small muted">
              <bdi>{setPath(id)}</bdi> · <bdi>{size(bytes)}</bdi>
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
