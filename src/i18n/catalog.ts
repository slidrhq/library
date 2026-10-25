/**
 * Every word of the library, by key. Each area of the interface keeps its own words in
 * `areas/<area>.ts`, in Hebrew and English; the other languages are in `locales/<lang>.ts`,
 * read when the language is chosen. A value holds `{name}` where a number or a name goes.
 */
import * as account from './areas/account';
import * as libraryBrowse from './areas/libraryBrowse';
import * as libraryCatalogs from './areas/libraryCatalogs';
import * as libraryShell from './areas/libraryShell';
import * as people from './areas/people';
import * as shell from './areas/shell';
import * as uploads from './areas/uploads';

const areas = [shell, account, libraryShell, libraryBrowse, libraryCatalogs, uploads, people];

export const en = Object.assign({}, ...areas.map((area) => area.en)) as Merge<typeof shell.en> &
  Merge<typeof account.en> &
  Merge<typeof libraryShell.en> &
  Merge<typeof libraryBrowse.en> &
  Merge<typeof libraryCatalogs.en> &
  Merge<typeof uploads.en> &
  Merge<typeof people.en>;

export type MessageKey = keyof typeof en;

export const he = Object.assign({}, ...areas.map((area) => area.he)) as Record<MessageKey, string>;

type Merge<T> = { [K in keyof T]: string };
