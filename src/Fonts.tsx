import { familyOfLanguage, LANGUAGE_SCRIPT, languageDir, type FontFamilyEntry } from '@slidr/model';
import { useMemo } from 'react';
import { registerLibraryFonts } from './fontFaces';
import { useT, type MessageKey, type Translate } from './i18n';
import { isBase, nativeName, type Lang } from './languages';
import { manifest, mediaJson, size } from './media';
import { ItemOverlay, stepper } from './Overlay';
import { matches, useRead, type LibraryRoute } from './shared';

interface FontCatalog {
  families: FontFamilyEntry[];
  faces: { family: string; style: string; weight: string; path: string; unicodeRange?: string }[];
}

interface Notice {
  name: string;
  version?: string;
  license?: string;
  author?: string;
  homepage?: string;
  text?: string;
}

/** A sentence in each language, set in a family that has its letters. */
const SENTENCES: Record<Lang, string> = {
  he: 'שפה ברורה, אות אחר אות: כך נראית המצגת שלכם',
  en: 'Clear type, letter by letter: this is how your deck reads',
  ar: 'خطّ واضح، حرفًا بحرف: هكذا يبدو عرضكم التقديمي',
  de: 'Klare Schrift, Buchstabe für Buchstabe: So liest sich Ihre Präsentation',
  es: 'Letra clara, una a una: así se lee tu presentación',
  fr: 'Une lettre nette après l’autre : voici comment se lit votre présentation',
  it: 'Caratteri chiari, lettera dopo lettera: ecco come si legge la tua presentazione',
  'pt-BR': 'Letras claras, uma a uma: é assim que sua apresentação se lê',
  ru: 'Чёткий шрифт, буква за буквой: так читается ваша презентация',
  tr: 'Net harfler, tek tek: sunumunuz böyle okunur',
  vi: 'Chữ rõ ràng, từng nét một: bài trình bày của bạn trông như thế này',
  id: 'Huruf yang jelas, satu per satu: beginilah presentasi Anda terbaca',
  hi: 'साफ़ अक्षर, एक-एक करके: ऐसी दिखती है आपकी प्रस्तुति',
  ja: 'はっきりした文字を一つずつ：これがあなたのスライドの見え方です',
  ko: '또렷한 글자를 한 자씩: 프레젠테이션은 이렇게 보입니다',
  'zh-CN': '清晰的字体，一字一句：这就是您的演示文稿',
};
const HE = SENTENCES.he;
const EN = SENTENCES.en;

/** The letters a family may have, by the tag the catalog gives them (`LANGUAGE_SCRIPT`). */
const SCRIPTS: Record<string, { name: MessageKey; sample: string }> = {
  he: { name: 'libraryCatalogs.script.he', sample: 'אבג דהו' },
  latin: { name: 'libraryCatalogs.script.latin', sample: 'Abc Def' },
  arabic: { name: 'libraryCatalogs.script.arabic', sample: 'أبج هوز' },
  cyrillic: { name: 'libraryCatalogs.script.cyrillic', sample: 'Абв Где' },
  vietnamese: { name: 'libraryCatalogs.script.vietnamese', sample: 'Ăâ Đđ Ơư' },
  devanagari: { name: 'libraryCatalogs.script.devanagari', sample: 'अआ इई' },
  japanese: { name: 'libraryCatalogs.script.japanese', sample: 'あア 漢字' },
  korean: { name: 'libraryCatalogs.script.korean', sample: '가나 다라' },
  chinese: { name: 'libraryCatalogs.script.chinese', sample: '中文 字体' },
};

const scriptName = (t: Translate, script: string) =>
  SCRIPTS[script] ? t(SCRIPTS[script].name) : script;
const scriptsOf = (t: Translate, scripts: readonly string[]) =>
  scripts.map((script) => scriptName(t, script)).join(' + ');

