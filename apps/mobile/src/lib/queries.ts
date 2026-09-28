import {
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  api,
  ApiError,
  type AccessRequestsResT,
  type ControlT,
  type ItemsFilter,
  type MeT,
  type PermissionsT,
  type ProposalsResT,
  type SetPolicy,
  type TaskT,
  type TasksFilter,
  type TasksResT,
  type TodayT,
  type UpdateMe,
  type UpdateTask,
} from './api';

export const qk = {
  me: ['me'] as const,
  accounts: ['accounts'] as const,
  connectors: ['connectors'] as const,
  /** Under `items` so every items invalidation refreshes it too. */
  events: ['items', 'events'] as const,
  today: ['today'] as const,
  items: (f: ItemsFilter) => ['items', f] as const,
  itemsAll: ['items'] as const,
  item: (id: string) => ['item', id] as const,
  tasks: (f: Partial<TasksFilter>) => ['tasks', f] as const,
  tasksAll: ['tasks'] as const,
  proposals: ['proposals'] as const,
  accessRequests: ['accessRequests'] as const,
  permissions: (principal?: string) => ['permissions', principal ?? null] as const,
  permissionsAll: ['permissions'] as const,
  control: ['control'] as const,
  models: ['models'] as const,
  mcp: ['mcp'] as const,
  activity: ['activity'] as const,
};

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (count, err) => {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

// ---- Queries ----
export const useMe = (enabled = true) => useQuery({ queryKey: qk.me, queryFn: api.me, enabled });
export const useAccounts = () => useQuery({ queryKey: qk.accounts, queryFn: api.accounts });
/** The catalog changes only when the hub's config does. */
export const useConnectors = () =>
  useQuery({ queryKey: qk.connectors, queryFn: api.connectors, staleTime: 5 * 60_000 });
export const useEvents = (enabled = true) =>
  useQuery({ queryKey: qk.events, queryFn: api.events, enabled });
export const useToday = () => useQuery({ queryKey: qk.today, queryFn: api.today });
export const useItem = (id: string) =>
  useQuery({ queryKey: qk.item(id), queryFn: () => api.item(id) });
export const useTasks = (f: Partial<TasksFilter>) =>
  useQuery({ queryKey: qk.tasks(f), queryFn: () => api.tasks(f) });
export const useProposals = () => useQuery({ queryKey: qk.proposals, queryFn: api.proposals });
export const useAccessRequests = () =>
  useQuery({ queryKey: qk.accessRequests, queryFn: api.accessRequests });
export const usePermissions = (principal?: string) =>
  useQuery({ queryKey: qk.permissions(principal), queryFn: () => api.permissions(principal) });
export const useControl = () => useQuery({ queryKey: qk.control, queryFn: api.control });
export const useModels = () => useQuery({ queryKey: qk.models, queryFn: api.models });
export const useMcp = () => useQuery({ queryKey: qk.mcp, queryFn: api.mcp });

export const useItems = (f: Omit<ItemsFilter, 'cursor'>) =>
  useInfiniteQuery({
    queryKey: qk.items(f),
    queryFn: ({ pageParam }) => api.items({ ...f, cursor: pageParam ?? undefined, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

export const useActivity = () =>
  useInfiniteQuery({
    queryKey: qk.activity,
    queryFn: ({ pageParam }) => api.activity(pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

// ---- Mutations ----

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateMe) => api.updateMe(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: qk.me });
      const prev = qc.getQueryData<MeT>(qk.me);
      if (prev) {
        const { onboarded, settings, ...rest } = patch;
        qc.setQueryData<MeT>(qk.me, {
          ...prev,
          ...rest,
          settings: { ...prev.settings, ...settings },
          onboardedAt: onboarded
            ? (prev.onboardedAt ?? new Date().toISOString())
            : prev.onboardedAt,
        });
      }
      return { prev };
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.me, ctx.prev);
    },
    onSuccess: (me) => {
      if (me) qc.setQueryData(qk.me, me);
    },
    onSettled: (_d, _e, patch) => {
      if (patch.preset !== undefined || patch.strictPersonal !== undefined) {
        void qc.invalidateQueries({ queryKey: qk.permissionsAll });
        void qc.invalidateQueries({ queryKey: qk.control });
      }
      // PATCH /me may not echo the user; make sure we converge.
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

/** Optimistic task update across every cached task list and Today. */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateTask }) => api.updateTask(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: qk.tasksAll });
      await qc.cancelQueries({ queryKey: qk.today });
      const lists = qc.getQueriesData<TasksResT>({ queryKey: qk.tasksAll });
      const today = qc.getQueryData<TodayT>(qk.today);
      const apply = (t: TaskT): TaskT => (t.id === id ? { ...t, ...patch } : t);
      for (const [key, data] of lists) {
        if (data) qc.setQueryData<TasksResT>(key, { tasks: data.tasks.map(apply) });
      }
      if (today) qc.setQueryData<TodayT>(qk.today, { ...today, nextUp: today.nextUp.map(apply) });
      return { lists, today };
    },
    onError: (_e, _v, ctx) => {
      ctx?.lists.forEach(([key, data]) => qc.setQueryData(key, data));
      if (ctx?.today) qc.setQueryData(qk.today, ctx.today);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.today });
    },
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createTask,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.tasksAll });
      void qc.invalidateQueries({ queryKey: qk.today });
    },
  });
}

