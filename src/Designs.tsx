import type { AssetMeta } from '@slidr/model';
import { useMemo, useState } from 'react';
import type { Variant } from './studio';
import { useT } from './i18n';
import { isBase, LanguageNames, LanguagePicker, nativeName, type Lang } from './languages';
import { designsModule, designThumbsModule, iconSearchModule, messages, named } from './app';
import { DeckSlide } from './Lazy';
import { manifest, mediaUrl, size } from './media';
import { ItemOverlay, stepper } from './Overlay';
import { finds, matches, TagFacts, useRead, type LibraryRoute } from './shared';
import { useWidth } from './width';

type Designs = Awaited<ReturnType<Awaited<ReturnType<typeof designsModule>>['loadDesigns']>>;
type FindThumb = Awaited<
  ReturnType<Awaited<ReturnType<typeof designThumbsModule>>['loadDesignThumbs']>
>;
type Tags = Awaited<ReturnType<Designs['loadDesignTags']>>;

/** The width a design's pictures are made at, at which the detail view shows them (ADR-111). */
const THUMB = 320;

/** The designs drawn in a language, read once a language (ADR-109). */
const designsIn = (lang: Lang) => designsModule().then((designs) => designs.loadDesigns(lang));
const thumbs = () => designThumbsModule().then((module) => module.loadDesignThumbs());

/**
 * The designs of a language, the pictures made of them, the app's search, and the tags it finds
 * them by (ADR-108).
 */
const load = (lang: Lang) =>
  Promise.all([designsIn(lang), thumbs(), iconSearchModule()]).then(
    async ([designs, thumb, search]) =>
      [designs, thumb, search, await designs.loadDesignTags()] as const,
  );

type Source = 'all' | 'authored' | 'managed';

/** The app's names first, then the ones `managed.json` gives, then the id (`DesignsCollection`). */
const nameOf = (designs: Designs, id: string, lang: Lang) =>
  named(messages.elements, lang, 'designs', 'name', id) ?? designs.designName(id, lang) ?? id;
const groupNameOf = (designs: Designs, group: string, lang: Lang) =>
  named(messages.elements, lang, 'designs', 'group', group) ??
  designs.designGroupName(group, lang) ??
  group;

const previews = new Map<string, ReturnType<Designs['designPreview']>>();

/** A design as the gallery draws it, in a language: kept, since a slide is costly to build. */
function previewOf(designs: Designs, id: string, lang: Lang) {
  const key = `${id}:${lang}`;
  let preview = previews.get(key);
  if (!preview) {
    preview = designs.designPreview(id, lang);
    previews.set(key, preview);
  }
  return preview;
}

function DesignView({
  designs,
  id,
  lang,
  width,
  lazy,
}: {
  designs: Designs;
  id: string;
  lang: Lang;
  width?: number;
  lazy?: boolean;
}) {
  const { deck, slide, resolveAsset } = previewOf(designs, id, lang);
  return (
    <DeckSlide deck={deck} slide={slide} resolveAsset={resolveAsset} width={width} lazy={lazy} />
  );
}

/**
 * The picture made of a design ahead, at the width it is shown at or at the width of its place.
 * It is asked for once that width is known, as the app's panel does: before it, the browser would
 * take the picture for the whole screen's width and then the one the card needs, and show the
 * first at twice the card's width until the second came. Its place keeps the slide's shape, so a
 * picture not yet read leaves the cards where they are, and only those near the screen are read.
 */
