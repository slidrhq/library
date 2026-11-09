import {
  CONTENT_LANGUAGES,
  createDeck,
  LANGUAGE_NAMES,
  languageDir,
  type Deck,
  type Slide,
} from '@slidr/model';
import { ScaledSlide, STILL_AT } from '@slidr/renderer';
import type { MotionBackground } from '@desktop/elements/motionBackgrounds';
import type { MotionPiece } from '@desktop/elements/motionPieces';
import type { MotionShape } from '@desktop/elements/motionShapes';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  iconSearchModule,
  messages,
  motionBackgroundsModule,
  motionModule,
  motionPiecesModule,
  named,
} from './app';
import { useT, type MessageKey } from './i18n';
import { LanguagePicker, type Lang } from './languages';
import { DeckSlide } from './Lazy';
import { mediaUrl } from './media';
import { ItemOverlay, stepper } from './Overlay';
import { finds, matches, TagFacts, tagsOf, useRead, type LibraryRoute } from './shared';
import { useWidth } from './width';

/*
 * The animations and the backgrounds of Elements: the library's catalogs of them,
 * `elements/animations/catalog.json` and `elements/backgrounds/catalog.json` (ADR-138 of the app),
 * as the app reads them and draws them. Each is drawn by the app's own code (`motion.ts`) on a
 * slide of a new deck in the language shown, as the tiles of the Elements panel draw it: still,
 * at the moment that shows what it is, and moving while the pointer is on it. Up close it moves,
 * in a deck that reads from the right and in one that reads from the left when its direction
 * matters.
 */

type Motion = Awaited<ReturnType<typeof motionModule>>;
type Search = Awaited<ReturnType<typeof iconSearchModule>>;
type Tags = Awaited<ReturnType<typeof tagsOf>>;

const BACKGROUNDS_FILE = 'elements/backgrounds/catalog.json';
const ANIMATIONS_FILE = 'elements/animations/catalog.json';

/** The backgrounds, the app's drawing of them, its search, and the tags it finds them by. */
const loadBackgrounds = () =>
  Promise.all([
    motionModule(),
    motionBackgroundsModule().then((module) => module.backgroundCatalog.load()),
    iconSearchModule(),
    tagsOf('backgrounds'),
  ]);

/** The animations and the animated shapes, and the same. */
const loadAnimations = () =>
  Promise.all([
    motionModule(),
    motionPiecesModule().then((module) => module.animationCatalog.load()),
    iconSearchModule(),
    tagsOf('animations'),
  ]);

/** A new deck in a language: its theme, and the direction it reads in. */
const deckIn = (lang: Lang): Deck => createDeck({ lang });

/** An item's name in a language: its own there, else its English one, as the app names it. */
const nameIn = (item: { name: Partial<Record<string, string>> }, lang: Lang) =>
  item.name[lang] ?? item.name.en ?? '';

/** A word of the app's own messages of Elements, in the language shown. */
const elementsWord = (lang: Lang, ...path: string[]) =>
  named(messages.elements, lang, ...path) ?? path.at(-1) ?? '';

/* ---------------------------------------------------------------- drawing */

/**
 * Plays what moves inside `box` while `playing`, and otherwise holds it at `STILL_AT`, as a tile
 * of the Elements panel does: the pictures in their shadow roots (their CSS animations and their
 * SMIL), and what the slide itself moves (an animated shape, a flowing line). Whoever asked the
 * system for less motion gets the still one only.
 */
function usePlaying(playing: boolean, drawn: unknown) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const play = playing && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const apply = () => {
      for (const animation of element.getAnimations({ subtree: true })) {
        if (play) animation.play();
        else {
          animation.pause();
          animation.currentTime = 0;
        }
      }
      for (const host of Array.from(element.querySelectorAll('[data-slidr-svg]'))) {
        const root = host.shadowRoot;
        if (!root) continue;
        for (const animation of root.getAnimations()) {
          if (play) animation.play();
          else {
            animation.pause();
            animation.currentTime = STILL_AT * 1000;
          }
        }
        const picture = root.querySelector('svg');
        if (!(picture instanceof SVGSVGElement)) continue;
        if (play) picture.unpauseAnimations();
        else {
          picture.pauseAnimations();
          picture.setCurrentTime(STILL_AT);
        }
      }
    };
    apply();
    // The renderer may still be putting the pictures in place in this frame.
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [playing, drawn]);
  return box;
}