/** Approve/reject remove the card from the pending list optimistically. */
export function useDecideProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      decision: 'approve' | 'reject';
      payload?: Record<string, unknown>;
    }) =>
      v.decision === 'approve' ? api.approveProposal(v.id, v.payload) : api.rejectProposal(v.id),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: qk.proposals });
      const prev = qc.getQueryData<ProposalsResT>(qk.proposals);
      if (prev)
        qc.setQueryData<ProposalsResT>(qk.proposals, {
          proposals: prev.proposals.filter((p) => p.id !== id),
        });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.proposals, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.proposals });
      void qc.invalidateQueries({ queryKey: qk.today });
      void qc.invalidateQueries({ queryKey: qk.itemsAll });
    },
  });
}

export function useDecideAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      decision: 'allow' | 'deny';
      durationMinutes: number;
      /** For `mcp_connect`: the code shown on the computer's consent page. */
      pairingCode?: string;
    }) =>
      v.decision === 'allow'
        ? api.allowAccess(v.id, v.durationMinutes, v.pairingCode)
        : api.denyAccess(v.id).then(() => ({ grant: null })),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: qk.accessRequests });
      const prev = qc.getQueryData<AccessRequestsResT>(qk.accessRequests);
      if (prev)
        qc.setQueryData<AccessRequestsResT>(qk.accessRequests, {
          requests: prev.requests.filter((r) => r.id !== id),
        });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.accessRequests, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.accessRequests });
      void qc.invalidateQueries({ queryKey: qk.permissionsAll });
      void qc.invalidateQueries({ queryKey: qk.control });
      void qc.invalidateQueries({ queryKey: qk.mcp });
    },
  });
}

export function useSetPaused() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => (paused ? api.pause() : api.resume()),
    onMutate: async (paused) => {
      await qc.cancelQueries({ queryKey: qk.control });
      const prev = qc.getQueryData<ControlT>(qk.control);
      if (prev) qc.setQueryData<ControlT>(qk.control, { ...prev, paused });
      const me = qc.getQueryData<MeT>(qk.me);
      if (me) qc.setQueryData<MeT>(qk.me, { ...me, paused });
      return { prev, me };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.control, ctx.prev);
      if (ctx?.me) qc.setQueryData(qk.me, ctx.me);
    },
    onSuccess: (control) => {
      if (control) qc.setQueryData(qk.control, control);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.control });
      void qc.invalidateQueries({ queryKey: qk.me });
    },
  });
}

/** `queryPrincipal` is the principal the Permissions query was made with (undefined = server default). */
export function useSetPolicy(queryPrincipal: string | undefined) {
  const qc = useQueryClient();
  const key = qk.permissions(queryPrincipal);
  return useMutation({
    mutationFn: (body: SetPolicy) => api.setPolicy(body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<PermissionsT>(key);
      if (prev) {
        const match = (r: PermissionsT['data'][number]) =>
          r.resource === body.resource &&
          r.provider === body.provider &&
          r.accountId === body.accountId;
        const upd = (r: PermissionsT['data'][number]) =>
          match(r)
            ? {
                ...r,
                level: body.level,
                source: body.accountId ? ('account' as const) : ('provider' as const),
              }
            : r;
        qc.setQueryData<PermissionsT>(key, {
          ...prev,
          data: prev.data.map(upd),
          actions: prev.actions.map(upd),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}
