import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage, type AccountT } from '@/lib/api';
import { qk, useAccounts, useConnectors } from '@/lib/queries';
import { serviceName } from '@/lib/format';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Dot } from '@/components/ui';
import {
  BackLink,
  EmptyState,
  ErrorState,
  goBack,
  LoadingState,
  Notice,
  Screen,
} from '@/components/layout';
import {
  AccountSettingsFields,
  saveAccountDraft,
  useAccountDraft,
} from '@/components/AccountSettings';

/** Per-account settings after onboarding (the same fields as the Scope step), from Connectors. */
export default function AccountSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const accounts = useAccounts();
  const list = accounts.data?.accounts ?? [];
  const account = list.find((a) => a.id === id);

  if (accounts.isPending || accounts.isError || !account) {
    return (
      <Screen>
        <BackLink label="Connectors" fallback="/connectors" />
        {accounts.isPending ? (
          <LoadingState />
        ) : accounts.isError ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : (
          <EmptyState title="Account not found" body="It may have been disconnected." />
        )}
      </Screen>
    );
  }
  return <Form key={account.id} account={account} list={list} />;
}

function Form({ account, list }: { account: AccountT; list: AccountT[] }) {
  const qc = useQueryClient();
  const catalog = useConnectors();
  const info = catalog.data?.connectors.find((c) => c.provider === account.provider);
  const [draft, setDraft] = useAccountDraft(account);
  const others = list.filter((a) => a.provider === account.provider && a.id !== account.id);

  const save = useMutation({
    mutationFn: () => saveAccountDraft(account, draft, others.length),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.accounts });
      goBack('/connectors');
    },
  });

  return (
    <Screen
      footer={
        <>
          {save.isError ? <Notice text={errorMessage(save.error)} /> : null}
          <Button label="Save" size="lg" onPress={() => save.mutate()} loading={save.isPending} />
        </>
      }
    >
      <BackLink label="Connectors" fallback="/connectors" />
      <View style={{ gap: 6 }}>
        <Title size={32}>{draft.nickname.trim() || account.nickname}</Title>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Dot color={draft.color} />
          <Txt size={14} color={colors.body} style={{ flexShrink: 1 }} numberOfLines={1}>
            {`${info?.name ?? serviceName(account.provider)} · ${account.externalId}`}
          </Txt>
        </View>
      </View>
      <AccountSettingsFields
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