/** A tile's slide, still until the pointer or the keyboard is on its card. */
function TileSlide({ deck, slide, playing }: { deck: Deck; slide: Slide; playing: boolean }) {
  const box = usePlaying(playing, slide);
  return (
    <div ref={box} aria-hidden>
      <DeckSlide deck={deck} slide={slide} lazy />
    </div>
  );
}

/** A slide as wide as its place, moving as it does on the stage. */
function MovingSlide({ deck, slide }: { deck: Deck; slide: Slide }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="slide-frame" aria-hidden>
      {width > 0 ? (
        <ScaledSlide deck={deck} slide={slide} width={width} mode="edit" />
      ) : (
        <div className="slide-empty" />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- the items */

/** An item of either catalog, as the page lists it: its key is the one its tags are filed under. */
interface Item {
  key: string;
  id: string;
  name: Partial<Record<string, string>>;
  /** Its slide in a deck. */
  slide: (motion: Motion, deck: Deck) => Slide;
  /** Whether its direction changes with the deck's. */
  turns: boolean;
  /** What it is, for the facts up close. */
  facts: (lang: Lang, t: (key: MessageKey) => string) => [string, ReactNode][];
}

function backgroundItem(background: MotionBackground): Item {
  return {
    key: background.id,
    id: background.id,
    name: background.name,
    slide: (motion, deck) => motion.backgroundSlide(background, deck, deck.theme.background),
    turns: background.sided,
    facts: (_lang, t) => [
      [
        t('libraryMotion.motion'),
        t(background.animated ? 'libraryMotion.moving' : 'libraryMotion.still'),
      ],
      [
        t('libraryMotion.direction'),
        t(background.sided ? 'libraryMotion.sided' : 'libraryMotion.whole'),
      ],
      [t('libraryMotion.size'), <span dir="ltr">1920 × 1080</span>],
    ],
  };
}

function pieceItem(piece: MotionPiece): Item {
  return {
    key: piece.id,
    id: piece.id,
    name: piece.name,
    slide: (motion, deck) => motion.pieceSlide(piece, deck),
    turns: piece.reads,
    facts: (lang, t) => [
      [
        t('libraryMotion.kind'),
        t(piece.kind === 'line' ? 'libraryMotion.kindLine' : 'libraryMotion.kindPicture'),
      ],
      [t('libraryMotion.group'), elementsWord(lang, 'animations', 'group', piece.group)],
      [t('libraryMotion.direction'), t(piece.reads ? 'libraryMotion.reads' : 'libraryMotion.same')],
      [t('libraryMotion.size'), <span dir="ltr">{`${piece.size.w} × ${piece.size.h}`}</span>],
    ],
  };
}

function shapeItem(shape: MotionShape): Item {
  return {
    key: `shape:${shape.id}`,
    id: shape.id,
    name: shape.name,
    slide: (motion, deck) => motion.shapeSlide(shape, deck),
    turns: Boolean(shape.reads),
    facts: (lang, t) => [
      [t('libraryMotion.kind'), t('libraryMotion.kindShape')],
      [
        t('libraryMotion.shape'),
        named(messages.objects, lang, 'shape', shape.preset) ?? (
          <span dir="ltr">{shape.preset}</span>
        ),
      ],
      [t('libraryMotion.motion'), elementsWord(lang, 'motion', 'kind', shape.ambient.kind)],
      [t('libraryMotion.direction'), t(shape.reads ? 'libraryMotion.reads' : 'libraryMotion.same')],
      [t('libraryMotion.size'), <span dir="ltr">{`${shape.side}`}</span>],
    ],
  };
}

/** A group of items under its name, as the panel groups them. */
interface Group {
  id: string;
  name: string;
  items: Item[];
}

/* ---------------------------------------------------------------- the page */

function MotionCard({
  item,
  motion,
  deck,
  lang,
  onOpen,
}: {
  item: Item;
  motion: Motion;
  deck: Deck;
  lang: Lang;
  onOpen: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const slide = useMemo(() => item.slide(motion, deck), [item, motion, deck]);
  return (
    <button
      type="button"
      className="lib-card"
      onClick={onOpen}
      onPointerEnter={() => setPlaying(true)}
      onPointerLeave={() => setPlaying(false)}
      onFocus={() => setPlaying(true)}
      onBlur={() => setPlaying(false)}
      title={`${nameIn(item, 'he')} · ${nameIn(item, 'en')}`}
    >
      <TileSlide deck={deck} slide={slide} playing={playing} />
      <span className="lib-card-body">
        <span className="lib-card-title" lang={lang} dir={languageDir(lang)}>
          {nameIn(item, lang)}
        </span>
        <span className="lib-card-meta small muted" dir="ltr">
          {item.id}
        </span>
      </span>
    </button>
  );
}

function MotionDetail({
  item,
  motion,
  file,
  lang: initial,
  tags,
  onClose,
  onStep,
}: {
  item: Item;
  motion: Motion;
  file: string;
  lang: Lang;
  tags: Tags;
  onClose: () => void;
  onStep?: (by: -1 | 1) => void;
}) {
  const t = useT();
  const [lang, setLang] = useState<Lang>(initial);
  // A deck in the language chosen; when the direction matters, one of each direction beside it.
  const decks = useMemo(() => {
    const own = deckIn(lang);
    if (!item.turns) return [{ deck: own, label: undefined }];
    const rtl = own.meta.dir === 'rtl' ? own : deckIn('he');
    const ltr = own.meta.dir === 'ltr' ? own : deckIn('en');
    return [
      { deck: rtl, label: t('libraryMotion.rtl') },
      { deck: ltr, label: t('libraryMotion.ltr') },
    ];
  }, [item, lang, t]);
  return (
    <ItemOverlay
      title={
        <>
          {nameIn(item, 'he')} <span className="muted">·</span>{' '}
          <span className="muted" dir="ltr">
            {nameIn(item, 'en')}
          </span>
        </>
      }
      subtitle={<span dir="ltr">{item.key}</span>}
      actions={<LanguagePicker lang={lang} onChange={setLang} />}
      onClose={onClose}
      onStep={onStep}
      side={
        <section>
          <dl className="facts">
            {item.facts(lang, t).map(([term, value]) => (
              <FactRow key={term} term={term} value={value} />
            ))}
            <TagFacts tags={tags[item.key]} />
            <dt>{t('libraryMotion.names')}</dt>
            <dd>
              {CONTENT_LANGUAGES.filter((one) => item.name[one]).map((one) => (
                <span key={one} className="block" lang={one} dir={languageDir(one)}>
                  <strong>{LANGUAGE_NAMES[one].native}: </strong>
                  {item.name[one]}
                </span>
              ))}
            </dd>
            <dt>{t('libraryBrowse.file')}</dt>
            <dd dir="ltr">
              <a href={mediaUrl(file)} target="_blank" rel="noreferrer">
                {file}
              </a>
            </dd>
          </dl>
          <p className="muted small">{t('libraryMotion.themeNote')}</p>
        </section>
      }
    >
      {decks.map(({ deck, label }) => (
        <figure key={deck.meta.dir} className="motion-figure">
          <MovingSlide deck={deck} slide={item.slide(motion, deck)} />
          {label && <figcaption>{label}</figcaption>}
        </figure>
      ))}
    </ItemOverlay>
  );
}

function FactRow({ term, value }: { term: string; value: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** The groups of a part, each with the items the query finds, as the page shows them. */
function MotionPart({
  part,
  groups,
  motion,
  search,
  tags,
  file,
  emptyKey,
  route,
  go,
  query,
  lang,
}: {
  part: 'animations' | 'backgrounds';
  groups: readonly Group[];
  motion: Motion;
  search: Search;
  tags: Tags;
  file: string;
  emptyKey: MessageKey;
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
  lang: Lang;
}) {
  const t = useT();
  const deck = useMemo(() => deckIn(lang), [lang]);
  const shown = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            finds(search, query, { he: item.name.he, en: item.name.en }, tags[item.key]) ||
            matches(query, item.key, item.name.he, item.name.en, item.name[lang]),
        ),
      })),
    [groups, search, tags, query, lang],
  );
  const all = groups.flatMap((group) => group.items);
  if (all.length === 0) return <p className="muted">{t(emptyKey)}</p>;
  const listed = shown.flatMap((group) => group.items.map((item) => item.key));
  const open = (key: string) => go({ section: part, item: key });
  const opened = all.find((item) => item.key === route.item);
  return (
    <>
      <p className="muted small">{t('libraryMotion.hint')}</p>
      {shown
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section key={group.id} className="lib-group">
            <h3>
              {group.name}{' '}
              <span className="muted small" dir="ltr">
                {group.id} · {group.items.length}
              </span>
            </h3>
            <div className="lib-grid">
              {group.items.map((item) => (
                <MotionCard
                  key={item.key}
                  item={item}
                  motion={motion}
                  deck={deck}
                  lang={lang}
                  onOpen={() => open(item.key)}
                />
              ))}
            </div>
          </section>
        ))}
      {opened && (
        <MotionDetail
          key={opened.key}
          item={opened}
          motion={motion}
          file={file}
          lang={lang}
          tags={tags}
          onClose={() => go({ section: part })}
          onStep={stepper(listed, opened.key, open)}
        />
      )}
    </>
  );
}

