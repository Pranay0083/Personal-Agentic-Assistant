import { useEffect } from 'react';
import { Redirect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useQueryClient } from '@tanstack/react-query';
import { LoadingState } from '@/components/layout';
import { useAuth } from '@/lib/auth';
import { qk } from '@/lib/queries';

// On web the OAuth popup lands here; this hands the URL back to the opener and closes it.
WebBrowser.maybeCompleteAuthSession();

/**
 * Landing route for the OAuth callback (hub://connected?accountId=…) when the redirect
 * opens the app directly instead of returning to the auth session (a deep link on
 * native, or a full-page redirect on web). There's no history to go back to, so send
 * the user to where connecting happens: Connect during onboarding, Connectors after.
 */
export default function Connected() {
  const qc = useQueryClient();
  const { status } = useAuth();
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: qk.accounts });
  }, [qc]);
  if (status === 'onboarding') return <Redirect href="/connect" />;
  if (status === 'ready') return <Redirect href="/connectors" />;
  if (status === 'signedOut') return <Redirect href="/welcome" />;
  return <LoadingState label="Finishing up…" />;
}
