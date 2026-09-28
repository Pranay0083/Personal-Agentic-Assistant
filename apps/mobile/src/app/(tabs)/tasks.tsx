import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useCreateTask, useTasks, useUpdateTask } from '@/lib/queries';
import { useAccountMap, useNow } from '@/lib/hooks';
import { dayDiff, dayLabel, dueText, sourceLabel } from '@/lib/format';
import { errorMessage, type TaskT } from '@/lib/api';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, Checkbox, Chip, Field, Row, Segmented, SourceTag } from '@/components/ui';
import { EmptyState, ErrorState, LoadingState, Notice, Screen, Sheet } from '@/components/layout';

type View_ = 'today' | 'week' | 'project';
type Group = { key: string; title: string; tone?: 'amber'; tasks: TaskT[] };

function byDue(a: TaskT, b: TaskT) {
  if (!a.dueAt) return b.dueAt ? 1 : a.createdAt.localeCompare(b.createdAt);
  if (!b.dueAt) return -1;
  return a.dueAt.localeCompare(b.dueAt);
}

function group(tasks: TaskT[], view: View_, now: Date): Group[] {
  const sorted = [...tasks].sort(byDue);
  const diffOf = (t: TaskT) => (t.dueAt ? dayDiff(new Date(t.dueAt), now) : null);
  const overdue = sorted.filter((t) => t.status === 'open' && (diffOf(t) ?? 0) < 0);
  const rest = sorted.filter((t) => !overdue.includes(t));
  const groups: Group[] = [];
  if (overdue.length)
    groups.push({ key: 'overdue', title: 'Overdue', tone: 'amber', tasks: overdue });

  if (view === 'today') {
    const d = (t: TaskT) => diffOf(t);
    groups.push({
      key: 'today',
      title: 'Today',
      tasks: rest.filter((t) => (d(t) ?? 99) <= 0 && t.dueAt),
    });
    groups.push({
      key: 'week',
      title: 'Later this week',
      tasks: rest.filter((t) => {
        const x = d(t);
        return x !== null && x >= 1 && x <= 6;
      }),
    });
    groups.push({
      key: 'later',
      title: 'Later',
      tasks: rest.filter((t) => {
        const x = d(t);
        return x !== null && x > 6;
      }),
    });
    groups.push({ key: 'none', title: 'No date', tasks: rest.filter((t) => !t.dueAt) });
  } else if (view === 'week') {
    for (let i = 0; i < 7; i++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      groups.push({
        key: `d${i}`,
        title: dayLabel(day, now),
        tasks: rest.filter((t) => diffOf(t) === i),
      });
    }
  } else {
    const map = new Map<string, TaskT[]>();
    for (const t of rest) {
      const k = t.project ?? '';
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    const keys = [...map.keys()].sort((a, b) =>
      a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
    );
    for (const k of keys)
      groups.push({ key: `p:${k}`, title: k || 'No project', tasks: map.get(k)! });
  }
  return groups.filter((g) => g.tasks.length > 0);
}

export default function TasksScreen() {
  const tasks = useTasks({ status: 'open' });
  const update = useUpdateTask();
  const accounts = useAccountMap();
  const nowMs = useNow();
  const now = new Date(nowMs);
  const [view, setView] = useState<View_>('today');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tasks completed on this screen stay visible (checked) so they can be undone.
  const [recent, setRecent] = useState<Record<string, TaskT>>({});

  const list = useMemo(() => {
    const server = tasks.data?.tasks ?? [];
    const ids = new Set(server.map((t) => t.id));
    return [
      ...server.map((t) => recent[t.id] ?? t),
      ...Object.values(recent).filter((t) => !ids.has(t.id)),
    ];
  }, [tasks.data, recent]);
  const open = list.filter((t) => t.status === 'open');
  const overdueCount = open.filter((t) => t.dueAt && dayDiff(new Date(t.dueAt), now) < 0).length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => group(list, view, now), [list, view, nowMs]);

  const toggle = (t: TaskT) => {
    setError(null);
    const status = t.status === 'done' ? 'open' : 'done';
    setRecent((r) => ({ ...r, [t.id]: { ...t, status } }));
    update.mutate(
      { id: t.id, patch: { status } },
      {
        onError: (e) => {
          setError(errorMessage(e));
          setRecent((r) => {
            const { [t.id]: _drop, ...rest } = r;
            return rest;
          });
        },
      },
    );
  };

  return (
    <Screen
      padTop={28}
      gap={16}
      bottomInset={false}
      onRefresh={() => void tasks.refetch()}
      refreshing={tasks.isRefetching}
    >
      <View
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}
      >
        <View style={{ gap: 4 }}>
          <Title size={40} lh={1}>
            Tasks
          </Title>
          <Txt size={13} color={colors.secondary}>
            {tasks.isSuccess ? `${open.length} open · ${overdueCount} overdue` : ' '}
          </Txt>
        </View>
        <Button label="+ New" radius={22} onPress={() => setCreating(true)} />
      </View>
      <Segmented<View_>
        value={view}
        onChange={setView}
        height={38}
        options={[
          { value: 'today', label: 'Today' },
          { value: 'week', label: 'This week' },
          { value: 'project', label: 'By project' },
        ]}
      />
      {error ? <Notice text={error} /> : null}
      {tasks.isPending ? (
        <LoadingState />
      ) : tasks.isError ? (
        <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState
          title={view === 'week' ? 'Nothing due this week' : 'No open tasks'}
          body="Tasks appear here when agents find requests in your accounts, or when you add one."
        />
      ) : (
        groups.map((g) => (
          <View key={g.key} style={{ gap: 8 }}>
            <Txt
              size={13}
              weight={600}
              color={g.tone === 'amber' ? colors.amber : colors.secondary}
              accessibilityRole="header"
            >
              {g.title}
            </Txt>
            <Card>
              {g.tasks.map((t, i) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  first={i === 0}
                  now={now}
                  source={sourceLabel(
                    t.source ?? (t.accountId ? accounts.get(t.accountId)?.provider : null),
                  )}
                  onToggle={() => toggle(t)}
                />
              ))}
            </Card>
          </View>
        ))
      )}
      <NewTaskSheet visible={creating} onClose={() => setCreating(false)} />
    </Screen>
  );
}

