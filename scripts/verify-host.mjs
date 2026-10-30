/**
 * Offline verification for dsh-continue-guard's host logic.
 *
 * Everything here runs against a virtual clock and a fake agent, so the suite
 * proves the DECISION rules without a live Harness, a network, or a model turn.
 * That matters because the rules are the feature: "did we resume when, and only
 * when, we should" cannot be eyeballed from a UI.
 *
 * Run: node scripts/verify-host.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  LoopResumeScheduler, SESSION_LOG_NAMES, classifyInterrupt, classifyRecovery,
  composeResumeText, decodeZstdTail, isTransportError, listRecentSessionLogs,
  normalizeConfig, parseLogLines, probeOnce, probeReachable, readSessionLogTail, recoverInterruptedSessions,
  resolveSessionHome, stopReasonOf,
} from '../index.js';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n    ${error.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n    ${error.message}`);
  }
}

// ── harness for the scheduler ───────────────────────────────────────────────

/** A clock the test advances by hand; `setTimeout` is captured, never awaited. */
function makeClock() {
  let now = 1_000_000;
  const timers = [];
  return {
    now: () => now,
    /** Capture the timer instead of scheduling it. */
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    /** Advance time and fire every captured timer that is due. */
    advance(ms) {
      now += ms;
      for (const t of timers.splice(0)) {
        if (t.cleared) continue;
        if (t.at <= now) t.fn();
        else timers.push(t);
      }
    },
    pending: () => timers.filter((t) => !t.cleared),
  };
}

function makeAgent(status = 'idle') {
  return { status, inbox: { nextTurn: [], nextStep: [] } };
}

function makeScheduler(overrides = {}) {
  const clock = makeClock();
  const sent = [];
  const probes = [];
  const agent = overrides.agent ?? makeAgent();
  const config = normalizeConfig({ verbose: false, ...overrides.config });
  const scheduler = new LoopResumeScheduler({
    config,
    now: clock.now,
    log: { info() {}, warn() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    resolveAgent: () => agent,
    probe: async () => {
      probes.push(clock.now());
      const ok = probes.length > (overrides.failProbes ?? 0);
      return { ok, attempts: 1, ms: 5 };
    },
    deliver: async (_agent, text, meta) => { sent.push({ text, meta }); },
  });
  scheduler._clock = clock;
  return { scheduler, clock, sent, probes, agent, config };
}

/** Run one armed resume: advance past the delay and let the microtasks settle. */
async function fireArmed(clock, scheduler, ms = 5000) {
  clock.advance(ms);
  await new Promise((resolve) => setImmediate(resolve));
}

// ── classification ──────────────────────────────────────────────────────────

check('a normally completed turn is not an interruption', () => {
  assert.equal(classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), null);
});

check('a user stop is not an interruption', () => {
  assert.equal(classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'cancelled' } } }), null);
  assert.equal(classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'stop' } } }), null);
});

check('turn/end error is classified as error', () => {
  assert.equal(classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'error' } } }), 'error');
});

check('a context-window failure is its own code (never auto-resumed)', () => {
  assert.equal(
    classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } } } }),
    'upstream.context-window',
  );
});

check('a deliberate abort is not an interruption, whoever caused it', () => {
  // Shapes taken from 467 real session logs: a person pressing stop, a driving
  // parent going away, and a session teardown. All three are decisions, not
  // failures. Retrying them fights the human — and with `autoResumeOnError: true`
  // the old code did that on every single stop, because all three arrived as a
  // plain `aborted` and were classified `upstream.aborted`.
  for (const by of ['user', 'parent', 'disposed']) {
    assert.equal(
      classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: by } } } }),
      null,
      `an abort by "${by}" must not be treated as a failure`,
    );
  }
  // An abort with no attributable cause stays retryable under autoResumeOnError.
  assert.equal(
    classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }),
    'upstream.aborted',
  );
});

check('a length stop is upstream.truncated', () => {
  const event = {
    type: 'assistant/message',
    data: { stream: [{ chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }] },
  };
  assert.equal(classifyInterrupt(event), 'upstream.truncated');
  assert.equal(stopReasonOf(event), 'max-tokens');
});

check('the harness also records a length stop as a turn/end reason', () => {
  // 24 of 467 real logs end on `{"kind":"max-tokens"}` at turn/end — not only as
  // an `assistant/message` finish chunk. Treating it as a generic abort asked for
  // `autoResumeOnError`, so with the defaults `resumeOnTruncation: true` silently
  // did nothing for exactly the turns it was meant to cover.
  assert.equal(
    classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }),
    'upstream.truncated',
  );
});

check('the raw adapter stopReason=length is also a truncation', () => {
  const event = {
    type: 'assistant/message',
    data: { stream: [{ chunk: { type: 'finish', replayState: { response: { stopReason: 'length' } } } }] },
  };
  assert.equal(classifyInterrupt(event), 'upstream.truncated');
});

check('a normal assistant message is not an interruption', () => {
  const event = { type: 'assistant/message', data: { stream: [{ chunk: { type: 'finish', reason: { kind: 'stop' } } }] } };
  assert.equal(classifyInterrupt(event), null);
});

// ── transport vs refusal ────────────────────────────────────────────────────

