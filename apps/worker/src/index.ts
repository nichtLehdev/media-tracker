import type { PgBoss } from 'pg-boss';
import { createBoss } from './boss.js';
import { registerSessionExpiry } from './jobs/session-expiry.js';

/**
 * The worker process (S3). Consumers are registered here as milestones land:
 *
 *   M2  session-expiry sweep (playback_sessions past expires_at)  [done]
 *   M3  announcement batch flush -> Discord webhook
 *   M5  Trakt / SIMKL import jobs
 *   M7  Seerr status polling
 */
async function main(): Promise<void> {
  const boss = createBoss();

  boss.on('error', (err: unknown) => {
    console.error('[worker] pg-boss error', err);
  });

  await boss.start();
  console.log('[worker] pg-boss started');

  await registerConsumers(boss);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] ${signal} received, stopping`);
    try {
      // Let in-flight handlers finish rather than dropping a half-sent
      // announcement batch.
      await boss.stop({ graceful: true, close: true });
    } catch (err) {
      console.error('[worker] error during shutdown', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function registerConsumers(boss: PgBoss): Promise<void> {
  await registerSessionExpiry(boss);
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
