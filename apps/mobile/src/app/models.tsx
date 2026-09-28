import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMeRequired } from '@/lib/auth';
import { qk, useModels, useUpdateMe } from '@/lib/queries';
import { agentName } from '@/lib/format';
import { api, errorMessage, type AgentConfigT, type ModelsT } from '@/lib/api';
import { colors, HIT } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, Dot, Row, SectionTitle, Toggle, ToggleCard } from '@/components/ui';
import { BackLink, ErrorState, LoadingState, Notice, Screen, Sheet } from '@/components/layout';
import { Check, Chevron } from '@/components/icons';
import { ProviderChips, ProviderFields, useProviderForm } from '@/components/ProviderForm';

type Entry = { key: string; label: string; providerId: string | null; model: string };

const AGENT_HINT: Record<string, (briefTime: string) => string> = {
  triage: () => 'Runs on every event',
  extractor: () => 'Pulls tasks from messages',
  brief: (t) => `Daily at ${t}`,
  reply: () => 'Drafts, never sends',
  planner: () => 'Weekly plan, big calls',
};

function modelsFromConfig(config: Record<string, string>): string[] {
  const list = [config.model, ...(config.models ?? '').split(',')];
  return [...new Set(list.map((m) => m?.trim()).filter((m): m is string => !!m))];
}

/** Picker entries: the hub's recommended Claude models, plus models on each of your providers. */
function buildEntries(data: ModelsT): Entry[] {
  const hub = data.options.filter((o) => o.providerKind === 'anthropic');
  const out: Entry[] = hub.map((o) => ({
    key: `hub:${o.model}`,
    label: o.label,
    providerId: null,
    model: o.model,
  }));
  for (const p of data.providers) {
    const models = new Set([
      ...modelsFromConfig(p.config),
      ...(p.kind === 'anthropic' ? hub.map((o) => o.model) : []),
    ]);
    for (const m of models) {
      const hubLabel = hub.find((o) => o.model === m)?.label;
      out.push({
        key: `${p.id}:${m}`,
        label: `${hubLabel ?? m} · ${p.label}`,
        providerId: p.id,
        model: m,
      });
    }
  }
  return out;
}

function entryFor(entries: Entry[], a: AgentConfigT): Entry | undefined {
  return entries.find((e) => e.providerId === a.providerId && e.model === a.model);
}

