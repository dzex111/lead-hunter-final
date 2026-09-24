#!/usr/bin/env node
import 'dotenv/config';
import { buildCliDeps } from '@/cli/index';
import { runDemo } from '@/demo/run';

/** `pnpm demo` — offline end-to-end run against the real schema, no network. */
const deps = buildCliDeps();
runDemo(deps)
  .then((report) => {
    process.stdout.write(`${report}\n`);
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`demo failed: ${(error as Error).message}\n`);
    process.exit(1);
  });
