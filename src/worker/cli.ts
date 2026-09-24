#!/usr/bin/env node
import 'dotenv/config';
import { buildCliDeps } from '@/cli/index';
import { startWorker } from '@/worker/index';

/**
 * `pnpm worker` — separate worker process (not Next.js). Claims jobs with
 * FOR UPDATE SKIP LOCKED, heartbeats leases, retries with backoff + jitter,
 * dead-letters exhausted jobs and shuts down gracefully on SIGINT/SIGTERM.
 */
const deps = buildCliDeps();
startWorker(deps).catch((error: unknown) => {
  process.stderr.write(`worker crashed: ${(error as Error).message}\n`);
  process.exit(1);
});
