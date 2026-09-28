import { router } from 'expo-router';
import { Button } from '@/components/ui';
import { goBack, Screen, StepHeader, StepTitle } from '@/components/layout';
import { AgentsConnect } from '@/components/AgentsConnect';

export default function AgentsScreen() {
  return (
    <Screen
      footer={<Button label="Continue" size="lg" onPress={() => router.push('/first-win')} />}
    >
      <StepHeader
        step={6}
        onBack={() => goBack('/models-setup')}
        onSkip={() => router.push('/first-win')}
      />
      <StepTitle
        title="Connect your agents"
        subtitle="Give Claude and your coding tools your context, with the limits you set. Each gets its own key."
      />
      <AgentsConnect />
    </Screen>
  );
}
