export const he = {
  'settings.nav': 'הגדרות',
  'settings.about': 'איפה הספרייה שמורה, איך נכנסים אליה, וכמה כל אחד יכול להעלות.',
  'settings.closed': 'רק המנהלים של הספרייה רואים את ההגדרות שלה.',
  'settings.loading': 'קורא את ההגדרות…',
  'settings.save': 'שמירה',
  'settings.saved': 'נשמר.',
  'settings.library.title': 'כתובת הספרייה',
  'settings.library.host': 'השרת הזה מקבל את הכתובת שלו מהמארח שלו.',
  'settings.library.script':
    'סקריפט ההתקנה קבע את הכתובת הזו. מריצים אותו שוב כדי לשנות אותה, יחד עם הפורט והדרך שבה מגיעים לספרייה.',
  'settings.media.title': 'מדיה',
  'settings.media.explain': 'איפה שמורה הספרייה שפורסמה. כל העלאה שמאושרת נכתבת לשם.',
  'settings.media.kind.folder': 'תיקייה במחשב הזה',
  'settings.media.kind.r2': 'דלי ה-R2 של ה-Worker ב-Cloudflare',
  'settings.media.kind.none': 'עדיין אין מקום למדיה',
  'settings.media.room': 'פנויים {free} מתוך {size} בדיסק שלה.',
  'settings.media.fixed':
    'סקריפט ההתקנה קבע את התיקייה הזו. כדי להעביר את המדיה, מתקינים שוב על אותה תיקיית נתונים.',
  'settings.media.path': 'תיקייה',
  'settings.media.test': 'בדיקה',
  'settings.media.testing': 'בודק…',
  'settings.media.reachedLibrary':
    'יש גישה, והכתיבה הצליחה. יש בה את הספרייה שפורסמה {when}: {files}.',
  'settings.media.reachedEmpty':
    'יש גישה, והכתיבה הצליחה. היא עדיין ריקה: אפשר למלא אותה בהמשך העמוד.',
  'settings.media.unreachable': 'הכתיבה לשם לא הצליחה: {error}',
  'settings.media.address': 'הכתובת שממנה האפליקציות המותקנות קוראות',
  'settings.media.addressHint': 'נותנים אותה לאפליקציות בארגון באחת משתי דרכים:',
  'settings.media.policy': 'מדיניות לכל המחשבים (Group Policy או Intune):',
  'settings.media.installer': 'או מתקין שנושא את הכתובת:',
  'settings.media.notHttps':
    'אפליקציות מותקנות קוראות רק מכתובת HTTPS (חוץ מ-localhost). צריך לתת לספרייה כתובת HTTPS, או לתת לתיקייה כתובת ציבורית.',
  'settings.copy': 'העתקה',
  'settings.copied': 'הועתק',
  'settings.seed.title': 'מילוי המדיה',
  'settings.seed.explain':
    'מדיה ריקה מתמלאת בעותק של ספרייה שפורסמה, קובץ אחרי קובץ. אפשר לעצור, וההעתקה ממשיכה מהמקום שבו נעצרה.',
  'settings.seed.from': 'מאיפה',
  'settings.seed.start': 'מילוי',
  'settings.seed.stop': 'עצירה',
  'settings.seed.progress': 'הועתקו {present} מתוך {files} קבצים',
  'settings.seed.failed': 'קבצים שלא הועתקו בסבב הזה: {count}. הם ינוסו שוב.',
  'settings.seed.done': 'המדיה מכילה עכשיו את כל הספרייה.',
  'settings.seed.live':
    'המדיה מכילה את הספרייה שפורסמה {when}: {files}. מעכשיו רק העלאות שמאושרות משנות אותה.',
  'settings.signIn.title': 'כניסה',
  'settings.signIn.explain': 'הספק שדרכו נכנסים החברים של הספרייה ומי שמעלה אליה.',
  'settings.signIn.local':
    'הבעלים נכנסים גם בקישור של המחשב שהספרייה מותקנת בו (slidr-library login).',
  'settings.signIn.provider': 'ספק',
  'settings.signIn.none': 'אין: רק הבעלים, בקישור של המחשב',
  'settings.signIn.oidc': 'ספק OpenID Connect אחר',
  'settings.signIn.clientId': 'מזהה הלקוח (Client ID)',
  'settings.signIn.secret': 'הסוד של הלקוח (Client secret)',
  'settings.signIn.secretKept': 'שמור מאז {when}. אם משאירים ריק, הוא נשאר.',
  'settings.signIn.tenant': 'דייר (Tenant)',
  'settings.signIn.tenantHint':
    'המזהה של הדייר של הארגון, או הדומיין שלו, כמו contoso.onmicrosoft.com. רק חשבונות של הדייר הזה נכנסים.',
  'settings.signIn.issuer': 'כתובת המנפיק (Issuer)',
  'settings.signIn.issuerHint':
    'הכתובת שמסמך הגילוי שלה נמצא ב-/.well-known/openid-configuration. הוא נקרא לפני השמירה.',
  'settings.signIn.name': 'השם על הכפתור',
  'settings.signIn.domains': 'דומיינים מורשים',
  'settings.signIn.domainsHint':
    'רק כתובות בדומיינים האלה נכנסות. מפרידים בפסיקים; אם משאירים ריק, כל כתובת מאומתת נכנסת.',
  'settings.signIn.domainsMicrosoft':
    'חובה ב-Microsoft: היא לא מאשרת שהכתובת מאומתת, ולכן הדומיינים הם שקובעים מי נכנס.',
  'settings.signIn.redirect': 'כתובת החזרה (Redirect URI) לרישום אצל הספק',
  'settings.signIn.remove': 'הסרת הספק',
  'settings.signIn.removeConfirm': 'להסיר את הספק? רק הבעלים יוכלו להיכנס, בקישור של המחשב.',
  'settings.signIn.host':
    'Google, דרך הלקוח של ה-Worker (GOOGLE_CLIENT_ID). כדי לקבוע את הספק כאן, מגדירים ל-Worker את LIBRARY_MASTER_KEY.',
  'settings.signIn.hostNone':
    'אין ספק כניסה. כדי לקבוע אותו כאן, מגדירים ל-Worker את LIBRARY_MASTER_KEY.',
  'settings.limits.title': 'העלאות',
  'settings.limits.explain':
    'כמה כל מי שאין לו תפקיד יכול להשאיר ממתין לאישור, וכמה מהר. החברים פטורים.',
  'settings.limits.pending': 'העלאות ממתינות',
  'settings.limits.bytes': 'נפח ממתין (MiB)',
  'settings.limits.tokens': 'טוקנים לאדם',
  'settings.limits.writes': 'כתיבות בדקה',
  'settings.limits.default': 'ברירת מחדל: {value}',
  'settings.empty': 'הספרייה עדיין ריקה: עוד לא פורסם בה דבר.',
  'settings.emptySeed': 'מילוי המדיה בהגדרות',
  'settings.signIn.ownerOnly':
    'רק הבעלים של הספרייה קובעים איך נכנסים אליה: מי שקובע את ספק הכניסה קובע מי כל אחד הוא.',
};