interface PartProps {
  route: LibraryRoute;
  go: (route: LibraryRoute) => void;
  query: string;
  lang: Lang;
}

/** The backgrounds of Elements: those that move, then the still ones, as the panel shows them. */
export function Backgrounds(props: PartProps) {
  const t = useT();
  const read = useRead(loadBackgrounds, []);
  const [motion, backgrounds, search, tags] = read.value ?? [];
  const groups = useMemo((): Group[] => {
    const items = (backgrounds ?? []).map((background) => ({
      background,
      item: backgroundItem(background),
    }));
    return [
      {
        id: 'animated',
        name: elementsWord(props.lang, 'backgrounds', 'animated'),
        items: items.filter(({ background }) => background.animated).map(({ item }) => item),
      },
      {
        id: 'still',
        name: elementsWord(props.lang, 'backgrounds', 'still'),
        items: items.filter(({ background }) => !background.animated).map(({ item }) => item),
      },
    ];
  }, [backgrounds, props.lang]);
  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!motion || !search || !tags) return <p className="muted">{t('libraryMotion.loading')}</p>;
  return (
    <MotionPart
      part="backgrounds"
      groups={groups}
      motion={motion}
      search={search}
      tags={tags}
      file={BACKGROUNDS_FILE}
      emptyKey="libraryMotion.backgroundsEmpty"
      {...props}
    />
  );
}

