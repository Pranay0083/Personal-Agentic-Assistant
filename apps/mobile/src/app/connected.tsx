import { useEffect, useState } from 'react';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useQueryClient } from '@tanstack/react-query';
import { LoadingState, Notice, Screen } from '@/components/layout';
import { Title } from '@/components/Txt';
import { Button } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { finishConnect, noticeParams, type ConnectOutcome } from '@/lib/connect';
import { qk } from '@/lib/queries';

// On web the OAuth popup lands here; this hands the URL back to the opener and closes it.
// The opener then completes the connect itself, so this window must not.
const handedOff = WebBrowser.maybeCompleteAuthSession().type === 'success';

const one = (v: string | string[] | undefined) => (typeof v === 'string' && v ? v : null);

/**
 * Landing route for the OAuth callback (hub://connected?pending=… or ?error=…) when the
 * redirect opens the app directly instead of returning to the auth session (a deep link on
 * native, or a full-page redirect on web). It completes the pending connect with this
 * session, then sends the user to where connecting happens: Connect during onboarding,
 * Connectors after. There's no history to go back to.
 */
export default function Connected() {
  const qc = useQueryClient();
  const { status } = useAuth();
  const params = useLocalSearchParams<{ pending?: string; error?: string }>();
  const pending = one(params.pending);
  const error = one(params.error);
  const signedIn = status === 'onboarding' || status === 'ready';
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(
    pending || error ? null : { ok: true, accountId: null, accounts: [], access: null },
  );

  useEffect(() => {
    // Completing needs this device's session; signed out, the pending id simply expires.
    if (handedOff || !signedIn || outcome) return;
    let alive = true;
    void finishConnect({ pending, error }).then((out) => {
      if (!alive) return;
      void qc.invalidateQueries({ queryKey: qk.accounts });
      void qc.invalidateQueries({ queryKey: qk.control });
      setOutcome(out);
    });
    return () => {
      alive = false;
    };
  }, [qc, signedIn, pending, error, outcome]);

  useEffect(() => {
    void qc.invalidateQueries({ queryKey: qk.accounts });
  }, [qc]);

  const home = status === 'onboarding' ? '/connect' : '/connectors';
  if (handedOff) return <LoadingState label="Finishing up…" />;
  if (status === 'signedOut') return <Redirect href="/welcome" />;
  if (!signedIn || !outcome) return <LoadingState label="Finishing up…" />;
  if (outcome.ok) return <Redirect href={{ pathname: home, params: noticeParams(outcome) }} />;
  if (outcome.cancelled || !outcome.message) return <Redirect href={home} />;
  return (
    <Screen>
      <Title size={28}>Nothing was connected</Title>
      <Notice text={outcome.message} />
      <Button label="Back" size="lg" onPress={() => router.replace(home)} />
    </Screen>
  );
}