export const en: Record<keyof typeof he, string> = {
  'settings.nav': 'Settings',
  'settings.about': 'Where the library is kept, how people sign in, and how much each may upload.',
  'settings.closed': 'Only the library’s admins see its settings.',
  'settings.loading': 'Reading the settings…',
  'settings.save': 'Save',
  'settings.saved': 'Saved.',
  'settings.library.title': 'The library’s address',
  'settings.library.host': 'This server is reached at the address its host gives it.',
  'settings.library.script':
    'The install script set this address. Running it again changes it, with the port and the way the library is reached.',
  'settings.media.title': 'Media',
  'settings.media.explain':
    'Where the published library is kept. Every upload that is approved is written there.',
  'settings.media.kind.folder': 'A folder on this machine',
  'settings.media.kind.r2': 'The Worker’s R2 bucket, on Cloudflare',
  'settings.media.kind.none': 'No media store yet',
  'settings.media.room': '{free} free of {size} on its disk.',
  'settings.media.fixed':
    'The install script named this folder. To move the media, install again over the same data folder.',
  'settings.media.path': 'Folder',
  'settings.media.test': 'Test',
  'settings.media.testing': 'Testing…',
  'settings.media.reachedLibrary':
    'Reached, and written to. It holds the library published {when}: {files}.',
  'settings.media.reachedEmpty':
    'Reached, and written to. It is empty still: seed it further down the page.',
  'settings.media.unreachable': 'It could not be written to: {error}',
  'settings.media.address': 'The address installed apps read',
  'settings.media.addressHint': 'Give it to the organization’s apps in one of two ways:',
  'settings.media.policy': 'A policy for every machine (Group Policy or Intune):',
  'settings.media.installer': 'Or an installer that carries the address:',
  'settings.media.notHttps':
    'Installed apps read only an HTTPS address (localhost aside). Give the library an HTTPS address, or the folder a public one.',
  'settings.copy': 'Copy',
  'settings.copied': 'Copied',
  'settings.seed.title': 'Seed the media',
  'settings.seed.explain':
    'An empty media store is filled with a copy of a published library, file by file. It may be stopped, and goes on where it stopped.',
  'settings.seed.from': 'From',
  'settings.seed.start': 'Seed',
  'settings.seed.stop': 'Stop',
  'settings.seed.progress': '{present} of {files} files copied',
  'settings.seed.failed': 'Files not copied in this round: {count}. They are tried again.',
  'settings.seed.done': 'The media holds the whole library now.',
  'settings.seed.live':
    'The media holds the library published {when}: {files}. From now on, only approved uploads change it.',
  'settings.signIn.title': 'Signing in',
  'settings.signIn.explain':
    'The provider the library’s members, and those who upload to it, sign in through.',
  'settings.signIn.local':
    'The owner also signs in by a link of the machine the library is installed on (slidr-library login).',
  'settings.signIn.provider': 'Provider',
  'settings.signIn.none': 'None: the owner alone, by the machine’s link',
  'settings.signIn.oidc': 'Another OpenID Connect provider',
  'settings.signIn.clientId': 'Client ID',
  'settings.signIn.secret': 'Client secret',
  'settings.signIn.secretKept': 'Kept since {when}. Left empty, it stays.',
  'settings.signIn.tenant': 'Tenant',
  'settings.signIn.tenantHint':
    'Your organization’s tenant ID, or its domain, as contoso.onmicrosoft.com. Only that tenant’s accounts sign in.',
  'settings.signIn.issuer': 'Issuer',
  'settings.signIn.issuerHint':
    'The address whose discovery document is at /.well-known/openid-configuration. It is read before saving.',
  'settings.signIn.name': 'Name on the button',
  'settings.signIn.domains': 'Allowed domains',
  'settings.signIn.domainsHint':
    'Only addresses in these domains sign in. Separate them with commas; left empty, any verified address does.',
  'settings.signIn.domainsMicrosoft':
    'Required for Microsoft: it does not vouch that an address is verified, so the domains decide who signs in.',
  'settings.signIn.redirect': 'Redirect URI to register with the provider',
  'settings.signIn.remove': 'Remove the provider',
  'settings.signIn.removeConfirm':
    'Remove the provider? Only the owner will sign in, by the machine’s link.',
  'settings.signIn.host':
    'Google, through the Worker’s own client (GOOGLE_CLIENT_ID). To set the provider here, give the Worker LIBRARY_MASTER_KEY.',
  'settings.signIn.hostNone':
    'No sign-in provider. To set one here, give the Worker LIBRARY_MASTER_KEY.',
  'settings.limits.title': 'Uploads',
  'settings.limits.explain':
    'How much each person without a role may leave waiting for review, and how fast. Members are exempt.',
  'settings.limits.pending': 'Uploads waiting',
  'settings.limits.bytes': 'Size waiting (MiB)',
  'settings.limits.tokens': 'Tokens per person',
  'settings.limits.writes': 'Writes a minute',
  'settings.limits.default': 'Default: {value}',
  'settings.empty': 'The library is empty: nothing is published in it yet.',
  'settings.emptySeed': 'Seed the media in Settings',
  'settings.signIn.ownerOnly':
    'Only the library’s owner sets how people sign in: whoever names the provider says who each person is.',
};
