import { BASE_LANGUAGES, createDeck, type AssetMeta } from '@slidr/model';
import { pictures } from '@slidr/templates/builtin/pictures';
import { useMemo, useState } from 'react';
import { useT } from './i18n';
import { LanguagePicker, nativeName, type Lang } from './languages';
import { useWidth } from './width';
import { framesModule, frameThumbsModule, messages, named } from './app';
import { ElementPicture, WhenSeen } from './Lazy';
import { manifest, mediaUrl, size } from './media';
import { ItemOverlay, stepper } from './Overlay';
import { TagFacts, tagsOf, useRead, type LibraryRoute } from './shared';

type FramesMod = Awaited<ReturnType<typeof framesModule>>;
type ThumbsMod = Awaited<ReturnType<typeof frameThumbsModule>>;
type PhotoFrame = Awaited<ReturnType<FramesMod['loadFrames']>>[number];

const load = async () => {
  const [frames, thumbs, tags] = await Promise.all([
    framesModule(),
    frameThumbsModule(),
    tagsOf('frames'),
  ]);
  return { frames, thumbs, tags, all: await frames.loadFrames() };
};

/** The theme a frame is drawn in here: a new deck's, as no deck is open. */
const THEME = createDeck().theme;

/**
 * The landscape the app's frame thumbnails wait for a photograph with (`FRAME_PHOTO_URL` of
 * `desktop/src/elements/tiles.tsx`), which the pictures made ahead show too.
 */
