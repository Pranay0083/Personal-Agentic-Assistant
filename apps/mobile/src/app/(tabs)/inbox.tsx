import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, SectionList, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ItemBucket, ItemKind, Provider } from '@hub/shared';
import { useAccounts, useItems } from '@/lib/queries';
import { useCatalogMap, useNow, useProviderCounts } from '@/lib/hooks';
import { itemTag, serviceName, shortTime } from '@/lib/format';
import type { AccountT, ItemT } from '@/lib/api';
import { colors, HIT } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Chip, Dot, Pill, SourceTag } from '@/components/ui';
import { EmptyState, ErrorState, LoadingState, Sheet } from '@/components/layout';
import { Check, Chevron, Search } from '@/components/icons';
import { AskBar, AskSheet, useAsk } from '@/components/Ask';

type Filter = 'all' | 'needs' | 'email' | 'slack' | 'jira' | 'teams' | 'chat' | 'docs' | 'code';
type KindT = ReturnType<typeof ItemKind.parse>;
type BucketT = ReturnType<typeof ItemBucket.parse>;
type ProviderT = ReturnType<typeof Provider.parse>;

const FILTERS: Record<Filter, { kind?: KindT; bucket?: BucketT; provider?: ProviderT }> = {
  all: {},
  needs: { bucket: 'needs_you' },
  email: { kind: 'email' },
  slack: { kind: 'chat', provider: 'slack' },
  jira: { kind: 'ticket', provider: 'atlassian' },
  teams: { kind: 'chat', provider: 'microsoft' },
  chat: { kind: 'chat', provider: 'gmail' },
  docs: { kind: 'note' },
  code: { kind: 'code' },
};

/** When a chip filters by provider on the phone, keep paging until a screenful shows. */
const MIN_FILTERED = 12;

/** Teal for things the hub already handled ("Task created", "Draft ready"), amber otherwise. */
function chipTone(label: string): 'teal' | 'amber' {
  return /task|draft|done|sent|replied|approved|added|handled/i.test(label) ? 'teal' : 'amber';
}

