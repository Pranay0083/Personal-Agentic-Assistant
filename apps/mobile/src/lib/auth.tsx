import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  setSessionToken,
  setUnauthorizedHandler,
  type MeT,
  type SignInT,
} from './api';
import { currentPushToken, forgetPushToken } from './push';
import { clearToken, loadToken, saveToken } from './token';
import { qk, useMe } from './queries';

export type AuthStatus = 'loading' | 'signedOut' | 'onboarding' | 'ready' | 'error';

type AuthCtx = {
  status: AuthStatus;
  token: string | null;
  me: MeT | undefined;
  error: unknown;
  retry: () => void;
  signIn: (res: SignInT) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // undefined = still reading secure storage
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void loadToken().then((t) => {
      if (!alive) return;
      setSessionToken(t);
      setToken(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  const dropSession = useCallback(async () => {
    setSessionToken(null);
    await clearToken();
    qc.clear();
    setToken(null);
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(() => void dropSession());
    return () => setUnauthorizedHandler(null);
  }, [dropSession]);

  const meQuery = useMe(!!token);

  const signIn = useCallback(
    async (res: SignInT) => {
      await saveToken(res.token);
      setSessionToken(res.token);
      qc.setQueryData(qk.me, res.user);
      setToken(res.token);
    },
    [qc],
  );

  const signOut = useCallback(async () => {
    try {
      // Unregister this device's push token too, so it stops getting this user's notifications.
      await api.signOut(await currentPushToken());
    } catch {
      // Sign out locally even if the server is unreachable.
    }
    forgetPushToken();
    await dropSession();
  }, [dropSession]);

  let status: AuthStatus;
  if (token === undefined) status = 'loading';
  else if (token === null) status = 'signedOut';
  else if (meQuery.data) status = meQuery.data.onboardedAt ? 'ready' : 'onboarding';
  else if (meQuery.isError) {
    status =
      meQuery.error instanceof ApiError && meQuery.error.status === 401 ? 'signedOut' : 'error';
  } else status = 'loading';

  const { refetch } = meQuery;
  const value = useMemo<AuthCtx>(
    () => ({
      status,
      token: token ?? null,
      me: meQuery.data,
      error: meQuery.error,
      retry: () => void refetch(),
      signIn,
      signOut,
    }),
    [status, token, meQuery.data, meQuery.error, refetch, signIn, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** The signed-in user. Only call from screens behind the auth guard. */
export function useMeRequired(): MeT {
  const { me } = useAuth();
  if (!me) throw new Error('No user');
  return me;
}
