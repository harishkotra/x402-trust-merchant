// seller/server.mjs — the seller side of the demo. Four files and one endpoint,
// in one process. It publishes what it is, what it costs, and what it returns.

import { createServer } from 'node:http';
import { verifyTypedData } from 'viem';
import { mint, toMarkdown } from './certificate.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const PAY_TO = process.env.SELLER_ADDRESS ?? '0x1111111111111111111111111111111111111111';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
const NETWORK = 'eip155:8453';
const PRICE = BigInt(process.env.SELLER_PRICE_MICROS ?? '50000'); // $0.05
const CHECK_PRICE = BigInt(process.env.CHECK_PRICE_MICROS ?? '2000'); // $0.002

// An authorisation is single-use. Without this, the same signed payload can be
// replayed and the seller hands out two results for one payment.
const usedNonces = new Set();

// Real work, not a lookup table: fetch the three documents a service is
// supposed to publish, time it, and score what actually came back.
async function checkEndpoint(target) {
  const base = target.startsWith('http')
    ? target
    : /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(target)
      ? `http://${target}`
      : `https://${target}`;
  const probes = [
    ['llms.txt', `${base}/llms.txt`],
    ['.well-known/x402', `${base}/.well-known/x402`],
    ['.well-known/agent-card.json', `${base}/.well-known/agent-card.json`],
  ];
  // Probes run concurrently: three sequential 4s timeouts is twelve seconds of
  // dead air if the target is down, and nobody watches that on a stage.
  const evidence = await Promise.all(
    probes.map(async ([probe, u]) => {
      const t0 = Date.now();
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(4000) });
        return { probe, status: res.status, ms: Date.now() - t0, present: res.ok };
      } catch (e) {
        return { probe, status: 0, ms: Date.now() - t0, present: false, error: e.name };
      }
    }),
  );
  const score = evidence.filter((e) => e.present).length;
  return { score, evidence };
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const accepts = (resource, price = PRICE) => [
  {
    scheme: 'exact',
    network: NETWORK,
    asset: ASSET,
    amount: price.toString(),
    payTo: PAY_TO,
    resource,
    description: 'A signed certificate that this agent bought something it can prove.',
    mimeType: 'application/json',
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
  },
];

// Verify the buyer's authorisation ourselves. No account, no API key, no
// session — just mathematics and a price.
async function verifyPayment(header, resource, price) {
  if (!header) return { ok: false, reason: 'missing X-PAYMENT' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed X-PAYMENT' };
  }
  if (payload.scheme !== 'exact') return { ok: false, reason: `unsupported scheme ${payload.scheme}` };
  if (payload.network !== NETWORK) return { ok: false, reason: `wrong network ${payload.network}` };

  const a = payload.payload?.authorization ?? {};
  if (BigInt(a.value ?? 0) < price) return { ok: false, reason: `underpaid: ${a.value} < ${price}` };
  if (a.to?.toLowerCase() !== PAY_TO.toLowerCase()) return { ok: false, reason: 'wrong payTo' };
  if (BigInt(a.validBefore ?? 0) < BigInt(Math.floor(Date.now() / 1000))) return { ok: false, reason: 'expired authorisation' };

  const valid = await verifyTypedData({
    address: a.from,
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ASSET },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
    signature: payload.payload.signature,
  });
  if (!valid) return { ok: false, reason: 'bad signature' };
  if (usedNonces.has(a.nonce)) return { ok: false, reason: 'authorisation already used' };
  usedNonces.add(a.nonce);
  return { ok: true, buyer: a.from, value: BigInt(a.value), resource };
}

// DEMO SETTLEMENT: in production this is where you hand the authorisation to a
// facilitator and it moves the money. Here we record the intent so the tape has
// something to print. Labelled as simulated so nobody is misled on stage.
const settlementRef = (buyer, value) =>
  'sim-' + Buffer.from(`${buyer}:${value}:${Date.now()}`).toString('hex').slice(0, 40);

