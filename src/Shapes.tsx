import { createDeck, createSlide, languageDir, type Element } from '@slidr/model';
import { extraShapes } from '@slidr/renderer';
import { useMemo } from 'react';
import type { Lang } from './languages';
import { iconSearchModule, messages, named, shapesModule } from './app';
import { useT } from './i18n';
import { DeckSlide } from './Lazy';
import { mediaUrl } from './media';
import { ItemOverlay, stepper } from './Overlay';
import { finds, matches, TagFacts, tagsOf, useRead, type LibraryRoute } from './shared';

type ShapesMod = Awaited<ReturnType<typeof shapesModule>>;

const SLIDE = { w: 1920, h: 1080 };
const LINE = 'line:';

/** The app's name of a preset, else the renderer's for one of its additional shapes, else the preset. */
const shapeName = (preset: string, lang: Lang) =>
  named(messages.objects, lang, 'shape', preset) ??
  extraShapes[preset]?.[lang === 'he' ? 'he' : 'en'] ??
  preset;
const lineName = (kind: string, lang: Lang) => named(messages.objects, lang, 'line', kind) ?? kind;
const groupName = (group: string, lang: Lang) =>
  named(messages.objects, lang, 'library', group) ?? group;
/** The key the library's tags give a shape or a line (`tags/shapes.json`). */
const tagKey = (item: string) => (item.startsWith(LINE) ? item : `shape:${item}`);
/** The shapes, the app's search, and the tags it finds them by (ADR-108). */
const load = () => Promise.all([shapesModule(), iconSearchModule(), tagsOf('shapes')]);