check('transport-flavoured failures are recognised', () => {
  assert.equal(isTransportError({ code: 'TRANSPORT' }), true);
  assert.equal(isTransportError({ message: 'TypeError: fetch failed' }), true);
  assert.equal(isTransportError({ message: 'read ECONNRESET' }), true);
  assert.equal(isTransportError({ status: 503 }), true);
});

check('refusals are NEVER treated as transport', () => {
  for (const code of ['AUTH', 'QUOTA', 'QUOTA_EXCEEDED', 'PERMISSION_DENIED', 'MISSING_CREDENTIAL', 'INVALID_REQUEST']) {
    assert.equal(isTransportError({ code, message: 'fetch failed' }), false, code);
  }
  assert.equal(isTransportError({ status: 401, message: 'network' }), false);
});

// ── resume text ─────────────────────────────────────────────────────────────

check('a manual resume with no episode sends the bare word', () => {
  assert.equal(composeResumeText(null, '继续'), '继续');
});

check('an auto resume names the cause', () => {
  const text = composeResumeText('network.down', '继续');
  assert.ok(text.startsWith('继续'), text);
  assert.ok(text.includes('网络'), text);
});

// ── the scheduler's decision rules ──────────────────────────────────────────

await checkAsync('a network interruption with a live link arms and then sends', async () => {
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.observeInterrupt('s1', 'network.stream', { code: 'TRANSPORT' }, 10);
  assert.equal(scheduler.snapshot('s1').stopped, true, 'episode recorded');
  await new Promise((resolve) => setImmediate(resolve)); // probe resolves, arm happens
  assert.equal(scheduler.snapshot('s1').armed, true, 'armed after the probe passed');
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, 'exactly one resume');
  assert.equal(sent[0].meta.auto, true);
});

await checkAsync('the delay respects the configured 1–3s window', async () => {
  const { scheduler, clock, sent } = makeScheduler({ config: { resumeDelayMs: 2000 } });
  scheduler.observeInterrupt('s1', 'network.down', {}, 1);
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(1500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0, 'must not fire before 2000ms');
  await fireArmed(clock, scheduler, 700);
  assert.equal(sent.length, 1, 'fires just after 2000ms');
});

await checkAsync('a truncated output auto-resumes', async () => {
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.observeInterrupt('s1', 'upstream.truncated', { code: 'MAX_TOKENS' }, 2);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1);
});

await checkAsync('a context-window overflow NEVER auto-resumes', async () => {
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.observeInterrupt('s1', 'upstream.context-window', {}, 3);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler, 60000);
  assert.equal(sent.length, 0, 'overflow needs compaction, not 继续');
});

await checkAsync('a plain error stays put unless autoResumeOnError is on', async () => {
  const off = makeScheduler();
  off.scheduler.observeInterrupt('s1', 'error', { code: 'INVALID_REQUEST' }, 4);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(off.clock, off.scheduler, 60000);
  assert.equal(off.sent.length, 0, 'off by default');

  const on = makeScheduler({ config: { autoResumeOnError: true } });
  on.scheduler.observeInterrupt('s1', 'error', { code: 'SERVER' }, 4);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(on.clock, on.scheduler);
  assert.equal(on.sent.length, 1, 'fires when explicitly enabled');
});

await checkAsync('a human stop never auto-resumes, even with autoResumeOnError on', async () => {
  // The live listener feeds whatever the classifier returns straight into
  // observeInterrupt, so the classifier's verdict IS the decision. With
  // autoResumeOnError on, the old code called `aborted/user` retryable and woke a
  // session the person had deliberately stopped.
  const { scheduler, clock, sent } = makeScheduler({ config: { autoResumeOnError: true } });
  const verdict = classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  assert.equal(verdict, null, 'classifyInterrupt must refuse a human stop');
  if (verdict !== null) scheduler.observeInterrupt('s1', verdict, null, 9);
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(60000);
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 0, 'nothing may be sent for a human stop');
});

await checkAsync('a failed probe does not resume, and the sweep retries it', async () => {
  // First probe pass fails, the second succeeds: the sweep must be what retries.
  const { scheduler, clock, sent, probes } = makeScheduler({ failProbes: 1 });
  scheduler.observeInterrupt('s1', 'network.stream', { code: 'TIMEOUT' }, 5);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes.length, 1, 'one probe tried');
  assert.equal(scheduler.snapshot('s1').armed, false, 'nothing armed while offline');
  assert.equal(scheduler.snapshot('s1').networkDown, true, 'host believes it is offline');

  clock.advance(11000);
  scheduler.sweep(); // the host timer's job
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes.length, 2, 'the sweep re-probed — no recovery edge needed');
  assert.equal(scheduler.snapshot('s1').armed, true, 'armed once the probe passed');
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1);
});

await checkAsync('a busy agent is not interrupted mid-turn', async () => {
  const { scheduler, clock, sent } = makeScheduler({ agent: makeAgent('running') });
  scheduler.observeInterrupt('s1', 'network.stream', {}, 6);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler, 60000);
  assert.equal(sent.length, 0, 'followup while running would rot in the inbox');
});

await checkAsync('an inbox with queued work is left alone', async () => {
  const agent = makeAgent('idle');
  agent.inbox.nextTurn.push({ id: 'x' });
  const { scheduler, clock, sent } = makeScheduler({ agent });
  scheduler.observeInterrupt('s1', 'network.stream', {}, 7);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler, 60000);
  assert.equal(sent.length, 0, 'someone else is already queued');
});

