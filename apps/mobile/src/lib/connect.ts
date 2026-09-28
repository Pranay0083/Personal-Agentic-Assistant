import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Provider } from '@hub/shared';
import { api } from './api';
import { qk } from './queries';

/**
 * hub://connected in standalone builds; exp://…/--/connected in Expo Go; the web origin on web.
 * Passed to the API as redirectUri (it allows the app scheme, and exp:// / localhost in dev).
 */
export const CONNECTED_REDIRECT = Linking.createURL('connected');

const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: 'You cancelled the sign-in. Nothing was connected.',
  oauth_error: 'The provider returned an error. Try again.',
  exchange_failed: "We couldn't finish connecting. Try again in a moment.",
  account_mismatch: 'That sign-in was for a different account than the one you are reconnecting.',
  already_connected: 'That account is already connected.',
};

export type ConnectOutcome =
  | { ok: true; accountId: string | null }
  | { ok: false; cancelled: boolean; message: string | null };

/** Parse hub://connected?accountId=… or ?error=… from the auth session result. */
export function parseConnectedUrl(url: string): ConnectOutcome {
  const { queryParams } = Linking.parse(url);
  const error = typeof queryParams?.error === 'string' ? queryParams.error : null;
  if (error)
    return {
      ok: false,
      cancelled: error === 'access_denied',
      message: CALLBACK_ERRORS[error] ?? `Connecting failed (${error}).`,
    };
  const accountId = typeof queryParams?.accountId === 'string' ? queryParams.accountId : null;
  return { ok: true, accountId };
}

/** POST /accounts/:provider/connect, open the consent page, then refetch accounts. */
export function useConnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: Provider): Promise<ConnectOutcome> => {
      const { url } = await api.connect(provider, CONNECTED_REDIRECT);
      const result = await WebBrowser.openAuthSessionAsync(url, CONNECTED_REDIRECT);
      if (result.type === 'success') return parseConnectedUrl(result.url);
      // cancel / dismiss: the user closed the browser. Not an error.
      return { ok: false, cancelled: true, message: null };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.accounts });
      void qc.invalidateQueries({ queryKey: qk.control });
    },
  });
}
