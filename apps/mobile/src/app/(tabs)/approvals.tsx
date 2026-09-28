import { useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  PROPOSAL_PAYLOADS,
  type EmailSendPayload,
  type JiraCommentPayload,
  type JiraTransitionPayload,
  type SlackPostPayload,
} from '@hub/shared';
import { useAccessRequests, useDecideAccess, useDecideProposal, useProposals } from '@/lib/queries';
import { useAccountMap } from '@/lib/hooks';
import {
  agentModelLabel,
  agentName,
  hhmm2,
  minutesLabel,
  serviceName,
  shortTime,
  sourceLabel,
} from '@/lib/format';
import { ApiError, errorMessage, type AccessRequestT, type ProposalT } from '@/lib/api';
import { colors, fonts } from '@/theme';
import { Label, Title, Txt } from '@/components/Txt';
import { Button, Card, Field, SourceTag } from '@/components/ui';
import { EmptyState, ErrorState, LoadingState, Notice, Screen, Sheet } from '@/components/layout';

type Decided = { message: string; tone: 'teal' | 'amber' };

type Action = ProposalT['action'];
const SENDS = new Set<Action>(['gmail.send', 'outlook.send', 'slack.post']);

function actionSource(p: ProposalT, provider: string | undefined): string {
  switch (p.action) {
    case 'gmail.send':
    case 'gmail.label':
      return 'GMAIL';
    case 'outlook.send':
      return 'OUTLOOK';
    case 'slack.post':
      return 'SLACK';
    case 'jira.transition':
    case 'jira.comment':
      return 'JIRA';
    default:
      return sourceLabel(provider);
  }
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ');
  return JSON.stringify(v);
}

/**
 * The payload parsed with the same schema the API and executor use. `null` when it doesn't
 * match, so the card falls back to showing every field as-is.
 */
type Typed =
  | { action: 'gmail.send' | 'outlook.send'; data: EmailSendPayload }
  | { action: 'slack.post'; data: SlackPostPayload }
  | { action: 'jira.transition'; data: JiraTransitionPayload }
  | { action: 'jira.comment'; data: JiraCommentPayload };

function typed(action: Action, payload: Record<string, unknown>): Typed | null {
  switch (action) {
    case 'gmail.send':
    case 'outlook.send': {
      const r = PROPOSAL_PAYLOADS[action].safeParse(payload);
      return r.success ? { action, data: r.data } : null;
    }
    case 'slack.post': {
      const r = PROPOSAL_PAYLOADS[action].safeParse(payload);
      return r.success ? { action, data: r.data } : null;
    }
    case 'jira.transition': {
      const r = PROPOSAL_PAYLOADS[action].safeParse(payload);
      return r.success ? { action, data: r.data } : null;
    }
    case 'jira.comment': {
      const r = PROPOSAL_PAYLOADS[action].safeParse(payload);
      return r.success ? { action, data: r.data } : null;
    }
    default:
      return null;
  }
}

/** Slack conversation id as the user can recognise it. The id itself is what gets used. */
function slackChannel(ch: string): string {
  if (/^D[A-Z0-9]{6,}$/.test(ch)) return `Direct message · ${ch}`;
  if (/^[CG][A-Z0-9]{6,}$/.test(ch)) return ch;
  return ch.startsWith('#') ? ch : `#${ch}`;
}

function slackThread(ts: string | undefined): string | null {
  if (!ts) return null;
  const secs = Number(ts);
  return Number.isFinite(secs) && secs > 0
    ? `In thread from ${shortTime(new Date(secs * 1000).toISOString())}`
    : 'In thread';
}

/** Card heading. Ticket changes are described from the payload itself, not the agent's title. */
function heading(p: ProposalT, t: Typed | null): string {
  if (t?.action === 'jira.transition') return `Move ${t.data.issueKey} to ${t.data.toStatus}`;
  if (t?.action === 'jira.comment') return `Comment on ${t.data.issueKey}`;
  return p.title;
}

function recipients(to: string[]): string {
  return to.length
    ? `${to[0]}${to.length > 1 ? ` and ${to.length - 1} more` : ''}`
    : 'the recipients';
}

