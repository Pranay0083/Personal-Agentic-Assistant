import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { Provider } from '@hub/shared';
import { useServices } from '@/lib/hooks';
import {
  connectedMessage,
  noticeFromParams,
  useConnectAccount,
  type ConnectedNotice,
} from '@/lib/connect';
import { errorMessage } from '@/lib/api';
import { coversText, MAX_ACCOUNTS_PER_SERVICE } from '@/lib/format';
import { colors, HIT } from '@/theme';
import { Txt } from '@/components/Txt';
import { Button, Card, Dot, Row } from '@/components/ui';
import {
  ErrorState,
  goBack,
  LoadingState,
  Notice,
  Screen,
  StepHeader,
  StepTitle,
} from '@/components/layout';
import { Check } from '@/components/icons';

type Msg = { text: string; tone: 'warn' | 'teal' };

export default function ConnectScreen() {
  const { catalog, accounts, groups } = useServices();
  const connect = useConnectAccount();
  const params = useLocalSearchParams<ConnectedNotice>();
  const [pending, setPending] = useState<Provider | null>(null);
  const [msg, setMsg] = useState<Msg | null>(() => {
    const text = noticeFromParams(params);
    return text ? { text, tone: 'teal' } : null;
  });
  const total = accounts.data?.accounts.length ?? 0;

  const notSetUp = (name: string) =>
    setMsg({
      text: `${name} isn't set up on your hub yet. Add its client ID and secret to the hub's config (see .env.example), then restart it.`,
      tone: 'warn',
    });

  const add = (provider: Provider) => {
    setMsg(null);
    setPending(provider);
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
      onSettled: () => setPending(null),
    });
  };

  const loading = catalog.isPending || accounts.isPending;

  return (
    <Screen
      footer={
        <>
          {msg ? <Notice text={msg.text} tone={msg.tone} /> : null}
          <Button
            label={`Continue · ${total} ${total === 1 ? 'account' : 'accounts'}`}
            size="lg"
            onPress={() => router.push(total ? '/scope' : '/presets')}
          />
        </>
      }
    >
      <StepHeader step={2} onBack={() => goBack('/role')} />
      <StepTitle
        title="Connect your accounts"
        subtitle="Add as many as you have, like work and personal Gmail. Each one gets its own settings."
      />
      {loading ? (
        <LoadingState compact label="Loading your services…" />
      ) : accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : catalog.isError ? (
        <ErrorState
          title="Couldn't load your hub's services"
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
      ) : groups.length === 0 ? (
        <Notice text="Your hub has no services set up yet. Add a provider's client ID and secret to its config, then restart it." />
      ) : (
        <Card radius={16}>
          {groups.map(({ info, accounts: mine }, i) => {
            const has = mine.length > 0;
            const full = mine.length >= MAX_ACCOUNTS_PER_SERVICE;
            const covers = coversText(info.covers, info.multiAccountNote);
            return (
              <Row
                key={info.provider}
                first={i === 0}
                style={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: has ? 10 : 4 }}
              >
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }}
                >
                  <View style={{ flex: 1, gap: 1 }}>
                    <Txt size={15} weight={600}>
                      {info.name}
                    </Txt>
                    {covers ? (
                      <Txt size={12} color={colors.secondary}>
                        {covers}
                      </Txt>
                    ) : null}
                  </View>
                  {!info.available ? (
                    <Pressable
                      onPress={() => notSetUp(info.name)}
                      accessibilityRole="button"
                      accessibilityLabel={`${info.name}: not set up on your hub`}
                      style={{
                        minHeight: HIT,
                        maxWidth: 120,
                        justifyContent: 'center',
                        alignItems: 'flex-end',
                      }}
                    >
                      <Txt size={12} weight={500} color={colors.secondary} align="right">
                        Not set up on your hub
                      </Txt>
                    </Pressable>
                  ) : full ? (
                    <Txt size={13} weight={600} color={colors.secondary}>
                      {`Max ${MAX_ACCOUNTS_PER_SERVICE}`}
                    </Txt>
                  ) : has ? (
                    <Button
                      label="+ Add another"
                      variant="link"
                      size="md"
                      radius={10}
                      textSize={13}
                      loading={pending === info.provider}
                      disabled={pending !== null && pending !== info.provider}
                      onPress={() => add(info.provider)}
                      style={{ paddingHorizontal: 12 }}
                    />
                  ) : (
                    <Button
                      label="Connect"
                      size="md"
                      radius={10}
                      textSize={13}
                      loading={pending === info.provider}
                      disabled={pending !== null && pending !== info.provider}
                      onPress={() => add(info.provider)}
                    />
                  )}
                </View>
                {mine.map((a) => (
                  <View
                    key={a.id}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      minHeight: 38,
                      paddingLeft: 2,
                    }}
                  >
                    <Dot color={a.color} />
                    <Txt size={14} weight={500}>
                      {a.nickname}
                    </Txt>
                    <Txt size={13} color={colors.secondary} style={{ flex: 1 }} numberOfLines={1}>
                      {a.externalId}
                    </Txt>
                    {a.status === 'reconnect' || a.status === 'disconnected' ? (
                      <Txt size={12} weight={600} color={colors.amberDark}>
                        Reconnect
                      </Txt>
                    ) : (
                      <Check size={16} color={colors.green} />
                    )}
                  </View>
                ))}
              </Row>
            );
          })}
        </Card>
      )}
    </Screen>
  );
}
