import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { Preset } from '@hub/shared';
import { useMeRequired } from '@/lib/auth';
import { useUpdateMe } from '@/lib/queries';
import { errorMessage } from '@/lib/api';
import { colors } from '@/theme';
import { Txt } from '@/components/Txt';
import { Button, OptionCard, Pill, ToggleCard } from '@/components/ui';
import { goBack, Notice, Screen, StepHeader, StepTitle } from '@/components/layout';

type PresetT = ReturnType<typeof Preset.parse>;

const PRESETS: { value: PresetT; title: string; body: string; tag?: string }[] = [
  { value: 'cautious', title: 'Cautious', body: 'Read only. Agents suggest, you do everything.' },
  {
    value: 'balanced',
    title: 'Balanced',
    body: 'Tasks and drafts happen on their own. Anything that sends or changes a ticket asks you first.',
    tag: 'Recommended',
  },
  {
    value: 'hands',
    title: 'Hands-off',
    body: 'Small actions like labeling and closing done tasks run automatically. Sending still asks.',
  },
];

export default function PresetsScreen() {
  const me = useMeRequired();
  const [preset, setPreset] = useState<PresetT>(me.preset);
  const [strict, setStrict] = useState(me.strictPersonal);
  const update = useUpdateMe();

  return (
    <Screen
      footer={
        <>
          {update.isError ? <Notice text={errorMessage(update.error)} /> : null}
          <Button
            label="Continue"
            size="lg"
            loading={update.isPending}
            onPress={() =>
              update.mutate(
                { preset, strictPersonal: strict },
                { onSuccess: () => router.push('/models-setup') },
              )
            }
          />
        </>
      }
    >
      <StepHeader step={4} onBack={() => goBack('/connect')} />
      <StepTitle
        title="How much should agents do?"
        subtitle="Pick a starting point. You can fine-tune each agent and account later."
      />
      <View style={{ gap: 10 }}>
        {PRESETS.map((p) => (
          <OptionCard
            key={p.value}
            selected={preset === p.value}
            onPress={() => setPreset(p.value)}
            accessibilityLabel={`${p.title}. ${p.body}`}
            style={{ padding: 16, gap: 6 }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Txt size={17} weight={600}>
                {p.title}
              </Txt>
              {p.tag ? <Pill label={p.tag} tone="solid" /> : null}
            </View>
            <Txt size={13} lh={1.45} color={colors.body}>
              {p.body}
            </Txt>
          </OptionCard>
        ))}
      </View>
      <ToggleCard
        title="Stricter for personal accounts"
        subtitle="Personal Gmail stays read-only, hidden from coding agents"
        value={strict}
        onChange={setStrict}
      />
    </Screen>
  );
}
