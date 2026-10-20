import { BASE_LANGUAGES, createDeck, languageDir, type GroupElement } from '@slidr/model';
import { useMemo, useState } from 'react';
import { useT } from './i18n';
import { isBase, LanguagePicker, nativeName, type Lang } from './languages';
import { useWidth } from './width';
import { cardSetsModule, iconSearchModule, messages, named } from './app';
import { ElementPicture } from './Lazy';
import { mediaUrl } from './media';
import { ItemOverlay, stepper } from './Overlay';
import { finds, matches, TagFacts, tagsOf, useRead, type LibraryRoute } from './shared';

type CardSets = Awaited<ReturnType<typeof cardSetsModule>>;
type CardSetId = CardSets['CARD_SETS'][number];
type Tags = Awaited<ReturnType<typeof tagsOf>>;

/** The card sets, the app's search, and the tags it finds them by (ADR-108). */
const load = () => Promise.all([cardSetsModule(), iconSearchModule(), tagsOf('cards')]);

/** The room around a drawn set, in slide pixels: its shadow falls there (`CardSetsCollection`). */
const PAD = 44;
/** The theme a set is drawn in here: a new deck's, as no deck is open. */
const THEME = createDeck().theme;

/** A new deck in a language: its cards in Hebrew or in English, laid out in its direction. */
const metaOf = (lang: Lang) => ({ lang, dir: languageDir(lang) });
const nameOf = (id: string, lang: Lang) =>
  named(messages.elements, lang, 'cards', 'name', id) ?? id;

