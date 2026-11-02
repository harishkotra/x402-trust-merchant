// seller/certificate.mjs — the result the agent actually buys.
// An ed25519 attestation anyone can verify offline. No chain call needed at
// verification time: the proof travels with the artifact.

import { generateKeyPairSync, sign, verify, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYFILE = join(HERE, '..', '.demo-seller-key.json');

function keypair() {
  if (existsSync(KEYFILE)) {
    const j = JSON.parse(readFileSync(KEYFILE, 'utf8'));
    return { publicKey: j.publicKey, privateKey: j.privateKey };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const j = {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  writeFileSync(KEYFILE, JSON.stringify(j, null, 2));
  return j;
}

const KEYS = keypair();

export function canonical(core) {
  // Deterministic ordering. A certificate you can't hash is a certificate you
  // can't verify, and that is the whole point of the artifact.
  return JSON.stringify(
    {
      v: core.v,
      issuer: core.issuer,
      buyer: core.buyer,
      item: core.item,
      amount: core.amount,
      network: core.network,
      settlement: core.settlement,
      issuedAt: core.issuedAt,
      nonce: core.nonce,
    },
    Object.keys(core).sort(),
  );
}

export function mint({ buyer, item, amount, network, settlement, issuer = 'devcon8004.demo' }) {
  const core = {
    v: 1,
    issuer,
    buyer,
    item,
    amount: String(amount),
    network,
    settlement,
    issuedAt: new Date().toISOString(),
    nonce: randomUUID(),
  };
  const body = canonical(core);
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = sign(null, Buffer.from(body), KEYS.privateKey).toString('base64');
  return { ...core, digest, signature, publicKey: KEYS.publicKey };
}

export function check(cert) {
  const body = canonical(cert);
  return verify(null, Buffer.from(body), KEYS.publicKey, Buffer.from(cert.signature, 'base64'));
}

export function toMarkdown(cert) {
  return [
    `# Certificate of Purchase`,
    ``,
    `**Issuer** ${cert.issuer}`,
    `**Buyer** \`${cert.buyer}\``,
    `**Item** ${cert.item}`,
    `**Paid** ${(Number(cert.amount) / 1e6).toFixed(4)} USDC on ${cert.network}`,
    `**Settlement** \`${cert.settlement}\``,
    `**Issued** ${cert.issuedAt}`,
    ``,
    `---`,
    `digest \`${cert.digest}\``,
    ``,
    `This artifact verifies offline. It is a seller attestation, not a proof`,
    `that the underlying work was good.`,
  ].join('\n');
}
