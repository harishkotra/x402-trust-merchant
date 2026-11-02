#!/usr/bin/env node
// test/contract.mjs — the refusal matrix.
//
// An agent meets the failure states long before it meets a 200. If those are
// wrong, the demo is a magic trick. This walks every refusal path against a
// live seller and asserts each one is machine-readable.

import { spawn } from 'node:child_process';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { EIP3009_TYPES } from '../lib/x402.mjs';
import { check } from '../seller/certificate.mjs';

const PORT = 8898;
const BASE = `http://localhost:${PORT}`;
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x1111111111111111111111111111111111111111';
const PRICE = 50000n;

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

const account = privateKeyToAccount(generatePrivateKey());

async function header(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: account.address,
    to: overrides.payTo ?? PAY_TO,
    value: BigInt(overrides.value ?? PRICE),
    validAfter: BigInt(now - 60),
    validBefore: BigInt(overrides.validBefore ?? now + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await account.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: overrides.chainId ?? 8453, verifyingContract: ASSET },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: auth,
  });
  const payload = {
    x402Version: 2,
    scheme: overrides.scheme ?? 'exact',
    network: overrides.network ?? 'eip155:8453',
    payload: {
      signature,
      authorization: {
        ...auth,
        value: auth.value.toString(),
        validAfter: auth.validAfter.toString(),
        validBefore: auth.validBefore.toString(),
      },
    },
  };
  return { header: Buffer.from(JSON.stringify(payload)).toString('base64'), nonce: auth.nonce };
}

const buy = (h) =>
  fetch(`${BASE}/buy/certificate?item=contract-test`, {
    headers: h ? { 'x-payment': h } : {},
  });

try {
  // ── discovery: the four files ──────────────────────────────────────────
  const llms = await fetch(`${BASE}/llms.txt`).then((r) => r.text());
  assert('llms.txt sells something specific', llms.includes('/buy/certificate'));

  const x402 = await fetch(`${BASE}/.well-known/x402`).then((r) => r.json());
  assert('.well-known/x402 declares a resource and a price',
    x402.resources?.[0]?.amount === '50000' && x402.resources[0].network === 'eip155:8453');

  const schema = await fetch(`${BASE}/.well-known/schema.json`).then((r) => r.json());
  assert('schema.json is versioned with typed input/output/refusal',
    schema.version && schema.input?.required?.includes('item') && schema.refusal?.properties?.error?.enum?.length >= 3);

  const card = await fetch(`${BASE}/.well-known/agent-card.json`).then((r) => r.json());
  assert('agent-card.json names a callable tool', card.tools?.[0]?.name === 'buy_certificate');

  // ── the unpriced request ───────────────────────────────────────────────
  const first = await buy();
  const challenge = await first.json();
  assert('unpriced request returns 402', first.status === 402);
  assert('402 carries price, asset, payTo, network',
    challenge.accepts?.[0]?.amount === '50000' &&
      challenge.accepts[0].asset === ASSET &&
      challenge.accepts[0].payTo === PAY_TO &&
      challenge.accepts[0].network === 'eip155:8453');
  assert('402 carries the EIP-712 domain so the buyer can sign',
    challenge.accepts?.[0]?.extra?.name === 'USD Coin');

  // ── refusals ───────────────────────────────────────────────────────────
  const cases = [
    ['missing X-PAYMENT', null, 'missing'],
    ['malformed X-PAYMENT', Buffer.from('not json').toString('base64'), 'malformed'],
    ['unsupported scheme', (await header({ scheme: 'upto' })).header, 'unsupported scheme'],
    ['wrong network', (await header({ network: 'eip155:84532' })).header, 'wrong network'],
    ['underpaid', (await header({ value: 40000n })).header, 'underpaid'],
    ['wrong payTo', (await header({ payTo: '0x2222222222222222222222222222222222222222' })).header, 'wrong payTo'],
    ['expired authorisation', (await header({ validBefore: Math.floor(Date.now() / 1000) - 60 })).header, 'expired'],
    ['bad signature (signed for another chain)', (await header({ chainId: 84532 })).header, 'bad signature'],
  ];

  for (const [label, h, expected] of cases) {
    const res = await buy(h);
    const body = await res.json().catch(() => ({}));
    const ok = res.status === 402 && String(body.error ?? '').toLowerCase().includes(expected.toLowerCase());
    assert(`refuses ${label}`, ok, `402 "${body.error ?? ''}"`);
    if (ok) assert(`  ↳ refusal stays actionable (carries accepts[])`, Array.isArray(body.accepts));
  }

  // ── our own checker, bought the same way ───────────────────────────────
  const checkHeader = await header({ value: 2000n });
  const checkRes = await fetch(`${BASE}/check/endpoint?target=localhost:${PORT}`, {
    headers: { 'x-payment': checkHeader.header },
  });
  const checkBody = await checkRes.json();
  assert('the trust check is a paid call, not a free lookup', checkRes.status === 200, `status ${checkRes.status}`);
  assert('the verdict comes with timed evidence', checkBody.check?.evidence?.length === 3 && checkBody.check.evidence.every((e) => 'ms' in e));
  assert('pointed at itself, it scores clean', checkBody.check?.verdict === 'clean', `score ${checkBody.check?.score}/3`);

  // ── the happy path, then replay it ─────────────────────────────────────
  const good = await header();
  const paid = await buy(good.header);
  const paidBody = await paid.json();
  assert('valid payment returns 200', paid.status === 200, `status ${paid.status}`);
  assert('certificate verifies offline', check(paidBody.certificate));
  assert('settlement header is present', Boolean(paid.headers.get('x-payment-response')));

  const replay = await buy(good.header);
  const replayBody = await replay.json();
  assert('the same authorisation cannot be spent twice', replay.status === 402 && /already used/.test(replayBody.error ?? ''), `"${replayBody.error}"`);

  if (failures === 0) console.log(`\n\x1b[32mCONTRACT OK\x1b[0m — every refusal is machine-readable, nothing double-spends.\n`);
  else console.log(`\n\x1b[31m${failures} CONTRACT CHECK(S) FAILED\x1b[0m\n`);
  if (failures) process.exitCode = 1;
} finally {
  server.kill();
}
