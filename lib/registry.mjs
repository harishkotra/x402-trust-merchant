// lib/registry.mjs — is the seller actually who it says it is?
// ERC-8004 deploys the same three registries at the same vanity addresses on
// every chain, because they were deployed with CREATE2. Read-only, no wallet.

const RPCS = {
  8453: process.env.RPC_BASE ?? 'https://mainnet.base.org',
  84532: process.env.RPC_BASE_SEPOLIA ?? 'https://sepolia.base.org',
  11155111: process.env.RPC_ETH_SEPOLIA ?? 'https://ethereum-sepolia-rpc.publicnode.com',
};

export const REGISTRIES = {
  mainnet: { identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' },
  testnet: { identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e', reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713' },
};

const SEL = {
  ownerOf: '0x6352211e',
  tokenURI: '0xc87b56dd',
  getVersion: '0x0d8e6e2c',
};

const word = (n) => BigInt(n).toString(16).padStart(64, '0');

async function rpc(chainId, method, params) {
  const res = await fetch(RPCS[chainId], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

function decodeString(hex) {
  if (!hex || hex === '0x') return null;
  const raw = hex.slice(2);
  if (raw.length < 128) return null;
  const offset = Number(BigInt('0x' + raw.slice(0, 64))) * 2;
  const len = Number(BigInt('0x' + raw.slice(offset, offset + 64)));
  const data = raw.slice(offset + 64, offset + 64 + len * 2);
  return Buffer.from(data, 'hex').toString('utf8');
}

/**
 * Look up an agent id in the identity registry.
 * Returns { registered, owner, registrationUrl, version } — never throws for
 * "not registered", because "not registered" is a result, not an error.
 */
export async function lookupAgent({ chainId = 84532, agentId = 1, registry = REGISTRIES.testnet } = {}) {
  const out = { chainId, agentId, registered: false, owner: null, registrationUrl: null, version: null, error: null };
  try {
    out.version = decodeString(await rpc(chainId, 'eth_call', [{ to: registry.identity, data: SEL.getVersion }, 'latest']));
  } catch (e) {
    out.error = `registry unreachable: ${e.message}`;
    return out;
  }
  try {
    const ownerHex = await rpc(chainId, 'eth_call', [
      { to: registry.identity, data: SEL.ownerOf + word(agentId) },
      'latest',
    ]);
    out.owner = '0x' + ownerHex.slice(-40);
    out.registered = true;
    try {
      const uri = decodeString(await rpc(chainId, 'eth_call', [{ to: registry.identity, data: SEL.tokenURI + word(agentId) }, 'latest']));
      out.registrationUrl = uri;
    } catch {
      /* tokenURI is optional in practice */
    }
  } catch {
    out.registered = false;
  }
  return out;
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
