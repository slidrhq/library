import { useEffect, useState } from 'react';
import { useLang, useT } from './i18n';
import { LanguagePicker } from './languages';
import { Library } from './Library';
import type { LibraryRoute } from './shared';
import { openInStudio, useStudio } from './studio';

const OVERVIEW = 'overview';

function readHash(): LibraryRoute {
  const params = new URLSearchParams(location.hash.slice(1));
  const slide = params.get('s');
  return {
    section: params.get('lib') ?? OVERVIEW,
    group: params.get('g') ?? undefined,
    item: params.get('i') ?? undefined,
    folder: params.get('f') ?? undefined,
    slide: slide === null ? undefined : Number(slide),
  };
}

function hashOf({ section, group, item, folder, slide }: LibraryRoute): string {
  const params = new URLSearchParams({ lib: section });
  if (group) params.set('g', group);
  if (folder) params.set('f', folder);
  if (item) params.set('i', item);
  if (slide !== undefined) params.set('s', String(slide));
  return `#${params}`;
}

/** The library browser, with the language it is shown in. */
export function Shell() {
  const [route, setRoute] = useState(readHash);
  const [lang, setLang] = useLang();
  const t = useT();
  const studio = useStudio();

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  // Browsing is kept in the history, so Back leaves an item or a section.
  const go = (next: LibraryRoute) => {
    history.pushState(null, '', hashOf(next));
    setRoute(next);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            S
          </span>
          <div>
            <h1>Slidr Library</h1>
            <p>{t('shell.subtitle')}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <LanguagePicker lang={lang} onChange={setLang} label={t('shell.displayLanguage')} />
        </div>
      </header>
      <main>
        <Library
          route={route}
          go={go}
          lang={lang}
          variants={studio.variants}
          serverUrl={studio.mediaUrl}
          onOpenVariant={openInStudio}
        />
      </main>
    </div>
  );
}
