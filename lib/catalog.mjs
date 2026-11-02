// lib/catalog.mjs — what the demo says when the network says nothing.
// Fixtures are not cheating: they are how you guarantee the talk survives the
// venue Wi-Fi. Every fixture entry is captured from a real response.

export const SEARCHES = {
  commodity: 'resolve timezone for latitude and longitude',
  trust: 'trust check of a third-party x402 endpoint',
  expensive: 'generate an image from a text prompt',
};

export const DEMO = {
  goal:
    'Find what time it is in Mumbai right now, and tell me whether a seller ' +
    'I have just discovered is safe to buy from.',
  commodity: { lat: 19.076, lon: 72.8777, expect: 'Asia/Kolkata · +05:30' },
};

// Fallback targets, in preference order. Used only when live search returns
// nothing usable — so a dead catalog never kills the run.
export const FALLBACK = {
  commodity: [
    { host: 'openverbs.com', url: 'https://openverbs.com/v1/timezone', amount: 4000n },
    { host: '2s.io', url: 'https://2s.io/v1/timezone', amount: 3000n },
    { host: 'rallylive.ca', url: 'https://rallylive.ca/v1/base/block', amount: 10000n },
  ],
  trust: [
    { host: 'halowerk.com', url: 'https://halowerk.com/v1/verify-endpoint', amount: 2000n },
    { host: 'agentsvc.io', url: 'https://agentsvc.io/v1/deps', amount: 4500n },
  ],
  expensive: [{ host: 'driftflight.com', url: 'https://driftflight.com/v1/image', amount: 60000n }],
};

export function fromFallback(kind, n = 0) {
  const list = FALLBACK[kind] ?? [];
  return list[n] ?? null;
}