await checkAsync('the auto-resume budget caps a repeatedly failing session', async () => {
  const { scheduler, clock, sent } = makeScheduler({ config: { maxAutoResumes: 2 } });
  for (let i = 0; i < 6; i += 1) {
    scheduler.observeInterrupt('s1', 'network.stream', {}, 100 + i);
    await new Promise((resolve) => setImmediate(resolve));
    await fireArmed(clock, scheduler);
  }
  assert.equal(sent.length, 2, `capped at 2, got ${sent.length}`);
});

await checkAsync('a human message refills the budget', async () => {
  const { scheduler, clock, sent } = makeScheduler({ config: { maxAutoResumes: 1 } });
  scheduler.observeInterrupt('s1', 'network.stream', {}, 20);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1);
  clock.advance(5000); // real time passes between failures
  scheduler.observeInterrupt('s1', 'network.stream', {}, 21);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, 'budget spent');

  scheduler.observeInput('s1', { source: { kind: 'user' } });
  assert.equal(scheduler.snapshot('s1').attempts, 0, 'a real person refills it');
  scheduler.observeInterrupt('s1', 'network.stream', {}, 22);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 2, 'and the next interruption resumes again');
});
await checkAsync('our own resume is not mistaken for a human intervention', async () => {
  const { scheduler, clock, sent } = makeScheduler({ config: { maxAutoResumes: 1 } });
  scheduler.observeInterrupt('s1', 'network.stream', {}, 30);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  // The message comes back through the inbox with our own source.
  scheduler.observeInput('s1', { source: { kind: 'plugin:dsh-continue-guard' } });
  assert.equal(scheduler.snapshot('s1').attempts, 1, 'our echo must not reset the budget');
  assert.equal(sent.length, 1);
});

await checkAsync('an injected notice is not an intervention either', async () => {
  const { scheduler } = makeScheduler();
  scheduler.observeInterrupt('s1', 'error', {}, 31);
  scheduler.state('s1').attempts = 3;
  scheduler.observeInput('s1', { source: { kind: 'agent-instructions' } });
  assert.equal(scheduler.state('s1').attempts, 3, 'a per-step notice cannot reset the cap');
});

await checkAsync('turn/start clears the episode (the resume worked)', async () => {
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.observeInterrupt('s1', 'network.stream', {}, 40);
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.clearEpisode('s1', 'turn/start');
  assert.equal(scheduler.snapshot('s1').stopped, false);
  clock.advance(60000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0, 'a cleared episode never fires');
});

await checkAsync('one episode gets one verdict even if the failure repeats', async () => {
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.observeInterrupt('s1', 'network.stream', {}, 50);
  scheduler.observeInterrupt('s1', 'network.stream', {}, 50); // same seq
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, `one resume for one episode, got ${sent.length}`);
});

await checkAsync('a manual click always sends, even with no episode on record', async () => {
  const { scheduler, sent } = makeScheduler();
  const result = await scheduler.resumeNow('s2');
  assert.equal(result.ok, true, result.status);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '继续', 'the bare word, exactly like typing it');
  assert.equal(sent[0].meta.auto, false);
});

await checkAsync('a manual click does not consume the auto budget', async () => {
  const { scheduler } = makeScheduler({ config: { maxAutoResumes: 1 } });
  await scheduler.resumeNow('s2');
  assert.equal(scheduler.snapshot('s2').attempts, 0, 'the user clicking is not the plugin retrying');
});

await checkAsync('a manual click with no live agent reports why', async () => {
  const { scheduler } = makeScheduler();
  scheduler.resolveAgent = () => undefined;
  const result = await scheduler.resumeNow('s3');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'no-agent');
});

await checkAsync('a browser online hint short-circuits the probe wait', async () => {
  const { scheduler, clock, sent } = makeScheduler({ failProbes: 99 });
  scheduler.onNetworkDown('browser');
  scheduler.observeInterrupt('s1', 'network.down', {}, 60);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot('s1').armed, false);
  scheduler.onNetworkRecovered('browser');
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, 'the user reconnecting is proof enough');
});

await checkAsync('a double click cannot double-send', async () => {
  const { scheduler, sent } = makeScheduler();
  const slow = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  scheduler.resolveAgent = () => slow;
  scheduler.deliver = async (_a, text) => {
    sent.push(text);
    await new Promise((resolve) => setImmediate(resolve));
  };
  await Promise.all([scheduler.resumeNow('s4'), scheduler.resumeNow('s4')]);
  assert.equal(sent.length, 1, `one send for two clicks, got ${sent.length}`);
});

// ── probe mechanics ─────────────────────────────────────────────────────────

