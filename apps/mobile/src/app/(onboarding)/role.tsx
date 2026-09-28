import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { Role } from '@hub/shared';
import { useAuth, useMeRequired } from '@/lib/auth';
import { useUpdateMe } from '@/lib/queries';
import { errorMessage } from '@/lib/api';
import { colors } from '@/theme';
import { Txt } from '@/components/Txt';
import { Button, OptionCard } from '@/components/ui';
import { Notice, Screen, StepHeader, StepTitle } from '@/components/layout';

type RoleT = ReturnType<typeof Role.parse>;

const ROLES: { value: RoleT; title: string; hint: string }[] = [
  { value: 'build', title: 'Build software', hint: 'GitHub, Jira, Slack' },
  { value: 'lead', title: 'Lead a team', hint: 'Calendar, Slack, Jira' },
  { value: 'run', title: 'Run a business', hint: 'Email, Notion, Calendar' },
  { value: 'student', title: 'Student', hint: 'Gmail, Calendar, Notion, due dates' },
  { value: 'mix', title: 'A bit of everything', hint: 'We will suggest as we go' },
];

export default function RoleScreen() {
  const me = useMeRequired();
  const { signOut } = useAuth();
  const [role, setRole] = useState<RoleT>(me.role ?? 'build');
  const update = useUpdateMe();

  const next = () => update.mutate({ role }, { onSuccess: () => router.push('/connect') });

  return (
    <Screen
      gap={16}
      footer={
        <>
          {update.isError ? <Notice text={errorMessage(update.error)} /> : null}
          <Button label="Continue" size="lg" onPress={next} loading={update.isPending} />
        </>
      }
    >
      <StepHeader step={1} onBack={() => void signOut()} onSkip={() => router.push('/connect')} />
      <View style={{ marginTop: 4 }}>
        <StepTitle
          size={36}
          title="What do you mostly do?"
          subtitle="We'll suggest accounts and agents to start with."
        />
      </View>
      <View style={{ gap: 10 }}>
        {[ROLES.slice(0, 2), ROLES.slice(2, 4), ROLES.slice(4)].map((rowRoles, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
            {rowRoles.map((r) => (
              <OptionCard
                key={r.value}
                selected={role === r.value}
                onPress={() => setRole(r.value)}
                accessibilityLabel={`${r.title}. ${r.hint}`}
                style={{
                  flex: 1,
                  minHeight: r.value === 'mix' ? 84 : 132,
                  padding: 16,
                  justifyContent: 'flex-end',
                  gap: 6,
                }}
              >
                <Txt size={16} weight={600}>
                  {r.title}
                </Txt>
                <Txt size={12} lh={1.4} color={colors.secondary}>
                  {r.hint}
                </Txt>
              </OptionCard>
            ))}
          </View>
        ))}
      </View>
    </Screen>
  );
}
