import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { Provider } from '@hub/shared';
import { useServices } from '@/lib/hooks';
import {
  connectedMessage,
  noticeFromParams,
  useConnectAccount,
  useWriteAccess,
  type ConnectedNotice,
} from '@/lib/connect';
import { errorMessage, type AccountT, type ConnectorInfoT } from '@/lib/api';
import { coversShort, MAX_ACCOUNTS_PER_SERVICE, plural, writeAccessCopy } from '@/lib/format';
import { colors, HIT } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, Dot, Pill, Row, type PillTone } from '@/components/ui';
import {
  BackLink,
  EmptyState,
  ErrorState,
  LoadingState,
  Notice,
  Screen,
} from '@/components/layout';
import { Chevron } from '@/components/icons';

function statusPill(a: AccountT): { label: string; tone: PillTone; reconnect: boolean } {
  switch (a.status) {
    case 'live':
      return { label: 'Live', tone: 'teal', reconnect: false };
    case 'importing':
    case 'connecting':
      return { label: 'Importing', tone: 'grey', reconnect: false };
    case 'paused':
      return { label: 'Paused', tone: 'grey', reconnect: false };
    case 'reconnect':
    case 'disconnected':
      return { label: 'Reconnect', tone: 'amber', reconnect: true };
  }
}

type Msg = { text: string; tone: 'warn' | 'teal' };

