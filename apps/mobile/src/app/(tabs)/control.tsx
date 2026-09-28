import { View } from 'react-native';
import { router } from 'expo-router';
import { useMeRequired } from '@/lib/auth';
import { useControl, useSetPaused } from '@/lib/queries';
import { useNow } from '@/lib/hooks';
import { ago, plural, presetLabel } from '@/lib/format';
import { errorMessage } from '@/lib/api';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, Dot, NavRow, SectionTitle } from '@/components/ui';
import { ErrorState, LoadingState, Notice, Screen } from '@/components/layout';

export default function ControlScreen() {
  const me = useMeRequired();
  const control = useControl();
  const setPaused = useSetPaused();
  const now = useNow();
  const c = control.data;
  const paused = c?.paused ?? me.paused;

  const needs = c?.accountsNeedingAttention ?? [];
  const connectorsSub = c ? (
    <Txt size={12} color={colors.secondary}>
      {plural(c.accountsCount, 'account')}
      {needs.length ? (
        <Txt size={12} weight={500} color={colors.amber}>
          {` · ${needs.length === 1 ? `${needs[0]!.nickname} needs reconnect` : `${needs.length} need reconnect`}`}
        </Txt>
      ) : null}
    </Txt>
  ) : (
    'Accounts and status'
  );
  const clients = c?.connectedClients ?? [];
  const q = me.settings.quietHours;

  return (
    <Screen
      padTop={28}
      gap={14}
      bottomInset={false}
      onRefresh={() => void control.refetch()}
      refreshing={control.isRefetching}
    >
      <Title size={40} lh={1}>
        Control
      </Title>

      {control.isPending ? (
        <LoadingState compact />
      ) : control.isError ? (
        <ErrorState error={control.error} onRetry={() => void control.refetch()} />
      ) : (
        <Card
          tone={paused ? 'warn' : 'default'}
          radius={16}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 14,
            paddingHorizontal: 16,
          }}
        >
          <View style={{ flex: 1, gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Dot size={8} color={paused ? colors.amber : colors.green} />
              <Txt size={15} weight={600}>
                {paused ? 'All agents paused' : 'Agents are running'}
              </Txt>
            </View>
            <Txt size={12} color={colors.secondary}>
              {paused
                ? 'Events still sync. Nothing runs or sends.'
                : `${plural(c!.activeAgents, 'agent')} active · ${c!.lastEventAt ? `last event ${ago(c!.lastEventAt, now)}` : 'no events yet'}`}
            </Txt>
          </View>
          <Button
            label={paused ? 'Resume' : 'Pause all'}
            variant={paused ? 'teal' : 'warnOutline'}
            radius={22}
            loading={setPaused.isPending}
            onPress={() => setPaused.mutate(!paused)}
          />
        </Card>
      )}
      {setPaused.isError ? <Notice text={errorMessage(setPaused.error)} /> : null}

      <View style={{ gap: 6 }}>
        <SectionTitle>Sources and access</SectionTitle>
        <Card>
          <NavRow
            first
            title="Connectors"
            subtitle={connectorsSub}
            onPress={() => router.push('/connectors')}
          />
          <NavRow
            title="Permissions"
            subtitle={`${presetLabel(me.preset)} preset${c ? ` · ${plural(c.temporaryGrants, 'temporary grant')}` : ''}`}
            onPress={() => router.push('/permissions')}
          />
          <NavRow
            title="Connected agents"
            subtitle={
              clients.length ? `${clients.join(', ')} · MCP link` : 'Claude, Claude Code · MCP link'
            }
            onPress={() => router.push('/connected-agents')}
          />
        </Card>
      </View>

      <View style={{ gap: 6 }}>
        <SectionTitle>Intelligence</SectionTitle>
        <Card>
          <NavRow
            first
            title="Models"
            subtitle="A model per agent · your keys"
            onPress={() => router.push('/models')}
          />
          <NavRow
            title="Agents and rules"
            subtitle="Triage, Brief, Reply, Planner"
            onPress={() => router.push('/permissions')}
          />
        </Card>
      </View>

      <View style={{ gap: 6 }}>
        <SectionTitle>You</SectionTitle>
        <Card>
          <NavRow
            first
            title="Notifications"
            subtitle={
              me.settings.notificationsEnabled
                ? `${me.settings.vips.length ? 'VIPs instantly' : 'Approvals only'} · quiet ${q.start}–${q.end}`
                : 'Off · tap to set up'
            }
            onPress={() => router.push('/notifications')}
          />
          <NavRow
            title="Activity log"
            subtitle="Everything agents read and did"
            onPress={() => router.push('/activity')}
          />
          <NavRow
            title="Data and privacy"
            subtitle="Retention, export, delete all"
            onPress={() => router.push('/privacy')}
          />
        </Card>
      </View>
    </Screen>
  );
}