function CardPicture({
  cards,
  element,
  lang,
  width: fixed,
}: {
  cards: CardSets;
  element: GroupElement;
  lang: Lang;
  width?: number;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const width = fixed ?? measured;
  const { deck, slide, size } = useMemo(
    () => cards.cardPicture(element, metaOf(lang), THEME, PAD),
    [cards, element, lang],
  );
  return (
    <div ref={ref} className="card-picture-box" style={fixed ? { width: fixed } : undefined}>
      {width > 0 && <ElementPicture deck={deck} slide={slide} size={size} width={width} />}
    </div>
  );
}

/** A set of `count` cards, the kinds in turn, as the toolbar would grow or shrink a new one. */
function setOf(cards: CardSets, id: CardSetId, count: number, lang: Lang): GroupElement {
  const reading = cards.readingOf(metaOf(lang));
  let set = cards.newCardSet(id, reading);
  for (let guard = 0; guard < 12 && cards.cardsOf(set).length > count; guard++) {
    const last = cards.cardsOf(set).at(-1)!;
    set = cards.withoutCard(set, last.id, reading) ?? set;
  }
  for (let guard = 0; guard < 12 && cards.cardsOf(set).length < count; guard++) {
    const kind = cards.cardsOf(set).length % cards.cardKinds(id);
    set = cards.withCard(set, kind, reading) ?? set;
  }
  return set;
}

function CardDetail({
  cards,
  id,
  lang: initial,
  tags,
  onClose,
  onStep,
}: {
  cards: CardSets;
  id: CardSetId;
  lang: Lang;
  tags: Tags;
  onClose: () => void;
  onStep?: (by: -1 | 1) => void;
}) {
  const t = useT();
  const [lang, setLang] = useState<Lang>(initial);
  const most = cards.mostCards(id);
  const kinds = cards.cardKinds(id);
  const reading = useMemo(() => cards.readingOf(metaOf(lang)), [cards, lang]);
  const whole = useMemo(() => cards.newCardSet(id, reading), [cards, id, reading]);
  const counts = useMemo(
    () =>
      Array.from({ length: most }, (_, i) => ({
        count: i + 1,
        set: setOf(cards, id, i + 1, lang),
      })),
    [cards, id, most, lang],
  );
  const samples = useMemo(
    () => Array.from({ length: kinds }, (_, kind) => cards.sampleCard(id, kind, reading)),
    [cards, id, kinds, reading],
  );

  return (
    <ItemOverlay
      title={
        <>
          {nameOf(id, 'he')} <span className="muted">·</span>{' '}
          <span className="muted" dir="ltr">
            {nameOf(id, 'en')}
          </span>
        </>
      }
      subtitle={
        <>
          <span dir="ltr">{id}</span> · {t('libraryBrowse.cardsSubtitle', { kinds, most })}
        </>
      }
      actions={<LanguagePicker langs={BASE_LANGUAGES} lang={lang} onChange={setLang} />}
      onClose={onClose}
      onStep={onStep}
      side={
        <section>
          <h3>{t('libraryBrowse.details')}</h3>
          <dl className="facts">
            <dt>{t('libraryBrowse.id')}</dt>
            <dd dir="ltr">{id}</dd>
            <dt>{t('libraryBrowse.cardsNewSet')}</dt>
            <dd>{t('libraryBrowse.cardsCount', { count: cards.cardsOf(whole).length })}</dd>
            <dt>{t('libraryBrowse.cardsKinds')}</dt>
            <dd>{kinds}</dd>
            <dt>{t('libraryBrowse.cardsMost')}</dt>
            <dd>{most}</dd>
            <TagFacts tags={tags[id]} />
            <dt>{t('libraryBrowse.file')}</dt>
            <dd dir="ltr">
              <a href={mediaUrl('elements/cards/catalog.json')} target="_blank" rel="noreferrer">
                elements/cards/catalog.json
              </a>
            </dd>
          </dl>
          <p className="muted small">{t('libraryBrowse.cardsThemeNote')}</p>
        </section>
      }
    >
      <h3>{t('libraryBrowse.cardsNewSetHeading')}</h3>
      <CardPicture cards={cards} element={whole} lang={lang} />
      <h3>{t('libraryBrowse.cardsKindsHeading')}</h3>
      <div className="thumbs">
        {samples.map((card, kind) => (
          <figure key={kind}>
            <CardPicture cards={cards} element={card} lang={lang} width={260} />
            <figcaption>{t('libraryBrowse.cardsKindN', { number: kind + 1 })}</figcaption>
          </figure>
        ))}
      </div>
      <h3>{t('libraryBrowse.cardsAnyCountHeading')}</h3>
      <div className="lib-grid">
        {counts.map(({ count, set }) => (
          <figure key={count} className="count-figure">
            <CardPicture cards={cards} element={set} lang={lang} />
            <figcaption>{t('libraryBrowse.cardsCount', { count })}</figcaption>
          </figure>
        ))}
      </div>
    </ItemOverlay>
  );
}

/** The card sets of Elements, each drawn as a new set goes onto a slide. */
export function Cards({
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
  const [cards, search, tags] = read.value ?? [];
  const shown = useMemo(
    () =>
      (cards?.CARD_SETS ?? []).filter(
        (id) =>
          (search &&
            finds(search, query, { he: nameOf(id, 'he'), en: nameOf(id, 'en') }, tags?.[id])) ||
          matches(query, id, nameOf(id, 'he'), nameOf(id, 'en'), nameOf(id, lang)),
      ),
    [cards, search, tags, query, lang],
  );
  const sets = useMemo(() => {
    if (!cards) return [];
    const reading = cards.readingOf(metaOf(lang));
    return shown.map((id) => ({ id, element: cards.newCardSet(id, reading) }));
  }, [cards, shown, lang]);
  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!cards || !tags) return <p className="muted">{t('libraryBrowse.cardsLoading')}</p>;
  if (cards.CARD_SETS.length === 0) return <p className="muted">{t('libraryBrowse.cardsEmpty')}</p>;
  // The card sets are written in Hebrew and English only, and are shown in no other language.
  if (!isBase(lang)) {
    return (
      <p className="muted">
        {t('libraryBrowse.cardsOnlyHeEn')}
        <bdi lang={lang}>{nativeName(lang)}</bdi>.
      </p>
    );
  }
  const open = (id: string) => go({ section: 'cards', item: id });
  const opened = cards.CARD_SETS.find((id) => id === route.item);

  return (
    <>
      <div className="lib-grid wide">
        {sets.map(({ id, element }) => (
          <button type="button" key={id} className="lib-card" onClick={() => open(id)}>
            <span className="card-stage">
              <CardPicture cards={cards} element={element} lang={lang} />
            </span>
            <span className="lib-card-body">
              <span className="lib-card-title" lang={lang} dir={languageDir(lang)}>
                {nameOf(id, lang)}
              </span>
              <span className="lib-card-meta small muted">
                <span dir="ltr">{id}</span> ·{' '}
                {t('libraryBrowse.cardsMeta', {
                  kinds: cards.cardKinds(id),
                  most: cards.mostCards(id),
                })}
              </span>
            </span>
          </button>
        ))}
      </div>
      {opened && (
        <CardDetail
          key={opened}
          cards={cards}
          id={opened}
          lang={lang}
          tags={tags}
          onClose={() => go({ section: 'cards' })}
          onStep={stepper(shown, opened, open)}
        />
      )}
    </>
  );
}

/** A set of the library as a new one goes onto a slide: for the overview. */
export function CardsPeek() {
  const read = useRead(cardSetsModule, []);
  const cards = read.value;
  const element = useMemo(() => {
    const id = cards?.CARD_SETS.includes('stats') ? 'stats' : cards?.CARD_SETS[0];
    return cards && id ? cards.newCardSet(id, cards.readingOf(metaOf('he'))) : undefined;
  }, [cards]);
  return (
    <span className="peek cards">
      {cards && element && <CardPicture cards={cards} element={element} lang="he" />}
    </span>
  );
}