/** The animations of Elements: the animated shapes first, then each group, as the panel has them. */
export function Animations(props: PartProps) {
  const t = useT();
  const read = useRead(loadAnimations, []);
  const [motion, catalog, search, tags] = read.value ?? [];
  const { MOTION_GROUPS = [] } = useRead(motionPiecesModule, []).value ?? {};
  const groups = useMemo((): Group[] => {
    if (!catalog) return [];
    return [
      {
        id: 'basic',
        name: elementsWord(props.lang, 'animatedShapes', 'title'),
        items: catalog.shapes.map(shapeItem),
      },
      ...MOTION_GROUPS.map((group) => ({
        id: group,
        name: elementsWord(props.lang, 'animations', 'group', group),
        items: catalog.pieces.filter((piece) => piece.group === group).map(pieceItem),
      })),
    ];
  }, [catalog, MOTION_GROUPS, props.lang]);
  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!motion || !search || !tags) return <p className="muted">{t('libraryMotion.loading')}</p>;
  return (
    <MotionPart
      part="animations"
      groups={groups}
      motion={motion}
      search={search}
      tags={tags}
      file={ANIMATIONS_FILE}
      emptyKey="libraryMotion.animationsEmpty"
      {...props}
    />
  );
}

/* ---------------------------------------------------------------- an upload */

/** What an upload of `backgrounds: add` or `animations: add` holds, as the page reads it. */
interface MotionUpload {
  type: string;
  target: string;
  fields: Record<string, unknown>;
  languages: Partial<Record<string, unknown>>;
}

