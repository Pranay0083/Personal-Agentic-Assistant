import { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { qk, useMcp } from '@/lib/queries';
import { useNow } from '@/lib/hooks';
import { ago } from '@/lib/format';
import { api, errorMessage } from '@/lib/api';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, Row, SectionTitle } from '@/components/ui';
import { BackLink, EmptyState, Notice, Screen } from '@/components/layout';
import { AgentsConnect } from '@/components/AgentsConnect';

export default function ConnectedAgentsScreen() {
  const qc = useQueryClient();
  const mcp = useMcp();
  const now = useNow();
  const [confirm, setConfirm] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.removeMcpClient(id),
    onSettled: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: qk.mcp });
      void qc.invalidateQueries({ queryKey: qk.control });
      void qc.invalidateQueries({ queryKey: qk.permissionsAll });
    },
  });
  const clients = mcp.data?.clients ?? [];

  return (
    <Screen onRefresh={() => void mcp.refetch()} refreshing={mcp.isRefetching}>
      <BackLink />
      <View style={{ gap: 6 }}>
        <Title size={36} lh={1}>
          Connected agents
        </Title>
        <Txt size={13} lh={1.45} color={colors.secondary}>
          Give Claude and your coding tools your context, with the limits you set. Each gets its own
          key.
        </Txt>
      </View>
      <AgentsConnect />
      {mcp.isSuccess ? (
        <View style={{ gap: 6 }}>
          <SectionTitle>Connected now</SectionTitle>
          {clients.length === 0 ? (
            <EmptyState
              title="No agents connected yet"
              body="When Claude or Claude Code connects, you'll approve it in Approvals and it shows up here."
            />
          ) : (
            <Card>
              {clients.map((c, i) => (
                <Row
                  key={c.id}
                  first={i === 0}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 56,
                    paddingLeft: 14,
                    paddingRight: 10,
                  }}
                >
                  <View style={{ flex: 1, gap: 2, paddingVertical: 8 }}>
                    <Txt size={15} weight={500}>
                      {c.name}
                    </Txt>
                    <Txt size={12} color={colors.secondary}>
                      {c.lastUsedAt
                        ? `Last used ${ago(c.lastUsedAt, now)}`
                        : `Connected ${ago(c.createdAt, now)}`}
                    </Txt>
                  </View>
                  <Button
                    label={confirm === c.id ? 'Confirm' : 'Disconnect'}
                    variant="warnOutline"
                    radius={10}
                    textSize={13}
                    loading={remove.isPending && remove.variables === c.id}
                    onPress={() => (confirm === c.id ? remove.mutate(c.id) : setConfirm(c.id))}
                  />
                </Row>
              ))}
            </Card>
          )}
        </View>
      ) : null}
      {remove.isError ? <Notice text={errorMessage(remove.error)} /> : null}
    </Screen>
  );
}
