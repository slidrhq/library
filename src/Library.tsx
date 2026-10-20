import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Variant } from './studio';
import { useLang, useT, type Translate } from './i18n';
import { isBase, nativeName, type Lang } from './languages';
import { hasWords, loadWords } from './app';
import { FileFacts, FilePreview, Files } from './Files';
import { Fonts } from './Fonts';
import { WhenSeen } from './Lazy';
import { manifest, MEDIA_LIBRARY_URL, mediaUrl, size, type Manifest } from './media';
import { ItemOverlay } from './Overlay';
import { inSection, sectionOf, SECTIONS, type Section } from './sections';
import { useRead, type LibraryRoute } from './shared';

// Each part is loaded when it is opened: the app's readers it takes read their catalogs as they
// are imported, and none of them should hold up another part.
const Designs = lazy(() => import('./Designs').then((m) => ({ default: m.Designs })));
const Templates = lazy(() => import('./Templates').then((m) => ({ default: m.Templates })));
const Cards = lazy(() => import('./Cards').then((m) => ({ default: m.Cards })));
const Frames = lazy(() => import('./Frames').then((m) => ({ default: m.Frames })));
const Shapes = lazy(() => import('./Shapes').then((m) => ({ default: m.Shapes })));
const Stickers = lazy(() => import('./Stickers').then((m) => ({ default: m.Stickers })));
const Art = lazy(() => import('./Art').then((m) => ({ default: m.Art })));
const Icons = lazy(() => import('./Icons').then((m) => ({ default: m.Icons })));
const ArtPeek = lazy(() => import('./Art').then((m) => ({ default: m.ArtPeek })));
const CardsPeek = lazy(() => import('./Cards').then((m) => ({ default: m.CardsPeek })));
const ShapesPeek = lazy(() => import('./Shapes').then((m) => ({ default: m.ShapesPeek })));
const IconsPeek = lazy(() => import('./Icons').then((m) => ({ default: m.IconsPeek })));

export type { LibraryRoute };

const OVERVIEW = 'overview';

/** The parts whose names are searched in the language shown too, from the app's translations. */
const TRANSLATED = new Set(['designs', 'templates', 'cards', 'shapes']);

/** What the search of a part reads: paths, or names in Hebrew, English and the language shown. */
function searchHint(section: string, lang: Lang, t: Translate): string {
  if (section === 'files') return t('library.searchPath');
  if (TRANSLATED.has(section) && !isBase(lang)) {
    return t('library.searchInLanguage', { language: nativeName(lang) });
  }
  return t('library.searchDefault');
}

function totals(read: Manifest | undefined, section: Section) {
  let count = 0;
  let bytes = 0;
  for (const [path, file] of Object.entries(read?.files ?? {})) {
    if (!inSection(section, path)) continue;
    count += 1;
    bytes += file.size;
  }
  return { count, bytes };
}

/** A few pictures the library publishes for a section, to show what is in it. */
function pictures(read: Manifest | undefined, folder: string, count: number): string[] {
  return Object.keys(read?.files ?? {})
    .filter(
      (path) => path.startsWith(folder) && path.endsWith('.webp') && !path.endsWith('-bg.webp'),
    )
    .filter((_, i, all) => i % Math.max(1, Math.floor(all.length / count)) === 0)
    .slice(0, count);
}

/** What each part looks like, drawn from the library itself. */
const PEEKS: Record<string, () => ReactNode> = {
  cards: () => <CardsPeek />,
  shapes: () => <ShapesPeek />,
  // The illustrated graphics draw from this set, among others.
  graphics: () => <ArtPeek set="streamline-stickies-color" />,
  emoji: () => (
    <ArtPeek
      set="twemoji"
      names={['grinning-face', 'party-popper', 'red-heart', 'thumbs-up', 'rocket', 'light-bulb']}
    />
  ),
  art: () => <ArtPeek set="noto" />,
  icons: () => <IconsPeek />,
  fonts: () => (
    <span className="peek">
      <span className="peek-glyph fonts">
        <span style={{ fontFamily: 'Heebo' }}>אב</span>
        <span style={{ fontFamily: 'Frank Ruhl Libre' }}>גד</span>
        <span style={{ fontFamily: 'Karantina' }}>הו</span>
        <span style={{ fontFamily: 'Playfair Display' }}>Aa</span>
        <span style={{ fontFamily: 'JetBrains Mono' }}>{'{}'}</span>
      </span>
    </span>
  ),
  files: () => (
    <span className="peek">
      <span className="peek-glyph mono" dir="ltr">
        manifest.json
      </span>
    </span>
  ),
};

/** The folder of pictures a part shows a few of. */
const PICTURES: Record<string, string> = {
  designs: 'images/designs/',
  templates: 'images/templates/',
  frames: 'images/frames/he/',
};

function Peek({ section, read }: { section: Section; read?: Manifest }) {
  const folder = PICTURES[section.id];
  if (!folder) {
    return <Suspense fallback={<span className="peek" />}>{PEEKS[section.id]?.()}</Suspense>;
  }
  return (
    <span className="peek photos">
      {pictures(read, folder, 4).map((path) => (
        <img key={path} src={mediaUrl(path)} alt="" loading="lazy" />
      ))}
    </span>
  );
}

