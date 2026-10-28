/**
 * The settings of the apps that read the library, as its admins see and set them
 * (server/core/system.ts; README, "System settings"). They are published into the media as one
 * file, which every app reads when it first starts, and again when it starts as a new version.
 */
import { CONTENT_LANGUAGES, type ContentLanguage } from '@slidr/model';
import { call } from './uploadsApi';

/** The agents the app has of its own, by the names it shows them (`harnessLook.ts` of the app). */
export const AGENTS = [
  { id: 'claude-code', name: 'Claude' },
  { id: 'codex-cli', name: 'Codex' },
  { id: 'copilot-cli', name: 'GitHub Copilot' },
  { id: 'gemini-cli', name: 'Gemini' },
  { id: 'grok-cli', name: 'Grok' },
] as const;

/** The app's image providers. */
export const IMAGE_PROVIDERS = [
  { id: 'codex-cli', name: 'Codex' },
  { id: 'openai-api', name: 'OpenAI API' },
] as const;

/** The app's photo libraries. */
export const STOCK_SOURCES = [
  { id: 'unsplash', name: 'Unsplash' },
  { id: 'pexels', name: 'Pexels' },
] as const;

export const LANGUAGES: readonly ContentLanguage[] = CONTENT_LANGUAGES;

/** The tints of an agent's mark, as the app's design system names them. */
export const TONES = ['orange', 'green', 'blue', 'violet', 'teal', 'pink', 'rose'] as const;
export type Tone = (typeof TONES)[number];

export type WebAccess = 'on' | 'off' | 'blocked';

export type Install = { winget: string; source?: string } | { npm: string };

/** An agent of the organization's own: a CLI of the app's custom agent protocol. */
export interface CustomAgent {
  id: string;
  name: string;
  glyph?: string;
  tone?: Tone;
  /** A native executable: its absolute path, or its name. */
  command: string;
  args: string[];
  env: Record<string, string>;
  install?: Install;
}

/** What is offered of one kind, and what an app starts with; none named, every one. */
export interface Offer<T extends string> {
  offered?: T[];
  default?: T;
}

export interface SystemSettings {
  version: 1;
  /** When it was published. */
  updated: string;
  agents: Offer<string> & { custom: CustomAgent[]; webAccess?: WebAccess };
  languages: Offer<ContentLanguage>;
  images: Offer<string>;
  stock: Offer<string>;
}

/** What is sent: the settings without what the server writes itself. */
export type SystemChange = Omit<SystemSettings, 'version' | 'updated'>;

const send = <T>(method: string, body: unknown) =>
  call<T>('settings/system', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const systemApi = {
  read: () => call<{ path: string; settings: SystemSettings | null }>('settings/system'),
  save: (change: SystemChange) =>
    send<{ settings: SystemSettings; published?: string }>('PUT', change),
  remove: () => call<undefined>('settings/system', { method: 'DELETE' }),
};
