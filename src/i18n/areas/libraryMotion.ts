/**
 * The words of the animations and the backgrounds of Elements (`src/Motion.tsx`): the library's
 * catalogs of them (ADR-138 of the app). Their names, and the names of their groups and kinds,
 * are the catalogs' and the app's own.
 */
export const he = {
  'library.section.animations.name': 'אנימציות',
  'library.section.animations.about':
    'האנימציות והצורות המונפשות של Elements: מה שזז מעצמו, כפי שהוא נכנס לשקף.',
  'library.section.backgrounds.name': 'רקעים',
  'library.section.backgrounds.about':
    'הרקעים של Elements, בתנועה ושקטים, מצוירים מעל הרקע של השקף.',

  'uploads.kind.backgrounds.add': 'רקע חדש',
  'uploads.kind.animations.add': 'אנימציה חדשה',

  'libraryMotion.loading': 'טוען…',
  'libraryMotion.animationsEmpty': 'בספרייה אין אנימציות.',
  'libraryMotion.backgroundsEmpty': 'בספרייה אין רקעים.',
  'libraryMotion.hint': 'כל אחד זז כשהעכבר עליו. לחיצה פותחת אותו בגדול.',
  'libraryMotion.kind': 'סוג',
  'libraryMotion.kindPicture': 'תמונה שזזה מעצמה',
  'libraryMotion.kindLine': 'קו שמשהו זורם לאורכו',
  'libraryMotion.kindShape': 'צורה שחוזרת על תנועה',
  'libraryMotion.motion': 'תנועה',
  'libraryMotion.moving': 'זז',
  'libraryMotion.still': 'שקט',
  'libraryMotion.direction': 'כיוון',
  'libraryMotion.sided': 'עומד בצד אחד של השקף, ומתהפך עם כיוון המצגת',
  'libraryMotion.whole': 'מכסה את כל השקף, זהה בשני הכיוונים',
  'libraryMotion.reads': 'נע מצד לצד, בכיוון הקריאה של המצגת',
  'libraryMotion.same': 'זהה בשני הכיוונים',
  'libraryMotion.group': 'קבוצה',
  'libraryMotion.size': 'גודל בשקף',
  'libraryMotion.shape': 'צורה',
  'libraryMotion.names': 'שמות',
  'libraryMotion.rtl': 'במצגת שנקראת מימין',
  'libraryMotion.ltr': 'במצגת שנקראת משמאל',
  'libraryMotion.themeNote': 'מצויר בערכת הנושא של מצגת חדשה. בשקף, הצבעים באים מהתבנית של המצגת.',
};

export const en: Record<keyof typeof he, string> = {
  'library.section.animations.name': 'Animations',
  'library.section.animations.about':
    'The animations and the animated shapes of Elements: what moves by itself, as it goes onto a slide.',
  'library.section.backgrounds.name': 'Backgrounds',
  'library.section.backgrounds.about':
    "The backgrounds of Elements, moving and still, drawn over the slide's ground.",

  'uploads.kind.backgrounds.add': 'New background',
  'uploads.kind.animations.add': 'New animation',

  'libraryMotion.loading': 'Loading…',
  'libraryMotion.animationsEmpty': 'The library has no animations.',
  'libraryMotion.backgroundsEmpty': 'The library has no backgrounds.',
  'libraryMotion.hint': 'Each one moves while the pointer is on it. A click opens it full size.',
  'libraryMotion.kind': 'Kind',
  'libraryMotion.kindPicture': 'A picture that moves by itself',
  'libraryMotion.kindLine': 'A line something runs along',
  'libraryMotion.kindShape': 'A shape that repeats a motion',
  'libraryMotion.motion': 'Motion',
  'libraryMotion.moving': 'Moves',
  'libraryMotion.still': 'Still',
  'libraryMotion.direction': 'Direction',
  'libraryMotion.sided':
    "Stands on one side of the slide, and is mirrored with the deck's direction",
  'libraryMotion.whole': 'Covers the whole slide, the same in both directions',
  'libraryMotion.reads': "Runs from side to side, in the deck's reading direction",
  'libraryMotion.same': 'The same in both directions',
  'libraryMotion.group': 'Group',
  'libraryMotion.size': 'Size on a slide',
  'libraryMotion.shape': 'Shape',
  'libraryMotion.names': 'Names',
  'libraryMotion.rtl': 'In a deck that reads from the right',
  'libraryMotion.ltr': 'In a deck that reads from the left',
  'libraryMotion.themeNote':
    "Drawn in a new deck's theme. On a slide, its colours come from the deck's template.",
};
