// lib/guard.mjs — the only file standing between an autonomous agent and your money.
// Every spend goes through here. No exceptions, no "just this once" in run.mjs.

import { existsSync } from 'node:fs';

const micros = (name, fallback) => BigInt(process.env[name] ?? fallback);

export const LIMITS = {
  maxPerCall: micros('MAX_PER_CALL_MICROS', '100000'),   // $0.10
  maxTotal: micros('MAX_TOTAL_MICROS', '500000'),        // $0.50
  networks: (process.env.ALLOW_NETWORKS ?? 'eip155:8453,eip155:84532').split(','),
  killSwitch: process.env.KILL_SWITCH_FILE ?? './STOP',
};

export class Refused extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
    this.refused = true;
  }
}

export class Budget {
  constructor(limits = LIMITS) {
    this.limits = { ...LIMITS, ...limits };
    this.spent = 0n;
    this.calls = 0;
  }

  // Called before signing. Throws Refused with a human sentence — the agent's
  // refusal has to be explainable on stage in one line.
  approve({ url, amount, network, payTo }) {
    if (existsSync(this.limits.killSwitch)) {
      throw new Refused('kill switch present', `remove ${this.limits.killSwitch} to resume`);
    }
    if (!this.limits.networks.includes(network)) {
      throw new Refused('network not allowed', `${network} is not in the allowlist`);
    }
    if (BigInt(amount) > this.limits.maxPerCall) {
      throw new Refused('price above per-call cap', `${amount} > ${this.limits.maxPerCall}`);
    }
    if (this.spent + BigInt(amount) > this.limits.maxTotal) {
      throw new Refused('session budget exhausted', `${this.spent + BigInt(amount)} > ${this.limits.maxTotal}`);
    }
    // Last gate: never sign a payment with nowhere to send it.
    if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(String(payTo))) {
      throw new Refused('offer has no usable payTo', 'refusing to sign a payment with nowhere to send it');
    }
    this.spent += BigInt(amount);
    this.calls += 1;
    return true;
  }
}