function DesignPicture({
  made,
  lang,
  width: fixed,
}: {
  made: NonNullable<ReturnType<FindThumb>>;
  lang: Lang;
  width?: number;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const width = fixed ?? measured;
  return (
    <div
      ref={ref}
      className="slide-frame design-frame"
      style={fixed ? { width: fixed } : undefined}
    >
      {width > 0 && (
        <img
          src={made.src}
          srcSet={made.srcSet}
          sizes={`${Math.round(width)}px`}
          lang={lang}
          alt=""
          loading="lazy"
          decoding="async"
          className="design-picture"
        />
      )}
    </div>
  );
}

/**
 * A design in a language as the gallery shows it: the picture made of it ahead, or, where it has
 * none, drawn live from the designs of that language, read when it is first shown.
 */
function DesignIn({
  id,
  lang,
  thumb,
  width,
}: {
  id: string;
  lang: Lang;
  thumb: FindThumb;
  width?: number;
}) {
  const made = thumb(id, lang);
  const drawn = useRead(
    () => (made ? Promise.resolve(undefined) : designsIn(lang)),
    [Boolean(made), lang],
  );
  if (made) return <DesignPicture made={made} lang={lang} width={width} />;
  if (!drawn.value) {
    return (
      <div className="slide-frame" style={width ? { width } : undefined}>
        <div className="slide-empty" />
      </div>
    );
  }
  return <DesignView designs={drawn.value} id={id} lang={lang} width={width} />;
}

function Picture({ asset, label }: { asset: AssetMeta; label: string }) {
  const files = useRead(manifest, []);
  const path = `images/designs/${asset.file}`;
  const file = files.value?.files[path];
  return (
    <figure className="picture-fact">
      <a href={mediaUrl(path)} target="_blank" rel="noreferrer" className="checker">
        <img src={mediaUrl(path)} alt={label} loading="lazy" />
      </a>
      <figcaption dir="ltr">
        {label}: {asset.file}
        <span className="muted">
          {asset.width && asset.height ? `${asset.width}×${asset.height}` : 'no size'}
          {file && ` · ${size(file.size)}`}
        </span>
      </figcaption>
    </figure>
  );
}

function DesignDetail({
  designs,
  thumb,
  id,
  lang: initial,
  tags,
  variant,
  onOpenVariant,
  onClose,
  onStep,
}: {
  designs: Designs;
  thumb: FindThumb;
  id: string;
  lang: Lang;
  tags: Tags;
  variant?: Variant;
  onOpenVariant: (variant: Variant) => void;
  onClose: () => void;
  onStep?: (by: -1 | 1) => void;
}) {
  const t = useT();
  const [lang, setLang] = useState<Lang>(initial);
  // The design up close, in the language its picker shows: the designs of that language.
  const shown = useRead(() => designsIn(lang), [lang]);
  const managed = designs.managed.has(id);
  const group = designs.groups.find((g) => designs.designsOf(g).includes(id));
  const slide = shown.value?.designIn(id, lang)
    ? previewOf(shown.value, id, lang).slide
    : undefined;
  const subject = designs.subjects[id];
  const backdrop = designs.previewBackdrop(id);
  const languages = designs.designLanguages(id);

  return (
    <ItemOverlay
      title={
        <>
          {nameOf(designs, id, 'he')} <span className="muted">·</span>{' '}
          <span className="muted" dir="ltr">
            {nameOf(designs, id, 'en')}
          </span>
        </>
      }
      subtitle={
        <>
          <span dir="ltr">{id}</span> ·{' '}
          {group ? groupNameOf(designs, group, lang) : t('libraryBrowse.designNoGroup')} ·{' '}
          {managed ? t('libraryBrowse.designPublished') : t('libraryBrowse.designHandWritten')}
        </>
      }
      actions={<LanguagePicker langs={languages} lang={lang} onChange={setLang} />}
      onClose={onClose}
      onStep={onStep}
      side={
        <>
          {variant && (
            <section className="approve-box">
              <p className="small">{t('libraryBrowse.designFromStudio')}</p>
              <button type="button" onClick={() => onOpenVariant(variant)}>
                {t('libraryBrowse.designOpenVariant')}
              </button>
            </section>
          )}
          <section>
            <h3>{t('libraryBrowse.details')}</h3>
            <dl className="facts">
              <dt>{t('libraryBrowse.id')}</dt>
              <dd dir="ltr">{id}</dd>
              <dt>{t('libraryBrowse.group')}</dt>
              <dd>
                {group ? `${groupNameOf(designs, group, lang)} · ` : ''}
                <span dir="ltr">{group ?? '—'}</span>
              </dd>
              <dt>{t('libraryBrowse.designSource')}</dt>
              <dd dir="ltr">elements/designs/{managed ? 'managed.json' : 'index.json'}</dd>
              <dt>{t('libraryBrowse.languages')}</dt>
              <dd>
                <LanguageNames langs={languages} />
              </dd>
              <dt>{t('libraryBrowse.designElements')}</dt>
              <dd>{slide?.elements.length ?? '…'}</dd>
              <dt>{t('libraryBrowse.designSubjectPoint')}</dt>
              <dd dir="ltr">{subject ? `${subject[0]}, ${subject[1]}` : '—'}</dd>
              <TagFacts tags={tags[id]} />
            </dl>
          </section>
          <section>
            <h3>{t('libraryBrowse.designPictures')}</h3>
            <Picture asset={designs.previewAsset(id)} label="subject" />
            {backdrop && <Picture asset={backdrop} label="backdrop" />}
          </section>
        </>
      }
    >
      {shown.value?.designIn(id, lang) ? (
        <DesignView designs={shown.value} id={id} lang={lang} />
      ) : (
        <div className="slide-frame">
          <div className="slide-empty" />
        </div>
      )}
      <h3>{t('libraryBrowse.designGalleryView', { size: THUMB })}</h3>
      <div className="thumbs">
        {languages.map((side) => (
          <figure key={side}>
            <DesignIn id={id} lang={side} thumb={thumb} width={THUMB} />
            <figcaption lang={side} dir="auto">
              {nativeName(side)}
            </figcaption>
          </figure>
        ))}
      </div>
    </ItemOverlay>
  );
}

/**
 * The ready-made slides of Elements, as the app lists them: the authored catalog, and after it
 * the designs the studio published, group by group. Each is shown as the picture made of it ahead
 * (ADR-109), or drawn live by the app's renderer where it has none.
 */
export function Designs({
  route,
  go,
  query,
  lang,
  variants,
  onOpenVariant,
}: {
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
  lang: Lang;
  variants: Record<string, Variant>;
  onOpenVariant: (variant: Variant) => void;
}) {
  const t = useT();
  const read = useRead(() => load(lang), [lang]);
  // Every design is written in English: what another language has is told as a share of those.
  const english = useRead(
    () => (isBase(lang) ? Promise.resolve(undefined) : designsIn('en')),
    [lang],
  );
  const [source, setSource] = useState<Source>('all');
  const [designs, thumb, search, tags] = read.value ?? [];

  /** The studio's variant each published design came from, by design id. */
  const studioOf = useMemo(() => {
    const found = new Map<string, Variant>();
    for (const variant of Object.values(variants)) {
      if (variant.published && variant.designId) found.set(variant.designId, variant);
    }
    return found;
  }, [variants]);

  const groups = useMemo(() => {
    if (!designs || !search || !tags) return [];
    return designs.groups
      .filter((group) => !route.group || group === route.group)
      .map((group) => ({
        group,
        ids: designs.designsIn(group, lang).filter((id) => {
          const managed = designs.managed.has(id);
          if (source === 'managed' && !managed) return false;
          if (source === 'authored' && managed) return false;
          // As the app's Ready slides search (`DesignsCollection`), and by any name as typed.
          return (
            finds(
              search,
              query,
              { he: nameOf(designs, id, 'he'), en: nameOf(designs, id, 'en') },
              { he: [groupNameOf(designs, group, 'he')], en: [groupNameOf(designs, group, 'en')] },
              tags[id],
            ) ||
            matches(
              query,
              id,
              nameOf(designs, id, 'he'),
              nameOf(designs, id, 'en'),
              nameOf(designs, id, lang),
              groupNameOf(designs, group, 'he'),
            )
          );
        }),
      }));
  }, [designs, search, tags, route.group, source, lang, query]);
  const listed = useMemo(() => groups.flatMap(({ ids }) => ids), [groups]);

  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!designs || !thumb || !tags) {
    return <p className="muted">{t('libraryBrowse.designsLoading')}</p>;
  }

  // The designs of a language are only those written in it: none is shown in English instead.
  const written = designs.ids;
  const managedCount = written.filter((id) => designs.managed.has(id)).length;
  const open = (id: string) => go({ ...route, item: id });

  return (
    <>
      {!isBase(lang) && english.value && (
        <p className="muted small">
          {t('libraryBrowse.designsWrittenIn', {
            shown: written.length,
            total: english.value.ids.length,
          })}
          <bdi lang={lang}>{nativeName(lang)}</bdi>.
        </p>
      )}
      <div className="lib-filters">
        <div className="segmented" role="group" aria-label={t('libraryBrowse.designSource')}>
          {(
            [
              ['all', t('libraryBrowse.designFilterAll', { count: written.length })],
              [
                'authored',
                t('libraryBrowse.designFilterAuthored', { count: written.length - managedCount }),
              ],
              ['managed', t('libraryBrowse.designFilterManaged', { count: managedCount })],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={source === value}
              onClick={() => setSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="chips" role="group" aria-label={t('libraryBrowse.group')}>
          <button
            type="button"
            className="chip"
            aria-pressed={!route.group}
            onClick={() => go({ section: 'designs' })}
          >
            {t('libraryBrowse.designAllGroups')}
          </button>
          {designs.groups.map((group) => {
            const count = designs.designsIn(group, lang).length;
            if (count === 0 && route.group !== group) return null;
            return (
              <button
                type="button"
                key={group}
                className="chip"
                aria-pressed={route.group === group}
                onClick={() => go({ section: 'designs', group })}
              >
                {groupNameOf(designs, group, lang)} <span className="muted">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {listed.length === 0 && <p className="muted">{t('libraryBrowse.designsNone')}</p>}
      {groups
        .filter(({ ids }) => ids.length > 0)
        .map(({ group, ids }) => (
          <section key={group} className="lib-group">
            <h3>
              {groupNameOf(designs, group, lang)}{' '}
              <span className="muted small" dir="ltr">
                {group} · {ids.length}
              </span>
            </h3>
            <div className="lib-grid">
              {/* A design is shown as its picture alone; its name is in its tooltip and its details. */}
              {ids.map((id) => {
                const made = thumb(id, lang, designs.designWord(id, lang));
                return (
                  <button
                    type="button"
                    key={id}
                    className="lib-card picture"
                    onClick={() => open(id)}
                    title={nameOf(designs, id, lang)}
                    aria-label={t('libraryBrowse.designOpen', { name: nameOf(designs, id, 'he') })}
                  >
                    {made ? (
                      <DesignPicture made={made} lang={lang} />
                    ) : (
                      <DesignView designs={designs} id={id} lang={lang} lazy />
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}

      {route.item && designs.designIn(route.item, lang) && (
        <DesignDetail
          key={route.item}
          designs={designs}
          thumb={thumb}
          id={route.item}
          lang={lang}
          tags={tags}
          variant={studioOf.get(route.item)}
          onOpenVariant={onOpenVariant}
          onClose={() => go({ ...route, item: undefined })}
          onStep={stepper(listed, route.item, open)}
        />
      )}
    </>
  );
}