/** The weights a face covers: each hundred of a variable range, or its one weight. */
function weightsOf(weight: string): number[] {
  const [from, to] = weight.split(/\s+/).map(Number);
  if (!from) return [];
  if (!to) return [from];
  const all: number[] = [];
  for (let w = Math.ceil(from / 100) * 100; w <= to; w += 100) all.push(w);
  return all;
}

function familyWeights(catalog: FontCatalog, family: string) {
  const normal = new Set<number>();
  let italic = false;
  for (const face of catalog.faces) {
    if (face.family !== family) continue;
    if (face.style === 'italic') italic = true;
    else for (const w of weightsOf(face.weight)) normal.add(w);
  }
  return { weights: [...normal].sort((a, b) => a - b), italic };
}

/** The folder of a family in the library, from where its faces are. */
const folderOf = (catalog: FontCatalog, family: string) =>
  catalog.faces.find((face) => face.family === family)?.path.split('/')[1];

const fonts = () =>
  Promise.all([mediaJson<FontCatalog>('fonts/catalog.json'), registerLibraryFonts()]).then(
    ([catalog]) => catalog,
  );

function FontDetail({
  catalog,
  family,
  lang,
  onClose,
  onStep,
}: {
  catalog: FontCatalog;
  family: string;
  lang: Lang;
  onClose: () => void;
  onStep?: (by: -1 | 1) => void;
}) {
  const t = useT();
  const entry = catalog.families.find((f) => f.family === family);
  const folder = folderOf(catalog, family);
  const notice = useRead(
    () => mediaJson<Notice>(`fonts/${folder}/${folder}.notice.json`),
    [folder],
  );
  const files = useRead(manifest, []);
  const faces = catalog.faces.filter((face) => face.family === family);
  const { weights, italic } = familyWeights(catalog, family);
  const hebrew = entry?.scripts.includes('he');
  // The sentence of the language shown, beside the Hebrew and the English, when it has its letters.
  const own = !isBase(lang) && entry?.scripts.includes(LANGUAGE_SCRIPT[lang]);
  const bytes = faces.reduce((sum, face) => sum + (files.value?.files[face.path]?.size ?? 0), 0);

  return (
    <ItemOverlay
      title={<span dir="ltr">{family}</span>}
      subtitle={
        <>
          {scriptsOf(t, entry?.scripts ?? [])} ·{' '}
          {t('libraryCatalogs.fonts.fileCount', { count: faces.length })} · {size(bytes)}
        </>
      }
      onClose={onClose}
      onStep={onStep}
      side={
        <>
          <section>
            <h3>{t('libraryCatalogs.fonts.license')}</h3>
            {notice.error && <p className="error-text">{notice.error}</p>}
            {notice.value && (
              <>
                <dl className="facts" dir="ltr">
                  <dt>package</dt>
                  <dd>
                    {notice.value.name} {notice.value.version}
                  </dd>
                  <dt>license</dt>
                  <dd>{notice.value.license}</dd>
                  <dt>author</dt>
                  <dd>{notice.value.author}</dd>
                  {notice.value.homepage && (
                    <>
                      <dt>home</dt>
                      <dd>
                        <a href={notice.value.homepage} target="_blank" rel="noreferrer">
                          {notice.value.homepage}
                        </a>
                      </dd>
                    </>
                  )}
                </dl>
                <details>
                  <summary>{t('libraryCatalogs.fonts.licenseText')}</summary>
                  <pre className="file-text small" dir="ltr">
                    {notice.value.text}
                  </pre>
                </details>
              </>
            )}
          </section>
          <section>
            <h3>{t('libraryCatalogs.fonts.files')}</h3>
            <ul className="plain-list" dir="ltr">
              {faces.map((face) => (
                <li key={face.path} title={face.unicodeRange}>
                  {face.path.split('/').at(-1)} · {face.style} {face.weight}
                  {files.value?.files[face.path] &&
                    ` · ${size(files.value.files[face.path]!.size)}`}
                </li>
              ))}
            </ul>
          </section>
        </>
      }
    >
      <div className="font-waterfall" style={{ fontFamily: JSON.stringify(family) }}>
        {weights.map((weight) => (
          <div key={weight} className="font-weight-row">
            <span className="tag" dir="ltr">
              {weight}
            </span>
            <div>
              {hebrew && (
                <p dir="rtl" style={{ fontWeight: weight }}>
                  {HE}
                </p>
              )}
              {own && (
                <p lang={lang} dir={languageDir(lang)} style={{ fontWeight: weight }}>
                  {SENTENCES[lang]}
                </p>
              )}
              <p dir="ltr" style={{ fontWeight: weight }}>
                {EN}
              </p>
            </div>
          </div>
        ))}
        {italic && (
          <div className="font-weight-row">
            <span className="tag">italic</span>
            <p dir="ltr" style={{ fontStyle: 'italic' }}>
              {EN}
            </p>
          </div>
        )}
        <p className="font-glyphs" dir="ltr">
          {hebrew && 'אבגדהוזחטיכךלמםנןסעפףצץקרשת '}
          ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 ₪$€%&@#?!
        </p>
      </div>
    </ItemOverlay>
  );
}

