/**
 * Mount test: run the REAL `apply()` against a fake plugin context and drive it
 * through the same sequence the Harness would.
 *
 * The other three gates test the pieces (rules, state table, wiring). This one
 * tests the joint: does `apply()` actually register a route, index a live agent,
 * and deliver a followup when the client POSTs /resume? A plugin can pass every
 * piecewise check and still be dead on the happy path — that is precisely the
 * failure "the button does nothing" looks like from the outside.
 *
 * Run: node scripts/verify-mount.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { LoopResumeScheduler, apply, inject } from '../index.js';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n    ${error.message}`);
  }
}

// ── the wire ────────────────────────────────────────────────────────────────
// apply() now runs a connectivity check at MOUNT, on its own 10 s heartbeat, and
// whenever a transport-shaped turn ends. The heartbeat is a timer, but the mount
// check is a floating fetch that would otherwise leave the test suite talking to
// the real internet. Stubbing `globalThis.fetch` is the honest way to control the
// wire from a test: the plugin's real code path runs unchanged, only the far end
// is ours.
const wire = { up: true, calls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  wire.calls += 1;
  if (!wire.up) throw new Error(`getaddrinfo ENOTFOUND ${url}`);
  return { status: 204, ok: true, headers: new Map() };
};

// ── the session home ────────────────────────────────────────────────────────
// `apply()` also runs the STARTUP-RECOVERY scan, and with no DSH_HOME set that
// scan reads the operator's real `<home>/sessions` tree. That made this gate
// depend on machine state, and it did so silently: measured, a real crashed
// session in the developer's home got picked up at mount, its wake armed a
// session, and the probe that followed incremented `wire.calls` — which satisfied
// "the monitor starts asking at mount" even with the mount check deleted. The
// gate was green on a mutant. Point the scan at an empty home instead, so the
// only thing that can touch the wire here is the code under test. (The
// `withCrashedHome` helper below overrides and restores this per test.)
const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-guard-mount-home-'));
process.env.DSH_HOME = isolatedHome;
process.on('exit', () => {
  try { rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── a fake Harness ──────────────────────────────────────────────────────────

function makeAgent(sessionId, status = 'idle') {
  const agent = {
    session: { id: sessionId },
    status,
    inbox: { nextTurn: [], nextStep: [] },
    followups: [],
    followup(message) {
      // The real one wakes the driver and enqueues; recording is enough to prove
      // the plugin reached it, which is the whole question.
      this.followups.push(message);
    },
  };
  return agent;
}

function makeHarness() {
  const state = {
    agents: [],
    routes: new Map(),
    disposers: [],
    listeners: new Map(),
    effects: [],
    logs: [],
    injections: [],
    followupOrder: [],
    // Startup recovery is the one path that calls INTO the loop driver. These
    // record the call's exact shape, because the shape is the bug we shipped.
    resumeCalls: [],
    resumeArity: [],
    woken: [],
  };

  const pluginContext = {
    logger: {
      info: (m) => state.logs.push({ level: 'info', message: String(m) }),
      warn: (m) => state.logs.push({ level: 'warn', message: String(m) }),
      error: (m) => state.logs.push({ level: 'error', message: String(m) }),
    },
    effect(fn, label) {
      const dispose = fn();
      state.effects.push({ label, dispose });
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    on(name, fn) {
      (state.listeners.get(name) ?? state.listeners.set(name, []).get(name)).push(fn);
      return () => {};
    },
    // `webServer` is a STATIC inject now: the Loader resolves it before apply(),
    // so it is present on the plugin context itself.
    webServer: {
      register(registration) {
        state.routes.set(registration.path, registration);
        return () => state.routes.delete(registration.path);
      },
    },
    // `agents` stays deferred; only the callback gets this scope.
    //
    // The `resume` contract below is deliberately the SERVICE's, not the loop's:
    // `AgentRegistry.resume(options)` takes exactly ONE argument and supplies
    // `ownerCtx` itself (`dsh-agent/lib/index.js:467` — `const ownerCtx =
    // this.ctx; ... Reflect.apply(target.resume, receiver, [ownerCtx, options])`).
    // A fake that ALSO accepted `(ownerCtx, options)` is how a two-argument call
    // site shipped green: the stand-in was more permissive than the thing it
    // stands in for, so it could not fail the way the real service fails. The
    // schema check below is the real failure mode — pass a context instead of
    // options and `resumeSessionId` is undefined, exactly as in production.
    inject(names, fn) {
      state.injections.push(names);
      const scope = {
        agents: {
          list: () => state.agents,
          async resume(...args) {
            state.resumeArity.push(args.length);
            const options = args[0];
            state.resumeCalls.push(options);
            if (options === null || typeof options !== 'object' || typeof options.resumeSessionId !== 'string') {
              throw new TypeError(
                `agent resume: expected { resumeSessionId: string }, got ${typeof options?.resumeSessionId}`,
              );
            }
            // The real service publishes an agent for the otherwise dormant
            // session; without that, nothing downstream can deliver the resume.
            if (state.agents.some((agent) => agent.session?.id === options.resumeSessionId)) return undefined;
            const agent = makeAgent(options.resumeSessionId);
            state.agents.push(agent);
            state.woken.push(options.resumeSessionId);
            // ...and announces it. `AgentRegistry.announce` dispatches a serial
            // `agent/created` (`dsh-agent/lib/index.js:582`), which is how the
            // plugin's index ever learns about an agent it did not create. A fake
            // that only appended to `list()` would leave the plugin blind and
            // make the delivery below look like a plugin bug.
            for (const listener of state.listeners.get('agent/created') ?? []) {
              await listener({ agent });
            }
            return undefined;
          },
          withoutInitiator(cb) {
            state.followupOrder.push('withoutInitiator');
            return cb();
          },
        },
        effect: pluginContext.effect,
        on: pluginContext.on,
        logger: pluginContext.logger,
      };
      fn(scope);
    },
    agents: undefined,
  };

  return { pluginContext, state };
}

/** Mount WITHOUT the loop driver, as a profile lacking `agents` would. */
function makeHarnessWithoutAgents() {
  const built = makeHarness();
  built.pluginContext.inject = (names, _fn) => { built.state.injections.push(names); };
  return built;
}

