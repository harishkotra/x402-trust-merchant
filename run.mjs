#!/usr/bin/env node
// run.mjs — VARIANT B: x402-trust-merchant.
//
// Three unrelated strangers. The agent buys a commodity from a seller it has
// never seen, buys a trust verdict from a second stranger, then buys the
// result from our own service. At no point does it hold an account anywhere.
//
//   node run.mjs --dry        negotiate for real, stop before the money moves
//   node run.mjs --live       pay for real (needs PRIVATE_KEY + funded wallet)
//   node run.mjs --fixtures   no network at all

import { writeFileSync, mkdirSync } from 'node:fs';
import { Tape, usd } from './lib/tape.mjs';
import { search, safeHost, rank } from './lib/discovery.mjs';
import { pay, walletFrom } from './lib/x402.mjs';
import { Budget, Refused, LIMITS } from './lib/guard.mjs';
import { lookupAgent, REGISTRIES, short } from './lib/registry.mjs';
import { SEARCHES, DEMO, fromFallback } from './lib/catalog.mjs';
import { fixture, snapshot } from './lib/fixtures.mjs';

const argv = new Set(process.argv.slice(2));
const MODE = argv.has('--live') ? 'live' : argv.has('--fixtures') ? 'fixtures' : 'dry';
const SELLER = process.env.SELLER_URL ?? 'http://localhost:8787';
const NETWORK = process.env.PAY_NETWORK ?? 'eip155:8453';

const tape = new Tape(`CHAIN-OWNED · ${MODE.toUpperCase()}`);
const budget = new Budget();
const account = MODE === 'live' ? walletFrom() : null;
const events = [];

const note = (type, data) => events.push({ t: Date.now(), type, ...data });

if (MODE === 'live' && !account) {
  console.error('\n--live needs PRIVATE_KEY. Nothing was spent.\n');
  process.exit(2);
}

console.log(`\x1b[2mgoal: ${DEMO.goal}\x1b[0m\n`);

