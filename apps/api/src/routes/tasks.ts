import { and, asc, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { accounts, items, tasks, type Db } from '@hub/db';
import type { Task } from '@hub/shared';
import { CreateTaskReq, TasksQuery, UpdateTaskReq } from '@hub/shared/api';
import type { Ctx } from '../context';
import { idParam, notFound, parse, parseDate } from '../http';
import { toTask } from '../serialize';

const taskAccountId = sql<string | null>`coalesce(${tasks.accountId}, ${items.accountId})`;

/** Tasks with their source tag (provider of the source item's account). Always user-scoped. */
export async function selectTasks(
  db: Db,
  userId: string,
  where: SQL[],
  opts: { limit?: number } = {},
): Promise<Task[]> {
  const q = db
    .select({
      id: tasks.id,
      title: tasks.title,
      notes: tasks.notes,
      dueAt: tasks.dueAt,
      status: tasks.status,
      project: tasks.project,
      sourceItemId: tasks.sourceItemId,
      accountId: taskAccountId,
      source: accounts.provider,
      confidence: tasks.confidence,
      confirmedByUser: tasks.confirmedByUser,
      createdBy: tasks.createdBy,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .leftJoin(items, eq(items.id, tasks.sourceItemId))
    .leftJoin(accounts, and(eq(accounts.id, taskAccountId), eq(accounts.userId, tasks.userId)))
    .where(and(eq(tasks.userId, userId), ...where))
    .orderBy(sql`${tasks.dueAt} asc nulls last`, desc(tasks.createdAt), asc(tasks.id));
  const rows = opts.limit ? await q.limit(opts.limit) : await q;
  return rows.map(toTask);
}

async function oneTask(db: Db, userId: string, id: string): Promise<Task> {
  const [t] = await selectTasks(db, userId, [eq(tasks.id, id)]);
  if (!t) throw notFound('task');
  return t;
}

export function taskRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  app.get('/tasks', async (req): Promise<{ tasks: Task[] }> => {
    const q = parse(TasksQuery, req.query);
    const where: SQL[] = [];
    if (q.status) where.push(eq(tasks.status, q.status));
    if (q.review === 'pending') {
      // Agent-created tasks the user hasn't confirmed or rejected yet (First win screen).
      where.push(isNull(tasks.confirmedByUser), ne(tasks.createdBy, 'user'));
    }
    return { tasks: await selectTasks(db, req.auth.userId, where) };
  });

  app.post('/tasks', async (req): Promise<Task> => {
    const userId = req.auth.userId;
    const body = parse(CreateTaskReq, req.body);
    const now = ctx.now();
    const [row] = await db
      .insert(tasks)
      .values({
        userId,
        title: body.title,
        notes: body.notes ?? null,
        project: body.project ?? null,
        dueAt: body.dueAt ? parseDate(body.dueAt, 'dueAt') : null,
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });
    const id = row!.id;
    await ctx.audit({ userId, principal: 'user', action: 'task.created', target: `task:${id}` });
    await ctx.live(userId, { type: 'task.created', taskId: id });
    return oneTask(db, userId, id);
  });

  app.patch('/tasks/:id', async (req): Promise<Task> => {
    const userId = req.auth.userId;
    const id = idParam(req.params);
    const body = parse(UpdateTaskReq, req.body);
    const [current] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
    if (!current) throw notFound('task');

    const now = ctx.now();
    const set: Partial<typeof tasks.$inferInsert> = { updatedAt: now };
    if (body.title !== undefined) set.title = body.title;
    if (body.notes !== undefined) set.notes = body.notes;
    if (body.project !== undefined) set.project = body.project;
    if (body.dueAt !== undefined) set.dueAt = body.dueAt ? parseDate(body.dueAt, 'dueAt') : null;
    let status = body.status;
    if (body.confirmedByUser !== undefined) {
      set.confirmedByUser = body.confirmedByUser;
      // "Not a task" dismisses it; confirming revives a dismissed one unless a status was sent.
      if (body.confirmedByUser === false) status = 'dismissed';
      else if (status === undefined && current.status === 'dismissed') status = 'open';
    }
    if (status !== undefined) {
      set.status = status;
      set.completedAt = status === 'done' ? (current.completedAt ?? now) : null;
    }
    await db
      .update(tasks)
      .set(set)
      .where(and(eq(tasks.id, id), eq(tasks.userId, userId)));

    const action =
      body.confirmedByUser === true
        ? 'task.confirmed'
        : body.confirmedByUser === false
          ? 'task.rejected'
          : 'task.updated';
    await ctx.audit({
      userId,
      principal: 'user',
      action,
      target: `task:${id}`,
      details: {
        fields: Object.keys(set).filter((k) => k !== 'updatedAt'),
        createdBy: current.createdBy,
      },
    });
    await ctx.live(userId, { type: 'task.updated', taskId: id });
    return oneTask(db, userId, id);
  });
}