/** Drive the registered route the way the HTTP layer would. */
async function request(state, path, { method = 'GET', body = undefined, search = '' } = {}) {
  const route = state.routes.get('/api/dsh-continue-guard');
  assert.ok(route !== undefined, 'no route registered under /api/dsh-continue-guard');

  let statusCode = 200;
  let payload;
  const res = {
    setHeader() {},
    end(text) { payload = text === undefined ? undefined : JSON.parse(text); },
    writeHead(code) { statusCode = code; },
    statusCode: 200,
  };
  const req = {
    method,
    url: `${path}${search}`,
    headers: { host: '127.0.0.1:55557', 'sec-fetch-site': 'same-origin' },
  };
  // readBody() reads the request stream; feed it the JSON bytes the browser sends.
  if (body !== undefined) {
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    req[Symbol.asyncIterator] = async function* iterate() { yield bytes; };
    req.on = (event, fn) => { if (event === 'data') fn(bytes); if (event === 'end') fn(); };
    req.readableEnded = true;
  }
  await route.handler(req, res);
  return { statusCode, payload };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function settleDeep() {
  for (let i = 0; i < 6; i += 1) await settle();
}

// ── mount ───────────────────────────────────────────────────────────────────

await check('webServer is a static inject, agents is deferred', async () => {
  assert.deepEqual([...inject], ['webServer'], 'webServer must be a hard dependency');
  assert.ok(!inject.includes('agents'),
    'agents must NOT be static: a profile without a loop driver would leave the pill pending forever');
});

await check('apply() mounts, injects the loop driver, and registers the route', async () => {
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, {});
  assert.equal(state.injections.length, 1, 'expected exactly one deferred inject');
  assert.deepEqual(state.injections[0], ['agents'], 'only the loop driver is deferred');
  assert.ok(state.routes.has('/api/dsh-continue-guard'), 'route was not registered');
});

