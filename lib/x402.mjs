// lib/x402.mjs — the whole payment flow, small enough to read aloud on stage.
//
//   1. ask for the resource
//   2. get 402 + a machine-readable price
//   3. sign an EIP-3009 authorisation for exactly that price
//   4. retry with X-PAYMENT, receive the result and a settlement receipt
//
// Reality check, observed on 2026-11-01 against live sellers:
//   · some return the challenge as a JSON body (x402Version 1 or 2)
//   · some return it in a `payment-required` header and an empty body
//   · some say network "base", some say "eip155:8453"
//   · some say maxAmountRequired, some say amount
// The spec calls these "dialects". You will meet all of them.

import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { Budget, Refused } from './guard.mjs';
import { usd } from './tape.mjs';

export const PAYMENT_HEADER = 'X-PAYMENT';
export const SETTLEMENT_HEADER = 'X-PAYMENT-RESPONSE';

export const NETWORK_ALIASES = {
  base: 'eip155:8453',
  'base-mainnet': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  ethereum: 'eip155:1',
  mainnet: 'eip155:1',
  sepolia: 'eip155:11155111',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  avalanche: 'eip155:43114',
  arbitrum: 'eip155:42161',
  optimism: 'eip155:10',
  bsc: 'eip155:56',
  'solana-mainnet': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
};

export const normaliseNetwork = (n) => NETWORK_ALIASES[String(n).toLowerCase()] ?? n;

const CHAIN_ID = (network) => Number(normaliseNetwork(network).split(':')[1]);

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export function parseAccepts(body) {
  const list = body?.accepts ?? body?.paymentRequirements ?? [];
  return list.map((a) => ({
    scheme: a.scheme ?? 'exact',
    network: normaliseNetwork(a.network),
    asset: a.asset ?? a.token ?? a.extra?.asset,
    payTo: a.payTo ?? a.recipient ?? a.payee ?? a.extra?.payTo ?? a.extra?.recipient,
    amount: BigInt(a.amount ?? a.maxAmountRequired ?? '0'),
    resource: a.resource,
    description: a.description ?? body?.error ?? '',
    mimeType: a.mimeType,
    maxTimeoutSeconds: a.maxTimeoutSeconds ?? 60,
    name: a.extra?.name ?? 'USD Coin',
    version: a.extra?.version ?? '2',
  }));
}

// Read a 402 whether the challenge is in the body or in a header.
export async function readChallenge(res) {
  const headerValue = res.headers.get('payment-required') ?? res.headers.get('x-payment-required');
  let body = {};
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }
  let dialect = 'body';
  if (!body?.accepts && headerValue) {
    try {
      body = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
      dialect = 'header';
    } catch {
      /* fall through to empty */
    }
  }

  // MPP: the same seller may also advertise a second rail in WWW-Authenticate
  // ("Payment method=tempo ..."). An agent that only knows X-PAYMENT meets a
  // challenge it cannot answer — that is a contract mismatch, not a bug.
  const auth = res.headers.get('www-authenticate') ?? '';
  const mpp = /^\s*Payment\b/i.test(auth)
    ? {
        raw: auth,
        id: (auth.match(/id="([^"]+)"/) ?? [])[1] ?? null,
        realm: (auth.match(/realm="([^"]+)"/) ?? [])[1] ?? null,
        method: (auth.match(/method="([^"]+)"/) ?? [])[1] ?? null,
      }
    : null;

  const accepts = parseAccepts(body);
  return {
    dialect,
    x402Version: body?.x402Version ?? null,
    error: body?.error ?? null,
    accepts,
    mpp,
    raw: body,
  };
}

export function chooseAccept(accepts, { network, maxAmount }) {
  const usable = accepts.filter(
    (a) => a.scheme === 'exact' && (!network || a.network === network) && (!maxAmount || a.amount <= maxAmount),
  );
  if (!usable.length) return null;
  return usable.sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0];
}

export async function signAuthorization(accept, account) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: accept.payTo,
    value: accept.amount,
    validAfter: BigInt(now - 600),
    validBefore: BigInt(now + Math.min(accept.maxTimeoutSeconds, 600)),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await account.signTypedData({
    domain: {
      name: accept.name,
      version: accept.version,
      chainId: CHAIN_ID(accept.network),
      verifyingContract: accept.asset,
    },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });
  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network: accept.network,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function decodeSettlement(header) {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return { raw: header };
  }
}

/**
 * Ask a URL for a resource, pay if asked, return the result.
 * mode: 'live' | 'dry'  ('dry' does the full negotiation and builds the
 * signature, then stops before any money moves)
 */
export async function pay(
  url,
  { mode = 'dry', account = null, budget = new Budget(), network = null, method = 'GET', body = null, onEvent = () => {} } = {},
) {
  const send = (headers = {}) =>
    fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

  const first = await send();

  // Free resource? Nothing to buy.
  if (first.status !== 402) {
    const text = await first.text();
    return { ok: first.ok, status: first.status, body: safeParse(text), paid: false, accept: null, settlement: null, challenge: null };
  }

  const challenge = await readChallenge(first);
  onEvent('challenge', { dialect: challenge.dialect, accepts: challenge.accepts.length });

  const accept = chooseAccept(challenge.accepts, { network });
  if (!accept) {
    throw new Refused(
      'no acceptable price',
      challenge.accepts.length
        ? `offered ${challenge.accepts.map((a) => `${a.network}/${usd(a.amount)}`).join(', ')}`
        : `402 with no readable price (dialect: ${challenge.dialect})`,
    );
  }

  budget.approve({ url, amount: accept.amount, network: accept.network, payTo: accept.payTo });
  onEvent('approved', { accept });

  if (mode === 'dry') {
    return { ok: true, status: 402, body: null, paid: false, accept, settlement: null, challenge, dryRun: true };
  }
  if (!account) throw new Refused('no wallet', 'set PRIVATE_KEY for --live');

  const header = await signAuthorization(accept, account);
  onEvent('signed', { bytes: header.length });

  // Header names are the live disagreement in x402 today: v1 says X-PAYMENT,
  // v2 says PAYMENT-SIGNATURE, MPP says Authorization: Payment. Offer x402
  // first; if the seller calls it ambiguous, drop to one header and retry.
  const attempts = [
    { 'payment-signature': header, 'x-payment': header },
    { 'payment-signature': header },
  ];
  if (challenge.mpp) attempts.push({ authorization: `Payment ${header}` });

  let second = null;
  for (const credentials of attempts) {
    second = await send(credentials);
    if (second.status !== 400) break;
    const probe = await second.clone().text();
    if (!/ambiguous/i.test(probe)) break;
  }
  const settlement =
    decodeSettlement(second.headers.get(SETTLEMENT_HEADER)) ??
    decodeSettlement(second.headers.get('payment-response'));
  const reply = safeParse(await second.text());

  return {
    ok: second.ok,
    status: second.status,
    body: reply,
    paid: second.ok && Boolean(settlement),
    accept,
    settlement,
    challenge,
    headerBytes: header.length,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text: String(text).slice(0, 800) };
  }
}

export function walletFrom(env = process.env) {
  const key = env.PRIVATE_KEY;
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('PRIVATE_KEY must be a 32-byte hex string');
  return privateKeyToAccount(key);
}