export default function ConnectorsScreen() {
  const { catalog, accounts, groups } = useServices();
  const connect = useConnectAccount();
  const write = useWriteAccess();
  const params = useLocalSearchParams<ConnectedNotice>();
  const [busy, setBusy] = useState<string | null>(null);
  /** Accounts that got write access in this session (the hub may not report it). */
  const [granted, setGranted] = useState<Record<string, true>>({});
  const [msg, setMsg] = useState<Msg | null>(() => {
    const text = noticeFromParams(params);
    return text ? { text, tone: 'teal' } : null;
  });
  const list = accounts.data?.accounts ?? [];
  const services = new Set(list.map((a) => a.provider));

  const run = (provider: Provider, key: string) => {
    setMsg(null);
    setBusy(key);
    connect.mutate(provider, {
      onSuccess: (out) => {
        if (!out.ok) {
          if (out.message) setMsg({ text: out.message, tone: 'warn' });
          return;
        }
        const text = connectedMessage(out);
        if (text) setMsg({ text, tone: 'teal' });
      },
      onError: (e) => setMsg({ text: errorMessage(e), tone: 'warn' }),
      onSettled: () => setBusy(null),
    });
  };

  const allowWrite = (a: AccountT, noun: string) => {
    setMsg(null);
    setBusy(`write:${a.id}`);
    write.mutate(a.id, {
      onSuccess: (out) => {
        if (!out.ok) {
          if (out.message) setMsg({ text: out.message, tone: 'warn' });
          return;
        }
        setGranted((g) => ({ ...g, [a.id]: true }));
        setMsg({
          text:
            connectedMessage(
              { ...out, access: 'write', accounts: out.accounts.length ? out.accounts : [a] },
              noun,
            ) ?? `${noun} is on for ${a.nickname}.`,
          tone: 'teal',
        });
      },
      onError: (e) => setMsg({ text: errorMessage(e), tone: 'warn' }),
      onSettled: () => setBusy(null),
    });
  };

  const notSetUp = (name: string) =>
    setMsg({
      text: `${name} isn't set up on your hub yet. Add its client ID and secret to the hub's config (see .env.example), then restart it.`,
      tone: 'warn',
    });

  const loading = catalog.isPending || accounts.isPending;

  return (
    <Screen
      gap={12}
      onRefresh={() => {
        void accounts.refetch();
        void catalog.refetch();
      }}
      refreshing={accounts.isRefetching}
    >
      <BackLink />
      <View style={{ gap: 4 }}>
        <Title size={36} lh={1}>
          Connectors
        </Title>
        <Txt size={13} color={colors.secondary}>
          {accounts.isSuccess
            ? `${plural(list.length, 'account')} across ${plural(services.size, 'service')}`
            : ' '}
        </Txt>
      </View>
      {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
      {loading ? (
        <LoadingState />
      ) : accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : (
        <>
          {catalog.isError ? (
            <ErrorState
              title="Couldn't load your hub's services"
              error={catalog.error}
              onRetry={() => void catalog.refetch()}
            />
          ) : null}
          {list.length === 0 && catalog.isSuccess ? (
            <EmptyState
              title="No accounts yet"
              body={
                groups.some((g) => g.info.available)
                  ? 'Connect a service below to start.'
                  : 'Your hub has no services set up yet. Add a provider’s client ID and secret to its config.'
              }
            />
          ) : null}
          {groups.map(({ info, accounts: mine, known }) => (
            <ServiceGroup
              key={info.provider}
              info={info}
              known={known}
              accounts={mine}
              busy={busy}
              granted={granted}
              onAdd={() =>
                info.available ? run(info.provider, `add:${info.provider}`) : notSetUp(info.name)
              }
              onReconnect={(a) => run(a.provider, a.id)}
              onAllowWrite={allowWrite}
            />
          ))}
          <Button
            label="Refresh status"
            variant="outline"
            onPress={() => void accounts.refetch()}
            loading={accounts.isRefetching}
          />
        </>
      )}
    </Screen>
  );
}

function ServiceGroup({
  info,
  known,
  accounts,
  busy,
  granted,
  onAdd,
  onReconnect,
  onAllowWrite,
}: {
  info: ConnectorInfoT;
  known: boolean;
  accounts: AccountT[];
  busy: string | null;
  granted: Record<string, true>;
  onAdd: () => void;
  onReconnect: (a: AccountT) => void;
  onAllowWrite: (a: AccountT, noun: string) => void;
}) {
  const full = accounts.length >= MAX_ACCOUNTS_PER_SERVICE;
  const covers = coversShort(info.covers, info.multiAccountNote);
  const writeCopy = info.available ? writeAccessCopy(info.writeActions) : null;
  const adding = busy === `add:${info.provider}`;
  const openSettings = (a: AccountT) => () =>
    router.push({ pathname: '/account/[id]', params: { id: a.id } });
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Txt
          size={12}
          weight={600}
          color={colors.secondary}
          accessibilityRole="header"
          style={{ flexShrink: 1 }}
        >
          {info.name}
          {covers ? <Txt size={12} color={colors.secondary}>{` · ${covers}`}</Txt> : null}
        </Txt>
        {known ? (
          <Pressable
            onPress={full || adding ? undefined : onAdd}
            accessibilityRole="button"
            accessibilityLabel={
              info.available ? `Add ${info.name} account` : `${info.name}: not set up on your hub`
            }
            accessibilityState={{ disabled: full || adding }}
            style={{
              minHeight: HIT,
              minWidth: HIT,
              paddingHorizontal: 4,
              alignItems: 'flex-end',
              justifyContent: 'center',
            }}
          >
            <Txt
              size={info.available ? 13 : 12}
              weight={info.available ? 600 : 500}
              color={info.available && !full ? colors.teal : colors.secondary}
            >
              {adding
                ? 'Opening…'
                : !info.available
                  ? 'Not set up on your hub'
                  : full
                    ? `Max ${MAX_ACCOUNTS_PER_SERVICE}`
                    : '+ Add'}
            </Txt>
          </Pressable>
        ) : (
          <View style={{ minHeight: HIT }} />
        )}
      </View>
      {accounts.length ? (
        <Card>
          {accounts.map((a, i) => {
            const pill = statusPill(a);
            const hasWrite = a.writeAccess === true || !!granted[a.id];
            return (
              <Row key={a.id} first={i === 0}>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 4 }}>
                  <Pressable
                    onPress={openSettings(a)}
                    accessibilityRole="button"
                    accessibilityLabel={`${a.nickname}, ${a.externalId}, ${pill.label}. Open settings.`}
                    style={({ pressed }) => ({
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      minHeight: 46,
                      paddingLeft: 14,
                      paddingRight: 8,
                      backgroundColor: pressed ? '#FAF8F3' : undefined,
                    })}
                  >
                    <Dot color={a.color} />
                    <View style={{ flex: 1, gap: 1, paddingVertical: 6 }}>
                      <Txt size={15} weight={500}>
                        {a.nickname}
                      </Txt>
                      <Txt size={12} color={colors.secondary} numberOfLines={1}>
                        {a.externalId}
                      </Txt>
                    </View>
                    {pill.reconnect && known ? null : (
                      <View style={{ justifyContent: 'center' }}>
                        <Pill label={pill.label} tone={pill.tone} padH={9} padV={4} />
                      </View>
                    )}
                  </Pressable>
                  {pill.reconnect && known ? (
                    <Pressable
                      onPress={busy ? undefined : () => onReconnect(a)}
                      accessibilityRole="button"
                      accessibilityLabel={`Reconnect ${a.nickname}`}
                      style={{ minHeight: HIT, justifyContent: 'center' }}
                    >
                      <Pill
                        label={busy === a.id ? 'Opening…' : pill.label}
                        tone={pill.tone}
                        padH={9}
                        padV={4}
                      />
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={openSettings(a)}
                    accessibilityRole="button"
                    accessibilityLabel={`${a.nickname} settings`}
                    style={{
                      minHeight: HIT,
                      width: 32,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Chevron dir="right" size={16} />
                  </Pressable>
                </View>
                {writeCopy && !pill.reconnect ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      minHeight: HIT,
                      paddingLeft: 36,
                      paddingRight: 12,
                      paddingBottom: 6,
                    }}
                  >
                    <View style={{ flex: 1, gap: 1 }}>
                      <Txt size={13} weight={500} color={colors.body}>
                        {writeCopy.label}
                      </Txt>
                      <Txt size={11} color={colors.secondary}>
                        {hasWrite
                          ? 'Allowed. Each one still waits for you in Approvals.'
                          : 'Separate permission. Off until you allow it.'}
                      </Txt>
                    </View>
                    {hasWrite ? (
                      <View style={{ justifyContent: 'center' }}>
                        <Pill label="Allowed" tone="teal" padH={9} padV={4} />
                      </View>
                    ) : (
                      <Button
                        label="Allow"
                        variant="tealOutline"
                        size="sm"
                        radius={10}
                        textSize={13}
                        loading={busy === `write:${a.id}`}
                        disabled={!!busy && busy !== `write:${a.id}`}
                        accessibilityLabel={`${writeCopy.label} for ${a.nickname}`}
                        onPress={() => onAllowWrite(a, writeCopy.noun)}
                        style={{ paddingHorizontal: 14 }}
                      />
                    )}
                  </View>
                ) : null}
              </Row>
            );
          })}
        </Card>
      ) : null}
      {writeCopy && accounts.length ? (
        <Txt
          size={11}
          lh={1.45}
          color={colors.secondary}
          style={{ paddingTop: 6, paddingHorizontal: 2 }}
        >
          {`Reading and ${writeCopy.noun.toLowerCase()} are separate permissions. Allow asks ${info.name} again, just for that account. Hub only uses it to ${writeCopy.what} you approved.`}
        </Txt>
      ) : null}
    </View>
  );
}
