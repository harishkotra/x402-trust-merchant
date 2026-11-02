# x402-trust-merchant - a paid trust checker and signed certificate an agent can buy

Same errand as its sibling `x402-agent-shopper`: an agent is told *"what time is it in Mumbai, and
is the seller safe to buy from?"* and has to find, check, pay and verify — alone.

The difference is where the trust comes from. `x402-agent-shopper` buys the verdict from a second
stranger. **Here, we sell it.** One hop leaves the building; two are ours.

```
01 DISCOVER  8 candidates for "timezone"                       bazaar
   └ geospatial.openverbs.com $0.0020  ·  agentsvc.io $0.0020  ·  2s.io $0.0025
02 SELECT    geospatial.openverbs.com  Resolve the timezone… $0.0020
03 PAY       geospatial.openverbs.com · $0.0020 · settled      230ms
   └ 402 header · x402 v2 · 1 offer(s) · also MPP rail "evm"
04 RESULT    Asia/Kolkata +05:30
05 DISCOVER  trust check — served by us, not the bazaar        owned
06 SELECT    our checker · target geospatial.openverbs.com     $0.0020
07 PAY       our checker · $0.0020 · settled                   640ms
08 RESULT    verdict: caution · 1/3 · 3 probes timed
09 CHECK     ERC-8004 identity #1 on base-sepolia              0x21fd…e235
10 PAY       our seller · $0.050 · settled                     18ms
11 RESULT    certificate 9c1f… · buyer 0x21fd…e235
12 ATTEMPT   agent402.tools wants $0.030 for one image         over policy
13 REFUSE    price above per-call cap · 30000 > 20000          stopped
TOTAL SPENT  $0.054   ·  2 sellers touched  ·  2.2s
```

One external dependency, 2.2 seconds, and the whole thing still starts with a real `402`
from a server nobody in the room owns.

> **The name.** `x402-trust-merchant` is the seller half of a pair. Its sibling is
> [`x402-agent-shopper`](../x402-agent-shopper) — the buyer that shops three strangers'
> APIs first. Same errand, opposite side of the counter.

---

## The claim this repo makes

> **MCP is the handshake. x402 is the money. Neither tells the agent what it just bought.**

The interesting part is not that an agent can pay. It is that a builder can *sell a
judgement* — a probe result, a score, a signed certificate — and an agent can buy it,
verify it, and carry on. This variant is the smaller, safer proof of that: we are the
shop the agent uses to check other sellers.

---

## Quickstart

```bash
git clone <this repo> && cd x402-trust-merchant
npm install                       # one dependency: viem

node run.mjs --fixtures           # the whole tape, no network, no money
npm run seller &                  # our shop on :8787 — /check/endpoint and /buy/certificate
node run.mjs --dry                # real listings, real 402s, real signature, no money
PRIVATE_KEY=0x… node run.mjs --live
```

Node 22+. No framework, no database, no build step.

### Modes

| Mode | Network | Money | Use it for |
|---|---|---|---|
| `--fixtures` | none | none | the stage, when venue Wi-Fi dies mid-sentence |
| `--dry` | real | none | rehearsal — proves the stranger's endpoint still looks like this |
| `--live` | real | real, capped | the demo |

---

## What happens on each hop

| Hop | Who | What is bought | Why it is credible |
|---|---|---|---|
| 1 | `geospatial.openverbs.com` — a stranger | timezone for 19.076, 72.8777 | real `402`, real signature, real settlement header |
| 2 | **our checker** | a verdict on hop 1's seller | three live probes with timings, not a constant |
| 3 | **our seller** | an ed25519-signed certificate | signature verifies offline |
| — | ERC-8004 registry (testnet) | a read, not a purchase | `ownerOf` on a real contract |

---

## Architecture

