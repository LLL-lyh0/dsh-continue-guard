/**
 * Reverse-mutation gate for STARTUP RECOVERY (crash recovery + host shutdown).
 *
 * Why this file exists: the wake call shipped with the wrong argument list —
 * `agents.resume(scope, options)` against a service whose signature is
 * `resume(options)` — and EVERY gate passed. The rules were right, the wiring was
 * right, and the mount fake had no `resume` at all, so the one call that crosses
 * into the loop driver was never executed by a test. A green suite said "startup
 * recovery works" while the feature silently did nothing.
 *
 * Each mutation below puts ONE defect back into the real source, names the gate
 * that must notice, and requires that gate to go red with that check's name in
 * its failure list. A mutation that survives is an untested behaviour, and the
 * `agents.resume` arity one is here first because it is the one that got through.
 *
 * Run: node scripts/mutate-startup.mjs   (or: npm run test:mutation)
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
const HOST_GATE = join(ROOT, 'scripts', 'verify-host.mjs');
const MOUNT_GATE = join(ROOT, 'scripts', 'verify-mount.mjs');

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const MUTATIONS = [
  {
    // THE SHIPPED BUG. `ctx.agents` is the AgentRegistry FACADE, which supplies
    // `ownerCtx` itself; passing a context first makes `options` the context,
    // `options.resumeSessionId` undefined, and the resume dies on a schema check
    // before it ever opens the log.
    name: 'the wake hands the service a context as if it were the loop (two-argument resume)',
    file: INDEX,
    from: '              await scope.agents.resume({ resumeSessionId: sessionId });',
    to: '              await scope.agents.resume(scope, { resumeSessionId: sessionId });',
    gate: 'verify-mount.mjs',
    catches: 'through the service contract',
  },
  {
    // The SAME defect, judged by the STATIC gate instead of the behavioural one.
    // Two independent gates for one bug is deliberate here: the static check has
    // no fake to get wrong, and the behavioural one proves the wiring actually
    // runs. Either alone would have missed the day the other is weakened.
    name: 'the two-argument resume, as seen by the static contract check',
    file: INDEX,
    from: '              await scope.agents.resume({ resumeSessionId: sessionId });',
    to: '              await scope.agents.resume(scope, { resumeSessionId: sessionId });',
    gate: 'verify-bundle.mjs',
    catches: 'the way the service is actually shaped',
  },
  {
    // REDUNDANT BY DESIGN, so this one mutation removes BOTH arming edges.
    //
    // After a recovery wake the published agent starts IDLE, and two independent
    // things can arm the delayed send: the explicit `observeIdle` nudge, and the
    // network monitor's first null→true edge, which evaluates every known session.
    // Which one wins is a race on the mount timing. Measured, not assumed: with
    // EITHER edge removed alone the mount gate stays green; only removing BOTH
    // turns it red. A mutation that deletes one edge of a redundant pair is
    // therefore not observable, and reporting it as MISSED would be the runner's
    // mistake rather than the gate's — so the mutation targets the real invariant
    // ("a woken session gets armed") instead of one of the two ways to satisfy it.
    name: 'a woken session is never armed (both arming edges removed)',
    file: INDEX,
    edits: [
      ['              created.observeIdle(sessionId);', '              // mutation: no idle nudge'],
      [
        '      if (wasReachable !== true && this.config.autoResume) {',
        '      if (false && wasReachable !== true && this.config.autoResume) {',
      ],
    ],
    gate: 'verify-mount.mjs',
    catches: 'actually resumed',
  },
  {
    // The poisoning case: the harness's own `{"kind":"interrupted"}` closer marks a
    // turn it repaired on someone's behalf. Stop reading it as a crash and the
    // session is skipped — and, because trying once is what writes the closer, it
    // can never be picked up again by any later scan.
    name: 'the harness\'s own interrupted-turn closer stops counting as a crash',
    file: INDEX,
    from: "  if (endKind === 'interrupted') return { reason: 'host.exit', event: events[lastEnd] };",
    to: "  if (false) return { reason: 'host.exit', event: events[lastEnd] };",
    gate: 'verify-host.mjs',
    catches: 'already repaired is still resumable',
  },
  {
    name: 'an open turn stops being the fingerprint of a killed process',
    file: INDEX,
    from: "  if (lastStart > lastEnd) return { reason: 'process.exit', event: events[lastStart] };",
    to: '  if (false) return { reason: \'process.exit\', event: events[lastStart] };',
    gate: 'verify-host.mjs',
    catches: 'an unclosed turn is read as a process exit',
  },
  {
    // A graceful shutdown CLOSES the running turn (`{kind:'aborted',
    // reason:{kind:'disposed'}}`), so the open-turn test above cannot see it.
    name: 'a graceful host shutdown is no longer recognised after a restart',
    file: INDEX,
    from: "      return { reason: 'host.exit', event: events[lastEnd] };",
    to: '      return null;',
    gate: 'verify-host.mjs',
    catches: 'a graceful host shutdown is picked up after a restart',
  },
  {
    name: 'the startup switch no longer gates a recovered crash episode',
    file: INDEX,
    from: "    if (reason === 'process.exit') return this.config.startupResume;",
    to: "    if (reason === 'process.exit') return false;",
    gate: 'verify-host.mjs',
    catches: 'a recovered process.exit episode is resumable',
  },
  {
    name: 'a deliberate stop is resurrected by the scan',
    file: INDEX,
    from: "    if (kind === 'aborted' && (by === 'user' || by === 'parent' || by === 'disposed')) return null;",
    to: "    if (false) return null;",
    gate: 'verify-host.mjs',
    catches: 'a deliberate abort is not an interruption',
  },
  {
    name: 'the scan races a session somebody is already driving',
    file: INDEX,
    from: "    if (agent !== undefined && agent !== null && String(agent.status ?? '').toLowerCase() === 'running') {",
    to: '    if (false) {',
    gate: 'verify-host.mjs',
    catches: 'the scan never races a session that is already running',
  },
  {
    name: 'the scan ignores its cap and wakes every session in the window',
    file: INDEX,
    from: '    if (summary.resumed >= limit) break;',
    to: '    if (false) break;',
    gate: 'verify-host.mjs',
    catches: 'the scan obeys its cap and its switches',
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
for (const path of [INDEX, HOST_GATE, MOUNT_GATE]) {
  originals.set(path, readFileSync(path));
  baseline[path] = sha(path);
}

let missed = 0;
for (const mutation of MUTATIONS) {
  const source = originals.get(mutation.file).toString('utf8');
  // Most mutations are one literal swap; a defect that lives in two places (see
  // the redundancy note above) declares `edits` instead.
  const edits = mutation.edits ?? [[mutation.from, mutation.to]];
  const missing = edits.find(([from]) => !source.includes(from));
  if (missing !== undefined) {
    // A stale anchor is NOT a pass: the mutation never applied, so "everything
    // stayed green" would be a vacuous result dressed up as a caught defect.
    console.log(`  ?? ANCHOR NOT FOUND  ${mutation.name}`);
    missed += 1;
    continue;
  }
  let mutated = source;
  for (const [from, to] of edits) mutated = mutated.replace(from, to);
  writeFileSync(mutation.file, mutated, 'utf8');

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
for (const path of [INDEX, HOST_GATE, MOUNT_GATE]) {
  if (sha(path) !== baseline[path]) { restored = false; console.log(`  !! NOT RESTORED: ${path}`); }
}
console.log(`\n${MUTATIONS.length - missed}/${MUTATIONS.length} caught; restored byte-identical: ${restored}`);
process.exit(missed === 0 && restored ? 0 : 1);
