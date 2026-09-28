import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type AccountT } from '@/lib/api';
import { qk, useAccounts } from '@/lib/queries';
import { serviceName } from '@/lib/format';
import { ACCOUNT_SWATCHES, colors, HIT } from '@/theme';
import { Txt } from '@/components/Txt';
import { Button, Card, Checkbox, Dot, Input, Segmented } from '@/components/ui';
import {
  EmptyState,
  ErrorState,
  goBack,
  LoadingState,
  Notice,
  Screen,
  StepHeader,
} from '@/components/layout';

type Days = 7 | 30 | 90;

export default function ScopeScreen() {
  const { i } = useLocalSearchParams<{ i?: string }>();
  const index = Math.max(0, Number(i ?? 0) || 0);
  const accounts = useAccounts();
  const list = useMemo(
    () =>
      [...(accounts.data?.accounts ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [accounts.data],
  );
  const account = list[index];

  if (accounts.isPending) {
    return (
      <Screen>
        <StepHeader step={3} onBack={() => goBack('/connect')} />
        <LoadingState />
      </Screen>
    );
  }
  if (accounts.isError || !account) {
    return (
      <Screen
        footer={<Button label="Continue" size="lg" onPress={() => router.push('/presets')} />}
      >
        <StepHeader step={3} onBack={() => goBack('/connect')} />
        {accounts.isError ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : (
          <EmptyState
            title="No accounts to set up"
            body="Connect an account first, or continue and add one later from Control."
          />
        )}
      </Screen>
    );
  }
  return <ScopeForm key={account.id} account={account} index={index} list={list} />;
}

function ScopeForm({
  account,
  index,
  list,
}: {
  account: AccountT;
  index: number;
  list: AccountT[];
}) {
  const qc = useQueryClient();
  const [nickname, setNickname] = useState(account.nickname);
  const [color, setColor] = useState(account.color);
  const [filters, setFilters] = useState(account.filters);
  const [days, setDays] = useState<Days>(account.backfillDays);
  const [applyAll, setApplyAll] = useState(false);
  const [isPersonal, setIsPersonal] = useState(account.isPersonal);

  const isGoogle = account.provider === 'gmail';
  const otherGoogle = list.filter((a) => a.provider === 'gmail' && a.id !== account.id);
  const skipGoogle = isGoogle && applyAll;
  const nextIndex = list.findIndex((a, j) => j > index && !(skipGoogle && a.provider === 'gmail'));
  const next = nextIndex >= 0 ? list[nextIndex] : undefined;

  const save = useMutation({
    mutationFn: async () => {
      await api.updateAccount(account.id, {
        nickname: nickname.trim() || account.nickname,
        color,
        filters,
        backfillDays: days,
        isPersonal,
      });
      if (skipGoogle && otherGoogle.length) await api.applySettingsToProvider(account.id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.accounts });
      if (next) router.push({ pathname: '/scope', params: { i: String(nextIndex) } });
      else router.push('/presets');
    },
  });

  const reads: { key: 'inbox' | 'sent' | 'promotions'; label: string; hint?: string }[] = [
    { key: 'inbox', label: 'Primary inbox' },
    { key: 'sent', label: 'Sent mail', hint: '· catches your promises' },
    { key: 'promotions', label: 'Promotions and Social' },
  ];

  return (
    <Screen
      footer={
        <>
          {save.isError ? <Notice text={errorMessage(save.error)} /> : null}
          <Button
            label={next ? `Next account: ${next.nickname}` : 'Continue'}
            size="lg"
            onPress={() => save.mutate()}
            loading={save.isPending}
          />
        </>
      }
    >
      <StepHeader
        step={3}
        suffix={`ACCOUNT ${index + 1} OF ${list.length}`}
        onBack={() => goBack('/connect')}
      />
      <View style={{ gap: 6 }}>
        <Txt serif size={32} lh={1.05} accessibilityRole="header">
          {isGoogle ? 'Set up this Gmail' : `Set up this ${serviceName(account.provider)}`}
        </Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Dot color={color} />
          <Txt size={14} color={colors.body}>
            {account.externalId}
          </Txt>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-end' }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Txt size={12} weight={600} color={colors.secondary}>
            Nickname
          </Txt>
          <Input
            value={nickname}
            onChangeText={setNickname}
            placeholder="Work"
            maxLength={40}
            accessibilityLabel="Nickname"
          />
        </View>
        <View style={{ gap: 6 }}>
          <Txt size={12} weight={600} color={colors.secondary}>
            Color
          </Txt>
          <View style={{ flexDirection: 'row', gap: 2 }}>
            {ACCOUNT_SWATCHES.map((s) => {
              const on = s.color === color;
              return (
                <Pressable
                  key={s.color}
                  onPress={() => setColor(s.color)}
                  accessibilityRole="button"
                  accessibilityLabel={s.label}
                  accessibilityState={{ selected: on }}
                  style={{
                    width: HIT,
                    height: HIT,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <View
                    style={{
                      width: on ? 34 : 26,
                      height: on ? 34 : 26,
                      borderRadius: 17,
                      borderWidth: on ? 2 : 0,
                      borderColor: s.color,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <View
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 13,
                        backgroundColor: s.color,
                        borderWidth: on ? 3 : 0,
                        borderColor: colors.bg,
                      }}
                    />
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

      {isGoogle ? (
        <Card style={{ paddingVertical: 8, paddingHorizontal: 14, gap: 4 }}>
          <Txt size={12} weight={600} color={colors.secondary} style={{ paddingVertical: 4 }}>
            What to read
          </Txt>
          {reads.map((r) => {
            const on = filters[r.key];
            return (
              <Pressable
                key={r.key}
                onPress={() => setFilters({ ...filters, [r.key]: !on })}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: HIT }}
              >
                <Checkbox checked={on} size={20} />
                <Txt size={15} style={{ flex: 1 }}>
                  {r.label}
                  {r.hint ? (
                    <Txt size={12} color={colors.secondary}>
                      {` ${r.hint}`}
                    </Txt>
                  ) : null}
                </Txt>
              </Pressable>
            );
          })}
          {filters.labels.map((l) => (
            <Pressable
              key={l}
              onPress={() =>
                setFilters({ ...filters, labels: filters.labels.filter((x) => x !== l) })
              }
              accessibilityRole="checkbox"
              accessibilityState={{ checked: true }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: HIT }}
            >
              <Checkbox checked size={20} />
              <Txt size={15}>{`Label: ${l}`}</Txt>
            </Pressable>
          ))}
        </Card>
      ) : null}

      <View style={{ gap: 6 }}>
        <Txt size={12} weight={600} color={colors.secondary}>
          How far back
        </Txt>
        <Segmented<`${Days}`>
          value={`${days}`}
          onChange={(v) => setDays(Number(v) as Days)}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
        />
        <Txt size={12} color={colors.secondary}>
          Imports in the background. You can keep going.
        </Txt>
      </View>

      <Pressable
        onPress={() => setIsPersonal(!isPersonal)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isPersonal }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: HIT }}
      >
        <Checkbox checked={isPersonal} size={20} />
        <View style={{ flex: 1, gap: 2 }}>
          <Txt size={14}>This is a personal account</Txt>
          <Txt size={12} color={colors.secondary}>
            Gets the stricter rules if you keep them on in the next step.
          </Txt>
        </View>
      </Pressable>

      {isGoogle && otherGoogle.length > 0 ? (
        <Pressable
          onPress={() => setApplyAll(!applyAll)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: applyAll }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: HIT }}
        >
          <Checkbox checked={applyAll} size={20} />
          <Txt size={14} style={{ flex: 1 }}>
            Use these settings for my other Google accounts
          </Txt>
        </Pressable>
      ) : null}
    </Screen>
  );
}
