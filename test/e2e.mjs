#!/usr/bin/env node
// test/e2e.mjs — proves the whole loop except the on-chain settlement.
//
//   ephemeral wallet → 402 challenge → EIP-3009 signature → seller verifies
//   → certificate minted → signature checked offline
//
// No funded wallet needed. No network needed. Run it before you trust a stage.

import { spawn } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { pay } from '../lib/x402.mjs';
import { check, toMarkdown } from '../seller/certificate.mjs';
import { Budget } from '../lib/guard.mjs';

const PORT = 8899;
const BASE = `http://localhost:${PORT}`;
let failures = 0;

const assert = (name, ok, extra = '') => {
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra ? '  \x1b[2m' + extra + '\x1b[0m' : ''}`);
  if (!ok) failures += 1;
};

const server = spawn('node', ['seller/server.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve) => {
  server.stdout.on('data', (d) => {
    if (String(d).includes('listening')) resolve();
  });
  setTimeout(resolve, 3000);
});

try {
  // 1. discovery document exists and describes the price
  const llms = await fetch(`${BASE}/llms.txt`).then((r) => r.text());
  assert('publishes llms.txt', llms.includes('/buy/certificate'), `${llms.length} bytes`);
  assert('llms.txt declares a price', /USDC/.test(llms));

  const card = await fetch(`${BASE}/.well-known/agent.json`).then((r) => r.json());
  assert('publishes a typed tool card', card.tools?.[0]?.name === 'buy_certificate');

  // 2. unpriced request is refused, with a price attached
  const challengeRes = await fetch(`${BASE}/buy/certificate`);
  assert('402 without payment', challengeRes.status === 402);
  const challenge = await challengeRes.json();
  assert('402 carries a machine-readable price', challenge.accepts?.[0]?.amount === '50000');

  // 3. full payment with an ephemeral wallet
  const account = privateKeyToAccount(generatePrivateKey());
  const budget = new Budget();
  const result = await pay(`${BASE}/buy/certificate?item=e2e`, {
    mode: 'live',
    account,
    budget,
    network: 'eip155:8453',
  });

  assert('payment accepted', result.ok, `status ${result.status}`);
  assert('buyer address recovered server-side', result.body?.certificate?.buyer?.toLowerCase() === account.address.toLowerCase());
  assert('settlement receipt returned', Boolean(result.settlement?.success));
  assert('certificate signature verifies offline', check(result.body.certificate));
  assert('certificate is human-readable', toMarkdown(result.body.certificate).includes('Certificate of Purchase'));

  // 4. a tampered certificate must not verify
  const forged = { ...result.body.certificate, amount: '1' };
  assert('tampered certificate rejected', check(forged) === false);

  // 5. a garbage payment header must not pass
  const junk = await fetch(`${BASE}/buy/certificate`, { headers: { 'x-payment': 'bm90LWEtcGF5bWVudA==' } });
  assert('garbage payment rejected', junk.status === 402);

  if (failures === 0) {
    console.log('\n\x1b[32mALL CHECKS PASSED\x1b[0m — the loop works end to end (settlement is simulated).\n');
  } else {
    console.log(`\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m\n`);
    process.exitCode = 1;
  }
} finally {
  server.kill();
}