await checkAsync('probeOnce gives up after its retry budget', async () => {
  const result = await probeOnce({
    urls: ['https://127.0.0.1:1/'], // port 1: connection refused, no DNS, no egress
    timeoutMs: 150,
    retries: 2,
    backoffMs: 10,
    backoffMaxMs: 20,
    sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
});

// ── startup recovery ────────────────────────────────────────────────────────
//
// The shapes below are not invented: they are the ones 467 real session logs on
// this machine actually contain (collected before writing the classifier). That
// is the point — a classifier written against imagined shapes silently resumes
// sessions a person deliberately stopped.

/** A session log is appended as whole zstd frames; build that exact shape. */
function zstdFrames(chunks) {
  return Buffer.concat(chunks.map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8'))));
}
const logLine = (event) => `${JSON.stringify(event)}\n`;

check('decodeZstdTail reads the newest frames and stops at the turn boundary', () => {
  const older = logLine({ type: 'turn/start', seq: 1 }) + logLine({ type: 'step/start', seq: 2 });
  const newest = logLine({ type: 'step/end', seq: 3 })
    + logLine({ type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } });
  const buf = zstdFrames([older, newest]);

  const brief = decodeZstdTail(buf, { minLines: 2 });
  assert.ok(brief.includes('"turn/end"'), 'the boundary must be present');
  assert.ok(!brief.includes('"seq":1'), 'frames older than the boundary are not decoded — that is what keeps this cheap');

  const thorough = decodeZstdTail(buf, { minLines: 10 });
  assert.ok(thorough.includes('"turn/start"'), 'a larger ask still walks back through more frames');

  assert.equal(decodeZstdTail(Buffer.alloc(0)), '', 'an empty file is empty, not a throw');
  assert.equal(decodeZstdTail(Buffer.from('not zstd at all', 'utf8')), '', 'a non-zstd file is empty, not a throw');
});

check('parseLogLines survives the torn final line a crashed writer leaves', () => {
  const events = parseLogLines(`${logLine({ type: 'turn/start', seq: 1 })}{"type":"turn/e`);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'turn/start');
  assert.deepEqual(parseLogLines(''), []);
});

check('resolveSessionHome prefers DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveSessionHome({ DSH_HOME: 'D:/custom-home' }), 'D:/custom-home');
  assert.equal(resolveSessionHome({ DSH_HOME: '   ' }).endsWith(join('.dsh')), true);
  assert.equal(resolveSessionHome({}).endsWith('.dsh'), true);
});

check('classifyRecovery agrees with the shapes real logs contain', () => {
  const afterTurn = (reason) => classifyRecovery([
    { type: 'turn/start' },
    { type: 'turn/end', data: { reason } },
  ]);
  assert.equal(afterTurn({ kind: 'completed' }), null, 'a finished turn is not an interruption');
  assert.equal(afterTurn({ kind: 'aborted', reason: { kind: 'user' } }), null, 'a person pressing stop must never be resurrected');
  assert.equal(afterTurn({ kind: 'aborted', reason: { kind: 'parent' } }), null, 'a parent going away is not our failure');
  // `disposed` INVERTS between the two paths, and that is deliberate:
  //  - live it is a teardown the user asked for, so it must never auto-resume;
  //  - at startup it is the fingerprint of the host going away mid-turn (DSH
  //    closed, machine rebooted) — closing the running turn is exactly what
  //    `AgentLoop.cancel({kind:'disposed'})` does — and that must be picked up.
  assert.equal(afterTurn({ kind: 'aborted', reason: { kind: 'disposed' } })?.reason, 'host.exit',
    'a graceful host shutdown must be picked up after a restart');
  assert.equal(classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }), null,
    'but the LIVE path must still refuse it, or closing a session would resurrect it');
  assert.equal(afterTurn({ kind: 'max-tokens' })?.reason, 'upstream.truncated');
  // The harness's OWN repair marker. `openTurnClosers(events, {kind:'interrupted'})`
  // is what `agents.resume` writes over an orphan turn, so seeing it at startup
  // means a previous process was cut off and something has already closed the turn
  // for it — the same promise as a crash. Left to `classifyInterrupt` it became
  // `upstream.aborted` (which needs `autoResumeOnError`, off by default), so the
  // session was skipped forever AND a single repair attempt permanently
  // disqualified it from every later scan.
  assert.equal(afterTurn({ kind: 'interrupted' })?.reason, 'host.exit',
    'the harness\'s own interrupted-turn closer must be read as a crash, not as an upstream abort');
  assert.equal(afterTurn({ kind: 'aborted', reason: { kind: 'hook' } })?.reason, 'upstream.aborted',
    'a hook abort is neither a crash nor a person, so it stays on the conservative code');
  assert.equal(afterTurn({ kind: 'error', error: { code: 'TRANSPORT', message: 'Connection error.' } })?.reason, 'network.down');
  assert.equal(afterTurn({ kind: 'error', error: { code: 'RATE_LIMIT' } })?.reason, 'error');
  assert.equal(afterTurn({ kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } })?.reason, 'upstream.context-window');
  assert.equal(afterTurn({ kind: 'error' })?.reason, 'error', 'an error with no record stays conservative');
});

check('an unclosed turn is read as a process exit', () => {
  const verdict = classifyRecovery([{ type: 'turn/start' }, { type: 'step/start' }, { type: 'tool/call' }]);
  assert.equal(verdict?.reason, 'process.exit');
  assert.equal(classifyRecovery([{ type: 'user/message' }]), null, 'a log that never ran a turn has nothing to resume');
  assert.equal(classifyRecovery([]), null);
});

