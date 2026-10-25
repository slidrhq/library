import { mediaFiles, mediaUrl } from '@slidr/media-library';
import { createDeck, languageDir, type AssetMeta, type Deck, type Slide } from '@slidr/model';
import { loadCharts } from '@slidr/renderer';
import { templateCover, withStandardLayouts, type Template } from '@slidr/templates';
import { pictures } from '@slidr/templates/builtin/pictures';
import { useEffect, useMemo, useState } from 'react';
import { useT } from './i18n';
import { isBase, LanguageNames, LanguagePicker, nativeName, type Lang } from './languages';
import { messages, named, samplesModule, templatesModule } from './app';
import { DeckSlide } from './Lazy';
import { ItemOverlay, stepper } from './Overlay';
import { matches, useRead, type LibraryRoute } from './shared';

const dirOf = languageDir;

/**
 * The templates as the app's library holds them: in the published order, standard layouts in,
 * with the languages the sample of each is written in.
 */
const load = async () => {
  const [{ builtIn }, files, samples] = await Promise.all([
    templatesModule(),
    mediaFiles(),
    samplesModule(),
  ]);
  return {
    templates: builtIn.map((template) => withStandardLayouts(template)),
    files,
    languages: await samples.sampleLanguages(),
  };
};

const nameOf = (template: Template, lang: Lang) =>
  named(messages.templates, lang, 'name', template.theme.id) ?? template.theme.name;
const taglineOf = (template: Template, lang: Lang) =>
  named(messages.templates, lang, 'tagline', template.theme.id);

/**
 * The photograph on the cover of each built-in template that opens with one: the one the opening
 * slide of its sample shows (as `desktop/src/templates/covers.ts` has them).
 */
const COVERS: Record<string, AssetMeta | undefined> = {
  shvil: pictures.shvilRidge,
  tzuk: pictures.tzukWarehouse,
  lavan: pictures.lavanChair1,
  nof: pictures.nofView2,
  defus: pictures.defusStreet1,
  shidur: pictures.migdalTeam2,
  mifgash: pictures.mifgashCall,
};

/**
 * A template's cover as the app's gallery draws it (`templateCover`): its opening layout with its
 * name, and the photograph of a template that opens with one.
 */
function coverOf(
  template: Template,
  lang: Lang,
  files: ReadonlySet<string>,
): { deck: Deck; slide: Slide; resolve: (asset: AssetMeta) => string | undefined } {
  const picture = COVERS[template.theme.id];
  const path = picture ? `images/templates/${picture.name}` : undefined;
  const url = path && files.has(path) ? mediaUrl(path) : undefined;
  const resolve = (asset: AssetMeta) => (asset.id === picture?.id ? url : undefined);
  const cover = templateCover(template, {
    lang,
    dir: dirOf(lang),
    name: nameOf(template, lang),
    ...(url ? { picture } : {}),
  });
  return { ...cover, resolve };
}

function Cover({
  template,
  lang,
  files,
}: {
  template: Template;
  lang: Lang;
  files: ReadonlySet<string>;
}) {
  const cover = useMemo(() => coverOf(template, lang, files), [template, lang, files]);
  return <DeckSlide deck={cover.deck} slide={cover.slide} resolveAsset={cover.resolve} lazy />;
}

const sampleDecks = new Map<
  string,
  Promise<{ deck?: Deck; resolve: (a: AssetMeta) => string | undefined }>
>();

/** The sample deck of a template in a language, as the app's library shows it under the card. */
function sampleOf(template: Template, lang: Lang) {
  const key = `${template.theme.id}:${lang}`;
  let pending = sampleDecks.get(key);
  if (!pending) {
    pending = samplesModule().then(async ({ builtInSampleDeck, pictureUrl }) => ({
      deck: await builtInSampleDeck(template, createDeck({ lang, dir: dirOf(lang) })),
      resolve: pictureUrl,
    }));
    pending.catch(() => sampleDecks.delete(key));
    sampleDecks.set(key, pending);
  }
  return pending;
}