/** A shape of the library in neutral black, as the app's library draws it (`ShapeArt`). */
function ShapeGlyph({ mod, preset }: { mod: ShapesMod; preset: string }) {
  const glyph = useMemo(() => mod.shapeGlyph(preset), [mod, preset]);
  if (!glyph) return null;
  return (
    <svg aria-hidden viewBox={`0 0 ${mod.GLYPH_BOX} ${mod.GLYPH_BOX}`} className="glyph">
      <path
        d={glyph.d}
        transform={`translate(${glyph.x} ${glyph.y})`}
        fill={glyph.closed ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={glyph.closed ? 0 : 1.7}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A line of the Insert menu, running left to right (`LineArt`). */
function LineGlyph({ mod, kind }: { mod: ShapesMod; kind: string }) {
  return (
    <svg aria-hidden viewBox={`0 0 ${mod.GLYPH_BOX} ${mod.GLYPH_BOX}`} className="glyph">
      <path
        d={mod.LINE_GLYPHS[kind as keyof ShapesMod['LINE_GLYPHS']]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The shape or line as it goes onto a slide of a new deck: in the middle, in the theme's colours. */
function OnSlide({ mod, item, lang }: { mod: ShapesMod; item: string; lang: Lang }) {
  const drawn = useMemo(() => {
    const dir = languageDir(lang);
    const element: Element = item.startsWith(LINE)
      ? mod.newLine(item.slice(LINE.length) as Parameters<ShapesMod['newLine']>[0], SLIDE, [], dir)
      : mod.newShape(item, SLIDE);
    const slide = createSlide({ elements: [element] });
    return { deck: createDeck({ lang, dir, slides: [slide] }), slide, element };
  }, [mod, item, lang]);
  return (
    <>
      <DeckSlide deck={drawn.deck} slide={drawn.slide} />
      <p className="muted small" dir="ltr">
        {drawn.element.frame.w}×{drawn.element.frame.h} at {drawn.element.frame.x},
        {drawn.element.frame.y}
      </p>
    </>
  );
}

/** The shapes and lines of the app's library, by group. */
export function Shapes({
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
  const [mod, search, tags] = read.value ?? [];
  const groups = useMemo(() => {
    if (!mod || !search || !tags) return [];
    const linesName = (l: Lang) => named(messages.elements, l, 'lines') ?? 'lines';
    const shapes = mod.shapeLibrary().map(({ group, presets }) => ({
      group: String(group),
      name: groupName(group, lang),
      items: presets.filter(
        (preset) =>
          finds(
            search,
            query,
            { he: shapeName(preset, 'he'), en: shapeName(preset, 'en') },
            { he: [groupName(group, 'he')], en: [groupName(group, 'en')] },
            tags[tagKey(preset)],
          ) ||
          matches(
            query,
            preset,
            shapeName(preset, 'he'),
            shapeName(preset, 'en'),
            shapeName(preset, lang),
          ),
      ),
    }));
    const lines = {
      group: 'lines',
      name: named(messages.elements, 'he', 'lines') ?? t('libraryBrowse.shapesLines'),
      items: mod.LINE_KINDS.filter(
        (kind) =>
          finds(
            search,
            query,
            { he: lineName(kind, 'he'), en: lineName(kind, 'en') },
            { he: [linesName('he')], en: [linesName('en')] },
            tags[LINE + kind],
          ) ||
          matches(query, kind, lineName(kind, 'he'), lineName(kind, 'en'), lineName(kind, lang)),
      ).map((kind) => LINE + kind),
    };
    return [...shapes, lines];
  }, [mod, search, tags, query, lang, t]);
  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!mod || !tags) return <p className="muted">{t('libraryBrowse.shapesLoading')}</p>;
  const listed = groups.flatMap(({ items }) => items);
  const open = (item: string) => go({ section: 'shapes', item });
  const nameOf = (item: string, l: Lang) =>
    item.startsWith(LINE) ? lineName(item.slice(LINE.length), l) : shapeName(item, l);
  const opened = route.item && listed.includes(route.item) ? route.item : undefined;

  return (
    <>
      {groups
        .filter(({ items }) => items.length > 0)
        .map(({ group, name, items }) => (
          <section key={group} className="lib-group">
            <h3>
              {name}{' '}
              <span className="muted small" dir="ltr">
                {group} · {items.length}
              </span>
            </h3>
            <div className="tile-grid icons">
              {items.map((item) => (
                <button
                  type="button"
                  key={item}
                  className="tile"
                  onClick={() => open(item)}
                  title={`${nameOf(item, 'he')} · ${nameOf(item, 'en')}`}
                >
                  <span className="tile-glyph">
                    {item.startsWith(LINE) ? (
                      <LineGlyph mod={mod} kind={item.slice(LINE.length)} />
                    ) : (
                      <ShapeGlyph mod={mod} preset={item} />
                    )}
                  </span>
                  <span className="tile-label">{nameOf(item, lang)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      {opened && (
        <ItemOverlay
          key={opened}
          title={
            <>
              {nameOf(opened, 'he')} <span className="muted">·</span>{' '}
              <span className="muted" dir="ltr">
                {nameOf(opened, 'en')}
              </span>
            </>
          }
          subtitle={<span dir="ltr">{opened}</span>}
          onClose={() => go({ section: 'shapes' })}
          onStep={stepper(listed, opened, open)}
          side={
            <section>
              <h3>{t('libraryBrowse.shapesInLibrary')}</h3>
              <span className="tile-glyph big">
                {opened.startsWith(LINE) ? (
                  <LineGlyph mod={mod} kind={opened.slice(LINE.length)} />
                ) : (
                  <ShapeGlyph mod={mod} preset={opened} />
                )}
              </span>
              <p className="muted small">
                {opened.startsWith(LINE)
                  ? t('libraryBrowse.shapesLineNote')
                  : mod.isOpenPreset(opened)
                    ? t('libraryBrowse.shapesOpenNote')
                    : t('libraryBrowse.shapesClosedNote')}
              </p>
              <p className="small" dir="ltr">
                <a
                  href={mediaUrl('elements/catalogs/shapes.json')}
                  target="_blank"
                  rel="noreferrer"
                >
                  elements/catalogs/shapes.json
                </a>
              </p>
              <dl className="facts">
                <TagFacts tags={tags[tagKey(opened)]} />
              </dl>
            </section>
          }
        >
          <h3>{t('libraryBrowse.shapesOnSlideHeading')}</h3>
          <OnSlide mod={mod} item={opened} lang={lang} />
        </ItemOverlay>
      )}
    </>
  );
}

const PEEK = ['roundRect', 'ellipse', 'triangle', 'star5', 'arrowRight', 'wedgeRoundRectCallout'];

/** A few shapes of the library, as its glyphs draw them: for the overview. */
export function ShapesPeek() {
  const read = useRead(shapesModule, []);
  if (!read.value) return <span className="peek" />;
  const mod = read.value;
  return (
    <span className="peek">
      {PEEK.map((preset) => (
        <span key={preset} className="peek-art">
          <ShapeGlyph mod={mod} preset={preset} />
        </span>
      ))}
    </span>
  );
}