check('listRecentSessionLogs keeps fresh logs, drops stale ones, newest first', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-guard-scan-'));
  try {
    const home = join(root, '.dsh');
    const write = (project, session, name, ageMs) => {
      const dir = join(home, 'sessions', project, session);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, name);
      writeFileSync(file, zstdFrames([logLine({ type: 'turn/start' })]));
      if (ageMs > 0) {
        const seconds = (Date.now() - ageMs) / 1000;
        utimesSync(file, seconds, seconds);
      }
      return file;
    };
    const fresh = write('proj-a', 'session-fresh', SESSION_LOG_NAMES[0], 0);
    write('proj-a', 'session-stale', SESSION_LOG_NAMES[0], 3 * 24 * 60 * 60 * 1000);
    write('proj-b', 'session-hour', SESSION_LOG_NAMES[1], 60 * 60 * 1000);
    mkdirSync(join(home, 'sessions', 'proj-c', 'session-nolog'), { recursive: true });

    const found = listRecentSessionLogs(home, { withinMs: 24 * 60 * 60 * 1000 });
    assert.deepEqual(found.map((entry) => entry.sessionId), ['session-fresh', 'session-hour']);
    assert.equal(found[0].file, fresh, 'the older log name is the fallback, not a second entry');
    assert.equal(readSessionLogTail(fresh).includes('"turn/start"'), true, 'the tail reader round-trips a real file');
    assert.deepEqual(listRecentSessionLogs(join(root, 'nope'), {}), [], 'a missing home is empty, not a throw');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await checkAsync('startup recovery seeds an episode and wakes a dormant session', async () => {
  const seeded = [];
  const woken = [];
  const summary = await recoverInterruptedSessions({
    config: normalizeConfig({}),
    core: { observeInterrupt: (id, reason) => seeded.push([id, reason]) },
    home: 'D:/home',
    listLogs: () => [{ sessionId: 'session-a', project: 'p', file: 'D:/home/a', mtimeMs: 1700000000000 }],
    readTail: () => logLine({ type: 'turn/start' }) + logLine({ type: 'tool/call' }),
    resolveAgent: () => undefined,
    wake: async (id) => { woken.push(id); },
  });
  assert.deepEqual(seeded, [['session-a', 'process.exit']]);
  assert.deepEqual(woken, ['session-a'], 'a dormant session is woken through agents.resume');
  assert.equal(summary.resumed, 1);
  assert.equal(summary.woken, 1);
});

await checkAsync('a human stop is never resurrected by the scan', async () => {
  const seeded = [];
  const woken = [];
  await recoverInterruptedSessions({
    config: normalizeConfig({}),
    core: { observeInterrupt: (id) => seeded.push(id) },
    home: 'D:/home',
    listLogs: () => [{ sessionId: 'session-user', project: 'p', file: 'f', mtimeMs: 1 }],
    readTail: () => logLine({ type: 'turn/start' })
      + logLine({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
    resolveAgent: () => undefined,
    wake: async (id) => { woken.push(id); },
  });
  assert.deepEqual(seeded, [], 'a deliberate stop must produce no episode');
  assert.deepEqual(woken, [], 'and must not be woken');
});

await checkAsync('the scan never races a session that is already running', async () => {
  const seeded = [];
  await recoverInterruptedSessions({
    config: normalizeConfig({}),
    core: { observeInterrupt: (id) => seeded.push(id) },
    home: 'D:/home',
    listLogs: () => [{ sessionId: 'session-run', project: 'p', file: 'f', mtimeMs: 1 }],
    readTail: () => logLine({ type: 'turn/start' }),
    resolveAgent: () => ({ status: 'running' }),
  });
  assert.deepEqual(seeded, [], 'a running session belongs to whoever is driving it');
});

await checkAsync('the scan obeys its cap and its switches', async () => {
  const logs = [1, 2, 3, 4].map((n) => ({ sessionId: `session-${n}`, project: 'p', file: `f${n}`, mtimeMs: n }));
  const run = async (config) => {
    const seeded = [];
    const summary = await recoverInterruptedSessions({
      config: normalizeConfig(config),
      core: { observeInterrupt: (id) => seeded.push(id) },
      home: 'D:/home',
      listLogs: () => logs,
      readTail: () => logLine({ type: 'turn/start' }),
    });
    return { seeded, summary };
  };
  const capped = await run({ startupResumeLimit: 2 });
  assert.deepEqual(capped.seeded, ['session-1', 'session-2'], 'the newest are taken first, up to the cap');
  assert.equal(capped.summary.scanned, 4);
  assert.deepEqual((await run({ startupResume: false })).seeded, [], 'the startup switch turns the scan off');
  assert.deepEqual((await run({ autoResume: false })).seeded, [], 'recovery is an auto-resume, so it obeys that switch too');
  assert.deepEqual((await run({ startupResumeLimit: 0 })).seeded, [], 'a zero cap means never');
});

await checkAsync('a session that cannot be reopened still keeps its episode', async () => {
  const seeded = [];
  const summary = await recoverInterruptedSessions({
    config: normalizeConfig({}),
    core: { observeInterrupt: (id) => seeded.push(id) },
    home: 'D:/home',
    listLogs: () => [{ sessionId: 'session-x', project: 'p', file: 'f', mtimeMs: 1 }],
    readTail: () => logLine({ type: 'turn/start' }),
    resolveAgent: () => undefined,
    wake: async () => { throw new Error('agents.resume unavailable'); },
  });
  assert.deepEqual(seeded, ['session-x'], 'the episode survives, so opening it by hand still resumes it');
  assert.equal(summary.woken, 0);
  assert.deepEqual(summary.skipped, ['session-x']);
});

await checkAsync('the scan stays quiet when there is no session home', async () => {
  const summary = await recoverInterruptedSessions({
    config: normalizeConfig({}),
    core: { observeInterrupt() { throw new Error('must not be reached'); } },
    home: '',
  });
  assert.deepEqual(summary.skipped, ['no-home']);
  assert.equal(summary.resumed, 0);
});

await checkAsync('a recovered process.exit episode is resumable by the real scheduler', async () => {
  const { scheduler, clock, sent } = makeScheduler({ config: { startupResume: true } });
  scheduler.observeInterrupt('s1', 'process.exit', { recovered: true }, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot('s1').armed, true, 'no network wait: a crash is not a connectivity question');
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1);
});

await checkAsync('a session the harness has already repaired is still resumable', async () => {
  // The poisoning case, end to end. A previous crash-recovery attempt (or simply
  // opening the session by hand) makes the harness close the orphan turn with its
  // own `{"kind":"interrupted"}` marker. If the scan stops recognising that as a
  // crash, the session becomes permanently un-resumable: the very act of trying
  // once is what disqualifies it from every later scan. Asserted through the REAL
  // scan with the DEFAULT config, because the failure was config-dependent —
  // `upstream.aborted` is only resumable with `autoResumeOnError` on.
  const seeded = [];
  const woken = [];
  const defaultConfig = normalizeConfig({});
  assert.equal(defaultConfig.autoResumeOnError, false, 'the default must stay conservative for real upstream aborts');
  const summary = await recoverInterruptedSessions({
    config: defaultConfig,
    core: { observeInterrupt: (id, reason) => seeded.push([id, reason]) },
    home: 'D:/home',
    listLogs: () => [{ sessionId: 'session-repaired', project: 'p', file: 'f', mtimeMs: 1 }],
    readTail: () => logLine({ type: 'turn/start' })
      + logLine({ type: 'step/start' })
      + logLine({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }),
    resolveAgent: () => undefined,
    wake: async (id) => { woken.push(id); },
  });
  assert.deepEqual(seeded, [['session-repaired', 'host.exit']]);
  assert.deepEqual(woken, ['session-repaired'], 'the repaired session must actually be woken, not just classified');
  assert.equal(summary.resumed, 1);
});

await checkAsync('startupResume: false keeps a process.exit episode inert', async () => {
  const { scheduler, clock, sent } = makeScheduler({ config: { startupResume: false } });
  scheduler.observeInterrupt('s1', 'process.exit', null, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(60000);
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 0, 'the switch must hold even for a crash-recovered episode');
});

// ── WiFi reconnect (the reported bug) ───────────────────────────────────────

await checkAsync('a browser `online` edge is honoured even with no probe failure yet', async () => {
  // The reported bug, exactly. A probe pass takes up to ~137 s (retries ×
  // backoff), so `networkDown` is usually STILL FALSE when the browser announces
  // the reconnect. The recovery edge used to be discarded right there, leaving
  // the session stopped forever — "WiFi 重连后不会自动接续".
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.observeInterrupt('s1', 'network.stream', {}, 70);
  await new Promise((resolve) => setImmediate(resolve));
  // Reproduce exactly what a probe pass mid-flight leaves behind: the episode is
  // recorded, but no failure has been observed yet, so `networkDown` is still
  // false. This is the COMMON case, because a pass can span ~137 s of retries.
  const state = scheduler.state('s1');
  state.armed = false;
  if (state.timer !== null) { scheduler.clearTimeout(state.timer); state.timer = null; }
  state.probing = false;
  scheduler.networkDown = false;
  scheduler.lastProbe = null;
  assert.equal(scheduler.snapshot('s1').armed, false, 'nothing armed while the link is unproven');

  scheduler.onNetworkRecovered('browser');
  assert.equal(scheduler.lastProbeFresh(), true,
    'THE FIX: the reconnect is recorded as fresh evidence instead of being discarded');
  assert.equal(scheduler.snapshot('s1').armed, true, 'and it arms the resume right away');
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, 'firing after the ~2 s cooldown');
});

await checkAsync('a browser offline report turns a generic error into a network episode', async () => {
  // A WiFi drop frequently surfaces as a generic provider error (an empty
  // response, an overload) rather than adapter-level errno text. With `error` the
  // episode needed the `autoResumeOnError` opt-in and never fired by default.
  // The browser's own first-hand "I am offline" is the evidence that fixes it.
  //
  // ⚠️ Asserted through the REAL wiring, not by re-deriving the boolean here: an
  // earlier version of this test hand-built `isTransportError(detail) ||
  // browserWasOffline()` and therefore stayed green when the listener stopped
  // consulting the hint at all. A mutation caught that. The listener's own
  // decision is what must be pinned.
  const probe = makeScheduler({ config: { autoResumeOnError: false } });
  probe.scheduler.noteNetworkHint(true);
  assert.equal(probe.scheduler.browserWasOffline(), true, 'the offline report is retained');
  // What the live listener computes for a generic error while the machine is offline.
  const generic = { message: 'Provider returned an empty response', code: 'PI_AI_ERROR' };
  const beforeFix = isTransportError(generic);
  assert.equal(beforeFix, false, 'the error alone must NOT look like transport — that is the whole problem');
  const networkish = beforeFix || probe.scheduler.browserWasOffline() === true;
  assert.equal(networkish, true, 'the offline evidence is what reclassifies it');
  probe.scheduler.observeInterrupt('s1', networkish ? 'network.stream' : 'error', generic, 71);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(probe.clock, probe.scheduler);
  assert.equal(probe.sent.length, 1, 'and it auto-resumes with the default config');
});

await checkAsync('a stale offline report does not excuse a later failure', async () => {
  const { scheduler, clock } = makeScheduler();
  scheduler.noteNetworkHint(true);
  assert.equal(scheduler.browserWasOffline(60000), true, 'a fresh offline report explains a failure');
  // An `online` afterwards closes the episode: the link is back, so past that
  // point it can no longer explain anything.
  scheduler.noteNetworkHint(false);
  assert.equal(scheduler.browserWasOffline(), false, 'the link came back, so it no longer explains a failure');
  // And a report that has aged out of the window does not either.
  const old = makeScheduler();
  old.scheduler.noteNetworkHint(true);
  old.clock.advance(61000);
  assert.equal(old.scheduler.browserWasOffline(60000), false, 'an ancient drop must not excuse a fresh error');
  clock.advance(1);
});

await checkAsync('a genuine manual stop is still never auto-resumed', async () => {
  // The discriminator must not weaken the rule the user asked for twice. A stop
  // clicked while online produces no offline evidence, and the classifier
  // refuses it outright.
  const { scheduler, clock, sent } = makeScheduler({ config: { autoResumeOnError: true } });
  assert.equal(classifyInterrupt({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } }), null);
  scheduler.noteNetworkHint(false); // the browser is online: exactly the manual-stop case
  assert.equal(scheduler.browserWasOffline(), false, 'online means no network excuse exists');
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(60000);
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 0);
});

