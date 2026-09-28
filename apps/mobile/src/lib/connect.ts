import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Provider } from '@hub/shared';
import { api, ApiError, errorMessage, type AccountT } from './api';
import { qk } from './queries';
import { accountUnit, serviceName } from './format';

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
  | {
      ok: true;
      accountId: string | null;
      /** Every account this consent added or refreshed (one consent can add several sites). */
      accounts: AccountT[];
      access: 'read' | 'write' | null;
    }
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
      (res): ConnectOutcome => ({
        ok: true,
        accountId: res.account.id,
        accounts: res.accounts,
        access: res.access,
      }),
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

/**
 * What to tell the user after a successful connect: "Added 2 Atlassian sites.",
 * "Connected Work (you@company.com).", or for write access "Sending is on for Work."
 */
export function connectedMessage(out: ConnectOutcome, verb?: string): string | null {
  if (!out.ok || out.accounts.length === 0) return null;
  const [first] = out.accounts;
  if (out.access === 'write') {
    return `${verb ?? 'Write access'} is on for ${first!.nickname}. Each one still waits for your approval.`;
  }
  if (out.accounts.length === 1) return `Connected ${first!.nickname} (${first!.externalId}).`;
  const n = out.accounts.length;
  return `Added ${n} ${serviceName(first!.provider)} ${accountUnit(first!.provider, n)}.`;
}

/** Search params a full-page redirect (web, deep link) uses to carry the result to Connect/Connectors. */
export type ConnectedNotice = { added?: string; access?: string; provider?: string };

export function noticeParams(out: ConnectOutcome): ConnectedNotice {
  if (!out.ok || !out.accounts.length) return {};
  return {
    added: String(out.accounts.length),
    access: out.access ?? 'read',
    provider: out.accounts[0]!.provider,
  };
}

/** Rebuilds the message from `noticeParams` (the accounts themselves are refetched). */
export function noticeFromParams(p: ConnectedNotice): string | null {
  const n = Number(p.added);
  if (!p.provider || !Number.isFinite(n) || n < 1) return null;
  if (p.access === 'write') return 'Write access is on. Each action still waits for your approval.';
  return n === 1
    ? `Connected a ${serviceName(p.provider)} ${accountUnit(p.provider, 1)}.`
    : `Added ${n} ${serviceName(p.provider)} ${accountUnit(p.provider, n)}.`;
}

async function runAuthSession(url: string): Promise<ConnectOutcome> {
  const result = await WebBrowser.openAuthSessionAsync(url, CONNECTED_REDIRECT);
  if (result.type === 'success') return finishConnect(parseConnectedUrl(result.url));
  // cancel / dismiss: the user closed the browser. Not an error.
  return { ok: false, cancelled: true, message: null };
}

/** POST /accounts/:provider/connect, open the consent page, complete it, then refetch accounts. */
export function useConnectAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (provider: Provider): Promise<ConnectOutcome> => {
      const { url } = await api.connect(provider, CONNECTED_REDIRECT);
      return runAuthSession(url);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.accounts });
      void qc.invalidateQueries({ queryKey: qk.control });
      void qc.invalidateQueries({ queryKey: qk.permissionsAll });
    },
  });
}

/**
 * POST /accounts/:id/write-access: a second, separate consent for the write scope (send,
 * post, update tickets). Only the executor uses that scope, and only for approved proposals.
 */
export function useWriteAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (accountId: string): Promise<ConnectOutcome> => {
      const { url } = await api.writeAccess(accountId, CONNECTED_REDIRECT);
      return runAuthSession(url);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.accounts });
      void qc.invalidateQueries({ queryKey: qk.permissionsAll });
    },
  });
}
