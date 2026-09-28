import type { Provider } from '@hub/shared';
import type { AccountT, ItemT, PolicyLevelT } from './types';

export type ServiceInfo = {
  provider: Provider;
  name: string;
  covers: string;
  /** Shorter "covers" text for the Connectors screen group header. */
  coversShort: string;
  available: boolean;
};

/** Services shown on Connect and Connectors, in design order. Only Google is wired up today. */
export const SERVICES: ServiceInfo[] = [
  {
    provider: 'gmail',
    name: 'Google',
    covers: 'Gmail, Calendar, Drive · one sign-in each',
    coversShort: 'Gmail, Calendar, Drive',
    available: true,
  },
  {
    provider: 'microsoft',
    name: 'Microsoft 365',
    covers: 'Outlook, Teams, OneDrive',
    coversShort: 'Outlook, Teams, OneDrive',
    available: false,
  },
  {
    provider: 'slack',
    name: 'Slack',
    covers: 'One per workspace',
    coversShort: 'per workspace',
    available: false,
  },
  {
    provider: 'atlassian',
    name: 'Atlassian',
    covers: 'Jira, Confluence · per site',
    coversShort: 'Jira, Confluence',
    available: false,
  },
  {
    provider: 'notion',
    name: 'Notion',
    covers: 'Only pages you pick',
    coversShort: 'pages you picked',
    available: false,
  },
  {
    provider: 'github',
    name: 'GitHub',
    covers: 'Only repos you pick',
    coversShort: 'repos you picked',
    available: false,
  },
];

export const MAX_ACCOUNTS_PER_SERVICE = 4;

export function serviceName(p: Provider | string): string {
  return SERVICES.find((s) => s.provider === p)?.name ?? p;
}

/** Source tag text for an item or task, e.g. GMAIL, TEAMS, JIRA. */
export function sourceLabel(provider: string | null | undefined, kind?: string | null): string {
  switch (provider) {
    case 'gmail':
      return kind === 'event' ? 'CALENDAR' : kind === 'file' ? 'DRIVE' : 'GMAIL';
    case 'microsoft':
      return kind === 'chat'
        ? 'TEAMS'
        : kind === 'file'
          ? 'ONEDRIVE'
          : kind === 'event'
            ? 'CALENDAR'
            : 'OUTLOOK';
    case 'slack':
      return 'SLACK';
    case 'atlassian':
      return kind === 'note' ? 'CONFLUENCE' : 'JIRA';
    case 'notion':
      return 'NOTION';
    case 'github':
      return 'GITHUB';
    case null:
    case undefined:
      return kind ? kind.toUpperCase() : 'HUB';
    default:
      return provider.toUpperCase();
  }
}

/** "GMAIL · WORK" style tag for an item, using its account. */
export function itemTag(item: ItemT, account: AccountT | undefined, withAccount = true): string {
  const src = sourceLabel(account?.provider, item.kind);
  return withAccount && account ? `${src} · ${account.nickname.toUpperCase()}` : src;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function hhmm(d: Date): string {
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

export function hhmm2(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86_400_000);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "MON · 28 SEP" */
export function dateHeader(d = new Date()): string {
  return `${DAYS[d.getDay()]} · ${d.getDate()} ${MONTHS[d.getMonth()]}`.toUpperCase();
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 12) return 'Good morning.';
  if (h < 18) return 'Good afternoon.';
  return 'Good evening.';
}

/** Inbox timestamp: "8:12" today, "Yesterday", "Tue", or "12 Sep". */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diff = dayDiff(now, d);
  if (diff <= 0) return hhmm(d);
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return DAYS[d.getDay()] ?? '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "2m ago", "3h ago", "just now". */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

export function agoShort(iso: string | null | undefined, now = Date.now()): string {
  return ago(iso, now).replace(' min ago', 'm ago');
}

/** Due text for a task and whether it's overdue. */
export function dueText(
  dueAt: string | null,
  now = new Date(),
): { text: string | null; overdue: boolean } {
  if (!dueAt) return { text: null, overdue: false };
  const d = new Date(dueAt);
  const diff = dayDiff(d, now);
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  if (diff < 0)
    return { text: diff === -1 ? 'Due yesterday' : `Due ${-diff} days ago`, overdue: true };
  if (diff === 0)
    return {
      text: hasTime ? `Due ${hhmm(d)}` : 'Due today',
      overdue: hasTime && d.getTime() < now.getTime(),
    };
  if (diff === 1) return { text: hasTime ? `Tomorrow ${hhmm(d)}` : 'Tomorrow', overdue: false };
  if (diff < 7)
    return { text: `${DAYS[d.getDay()]}${hasTime ? ` ${hhmm(d)}` : ''}`, overdue: false };
  return { text: `${d.getDate()} ${MONTHS[d.getMonth()]}`, overdue: false };
}

export function dayLabel(d: Date, now = new Date()): string {
  const diff = dayDiff(d, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "claude-sonnet-5" → "SONNET 5", "claude-haiku-4-5" → "HAIKU 4.5", "gpt-4o" → "GPT-4O". */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.replace(/^(anthropic\.|us\.anthropic\.)/, '').replace(/-\d{8}.*$/, '');
  const claude = /^claude-([a-z]+)-(\d+(?:-\d+)*)/.exec(m);
  if (claude) return `${claude[1]!.toUpperCase()} ${claude[2]!.replace(/-/g, '.')}`;
  return m.toUpperCase();
}

const AGENT_NAMES: Record<string, string> = {
  triage: 'Triage agent',
  extractor: 'Extractor',
  brief: 'Brief agent',
  reply: 'Reply agent',
  planner: 'Planner',
};

export function agentName(agent: string): string {
  const key = agent.replace(/^agent:/, '');
  return AGENT_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** "REPLY AGENT · SONNET 5" */
export function agentModelLabel(agent: string, model: string | null): string {
  const a = agent.replace(/^agent:/, '');
  const name = a === 'planner' || a === 'extractor' ? a.toUpperCase() : `${a.toUpperCase()} AGENT`;
  const ml = modelLabel(model);
  return ml ? `${name} · ${ml}` : name;
}

export const LEVEL_LABEL: Record<PolicyLevelT, string> = {
  none: 'No access',
  read: 'Read',
  draft: 'Drafts',
  ask: 'Ask me',
  auto: 'Automatic',
  never: 'Never',
};

export function minutesLabel(min: number): string {
  if (min % 60 === 0) {
    const h = min / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return `${min} min`;
}

export function presetLabel(p: string): string {
  return p === 'hands' ? 'Hands-off' : p.charAt(0).toUpperCase() + p.slice(1);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Short time-column label for Today's "Next up": "11:00", "Today", "Tmrw", "Thu", "Late". */
export function slotLabel(dueAt: string | null, now = new Date()): string {
  if (!dueAt) return '—';
  const d = new Date(dueAt);
  const diff = dayDiff(d, now);
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  if (diff < 0) return 'Late';
  if (diff === 0) return hasTime ? hhmm2(d) : 'Today';
  if (diff === 1) return 'Tmrw';
  if (diff < 7) return DAYS[d.getDay()] ?? '';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