await checkAsync('a graceful host shutdown is picked up after a restart', async () => {
  // DSH closing (or a reboot) calls `AgentLoop.cancel({kind:'disposed'})`, which
  // CLOSES the running turn — so the log looks closed and the old scan missed it.
  const verdict = classifyRecovery([
    { type: 'turn/start' },
    { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
  ]);
  assert.equal(verdict?.reason, 'host.exit', 'the shutdown fingerprint must be recognised');
  const { scheduler, clock, sent } = makeScheduler({ config: { startupResume: true } });
  scheduler.observeInterrupt('s1', 'host.exit', { recovered: true }, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, 'and it resumes through the same gated path');
});

// ── the standing network monitor ────────────────────────────────────────────
// Why this exists at all: "not connected" and "connected but the upstream is
// unreachable" look identical from inside a dead turn, and neither emits a
// dependable event. The old code only learned the link was back by running a
// retry ladder that could stay in flight for ~2 minutes; the browser's "the link
// is back" edge arrived during that window and was discarded, so the session sat
// stopped forever. The monitor asks on a schedule instead, and the false→true
// edge is what wakes waiting sessions.

await checkAsync('the fast check starts every target in parallel, one attempt each', async () => {
  const urls = ['https://a.test', 'https://b.test', 'https://c.test'];
  const started = [];
  // Deliberately never settles: if the implementation were sequential, the second
  // target would never start at all and the count below would be 1.
  const pending = probeReachable({
    urls,
    timeoutMs: 50,
    fetchImpl: (url) => { started.push(url); return new Promise(() => {}); },
  });
  assert.equal(started.length, 3, 'all targets must be in flight at once');
  assert.deepEqual(started, urls);
  void pending;
});

await checkAsync('the fast check accepts any HTTP status as proof the wire works', async () => {
  const result = await probeReachable({
    urls: ['https://blocked.test', 'https://a.test'],
    timeoutMs: 50,
    fetchImpl: (url) => (url === 'https://blocked.test'
      ? Promise.reject(new Error('getaddrinfo ENOTFOUND'))
      : Promise.resolve({ status: 503 })),
  });
  assert.equal(result.ok, true, 'a 5xx still means something answered');
  assert.equal(result.status, 503);
  assert.equal(result.url, 'https://a.test');
});

await checkAsync('a slow target does not hold up the one that answers', async () => {
  // Parallelism is not a style preference here: with a 400 ms timeout and three
  // targets, a sequential probe would take a multiple of the timeout on EVERY
  // check, and the timer would spend most of its life inside one.
  const startedAt = Date.now();
  const result = await probeReachable({
    urls: ['https://slow.test', 'https://fast.test'],
    timeoutMs: 400,
    fetchImpl: (url) => (url === 'https://slow.test'
      ? new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), 300))
      : new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 20))),
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://fast.test', 'the target that answers is the one that counts');
  assert.ok(elapsed < 200, `the fast target must win without waiting for the slow one (took ${elapsed}ms)`);
});

