/**
 * Reverse-mutation gate for the README meta-gate.
 *
 * `check-readme-counts.mjs` claims that the README cannot drift away from the
 * code. That claim is worth nothing until you show the gate actually goes red
 * when a drift is introduced — so these mutations introduce exactly the two
 * drifts that had really happened before (a config key added but never
 * documented, and a documented key that no longer exists), and require the named
 * check to fail.
 *
 * Run: node scripts/mutate-readme.mjs   (or: npm run test:mutation)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const README = join(ROOT, 'README.md');
const GATE = join(ROOT, 'scripts', 'check-readme-counts.mjs');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const original = readFileSync(README, 'utf8');
const baseline = sha(README);

function runGate() {
  try {
    const out = execFileSync(process.execPath, [GATE], { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    return { text: out, red: false };
  } catch (error) {
    return { text: `${error.stdout ?? ''}\n${error.stderr ?? ''}`, red: true };
  }
}

const MUTATIONS = [
  {
    name: 'a config key is added but left undocumented',
    catches: 'every Config key is documented in the README table',
    apply: (text) => text.replace(/^\| `netCheckIntervalMs`.*\n/m, ''),
  },
  {
    name: 'the table names a key the schema rejects',
    catches: 'the README table documents no key the Config schema does not have',
    apply: (text) => text.replace('| `minResumeGapMs` | `4000` |', '| `minResumeGapMsec` | `4000` |'),
  },
  {
    name: 'a gate count drifts out of date',
    catches: 'every per-gate count in README matches what the gate ran',
    // Locate the line and corrupt whatever number is on it. A hard-coded anchor
    // ("verify-host.mjs    # 63 项") duplicates a fact that changes every time a
    // check is added, so the anchor goes stale and the mutation silently skips —
    // reported as MISSED, which blames the gate for the runner's own staleness.
    // That is exactly how this mutation was caught out: it reported ANCHOR NOT
    // FOUND on the very next count bump.
    apply: (text) => {
      const line = text.match(/^node scripts\/verify-host\.mjs\s+#\s*\d+\s*项/m);
      if (line === null) return text;
      return text.replace(line[0], line[0].replace(/\d+/, (n) => String(Number(n) - 11)));
    },
  },
];

let missed = 0;
for (const mutation of MUTATIONS) {
  const mutated = mutation.apply(original);
  if (mutated === original) {
    console.log(`  ?? ANCHOR NOT FOUND  ${mutation.name}`);
    missed += 1;
    continue;
  }
  writeFileSync(README, mutated, 'utf8');
  const result = runGate();
  const caught = result.red && result.text.includes(mutation.catches);
  console.log(`  ${caught ? 'ok CAUGHT' : 'XX MISSED'}  ${mutation.name}`);
  if (!caught) {
    missed += 1;
    console.log(`     red=${result.red} expected="${mutation.catches}"`);
    console.log(`     ${result.text.trim().split('\n').slice(-4).join('\n     ')}`);
  }
  // Restore from memory after EVERY mutation: the next iteration must drift
  // pristine text, and a half-restored README would make later results lie.
  writeFileSync(README, original, 'utf8');
}

const restored = sha(README) === baseline;
if (!restored) console.log('  !! README NOT RESTORED');
console.log(`\n${MUTATIONS.length - missed}/${MUTATIONS.length} caught; restored byte-identical: ${restored}`);
process.exit(missed === 0 && restored ? 0 : 1);