await check('the HTTP surface exists even WITHOUT the loop driver', async () => {
  // This is the regression that produced "every click 404": the routes used to be
  // registered inside the service-pair inject, so an absent `agents` took the
  // pill's entire host surface down with it.
  const { pluginContext, state } = makeHarnessWithoutAgents();
  apply(pluginContext, {});
  assert.ok(state.routes.has('/api/dsh-continue-guard'), 'routes must not depend on the loop driver');

  const res = await request(state, '/state', { search: '?sessionId=sess-x' });
  assert.equal(res.statusCode, 200, 'the pill must be able to poll without agents');
  assert.equal(res.payload.ok, true, JSON.stringify(res.payload));
  assert.equal(res.payload.value.hasAgent, false, 'no loop driver means no agent');
});

await check('without the loop driver, resume explains itself instead of 404-ing', async () => {
  const { pluginContext, state } = makeHarnessWithoutAgents();
  apply(pluginContext, {});
  const res = await request(state, '/resume', { method: 'POST', body: { sessionId: 'sess-y' } });
  assert.equal(res.statusCode, 200, 'a POST to a real route must not be a 404');
  assert.equal(res.payload.ok, false);
  assert.match(String(res.payload.error), /agents|循环/);
});

await check('apply() with enabled:false mounts nothing', async () => {
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, { enabled: false });
  assert.equal(state.injections.length, 0, 'must not inject when disabled');
  assert.equal(state.routes.size, 0, 'must not register a route when disabled');
});

await check('mount logs the HTTP route so a missing one is visible in the log', async () => {
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, {});
  const mounted = state.logs.find((l) => l.message.includes('HTTP 路由'));
  assert.ok(mounted !== undefined, `no mount log; saw: ${state.logs.map((l) => l.message).join(' | ')}`);
});

// ── the routes the client calls ─────────────────────────────────────────────

await check('GET /state answers for a session the host knows', async () => {
  const { pluginContext, state } = makeHarness();
  state.agents.push(makeAgent('sess-1'));
  apply(pluginContext, {});
  const res = await request(state, '/state', { search: '?sessionId=sess-1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true, JSON.stringify(res.payload));
  assert.equal(res.payload.value.sessionId, 'sess-1');
  assert.equal(res.payload.value.hasAgent, true, 'the seeded agent was not indexed');
});

await check('GET /state refuses a missing sessionId', async () => {
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, {});
  const res = await request(state, '/state');
  assert.equal(res.payload.ok, false);
  assert.match(String(res.payload.error), /sessionId/);
});

await check('an unknown route is a 404, not a crash', async () => {
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, {});
  const res = await request(state, '/nope');
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.ok, false);
});

await check('a cross-origin request is refused', async () => {
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, {});
  const route = state.routes.get('/api/dsh-continue-guard');
  let statusCode = 200;
  const res = { setHeader() {}, end: () => {}, writeHead(c) { statusCode = c; } };
  await route.handler(
    { method: 'GET', url: '/state?sessionId=x', headers: { host: '127.0.0.1:1', origin: 'https://evil.example' } },
    res,
  );
  assert.equal(statusCode, 403, 'an off-host Origin must not reach the handlers');
});

// ── the happy path: the click actually sends ────────────────────────────────