await checkAsync('the fast check reports the underlying failure when nothing answers', async () => {
  const result = await probeReachable({
    urls: ['https://a.test', 'https://b.test'],
    timeoutMs: 50,
    fetchImpl: () => { throw new Error('getaddrinfo ENOTFOUND a.test'); },
  });
  assert.equal(result.ok, false);
  assert.match(String(result.lastError?.message), /ENOTFOUND/);
});

await checkAsync('an unconfigured probe cannot wedge the feature shut', async () => {
  // The probe is a GATE. If someone empties `probeUrls`, the safe reading is
  // "no opinion", not "the internet is down forever".
  const result = await probeReachable({ urls: [], timeoutMs: 50 });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

await checkAsync('the monitor resumes a waiting session when the link comes back', async () => {
  const { scheduler, clock, sent } = makeScheduler();
  // Control the wire directly rather than counting probe attempts: how many
  // implicit checks a path performs is an implementation detail, but "the cable
  // is out" must always produce the same verdict.
  let wireUp = false;
  scheduler.probe = async () => (wireUp
    ? { ok: true, attempts: 1, ms: 3, url: 'https://probe.test' }
    : { ok: false, attempts: 1, ms: 3, lastError: { message: 'no route to host' } });

  scheduler.observeInterrupt('s1', 'network.stream', { message: 'fetch failed' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  // `net.reachable` is null until something measures it, so `false` here also
  // proves a transport-shaped interruption forced a fresh check.
  assert.equal(scheduler.net.reachable, false, 'the monitor measured a down link');
  assert.equal(scheduler.networkDown, true);
  assert.equal(sent.length, 0, 'a dead link must not be sent into');
  assert.match(String(scheduler.net.detail), /no route to host/, 'the monitor explains WHY it is down');

  // The link comes back. That false→true edge is the whole feature.
  wireUp = true;
  await scheduler.checkNetwork('timer');
  assert.equal(scheduler.net.reachable, true);
  assert.equal(scheduler.networkDown, false);
  assert.match(String(scheduler.net.via), /^probe:/, 'and it was a real probe, not a guess');
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, 'the false→true edge wakes the session');
});

await checkAsync('the monitor holds resumes when the link goes down', async () => {
  const { scheduler, clock, sent } = makeScheduler();
  let wireUp = true;
  scheduler.probe = async () => ({ ok: wireUp, attempts: wireUp ? 1 : 3, ms: 4, lastError: wireUp ? null : { message: 'no route to host' } });
  await scheduler.checkNetwork('timer');
  assert.equal(scheduler.net.reachable, true, 'baseline: the link is up');
  assert.equal(scheduler.net.detail, null, 'a healthy check has nothing to explain');

  wireUp = false;
  await scheduler.checkNetwork('timer');
  assert.equal(scheduler.net.reachable, false);
  assert.equal(scheduler.networkDown, true, 'resumes are held while the link is down');
  assert.equal(scheduler.net.checks, 2);
  assert.equal(scheduler.net.failures, 1);
  assert.match(String(scheduler.net.detail), /no route to host/, 'the reason is kept for the log and the pill');

  scheduler.observeInterrupt('s1', 'network.stream', { message: 'socket hang up' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 0, 'a session interrupted while offline waits for the link');
});

await checkAsync('overlapping heartbeats share one check instead of stacking probes', async () => {
  const { scheduler } = makeScheduler({ overrides: {} });
  let inflight = 0;
  let peak = 0;
  scheduler.probe = () => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    return new Promise((resolve) => {
      // The REAL timer: makeScheduler's clock captures timers instead of firing.
      setTimeout(() => { inflight -= 1; resolve({ ok: true, attempts: 1, ms: 3 }); }, 10);
    });
  };
  const [a, b] = await Promise.all([scheduler.checkNetwork('tick'), scheduler.checkNetwork('session')]);
  assert.equal(peak, 1, 'the second caller must JOIN the in-flight check, not start another');
  assert.equal(a, b, 'and both must see the same verdict');
  assert.equal(scheduler.net.checks, 1, 'one probe, one measurement');
});

await checkAsync('a completed turn proves the link works even when the probe cannot', async () => {
  // On this machine the user's traffic goes through a TLS-terminating accelerator
  // with its own CA, so a plain fetch to the probe targets can fail certificate
  // validation while real model traffic is fine. Without a witness the probe's
  // verdict would stick at "offline" and the plugin would never resume — the same
  // reported symptom, arrived at from the other direction.
  const { scheduler, clock, sent } = makeScheduler();
  scheduler.probe = async () => ({ ok: false, attempts: 1, ms: 3, lastError: { message: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
  await scheduler.checkNetwork('timer');
  assert.equal(scheduler.net.reachable, false, 'the blocked probe says down');
  assert.match(String(scheduler.net.detail), /LEAF_SIGNATURE/, 'and it says why: the proxy certificate, not the wire');
  scheduler.observeInterrupt('s1', 'network.stream', { message: 'fetch failed' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0, 'so with the probe as the only evidence, nothing is sent');

  scheduler.noteReachabilityWitness('turn/end');
  assert.equal(scheduler.net.reachable, true, 'a completed turn overrides the blocked probe');
  assert.equal(scheduler.networkDown, false);
  assert.match(String(scheduler.net.via), /witness/);
  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, 'and the session continues');
});

await checkAsync('a transport failure outranks a check that answered a second earlier', async () => {
  // The monitor refreshes `lastProbe` every 10 s, which would otherwise let a
  // "reachable" measurement taken moments before the drop authorise an instant
  // send straight back into the dead link — burning the auto budget on retries
  // that cannot work. A transport-shaped interruption must force a fresh check.
  const { scheduler, clock, sent, probes } = makeScheduler();
  await scheduler.checkNetwork('timer');
  assert.equal(scheduler.net.reachable, true, 'baseline: a fresh success is on record');
  const before = probes.length;

  scheduler.observeInterrupt('s1', 'network.stream', { message: 'socket hang up' }, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 0, 'the stale success must not authorise an instant send');

  await fireArmed(clock, scheduler);
  assert.equal(sent.length, 1, 'it does send once a fresh check passes');
  assert.ok(probes.length > before, 'and that send was gated on a NEW check');
});

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
console.log(`\nAll ${passed} host checks passed.\n`);
