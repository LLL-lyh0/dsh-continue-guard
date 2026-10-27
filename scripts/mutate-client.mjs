/**
 * Reverse-mutation gate: prove the client gates can actually fail.
 *
 * A green suite means nothing unless the checks would go RED when the behaviour
 * they describe is broken. This script reintroduces each defect the manual-send
 * rewiring was meant to prevent, requires the gates to catch it, and restores
 * client.js byte-identically afterwards.
 *
 * The restore is verified by comparison, not by "it's green again": a gate can go
 * green for the wrong reason, and a half-restored file is the worst outcome —
 * the next run would be testing a mutant.
 *
 * Run: node scripts/mutate-client.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLIENT = join(ROOT, 'client.js');
const ORIGINAL = readFileSync(CLIENT, 'utf8');

/**
 * Each entry reintroduces ONE defect. `expect` must match the gate output: every
 * pattern has to appear, so a mutation cannot pass by tripping an unrelated
 * assertion.
 */
const MUTATIONS = [
  {
    name: 'sessions promoted to a static inject (the pill would vanish on a profile without it)',
    from: "inject: ['slots'],",
    to: "inject: ['slots', 'sessions'],",
    expect: [/FAILED/, /sessions is DEFERRED/],
  },
  {
    name: 'the manual path replaced by an unconditional fallback to the HTTP route',
    from: 'const direct = await submitAsUser(sessionId, text);',
    to: 'const direct = { ok: false, unavailable: true };',
    expect: [/FAILED/, /real submission pipeline/],
  },
  {
    name: 'the rejection guard removed (a rejected send would be retried down the route)',
    from: `          if (direct.unavailable !== true) {
            setFlash(\`\${t.failed}\${direct.error ? \`：\${direct.error}\` : ''}\`);
            return;
          }
`,
    to: '',
    expect: [/FAILED/, /REAL rejection/],
  },
  {
    name: 'beginSubmission dropped (the optimistic echo never registers)',
    from: "handle = session.beginSubmission({ mode: 'queue', text, attachments: [] });",
    to: 'handle = undefined;',
    expect: [/FAILED/, /real submission pipeline/],
  },
];

const runGate = (name) => {
  const result = spawnSync(process.execPath, [join(HERE, name)], { encoding: 'utf8', timeout: 120000 });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
};

let missed = 0;

for (const mutation of MUTATIONS) {
  if (!ORIGINAL.includes(mutation.from)) {
    // A stale anchor is NOT a pass: it means the mutation never applied, so the
    // "everything still green" outcome would be vacuous.
    console.log(`SKIP    ${mutation.name}\n        anchor not found — the mutation never applied`);
    missed += 1;
    continue;
  }

  writeFileSync(CLIENT, ORIGINAL.replace(mutation.from, mutation.to));
  const clientOut = runGate('verify-client.mjs');
  const bundleOut = runGate('verify-bundle.mjs');
  const combined = `${clientOut}\n${bundleOut}`;

  const caught = mutation.expect.every((pattern) => pattern.test(combined));
  const stillGreen =
    /All \d+ client checks passed/.test(clientOut) && /All \d+ bundle checks passed/.test(bundleOut);

  if (caught && !stillGreen) {
    const reported = [...combined.matchAll(/^\s*(?:\u2717|FAIL)\s*(.+)$/gm)].map((m) => m[1].trim());
    console.log(`CAUGHT  ${mutation.name}`);
    for (const line of reported.slice(0, 4)) console.log(`        ${line}`);
    console.log('');
  } else {
    missed += 1;
    console.log(`MISSED  ${mutation.name}\n        the gates stayed green — that check is decorative\n`);
  }
}

writeFileSync(CLIENT, ORIGINAL);

const restored = readFileSync(CLIENT, 'utf8') === ORIGINAL;
const clientOut = runGate('verify-client.mjs');
const bundleOut = runGate('verify-bundle.mjs');
const green =
  /All \d+ client checks passed/.test(clientOut) && /All \d+ bundle checks passed/.test(bundleOut);

console.log(`restored byte-identical: ${restored}`);
console.log(`after restore: ${clientOut.match(/All \d+ client checks passed/)?.[0] ?? 'client RED'}, ${bundleOut.match(/All \d+ bundle checks passed/)?.[0] ?? 'bundle RED'}`);
console.log(missed === 0 ? '\nAll mutations caught.' : `\n${missed} MISSED — the gate is not doing its job.`);

process.exit(missed === 0 && restored && green ? 0 : 1);
