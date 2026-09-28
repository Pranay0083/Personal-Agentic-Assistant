import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMeRequired } from '@/lib/auth';
import { qk, usePermissions, useSetPolicy, useUpdateMe } from '@/lib/queries';
import { useAccountMap, useNow } from '@/lib/hooks';
import { LEVEL_LABEL, presetLabel } from '@/lib/format';
import { api, errorMessage, type GrantT, type PermissionRowT, type PermissionsT } from '@/lib/api';
import type { PolicyLevelT } from '@/lib/types';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import {
  Button,
  Card,
  Chip,
  Pill,
  Row,
  SectionTitle,
  Segmented,
  type PillTone,
} from '@/components/ui';
import {
  BackLink,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  Screen,
} from '@/components/layout';

const DATA_CYCLE: PolicyLevelT[] = ['none', 'read'];
const ACTION_CYCLE: PolicyLevelT[] = ['never', 'ask', 'auto'];

const LEVEL_TONE: Record<PolicyLevelT, PillTone> = {
  none: 'grey',
  read: 'teal',
  draft: 'teal',
  ask: 'amber',
  auto: 'solid',
  never: 'grey',
};

const RESOURCE_NAME: Record<string, string> = {
  email: 'Email',
  chat: 'Chat',
  tickets: 'Tickets',
  notes: 'Notes',
  calendar: 'Calendar',
  files: 'Files',
  code: 'Code',
  'task.create': 'Create tasks',
  'draft.write': 'Write drafts',
  'message.send': 'Send messages',
  'ticket.update': 'Update tickets',
  'email.label': 'Label email',
};

function nextLevel(level: PolicyLevelT, cycle: PolicyLevelT[]): PolicyLevelT {
  const i = cycle.indexOf(level);
  return cycle[(i + 1) % cycle.length]!;
}

type Preset = 'cautious' | 'balanced' | 'hands';

export default function PermissionsScreen() {
  const me = useMeRequired();
  const qc = useQueryClient();
  const [principal, setPrincipal] = useState<string | undefined>(undefined);
  const perms = usePermissions(principal);
  const setPolicy = useSetPolicy(principal);
  const updateMe = useUpdateMe();
  const accounts = useAccountMap();
  const now = useNow(15_000);
  const [error, setError] = useState<string | null>(null);

  const key = qk.permissions(principal);
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeGrant(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PermissionsT>(key);
      if (prev)
        qc.setQueryData<PermissionsT>(key, {
          ...prev,
          grants: prev.grants.filter((g) => g.id !== id),
        });
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      setError(errorMessage(e));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.permissionsAll });
      void qc.invalidateQueries({ queryKey: qk.control });
    },
  });

  const data = perms.data;
  const current = principal ?? data?.principal;
  const whoLabel = data?.principals.find((p) => p.key === current)?.label ?? 'this agent';

  const cycle = (row: PermissionRowT, order: PolicyLevelT[]) => {
    if (!current) return;
    setError(null);
    setPolicy.mutate(
      {
        principal: current,
        provider: row.provider,
        accountId: row.accountId,
        resource: row.resource,
        level: nextLevel(row.level, order),
      },
      { onError: (e) => setError(errorMessage(e)) },
    );
  };

  const grantLabel = (g: GrantT) => {
    const acct = g.accountId ? accounts.get(g.accountId) : undefined;
    const res = RESOURCE_NAME[g.resource] ?? g.resource;
    return `Temporary: ${res} ${LEVEL_LABEL[g.level].toLowerCase()}${acct ? ` · ${acct.nickname}` : ''}`;
  };
  const expiresIn = (g: GrantT) => {
    const min = Math.max(0, Math.ceil((new Date(g.expiresAt).getTime() - now) / 60_000));
    if (min <= 0) return 'Expiring now';
    if (min < 60) return `Expires in ${min} min`;
    const h = Math.floor(min / 60);
    return `Expires in ${h}h ${min % 60}m`;
  };

  const renderRows = (rows: PermissionRowT[], order: PolicyLevelT[]) =>
    rows.map((r, i) => (
      <Row
        key={`${r.resource}:${r.provider ?? ''}:${r.accountId ?? ''}`}
        first={i === 0}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 52,
          paddingVertical: 2,
          paddingLeft: 14,
          paddingRight: 10,
        }}
      >
        <View style={{ flex: 1, gap: 2, paddingVertical: 6 }}>
          <Txt size={15} weight={500}>
            {r.label}
          </Txt>
          <Txt size={12} color={colors.secondary}>
            {r.source === 'grant' ? `${r.scope} · temporary` : r.scope}
          </Txt>
        </View>
        <Pressable
          onPress={() => cycle(r, order)}
          accessibilityRole="button"
          accessibilityLabel={`${r.label}: ${LEVEL_LABEL[r.level]}. Tap to change.`}
          disabled={r.source === 'grant'}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Pill
            label={LEVEL_LABEL[r.level]}
            tone={LEVEL_TONE[r.level]}
            size={12}
            padH={11}
            padV={5}
          />
        </Pressable>
      </Row>
    ));

  return (
    <Screen
      padTop={16}
      gap={14}
      onRefresh={() => void perms.refetch()}
      refreshing={perms.isRefetching}
    >
      <BackLink />
      <Title size={36} lh={1}>
        Permissions
      </Title>
      <Segmented<Preset>
        value={me.preset}
        onChange={(preset) =>
          updateMe.mutate({ preset }, { onError: (e) => setError(errorMessage(e)) })
        }
        options={(['cautious', 'balanced', 'hands'] as const).map((p) => ({
          value: p,
          label: presetLabel(p),
        }))}
      />
      {data ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}
          style={{ marginHorizontal: -20, flexGrow: 0 }}
        >
          {data.principals.map((p) => (
            <Chip
              key={p.key}
              label={p.label}
              on={p.key === current}
              onPress={() => setPrincipal(p.key)}
              minHeight={44}
            />
          ))}
        </ScrollView>
      ) : null}
      {error ? <Notice text={error} /> : null}

      {perms.isPending ? (
        <LoadingState />
      ) : perms.isError ? (
        <ErrorState error={perms.error} onRetry={() => void perms.refetch()} />
      ) : (
        <>
          {data!.grants.map((g) => (
            <Card
              key={g.id}
              tone="warn"
              radius={12}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 10,
                paddingLeft: 14,
                paddingRight: 12,
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Txt size={14} weight={600} color={colors.amberDark}>
                  {grantLabel(g)}
                </Txt>
                <Txt size={12} color={colors.warnBody}>
                  {expiresIn(g)}
                </Txt>
              </View>
              <Button
                label="Revoke"
                variant="warnOutline"
                radius={10}
                textSize={13}
                onPress={() => revoke.mutate(g.id)}
              />
            </Card>
          ))}

          <View style={{ gap: 6 }}>
            <SectionTitle>{`What ${whoLabel} can see`}</SectionTitle>
            {data!.data.length ? (
              <Card>{renderRows(data!.data, DATA_CYCLE)}</Card>
            ) : (
              <EmptyState
                title="No data sources yet"
                body="Connect an account to set what this agent can read."
              />
            )}
          </View>
          {data!.actions.length ? (
            <View style={{ gap: 6 }}>
              <SectionTitle>{`What ${whoLabel} can do`}</SectionTitle>
              <Card>{renderRows(data!.actions, ACTION_CYCLE)}</Card>
            </View>
          ) : null}
          <Txt size={12} lh={1.45} color={colors.secondary}>
            Tap a level to change it. Rules are enforced on your server, not in the app.
          </Txt>
        </>
      )}
    </Screen>
  );
}
