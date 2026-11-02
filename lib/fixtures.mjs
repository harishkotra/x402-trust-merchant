// lib/fixtures.mjs — the conference Wi-Fi insurance policy.
//
// Every result the demo shows was captured from a real run first. These files
// are what that run returned. Replay them and the demo is identical on a stage
// with no network, and you can still tell the truth: "these are real responses,
// captured on <date>".
//
// Refresh them with:  node run.mjs --live --capture

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'fixtures');

const cache = new Map();

export function fixture(name) {
  if (cache.has(name)) return cache.get(name);
  const path = join(DIR, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing fixtures/${name}.json — run --live --capture once`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const shaped = {
    ok: true,
    status: 200,
    paid: true,
    dryRun: false,
    accept: {
      amount: BigInt(raw.accept.amount),
      network: raw.accept.network,
      payTo: raw.accept.payTo,
      scheme: 'exact',
      asset: raw.accept.asset,
    },
    settlement: raw.settlement,
    challenge: raw.challenge ?? null,
    body: raw.body,
    replay: true,
    capturedAt: raw.capturedAt ?? null,
  };
  cache.set(name, shaped);
  return shaped;
}

export const hasFixtures = () => existsSync(DIR);

// Snapshot = raw JSON, for things that are not a payment (registry reads, listings).
export function snapshot(name) {
  const path = join(DIR, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing fixtures/${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}
