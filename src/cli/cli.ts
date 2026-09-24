#!/usr/bin/env node
import 'dotenv/config';
import { buildProgram } from '@/cli/index';

const program = buildProgram();
program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`error: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