function approvedMessage(p: ProposalT, payload: Record<string, unknown>): string {
  const t = typed(p.action, payload);
  switch (t?.action) {
    case 'gmail.send':
    case 'outlook.send':
      return `Approved. Sending to ${recipients(t.data.to)}. Logged in Activity.`;
    case 'slack.post':
      return `Approved. Posting to ${slackChannel(t.data.channel)}. Logged in Activity.`;
    case 'jira.transition':
      return `Approved. Moving ${t.data.issueKey} to ${t.data.toStatus}. Logged in Activity.`;
    case 'jira.comment':
      return `Approved. Commenting on ${t.data.issueKey}. Logged in Activity.`;
    default:
      return 'Approved. Logged in Activity.';
  }
}

/** Digits in a pairing code; matches apps/mcp's consent page. */
const PAIRING_DIGITS = 6;

/**
 * What to tell the user when allowing an `mcp_connect` fails. `final` errors end the
 * request (show them as the card's outcome); the others keep the code input open.
 */
function connectError(e: unknown): { message: string; final: boolean } | null {
  if (!(e instanceof ApiError)) return null;
  switch (e.code) {
    case 'wrong_pairing_code': {
      const left = /(\d+) attempts? left/.exec(e.message)?.[1];
      return {
        message: `That code doesn't match the one on your computer.${left ? ` ${left} ${left === '1' ? 'try' : 'tries'} left.` : ''}`,
        final: false,
      };
    }
    case 'pairing_code_required':
      return { message: 'Enter the code shown on your computer first.', final: false };
    case 'pairing_locked':
      return {
        message: 'Denied after too many wrong codes. If it was you, start again on your computer.',
        final: true,
      };
    case 'expired':
      return {
        message: 'This request expired. Start the connection again on your computer.',
        final: true,
      };
    default:
      return null;
  }
}

function rejectedMessage(p: ProposalT): string {
  if (SENDS.has(p.action) || p.action === 'jira.comment') return 'Rejected. Draft discarded.';
  if (p.action.startsWith('jira.')) return 'Rejected. Jira unchanged.';
  return 'Rejected. Nothing was changed.';
}