function TaskRow({
  task,
  first,
  now,
  source,
  onToggle,
}: {
  task: TaskT;
  first: boolean;
  now: Date;
  source: string;
  onToggle: () => void;
}) {
  const done = task.status === 'done';
  const due = dueText(task.dueAt, now);
  const extra = task.project ?? task.notes;
  return (
    <Row first={first}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={task.title}
        style={{
          flexDirection: 'row',
          gap: 12,
          alignItems: 'flex-start',
          paddingVertical: 12,
          paddingHorizontal: 14,
          minHeight: 44,
        }}
      >
        <View style={{ marginTop: 1 }}>
          <Checkbox checked={done} />
        </View>
        <View style={{ flex: 1, gap: 5 }}>
          <Txt
            size={15}
            weight={500}
            color={done ? colors.secondary : colors.ink}
            style={done ? { textDecorationLine: 'line-through' } : undefined}
          >
            {task.title}
          </Txt>
          <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {task.source || task.accountId ? <SourceTag label={source} /> : null}
            {due.text ? (
              <Txt
                size={12}
                weight={due.overdue ? 500 : 400}
                color={due.overdue && !done ? colors.amber : colors.secondary}
              >
                {due.text}
              </Txt>
            ) : null}
            {extra ? (
              <Txt size={12} color={colors.secondary} numberOfLines={1} style={{ flexShrink: 1 }}>
                {due.text ? `· ${extra}` : extra}
              </Txt>
            ) : null}
          </View>
        </View>
      </Pressable>
    </Row>
  );
}

type DueChoice = 'none' | 'today' | 'tomorrow' | 'friday';

function dueFor(choice: DueChoice): string | null {
  const n = new Date();
  const at = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 0).toISOString();
  if (choice === 'today') return at(n);
  if (choice === 'tomorrow') return at(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
  if (choice === 'friday') {
    const add = (5 - n.getDay() + 7) % 7 || 7;
    return at(new Date(n.getFullYear(), n.getMonth(), n.getDate() + add));
  }
  return null;
}

function NewTaskSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const create = useCreateTask();
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  const [due, setDue] = useState<DueChoice>('today');

  const submit = () =>
    create.mutate(
      { title: title.trim(), dueAt: dueFor(due), project: project.trim() || null },
      {
        onSuccess: () => {
          setTitle('');
          setProject('');
          setDue('today');
          onClose();
        },
      },
    );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="New task"
      footer={
        <Button
          label="Add task"
          size="lg"
          onPress={submit}
          disabled={!title.trim()}
          loading={create.isPending}
        />
      }
    >
      <Field
        label="What needs doing"
        value={title}
        onChangeText={setTitle}
        placeholder="Send Q3 deck outline"
        autoFocus
      />
      <View style={{ gap: 6 }}>
        <Txt size={12} weight={600} color={colors.secondary}>
          Due
        </Txt>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {(
            [
              ['today', 'Today'],
              ['tomorrow', 'Tomorrow'],
              ['friday', 'Friday'],
              ['none', 'No date'],
            ] as const
          ).map(([v, l]) => (
            <Chip key={v} label={l} on={due === v} onPress={() => setDue(v)} minHeight={40} />
          ))}
        </View>
      </View>
      <Field
        label="Project (optional)"
        value={project}
        onChangeText={setProject}
        placeholder="Q3 planning"
      />
      {create.isError ? <Notice text={errorMessage(create.error)} /> : null}
    </Sheet>
  );
}
