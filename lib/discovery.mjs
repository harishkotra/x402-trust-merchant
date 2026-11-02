// lib/discovery.mjs — find services we have never seen, using the public x402 Bazaar.
// No API key. No account. This is what "discovery" means: a search index for
// payable endpoints, ranked by relevance and by observed quality.

const BAZAAR = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const SEARCH = 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';

const normalise = (r) => {
  const a = (r.accepts ?? [])[0] ?? {};
  return {
    url: r.resource ?? r.url,
    description: r.description ?? r.metadata?.description ?? '',
    network: a.network,
    asset: a.asset,
    amount: BigInt(a.amount ?? a.maxAmountRequired ?? '0'),
    payTo: a.payTo,
    name: a.extra?.name,
    version: a.extra?.version,
    scheme: a.scheme ?? 'exact',
    quality: r.quality ?? null,
    lastCalled: r.quality?.lastCalledAt ?? null,
    host: safeHost(r.resource ?? r.url),
  };
};

export function safeHost(u) {
  try {
    return new URL(u).host;
  } catch {
    return String(u ?? '?');
  }
}

// Full-text/semantic search over the catalog. Falls back to the paginated
// list + local filter if the search endpoint is unavailable.
export async function search(query, { limit = 8 } = {}) {
  const url = `${SEARCH}?query=${encodeURIComponent(query)}&limit=${limit}`;
  let body;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`search ${res.status}`);
    body = await res.json();
  } catch {
    const res = await fetch(`${BAZAAR}?limit=200`, { headers: { accept: 'application/json' } });
    body = await res.json();
  }
  const items = body.resources ?? body.items ?? [];
  const q = query.toLowerCase();
  const scored = items
    .map(normalise)
    .filter((r) => r.url)
    .map((r) => {
      const text = `${r.description} ${r.url}`.toLowerCase();
      const hits = q.split(/\s+/).filter((w) => w.length > 3 && text.includes(w)).length;
      return { ...r, hits };
    })
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits || rank(b) - rank(a));
  return scored.slice(0, limit);
}

// Rank a candidate the way a buyer should: recent activity beats loud marketing.
export function rank(r) {
  const calls = r.quality?.callCount ?? 0;
  const payers = r.quality?.uniquePayers ?? 0;
  return Math.min(calls, 500) * 0.1 + Math.min(payers, 50) * 3;
}
