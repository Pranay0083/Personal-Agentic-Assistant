import { useEffect } from 'react';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { LoadingState } from '@/components/layout';
import { qk } from '@/lib/queries';

/**
 * Landing route for the OAuth callback (hub://connected?accountId=…) when the deep link
 * opens the app instead of returning to the auth session.
 */
export default function Connected() {
  const qc = useQueryClient();
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: qk.accounts });
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [qc]);
  return <LoadingState label="Finishing up…" />;
}