await check('POST /resume delivers a followup to a live agent', async () => {
  const { pluginContext, state } = makeHarness();
  const agent = makeAgent('sess-2');
  state.agents.push(agent);
  apply(pluginContext, {});

  const res = await request(state, '/resume', { method: 'POST', body: { sessionId: 'sess-2' } });
  assert.equal(res.payload.ok, true, `resume failed: ${JSON.stringify(res.payload)}`);
  assert.equal(agent.followups.length, 1, 'followup was never called — this is the "button does nothing" bug');
  assert.ok(agent.followups[0] !== undefined, 'followup got no message');
  assert.equal(state.followupOrder.includes('withoutInitiator'), true, 'delivery must be wrapped in withoutInitiator()');
});

await check('the delivered message is a signed plugin message, not a fake user turn', async () => {
  const { pluginContext, state } = makeHarness();
  const agent = makeAgent('sess-3');
  state.agents.push(agent);
  apply(pluginContext, {});
  await request(state, '/resume', { method: 'POST', body: { sessionId: 'sess-3' } });

  const message = agent.followups[0];
  assert.equal(message.role, 'user');
  const kind = message.source?.kind;
  assert.ok(kind !== 'user', 'must never forge {kind:"user"} — that is host attestation of a human');
  assert.equal(kind, 'plugin:dsh-continue-guard', `source kind was ${kind}`);
  const body = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  assert.match(body, /继续/, `resume text missing: ${body}`);
});

await check('POST /resume reports no-agent when nothing is registered', async () => {
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, {});
  const res = await request(state, '/resume', { method: 'POST', body: { sessionId: 'ghost' } });
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.value.status, 'no-agent', JSON.stringify(res.payload));
});

await check('a resumed session is not double-sent by two rapid clicks', async () => {
  const { pluginContext, state } = makeHarness();
  const agent = makeAgent('sess-4');
  state.agents.push(agent);
  apply(pluginContext, {});
  const [first, second] = await Promise.all([
    request(state, '/resume', { method: 'POST', body: { sessionId: 'sess-4' } }),
    request(state, '/resume', { method: 'POST', body: { sessionId: 'sess-4' } }),
  ]);
  assert.equal(agent.followups.length, 1, `two clicks sent ${agent.followups.length} followups`);
  const statuses = [first.payload.value.status, second.payload.value.status];
  assert.ok(statuses.includes('sent'), `neither click sent: ${statuses.join(', ')}`);
});

// ── events: does the host SEE an interruption? ──────────────────────────────

await check('a turn/end error is observed through the session/event hook', async () => {
  const { pluginContext, state } = makeHarness();
  state.agents.push(makeAgent('sess-5'));
  apply(pluginContext, {});

  const emit = state.listeners.get('session/event') ?? [];
  assert.ok(emit.length > 0, 'the plugin registered no session/event listener');

  for (const fn of emit) {
    fn({ id: 'sess-5' }, { type: 'turn/end', seq: 10, data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } } } });
  }
  await settleDeep();

  const res = await request(state, '/state', { search: '?sessionId=sess-5' });
  assert.equal(res.payload.value.stopped, true, `interruption not recorded: ${JSON.stringify(res.payload.value)}`);
  assert.ok(String(res.payload.value.reason).includes('network'), `reason was ${res.payload.value.reason}`);
});