export default function ModelsScreen() {
  const me = useMeRequired();
  const qc = useQueryClient();
  const models = useModels();
  const updateMe = useUpdateMe();
  const [picking, setPicking] = useState<AgentConfigT | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(() => (models.data ? buildEntries(models.data) : []), [models.data]);

  const setAgent = useMutation({
    mutationFn: (a: AgentConfigT) =>
      api.setAgentModel(a.agent, {
        providerId: a.providerId,
        model: a.model,
        fallback: a.fallback,
      }),
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: qk.models });
      const prev = qc.getQueryData<ModelsT>(qk.models);
      if (prev)
        qc.setQueryData<ModelsT>(qk.models, {
          ...prev,
          agents: prev.agents.map((x) => (x.agent === a.agent ? a : x)),
        });
      return { prev };
    },
    onError: (e, _a, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.models, ctx.prev);
      setError(errorMessage(e));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.models }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeProvider(id),
    onError: (e) => setError(errorMessage(e)),
    onSettled: () => {
      setConfirmRemove(null);
      void qc.invalidateQueries({ queryKey: qk.models });
    },
  });

  return (
    <Screen gap={10} onRefresh={() => void models.refetch()} refreshing={models.isRefetching}>
      <BackLink />
      <View style={{ gap: 6 }}>
        <Title size={36} lh={1}>
          Models
        </Title>
        <Txt size={13} color={colors.secondary}>
          Pick a model per agent. Keys stay on your server.
        </Txt>
      </View>
      {error ? <Notice text={error} /> : null}

      {models.isPending ? (
        <LoadingState />
      ) : models.isError ? (
        <ErrorState error={models.error} onRetry={() => void models.refetch()} />
      ) : (
        <>
          <View style={{ gap: 6 }}>
            <SectionTitle>Agents</SectionTitle>
            <Card>
              {models.data.agents.map((a, i) => {
                const e = entryFor(entries, a);
                return (
                  <Row
                    key={a.agent}
                    first={i === 0}
                    style={{ paddingVertical: 12, paddingHorizontal: 14, gap: 8 }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                      }}
                    >
                      <Txt size={15} weight={500}>
                        {agentName(a.agent)}
                      </Txt>
                      <Txt size={12} color={colors.secondary}>
                        {AGENT_HINT[a.agent]?.(me.settings.briefTime) ?? ''}
                      </Txt>
                    </View>
                    <Pressable
                      onPress={() => setPicking(a)}
                      accessibilityRole="button"
                      accessibilityLabel={`${agentName(a.agent)} model: ${e?.label ?? a.model}. Change`}
                      style={{
                        minHeight: HIT,
                        paddingHorizontal: 12,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: colors.inputBorder,
                        backgroundColor: colors.bg,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <Txt size={14} style={{ flex: 1 }} numberOfLines={1}>
                        {e?.label ?? a.model}
                      </Txt>
                      {a.providerId && a.fallback ? (
                        <Txt size={11} color={colors.secondary}>
                          fallback on
                        </Txt>
                      ) : null}
                      <Chevron dir="down" size={14} color={colors.secondary} />
                    </Pressable>
                  </Row>
                );
              })}
            </Card>
          </View>

          <View style={{ gap: 6 }}>
            <SectionTitle>Providers</SectionTitle>
            <Card>
              {models.data.providers.map((p, i) => (
                <Row
                  key={p.id}
                  first={i === 0}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 52,
                    paddingVertical: 2,
                    paddingLeft: 14,
                    paddingRight: 10,
                  }}
                >
                  <View style={{ flex: 1, gap: 2, paddingVertical: 6 }}>
                    <Txt size={15} weight={500}>
                      {p.label}
                    </Txt>
                    <Txt
                      size={12}
                      color={p.status === 'error' ? colors.amberDark : colors.secondary}
                    >
                      {`${p.hasSecret ? 'Your key' : 'Your account'} · ${p.status === 'connected' ? 'connected' : p.status === 'error' ? 'error, check the key' : 'not verified yet'}`}
                    </Txt>
                  </View>
                  <Dot
                    size={8}
                    color={
                      p.status === 'connected'
                        ? colors.green
                        : p.status === 'error'
                          ? colors.amber
                          : colors.toggleOff
                    }
                  />
                  <Button
                    label={confirmRemove === p.id ? 'Confirm' : 'Remove'}
                    variant={confirmRemove === p.id ? 'warnOutline' : 'outline'}
                    radius={10}
                    textSize={13}
                    loading={remove.isPending && remove.variables === p.id}
                    onPress={() =>
                      confirmRemove === p.id ? remove.mutate(p.id) : setConfirmRemove(p.id)
                    }
                  />
                </Row>
              ))}
              <Row
                first={models.data.providers.length === 0}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 52,
                  paddingVertical: 2,
                  paddingLeft: 14,
                  paddingRight: 10,
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt size={15} weight={500}>
                    Your own provider
                  </Txt>
                  <Txt size={12} color={colors.secondary}>
                    Anthropic, OpenAI, Bedrock, Vertex and more
                  </Txt>
                </View>
                <Button
                  label="Add key"
                  variant="outline"
                  radius={10}
                  textSize={13}
                  onPress={() => setAdding(true)}
                />
              </Row>
              <Row
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  minHeight: 52,
                  paddingVertical: 2,
                  paddingLeft: 14,
                  paddingRight: 10,
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt size={15} weight={500}>
                    Local model
                  </Txt>
                  <Txt size={12} color={colors.secondary}>
                    Ollama on your Mac · coming soon
                  </Txt>
                </View>
                <Button
                  label="Set up"
                  variant="outline"
                  radius={10}
                  textSize={13}
                  disabled
                  onPress={() => undefined}
                />
              </Row>
            </Card>
          </View>
        </>
      )}

      <ToggleCard
        title="Keep email bodies local"
        subtitle="Cloud models see summaries only"
        value={me.settings.keepBodiesLocal}
        onChange={(v) =>
          updateMe.mutate(
            { settings: { keepBodiesLocal: v } },
            { onError: (e) => setError(errorMessage(e)) },
          )
        }
      />

      <PickerSheet
        agent={picking}
        entries={entries}
        onClose={() => setPicking(null)}
        onSave={(a) => {
          setPicking(null);
          setError(null);
          setAgent.mutate(a);
        }}
      />
      <AddProviderSheet visible={adding} onClose={() => setAdding(false)} />
    </Screen>
  );
}

