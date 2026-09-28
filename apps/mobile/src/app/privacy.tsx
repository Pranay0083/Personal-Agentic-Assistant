import { useState } from 'react';
import { View } from 'react-native';
import { useAuth, useMeRequired } from '@/lib/auth';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button, Card, NavRow, SectionTitle } from '@/components/ui';
import { BackLink, Notice, Screen } from '@/components/layout';

export default function PrivacyScreen() {
  const me = useMeRequired();
  const { signOut } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <Screen>
      <BackLink />
      <View style={{ gap: 6 }}>
        <Title size={36} lh={1}>
          Data and privacy
        </Title>
        <Txt size={13} lh={1.45} color={colors.secondary}>
          Your hub stores tokens encrypted and never sends them to this phone.
        </Txt>
      </View>
      {notice ? <Notice text={notice} /> : null}

      <View style={{ gap: 6 }}>
        <SectionTitle>Your data</SectionTitle>
        <Card>
          <NavRow
            first
            title="Retention"
            subtitle="How long bodies and summaries are kept"
            onPress={() => setNotice('Retention settings are coming soon.')}
          />
          <NavRow
            title="Export"
            subtitle="Download everything your hub holds"
            onPress={() => setNotice('Export is coming soon.')}
          />
          <NavRow
            title="Delete everything"
            subtitle={
              <Txt size={12} color={colors.amber}>
                Revokes every token and deletes all data
              </Txt>
            }
            onPress={() =>
              setNotice(
                'Delete everything is coming soon. To remove one account now, disconnect it on your hub.',
              )
            }
          />
        </Card>
      </View>

      <View style={{ gap: 6 }}>
        <SectionTitle>Session</SectionTitle>
        <Card style={{ padding: 14, gap: 10 }}>
          <Txt size={14} color={colors.body}>
            {`Signed in as ${me.email}`}
          </Txt>
          <Button
            label="Sign out"
            variant="outline"
            loading={signingOut}
            onPress={() => {
              setSigningOut(true);
              void signOut();
            }}
          />
        </Card>
      </View>
    </Screen>
  );
}
