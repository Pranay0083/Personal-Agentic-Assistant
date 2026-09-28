import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { useMeRequired } from '@/lib/auth';
import { useAccounts, useTasks, useUpdateMe, useUpdateTask } from '@/lib/queries';
import { errorMessage, type TaskT } from '@/lib/api';
import { dueText, plural, sourceLabel } from '@/lib/format';
import { enablePush } from '@/lib/push';
import { colors } from '@/theme';
import { Txt } from '@/components/Txt';
import { Button, Card, Dot, SourceTag } from '@/components/ui';
import {
  EmptyState,
  ErrorState,
  goBack,
  LoadingState,
  Notice,
  Screen,
  StepHeader,
  StepTitle,
} from '@/components/layout';

export default function FirstWinScreen() {
  const me = useMeRequired();
  const tasks = useTasks({ review: 'pending' });
  const accounts = useAccounts();
  const updateTask = useUpdateTask();
  const updateMe = useUpdateMe();
  const [answered, setAnswered] = useState<Record<string, { task: TaskT; yes: boolean }>>({});
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountList = accounts.data?.accounts ?? [];
  const byId = useMemo(() => new Map(accountList.map((a) => [a.id, a])), [accountList]);
  const days = accountList.reduce((m, a) => Math.max(m, a.backfillDays), 0) || 30;

  const shown = useMemo(() => {
    const fromServer = (tasks.data?.tasks ?? []).slice(0, 5);
    const ids = new Set(fromServer.map((t) => t.id));
    const kept = Object.values(answered)
      .map((a) => a.task)
      .filter((t) => !ids.has(t.id));
    return [...fromServer, ...kept].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [tasks.data, answered]);

  const answer = (task: TaskT, yes: boolean) => {
    setError(null);
    setAnswered((prev) => ({ ...prev, [task.id]: { task, yes } }));
    updateTask.mutate(
      { id: task.id, patch: { confirmedByUser: yes } },
      {
        onError: (e) => {
          setError(errorMessage(e));
          setAnswered((prev) => {
            const { [task.id]: _drop, ...rest } = prev;
            return rest;
          });
        },
      },
    );
  };

  const notificationsOn = me.settings.notificationsEnabled;
  const allow = async () => {
    setPushBusy(true);
    setPushNote(null);
    const res = await enablePush();
    setPushBusy(false);
    if (res.ok) updateMe.mutate({ settings: { notificationsEnabled: true } });
    else setPushNote(res.message);
  };

  const q = me.settings.quietHours;

  return (
    <Screen
      footer={
        <>
          {error || updateMe.isError ? (
            <Notice text={error ?? errorMessage(updateMe.error)} />
          ) : null}
          <Button
            label="Go to Today"
            size="lg"
            loading={updateMe.isPending}
            onPress={() => updateMe.mutate({ onboarded: true })}
          />
        </>
      }
    >
      <StepHeader step={7} onBack={() => goBack('/agents')} />
      <StepTitle
        title="Here's what we found."
        subtitle={
          accountList.length
            ? `From the last ${days} days across ${plural(accountList.length, 'account')}. Confirm a few so the agents learn what counts.`
            : 'Confirm a few so the agents learn what counts.'
        }
      />

      {tasks.isPending ? (
        <LoadingState compact label="Looking for tasks…" />
      ) : tasks.isError ? (
        <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : shown.length === 0 ? (
        <EmptyState
          title="Nothing to confirm yet"
          body="Your accounts are still importing. New tasks will show up in Today as they're found."
        />
      ) : (
        <View style={{ gap: 10 }}>
          {shown.map((t) => {
            const acct = t.accountId ? byId.get(t.accountId) : undefined;
            const due = dueText(t.dueAt).text;
            const meta = [acct?.nickname, due].filter(Boolean).join(' · ');
            const ans = answered[t.id];
            return (
              <Card key={t.id} style={{ padding: 14, gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {acct ? <Dot color={acct.color} size={9} /> : null}
                  <SourceTag label={sourceLabel(t.source ?? acct?.provider)} />
                  <Txt
                    size={12}
                    color={colors.secondary}
                    numberOfLines={1}
                    style={{ flexShrink: 1 }}
                  >
                    {meta}
                  </Txt>
                </View>
                <Txt size={15} weight={500}>
                  {t.title}
                </Txt>
                {ans ? (
                  <View
                    style={{ minHeight: 44, justifyContent: 'center' }}
                    accessibilityLiveRegion="polite"
                  >
                    <Txt size={13} weight={600} color={colors.tealDark}>
                      {ans.yes ? 'Added to Tasks' : 'Got it. Similar messages will be skipped.'}
                    </Txt>
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button
                      label="Yes, a task"
                      variant="teal"
                      grow
                      radius={10}
                      onPress={() => answer(t, true)}
                    />
                    <Button
                      label="Not a task"
                      variant="outline"
                      grow
                      radius={10}
                      weight={400}
                      onPress={() => answer(t, false)}
                    />
                  </View>
                )}
              </Card>
            );
          })}
        </View>
      )}

      <Card
        tone="tint"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 12,
          paddingHorizontal: 14,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Txt size={15} weight={600}>
            Get nudged when it matters
          </Txt>
          <Txt size={12} color={colors.tealTintBody}>
            {`Approvals and VIPs only. Quiet ${q.start}–${q.end}.`}
          </Txt>
        </View>
        {notificationsOn ? (
          <Button
            label="On"
            variant="tealOutline"
            radius={10}
            onPress={() => undefined}
            accessibilityLabel="Notifications are on"
          />
        ) : (
          <Button
            label="Allow"
            variant="teal"
            radius={10}
            loading={pushBusy}
            onPress={() => void allow()}
          />
        )}
      </Card>
      {pushNote ? <Notice text={pushNote} /> : null}
    </Screen>
  );
}