// ── hop 1: buy a commodity from a stranger ────────────────────────────────
let hop1 = null;
try {
  const candidates = MODE === 'fixtures' ? [] : await search(SEARCHES.commodity, { limit: 8 });
  tape.step('DISCOVER', MODE === 'fixtures' ? 'replaying captured listing for "timezone"' : `${candidates.length} candidates for "timezone"`, {
    value: MODE === 'fixtures' ? 'captured' : 'bazaar',
    sub: candidates.slice(0, 3).map((c) => `${c.host} ${usd(c.amount)}`).join('  ·  ') || null,
  });
  hop1 = candidates[0] ?? fromFallback('commodity');
  if (!hop1) throw new Error('no seller found');
  if (MODE === 'fixtures') hop1.amount = fixture('hop1').accept.amount;
  tape.seller(hop1.host);
  // Clip on a word boundary: a mid-word ellipsis reads like a bug on a projector.
  const clip = (s, n) => {
    if (s.length <= n) return s;
    const cut = s.slice(0, n - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > n * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:·-]+$/, '')}…`;
  };
  const desc = clip((hop1.description ?? '').replace(/\s+/g, ' '), Math.max(0, 50 - hop1.host.length));
  tape.step('SELECT', `${hop1.host}  ${desc}`, { value: usd(hop1.amount) });
} catch (e) {
  tape.step('SELECT', `no live seller (${e.message.slice(0, 40)}) — using fallback`, { ok: false });
  hop1 = fromFallback('commodity');
  tape.seller(hop1.host);
}

let tick = Date.now();
try {
  // The listing says what the tool wants; the goal supplies it. Without the
  // coordinates the seller would take the money and return a validation error.
  const buyUrl = new URL(hop1.url);
  if (!buyUrl.search) {
    buyUrl.search = new URLSearchParams({ lat: String(DEMO.commodity.lat), lon: String(DEMO.commodity.lon) }).toString();
  }
  const r = MODE === 'fixtures' ? fixture('hop1') : await pay(buyUrl.toString(), { mode: MODE === 'live' ? 'live' : 'dry', account, budget, network: NETWORK });
  const ms = MODE === 'fixtures' ? 230 : Date.now() - tick;
  tape.charge(r.accept.amount);
  tape.step('PAY', `${hop1.host} · ${usd(r.accept.amount)} · ${r.paid ? 'settled' : 'signed'}`, {
    value: `${ms}ms`,
    ok: true,
    sub: r.challenge
      ? `402 ${r.challenge.dialect} · x402 v${r.challenge.x402Version ?? '?'} · ${r.challenge.accepts.length} offer(s)` +
        (r.challenge.mpp ? ` · also MPP rail "${r.challenge.mpp.method}"` : '')
      : null,
  });
  tape.step('RESULT', r.dryRun ? 'not bought — real 402, no answer purchased' : summarise(r.body), { ok: true });
  note('hop1', { ok: true, ms, spent: r.accept.amount.toString(), host: hop1.host });
} catch (e) {
  tape.step('PAY', `${hop1.host} refused: ${e.reason ?? e.message}`.slice(0, 68), { ok: false });
  tape.fail();
  note('hop1', { ok: false, error: e.reason ?? e.message });
}

// ── hop 2: buy a trust verdict from OUR OWN checker ───────────────────────
// Variant B. The middle hop is a service we control, so the only thing we do
// not control is the first lookup.
let hop2 = { host: 'localhost:8787 (our checker)', url: `${SELLER}/check/endpoint`, amount: 2000n };
try {
  tape.seller('localhost:8787');
  tape.step('DISCOVER', 'trust check — served by us, not the bazaar', { value: 'owned' });
  tape.step('SELECT', `our checker · target ${hop1.host}`, { value: usd(hop2.amount) });
} catch (e) {
  tape.step('SELECT', `checker unavailable: ${e.message.slice(0, 40)}`, { ok: false });
}

try {
  tick = Date.now();
  const url = `${hop2.url}?target=${encodeURIComponent(hop1.host)}`;
  const r = MODE === 'fixtures' ? fixture('checker') : await pay(url, { mode: MODE === 'live' ? 'live' : 'dry', account, budget, network: NETWORK });
  const ms = MODE === 'fixtures' ? 180 : Date.now() - tick;
  tape.charge(r.accept.amount);
  tape.step('PAY', `our checker · ${usd(r.accept.amount)} · ${r.paid ? 'settled' : 'signed'}`, { value: `${ms}ms`, ok: true });
  tape.step(
    'RESULT',
    r.dryRun ? 'verdict withheld (dry run)' : `${r.body?.check?.verdict ?? '?'} · score ${r.body?.check?.score ?? '?'}/3`,
    { ok: true },
  );
  note('hop2', { ok: true, ms, spent: r.accept.amount.toString(), host: hop2.host });
} catch (e) {
  tape.step('PAY', `our checker: ${e.reason ?? e.message}`.slice(0, 68), { ok: false });
  tape.fail();
  note('hop2', { ok: false, error: e.reason ?? e.message });
}

// ── hop 3: check identity, then buy our own result ────────────────────────
try {
  const reg = MODE === 'fixtures' ? { ...snapshot('registry'), registered: true } : await lookupAgent({ chainId: 84532, agentId: 1, registry: REGISTRIES.testnet });
  tape.step('CHECK', `ERC-8004 identity #1 on base-sepolia`, {
    value: reg.registered ? short(reg.owner) : 'unregistered',
    ok: reg.registered,
    sub: reg.error ?? (reg.registered ? `owner ${reg.owner}` : 'not in the registry — buying anyway is your call'),
  });
  note('registry', reg);
} catch (e) {
  tape.step('CHECK', `registry unreachable: ${e.message.slice(0, 42)}`, { ok: false });
  note('registry', { error: e.message });
}

