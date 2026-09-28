import { useEffect } from 'react';
import { AppState } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { LiveEvent } from '@hub/shared/queues';
import { deviceTimezone, type ControlT } from './api';
import { API_URL } from './config';
import { qk } from './queries';

type LiveEventT = ReturnType<typeof LiveEvent.parse>;

/**
 * The contract allows `?token=` because browser EventSource can't set headers. expo/fetch can,
 * and the API accepts a bearer header on /events too, so the session token stays out of URLs
 * (and out of access logs).
 */
const TOKEN_IN_QUERY = false;

function applyEvent(qc: QueryClient, ev: LiveEventT) {
  const inv = (queryKey: readonly unknown[]) => void qc.invalidateQueries({ queryKey });
  switch (ev.type) {
    case 'item.created':
      inv(qk.itemsAll);
      inv(qk.today);
      break;
    case 'item.updated':
      inv(qk.itemsAll);
      inv(qk.item(ev.itemId));
      inv(qk.today);
      break;
    case 'task.created':
    case 'task.updated':
      inv(qk.tasksAll);
      inv(qk.today);
      break;
    case 'proposal.created':
    case 'proposal.updated':
      inv(qk.proposals);
      inv(qk.today);
      inv(qk.itemsAll);
      break;
    case 'access_request.created':
      inv(qk.accessRequests);
      break;
    case 'account.updated':
      inv(qk.accounts);
      inv(qk.control);
      inv(qk.today);
      break;
    case 'brief.created':
      inv(qk.today);
      break;
    case 'control.changed': {
      const prev = qc.getQueryData<ControlT>(qk.control);
      if (prev) qc.setQueryData<ControlT>(qk.control, { ...prev, paused: ev.paused });
      inv(qk.control);
      inv(qk.me);
      break;
    }
  }
}

/** Parse one SSE frame ("event: x\ndata: {...}\n\n") into its data payload. */
function frameData(frame: string): string | null {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? data.join('\n') : null;
}

/**
 * Subscribes to GET /events while the app is in the foreground and invalidates the
 * matching queries on each LiveEvent. Reconnects with exponential backoff (1s → 30s).
 */
export function useLiveEvents(token: string | null, enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!token || !enabled) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let connectedOnce = false;
    let foreground = AppState.currentState !== 'background';

    const schedule = () => {
      if (stopped || !foreground) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    const connect = async () => {
      retryTimer = null;
      if (stopped || !foreground) return;
      const mine = new AbortController();
      controller = mine;
      try {
        const url = TOKEN_IN_QUERY
          ? `${API_URL}/events?token=${encodeURIComponent(token)}`
          : `${API_URL}/events`;
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (!TOKEN_IN_QUERY) headers.Authorization = `Bearer ${token}`;
        const tz = deviceTimezone();
        if (tz) headers['X-Timezone'] = tz;
        const res = await expoFetch(url, {
          headers,
          signal: mine.signal,
        });
        if (res.status === 401) return; // session gone; the REST client handles sign-out
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        attempt = 0;
        // Anything could have changed while we were disconnected.
        if (connectedOnce) void qc.invalidateQueries();
        connectedOnce = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
            const data = frameData(frame);
            if (!data) continue; // comment / heartbeat
            try {
              const parsed = LiveEvent.safeParse(JSON.parse(data));
              if (parsed.success) applyEvent(qc, parsed.data);
            } catch {
              // ignore malformed frames
            }
          }
        }
      } catch {
        // network error or abort; fall through to reconnect
      }
      if (controller !== mine) return; // superseded (went to background and back)
      controller = null;
      if (!stopped) schedule();
    };

    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'inactive') return; // transient (control center, app switcher)
      const nowForeground = s === 'active';
      if (nowForeground === foreground) return;
      foreground = nowForeground;
      if (foreground) {
        attempt = 0;
        if (!controller && !retryTimer) void connect();
      } else {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        controller?.abort();
        controller = null;
      }
    });

    void connect();
    return () => {
      stopped = true;
      sub.remove();
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [token, enabled, qc]);
}
