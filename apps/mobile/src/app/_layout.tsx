import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { InstrumentSerif_400Regular } from '@expo-google-fonts/instrument-serif/400Regular';
import { IBMPlexSans_400Regular } from '@expo-google-fonts/ibm-plex-sans/400Regular';
import { IBMPlexSans_500Medium } from '@expo-google-fonts/ibm-plex-sans/500Medium';
import { IBMPlexSans_600SemiBold } from '@expo-google-fonts/ibm-plex-sans/600SemiBold';
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import { AuthProvider, useAuth } from '@/lib/auth';
import { makeQueryClient } from '@/lib/queries';
import { useLiveEvents } from '@/lib/events';
import { setupNotificationHandler } from '@/lib/push';
import { colors } from '@/theme';
import { Title, Txt } from '@/components/Txt';
import { Button } from '@/components/ui';
import { ErrorState } from '@/components/layout';

void SplashScreen.preventAutoHideAsync();
setupNotificationHandler();

const queryClient = makeQueryClient();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    InstrumentSerif_400Regular,
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexMono_500Medium,
  });

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="dark" />
          <Root fontsReady={fontsLoaded || !!fontError} />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function Root({ fontsReady }: { fontsReady: boolean }) {
  const { status, token, error, retry, signOut } = useAuth();
  const ready = fontsReady && status !== 'loading';

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  useLiveEvents(token, status === 'ready');

  if (!ready) return null; // splash screen stays up

  if (status === 'error') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24, paddingTop: 96, gap: 16 }}>
        <Title size={36}>Your hub isn't answering.</Title>
        <Txt size={14} lh={1.45} color={colors.secondary}>
          The app couldn't reach your server. Your data is safe; nothing ran while you were away
          from it.
        </Txt>
        <ErrorState error={error} onRetry={retry} title="Connection problem" />
        <Button label="Sign out" variant="outline" onPress={() => void signOut()} />
      </View>
    );
  }

  const signedIn = status === 'onboarding' || status === 'ready';
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="welcome" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'onboarding'}>
        <Stack.Screen name="(onboarding)" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'ready'}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="item/[id]" />
        <Stack.Screen name="connectors" />
        <Stack.Screen name="account/[id]" />
        <Stack.Screen name="permissions" />
        <Stack.Screen name="models" />
        <Stack.Screen name="connected-agents" />
        <Stack.Screen name="notifications" />
        <Stack.Screen name="activity" />
        <Stack.Screen name="privacy" />
      </Stack.Protected>
      <Stack.Screen name="connected" />
    </Stack>
  );
}