```
                      ┌────────────────────────────────┐
                      │            run.mjs             │
                      │  goal → find → check → pay     │
                      │       → verify → receipt       │
                      └──────┬─────────────────┬───────┘
                             │                 │
                             ▼                 ▼
                  ┌────────────────────┐   ┌───────────────────────┐
                  │ lib/discovery.mjs  │   │ lib/guard.mjs         │
                  │ Bazaar search      │   │ Budget.approve()      │
                  └─────────┬──────────┘   │ ./STOP kill switch    │
                            │              └──────────┬────────────┘
                            ▼                         │ every signature
                  ┌─────────────────────┐             │
                  │    lib/x402.mjs     │◄────────────┘
                  │ readChallenge       │
                  │ chooseAccept · sign │
                  └────┬───────────┬────┘
                       │           │
          ┌────────────┘           └──────────────┐
          ▼                                       ▼
┌──────────────────────┐        ┌───────────────────────────────────────┐
│ stranger's 402        │        │ seller/server.mjs  (:8787)           │
│ geospatial.openverbs  │        │ /llms.txt                             │
│ (only external dep)   │        │ /.well-known/x402 · schema · agent    │
└──────────────────────┘        │ /check/endpoint   2000 μ$  ← ours     │
                                │ /buy/certificate 50000 μ$  ← ours     │
                                └──────────────┬────────────────────────┘
                                               ▼
                                ┌───────────────────────────────────────┐
                                │ checkEndpoint(): 3 probes, in parallel│
                                │ certificate.mjs: ed25519, offline     │
                                └───────────────────────────────────────┘
```

---

## The parts worth reading

### 1. The checker does real work

`/check/endpoint?target=host` fetches the three documents a service is supposed to
publish — `llms.txt`, `/.well-known/x402`, `/.well-known/agent-card.json` — times each
one and scores what actually came back:

```json
{ "target": "geospatial.openverbs.com", "verdict": "caution", "score": 1,
  "evidence": [ { "probe": "llms.txt", "status": 404, "ms": 118, "present": false }, … ] }
```

`score 3` → `clean`, `1–2` → `caution`, `0` → `unknown`. An audience can tell the
difference between a verdict and a constant, so this had to be a real probe.

The probes run **concurrently**, and the scheme is chosen from the target:

```js
// three sequential 4s timeouts is twelve seconds of dead air.
// nobody watches that on a stage.
const schemes = localhost ? ['http'] : ['https'];
const [llms, x402, card] = await Promise.all([
  probe(`${base}/llms.txt`),
  probe(`${base}/.well-known/x402`),
  probe(`${base}/.well-known/agent-card.json`),
]);
```

That `localhost` branch is not decoration. It exists because the contract test caught
the checker scoring *our own* local seller `0/3` — a bug that would have been discovered
live, on stage, in front of the room.

### 2. We publish what we expect others to publish

The seller serves the documents its own checker looks for, or the demo is a joke at our
expense:

- `/.well-known/x402` — both priced resources, with `amount`, `network`, `payTo`
- `/.well-known/schema.json` — typed input and output, versioned `1.0.0`
- `/.well-known/agent-card.json`, `/llms.txt` — the human and machine front doors

```json
{ "x402Version": 2,
  "resources": [
    { "resource": "http://localhost:8787/buy/certificate", "price": "50000" },
    { "resource": "http://localhost:8787/check/endpoint",  "price": "2000"  } ] }
```

### 3. The budget is a gate, not a log line

`lib/guard.mjs` runs *before* the signature. The refusal is a sentence, not a stack trace:

```js
if (BigInt(amount) > this.limits.maxPerCall) {
  throw new Refused('price above per-call cap', `${amount} > ${this.limits.maxPerCall}`);
}
```

```
12 ATTEMPT   agent402.tools wants $0.030 for one image   over policy
13 REFUSE    price above per-call cap · 30000 > 20000    stopped
```

`touch STOP` stops every future purchase with no restart.

### 4. The payment header is not standard yet

Three names are in the wild — `X-PAYMENT` (v1), `PAYMENT-SIGNATURE` (v2),
`Authorization: Payment` (MPP) — and one live seller rejects a request that offers both
x402 and MPP: `400 ambiguous_payment`. The client negotiates:

```js
const attempts = [
  { 'payment-signature': header, 'x-payment': header },
  { 'payment-signature': header },
];
if (challenge.mpp) attempts.push({ authorization: `Payment ${header}` });
```

### 5. An authorisation is single-use

`usedNonces` makes a replayed credential fail with `authorisation already used` instead of
minting a second certificate. The contract test asserts both the status and the reason.