export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const accountsQ = useAccounts();
  const accounts = accountsQ.data?.accounts ?? [];
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const counts = useProviderCounts();
  const catalog = useCatalogMap();
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>('all');
  const [switcher, setSwitcher] = useState(false);
  const ask = useAsk();
  const now = useNow();

  const f = FILTERS[filter];
  const items = useItems({ accountId, kind: f.kind, bucket: f.bucket });
  const selected = accountId ? byId.get(accountId) : undefined;

  const all = useMemo(() => {
    const flat = (items.data?.pages ?? []).flatMap((p) => p.items);
    return f.provider ? flat.filter((i) => byId.get(i.accountId)?.provider === f.provider) : flat;
  }, [items.data, f.provider, byId]);
  const needsCount = items.data?.pages[0]?.counts.needsYou ?? 0;

  // The API filters by kind only; Slack vs Teams vs Google Chat is filtered here.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = items;
  useEffect(() => {
    if (f.provider && all.length < MIN_FILTERED && hasNextPage && !isFetchingNextPage)
      void fetchNextPage();
  }, [f.provider, all.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const sections = useMemo(() => {
    const needs = all.filter((i) => i.bucket === 'needs_you');
    const fyi = all.filter((i) => i.bucket !== 'needs_you' && i.bucket !== 'ignore');
    return [
      ...(needs.length ? [{ key: 'needs', title: 'Needs you', data: needs }] : []),
      ...(fyi.length ? [{ key: 'fyi', title: 'FYI', data: fyi }] : []),
    ];
  }, [all]);

  const chips: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'needs', label: `Needs you · ${needsCount}` },
    { value: 'email', label: 'Email' },
    { value: 'slack', label: 'Slack' },
    { value: 'jira', label: 'Jira' },
    { value: 'teams', label: 'Teams' },
  ];
  // Extra chips only for services the user actually has.
  const hasKind = (p: ProviderT, kind: KindT) =>
    (counts.get(p) ?? 0) > 0 && !!catalog.get(p)?.sources.some((s) => s.kind === kind);
  if (hasKind('gmail', 'chat')) chips.push({ value: 'chat', label: 'Chat' });
  if ((counts.get('notion') ?? 0) > 0 || hasKind('atlassian', 'note'))
    chips.push({ value: 'docs', label: 'Docs' });
  if ((counts.get('github') ?? 0) > 0) chips.push({ value: 'code', label: 'Code' });
  // Accounts grouped by service for the switcher.
  const accountGroups = useMemo(() => {
    const m = new Map<string, AccountT[]>();
    for (const a of accounts) m.set(a.provider, [...(m.get(a.provider) ?? []), a]);
    return [...m.entries()];
  }, [accounts]);

  const header = (
    <View style={{ gap: 16, paddingBottom: 8 }}>
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <View style={{ gap: 4 }}>
          <Title size={40} lh={1}>
            Inbox
          </Title>
          <Pressable
            onPress={() => setSwitcher(true)}
            accessibilityRole="button"
            accessibilityLabel="Choose account"
            hitSlop={{ top: 6, bottom: 6 }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32 }}
          >
            {selected ? <Dot color={selected.color} size={8} /> : null}
            <Txt size={13} color={colors.secondary}>
              {selected
                ? selected.nickname
                : `All ${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}`}
            </Txt>
            <Chevron dir="down" size={14} color={colors.secondary} />
          </Pressable>
        </View>
        <Pressable
          onPress={() => ask.start()}
          accessibilityRole="button"
          accessibilityLabel="Search"
          style={{
            width: HIT,
            height: HIT,
            borderRadius: HIT / 2,
            borderWidth: 1,
            borderColor: colors.inputBorder,
            backgroundColor: colors.white,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Search />
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8 }}
        style={{ marginHorizontal: -20 }}
      >
        <View style={{ width: 12 }} />
        {chips.map((c) => (
          <Chip
            key={c.value}
            label={c.label}
            on={filter === c.value}
            onPress={() => setFilter(c.value)}
          />
        ))}
        <View style={{ width: 12 }} />
      </ScrollView>
      {items.isPending ? <LoadingState compact /> : null}
      {items.isError ? (
        <ErrorState error={items.error} onRetry={() => void items.refetch()} />
      ) : null}
      {items.isSuccess && sections.length === 0 ? (
        <EmptyState
          title={filter === 'all' ? 'Nothing here yet' : 'Nothing matches this filter'}
          body={
            accounts.length === 0
              ? 'Connect an account in Control → Connectors to fill your inbox.'
              : 'New messages show up here as they sync.'
          }
        />
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SectionList
        sections={sections}
        keyExtractor={(i) => i.id}
        ListHeaderComponent={header}
        contentContainerStyle={{
          paddingTop: insets.top + 28,
          paddingHorizontal: 20,
          paddingBottom: 24,
        }}
        stickySectionHeadersEnabled={false}
        onRefresh={() => void items.refetch()}
        refreshing={items.isRefetching && !items.isFetchingNextPage}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          if (items.hasNextPage && !items.isFetchingNextPage) void items.fetchNextPage();
        }}
        renderSectionHeader={({ section }) => (
          <View style={{ paddingTop: 8, paddingBottom: 8 }}>
            <Txt size={13} weight={600} color={colors.secondary} accessibilityRole="header">
              {section.title}
            </Txt>
          </View>
        )}
        renderItem={({ item, index, section }) => (
          <InboxRow
            item={item}
            account={byId.get(item.accountId)}
            multi={(counts.get(byId.get(item.accountId)?.provider ?? '') ?? 0) > 1}
            first={index === 0}
            last={index === section.data.length - 1}
            needs={section.key === 'needs'}
            now={now}
          />
        )}
        renderSectionFooter={() => <View style={{ height: 8 }} />}
        ListFooterComponent={
          items.isFetchingNextPage ? <LoadingState compact label="Loading more…" /> : null
        }
      />

      <Sheet visible={switcher} onClose={() => setSwitcher(false)} title="Accounts">
        <AccountOption
          label={`All ${accounts.length} accounts`}
          on={!accountId}
          onPress={() => {
            setAccountId(undefined);
            setSwitcher(false);
          }}
        />
        {accountGroups.map(([provider, list]) => (
          <View key={provider} style={{ gap: 8 }}>
            <Txt size={12} weight={600} color={colors.secondary} accessibilityRole="header">
              {catalog.get(provider as ProviderT)?.name ?? serviceName(provider)}
            </Txt>
            {list.map((a) => (
              <AccountOption
                key={a.id}
                label={a.nickname}
                sub={a.externalId}
                color={a.color}
                on={accountId === a.id}
                onPress={() => {
                  setAccountId(a.id);
                  setSwitcher(false);
                }}
              />
            ))}
          </View>
        ))}
      </Sheet>
      <AskSheetOrSearch ask={ask} />
    </View>
  );
}