try {
  tick = Date.now();
  const r = MODE === 'fixtures'
    ? fixture('hop3')
    : await pay(`${SELLER}/buy/certificate?item=find-check-pay-result`, {
        mode: MODE === 'live' ? 'live' : 'dry',
        account,
        budget,
        network: NETWORK,
      });
  const ms = MODE === 'fixtures' ? 90 : Date.now() - tick;
  tape.charge(r.accept.amount);
  tape.seller('localhost:8787');
  tape.step('PAY', `our seller · ${usd(r.accept.amount)} · ${r.paid ? 'settled' : 'signed'}`, { value: `${ms}ms`, ok: true });
  if (r.body?.certificate) {
    tape.step('RESULT', `certificate ${r.body.certificate.digest.slice(0, 24)}…`, { ok: true, sub: `buyer ${short(r.body.certificate.buyer)}` });
  } else {
    tape.step('RESULT', 'certificate withheld (dry run)', { ok: true });
  }
  note('hop3', { ok: true, ms, spent: r.accept.amount.toString() });
} catch (e) {
  tape.step('PAY', `our seller: ${e.reason ?? e.message}`.slice(0, 68), { ok: false });
  tape.fail();
  note('hop3', { ok: false, error: e.reason ?? e.message });
}

// ── the refusal: prove the agent can say no ───────────────────────────────
// Same agent, same wallet, a stricter policy: this errand is capped at two
// cents a call. The image endpoint wants six. It walks away.
const strict = new Budget({ ...LIMITS, maxPerCall: 20000n, maxTotal: 20000n });
try {
  const pricey =
    MODE === 'fixtures'
      ? await snapshot('expensive')
      : (await search(SEARCHES.expensive, { limit: 3 }))[0];
  const target = pricey
    ? { ...pricey, amount: BigInt(pricey.amount ?? pricey.accept?.amount ?? 0) }
    : fromFallback('expensive');
  tape.step('ATTEMPT', `${target.host} wants ${usd(target.amount)} for one image`, { value: 'over policy' });
  strict.approve({ url: target.url, amount: target.amount, network: NETWORK, payTo: '0x0' });
  tape.step('REFUSE', 'guard failed — this should never print', { ok: false });
  tape.fail();
} catch (e) {
  if (e.refused) {
    tape.step('REFUSE', `${e.reason} · ${String(e.detail).slice(0, 32)}`, { value: 'stopped', ok: false });
    note('refusal', { reason: e.reason, detail: e.detail });
  } else {
    tape.step('REFUSE', `could not evaluate: ${e.message.slice(0, 40)}`, { ok: false });
  }
}

tape.footer(
  MODE === 'live' ? 'TOTAL SPENT' : 'TOTAL QUOTED',
  MODE === 'fixtures' ? 'replayed capture · no network' : null,
);

const summary = {
  variant: 'x402-trust-merchant',
  mode: MODE,
  spentMicros: budget.spent.toString(),
  calls: budget.calls,
  sellers: tape.sellers.size,
  failures: tape.failures,
  durationMs: Date.now() - tape.t0,
  events,
};
mkdirSync('results', { recursive: true });
writeFileSync(`results/x402-trust-merchant-${Date.now()}.json`, JSON.stringify(summary, null, 2));
if (argv.has('--json')) console.log(JSON.stringify(summary));

function summarise(body) {
  if (!body) return '(empty)';
  if (typeof body !== 'object') return String(body).slice(0, 60);
  if (body.timezone) return `${body.timezone} ${body.utc_offset ?? ''}${body.local_time ? ` · local ${body.local_time}` : ''}`.trim();
  if (body.check) return `${body.check.verdict} · score ${body.check.score}/3`;
  if (body.certificate) return `certificate ${String(body.certificate.digest ?? '').slice(0, 16)}…`;
  const flat = JSON.stringify(body).replace(/["{}[\]]/g, '');
  return flat.length > 58 ? flat.slice(0, 57) + '…' : flat;
}
