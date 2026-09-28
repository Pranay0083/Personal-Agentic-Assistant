import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { Provider } from '@hub/shared';
import { useAccounts } from '@/lib/queries';
import { useConnectAccount } from '@/lib/connect';
import { errorMessage, type AccountT } from '@/lib/api';
import { MAX_ACCOUNTS_PER_SERVICE, plural, SERVICES } from '@/lib/format';
import { colors } from '@/theme';
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

export default function ConnectorsScreen() {
  const accounts = useAccounts();
  const connect = useConnectAccount();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = accounts.data?.accounts ?? [];
  const services = new Set(list.map((a) => a.provider));

  const run = (provider: Provider, key: string, available: boolean) => {
    setNotice(null);
    if (!available) {
      setNotice(
        `${SERVICES.find((s) => s.provider === provider)?.name} is coming soon. Google works today.`,
      );
      return;
    }
    setBusy(key);
    connect.mutate(provider, {
      onSuccess: (out) => {
        if (!out.ok && out.message) setNotice(out.message);
      },
      onError: (e) => setNotice(errorMessage(e)),
      onSettled: () => setBusy(null),
    });
  };

  return (
    <Screen gap={12} onRefresh={() => void accounts.refetch()} refreshing={accounts.isRefetching}>
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
      {notice ? <Notice text={notice} /> : null}
      {accounts.isPending ? (
        <LoadingState />
      ) : accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : (
        <>
          {list.length === 0 ? (
            <EmptyState
              title="No accounts yet"
              body="Connect Google to start. More services are on the way."
            />
          ) : null}
          {SERVICES.map((s) => {
            const mine = list.filter((a) => a.provider === s.provider);
            const full = mine.length >= MAX_ACCOUNTS_PER_SERVICE;
            return (
              <View key={s.provider}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Txt size={12} weight={600} color={colors.secondary} accessibilityRole="header">
                    {s.name}
                    <Txt size={12} color={colors.secondary}>{` · ${s.coversShort}`}</Txt>
                  </Txt>
                  <Pressable
                    onPress={() =>
                      full ? undefined : run(s.provider, `add:${s.provider}`, s.available)
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${s.name} account`}
                    style={{
                      minHeight: 44,
                      minWidth: 44,
                      paddingHorizontal: 4,
                      alignItems: 'flex-end',
                      justifyContent: 'center',
                    }}
                  >
                    <Txt
                      size={13}
                      weight={600}
                      color={s.available && !full ? colors.teal : colors.secondary}
                    >
                      {busy === `add:${s.provider}`
                        ? 'Opening…'
                        : full
                          ? 'Max 4'
                          : s.available
                            ? '+ Add'
                            : 'Coming soon'}
                    </Txt>
                  </Pressable>
                </View>
                {mine.length ? (
                  <Card>
                    {mine.map((a, i) => {
                      const pill = statusPill(a);
                      return (
                        <Row
                          key={a.id}
                          first={i === 0}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 12,
                            minHeight: 46,
                            paddingLeft: 14,
                            paddingRight: 12,
                          }}
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
                          {pill.reconnect ? (
                            <Pressable
                              onPress={() => run(a.provider, a.id, true)}
                              accessibilityRole="button"
                              accessibilityLabel={`Reconnect ${a.nickname}`}
                              style={{ minHeight: 44, justifyContent: 'center' }}
                            >
                              <Pill
                                label={busy === a.id ? 'Opening…' : pill.label}
                                tone={pill.tone}
                                padH={9}
                                padV={4}
                              />
                            </Pressable>
                          ) : (
                            <Pill label={pill.label} tone={pill.tone} padH={9} padV={4} />
                          )}
                        </Row>
                      );
                    })}
                  </Card>
                ) : null}
              </View>
            );
          })}
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
