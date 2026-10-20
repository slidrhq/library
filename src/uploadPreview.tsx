/**
 * An upload as the app will show it, drawn by the app's renderer before it is in the library: a
 * design's slide with its own picture, a template's sample seated on the template's layouts.
 */
import {
  createDeck,
  languageDir,
  walkElements,
  type AssetMeta,
  type ContentLanguage,
  type Deck,
  type Slide,
} from '@slidr/model';
import type { Template } from '@slidr/templates';
import { Component, useMemo, type MouseEvent, type ReactNode } from 'react';
import { DeckSlide } from './Lazy';
import { slideProblem } from './uploadsApi';

/** Where a picture is drawn from, and its size, which a cropped picture needs. */
export interface PictureSource {
  url: string;
  width?: number;
  height?: number;
}

const SUBJECT = 'upload-subject';
const BACKDROP = 'upload-backdrop';
const SLIDE_WIDTH = 1920;
const SLIDE_HEIGHT = 1080;

function pictureMeta(id: string, picture: PictureSource | undefined): AssetMeta {
  return {
    id,
    file: `${id}.webp`,
    mime: 'image/webp',
    kind: 'image',
    origin: 'import',
    bytes: 0,
    ...(picture?.width && picture.height ? { width: picture.width, height: picture.height } : {}),
  };
}

/** A design's slide in a deck of its language, its pictures named as the deck holds them. */
function designDeck(
  slide: Slide,
  lang: ContentLanguage,
  picture?: PictureSource,
  backdrop?: PictureSource,
) {
  const drawn = structuredClone(slide);
  for (const element of walkElements(drawn.elements)) {
    if (element.type !== 'image') continue;
    if (element.assetId === '__subject__') element.assetId = SUBJECT;
    if (element.assetId === '__backdrop__') element.assetId = BACKDROP;
  }
  const deck = createDeck({ lang, slides: [drawn] });
  deck.assets[SUBJECT] = pictureMeta(SUBJECT, picture);
  deck.assets[BACKDROP] = pictureMeta(BACKDROP, backdrop);
  const resolve = (asset: AssetMeta) =>
    asset.id === SUBJECT ? picture?.url : asset.id === BACKDROP ? backdrop?.url : undefined;
  return { deck, slide: drawn, resolve };
}

/** What could not be drawn, in place of the drawing. */
class Drawn extends Component<{ children: ReactNode; failed: (error: string) => ReactNode }> {
  override state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override render() {
    return this.state.error ? this.props.failed(this.state.error) : this.props.children;
  }
}

export function Unshown({ children, drop }: { children: ReactNode; drop?: boolean }) {
  return <div className={drop ? 'upload-unshown drop' : 'upload-unshown small'}>{children}</div>;
}

/**
 * A design's slide, with its picture; the subject's point is marked on it, and a click on it
 * places the point when `onPick` is given. The point is of the slide as it is written left to
 * right, as the catalog keeps it (`subjects`), and mirrored on a slide that reads from the right.
 */
export function DesignPreview({
  slide,
  lang,
  picture,
  backdrop,
  width,
  subject,
  onPick,
  notSlide,
}: {
  slide: unknown;
  lang: ContentLanguage;
  picture?: PictureSource;
  backdrop?: PictureSource;
  width?: number;
  subject?: readonly [number, number];
  onPick?: (point: [number, number]) => void;
  /** What to say of content that is not a slide. */
  notSlide: (problem: string) => ReactNode;
}) {
  const problem = useMemo(() => slideProblem(slide), [slide]);
  const drawn = useMemo(
    () => (problem ? undefined : designDeck(slide as Slide, lang, picture, backdrop)),
    [problem, slide, lang, picture, backdrop],
  );
  if (!drawn) return <Unshown>{notSlide(problem ?? '')}</Unshown>;
  const mirror = (x: number) => (languageDir(lang) === 'rtl' ? SLIDE_WIDTH - x : x);
  const pick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onPick) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - box.left) / box.width) * SLIDE_WIDTH);
    const y = Math.round(((event.clientY - box.top) / box.height) * SLIDE_HEIGHT);
    onPick([mirror(Math.min(Math.max(x, 0), SLIDE_WIDTH)), Math.min(Math.max(y, 0), SLIDE_HEIGHT)]);
  };
  return (
    <Drawn key={`${lang}`} failed={(error) => <Unshown>{notSlide(error)}</Unshown>}>
      {/* The slide's own coordinates run from its left edge, in a page that reads from the right. */}
      <div
        className={onPick ? 'upload-slide picking' : 'upload-slide'}
        dir="ltr"
        onClick={onPick ? pick : undefined}
        style={width ? { width } : undefined}
      >
        <DeckSlide
          deck={drawn.deck}
          slide={drawn.slide}
          resolveAsset={drawn.resolve}
          width={width}
        />
        {subject && (
          <span
            className="subject-mark"
            aria-hidden
            style={{
              left: `${(mirror(subject[0]) / SLIDE_WIDTH) * 100}%`,
              top: `${(subject[1] / SLIDE_HEIGHT) * 100}%`,
            }}
          />
        )}
      </div>
    </Drawn>
  );
}

/** A template's sample in a language, seated on its layouts by the template's own engine. */
export async function sampleDeckOf(
  template: Template,
  sample: unknown[],
  lang: ContentLanguage,
): Promise<{ deck: Deck; resolve: (asset: AssetMeta) => string | undefined }> {
  const [{ sampleDeck }, { pictures }, { pictureUrl }] = await Promise.all([
    import('@slidr/templates/builtin/kit'),
    import('@slidr/templates/builtin/pictures'),
    import('@desktop/templates/samples'),
  ]);
  const assets = Object.fromEntries(Object.values(pictures).map((one) => [one.id, one]));
  const deck = sampleDeck(
    { ...template, assets: { ...assets, ...template.assets } },
    sample as never,
    {
      lang,
      dir: languageDir(lang),
    },
  );
  return { deck, resolve: pictureUrl };
}

/** The slides of a sample deck: the one chosen large, and all of them small to choose from. */
export function SampleSheet({
  deck,
  resolve,
  current,
  onCurrent,
}: {
  deck: Deck;
  resolve: (asset: AssetMeta) => string | undefined;
  current: number;
  onCurrent: (index: number) => void;
}) {
  const shown = deck.slides[Math.min(current, deck.slides.length - 1)];
  return (
    <>
      {shown && <DeckSlide deck={deck} slide={shown} resolveAsset={resolve} />}
      <div className="sample-sheet">
        {deck.slides.map((slide, index) => (
          <button
            type="button"
            key={slide.id}
            className={index === current ? 'sample-thumb current' : 'sample-thumb'}
            onClick={() => onCurrent(index)}
          >
            <DeckSlide deck={deck} slide={slide} resolveAsset={resolve} lazy />
            <span className="sample-thumb-label" dir="auto">
              {index + 1}. {slide.name}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
