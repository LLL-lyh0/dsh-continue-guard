/**
 * Reverse-mutation gate for the standing network monitor.
 *
 * A new feature's tests prove nothing until you show they FAIL when the feature
 * is taken away. Each mutation below puts ONE specific defect back into the real
 * source, names the gate that is supposed to notice, and requires that gate to
 * go red WITH that check's name in the failure list. A mutation that survives is
 * either an untested behaviour or a gate that is merely decorative.
 *
 * The runner deliberately runs ONE named gate per mutation. An earlier runner
 * pointed every mutation at a single suite and reported five "MISSED" results
 * that were really just the wrong gate being asked.
 *
 * Run: node scripts/mutate-monitor.mjs   (or: npm run test:mutation)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-relative so this runs from anywhere: `fileURLToPath` also decodes the
// Windows drive-letter path that `URL.pathname` would leave as `/D:/...`.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX = join(ROOT, 'index.js');
const MOUNT_GATE = join(ROOT, 'scripts', 'verify-mount.mjs');

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const MUTATIONS = [
  {
    name: 'the plugin never asks at mount, only on its 10 s tick',
    file: INDEX,
    from: "      void created.checkNetwork('mount');",
    to: '      // mutation: no mount check',
    gate: 'verify-mount.mjs',
    catches: 'the monitor starts asking at mount',
  },
  {
    name: 'the heartbeat ignores the configured cadence',
    file: INDEX,
    from: '      }, resolved.netCheckIntervalMs);',
    to: '      }, 60 * 60 * 1000);',
    gate: 'verify-mount.mjs',
    catches: 'the heartbeat runs at the configured cadence',
  },
  {
    name: 'a second caller starts its own probe instead of joining the first',
    file: INDEX,
    from: '    if (this.netChecking !== null) return this.netChecking;',
    to: '    if (false) return this.netChecking;',
    gate: 'verify-host.mjs',
    catches: 'overlapping heartbeats share one check',
  },
  {
    name: 'the targets are probed one after another',
    file: INDEX,
    // A syntactically VALID serialisation: every fetch is gated behind the
    // previous one settling plus a delay, so the targets are no longer in flight
    // together. An earlier attempt spliced an `await` into the executor (which is
    // not an async function) and an unbalanced `for` loop; both made the module
    // fail to PARSE, so the gate went red for the wrong reason — a false CAUGHT
    // that would have hidden a genuine hole.
    from: '  const doFetch = options.fetchImpl ?? fetch;',
    to: [
      '  const rawFetch = options.fetchImpl ?? fetch;',
      '  let __chain = Promise.resolve();',
      '  const doFetch = (url, init) => {',
      '    const slot = __chain.then(() => rawFetch(url, init));',
      '    __chain = slot.then(() => new Promise((r) => setTimeout(r, 200)), () => new Promise((r) => setTimeout(r, 200)));',
      '    return slot;',
      '  };',
    ].join('\n'),
    gate: 'verify-host.mjs',
    catches: 'the fast check starts every target in parallel',
  },
  {
    name: 'a failed check no longer marks the link down',
    file: INDEX,
    from: '      this.networkDown = true;\n      if (wasReachable === true) {',
    to: '      if (wasReachable === true) {',
    gate: 'verify-host.mjs',
    catches: 'the monitor holds resumes when the link goes down',
  },
  {
    name: 'the false→true edge no longer wakes the waiting sessions',
    file: INDEX,
    from: '      if (wasReachable !== true && this.config.autoResume) {\n        for (const sessionId of [...this.sessions.keys()]) this.evaluate(sessionId, `net:${trigger}`);\n      }',
    to: '      if (false) {\n        for (const sessionId of [...this.sessions.keys()]) this.evaluate(sessionId, `net:${trigger}`);\n      }',
    gate: 'verify-host.mjs',
    catches: 'the monitor resumes a waiting session when the link comes back',
  },
  {
    name: 'a transport-shaped interruption trusts a stale success',
    file: INDEX,
    from: "    if (reason === 'network.down' || reason === 'network.stream') this.lastProbe = null;",
    to: '    // mutation: keep the stale probe result',
    gate: 'verify-host.mjs',
    catches: 'a transport failure outranks a check',
  },
  {
    name: 'a completed turn is no longer treated as proof the link works',
    file: INDEX,
    from: "      if (endKind?.kind === 'completed') core.noteReachabilityWitness('turn/end');",
    to: '      if (false) core.noteReachabilityWitness(\'turn/end\');',
    gate: 'verify-mount.mjs',
    catches: 'a completed turn overrides a blocked probe',
  },
  {
    name: 'an empty probe list is read as "the internet is down"',
    file: INDEX,
    from: '  if (urls.length === 0) return { ok: true, url: null, status: 0, attempts: 0, ms: 0, skipped: true };',
    to: '  if (urls.length === 0) return { ok: false, url: null, status: 0, attempts: 0, ms: 0, skipped: true };',
    gate: 'verify-host.mjs',
    catches: 'an unconfigured probe cannot wedge',
  },
];

function runGate(name) {
  try {
    const out = execFileSync(process.execPath, [`${ROOT}/scripts/${name}`], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { text: out, red: false };
  } catch (error) {
    return { text: `${error.stdout ?? ''}\n${error.stderr ?? ''}`, red: true };
  }
}

// Held in memory, not shelled out to `.bak` copies beside the source: a backup
// file dropped into the package would ship with it, and restore-from-memory is
// what the byte-identical check at the end actually validates.
const originals = new Map();
const baseline = {};
for (const path of [INDEX, MOUNT_GATE]) {
  originals.set(path, readFileSync(path));
  baseline[path] = sha(path);
}

let missed = 0;
for (const mutation of MUTATIONS) {
  const source = originals.get(mutation.file).toString('utf8');
  if (!source.includes(mutation.from)) {
    console.log(`  ?? ANCHOR NOT FOUND  ${mutation.name}`);
    missed += 1;
    continue;
  }
  writeFileSync(mutation.file, source.replace(mutation.from, mutation.to), 'utf8');

  const result = runGate(mutation.gate);
  const caught = result.red && (mutation.catches === null || result.text.includes(mutation.catches));
  console.log(`  ${caught ? 'ok CAUGHT' : 'XX MISSED'}  ${mutation.name}  [${mutation.gate}]`);
  if (!caught) {
    missed += 1;
    console.log(`     red=${result.red} expected="${mutation.catches}"`);
    console.log(`     ${result.text.trim().split('\n').slice(-4).join('\n     ')}`);
  }

  // Restore immediately: the next iteration must mutate pristine source, and a
  // half-restored file would silently turn every later result into a lie.
  writeFileSync(mutation.file, originals.get(mutation.file));
}

let restored = true;
for (const path of [INDEX, MOUNT_GATE]) {
  if (sha(path) !== baseline[path]) { restored = false; console.log(`  !! NOT RESTORED: ${path}`); }
}
console.log(`\n${MUTATIONS.length - missed}/${MUTATIONS.length} caught; restored byte-identical: ${restored}`);
process.exit(missed === 0 && restored ? 0 : 1);