function PickerSheet({
  agent,
  entries,
  onClose,
  onSave,
}: {
  agent: AgentConfigT | null;
  entries: Entry[];
  onClose: () => void;
  onSave: (a: AgentConfigT) => void;
}) {
  return (
    <Sheet visible={!!agent} onClose={onClose} title={agent ? agentName(agent.agent) : ''}>
      {agent ? <Picker key={agent.agent} agent={agent} entries={entries} onSave={onSave} /> : null}
    </Sheet>
  );
}

function Picker({
  agent,
  entries,
  onSave,
}: {
  agent: AgentConfigT;
  entries: Entry[];
  onSave: (a: AgentConfigT) => void;
}) {
  const [sel, setSel] = useState<Entry | undefined>(entryFor(entries, agent));
  const [fallback, setFallback] = useState(agent.fallback);
  return (
    <View style={{ gap: 10 }}>
      {entries.map((e) => {
        const on = sel?.key === e.key;
        return (
          <Pressable
            key={e.key}
            onPress={() => setSel(e)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            style={{
              minHeight: 48,
              paddingHorizontal: 14,
              borderRadius: 12,
              borderWidth: on ? 2 : 1,
              borderColor: on ? colors.teal : colors.border,
              backgroundColor: on ? colors.tealTint : colors.white,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Txt
              size={14}
              weight={on ? 600 : 400}
              color={on ? colors.tealDark : colors.ink}
              style={{ flex: 1 }}
            >
              {e.label}
            </Txt>
            {on ? <Check color={colors.teal} /> : null}
          </Pressable>
        );
      })}
      {entries.length <= 3 ? (
        <Txt size={12} color={colors.secondary}>
          Add a provider with a model name to see more choices here.
        </Txt>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt size={14} weight={500}>
            {"Fall back if it's down"}
          </Txt>
          <Txt size={12} color={colors.secondary}>
            Switch to Recommended until it recovers
          </Txt>
        </View>
        <Toggle value={fallback} onChange={setFallback} label="Fall back if the provider is down" />
      </View>
      <Button
        label="Save"
        size="lg"
        disabled={!sel}
        onPress={() =>
          sel &&
          onSave({ agent: agent.agent, providerId: sel.providerId, model: sel.model, fallback })
        }
      />
    </View>
  );
}

function AddProviderSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const form = useProviderForm('anthropic');
  const add = useMutation({
    mutationFn: () => api.addProvider(form.build()),
    onSuccess: () => {
      form.clear();
      void qc.invalidateQueries({ queryKey: qk.models });
      onClose();
    },
  });
  return (
    <Sheet
      visible={visible}
      onClose={() => {
        form.clear();
        onClose();
      }}
      title="Add a provider"
      footer={
        <Button
          label="Save to my hub"
          size="lg"
          onPress={() => add.mutate()}
          disabled={!form.complete}
          loading={add.isPending}
        />
      }
    >
      <Txt size={13} lh={1.45} color={colors.secondary}>
        Keys go straight to your hub, are encrypted there, and are never stored on this phone.
      </Txt>
      <ProviderChips form={form} />
      <ProviderFields form={form} />
      {add.isError ? <Notice text={errorMessage(add.error)} /> : null}
    </Sheet>
  );
}