### 6. The result is verifiable offline

```js
const { certificate, publicKey } = mint({ buyer: account.address, item, result });
const verification = check(certificate, publicKey);   // → { valid: true, digest }
```

Ed25519 over canonical JSON. The buyer never has to ask the seller "is this yours?".

---

## Technology

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22, ESM | `node run.mjs` is the whole deploy |
| Chain access | `viem` ^2.21 | typed EIP-712 signing, one dependency |
| Money | x402 over USDC on Base (`eip155:8453`) | sub-cent prices, no account, no invoice |
| Signature | EIP-3009 `TransferWithAuthorization` | buyer signs, facilitator pays gas |
| Seller | `node:http`, zero deps | readable in a projector font |
| Probing | `fetch` + `AbortSignal.timeout` | three concurrent probes, 4s ceiling each |
| Result signing | `node:crypto` ed25519 | verify offline |
| Identity | ERC-8004 (read-only, testnet) | a real registry, not a mock |
| Discovery | x402 Bazaar HTTP index | public, no key, live sellers |

---

## Tests

```bash
node test/e2e.mjs        # 12 checks — spawns a seller on :8899, ephemeral wallet
node test/contract.mjs   # 30 checks — the refusal matrix, plus the checker's own contract
node test/offline.mjs    #  3 checks — fixtures mode with fetch replaced by a landmine
```

The extra three checks here are the ones that matter for this variant: that
`/check/endpoint` is a *paid* call, that its verdict carries three timed evidence entries,
and that pointed at our own seller it scores `clean`. That last one is what caught the
`https`-only bug.

---

## What the demo does not do

- **Settlement is verified, not broadcast.** The seller validates the EIP-3009 signature
  and returns a settlement receipt. A real facilitator is one HTTP POST away, left out so
  the money path has no third party in it.
- **The checker is a signal, not an audit.** Three HTTP probes prove a service publishes
  discovery documents. It does not prove the service is honest.
- **The registry check proves identity, never quality.**
- **No LLM in the loop.** Deterministic on purpose: the protocol is the interesting part.

---

## Fork it and build on it

```bash
git clone <this repo> && cd x402-trust-merchant
npm install
node test/e2e.mjs && node test/contract.mjs
```

Conventions:

1. **One dependency, and it earns its place.**
2. **Every network boundary is a `lib/` module.** Swap one without touching the tape.
3. **New failure state → new contract test first.**
4. **Fixtures are captures, never hand-written.**
5. **The tape is the UI.** New capability = new line with a price and a verdict.

### Good first contributions

- **Weighted scoring** — the three probes are not equally informative; a service with a
  valid `/.well-known/x402` but no `llms.txt` is more buyable than one with neither.
  Make the verdict explain its weighting.
- **Deeper probes** — settle-ability (does the `402` name a chain the buyer supports?),
  schema presence, TLS age, response-time percentile. Each is one function.
- **Caching with freshness** — a verdict on a host is worth minutes, not forever.
  A price-aware cache is an economic feature, not an optimisation.
- **Refund path** — our checker can fail after payment; today it cannot refund.
- **Real facilitator settlement** — `lib/facilitator.mjs` is the intended seam.
- **MCP surface** — expose `find`, `check`, `pay` as MCP tools with the same budget guard.
- **Verifiable verdicts** — sign the checker's output with the same ed25519 key as the
  certificate, so a third party can verify a verdict without trusting our server.
- **Spend ledger** — every `approve()` decision to JSONL, so a buyer can audit a month.

### Pull requests

Small, single-purpose, test output pasted in. Changes to the checker need a new
`test/contract.mjs` assertion, because the checker's contract *is* the product here.

---

## Environment

```
PRIVATE_KEY=              # live mode only
MAX_PER_CALL_MICROS=20000 # $0.02 per call
MAX_TOTAL_MICROS=500000   # $0.50 per session
ALLOW_NETWORKS=eip155:8453,eip155:84532
KILL_SWITCH_FILE=./STOP
SELLER_URL=http://localhost:8787
PORT=8787
PAY_TO=0x1111111111111111111111111111111111111111
SELLER_PRICE_MICROS=50000
CHECK_PRICE_MICROS=2000
```