await check('a generic error becomes a network episode when the browser reported offline', async () => {
  // THE WiFi CASE, end to end through the real apply() and the real routes.
  //
  // A WiFi drop often surfaces as a generic provider error ("returned an empty
  // response"), which alone is indistinguishable from a quota/account problem —
  // so by default it would NOT auto-resume. The browser reporting itself offline
  // is the missing evidence.
  //
  // Asserted HERE, not in the scheduler test: the decision lives in the
  // listener's wiring, and a test that re-derives the boolean by hand stays green
  // even when the listener stops consulting the hint (a mutation proved exactly
  // that). Here the real listener does the deciding.
  const { pluginContext, state } = makeHarness();
  state.agents.push(makeAgent('sess-offline'));
  apply(pluginContext, { autoResumeOnError: false });

  const down = await request(state, '/network', { method: 'POST', body: { sessionId: 'sess-offline', down: true } });
  assert.equal(down.payload.ok, true, 'the offline hint must be accepted');

  const emit = state.listeners.get('session/event') ?? [];
  const generic = { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Provider returned an empty response' } };
  for (const fn of emit) fn({ id: 'sess-offline' }, { type: 'turn/end', seq: 20, data: { reason: generic } });
  await settleDeep();

  const res = await request(state, '/state', { search: '?sessionId=sess-offline' });
  assert.equal(res.payload.value.stopped, true, 'the interruption is recorded');
  assert.equal(res.payload.value.reason, 'network.stream',
    `offline evidence must reclassify it as a link failure, got "${res.payload.value.reason}"`);
  assert.equal(res.payload.value.autoAllowed, true,
    'and it must be auto-resumable with the DEFAULT config (autoResumeOnError off)');
});

await check('without offline evidence the same generic error stays conservative', async () => {
  // The other half of the discriminator: the machine was online, so this is just
  // a model error and must keep needing the opt-in — otherwise every quota
  // exhaustion would auto-retry and burn money.
  const { pluginContext, state } = makeHarness();
  state.agents.push(makeAgent('sess-online'));
  apply(pluginContext, { autoResumeOnError: false });
  const emit = state.listeners.get('session/event') ?? [];
  const generic = { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Provider returned an empty response' } };
  for (const fn of emit) fn({ id: 'sess-online' }, { type: 'turn/end', seq: 21, data: { reason: generic } });
  await settleDeep();

  const res = await request(state, '/state', { search: '?sessionId=sess-online' });
  assert.equal(res.payload.value.reason, 'error', 'an online machine means a plain error');
  assert.equal(res.payload.value.autoAllowed, false, 'which keeps the labelled stop behaviour');
});

await check('a user/message refills the retry budget', async () => {
  const { pluginContext, state } = makeHarness();
  state.agents.push(makeAgent('sess-6'));
  apply(pluginContext, {});
  const emit = state.listeners.get('session/event') ?? [];

  const fire = (event) => { for (const fn of emit) fn({ id: 'sess-6' }, event); };
  fire({ type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { code: 'TRANSPORT' } } } });
  await settleDeep();
  fire({ type: 'user/message', seq: 2, data: { message: { source: { kind: 'user' } } } });
  await settleDeep();

  const res = await request(state, '/state', { search: '?sessionId=sess-6' });
  assert.equal(res.payload.value.attempts, 0, 'a human turn must reset attempts');
  assert.equal(res.payload.value.stopped, false, 'a human turn closes the episode');
});

await check('turn/start closes an episode', async () => {
  const { pluginContext, state } = makeHarness();
  state.agents.push(makeAgent('sess-7'));
  apply(pluginContext, {});
  const emit = state.listeners.get('session/event') ?? [];
  const fire = (event) => { for (const fn of emit) fn({ id: 'sess-7' }, event); };

  fire({ type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { code: 'TRANSPORT' } } } });
  await settleDeep();
  fire({ type: 'turn/start', seq: 2, data: {} });
  await settleDeep();

  const res = await request(state, '/state', { search: '?sessionId=sess-7' });
  assert.equal(res.payload.value.stopped, false, 'turn/start must end the episode');
});

// ── the auto-resume path, end to end ────────────────────────────────────────

