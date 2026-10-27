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
import {
  LoopResumeScheduler, classifyInterrupt, composeResumeText, isTransportError,
  normalizeConfig, probeOnce, stopReasonOf,
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

check('a length stop is upstream.truncated', () => {
  const event = {
    type: 'assistant/message',
    data: { stream: [{ chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }] },
  };
  assert.equal(classifyInterrupt(event), 'upstream.truncated');
  assert.equal(stopReasonOf(event), 'max-tokens');
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

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
console.log(`\nAll ${passed} host checks passed.\n`);
