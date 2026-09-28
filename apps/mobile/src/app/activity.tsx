import { useMemo } from 'react';
import { View } from 'react-native';
import { useActivity, useMcp } from '@/lib/queries';
import { agentName, dayLabel, hhmm } from '@/lib/format';
import type { ActivityEntryT } from '@/lib/api';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, Row, SectionTitle, SourceTag } from '@/components/ui';
import { BackLink, EmptyState, ErrorState, LoadingState, Screen } from '@/components/layout';

function humanAction(action: string): string {
  const s = action.replace(/[._]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ActivityScreen() {
  const activity = useActivity();
  const mcp = useMcp();
  const clientNames = useMemo(
    () => new Map((mcp.data?.clients ?? []).map((c) => [c.id, c.name])),
    [mcp.data],
  );

  const who = (p: string) => {
    if (p === 'user') return 'YOU';
    if (p.startsWith('agent:')) return agentName(p).toUpperCase();
    if (p.startsWith('mcp:')) return (clientNames.get(p.slice(4)) ?? 'MCP CLIENT').toUpperCase();
    return p.toUpperCase();
  };

  const groups = useMemo(() => {
    const entries = (activity.data?.pages ?? []).flatMap((p) => p.entries);
    const out: { day: string; entries: ActivityEntryT[] }[] = [];
    for (const e of entries) {
      const day = dayLabel(new Date(e.at));
      const last = out[out.length - 1];
      if (last && last.day === day) last.entries.push(e);
      else out.push({ day, entries: [e] });
    }
    return out;
  }, [activity.data]);

  return (
    <Screen
      onRefresh={() => void activity.refetch()}
      refreshing={activity.isRefetching && !activity.isFetchingNextPage}
    >
      <BackLink />
      <View style={{ gap: 6 }}>
        <Title size={36} lh={1}>
          Activity log
        </Title>
        <Txt size={13} color={colors.secondary}>
          Everything agents read and did. This log can't be edited.
        </Txt>
      </View>
      {activity.isPending ? (
        <LoadingState />
      ) : activity.isError ? (
        <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState
          title="Nothing yet"
          body="Reads, drafts, approvals and sends will be listed here as they happen."
        />
      ) : (
        <>
          {groups.map((g) => (
            <View key={g.day} style={{ gap: 6 }}>
              <SectionTitle>{g.day}</SectionTitle>
              <Card>
                {g.entries.map((e, i) => (
                  <Row
                    key={e.id}
                    first={i === 0}
                    style={{ paddingVertical: 11, paddingHorizontal: 14, gap: 4 }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <SourceTag label={who(e.principal)} />
                      <Txt size={12} color={colors.secondary}>
                        {hhmm(new Date(e.at))}
                      </Txt>
                    </View>
                    <Txt size={14} color={colors.ink}>
                      {humanAction(e.action)}
                    </Txt>
                    {e.target ? (
                      <Txt size={12} color={colors.secondary} numberOfLines={1}>
                        {e.target}
                      </Txt>
                    ) : null}
                  </Row>
                ))}
              </Card>
            </View>
          ))}
          {activity.hasNextPage ? (
            <Button
              label="Load more"
              variant="outline"
              loading={activity.isFetchingNextPage}
              onPress={() => void activity.fetchNextPage()}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}
