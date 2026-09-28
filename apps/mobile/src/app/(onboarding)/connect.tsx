import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { Provider } from '@hub/shared';
import { useAccounts } from '@/lib/queries';
import { useConnectAccount } from '@/lib/connect';
import { errorMessage } from '@/lib/api';
import { MAX_ACCOUNTS_PER_SERVICE, SERVICES } from '@/lib/format';
import { colors } from '@/theme';
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

export default function ConnectScreen() {
  const accounts = useAccounts();
  const connect = useConnectAccount();
  const [pending, setPending] = useState<Provider | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = accounts.data?.accounts ?? [];

  const add = (provider: Provider, available: boolean) => {
    setNotice(null);
    if (!available) {
      setNotice(
        `${SERVICES.find((s) => s.provider === provider)?.name} is coming soon. Google works today.`,
      );
      return;
    }
    setPending(provider);
    connect.mutate(provider, {
      onSuccess: (out) => {
        if (!out.ok && out.message) setNotice(out.message);
      },
      onError: (e) => setNotice(errorMessage(e)),
      onSettled: () => setPending(null),
    });
  };

  return (
    <Screen
      footer={
        <>
          {notice ? <Notice text={notice} /> : null}
          <Button
            label={`Continue · ${list.length} ${list.length === 1 ? 'account' : 'accounts'}`}
            size="lg"
            onPress={() => router.push(list.length ? '/scope' : '/presets')}
          />
        </>
      }
    >
      <StepHeader step={2} onBack={() => goBack('/role')} />
      <StepTitle
        title="Connect your accounts"
        subtitle="Add as many as you have, like work and personal Gmail. Each one gets its own settings."
      />
      {accounts.isPending ? (
        <LoadingState compact label="Loading your accounts…" />
      ) : accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : (
        <Card radius={16}>
          {SERVICES.map((s, i) => {
            const mine = list.filter((a) => a.provider === s.provider);
            const has = mine.length > 0;
            const full = mine.length >= MAX_ACCOUNTS_PER_SERVICE;
            return (
              <Row
                key={s.provider}
                first={i === 0}
                style={{ paddingHorizontal: 14, paddingTop: 4, paddingBottom: has ? 10 : 4 }}
              >
                <View
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }}
                >
                  <View style={{ flex: 1, gap: 1 }}>
                    <Txt size={15} weight={600}>
                      {s.name}
                    </Txt>
                    <Txt size={12} color={colors.secondary}>
                      {s.covers}
                    </Txt>
                  </View>
                  {!s.available ? (
                    <Button
                      label="Coming soon"
                      variant="outline"
                      size="md"
                      radius={10}
                      weight={500}
                      textSize={13}
                      onPress={() => add(s.provider, false)}
                    />
                  ) : full ? (
                    <Txt size={13} weight={600} color={colors.secondary}>
                      Max 4
                    </Txt>
                  ) : has ? (
                    <Button
                      label="+ Add another"
                      variant="link"
                      size="md"
                      radius={10}
                      textSize={13}
                      loading={pending === s.provider}
                      onPress={() => add(s.provider, true)}
                      style={{ paddingHorizontal: 12 }}
                    />
                  ) : (
                    <Button
                      label="Connect"
                      size="md"
                      radius={10}
                      textSize={13}
                      loading={pending === s.provider}
                      onPress={() => add(s.provider, true)}
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
                    {a.status === 'reconnect' ? (
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
