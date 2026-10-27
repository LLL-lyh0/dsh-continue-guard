/**
 * Meta-gate: the README's check counts must match reality.
 *
 * Rationale: the counts in README.md were maintained by hand and silently drifted
 * (it said 89 while the suite already ran 100). A number a human has to remember
 * to update is a number that is eventually wrong, and a wrong count makes the
 * whole verification section read as boilerplate — which is exactly how a real
 * gate gets ignored later.
 *
 * This runs the four gates for real, parses what each one actually executed, and
 * refuses to pass if README quotes anything else — the per-script numbers, the
 * total, or the list itself.
 *
 * Run: node scripts/check-readme-counts.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const README = join(ROOT, 'README.md');

const GATES = ['verify-host', 'verify-client', 'verify-bundle', 'verify-mount'];

const failures = [];
const check = (name, body) => {
  try {
    body();
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  \u2717 ${name}\n      ${error.message}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

// --- what each gate ACTUALLY ran -------------------------------------------
const measured = new Map();
for (const gate of GATES) {
  const result = spawnSync(process.execPath, [join(HERE, `${gate}.mjs`)], { encoding: 'utf8', timeout: 120000 });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const line = out.match(/All (\d+) \w+ checks passed/);
  if (result.status !== 0 || line === null) {
    failures.push(`${gate}.mjs did not pass cleanly — fix that before trusting any count`);
    console.log(`  \u2717 ${gate}.mjs exited ${result.status} without an "All N ... checks passed" line`);
    measured.set(gate, null);
    continue;
  }
  measured.set(gate, Number(line[1]));
}

const readme = readFileSync(README, 'utf8');

// --- the numbers README quotes ---------------------------------------------
const listed = new Map();
for (const match of readme.matchAll(/verify-([a-z-]+)\.mjs\s+#\s*(\d+) \u9879/g)) {
  listed.set(`verify-${match[1]}`, Number(match[2]));
}

check('README lists all four gates with counts', () => {
  for (const gate of GATES) {
    assert(listed.has(gate), `README has no "verify-${gate.replace('verify-', '')}.mjs  # N 项" line`);
  }
});

check('every per-gate count in README matches what the gate ran', () => {
  const wrong = [];
  for (const gate of GATES) {
    const actual = measured.get(gate);
    if (actual === null || actual === undefined) continue;
    const quoted = listed.get(gate);
    if (quoted !== actual) wrong.push(`${gate}: README says ${quoted}, the gate ran ${actual}`);
  }
  assert(wrong.length === 0, wrong.join('; '));
});

check('the README total is the sum of the four gates', () => {
  const totals = [...readme.matchAll(/\u4e00\u6b21\u8dd1\u5b8c\uff08(\d+) \u9879\uff09/g)];
  assert(totals.length === 1, `expected exactly one "\u4e00\u6b21\u8dd1\u5b8c\uff08N \u9879\uff09" in README, found ${totals.length}`);
  const quoted = Number(totals[0][1]);
  const sum = GATES.reduce((acc, gate) => acc + (measured.get(gate) ?? 0), 0);
  assert(quoted === sum, `README says ${quoted} \u9879, the four gates sum to ${sum}`);
});

check('the README total also equals the sum it lists', () => {
  const quoted = Number([...readme.matchAll(/\u4e00\u6b21\u8dd1\u5b8c\uff08(\d+) \u9879\uff09/g)][0][1]);
  const sum = [...listed.values()].reduce((a, b) => a + b, 0);
  assert(quoted === sum, `README total ${quoted} \u2260 sum of its own per-gate numbers ${sum}`);
});

if (failures.length > 0) {
  console.log(`\n${failures.length} README count problem(s).`);
  process.exit(1);
}
console.log(`\nREADME counts agree with the suite (${GATES.reduce((a, g) => a + measured.get(g), 0)} checks across ${GATES.length} gates).`);
