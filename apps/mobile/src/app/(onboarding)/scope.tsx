import { useMemo } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage, type AccountT } from '@/lib/api';
import { qk, useAccounts, useConnectors } from '@/lib/queries';
import { colors } from '@/theme';
import { Txt } from '@/components/Txt';
import { Button, Dot } from '@/components/ui';
import {
  EmptyState,
  ErrorState,
  goBack,
  LoadingState,
  Notice,
  Screen,
  StepHeader,
} from '@/components/layout';
import {
  AccountSettingsFields,
  saveAccountDraft,
  setupTitle,
  useAccountDraft,
} from '@/components/AccountSettings';

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
  const catalog = useConnectors();
  const info = catalog.data?.connectors.find((c) => c.provider === account.provider);
  const [draft, setDraft] = useAccountDraft(account);

  const others = list.filter((a) => a.provider === account.provider && a.id !== account.id);
  // "Use these settings for my other … accounts" skips their own Scope steps.
  const skipSame = draft.applyAll && others.length > 0;
  const nextIndex = list.findIndex(
    (a, j) => j > index && !(skipSame && a.provider === account.provider),
  );
  const next = nextIndex >= 0 ? list[nextIndex] : undefined;

  const save = useMutation({
    mutationFn: () => saveAccountDraft(account, draft, others.length),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.accounts });
      if (next) router.push({ pathname: '/scope', params: { i: String(nextIndex) } });
      else router.push('/presets');
    },
  });

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
          {setupTitle(account, info)}
        </Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Dot color={draft.color} />
          <Txt size={14} color={colors.body} style={{ flexShrink: 1 }} numberOfLines={1}>
            {account.externalId}
          </Txt>
        </View>
      </View>
      <AccountSettingsFields
        onboarding
        account={account}
        info={info}
        catalogState={catalog.status}
        onRetryCatalog={() => void catalog.refetch()}
        otherCount={others.length}
        draft={draft}
        setDraft={setDraft}
      />
    </Screen>
  );
}