const json = (res, code, body, headers = {}) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 1. What this service is. The first thing an unfamiliar agent reads.
  if (url.pathname === '/llms.txt') {
    const text = [
      '# devcon8004 demo seller',
      '',
      '> Sells one thing: a signed certificate that an agent bought something.',
      '',
      '## Endpoints',
      `- GET /buy/certificate  — ${(Number(PRICE) / 1e6).toFixed(4)} USDC on ${NETWORK} (x402, exact)`,
      '',
      '## How to pay',
      'GET the URL. Ignore the 200 you were hoping for.',
      'Read the 402 body, sign an EIP-3009 TransferWithAuthorization for the',
      'amount in accepts[0], retry with header X-PAYMENT = base64(JSON).',
      '',
      '## What you get back',
      'certificate.v, issuer, buyer, item, amount, network, settlement, digest,',
      'signature, publicKey. Verify the signature offline. It is an ed25519',
      'attestation by the seller, not a proof about the quality of the work.',
      '',
      '## Failure states',
      '- 402 with error "underpaid" — you offered less than the listed price',
      '- 402 with error "expired authorization" — validBefore has passed',
      '- 409 — you are paying for a version of this contract that no longer exists',
      '',
      'contract-version: 1.0.0',
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(text);
  }

  // 2. The discovery documents, served. An agent reads these before it pays.
  if (url.pathname === '/.well-known/x402' || url.pathname === '/.well-known/x402.json') {
    return json(res, 200, {
      x402Version: 2,
      resources: [
        {
          resource: `${url.origin}/buy/certificate`,
          scheme: 'exact',
          network: NETWORK,
          asset: ASSET,
          amount: PRICE.toString(),
          payTo: PAY_TO,
          mimeType: 'application/json',
          description: 'A signed certificate of purchase, verifiable offline.',
          maxTimeoutSeconds: 60,
        },
        {
          resource: `${url.origin}/check/endpoint`,
          scheme: 'exact',
          network: NETWORK,
          asset: ASSET,
          amount: CHECK_PRICE.toString(),
          payTo: PAY_TO,
          mimeType: 'application/json',
          description: 'A scored verdict on whether an endpoint is discoverable.',
          maxTimeoutSeconds: 60,
        },
      ],
    });
  }

  if (url.pathname === '/.well-known/schema.json') {
    return json(res, 200, {
      version: '1.0.0',
      name: 'buy_certificate',
      input: {
        type: 'object',
        required: ['item'],
        properties: { item: { type: 'string', maxLength: 120 } },
      },
      output: {
        type: 'object',
        required: ['certificate', 'markdown'],
        properties: {
          certificate: {
            type: 'object',
            required: ['version', 'buyer', 'item', 'amount', 'network', 'digest', 'signature'],
            properties: {
              version: { const: 1 },
              buyer: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
              digest: { type: 'string' },
              signature: { type: 'string' },
            },
          },
          markdown: { type: 'string' },
        },
      },
      refusal: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { enum: ['underpaid', 'bad signature', 'expired authorization', 'network not supported', 'price changed'] },
          accepts: { type: 'array', description: 'what to pay instead' },
        },
      },
    });
  }

  if (url.pathname === '/.well-known/agent.json' || url.pathname === '/.well-known/agent-card.json') {
    return json(res, 200, {
      name: 'devcon8004.demo/certificate-seller',
      version: '1.0.0',
      description: 'Sells a verifiable certificate of purchase.',
      contact: 'demo@localhost',
      x402: { network: NETWORK, asset: ASSET, scheme: 'exact' },
      tools: [
        {
          name: 'buy_certificate',
          input: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
          output: { type: 'object', properties: { digest: { type: 'string' }, signature: { type: 'string' } } },
          price: { amount: PRICE.toString(), asset: 'USDC', network: NETWORK },
        },
      ],
    });
  }

  // 2. The endpoint. One price, one result, one failure mode.
  if (url.pathname === '/buy/certificate') {
    const resource = `${url.origin}/buy/certificate`;
    const payment = await verifyPayment((req.headers['payment-signature'] ?? req.headers['x-payment']), resource, PRICE);

    if (!payment.ok) {
      return json(res, 402, { x402Version: 2, error: payment.reason, accepts: accepts(resource) });
    }

    const settlement = settlementRef(payment.buyer, payment.value);
    const cert = mint({
      buyer: payment.buyer,
      item: url.searchParams.get('item') ?? 'a certificate of purchase',
      amount: PRICE,
      network: NETWORK,
      settlement,
    });

    return json(
      res,
      200,
      { certificate: cert, markdown: toMarkdown(cert) },
      { 'x-payment-response': Buffer.from(JSON.stringify({ success: true, transaction: settlement, network: NETWORK })).toString('base64'), 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: settlement, network: NETWORK })).toString('base64') },
    );
  }

  // 3. The trust check. This is variant B's middle hop: we sell the verdict on
  //    someone else's endpoint, and the agent buys it before it buys from them.
  if (url.pathname === '/check/endpoint') {
    const resource = `${url.origin}/check/endpoint`;
    const payment = await verifyPayment((req.headers['payment-signature'] ?? req.headers['x-payment']), resource, CHECK_PRICE);
    if (!payment.ok) {
      return json(res, 402, { x402Version: 2, error: payment.reason, accepts: accepts(resource, CHECK_PRICE) });
    }

    const target = url.searchParams.get('target') ?? 'example.com';
    const verdict = await checkEndpoint(target);
    const settlement = settlementRef(payment.buyer, payment.value);

    return json(
      res,
      200,
      {
        check: {
          target,
          verdict: verdict.score >= 2 ? 'clean' : verdict.score >= 1 ? 'caution' : 'unknown',
          score: verdict.score,
          evidence: verdict.evidence,
          checkedAt: new Date().toISOString(),
          settlement,
        },
      },
      { 'x-payment-response': Buffer.from(JSON.stringify({ success: true, transaction: settlement, network: NETWORK })).toString('base64'), 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: settlement, network: NETWORK })).toString('base64') },
    );
  }

  if (url.pathname === '/health') return json(res, 200, { ok: true, price: PRICE.toString() });
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`seller listening on http://localhost:${PORT}`);
  console.log(`  GET /llms.txt`);
  console.log(`  GET /buy/certificate   ${(Number(PRICE) / 1e6).toFixed(4)} USDC · ${NETWORK}`);
});
