/** Fake-mode helpers for dev scripts (the gateway's fake:email, fake:google). Not for production code. */
export {
  FakeGmailStore,
  defaultFakeStore,
  seedFakeState,
  DEFAULT_FAKE_STORE_PATH,
  type FakeMailbox,
  type NewFakeMessage,
} from './fake-store';
export type {
  FakeGoogle,
  FakeChannel,
  FakeEventSubscription,
  NewFakeCalendarEvent,
  NewFakeChatMessage,
  NewFakeDriveShare,
} from './fake-google-store';
export { fakeClientFactory, fakeAuth } from './fake';
export { fakeRestFactory } from './fake-google';
