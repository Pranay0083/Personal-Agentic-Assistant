import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Provider } from '@hub/shared';
import { api, ApiError, errorMessage } from './api';
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
  missing_scope:
    "The sign-in didn't grant the access Hub asked for, so nothing was connected. Try again and keep the requested permissions.",
  connect_user_mismatch:
    "This sign-in was started from a different Hub account, so nothing was connected. If you didn't start it, ignore the link and connect from this app.",
  connect_expired: 'That sign-in expired or was already used. Start connecting again.',
  account_not_found: 'That account is no longer connected. Connect it again.',
  invalid_state: 'That sign-in link is invalid or expired. Start connecting again.',
};

export type ConnectOutcome =
  | { ok: true; accountId: string | null }
  | { ok: false; cancelled: boolean; message: string | null };

const failure = (code: string): ConnectOutcome => ({
  ok: false,
  cancelled: code === 'access_denied',
  message: CALLBACK_ERRORS[code] ?? `Connecting failed (${code}).`,
});

/** What the hub put on hub://connected: ?pending=… on success, ?error=… on failure. */
export type ConnectedParams = { pending: string | null; error: string | null };

export function parseConnectedUrl(url: string): ConnectedParams {
  const { queryParams } = Linking.parse(url);
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { pending: str(queryParams?.pending), error: str(queryParams?.error) };
}

// The same redirect can reach both the auth session and the /connected route (Android
// deep links), so each pending id is completed once and both callers share the result.
const completions = new Map<string, Promise<ConnectOutcome>>();

/** POST /accounts/complete for a pending id, once. Never throws. */
export function completePending(pending: string): Promise<ConnectOutcome> {
  let p = completions.get(pending);
  if (!p) {
    p = api.completeConnect(pending).then(
      (res): ConnectOutcome => ({ ok: true, accountId: res.account.id }),
      (e: unknown): ConnectOutcome =>
        e instanceof ApiError && CALLBACK_ERRORS[e.code]
          ? failure(e.code)
          : { ok: false, cancelled: false, message: errorMessage(e) },
    );
    completions.set(pending, p);
  }
  return p;
}

/** Turns the callback params into an outcome, completing the connect if there is one. */
export async function finishConnect(params: ConnectedParams): Promise<ConnectOutcome> {
  if (params.error) return failure(params.error);
  if (params.pending) return completePending(params.pending);
  return failure('exchange_failed');
}

/** POST /accounts/:provider/connect, open the consent page, complete it, then refetch accounts. */
export function useConnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: Provider): Promise<ConnectOutcome> => {
      const { url } = await api.connect(provider, CONNECTED_REDIRECT);
      const result = await WebBrowser.openAuthSessionAsync(url, CONNECTED_REDIRECT);
      if (result.type === 'success') return finishConnect(parseConnectedUrl(result.url));
      // cancel / dismiss: the user closed the browser. Not an error.
      return { ok: false, cancelled: true, message: null };
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.accounts });
      void qc.invalidateQueries({ queryKey: qk.control });
    },
  });
}
