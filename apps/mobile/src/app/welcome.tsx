import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useMutation } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { GOOGLE_CLIENT_IDS } from '@/lib/config';
import { colors } from '@/theme';
import { Label, Title, Txt } from '@/components/Txt';
import { Button, Input, LinkButton } from '@/components/ui';
import { Notice, Screen } from '@/components/layout';
import { Lock, Shield, Trash } from '@/components/icons';

WebBrowser.maybeCompleteAuthSession();

const platformGoogleId = Platform.select({
  ios: GOOGLE_CLIENT_IDS.ios,
  android: GOOGLE_CLIENT_IDS.android,
  default: GOOGLE_CLIENT_IDS.web,
});

const PROMISES = [
  { Icon: Lock, title: 'Read-only by default', body: 'Agents can look, not touch.' },
  { Icon: Shield, title: 'You approve every send', body: 'Nothing leaves without your tap.' },
  { Icon: Trash, title: 'Delete it all, anytime', body: 'One tap removes your data and tokens.' },
];

export default function Welcome() {
  const { signIn } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');

  const dev = useMutation({
    mutationFn: (e: string) => api.devSignIn(e.trim()),
    onSuccess: (res) => signIn(res),
  });

  return (
    <Screen
      padTop={56}
      padH={24}
      gap={24}
      footer={
        <>
          {notice ? <Notice text={notice} /> : null}
          <Button
            label="Continue with Apple"
            size="lg"
            variant="dark"
            onPress={() => setNotice('Sign in with Apple is coming soon. Use Google for now.')}
          />
          {platformGoogleId ? (
            <GoogleButton onError={setNotice} />
          ) : (
            <Button
              label="Continue with Google"
              size="lg"
              variant="outline"
              onPress={() =>
                setNotice(
                  __DEV__
                    ? 'Google sign-in needs EXPO_PUBLIC_GOOGLE_*_CLIENT_ID. Use the dev email sign-in below.'
                    : 'Google sign-in is not configured for this build.',
                )
              }
            />
          )}
          <LinkButton
            label="Use email and a passkey"
            onPress={() => setNotice('Passkeys are coming soon.')}
          />
          {__DEV__ ? (
            <View
              style={{
                gap: 8,
                padding: 12,
                borderRadius: 14,
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: colors.inputBorder,
              }}
            >
              <Label size={10}>DEV SIGN-IN</Label>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Input
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  accessibilityLabel="Dev sign-in email"
                  style={{ flex: 1 }}
                  onSubmitEditing={() => email.includes('@') && dev.mutate(email)}
                />
                <Button
                  label="Sign in"
                  size="md"
                  onPress={() => dev.mutate(email)}
                  disabled={!email.includes('@')}
                  loading={dev.isPending}
                />
              </View>
              {dev.isError ? (
                <Txt size={12} color={colors.amberDark}>
                  {errorMessage(dev.error)}
                </Txt>
              ) : null}
            </View>
          ) : null}
          <Txt size={12} lh={1.4} color={colors.secondary} align="center">
            {"Signing in doesn't connect your mail. You'll choose accounts next."}
          </Txt>
        </>
      }
    >
      <View style={{ gap: 16 }}>
        <Label em={0.1} color={colors.teal}>
          YOUR HUB
        </Label>
        <Title size={52} lh={0.98}>
          Everything you owe people, in one place.
        </Title>
        <Txt size={16} lh={1.5} color={colors.body}>
          Reads your email, chats and tickets across all your accounts, and turns them into one
          list.
        </Txt>
        <View style={{ gap: 14, marginTop: 12 }}>
          {PROMISES.map(({ Icon, title, body }) => (
            <View key={title} style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  backgroundColor: colors.tealTint,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon size={18} color={colors.teal} />
              </View>
              <View style={{ gap: 2, flex: 1 }}>
                <Txt size={15} weight={600}>
                  {title}
                </Txt>
                <Txt size={13} color={colors.secondary}>
                  {body}
                </Txt>
              </View>
            </View>
          ))}
        </View>
      </View>
    </Screen>
  );
}

/** Mounted only when a client ID exists for this platform (the hook throws without one). */
function GoogleButton({ onError }: { onError: (msg: string) => void }) {
  const { signIn } = useAuth();
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: GOOGLE_CLIENT_IDS.ios,
    androidClientId: GOOGLE_CLIENT_IDS.android,
    webClientId: GOOGLE_CLIENT_IDS.web,
    selectAccount: true,
  });
  const exchange = useMutation({
    mutationFn: (idToken: string) => api.googleSignIn(idToken),
    onSuccess: (res) => signIn(res),
    onError: (e) => onError(errorMessage(e)),
  });

  useEffect(() => {
    if (response?.type === 'success') {
      const idToken = response.params.id_token;
      if (idToken) exchange.mutate(idToken);
      else onError('Google did not return an ID token.');
    } else if (response?.type === 'error') {
      onError(response.error?.message ?? 'Google sign-in failed.');
    }
    // exchange.mutate is stable; run once per response
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  return (
    <Button
      label="Continue with Google"
      size="lg"
      variant="outline"
      disabled={!request}
      loading={exchange.isPending}
      onPress={() => void promptAsync()}
    />
  );
}
