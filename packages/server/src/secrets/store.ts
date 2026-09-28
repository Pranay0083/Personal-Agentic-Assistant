import { eq } from 'drizzle-orm';
import { secrets, type Db } from '@hub/db';
import { open, seal, type KeyProvider } from './envelope';

/**
 * Stores secrets (OAuth tokens, provider API keys) encrypted at rest.
 * Callers keep only the returned `secret_ref` id.
 */
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
  ) {}

  async put(userId: string, kind: string, value: string): Promise<string> {
    const env = await seal(this.keys, value);
    const [row] = await this.db
      .insert(secrets)
      .values({ userId, kind, ...env })
      .returning({ id: secrets.id });
    return row!.id;
  }

  async replace(ref: string, value: string): Promise<void> {
    const env = await seal(this.keys, value);
    await this.db.update(secrets).set(env).where(eq(secrets.id, ref));
  }

  async get(ref: string): Promise<string> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.id, ref));
    if (!row) throw new Error('secret not found');
    return (await open(this.keys, row)).toString('utf8');
  }

  async getJson<T>(ref: string): Promise<T> {
    return JSON.parse(await this.get(ref)) as T;
  }

  async delete(ref: string): Promise<void> {
    await this.db.delete(secrets).where(eq(secrets.id, ref));
  }
}
