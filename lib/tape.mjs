// lib/tape.mjs — the receipt tape. Every purchase prints a line, live, as it settles.
// This is the artifact the audience actually reads. Keep it boring and monospaced.

const W = 76;
const C = {
  off: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const pad = (s, n) => {
  s = String(s ?? '');
  if (s.length < n) return s + ' '.repeat(n - s.length);
  // Break on a word: "Resolve the timezone f…" looks like a bug on a projector.
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 4 ? cut.slice(0, sp) : cut).replace(/[\s,;:·-]+$/, '') + '…';
};

const usd = (base) => {
  const v = Number(base) / 1e6;
  return '$' + (v === 0 ? '0.00' : v.toFixed(v < 0.01 ? 4 : 3));
};

const rule = (ch = '─') => ch.repeat(W);

export class Tape {
  constructor(title = 'RECEIPT TAPE') {
    this.title = title;
    this.n = 0;
    this.t0 = Date.now();
    this.total = 0n;
    this.sellers = new Set();
    this.failures = 0;
    this.header();
  }

  header() {
    const t = ` ${this.title} `;
    const side = Math.max(2, Math.floor((W - t.length) / 2));
    console.log('');
    console.log(C.dim + '━'.repeat(side) + C.bold + C.cyan + t + C.off + C.dim + '━'.repeat(W - side - t.length) + C.off);
  }

  // phase: DISCOVER | SELECT | CHECK | PAY | RESULT | REFUSE
  async step(phase, detail, { value = '', ok = null, sub = null } = {}) {
    this.n += 1;
    const num = String(this.n).padStart(2, '0');
    const colour =
      ok === false ? C.red : ok === true ? C.green : phase === 'REFUSE' ? C.yellow : C.cyan;
    const head = `${C.dim}${num}${C.off} ${C.bold}${colour}${pad(phase, 9)}${C.off}`;
    const tail = value ? C.dim + pad(String(value), 14) + C.off : '';
    const dw = W - 2 - 9 - 1 - (value ? 14 : 0);
    console.log(`${head} ${pad(detail, value ? dw - 1 : dw)}${value ? ` ${tail}` : ''}`);
    if (sub) console.log(`${C.dim}   └ ${sub}${C.off}`);
  }

  // Print a raw line inside the tape (for the returned result payload).
  result(detail) {
    console.log(`${C.dim}      ${pad(detail, W - 6)}${C.off}`);
  }

  charge(base) {
    this.total += BigInt(base);
  }

  seller(host) {
    if (host) this.sellers.add(host);
  }

  fail() {
    this.failures += 1;
  }

  footer(label = 'TOTAL SPENT', note = null) {
    const secs = Math.max((Date.now() - this.t0) / 1000, 0.4).toFixed(1);
    console.log(C.dim + rule() + C.off);
    const line =
      `${C.bold}${label}${C.off}  ${C.green}${usd(this.total)}${C.off}` +
      `   ${C.dim}·${C.off}  ${this.sellers.size} seller${this.sellers.size === 1 ? '' : 's'} touched` +
      (note ? `  ${C.dim}·${C.off}  ${C.yellow}${note}${C.off}` : `  ${C.dim}·${C.off}  ${secs}s`) +
      (this.failures ? `  ${C.dim}·${C.off}  ${C.red}${this.failures} failure${this.failures === 1 ? '' : 's'}${C.off}` : '');
    console.log(line);
    console.log(C.dim + rule() + C.off);
    console.log('');
  }
}

export { usd, C, W };