/**
 * The fonts of decks in the language shown (`familyOfLanguage`): a sample of each family, and its
 * faces and licence up close. A Hebrew family is not among English's, though it has Latin letters.
 */
export function Fonts({
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
  const read = useRead(fonts, []);
  const catalog = read.value;
  const script = LANGUAGE_SCRIPT[lang];
  const fitting = useMemo(
    () => (catalog?.families ?? []).filter((f) => familyOfLanguage(f, lang)),
    [catalog, lang],
  );
  const shown = useMemo(
    () => fitting.filter((f) => matches(query, f.family)).map((f) => f.family),
    [fitting, query],
  );
  if (read.error) return <p className="error-text">{read.error}</p>;
  if (!catalog) return <p className="muted">{t('libraryCatalogs.loading')}</p>;
  const open = (family: string) => go({ section: 'fonts', item: family });

  return (
    <>
      {fitting.length > 0 && (
        <p className="small muted">
          {t('libraryCatalogs.fonts.withScript', {
            script: scriptName(t, script),
            count: fitting.length,
          })}
        </p>
      )}
      {fitting.length === 0 && (
        <p className="small language-note">
          {t('libraryCatalogs.fonts.noneWithScript', { script: scriptName(t, script) })}
          <bdi lang={lang}>{nativeName(lang)}</bdi>
          {t('libraryCatalogs.fonts.noneWithScriptEnd')}
        </p>
      )}
      <div className="font-grid">
        {shown.map((family) => {
          const entry = catalog.families.find((f) => f.family === family)!;
          // A sample of the letters of the language shown, which every family shown has.
          const sample = script;
          const { weights } = familyWeights(catalog, family);
          return (
            <button
              type="button"
              key={family}
              className="font-card"
              onClick={() => open(family)}
              style={{ fontFamily: JSON.stringify(family) }}
            >
              <span className="font-card-name">
                <bdi>{family}</bdi>
              </span>
              <span className="font-card-sample">
                {sample === 'latin' ? (
                  <bdi dir="ltr">Abc Def · 123</bdi>
                ) : (
                  <>
                    <bdi>{SCRIPTS[sample]?.sample}</bdi> · Abc
                  </>
                )}
              </span>
              <span className="font-card-meta">
                {scriptsOf(t, entry.scripts)} ·{' '}
                {t('libraryCatalogs.fonts.weightCount', { count: weights.length })}
              </span>
            </button>
          );
        })}
      </div>
      {route.item && catalog.families.some((f) => f.family === route.item) && (
        <FontDetail
          key={route.item}
          catalog={catalog}
          family={route.item}
          lang={lang}
          onClose={() => go({ section: 'fonts' })}
          onStep={stepper(shown, route.item, open)}
        />
      )}
    </>
  );
}
