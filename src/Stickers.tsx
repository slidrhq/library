import { useMemo } from 'react';
import type { Lang } from './languages';
import { useLang, useT } from './i18n';
import { messages, named, stickersModule } from './app';
import { mediaUrl } from './media';
import { ItemOverlay, stepper } from './Overlay';
import { DrawingStage, Markup, NoticeFacts, Paged } from './Svg';
import { useRead, type LibraryRoute } from './shared';

type StickersMod = Awaited<ReturnType<typeof stickersModule>>;
type Sticker = Awaited<ReturnType<StickersMod['loadGraphics']>>[number];

const KINDS = {
  graphics: {
    catalog: 'elements/catalogs/graphics-catalog.json',
    load: (mod: StickersMod) => mod.loadGraphics(),
    groups: (mod: StickersMod) => mod.GRAPHIC_STYLES as readonly string[],
    groupName: (group: string, lang: Lang) =>
      named(messages.elements, lang, 'graphics', group) ?? group,
  },
  emoji: {
    catalog: 'elements/catalogs/emoji-catalog.json',
    load: (mod: StickersMod) => mod.loadEmoji(),
    groups: (mod: StickersMod) => mod.EMOJI_GROUPS as readonly string[],
    groupName: (group: string, lang: Lang) =>
      named(messages.elements, lang, 'emoji', 'group', group) ?? group,
  },
};

/** Every sticker of a kind, with the markup each is drawn with. */
async function loadKind(kind: keyof typeof KINDS) {
  const mod = await stickersModule();
  const stickers = await KINDS[kind].load(mod);
  const markup = new Map<string, string | undefined>();
  await Promise.all(
    stickers.map(async (sticker) => markup.set(sticker.id, await mod.stickerMarkup(sticker))),
  );
  return { mod, stickers, markup };
}

function StickerDetail({
  sticker,
  svg,
  kind,
  onClose,
  onStep,
}: {
  sticker: Sticker;
  svg?: string;
  kind: keyof typeof KINDS;
  onClose: () => void;
  onStep?: (by: -1 | 1) => void;
}) {
  const t = useT();
  const [lang] = useLang();
  const hebrewWords = [...sticker.nameTerms, ...sticker.tagTerms].filter(Boolean);
  return (
    <ItemOverlay
      title={
        <>
          {sticker.label.he} <span className="muted">·</span>{' '}
          <span className="muted" dir="ltr">
            {sticker.label.en}
          </span>
        </>
      }
      subtitle={
        <>
          <span dir="ltr">{sticker.id}</span> · {KINDS[kind].groupName(sticker.group, lang)}
        </>
      }
      onClose={onClose}
      onStep={onStep}
      side={
        <>
          <section>
            <h3>{t('libraryCatalogs.details')}</h3>
            <dl className="facts">
              <dt>{t('libraryCatalogs.id')}</dt>
              <dd dir="ltr">{sticker.id}</dd>
              <dt>{t('libraryCatalogs.stickers.setOfArt')}</dt>
              <dd dir="ltr">
                <a
                  href={mediaUrl(`elements/art/${sticker.set}.json`)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {sticker.set}
                </a>{' '}
                · {sticker.art}
              </dd>
              <dt>{t('libraryCatalogs.stickers.englishWords')}</dt>
              <dd dir="ltr">{[...sticker.nameWords, ...sticker.tagWords].join(', ') || '—'}</dd>
              <dt>{t('libraryCatalogs.stickers.hebrewWords')}</dt>
              <dd>{hebrewWords.join(', ') || '—'}</dd>
              <dt>{t('libraryCatalogs.stickers.catalog')}</dt>
              <dd dir="ltr">{KINDS[kind].catalog}</dd>
            </dl>
          </section>
          <section>
            <h3>{t('libraryCatalogs.stickers.kitLicense')}</h3>
            <NoticeFacts path={`elements/art/${sticker.set}.notice.json`} />
          </section>
        </>
      }
    >
      {svg ? (
        <DrawingStage svg={svg} />
      ) : (
        <p className="warn">{t('libraryCatalogs.stickers.kitGone')}</p>
      )}
    </ItemOverlay>
  );
}

/** The graphics in their four styles, or the emoji in Unicode's groups, as Elements offers them. */
export function Stickers({
  kind,
  route,
  go,
  query,
  lang,
}: {
  kind: keyof typeof KINDS;
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
  lang: Lang;
}) {
  const t = useT();
  const read = useRead(() => loadKind(kind), [kind]);
  const found = useMemo(() => {
    if (!read.value) return [];
    const { mod, stickers } = read.value;
    const inGroup = stickers.filter((sticker) => !route.group || sticker.group === route.group);
    if (!query.trim()) return inGroup;
    return mod.searchStickers(inGroup, query, inGroup.length);
  }, [read.value, route.group, query]);

  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!read.value) return <p className="muted">{t('libraryCatalogs.loading')}</p>;
  const { mod, stickers, markup } = read.value;
  const groups = KINDS[kind].groups(mod);
  const ids = found.map((sticker) => sticker.id);
  const open = (id: string) => go({ ...route, item: id });
  const opened = stickers.find((sticker) => sticker.id === route.item);

  return (
    <>
      <div className="lib-filters">
        <div className="chips" role="group" aria-label={t('libraryCatalogs.group')}>
          <button
            type="button"
            className="chip"
            aria-pressed={!route.group}
            onClick={() => go({ section: kind })}
          >
            {t('libraryCatalogs.all')} <span className="muted">{stickers.length}</span>
          </button>
          {groups.map((group) => (
            <button
              type="button"
              key={group}
              className="chip"
              aria-pressed={route.group === group}
              onClick={() => go({ section: kind, group })}
            >
              {KINDS[kind].groupName(group, lang)}{' '}
              <span className="muted">{stickers.filter((s) => s.group === group).length}</span>
            </button>
          ))}
        </div>
      </div>
      {found.length === 0 && <p className="muted">{t('libraryCatalogs.stickers.noResults')}</p>}
      <Paged
        key={`${route.group}:${query}`}
        items={found}
        render={(sticker) => (
          <button
            type="button"
            key={sticker.id}
            className="tile"
            onClick={() => open(sticker.id)}
            title={`${sticker.label.he} · ${sticker.label.en}`}
          >
            <Markup svg={markup.get(sticker.id)} className="tile-art" />
            <span className="tile-label" dir="auto">
              {sticker.label[lang === 'he' ? 'he' : 'en']}
            </span>
          </button>
        )}
      />
      {opened && (
        <StickerDetail
          key={opened.id}
          sticker={opened}
          svg={markup.get(opened.id)}
          kind={kind}
          onClose={() => go({ ...route, item: undefined })}
          onStep={stepper(ids, opened.id, open)}
        />
      )}
    </>
  );
}