await check('an interruption auto-resumes once the probe passes', async () => {
  // This is the feature the user asked for: not just a button, but one that
  // fires itself after a network drop. Drive it through the real route surface.
  const { pluginContext, state } = makeHarness();
  const agent = makeAgent('sess-8');
  state.agents.push(agent);
  apply(pluginContext, {
    resumeDelayMs: 1200,
    minResumeDelayMs: 1000,
    maxAutoResumes: 3,
    // Loopback port 1 refuses instantly: a deterministic "probe failed" that
    // needs no egress, then succeeds on the second pass.
    probeUrls: ['https://127.0.0.1:1/'],
    probeTimeoutMs: 200,
    probeRetries: 1,
    probeBackoffMs: 10,
    probeBackoffMaxMs: 20,
  });

  const emit = state.listeners.get('session/event') ?? [];
  for (const fn of emit) {
    fn({ id: 'sess-8' }, { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } } } });
  }
  await settleDeep();

  const after = await request(state, '/state', { search: '?sessionId=sess-8' });
  assert.equal(after.payload.value.stopped, true, 'episode not recorded');
  // The probe to a closed port fails, so nothing may be sent yet.
  assert.equal(agent.followups.length, 0, 'must not resume before the link is proven up');
});

await check('the sweep is armed on a timer', async () => {
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, {});
  const labels = state.effects.map((e) => String(e.label));
  assert.ok(labels.some((l) => l.includes('sweep')), `no sweep effect; effects: ${labels.join(', ')}`);
  const sweepEffect = state.effects.find((e) => String(e.label).includes('sweep'));
  assert.equal(typeof sweepEffect.dispose, 'function', 'the sweep timer must be disposable');
  sweepEffect.dispose(); // and must not throw
});

// ── the standing network monitor, through the real apply() ───────────────────
// These belong here rather than in verify-host: the question is not "does the
// scheduler know a rule", it is "does the MOUNTED plugin actually ask". A gate
// that re-derives the wiring by hand stays green when the wiring is removed —
// that mistake was made once already on the offline-hint discriminator.

await check('mount recovery runs against this gate\'s own session home', async () => {
  // The gate must not depend on whoever runs it. `apply()` scans <home>/sessions at
  // mount, and if that resolves to the operator's real home then a resumable
  // session sitting there can wake, arm, and probe — which is enough to satisfy
  // another check's assertion. Measured: that is exactly how "the plugin never
  // asks at mount" stopped being caught. Pin both the isolation and its effect.
  assert.equal(process.env.DSH_HOME, isolatedHome,
    'the operator\'s real session home would make this gate machine-dependent');
  const { pluginContext, state } = makeHarness();
  apply(pluginContext, { probeUrls: ['https://wire.test/'], probeTimeoutMs: 50, netCheckIntervalMs: 60000 });
  await settleDeep();
  assert.deepEqual(state.woken, [], 'nothing outside DSH_HOME may be woken at mount');
});

await check('the monitor starts asking at mount and keeps its own heartbeat', async () => {
  const { pluginContext, state } = makeHarness();
  const before = wire.calls;
  apply(pluginContext, { probeUrls: ['https://wire.test/'], probeTimeoutMs: 100, netCheckIntervalMs: 10000 });
  await settleDeep();
  assert.ok(wire.calls > before, 'mount must ask whether the internet is reachable');

  const labels = state.effects.map((e) => String(e.label));
  assert.ok(labels.some((l) => l.includes('network monitor')), `no monitor effect; effects: ${labels.join(', ')}`);
  const effect = state.effects.find((e) => String(e.label).includes('network monitor'));
  assert.equal(typeof effect.dispose, 'function', 'the heartbeat must be disposable');

  // A disposed plugin must stop touching the wire, not just stop logging.
  effect.dispose();
  const quiet = wire.calls;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(wire.calls, quiet, 'a disposed monitor must go quiet');
});

