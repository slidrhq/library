/**
 * The system settings, for the library's admins (server/core/system.ts; README, "System
 * settings"): what the organization's apps offer, and what they start with. The agents, the
 * organization's own among them; the languages of the interface; web access; the image providers
 * and the photo libraries. They are published into the media at once, as one file, and each app
 * reads it when it first starts, and again only when it starts as a new version of the app.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ContentLanguage } from '@slidr/model';
import { isolate } from './bidi';
import { useLang, useT, type MessageKey } from './i18n';
import { nativeName } from './languages';
import { Field, Said, messageOf, useWork, type Note } from './Settings';
import { useRead } from './shared';
import {
  AGENTS,
  IMAGE_PROVIDERS,
  LANGUAGES,
  STOCK_SOURCES,
  TONES,
  systemApi,
  type CustomAgent,
  type Offer,
  type SystemChange,
  type SystemSettings,
  type WebAccess,
} from './systemApi';
import { ApiError, readAccess, when } from './uploadsApi';

/** An agent of the organization's own as its fields hold it, before it is checked. */
interface AgentDraft {
  /** The page's own key for it, so its fields keep their place while its id is typed. */
  key: number;
  id: string;
  name: string;
  glyph: string;
  tone: string;
  command: string;
  /** One a line. */
  args: string;
  /** `NAME=value`, one a line. */
  env: string;
  install: '' | 'winget' | 'npm';
  package: string;
  source: string;
}

/** What is offered of one kind, as the boxes hold it; every box checked, every one. */
interface OfferDraft {
  offered: string[];
  default: string;
}

interface Draft {
  agents: OfferDraft;
  webAccess: '' | WebAccess;
  custom: AgentDraft[];
  languages: OfferDraft;
  images: OfferDraft;
  stock: OfferDraft;
}

let keys = 0;

