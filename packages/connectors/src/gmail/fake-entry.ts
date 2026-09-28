/** Fake-mode helpers for dev scripts (e.g. the gateway's fake:email). Not for production code. */
export {
  FakeGmailStore,
  defaultFakeStore,
  seedFakeState,
  DEFAULT_FAKE_STORE_PATH,
  type FakeMailbox,
  type NewFakeMessage,
} from './fake-store';
export { fakeClientFactory, fakeAuth } from './fake';