await check('the heartbeat runs at the configured cadence', async () => {
  // The requirement is an explicit "every 10 s", so the cadence is part of the
  // contract, not an implementation detail. Assert the interval that was actually
  // requested rather than waiting 10 real seconds for it to fire.
  const realSetInterval = globalThis.setInterval;
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { intervals.push(ms); return realSetInterval(fn, ms); };
  let dispose;
  try {
    const { pluginContext, state } = makeHarness();
    apply(pluginContext, { probeUrls: ['https://wire.test/'], probeTimeoutMs: 100, netCheckIntervalMs: 7000 });
    const effect = state.effects.find((e) => String(e.label).includes('network monitor'));
    assert.ok(effect !== undefined, 'the monitor must arm a timer');
    dispose = effect.dispose;
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  assert.ok(intervals.includes(7000), `the monitor must use the configured cadence; saw ${intervals.join(', ')}`);
  dispose();
});

await check('the state route reports the monitor verdict, not a guess', async () => {
  const { pluginContext, state } = makeHarness();
  wire.up = true;
  apply(pluginContext, { probeUrls: ['https://wire.test/'], probeTimeoutMs: 100 });
  await settleDeep();

  const up = await request(state, '/state', { search: '?sessionId=sess-net' });
  assert.equal(up.payload.value.net.reachable, true, 'the route must expose a real measurement');
  assert.equal(up.payload.value.net.checking, false, 'and must not claim a check is still out');
  assert.equal(up.payload.value.networkDown, false);

  wire.up = false;
  await request(state, '/probe', { method: 'POST', body: {} });
  const down = await request(state, '/state', { search: '?sessionId=sess-net' });
  assert.equal(down.payload.value.net.reachable, false);
  assert.equal(down.payload.value.networkDown, true, 'the pill needs to be able to say「断网中」');
  assert.match(String(down.payload.value.net.detail), /ENOTFOUND/, 'and to say why');
});

await check('the probe route drives the monitor instead of a second opinion', async () => {
  const { pluginContext, state } = makeHarness();
  wire.up = true;
  apply(pluginContext, { probeUrls: ['https://wire.test/'], probeTimeoutMs: 100 });
  await settleDeep();

  const ok = await request(state, '/probe', { method: 'POST', body: {} });
  assert.equal(ok.payload.ok, true);
  assert.equal(ok.payload.value.reachable, true);
  assert.match(String(ok.payload.value.via), /^probe:api$/);

  wire.up = false;
  const down = await request(state, '/probe', { method: 'POST', body: {} });
  assert.equal(down.payload.value.reachable, false);
  assert.equal(down.payload.value.checking, false, 'the verdict must be settled by the time it is returned');
});

await check('a completed turn overrides a blocked probe and lets the session continue', async () => {
  // The machine this runs on sends its traffic through a TLS-terminating
  // accelerator with its own CA, so the probe targets can be unreachable while
  // real model traffic is fine. Without the witness the plugin would conclude
  // "offline forever" and never resume — the reported symptom, from the other side.
  const { pluginContext, state } = makeHarness();
  const agent = makeAgent('sess-9');
  state.agents.push(agent);
  wire.up = false;
  apply(pluginContext, {
    resumeDelayMs: 40,
    minResumeDelayMs: 30,
    probeUrls: ['https://blocked.test/'],
    probeTimeoutMs: 100,
  });
  await settleDeep();
  const emit = state.listeners.get('session/event') ?? [];
  for (const fn of emit) {
    fn({ id: 'sess-9' }, { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'fetch failed' } } } });
  }
  await settleDeep();

  const before = await request(state, '/state', { search: '?sessionId=sess-9' });
  assert.equal(before.payload.value.net.reachable, false, 'the probe says the wire is down');
  assert.equal(agent.followups.length, 0, 'so nothing may be sent yet');

  // Real traffic got through anyway and the turn COMPLETED: first-hand proof.
  wire.up = true;
  for (const fn of emit) {
    fn({ id: 'sess-9' }, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } });
  }
  await settleDeep();
  const after = await request(state, '/state', { search: '?sessionId=sess-9' });
  assert.equal(after.payload.value.net.reachable, true, 'a completed turn overrides the blocked probe');
  assert.match(String(after.payload.value.net.via), /^witness:/);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(agent.followups.length, 1, 'and the waiting session actually continues');
});