/** The search button reuses Ask: there's no keyword search endpoint in the contract. */
function AskSheetOrSearch({ ask }: { ask: ReturnType<typeof useAsk> }) {
  if (ask.open && !ask.question) return <SearchPrompt ask={ask} />;
  return <AskSheet state={ask} />;
}

function SearchPrompt({ ask }: { ask: ReturnType<typeof useAsk> }) {
  return (
    <Sheet visible onClose={ask.close} title="Search">
      <Txt size={13} lh={1.45} color={colors.secondary}>
        Ask in plain words, like “where does the API spec live?”
      </Txt>
      <AskBar state={ask} />
    </Sheet>
  );
}

function AccountOption({
  label,
  sub,
  color,
  on,
  onPress,
}: {
  label: string;
  sub?: string;
  color?: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: colors.white,
        borderWidth: 1,
        borderColor: on ? colors.teal : colors.border,
      }}
    >
      {color ? <Dot color={color} /> : <View style={{ width: 10 }} />}
      <View style={{ flex: 1 }}>
        <Txt size={15} weight={500}>
          {label}
        </Txt>
        {sub ? (
          <Txt size={12} color={colors.secondary}>
            {sub}
          </Txt>
        ) : null}
      </View>
      {on ? <Check color={colors.teal} /> : null}
    </Pressable>
  );
}

function InboxRow({
  item,
  account,
  first,
  last,
  needs,
  now,
  multi,
}: {
  item: ItemT;
  account: AccountT | undefined;
  /** The user has several accounts of this provider: add the nickname to the tag. */
  multi: boolean;
  first: boolean;
  last: boolean;
  needs: boolean;
  now: number;
}) {
  const body = item.summary ?? item.title ?? '(no subject)';
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/item/[id]', params: { id: item.id } })}
      accessibilityRole="button"
      style={({ pressed }) => ({
        backgroundColor: pressed ? '#FAF8F3' : colors.white,
        borderColor: colors.border,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderTopWidth: first ? 1 : 0,
        borderBottomWidth: last ? 1 : 0,
        borderTopLeftRadius: first ? 14 : 0,
        borderTopRightRadius: first ? 14 : 0,
        borderBottomLeftRadius: last ? 14 : 0,
        borderBottomRightRadius: last ? 14 : 0,
      })}
    >
      <View
        style={{
          marginHorizontal: 0,
          paddingVertical: needs ? 12 : 11,
          paddingHorizontal: 14,
          gap: needs ? 6 : 4,
          borderTopWidth: first ? 0 : 1,
          borderTopColor: colors.divider,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexShrink: 1 }}>
            <SourceTag label={itemTag(item, account, multi)} />
            {item.author ? (
              <Txt
                size={12}
                weight={needs ? 600 : 400}
                color={needs ? colors.ink : colors.secondary}
                numberOfLines={1}
                style={{ flexShrink: 1 }}
              >
                {item.author}
              </Txt>
            ) : null}
          </View>
          <Txt size={12} color={colors.secondary}>
            {shortTime(item.receivedAt, new Date(now))}
          </Txt>
        </View>
        <Txt size={14} lh={1.4} color={needs ? colors.ink : colors.body} numberOfLines={3}>
          {body}
        </Txt>
        {item.statusLabel ? (
          <Pill label={item.statusLabel} tone={chipTone(item.statusLabel)} />
        ) : null}
      </View>
    </Pressable>
  );
}