const LANDSCAPE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" preserveAspectRatio="xMidYMid slice">' +
    '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#e0f2fe"/></linearGradient></defs>' +
    '<rect width="120" height="120" fill="url(#sky)"/><circle cx="84" cy="36" r="12" fill="#fde047"/>' +
    '<path d="M0 120V78l30-30 34 38 14-12 42 34v12Z" fill="#86efac"/>' +
    '<path d="M0 120v-18l44-30 40 26 36-14v36Z" fill="#22c55e"/></svg>',
)}`;

/** A photograph of the library, to see a frame with a real picture in it. */
const PHOTO = pictures.ananTeam2;

const TILE = { w: 176, h: 144 };

const groupName = (group: string, lang: Lang) =>
  named(messages.elements, lang, 'frames', 'group', group) ?? group;
const setName = (set: string, lang: Lang) =>
  named(messages.elements, lang, 'frames', 'set', set) ?? set;
const plainId = (frame: PhotoFrame) => frame.id.replace(/^frame:/, '');

/** A frame as the renderer draws it on a slide, around the landscape or a photograph. */
function DrawnFrame({
  mod,
  frame,
  lang,
  width,
  photo = false,
}: {
  mod: FramesMod;
  frame: PhotoFrame;
  lang: Lang;
  width: number;
  photo?: boolean;
}) {
  const drawn = useMemo(() => {
    const { deck, slide } = mod.framePreview(frame, lang, THEME);
    const id = mod.SAMPLE_PHOTO.id;
    if (photo && PHOTO) {
      deck.assets[id] = {
        ...mod.SAMPLE_PHOTO,
        mime: 'image/webp',
        width: PHOTO.width,
        height: PHOTO.height,
      };
    }
    const url = photo && PHOTO ? mediaUrl(`images/templates/${PHOTO.name}`) : LANDSCAPE;
    const resolve = (asset: AssetMeta) => (asset.id === id ? url : undefined);
    return { deck, slide, resolve };
  }, [mod, frame, lang, photo]);
  return (
    <ElementPicture
      deck={drawn.deck}
      slide={drawn.slide}
      size={frame.size}
      width={width}
      resolveAsset={drawn.resolve}
      bleed={12}
    />
  );
}

/** A frame in a tile, as the Elements panel shows it (`FrameThumb`). */
function FrameTile({
  mod,
  thumbs,
  frame,
  lang,
}: {
  mod: FramesMod;
  thumbs: ThumbsMod;
  frame: PhotoFrame;
  lang: Lang;
}) {
  const picture = thumbs.frameThumb(frame, lang);
  const fit = Math.floor(Math.min(TILE.w - 24, ((TILE.h - 24) * frame.size.w) / frame.size.h));
  if (picture) {
    // The frame is as large as the renderer would draw it; its shadow's room reaches past it.
    const spread = picture.spread;
    return (
      <span className="frame-tile">
        <img
          src={picture.url}
          alt=""
          style={{ width: fit * spread, maxWidth: 'none' }}
          loading="lazy"
        />
      </span>
    );
  }
  return (
    <span className="frame-tile">
      <WhenSeen ratio={`${TILE.w} / ${TILE.h}`}>
        <span className="frame-tile-inner">
          <DrawnFrame mod={mod} frame={frame} lang={lang} width={fit} />
        </span>
      </WhenSeen>
    </span>
  );
}

function FrameDetail({
  mod,
  thumbs,
  frame,
  tags,
  lang: initial,
  onClose,
  onStep,
}: {
  mod: FramesMod;
  thumbs: ThumbsMod;
  frame: PhotoFrame;
  /** What the library's tags (`tags/frames.json`) say of it, beside the catalogue's own words. */
  tags: Awaited<ReturnType<typeof tagsOf>>[string] | undefined;
  lang: Lang;
  onClose: () => void;
  onStep?: (by: -1 | 1) => void;
}) {
  const t = useT();
  const [lang, setLang] = useState<Lang>(initial);
  const [photo, setPhoto] = useState(true);
  const [ref, width] = useWidth<HTMLDivElement>();
  const files = useRead(manifest, []);
  const id = plainId(frame);
  const ahead = mod.picturedAhead(frame);
  const drawWidth = Math.min(
    Math.max(0, width - 24),
    Math.round((560 * frame.size.w) / frame.size.h),
    900,
  );
  const extras = frame.extras ?? [];
  const words = extras.filter((extra) => extra.kind !== 'sticker').length;

  return (
    <ItemOverlay
      title={
        <>
          {frame.label.he} <span className="muted">·</span>{' '}
          <span className="muted" dir="ltr">
            {frame.label.en}
          </span>
        </>
      }
      subtitle={
        <>
          <span dir="ltr">{frame.id}</span> · {groupName(frame.group, lang)}
          {frame.set && ` · ${setName(frame.set, lang)}`}
        </>
      }
      actions={
        <>
          <div
            className="segmented"
            role="group"
            aria-label={t('libraryCatalogs.frames.pictureInFrame')}
          >
            <button type="button" aria-pressed={photo} onClick={() => setPhoto(true)}>
              {t('libraryCatalogs.frames.photo')}
            </button>
            <button type="button" aria-pressed={!photo} onClick={() => setPhoto(false)}>
              {t('libraryCatalogs.frames.sampleLandscape')}
            </button>
          </div>
          {/* Only the words beside a picture have a language: a frame without them is the same in all. */}
          {words > 0 && <LanguagePicker langs={BASE_LANGUAGES} lang={lang} onChange={setLang} />}
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
              <dd dir="ltr">{frame.id}</dd>
              <dt>{t('libraryCatalogs.group')}</dt>
              <dd>
                {groupName(frame.group, lang)} · <span dir="ltr">{frame.group}</span>
              </dd>
              {frame.set && (
                <>
                  <dt>{t('libraryCatalogs.frames.magnetSet')}</dt>
                  <dd>
                    {setName(frame.set, lang)} · <span dir="ltr">{frame.set}</span>
                  </dd>
                </>
              )}
              <dt>{t('libraryCatalogs.frames.sizeOnSlide')}</dt>
              <dd dir="ltr">
                {frame.size.w}×{frame.size.h}
              </dd>
              <dt>{t('libraryCatalogs.frames.crop')}</dt>
              <dd dir="ltr">{frame.mask?.kind ?? 'none'}</dd>
              <dt>{t('libraryCatalogs.frames.art')}</dt>
              <dd>
                {t(frame.art ? 'libraryCatalogs.frames.has' : 'libraryCatalogs.frames.hasNot')}
              </dd>
              <dt>{t('libraryCatalogs.frames.besidePicture')}</dt>
              <dd>
                {t('libraryCatalogs.frames.extras', { stickers: extras.length - words, words })}
              </dd>
              <dt>{t('libraryCatalogs.frames.shadow')}</dt>
              <dd>
                {t(frame.shadow ? 'libraryCatalogs.frames.has' : 'libraryCatalogs.frames.hasNot')}
              </dd>
              <dt>{t('libraryCatalogs.frames.followsTheme')}</dt>
              <dd>
                {t(
                  mod.followsTheme(frame)
                    ? 'libraryCatalogs.frames.followsThemeYes'
                    : 'libraryCatalogs.frames.followsThemeNo',
                )}
              </dd>
              {frame.featured !== undefined && (
                <>
                  <dt>{t('libraryCatalogs.frames.featured')}</dt>
                  <dd>
                    {t('libraryCatalogs.frames.featuredPlace', { place: frame.featured + 1 })}
                  </dd>
                </>
              )}
              <dt>rev</dt>
              <dd dir="ltr">{mod.frameRev(frame)}</dd>
              <TagFacts tags={tags} />
            </dl>
          </section>
          {ahead && (
            <section>
              <h3>{t('libraryCatalogs.frames.readyPictures')}</h3>
              {(['he', 'en'] as const).map((side) => {
                const path = `images/frames/${side}/${id}.webp`;
                const current = thumbs.frameThumb(frame, side);
                const file = files.value?.files[path];
                return (
                  <figure key={side} className="picture-fact">
                    {file ? (
                      <a href={mediaUrl(path)} target="_blank" rel="noreferrer" className="checker">
                        <img src={mediaUrl(path)} alt={path} loading="lazy" />
                      </a>
                    ) : null}
                    <figcaption dir="ltr">
                      {path}
                      <span className={current ? 'ok' : 'warn'}>
                        {current
                          ? `current · ${size(file?.size ?? 0)}`
                          : file
                            ? 'stale: drawn live in the app, and frames.test.ts fails'
                            : 'missing: drawn live in the app'}
                      </span>
                    </figcaption>
                  </figure>
                );
              })}
            </section>
          )}
        </>
      }
    >
      <div ref={ref} className="frame-stage checker">
        {drawWidth > 0 && (
          <DrawnFrame mod={mod} frame={frame} lang={lang} width={drawWidth} photo={photo} />
        )}
      </div>
      <p className="muted small">
        {t('libraryCatalogs.frames.caption')}
        {t(
          photo
            ? 'libraryCatalogs.frames.captionWithPhoto'
            : 'libraryCatalogs.frames.captionWithLandscape',
        )}
        .
      </p>
    </ItemOverlay>
  );
}

/** The photo frames and event magnets, group by group, as the Elements panel offers them. */
export function Frames({
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
  // The frames Elements offers in the language (`frameIn`): every frame without words, the
  // letters of its alphabet, and the magnets only in Hebrew and English, which they are written in.
  const all = useMemo(
    () => read.value && read.value.frames.framesIn(read.value.all, lang),
    [read.value, lang],
  );
  const found = useMemo(() => {
    if (!read.value || !all) return [];
    const inGroup = all.filter((frame) => !route.group || frame.group === route.group);
    if (!query.trim()) return inGroup;
    const ids = new Set(inGroup.map((frame) => frame.id));
    return read.value.frames
      .searchFrames(all, query, all.length)
      .filter((frame) => ids.has(frame.id));
  }, [read.value, all, route.group, query]);

  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!read.value || !all) return <p className="muted">{t('libraryCatalogs.frames.loading')}</p>;
  if (all.length === 0) {
    return (
      <p className="muted">
        {t('libraryCatalogs.frames.noneIn')}
        <bdi lang={lang}>{nativeName(lang)}</bdi>.
      </p>
    );
  }
  const { frames: mod, thumbs, tags } = read.value;
  const groups = mod.FRAME_GROUPS.filter((group) => all.some((frame) => frame.group === group));
  const ids = found.map((frame) => frame.id);
  const open = (id: string) => go({ ...route, item: id });
  const opened = all.find((frame) => frame.id === route.item);
  const searching = query.trim().length > 0;

  return (
    <>
      <div className="lib-filters">
        <div className="chips" role="group" aria-label={t('libraryCatalogs.group')}>
          <button
            type="button"
            className="chip"
            aria-pressed={!route.group}
            onClick={() => go({ section: 'frames' })}
          >
            {t('libraryCatalogs.all')} <span className="muted">{all.length}</span>
          </button>
          {groups.map((group) => (
            <button
              type="button"
              key={group}
              className="chip"
              aria-pressed={route.group === group}
              onClick={() => go({ section: 'frames', group })}
            >
              {groupName(group, lang)}{' '}
              <span className="muted">{all.filter((frame) => frame.group === group).length}</span>
            </button>
          ))}
        </div>
      </div>
      {found.length === 0 && <p className="muted">{t('libraryCatalogs.frames.noMatch')}</p>}
      {(searching ? [undefined] : groups.filter((g) => !route.group || g === route.group)).map(
        (group) => {
          const list = group ? found.filter((frame) => frame.group === group) : found;
          if (list.length === 0) return null;
          return (
            <section key={group ?? 'found'} className="lib-group">
              {group && (
                <h3>
                  {groupName(group, lang)}{' '}
                  <span className="muted small" dir="ltr">
                    {group} · {list.length}
                  </span>
                </h3>
              )}
              <div className="tile-grid frames">
                {list.map((frame) => (
                  <button
                    type="button"
                    key={frame.id}
                    className="tile"
                    onClick={() => open(frame.id)}
                    title={`${frame.label.he} · ${frame.label.en}`}
                  >
                    <FrameTile mod={mod} thumbs={thumbs} frame={frame} lang={lang} />
                    <span className="tile-label" dir="auto">
                      {frame.label[lang === 'he' ? 'he' : 'en']}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        },
      )}
      {opened && (
        <FrameDetail
          key={opened.id}
          mod={mod}
          thumbs={thumbs}
          frame={opened}
          tags={tags[plainId(opened)]}
          lang={lang}
          onClose={() => go({ ...route, item: undefined })}
          onStep={stepper(ids, opened.id, open)}
        />
      )}
    </>
  );
}
