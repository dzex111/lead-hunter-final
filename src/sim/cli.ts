#!/usr/bin/env node
import 'dotenv/config';
import { runSimulation } from '@/sim/run';

/** `pnpm sim` — synthetic population with hidden ground truth, 1000 sends. */
function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

const report = runSimulation({
  sends: arg('sends', 1000),
  population: arg('population', 400),
  seed: arg('seed', 20260101),
});

process.stdout.write(`${report}\n`);