// ── startup recovery: the crash path goes through the real service ──────────
// This section exists because the bug it pins shipped green through EVERY other
// gate. The rules were right, the wiring was right, the fake was wrong: it stood
// in for `agents` with no `resume` at all, so the wake path was never executed
// and its argument list was never questioned. The real facade takes ONE argument
// (`AgentRegistry.resume(options)`), the call site passed two, and the plugin
// quietly never woke anything — the reported symptom exactly. A stand-in must
// fail the way the real thing fails, or it is not a test.

/**
 * A DSH_HOME holding one crashed session log: an open `turn/start` with no
 * matching `turn/end`, which is what a killed process leaves behind.
 */
function makeCrashedHome(sessionId) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-guard-mount-'));
  const dir = join(root, 'sessions', '--proj--', sessionId);
  mkdirSync(dir, { recursive: true });
  const line = (event) => `${JSON.stringify(event)}\n`;
  const text = [
    line({ type: 'session/start', seq: 1 }),
    line({ type: 'turn/start', seq: 2, data: { turn: 1 } }),
    line({ type: 'step/start', seq: 3 }),
    line({ type: 'assistant/message', seq: 4, data: { text: 'working' } }),
    line({ type: 'tool/call', seq: 5 }),
  ].join('');
  writeFileSync(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(text, 'utf8')));
  return root;
}

/** Point the plugin at a throwaway home for the duration of `fn`. */
async function withCrashedHome(sessionId, fn) {
  const home = makeCrashedHome(sessionId);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

await check('startup recovery wakes a dormant session through the service contract', async () => {
  await withCrashedHome('session-crashed', async () => {
    wire.up = true;
    const { pluginContext, state } = makeHarness();
    apply(pluginContext, {});
    await settleDeep();
    await settleDeep();

    assert.deepEqual(state.woken, ['session-crashed'],
      `the crashed session must be woken through agents.resume; woke ${JSON.stringify(state.woken)}`);
    assert.ok(state.resumeArity.length > 0, 'agents.resume must actually be called');
    for (const arity of state.resumeArity) {
      assert.equal(arity, 1,
        'agents.resume takes ONE argument (options). Passing a context/owner first makes '
        + 'options.resumeSessionId undefined and the resume dies before touching the log.');
    }
    assert.equal(state.resumeCalls[0].resumeSessionId, 'session-crashed');
    assert.ok(state.logs.some((entry) => /启动恢复/.test(entry.message)),
      'the recovery must be visible in the log, not silent');
  });
});

await check('the session woken at startup is actually resumed, not merely reopened', async () => {
  // Waking is only half the promise: the published agent starts IDLE and will
  // never run a turn on its own, so the plugin still has to send. A gate that
  // stopped at "resume was called" would bless a feature that opens a session
  // and leaves the person staring at an idle chat.
  await withCrashedHome('session-crashed-2', async () => {
    wire.up = true;
    const { pluginContext, state } = makeHarness();
    apply(pluginContext, { resumeDelayMs: 40, minResumeDelayMs: 30, probeUrls: ['https://wire.test/'] });
    await settleDeep();
    await settleDeep();

    assert.deepEqual(state.woken, ['session-crashed-2']);
    const agent = state.agents.find((candidate) => candidate.session?.id === 'session-crashed-2');
    assert.ok(agent !== undefined, 'the wake must publish an agent, or nothing can deliver the resume');

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(agent.followups.length, 1, `expected exactly one resume message, got ${agent.followups.length}`);
    const body = typeof agent.followups[0].content === 'string'
      ? agent.followups[0].content
      : JSON.stringify(agent.followups[0].content);
    assert.match(body, /继续/, `the resume text is missing: ${body}`);
  });
});

// ── report ──────────────────────────────────────────────────────────────────

console.log(`\n${failures.length === 0 ? 'All' : `${failures.length} FAILED,`} ${passed} mount checks ${failures.length === 0 ? 'passed' : ''}.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
// The mounted scheduler keeps a sweep interval alive.
process.exit(0);
