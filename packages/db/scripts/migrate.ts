import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { migrate } from '../src/migrate';

if (existsSync('../../.env')) loadEnvFile('../../.env');
process.env.DATABASE_URL ??= 'postgres://hub:hub@localhost:5434/hub';

await migrate();
console.log('migrations applied');
