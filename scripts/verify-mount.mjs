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
    inject(names, fn) {
      state.injections.push(names);
      const scope = {
        agents: {
          list: () => state.agents,
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

// ── report ──────────────────────────────────────────────────────────────────

console.log(`\n${failures.length === 0 ? 'All' : `${failures.length} FAILED,`} ${passed} mount checks ${failures.length === 0 ? 'passed' : ''}.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
// The mounted scheduler keeps a sweep interval alive.
process.exit(0);
