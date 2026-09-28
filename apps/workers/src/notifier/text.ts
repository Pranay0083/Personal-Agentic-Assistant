/**
 * The only push texts workers send. Push leaves our systems (Expo, APNs/FCM, lock
 * screens) and sits in Redis job data, so it is generic and never message-derived: no
 * subjects, sender names, summaries, task titles or brief headlines. The app fetches the
 * details by id (NotifierJob.data) over the authenticated API.
 */
export const PUSH_TEXT = {
  /** `dueLabel` is a relative day ("today", "Wednesday"), computed from the due date only. */
  task: (dueLabel: string | null) => ({
    title: 'New task',
    body: dueLabel ? `Due ${dueLabel}` : 'Open Hub to review it',
  }),
  approval: { title: 'Draft ready', body: 'A reply is waiting for your approval' },
  vipNeedsYou: { title: 'A VIP needs you', body: 'Open Hub to see what they need' },
  vipMessage: { title: 'New message from a VIP', body: 'Open Hub to read it' },
  brief: { title: 'Your daily brief is ready', body: 'Open Hub to see today at a glance' },
  accessRequest: {
    title: 'Access request',
    body: 'An agent is asking for access. Review it in Hub.',
  },
} as const;
