import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/queries';
import { colors } from '@/theme';
import { Label, Txt } from '@/components/Txt';
import { Button, Card, Row, Segmented, ToggleCard } from '@/components/ui';
import { goBack, Notice, Screen, StepHeader, StepTitle } from '@/components/layout';
import { ProviderChips, ProviderFields, useProviderForm } from '@/components/ProviderForm';

type Mode = 'rec' | 'key' | 'local';

const MODES: { value: Mode; label: string; body: string }[] = [
  {
    value: 'rec',
    label: 'Recommended',
    body: 'A fast model for triage, stronger ones for writing and planning.',
  },
  {
    value: 'key',
    label: 'Own provider',
    body: 'Use your own cloud, API key or router, and your own billing.',
  },
  { value: 'local', label: 'Local only', body: 'Runs on your Mac. Most private.' },
];

const RECOMMENDED = [
  ['Triage', 'HAIKU 4.5'],
  ['Brief and replies', 'SONNET 5'],
  ['Planning', 'OPUS 5.5'],
] as const;

export default function ModelsSetupScreen() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('rec');
  const [fallback, setFallback] = useState(true);
  const form = useProviderForm('bedrock');

  const save = useMutation({
    mutationFn: async () => {
      if (mode !== 'key' || !form.touched) return;
      // The key goes straight to the server (encrypted there); it is never persisted on the phone.
      await api.addProvider(form.build());
      form.clear();
      const models = await api.models();
      await Promise.all(
        models.agents
          .filter((a) => a.fallback !== fallback)
          .map((a) =>
            api.setAgentModel(a.agent, { providerId: a.providerId, model: a.model, fallback }),
          ),
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.models });
      router.push('/agents');
    },
  });

  const current = MODES.find((m) => m.value === mode)!;
  const blocked = mode === 'key' && form.touched && !form.complete;

  return (
    <Screen
      gap={12}
      footer={
        <>
          {save.isError ? <Notice text={errorMessage(save.error)} /> : null}
          {mode === 'key' && !form.touched ? (
            <Txt size={12} color={colors.secondary} align="center">
              No key yet? Continue with Recommended and add one later in Control → Models.
            </Txt>
          ) : null}
          <Button
            label="Continue"
            size="lg"
            onPress={() => save.mutate()}
            loading={save.isPending}
            disabled={blocked}
          />
        </>
      }
    >
      <StepHeader step={5} onBack={() => goBack('/presets')} />
      <StepTitle
        title="Choose your models"
        subtitle="Change any agent later. Keys stay encrypted on your server, never on this phone."
      />
      <Segmented<Mode> value={mode} onChange={setMode} options={MODES} />
      <Txt size={13} lh={1.45} color={colors.body} style={{ marginTop: -4 }}>
        {current.body}
      </Txt>

      {mode === 'rec' ? (
        <Card>
          {RECOMMENDED.map(([agent, model], i) => (
            <Row
              key={agent}
              first={i === 0}
              style={{
                minHeight: 44,
                paddingHorizontal: 14,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Txt size={14}>{agent}</Txt>
              <Label size={12} em={0} color={colors.tealDark}>
                {model}
              </Label>
            </Row>
          ))}
        </Card>
      ) : null}

      {mode === 'key' ? (
        <View style={{ gap: 12 }}>
          <ProviderChips form={form} />
          <ProviderFields form={form} />
          <ToggleCard
            title="Fall back if it's down"
            subtitle="Switch to Recommended until it recovers"
            value={fallback}
            onChange={setFallback}
          />
        </View>
      ) : null}

      {mode === 'local' ? (
        <Notice text="Needs the Mac helper with Ollama running. Slower, and your data never leaves your machine. The Mac helper is coming soon; agents use Recommended until then." />
      ) : null}
    </Screen>
  );
}