const agentDraft = (agent?: CustomAgent): AgentDraft => {
  const install = agent?.install;
  return {
    key: (keys += 1),
    id: agent?.id ?? '',
    name: agent?.name ?? '',
    glyph: agent?.glyph ?? '',
    tone: agent?.tone ?? '',
    command: agent?.command ?? '',
    args: (agent?.args ?? []).join('\n'),
    env: Object.entries(agent?.env ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'),
    install: install ? ('npm' in install ? 'npm' : 'winget') : '',
    package: install ? ('npm' in install ? install.npm : install.winget) : '',
    source: install && 'source' in install ? (install.source ?? '') : '',
  };
};

const offerDraft = (offer: Offer<string> | undefined, all: readonly string[]): OfferDraft => ({
  offered: offer?.offered ?? [...all],
  default: offer?.default ?? '',
});

function draftOf(settings: SystemSettings | null): Draft {
  const custom = (settings?.agents.custom ?? []).map(agentDraft);
  return {
    agents: offerDraft(settings?.agents, [
      ...AGENTS.map((agent) => agent.id),
      ...custom.map((agent) => agent.id),
    ]),
    webAccess: settings?.agents.webAccess ?? '',
    custom,
    languages: offerDraft(settings?.languages, LANGUAGES),
    images: offerDraft(
      settings?.images,
      IMAGE_PROVIDERS.map((provider) => provider.id),
    ),
    stock: offerDraft(
      settings?.stock,
      STOCK_SOURCES.map((source) => source.id),
    ),
  };
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** An offer as it is sent: every one offered is none named. */
function offerOf<T extends string>(draft: OfferDraft, all: readonly string[]): Offer<T> {
  const every = all.every((id) => draft.offered.includes(id));
  return {
    ...(every ? {} : { offered: all.filter((id) => draft.offered.includes(id)) as T[] }),
    ...(draft.default ? { default: draft.default as T } : {}),
  };
}

function changeOf(draft: Draft): SystemChange {
  const custom: CustomAgent[] = draft.custom.map((agent) => ({
    id: agent.id.trim(),
    name: agent.name.trim(),
    ...(agent.glyph.trim() ? { glyph: agent.glyph.trim() } : {}),
    ...(agent.tone ? { tone: agent.tone as CustomAgent['tone'] } : {}),
    command: agent.command.trim(),
    args: lines(agent.args),
    env: Object.fromEntries(
      lines(agent.env).map((line) => {
        const at = line.indexOf('=');
        return at < 0 ? [line, ''] : [line.slice(0, at).trim(), line.slice(at + 1)];
      }),
    ),
    ...(agent.install === 'winget'
      ? {
          install: {
            winget: agent.package.trim(),
            ...(agent.source.trim() ? { source: agent.source.trim() } : {}),
          },
        }
      : agent.install === 'npm'
        ? { install: { npm: agent.package.trim() } }
        : {}),
  }));
  const agents = [...AGENTS.map((agent) => agent.id), ...custom.map((agent) => agent.id)];
  return {
    agents: {
      ...offerOf(draft.agents, agents),
      custom,
      ...(draft.webAccess ? { webAccess: draft.webAccess } : {}),
    },
    languages: offerOf<ContentLanguage>(draft.languages, LANGUAGES),
    images: offerOf(
      draft.images,
      IMAGE_PROVIDERS.map((provider) => provider.id),
    ),
    stock: offerOf(
      draft.stock,
      STOCK_SOURCES.map((source) => source.id),
    ),
  };
}

/** Boxes for what is offered, and the one an app starts with. */
function OfferPart({
  title,
  explain,
  options,
  value,
  onChange,
  children,
}: {
  title: MessageKey;
  explain: MessageKey;
  options: readonly { id: string; name: ReactNode }[];
  value: OfferDraft;
  onChange: (value: OfferDraft) => void;
  children?: ReactNode;
}) {
  const t = useT();
  const toggle = (id: string, on: boolean) => {
    const offered = on ? [...value.offered, id] : value.offered.filter((one) => one !== id);
    onChange({ offered, default: offered.includes(value.default) ? value.default : '' });
  };
  return (
    <section className="settings-part">
      <h3>{t(title)}</h3>
      <p className="small">{t(explain)}</p>
      <div className="system-offer">
        {options.map((option) => (
          <label key={option.id} className="settings-check">
            <input
              type="checkbox"
              checked={value.offered.includes(option.id)}
              onChange={(event) => toggle(option.id, event.target.checked)}
            />
            <span>{option.name}</span>
          </label>
        ))}
      </div>
      {value.offered.length === 0 && <p className="error-text small">{t('system.noneOffered')}</p>}
      <Field label={t('system.default')}>
        <select
          value={value.default}
          onChange={(event) => onChange({ ...value, default: event.target.value })}
        >
          <option value="">{t('system.defaultNone')}</option>
          {options
            .filter((option) => value.offered.includes(option.id))
            .map((option) => (
              <option key={option.id} value={option.id}>
                {typeof option.name === 'string' ? option.name : option.id}
              </option>
            ))}
        </select>
      </Field>
      {children}
    </section>
  );
}

/** The fields of one of the organization's agents. */
function AgentFields({
  agent,
  onChange,
  onRemove,
}: {
  agent: AgentDraft;
  onChange: (agent: AgentDraft) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const set =
    <K extends keyof AgentDraft>(name: K) =>
    (event: { target: { value: string } }) =>
      onChange({ ...agent, [name]: event.target.value });
  return (
    <fieldset className="system-agent">
      <legend>
        <bdi>{agent.name.trim() || agent.id.trim() || t('system.custom.unnamed')}</bdi>
      </legend>
      <div className="settings-server two">
        <Field label={t('system.custom.name')}>
          <input required maxLength={40} value={agent.name} onChange={set('name')} />
        </Field>
        <Field label={t('system.custom.id')} hint={t('system.custom.idHint')}>
          <input
            required
            dir="ltr"
            pattern="[a-z][a-z0-9\-]{1,31}"
            value={agent.id}
            onChange={set('id')}
          />
        </Field>
      </div>
      <div className="settings-server two">
        <Field label={t('system.custom.glyph')} hint={t('system.custom.glyphHint')}>
          <input maxLength={4} value={agent.glyph} onChange={set('glyph')} />
        </Field>
        <Field label={t('system.custom.tone')}>
          <select value={agent.tone} onChange={set('tone')}>
            <option value="">{t('system.custom.toneNone')}</option>
            {TONES.map((tone) => (
              <option key={tone} value={tone}>
                {t(`system.tone.${tone}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t('system.custom.command')} hint={isolate(t('system.custom.commandHint'))}>
        <input
          required
          dir="ltr"
          value={agent.command}
          onChange={set('command')}
          placeholder="%LOCALAPPDATA%\Programs\Acme\acme.exe"
        />
      </Field>
      <Field label={t('system.custom.args')} hint={t('system.custom.argsHint')}>
        <textarea dir="ltr" rows={3} value={agent.args} onChange={set('args')} />
      </Field>
      <Field label={t('system.custom.env')} hint={t('system.custom.envHint')}>
        <textarea
          dir="ltr"
          rows={2}
          value={agent.env}
          onChange={set('env')}
          placeholder="ACME_REGION=eu"
        />
      </Field>
      <Field label={t('system.custom.install')} hint={t('system.custom.installHint')}>
        <select value={agent.install} onChange={set('install')}>
          <option value="">{t('system.custom.installNone')}</option>
          <option value="winget">WinGet</option>
          <option value="npm">npm</option>
        </select>
      </Field>
      {agent.install && (
        <div className={agent.install === 'winget' ? 'settings-server two' : undefined}>
          <Field label={t('system.custom.package')}>
            <input
              required
              dir="ltr"
              value={agent.package}
              onChange={set('package')}
              placeholder={agent.install === 'npm' ? '@acme/agent' : 'Acme.Agent'}
            />
          </Field>
          {agent.install === 'winget' && (
            <Field label={t('system.custom.source')} hint={t('system.custom.sourceHint')}>
              <input dir="ltr" value={agent.source} onChange={set('source')} />
            </Field>
          )}
        </div>
      )}
      <div className="row">
        <button type="button" className="ghost small" onClick={onRemove}>
          {t('system.custom.remove')}
        </button>
      </div>
    </fieldset>
  );
}

function Issues({ issues }: { issues: { path: string; message: string }[] }) {
  const t = useT();
  if (issues.length === 0) return null;
  return (
    <div className="error-text small" role="alert">
      <p>{t('system.issues')}</p>
      <ul>
        {issues.map((issue) => (
          <li key={`${issue.path}:${issue.message}`}>
            <code dir="ltr">{issue.path}</code> {isolate(issue.message)}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PUBLISHED: Note = { ok: true, say: (t) => t('system.saved') };
const REMOVED: Note = { ok: true, say: (t) => t('system.removed') };

export function System() {
  const t = useT();
  const [uiLang] = useLang();
  const access = useRead(readAccess, []);
  const [settings, setSettings] = useState<SystemSettings | null>();
  const [draft, setDraft] = useState<Draft>();
  const [failed, setFailed] = useState<string>();
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const work = useWork();
  const may = access.value?.user?.can.settings;
  useEffect(() => {
    if (!may) return;
    systemApi.read().then(
      (read) => {
        setSettings(read.settings);
        setDraft(draftOf(read.settings));
      },
      (error: unknown) => setFailed(messageOf(error)),
    );
  }, [may]);

  if (access.value && !may) {
    return (
      <div className="upload-empty">
        <p>{t('settings.closed')}</p>
      </div>
    );
  }
  if (failed !== undefined) {
    return <p className="error-text">{isolate(t('people.failed', { error: failed }))}</p>;
  }
  if (!draft || settings === undefined) return <p className="muted">{t('settings.loading')}</p>;

  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const agentOptions = [
    ...AGENTS.map((agent) => ({ id: agent.id, name: agent.name })),
    ...draft.custom
      .filter((agent) => agent.id.trim())
      .map((agent) => ({ id: agent.id.trim(), name: agent.name.trim() || agent.id.trim() })),
  ];
  const empty = [draft.agents, draft.languages, draft.images, draft.stock].some(
    (offer) => offer.offered.length === 0,
  );

  const changeAgent = (index: number, agent: AgentDraft) => {
    const before = draft.custom[index]!.id.trim();
    const after = agent.id.trim();
    const custom = draft.custom.map((one, at) => (at === index ? agent : one));
    // An agent is offered as it is added, and keeps its place in the offer as its id changes.
    const offered = draft.agents.offered.map((id) => (id === before ? after : id));
    if (after && !offered.includes(after) && !before) offered.push(after);
    update({
      custom,
      agents: {
        offered,
        default: draft.agents.default === before ? after : draft.agents.default,
      },
    });
  };
  const removeAgent = (index: number) => {
    const id = draft.custom[index]!.id.trim();
    update({
      custom: draft.custom.filter((_, at) => at !== index),
      agents: {
        offered: draft.agents.offered.filter((one) => one !== id),
        default: draft.agents.default === id ? '' : draft.agents.default,
      },
    });
  };

  const publish = (event: FormEvent) => {
    event.preventDefault();
    setIssues([]);
    work.run(async () => {
      try {
        const saved = await systemApi.save(changeOf(draft));
        setSettings(saved.settings);
        setDraft(draftOf(saved.settings));
        return PUBLISHED;
      } catch (error) {
        if (error instanceof ApiError && error.issues.length > 0) setIssues(error.issues);
        throw error;
      }
    });
  };
  const remove = () => {
    if (!window.confirm(t('system.removeConfirm'))) return;
    setIssues([]);
    work.run(async () => {
      await systemApi.remove();
      setSettings(null);
      setDraft(draftOf(null));
      return REMOVED;
    });
  };

  return (
    <form className="settings" onSubmit={publish}>
      <section className="settings-part">
        <h3>{t('system.title')}</h3>
        <p className="small">{t('system.explain')}</p>
        <p className="small">
          {settings
            ? t('system.updated', { when: when(uiLang, settings.updated) })
            : t('system.none')}
        </p>
      </section>

      <OfferPart
        title="system.agents.title"
        explain="system.agents.explain"
        options={agentOptions}
        value={draft.agents}
        onChange={(agents) => update({ agents })}
      >
        <Field label={t('system.web.label')} hint={t('system.web.hint')}>
          <select
            value={draft.webAccess}
            onChange={(event) => update({ webAccess: event.target.value as Draft['webAccess'] })}
          >
            <option value="">{t('system.web.unset')}</option>
            <option value="on">{t('system.web.on')}</option>
            <option value="off">{t('system.web.off')}</option>
            <option value="blocked">{t('system.web.blocked')}</option>
          </select>
        </Field>
      </OfferPart>

      <section className="settings-part">
        <h3>{t('system.custom.title')}</h3>
        <p className="small">{t('system.custom.explain')}</p>
        {draft.custom.map((agent, index) => (
          <AgentFields
            key={agent.key}
            agent={agent}
            onChange={(next) => changeAgent(index, next)}
            onRemove={() => removeAgent(index)}
          />
        ))}
        <div className="row">
          <button
            type="button"
            className="small"
            disabled={draft.custom.length >= 16}
            onClick={() => update({ custom: [...draft.custom, agentDraft()] })}
          >
            {t('system.custom.add')}
          </button>
        </div>
      </section>

      <OfferPart
        title="system.languages.title"
        explain="system.languages.explain"
        options={LANGUAGES.map((lang) => ({ id: lang, name: nativeName(lang) }))}
        value={draft.languages}
        onChange={(languages) => update({ languages })}
      />
      <OfferPart
        title="system.images.title"
        explain="system.images.explain"
        options={IMAGE_PROVIDERS}
        value={draft.images}
        onChange={(images) => update({ images })}
      />
      <OfferPart
        title="system.stock.title"
        explain="system.stock.explain"
        options={STOCK_SOURCES}
        value={draft.stock}
        onChange={(stock) => update({ stock })}
      />

      <section className="settings-part">
        <Issues issues={issues} />
        <div className="row">
          <button type="submit" className="primary" disabled={work.busy || empty}>
            {t('system.save')}
          </button>
          {settings && (
            <button type="button" className="ghost" disabled={work.busy} onClick={remove}>
              {t('system.remove')}
            </button>
          )}
        </div>
        <Said note={work.note} />
      </section>
    </form>
  );
}