function Swatches({ template }: { template: Template }) {
  const colors = template.theme.colors as unknown as Record<string, string>;
  return (
    <div className="swatches">
      {Object.entries(colors).map(([token, value]) => (
        <span key={token} className="swatch" title={`${token}: ${value}`}>
          <span className="swatch-color" style={{ background: value }} />
          <span dir="ltr">{token}</span>
        </span>
      ))}
    </div>
  );
}

function TemplateDetail({
  template,
  lang: initial,
  languages,
  slide: chosen,
  onSlide,
  onClose,
  onStep,
}: {
  template: Template;
  lang: Lang;
  /** The languages its sample is written in. */
  languages: Lang[];
  slide: number;
  onSlide: (index: number) => void;
  onClose: () => void;
  onStep?: (by: -1 | 1) => void;
}) {
  const t = useT();
  const [lang, setLang] = useState<Lang>(initial);
  const sample = useRead(() => sampleOf(template, lang), [template, lang]);
  const deck = sample.value?.deck;
  const index = deck ? Math.min(chosen, deck.slides.length - 1) : 0;
  const current = deck?.slides[index];
  useEffect(() => {
    void loadCharts().catch(() => undefined);
  }, []);
  const { fonts } = template.theme;

  return (
    <ItemOverlay
      title={
        <>
          {nameOf(template, 'he')} <span className="muted">·</span>{' '}
          <span className="muted" dir="ltr">
            {nameOf(template, 'en')}
          </span>
        </>
      }
      subtitle={taglineOf(template, 'he') ?? template.description}
      actions={
        // The sample only in the languages it is written in, as the app shows it.
        <LanguagePicker
          lang={lang}
          onChange={setLang}
          langs={languages.length > 0 ? languages : undefined}
        />
      }
      onClose={onClose}
      onStep={onStep}
      side={
        <>
          <section>
            <h3>{t('libraryBrowse.details')}</h3>
            <dl className="facts">
              <dt>{t('libraryBrowse.id')}</dt>
              <dd dir="ltr">{template.theme.id}</dd>
              <dt>{t('libraryBrowse.templateDirection')}</dt>
              <dd dir="ltr">{template.dir}</dd>
              <dt>layouts</dt>
              <dd>{template.layouts.length}</dd>
              <dt>{t('libraryBrowse.templateSampleSlides')}</dt>
              <dd>{deck ? deck.slides.length : '…'}</dd>
              <dt>{t('libraryBrowse.templateSampleLanguages')}</dt>
              <dd>
                <LanguageNames langs={languages} />
              </dd>
              <dt>{t('libraryBrowse.templateHeadingFont')}</dt>
              <dd dir="ltr">
                {fonts.heading.he} / {fonts.heading.latin}
              </dd>
              <dt>{t('libraryBrowse.templateBodyFont')}</dt>
              <dd dir="ltr">
                {fonts.body.he} / {fonts.body.latin}
              </dd>
              <dt>{t('libraryBrowse.templateCorners')}</dt>
              <dd dir="ltr">{template.theme.radius}px</dd>
            </dl>
            <p className="muted small" dir="ltr">
              {template.description}
            </p>
          </section>
          <section>
            <h3>{t('libraryBrowse.templateColors')}</h3>
            <Swatches template={template} />
          </section>
          <section>
            <h3>Layouts</h3>
            <ul className="plain-list" dir="ltr">
              {template.layouts.map((layout) => (
                <li key={layout.id}>
                  {layout.name} · {layout.archetype}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>{t('libraryBrowse.files')}</h3>
            <ul className="plain-list" dir="ltr">
              <li>
                <a
                  href={mediaUrl(`templates/${template.theme.id}/template.json`)}
                  target="_blank"
                  rel="noreferrer"
                >
                  templates/{template.theme.id}/template.json
                </a>
              </li>
              <li>templates/catalog.json · samples.{template.theme.id}</li>
            </ul>
          </section>
        </>
      }
    >
      {sample.error && <p className="error-text">{sample.error}</p>}
      {!sample.value && !sample.error && <div className="slide-empty working big" />}
      {sample.value && !deck && <p className="muted">{t('libraryBrowse.templateNoSample')}</p>}
      {deck && current && (
        <>
          <DeckSlide deck={deck} slide={current} resolveAsset={sample.value?.resolve} />
          <p className="muted small">
            {t('libraryBrowse.templateSlideOf', { number: index + 1, total: deck.slides.length })}
            {current.name && ` · ${current.name}`}
          </p>
          <div className="filmstrip">
            {deck.slides.map((slide, i) => (
              <button
                type="button"
                key={slide.id}
                className="film"
                aria-current={i === index ? 'true' : undefined}
                onClick={() => onSlide(i)}
                title={slide.name}
              >
                <DeckSlide deck={deck} slide={slide} resolveAsset={sample.value?.resolve} lazy />
                <span className="film-number">{i + 1}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </ItemOverlay>
  );
}

/** The built-in templates: a cover of each, and its whole sample deck up close. */
export function Templates({
  route,
  go,
  query,
  lang,
}: {
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
  lang: Lang;
}) {
  const t = useT();
  const read = useRead(load, []);
  // Only the templates whose sample is written in the language shown, as the app offers them
  // (ADR-104); one with no sample, which the app shows in its own words, in every language.
  const offered = useMemo(() => {
    const languages = read.value?.languages ?? {};
    return (read.value?.templates ?? []).filter(
      (template) => languages[template.theme.id]?.includes(lang) ?? true,
    );
  }, [read.value, lang]);
  const shown = useMemo(
    () =>
      offered.filter((template) =>
        matches(
          query,
          template.theme.id,
          nameOf(template, 'he'),
          nameOf(template, 'en'),
          nameOf(template, lang),
          taglineOf(template, 'he'),
          taglineOf(template, lang),
          template.description,
        ),
      ),
    [offered, lang, query],
  );
  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!read.value) return <p className="muted">{t('libraryBrowse.templatesLoading')}</p>;
  const { templates, files, languages } = read.value;
  const languagesOf = (template: Template) => languages[template.theme.id] ?? [];
  const ids = shown.map((template) => template.theme.id);
  const open = (id: string) => go({ section: 'templates', item: id });
  const opened = offered.find((template) => template.theme.id === route.item);

  return (
    <>
      {!isBase(lang) && (
        <p className="muted small">
          {t('libraryBrowse.templatesWrittenIn', {
            shown: offered.length,
            total: templates.length,
          })}
          <bdi lang={lang}>{nativeName(lang)}</bdi>.
        </p>
      )}
      {shown.length === 0 && <p className="muted">{t('libraryBrowse.templatesNone')}</p>}
      <div className="lib-grid wide">
        {shown.map((template) => {
          // The words of a card read in their own language's direction; a tagline not yet
          // translated falls back to the English description.
          const tagline = taglineOf(template, lang);
          return (
            <button
              type="button"
              key={template.theme.id}
              className="lib-card"
              onClick={() => open(template.theme.id)}
            >
              <Cover template={template} lang={lang} files={files} />
              <span className="lib-card-body">
                <span className="lib-card-title">
                  <span lang={lang} dir={dirOf(lang)}>
                    {nameOf(template, lang)}
                  </span>
                  {/* Beside a name in another language, the English one: the id is in the detail. */}
                  {lang !== 'en' && (
                    <>
                      {' '}
                      <span className="muted" lang="en" dir="ltr">
                        {nameOf(template, 'en')}
                      </span>
                    </>
                  )}
                </span>
                <span
                  className="muted small clamp"
                  lang={tagline ? lang : 'en'}
                  dir={tagline ? dirOf(lang) : 'ltr'}
                >
                  {tagline ?? template.description}
                </span>
                <span className="lib-card-meta small muted">{template.layouts.length} layouts</span>
              </span>
            </button>
          );
        })}
      </div>
      {opened && (
        <TemplateDetail
          key={opened.theme.id}
          template={opened}
          lang={lang}
          languages={languagesOf(opened)}
          slide={route.slide ?? 0}
          onSlide={(index) => go({ ...route, slide: index })}
          onClose={() => go({ section: 'templates' })}
          onStep={stepper(ids, opened.theme.id, open)}
        />
      )}
    </>
  );
}