function Overview({ go }: { go: (route: LibraryRoute) => void }) {
  const t = useT();
  const files = (count: number) =>
    count === 1 ? t('library.fileOne') : t('library.fileMany', { count });
  const read = useRead(manifest, []);
  return (
    <div className="lib-grid overview">
      {SECTIONS.map((section) => {
        const { count, bytes } = totals(read.value, section);
        return (
          <button
            type="button"
            key={section.id}
            className="lib-card section-card"
            onClick={() => go({ section: section.id })}
          >
            <WhenSeen ratio="5 / 2">
              <Peek section={section} read={read.value} />
            </WhenSeen>
            <span className="lib-card-body">
              <span className="lib-card-title">{t(section.nameKey)}</span>
              <span className="muted small">{t(section.aboutKey)}</span>
              <span className="lib-card-meta small muted">
                {read.value
                  ? t('library.filesAndSize', { files: files(count), size: size(bytes) })
                  : '…'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const published = (t: Translate, locale: string, when?: string) =>
  when
    ? new Date(when).toLocaleString(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : t('library.publishedUnknown');

/**
 * The media library as it is published: each of its parts, drawn as the app draws it, and every
 * file of it. Read-only: publishing goes through the studio (github.com/slidrhq/studio).
 */
export function Library({
  route,
  go,
  lang,
  variants,
  serverUrl,
  onOpenVariant,
}: {
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  lang: Lang;
  variants: Record<string, Variant>;
  /** The library the server publishes to (`SLIDR_MEDIA_URL`). */
  serverUrl?: string;
  onOpenVariant: (variant: Variant) => void;
}) {
  const t = useT();
  const [uiLang] = useLang();
  const read = useRead(manifest, []);
  const section = sectionOf(route.section);
  // A language is shown once the app's words in it are read; until then, the one before.
  const [shown, setShown] = useState<Lang>(() => (hasWords(lang) ? lang : 'en'));
  useEffect(() => {
    let live = true;
    const show = () => live && setShown(lang);
    loadWords(lang).then(show, show);
    return () => {
      live = false;
    };
  }, [lang]);
  // What was searched for, in the part it was typed in: another part starts without it.
  const [search, setSearch] = useState({ section: route.section, text: '' });
  const query = search.section === route.section ? search.text : '';
  const totalBytes = useMemo(
    () => Object.values(read.value?.files ?? {}).reduce((sum, file) => sum + file.size, 0),
    [read.value],
  );
  const other =
    serverUrl && serverUrl.replace(/\/?$/, '/') !== MEDIA_LIBRARY_URL ? serverUrl : undefined;

  const props = { route, go, query, lang: shown };
  let content: ReactNode;
  switch (section?.id) {
    case 'designs':
      content = <Designs {...props} variants={variants} onOpenVariant={onOpenVariant} />;
      break;
    case 'templates':
      content = <Templates {...props} />;
      break;
    case 'cards':
      content = <Cards {...props} />;
      break;
    case 'frames':
      content = <Frames {...props} />;
      break;
    case 'shapes':
      content = <Shapes {...props} />;
      break;
    case 'graphics':
      content = <Stickers kind="graphics" {...props} />;
      break;
    case 'emoji':
      content = <Stickers kind="emoji" {...props} />;
      break;
    case 'art':
      content = <Art {...props} />;
      break;
    case 'icons':
      content = <Icons {...props} />;
      break;
    case 'fonts':
      content = <Fonts {...props} />;
      break;
    case 'files':
      content = <Files {...props} />;
      break;
    default:
      content = <Overview go={go} />;
  }

  return (
    <div className="library">
      <aside className="lib-nav" aria-label={t('library.navLabel')}>
        <div className="lib-nav-head">
          <h2>{t('library.title')}</h2>
          <p className="muted small">
            {t('library.publishedAt', { when: published(t, uiLang, read.value?.published) })}
            <br />
            {read.value
              ? t('library.filesAndSize', {
                  files: t('library.fileMany', { count: Object.keys(read.value.files).length }),
                  size: size(totalBytes),
                })
              : '…'}
          </p>
          <a className="small" href={MEDIA_LIBRARY_URL} target="_blank" rel="noreferrer" dir="ltr">
            {MEDIA_LIBRARY_URL.replace(/^https:\/\//, '')}
          </a>
          {other && (
            <p className="warn small">
              {t('library.otherServer', { url: '\u2066' + other + '\u2069' })}
            </p>
          )}
        </div>
        <nav className="lib-sections">
          <button
            type="button"
            aria-current={!section ? 'page' : undefined}
            onClick={() => go({ section: OVERVIEW })}
          >
            {t('library.overview')}
          </button>
          {SECTIONS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              aria-current={section?.id === entry.id ? 'page' : undefined}
              onClick={() => go({ section: entry.id })}
            >
              {t(entry.nameKey)}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="ghost small"
          onClick={() => location.reload()}
          title={t('library.reloadHint')}
        >
          {t('library.reload')}
        </button>
      </aside>

      <div className="lib-main">
        <header className="lib-head">
          <div>
            <h2>{section ? t(section.nameKey) : t('library.overview')}</h2>
            <p className="muted small">
              {section ? t(section.aboutKey) : t('library.overviewAbout')}
            </p>
          </div>
          {section && (
            <input
              type="search"
              className="lib-search"
              value={query}
              onChange={(event) => setSearch({ section: route.section, text: event.target.value })}
              placeholder={searchHint(section.id, shown, t)}
              aria-label={t('library.searchLabel')}
            />
          )}
        </header>
        {read.error && (
          <p className="error-text">{t('library.readFailed', { error: read.error })}</p>
        )}
        <Suspense fallback={<p className="muted">{t('library.loading')}</p>}>{content}</Suspense>
      </div>

      {section?.id === 'files' && route.item && (
        <ItemOverlay
          key={route.item}
          title={<span dir="ltr">{route.item.split('/').at(-1)}</span>}
          subtitle={<span dir="ltr">{route.item}</span>}
          onClose={() => go({ ...route, item: undefined })}
          side={<FileFacts path={route.item} file={read.value?.files[route.item]} />}
        >
          <FilePreview path={route.item} file={read.value?.files[route.item]} />
        </ItemOverlay>
      )}
    </div>
  );
}
