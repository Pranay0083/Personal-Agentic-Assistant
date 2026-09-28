import { View } from 'react-native';
import { router } from 'expo-router';
import { useMeRequired } from '@/lib/auth';
import { useToday } from '@/lib/queries';
import { useAccountMap, useNow } from '@/lib/hooks';
import { agoShort, dateHeader, greeting, hhmm, itemTag, shortTime, slotLabel } from '@/lib/format';
import { colors } from '@/theme';
import { Label, Title, Txt } from '@/components/Txt';
import { Card, Dot, LinkButton, Row, SourceTag } from '@/components/ui';
import { EmptyState, ErrorState, LoadingState, Screen } from '@/components/layout';
import { AskBar, AskSheet, useAsk } from '@/components/Ask';

export default function TodayScreen() {
  const me = useMeRequired();
  const today = useToday();
  const accounts = useAccountMap();
  const ask = useAsk();
  const now = useNow();

  const data = today.data;
  const synced = data?.lastSyncedAt;
  const fresh = synced ? now - new Date(synced).getTime() < 60 * 60_000 : false;

  return (
    <Screen
      padTop={28}
      gap={20}
      bottomInset={false}
      onRefresh={() => void today.refetch()}
      refreshing={today.isRefetching}
      footer={<AskBar state={ask} />}
    >
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <View style={{ gap: 6 }}>
          <Label>{dateHeader(new Date(now))}</Label>
          <Title size={40} lh={1}>
            {greeting(new Date(now))}
          </Title>
        </View>
        {data ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderRadius: 999,
              backgroundColor: colors.white,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Dot size={7} color={fresh ? colors.green : colors.amber} />
            <Txt size={12} color={colors.muted}>
              {synced ? `Synced ${agoShort(synced, now)}` : 'Not synced yet'}
            </Txt>
          </View>
        ) : null}
      </View>

      {today.isPending ? (
        <LoadingState />
      ) : today.isError ? (
        <ErrorState error={today.error} onRetry={() => void today.refetch()} />
      ) : (
        <>
          {data!.brief ? (
            <View style={{ gap: 12, padding: 18, borderRadius: 16, backgroundColor: colors.teal }}>
              <Label
                color={colors.tealOnDark}
              >{`DAILY BRIEF · ${hhmm(new Date(data!.brief.createdAt))}`}</Label>
              <Txt serif size={22} lh={1.2} color={colors.white}>
                {data!.brief.headline}
              </Txt>
              {data!.brief.bullets.length ? (
                <View style={{ gap: 8 }}>
                  {data!.brief.bullets.map((b, i) => (
                    <Txt key={i} size={14} lh={1.4} color={colors.tealOnDarkBody}>
                      {b}
                    </Txt>
                  ))}
                </View>
              ) : null}
              <LinkButton
                label="Plan my day →"
                color={colors.white}
                weight={600}
                align="flex-start"
                onPress={() => router.navigate('/tasks')}
              />
            </View>
          ) : (
            <View
              style={{ gap: 8, padding: 18, borderRadius: 16, backgroundColor: colors.tealTint }}
            >
              <Label color={colors.teal}>{`DAILY BRIEF · ${me.settings.briefTime}`}</Label>
              <Txt serif size={22} lh={1.2} color={colors.tealDark}>
                No brief yet today.
              </Txt>
              <Txt size={14} lh={1.4} color={colors.tealTintBody}>
                {`Your brief lands at ${me.settings.briefTime} each morning, once your accounts have synced.`}
              </Txt>
            </View>
          )}

          <View style={{ gap: 10 }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Txt size={15} weight={600} accessibilityRole="header">
                Needs you
              </Txt>
              <LinkButton
                label="See all"
                size={13}
                align="flex-end"
                onPress={() => router.navigate('/inbox')}
              />
            </View>
            {data!.needsYou.length === 0 ? (
              <EmptyState
                title="You're all caught up"
                body="Nothing is waiting on you right now."
              />
            ) : (
              <Card>
                {data!.needsYou.map((item, i) => {
                  const meta = [
                    item.author,
                    shortTime(item.receivedAt, new Date(now)),
                    item.statusLabel?.toLowerCase(),
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <Row
                      key={item.id}
                      first={i === 0}
                      onPress={() =>
                        router.push({ pathname: '/item/[id]', params: { id: item.id } })
                      }
                      style={{ paddingVertical: 12, paddingHorizontal: 14, gap: 4 }}
                    >
                      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                        <SourceTag label={itemTag(item, accounts.get(item.accountId), false)} />
                        <Txt
                          size={12}
                          color={colors.secondary}
                          numberOfLines={1}
                          style={{ flexShrink: 1 }}
                        >
                          {meta}
                        </Txt>
                      </View>
                      <Txt size={15} weight={500} numberOfLines={2}>
                        {item.title ?? item.summary ?? '(no subject)'}
                      </Txt>
                    </Row>
                  );
                })}
              </Card>
            )}
          </View>

          <View style={{ gap: 10 }}>
            <Txt size={15} weight={600} accessibilityRole="header">
              Next up
            </Txt>
            {data!.nextUp.length === 0 ? (
              <Txt size={14} color={colors.secondary}>
                No tasks due soon.
              </Txt>
            ) : (
              <View style={{ gap: 8 }}>
                {data!.nextUp.map((t) => {
                  const timeText = slotLabel(t.dueAt, new Date(now));
                  return (
                    <View
                      key={t.id}
                      style={{ flexDirection: 'row', gap: 14, alignItems: 'center', minHeight: 24 }}
                    >
                      <Txt
                        mono
                        size={12}
                        color={colors.teal}
                        style={{ width: 44 }}
                        numberOfLines={1}
                      >
                        {timeText}
                      </Txt>
                      <Txt size={14} style={{ flex: 1 }} numberOfLines={1}>
                        {t.project ? `${t.title} · ${t.project}` : t.title}
                      </Txt>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </>
      )}
      <AskSheet state={ask} />
    </Screen>
  );
}