/**
 * The item an upload adds, read by the app's own reader of the catalogs (`backgroundsOf`,
 * `animationsOf`), as the app will read it once it is published: an upload the app could not draw
 * gives none.
 */
async function itemOfUpload(upload: MotionUpload): Promise<Item | undefined> {
  const name = Object.fromEntries(
    Object.entries(upload.languages).flatMap(([lang, content]) => {
      const one = (content as { name?: unknown } | undefined)?.name;
      return typeof one === 'string' ? [[lang, one]] : [];
    }),
  );
  const { kind, shape, ...fields } = upload.fields;
  const record = { id: upload.target, name, ...fields };
  if (upload.type === 'backgrounds') {
    const [background] = (await motionBackgroundsModule()).backgroundsOf({
      backgrounds: [record],
    });
    return background && backgroundItem(background);
  }
  const { animationsOf } = await motionPiecesModule();
  if (kind === 'shape') {
    const [one] = animationsOf({
      shapes: [{ id: upload.target, name, ...(shape as object | undefined) }],
    }).shapes;
    return one && shapeItem(one);
  }
  const [piece] = animationsOf({ animations: [record] }).pieces;
  return piece && pieceItem(piece);
}

/**
 * An upload of a background or an animation up close: the item it adds, moving, in the language
 * chosen, and in the other direction too when its direction matters.
 */
export function MotionUploadStage({ upload, lang }: { upload: MotionUpload; lang: Lang }) {
  const t = useT();
  const read = useRead(() => Promise.all([motionModule(), itemOfUpload(upload)]), [upload]);
  const [motion, item] = read.value ?? [];
  const decks = useMemo(() => {
    const own = deckIn(lang);
    if (!item?.turns) return [own];
    return [own, own.meta.dir === 'rtl' ? deckIn('en') : deckIn('he')];
  }, [item, lang]);
  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!read.value) return <p className="muted">{t('libraryMotion.loading')}</p>;
  if (!motion || !item) return <p className="muted">{t('libraryMotion.cannotDraw')}</p>;
  return (
    <>
      {decks.map((deck) => (
        <figure key={deck.meta.dir} className="motion-figure">
          <MovingSlide deck={deck} slide={item.slide(motion, deck)} />
          {item.turns && (
            <figcaption>
              {t(deck.meta.dir === 'rtl' ? 'libraryMotion.rtl' : 'libraryMotion.ltr')}
            </figcaption>
          )}
        </figure>
      ))}
      <dl className="facts">
        {item.facts(lang, t).map(([term, value]) => (
          <FactRow key={term} term={term} value={value} />
        ))}
      </dl>
    </>
  );
}

/* ---------------------------------------------------------------- the overview */

/** Two of a part's items, still, side by side: for the overview. */
function Peek({ slides }: { slides: { deck: Deck; slide: Slide }[] | undefined }) {
  return (
    <span className="peek motion-peek" aria-hidden>
      {slides?.map(({ deck, slide }) => (
        <span key={slide.id} className="motion-peek-slide">
          <DeckSlide deck={deck} slide={slide} />
        </span>
      ))}
    </span>
  );
}

export function BackgroundsPeek() {
  const read = useRead(loadBackgrounds, []);
  const [motion, backgrounds] = read.value ?? [];
  const slides = useMemo(() => {
    if (!motion || !backgrounds) return undefined;
    const deck = deckIn('he');
    return backgrounds
      .slice(0, 2)
      .map((background) => ({ deck, slide: backgroundItem(background).slide(motion, deck) }));
  }, [motion, backgrounds]);
  return <Peek slides={slides} />;
}

export function AnimationsPeek() {
  const read = useRead(loadAnimations, []);
  const [motion, catalog] = read.value ?? [];
  const slides = useMemo(() => {
    if (!motion || !catalog) return undefined;
    const deck = deckIn('he');
    return catalog.pieces
      .slice(0, 2)
      .map((piece) => ({ deck, slide: pieceItem(piece).slide(motion, deck) }));
  }, [motion, catalog]);
  return <Peek slides={slides} />;
}