export default function ApprovalsScreen() {
  const proposals = useProposals();
  const requests = useAccessRequests();
  const decideP = useDecideProposal();
  const decideA = useDecideAccess();
  const accounts = useAccountMap();
  // Keep decided cards on screen (with their outcome) even after the pending list refetches.
  const [snap, setSnap] = useState<Record<string, ProposalT | AccessRequestT>>({});
  const [decided, setDecided] = useState<Record<string, Decided>>({});
  const [editing, setEditing] = useState<ProposalT | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Inline errors on connect cards (wrong pairing code), by request id. */
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const setCardError = (id: string, message: string | null) =>
    setCardErrors((s) => {
      const { [id]: _drop, ...rest } = s;
      return message ? { ...rest, [id]: message } : rest;
    });

  const mark = (item: ProposalT | AccessRequestT, d: Decided) => {
    setSnap((s) => ({ ...s, [item.id]: item }));
    setDecided((s) => ({ ...s, [item.id]: d }));
  };
  const unmark = (id: string) =>
    setDecided((s) => {
      const { [id]: _drop, ...rest } = s;
      return rest;
    });

  const decideProposal = (
    p: ProposalT,
    decision: 'approve' | 'reject',
    payload?: Record<string, unknown>,
  ) => {
    setError(null);
    mark(
      p,
      decision === 'approve'
        ? { message: approvedMessage(p, payload ?? p.payload), tone: 'teal' }
        : { message: rejectedMessage(p), tone: 'teal' },
    );
    decideP.mutate(
      { id: p.id, decision, payload },
      {
        onError: (e) => {
          if (e instanceof ApiError && e.status === 409) {
            // Someone (another device) already decided it; show that instead of rolling back.
            setDecided((s) => ({ ...s, [p.id]: { message: errorMessage(e), tone: 'teal' } }));
            return;
          }
          unmark(p.id);
          setError(errorMessage(e));
        },
      },
    );
  };

  const decideAccess = (r: AccessRequestT, decision: 'allow' | 'deny', pairingCode?: string) => {
    setError(null);
    setCardError(r.id, null);
    const who = r.clientName ?? agentName(r.principal.replace(/^mcp:/, ''));
    mark(r, {
      message: decision === 'allow' ? 'Allowing…' : `Denied. ${who} was told no.`,
      tone: 'amber',
    });
    decideA.mutate(
      { id: r.id, decision, durationMinutes: r.durationMinutes ?? 60, pairingCode },
      {
        onSuccess: (res) => {
          if (decision !== 'allow') return;
          const message = res.grant
            ? `Allowed until ${hhmm2(new Date(res.grant.expiresAt))}. Revoke anytime in Permissions.`
            : r.kind === 'mcp_connect'
              ? `${who} is connected. Manage it in Connected agents.`
              : 'Allowed. Revoke anytime in Permissions.';
          setDecided((s) => ({ ...s, [r.id]: { message, tone: 'amber' } }));
        },
        onError: (e) => {
          const ce = r.kind === 'mcp_connect' && decision === 'allow' ? connectError(e) : null;
          if (ce?.final) {
            setDecided((s) => ({ ...s, [r.id]: { message: ce.message, tone: 'amber' } }));
            return;
          }
          if (ce) {
            // Wrong or missing code: keep the card open so they can check and retype it.
            unmark(r.id);
            setCardError(r.id, ce.message);
            return;
          }
          if (e instanceof ApiError && e.status === 409) {
            setDecided((s) => ({ ...s, [r.id]: { message: errorMessage(e), tone: 'amber' } }));
            return;
          }
          unmark(r.id);
          setError(errorMessage(e));
        },
      },
    );
  };

  const cards = useMemo(() => {
    const live: (ProposalT | AccessRequestT)[] = [
      ...(proposals.data?.proposals ?? []),
      ...(requests.data?.requests ?? []),
    ];
    const ids = new Set(live.map((x) => x.id));
    const kept = Object.keys(decided)
      .filter((id) => !ids.has(id) && snap[id])
      .map((id) => snap[id]!);
    return [...live, ...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [proposals.data, requests.data, decided, snap]);

  const pendingCount = cards.filter((c) => !decided[c.id]).length;
  const loading = proposals.isPending || requests.isPending;
  const failed = proposals.isError ? proposals.error : requests.isError ? requests.error : null;

  return (
    <Screen
      padTop={28}
      gap={14}
      bottomInset={false}
      onRefresh={() => {
        void proposals.refetch();
        void requests.refetch();
      }}
      refreshing={proposals.isRefetching || requests.isRefetching}
    >
      <View style={{ gap: 4 }}>
        <Title size={40} lh={1}>
          Approvals
        </Title>
        <Txt size={13} color={colors.secondary}>
          Nothing leaves without you.
        </Txt>
      </View>
      {error ? <Notice text={error} /> : null}
      {loading ? (
        <LoadingState />
      ) : failed ? (
        <ErrorState
          error={failed}
          onRetry={() => {
            void proposals.refetch();
            void requests.refetch();
          }}
        />
      ) : cards.length === 0 ? (
        <EmptyState
          title="Nothing to approve"
          body="Drafts, ticket changes and access requests from agents will wait here for your tap."
        />
      ) : (
        <>
          {cards.map((c) =>
            'action' in c ? (
              <ProposalCard
                key={c.id}
                p={c}
                source={actionSource(c, accounts.get(c.accountId)?.provider)}
                decided={decided[c.id]}
                onApprove={() => decideProposal(c, 'approve')}
                onEdit={() => setEditing(c)}
                onReject={() => decideProposal(c, 'reject')}
              />
            ) : (
              <AccessCard
                key={c.id}
                r={c}
                decided={decided[c.id]}
                error={cardErrors[c.id]}
                onAllow={(code) => decideAccess(c, 'allow', code)}
                onDeny={() => decideAccess(c, 'deny')}
              />
            ),
          )}
          {pendingCount === 0 ? (
            <Txt size={13} color={colors.secondary} align="center">
              All caught up.
            </Txt>
          ) : null}
        </>
      )}
      <EditSheet
        proposal={editing}
        onClose={() => setEditing(null)}
        onApprove={(payload) => {
          const p = editing!;
          setEditing(null);
          decideProposal(p, 'approve', payload);
        }}
      />
    </Screen>
  );
}

function Outcome({ d }: { d: Decided }) {
  return (
    <View style={{ minHeight: 44, justifyContent: 'center' }} accessibilityLiveRegion="polite">
      <Txt size={14} weight={600} color={d.tone === 'amber' ? colors.amberDark : colors.tealDark}>
        {d.message}
      </Txt>
    </View>
  );
}

function Meta({ rows }: { rows: [string, string][] }) {
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return (
    <View style={{ gap: 2 }}>
      {shown.map(([k, v]) => (
        <Txt key={k} size={12} color={colors.secondary} numberOfLines={2} selectable>
          <Txt size={12} weight={600} color={colors.secondary}>{`${k}: `}</Txt>
          {v}
        </Txt>
      ))}
    </View>
  );
}

function BodyBox({ text, empty = '(empty message)' }: { text: string; empty?: string }) {
  return (
    <View
      style={{
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: colors.bg,
      }}
    >
      <Txt size={13} lh={1.45} color={colors.body} selectable>
        {text || empty}
      </Txt>
    </View>
  );
}

/** Shows exactly what will be sent or changed. */
function PayloadView({ p }: { p: ProposalT }) {
  const t = typed(p.action, p.payload);
  switch (t?.action) {
    case 'gmail.send':
    case 'outlook.send':
      return (
        <View style={{ gap: 8 }}>
          <Meta
            rows={[
              ['To', t.data.to.join(', ')],
              ['Cc', t.data.cc.join(', ')],
              ['Subject', t.data.subject],
            ]}
          />
          <BodyBox text={t.data.body} />
        </View>
      );
    case 'slack.post':
      return (
        <View style={{ gap: 8 }}>
          <Meta
            rows={[
              ['Channel', slackChannel(t.data.channel)],
              ['Thread', slackThread(t.data.threadTs) ?? ''],
            ]}
          />
          <BodyBox text={t.data.text} />
        </View>
      );
    case 'jira.transition':
      return (
        <Txt size={13} lh={1.45} color={colors.body} selectable>
          {t.data.comment ? `Also adds a comment: "${t.data.comment}"` : 'No comment added.'}
        </Txt>
      );
    case 'jira.comment':
      return <BodyBox text={t.data.body} empty="(empty comment)" />;
    default:
      return <RawPayload p={p} />;
  }
}

/** Any other action, or a payload that doesn't match its schema: every field, as-is. */
function RawPayload({ p }: { p: ProposalT }) {
  const entries = Object.entries(p.payload);
  const known = p.action in PROPOSAL_PAYLOADS;
  return (
    <View style={{ gap: 8 }}>
      {known ? (
        <Txt size={12} weight={600} color={colors.amberDark}>
          {"This draft doesn't match what your hub expects, so approving it may fail."}
        </Txt>
      ) : null}
      <View
        style={{
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 10,
          backgroundColor: colors.bg,
          gap: 4,
        }}
      >
        {entries.length === 0 ? (
          <Txt size={13} color={colors.body}>
            No details.
          </Txt>
        ) : (
          entries.map(([k, v]) => (
            <Txt key={k} size={13} lh={1.45} color={colors.body} selectable>
              <Txt size={13} weight={600} color={colors.body}>{`${k}: `}</Txt>
              {str(v)}
            </Txt>
          ))
        )}
      </View>
    </View>
  );
}

/**
 * Text fields the user may rewrite before approving. Recipients, channels, threads, issue
 * keys and transitions are never editable: they come from the stored item, not a model.
 */
const EDITABLE: Partial<
  Record<Action, { key: string; label: string; long: boolean; required?: boolean }[]>
> = {
  'gmail.send': [
    { key: 'subject', label: 'Subject', long: false },
    { key: 'body', label: 'Message', long: true },
  ],
  'outlook.send': [
    { key: 'subject', label: 'Subject', long: false },
    { key: 'body', label: 'Message', long: true },
  ],
  'slack.post': [{ key: 'text', label: 'Message', long: true, required: true }],
  'jira.transition': [{ key: 'comment', label: 'Comment (optional)', long: true }],
  'jira.comment': [{ key: 'body', label: 'Comment', long: true, required: true }],
};

function canEdit(p: ProposalT): boolean {
  return !!EDITABLE[p.action]?.length && typed(p.action, p.payload) !== null;
}

function ProposalCard({
  p,
  source,
  decided,
  onApprove,
  onEdit,
  onReject,
}: {
  p: ProposalT;
  source: string;
  decided?: Decided;
  onApprove: () => void;
  onEdit: () => void;
  onReject: () => void;
}) {
  return (
    <Card radius={16} style={{ padding: 16, gap: 10 }}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Label size={10} em={0.06} style={{ flexShrink: 1 }} numberOfLines={1}>
          {agentModelLabel(p.agent, p.model)}
        </Label>
        <SourceTag label={source} />
      </View>
      <Txt size={16} weight={600} accessibilityRole="header">
        {heading(p, typed(p.action, p.payload))}
      </Txt>
      <PayloadView p={p} />
      {decided ? (
        <Outcome d={decided} />
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={SENDS.has(p.action) ? 'Approve & send' : 'Approve'}
            variant="teal"
            grow
            onPress={onApprove}
          />
          {canEdit(p) ? (
            <Button label="Edit" variant="outline" weight={400} onPress={onEdit} />
          ) : null}
          <Button
            label="Reject"
            variant="ghost"
            weight={400}
            onPress={onReject}
            style={{ paddingHorizontal: 12 }}
          />
        </View>
      )}
    </Card>
  );
}

function AccessCard({
  r,
  decided,
  error,
  onAllow,
  onDeny,
}: {
  r: AccessRequestT;
  decided?: Decided;
  /** Inline error, e.g. a wrong pairing code. */
  error?: string;
  /** For `mcp_connect`, called with the pairing code the user typed (digits only). */
  onAllow: (pairingCode?: string) => void;
  onDeny: () => void;
}) {
  const [code, setCode] = useState('');
  const who = r.clientName ?? agentName(r.principal.replace(/^mcp:/, ''));
  const minutes = r.durationMinutes ?? 60;
  const target = r.provider
    ? serviceName(r.provider)
    : r.resource.charAt(0).toUpperCase() + r.resource.slice(1);
  const verb = r.level === 'read' ? 'Read' : r.level === 'draft' ? 'Draft in' : 'Act on';
  const connect = r.kind === 'mcp_connect';
  const digits = code.replace(/\D/g, '');
  const codeReady = digits.length === PAIRING_DIGITS;
  return (
    <Card tone="warn" radius={16} style={{ padding: 16, gap: 10 }}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Label size={10} em={0.06} color={colors.amberDark}>
          {connect ? 'NEW CONNECTION' : 'PERMISSION REQUEST'}
        </Label>
        <View style={{ flexDirection: 'row', gap: 6, flexShrink: 1 }}>
          {connect && !r.clientNameVerified ? (
            <SourceTag label="UNVERIFIED NAME" tone="warn" />
          ) : null}
          <SourceTag label={who.toUpperCase()} tone="warn" />
        </View>
      </View>
      <Txt size={16} weight={600} accessibilityRole="header">
        {connect
          ? `${who} wants to connect${r.redirectHost ? ` · redirects to ${r.redirectHost}` : ''}`
          : `${verb} ${target} for ${minutesLabel(minutes)}`}
      </Txt>
      {connect ? (
        <View style={{ gap: 6 }}>
          {/* The client name is self-reported; the redirect host is where access actually goes. */}
          <View
            style={{
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderRadius: 10,
              backgroundColor: colors.warnTag,
              gap: 2,
            }}
          >
            <Txt size={11} weight={600} color={colors.amberDark}>
              Access goes to
            </Txt>
            <Txt mono size={12} color={colors.amberDark} selectable>
              {r.redirectHost ?? 'Unknown host'}
            </Txt>
          </View>
          <Txt size={13} lh={1.45} color={colors.body}>
            {r.clientNameVerified
              ? 'Only allow it if you started this connection and recognise the host. It gets what you allow in Permissions, and you can disconnect it anytime.'
              : `"${who}" is the name the app gave itself, not a verified name. Only allow it if you started this connection and recognise the host. It gets what you allow in Permissions, and you can disconnect it anytime.`}
          </Txt>
          {decided ? null : (
            <View style={{ gap: 6, marginTop: 4 }}>
              <Field
                label="Enter the code shown on your computer"
                value={code}
                onChangeText={(v) => setCode(v.replace(/[^\d ]/g, '').slice(0, PAIRING_DIGITS + 1))}
                placeholder="123 456"
                keyboardType="number-pad"
                inputMode="numeric"
                autoComplete="off"
                maxLength={PAIRING_DIGITS + 1}
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (codeReady) onAllow(digits);
                }}
                style={{ fontFamily: fonts.mono, fontSize: 20, letterSpacing: 4 }}
              />
              {error ? (
                <Txt
                  size={13}
                  weight={600}
                  color={colors.amberDark}
                  accessibilityLiveRegion="polite"
                >
                  {error}
                </Txt>
              ) : (
                <Txt size={12} color={colors.secondary}>
                  {"No code on your screen? You didn't start this. Deny it."}
                </Txt>
              )}
            </View>
          )}
        </View>
      ) : (
        <Txt size={13} lh={1.45} color={colors.body}>
          {`${r.reason ? `Reason given: ${r.reason.replace(/\.$/, '')}.` : 'No reason given.'} Access ends automatically.`}
        </Txt>
      )}
      {decided ? (
        <Outcome d={decided} />
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={connect ? 'Allow' : `Allow for ${minutesLabel(minutes)}`}
            grow
            disabled={connect && !codeReady}
            onPress={() => (connect ? onAllow(digits) : onAllow())}
          />
          <Button
            label="Deny"
            variant="warnOutline"
            weight={400}
            onPress={onDeny}
            style={{ backgroundColor: 'transparent', paddingHorizontal: 18 }}
          />
        </View>
      )}
    </Card>
  );
}

