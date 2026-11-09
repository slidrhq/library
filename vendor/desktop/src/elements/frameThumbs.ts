import { mediaCatalog, mediaFiles, mediaUrl, readMediaJson } from '@slidr/media-library';
import type { ContentLanguage } from '@slidr/model';
import { frameLanguage, frameRev, picturedAhead, type PhotoFrame } from './frames';

/*
 * The small pictures of the event magnets. A magnet is a whole design: a card, stickers with
 * photographs in them, lines of words. Drawn by the renderer, the hundred of them were built
 * again each time the group was opened, behind a loading state of seconds. So each has a picture
 * that was made ahead, of the renderer's own drawing, in each language its words are written in,
 * and the panel shows that.
 *
 * The pictures are in the media library, `images/frames/<language>/<frame>.webp`, with an index
 * that says for each the word of what it was drawn from (`frameRev`). A frame that has no
 * picture, or whose drawing has changed since, is drawn by the renderer as before.
 */

interface ThumbsIndex {
  /** How large a picture is to its frame's box. */
  scale: number;
  /** The room around the frame's box in a picture, for its shadow, in pixels of the picture. */
  bleed: number;
  /** The word of the drawing each picture was made from, by the frame's id without `frame:`. */
  frames: Readonly<Record<string, string>>;
}

/**
 * The index of the pictures, and the library's files: read when the frames are first shown, or
 * while the app is idle. Until then, and in a media library that has no pictures yet, a frame has
 * none and is drawn, and nothing fails.
 */
export const frameThumbIndex = mediaCatalog<{
  index: ThumbsIndex | undefined;
  files: ReadonlySet<string>;
}>(
  async () => ({
    index: await readMediaJson<ThumbsIndex>('images/frames/index.json'),
    files: await mediaFiles(),
  }),
  { index: undefined, files: new Set() },
);

export interface FrameThumbPicture {
  url: string;
  /**
   * How much larger the picture is than its frame's box along the box's longer side: the room
   * of the shadow is around the box.
   */
  spread: number;
}

/** What was found for a frame before, by language: its picture, or null for none. */
let found = new WeakMap<PhotoFrame, Partial<Record<ContentLanguage, FrameThumbPicture | null>>>();
// Found again with the index that came.
frameThumbIndex.subscribe(() => {
  found = new WeakMap();
});

function find(frame: PhotoFrame, lang: ContentLanguage): FrameThumbPicture | null {
  const { index, files } = frameThumbIndex.get();
  if (!index || !picturedAhead(frame)) return null;
  const name = frame.id.replace(/^frame:/, '');
  const path = `images/frames/${lang}/${name}.webp`;
  if (!files.has(path) || index.frames[name] !== frameRev(frame)) return null;
  const longer = Math.max(frame.size.w, frame.size.h) * index.scale;
  return { url: mediaUrl(path), spread: (longer + 2 * index.bleed) / longer };
}

/**
 * The picture of a frame that was made ahead, with its words in the language they are said in to
 * an interface in `lang` (`frameLanguage`); undefined for a frame that has none, or one of a
 * drawing the frame no longer has.
 */
export function frameThumb(frame: PhotoFrame, lang: string): FrameThumbPicture | undefined {
  const language = frameLanguage(frame, lang);
  let known = found.get(frame);
  if (!known) found.set(frame, (known = {}));
  return (known[language] ??= find(frame, language)) ?? undefined;
}

/** The pictures that are on their way, held until they have come. */
const coming = new Set<HTMLImageElement>();
const fetched = new Set<string>();

/**
 * Has the pictures of some frames at hand before they are shown: which frame has one is worked
 * out, and its picture is fetched, a frame at a time while the browser is idle. The list of all
 * of them is then there the moment it is opened. Returns what stops it.
 */
export function prepareFrameThumbs(frames: readonly PhotoFrame[], lang: string): () => void {
  const idle = typeof requestIdleCallback === 'function';
  let at = 0;
  let waiting = 0;
  let stopped = false;
  const wait = () => {
    if (stopped) return;
    waiting = idle ? requestIdleCallback(step) : window.setTimeout(step, 30);
  };
  const step = () => {
    const frame = frames[at++];
    if (!frame) return;
    const url = frameThumb(frame, lang)?.url;
    if (url && !fetched.has(url)) {
      fetched.add(url);
      const image = new Image();
      const done = () => coming.delete(image);
      image.onload = done;
      image.onerror = done;
      coming.add(image);
      image.src = url;
    }
    wait();
  };
  // Which frame has a picture is known once the index has come.
  void frameThumbIndex.load().then(wait);
  return () => {
    stopped = true;
    if (idle) cancelIdleCallback(waiting);
    else clearTimeout(waiting);
  };
}