function EditSheet({
  proposal,
  onClose,
  onApprove,
}: {
  proposal: ProposalT | null;
  onClose: () => void;
  onApprove: (payload: Record<string, unknown>) => void;
}) {
  const sends = proposal ? SENDS.has(proposal.action) : false;
  return (
    <Sheet
      visible={!!proposal}
      onClose={onClose}
      title={sends ? 'Edit before sending' : 'Edit before approving'}
    >
      {proposal ? <EditForm key={proposal.id} p={proposal} onApprove={onApprove} /> : null}
    </Sheet>
  );
}

function EditForm({
  p,
  onApprove,
}: {
  p: ProposalT;
  onApprove: (payload: Record<string, unknown>) => void;
}) {
  const fields = EDITABLE[p.action] ?? [];
  const t = typed(p.action, p.payload);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, str(p.payload[f.key])])),
  );
  const [invalid, setInvalid] = useState<string | null>(null);

  // What stays exactly as proposed, shown read-only above the editable text.
  const fixed: [string, string][] =
    t?.action === 'gmail.send' || t?.action === 'outlook.send'
      ? [
          ['To', t.data.to.join(', ')],
          ['Cc', t.data.cc.join(', ')],
        ]
      : t?.action === 'slack.post'
        ? [
            ['Channel', slackChannel(t.data.channel)],
            ['Thread', slackThread(t.data.threadTs) ?? ''],
          ]
        : t?.action === 'jira.transition'
          ? [
              ['Issue', t.data.issueKey],
              ['Moves to', t.data.toStatus],
            ]
          : t?.action === 'jira.comment'
            ? [['Issue', t.data.issueKey]]
            : [];

  const missing = fields.some((f) => f.required && !(values[f.key] ?? '').trim());

  const approve = () => {
    const next: Record<string, unknown> = { ...p.payload };
    for (const f of fields) {
      const v = values[f.key] ?? '';
      // An empty optional comment means "no comment", not an empty one.
      if (!f.required && f.key === 'comment' && !v.trim()) delete next[f.key];
      else next[f.key] = v;
    }
    const schema = (
      PROPOSAL_PAYLOADS as Record<string, { safeParse(d: unknown): { success: boolean } }>
    )[p.action];
    if (schema && !schema.safeParse(next).success) {
      setInvalid(
        p.action === 'slack.post'
          ? 'Slack messages must be 1 to 4,000 characters.'
          : "That text can't be sent as it is. Check its length and try again.",
      );
      return;
    }
    onApprove(next);
  };

  return (
    <View style={{ gap: 12 }}>
      <Meta rows={fixed} />
      {fields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          value={values[f.key] ?? ''}
          onChangeText={(v) => {
            setInvalid(null);
            setValues((s) => ({ ...s, [f.key]: v }));
          }}
          multiline={f.long}
          autoCorrect
          style={f.long ? { minHeight: 160, paddingTop: 10, textAlignVertical: 'top' } : undefined}
        />
      ))}
      {fields.length === 0 ? (
        <Txt size={13} color={colors.secondary}>
          This action has no text to edit.
        </Txt>
      ) : null}
      {invalid ? <Notice text={invalid} /> : null}
      <Button
        label={SENDS.has(p.action) ? 'Approve & send' : 'Approve'}
        variant="teal"
        size="lg"
        disabled={missing}
        onPress={approve}
      />
    </View>
  );
}
