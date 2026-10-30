/**
 * Client-half smoke test: load client.js into a VM with a DOM-free React stub
 * and drive the pill through every state the host can report.
 *
 * Why a VM instead of the browser: the pill's job is a STATE TABLE — which label,
 * which tone, which glyph, when the click is allowed — and that table is exactly
 * where a UI plugin goes wrong silently (a blank label, a button that renders but
 * cannot send). Those bugs are invisible from "it registered" and slow to spot by
 * eye, so they get pinned here instead.
 *
 * Run: node scripts/verify-client.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'client.js'), 'utf8');

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

// ── a minimal React ─────────────────────────────────────────────────────────
// Hooks are real enough to run the component's logic: state, effects and refs
// persist per mounted instance, and effects run on demand (not automatically),
// so a test decides when the poll loop ticks.

function makeReact() {
  const instances = [];
  let current = null;

  function makeHookSlot(init) {
    const slot = { value: init, queue: [] };
    return slot;
  }

  function useReducer(reducer, initial) {
    const slot = current.hooks[current.index++] ?? (current.hooks[current.index - 1] = makeHookSlot({ value: initial }));
    if (slot.queue.length > 0) {
      slot.value = slot.queue.reduce(reducer, slot.value);
      slot.queue = [];
    }
    return [slot.value, (action) => { slot.queue.push(action); }];
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(initial) {
      const slot = current.hooks[current.index++] ?? (current.hooks[current.index - 1] = makeHookSlot(typeof initial === 'function' ? initial() : initial));
      if (!('set' in slot)) {
        slot.set = (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next;
          current.dirty = true;
        };
      }
      return [slot.value, slot.set];
    },
    useRef(initial) {
      const slot = current.hooks[current.index++] ?? (current.hooks[current.index - 1] = makeHookSlot({ current: initial }));
      return slot.value;
    },
    useMemo(fn) {
      const slot = current.hooks[current.index++] ?? (current.hooks[current.index - 1] = makeHookSlot(fn()));
      return slot.value;
    },
    useCallback(fn) {
      return fn;
    },
    useEffect(fn) { current.effects.push(fn); },
    useReducer,
    useLayoutEffect() {},
    Fragment: 'fragment',
  };

  return {
    React,
    mount(Component, props) {
      const instance = { Component, props, hooks: [], effects: [], dirty: false };
      instances.push(instance);
      const render = () => {
        current = instance;
        instance.index = 0;
        instance.effects = [];
        instance.dirty = false;
        const tree = Component(props);
        return tree;
      };
      instance.render = render;
      instance.tree = render();
      return instance;
    },
    /** Rerun the component body, picking up any setState calls. */
    rerender(instance) {
      instance.tree = instance.render();
      return instance.tree;
    },
    /** Run the effects registered by the last render. */
    runEffects(instance) {
      for (const fn of instance.effects) fn();
      return instance;
    },
  };
}

// ── a fake host ─────────────────────────────────────────────────────────────

/** Load client.js with a stubbed module table, capturing the registration. */
function load({ hostValue, fetchImpl, online = true, lang = 'zh-CN' }) {
  const react = makeReact();
  const registrations = [];
  const requests = [];
  const listeners = {};

  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    Promise,
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    Error,
    TypeError,
    isNaN,
    parseInt,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (fetchImpl !== undefined) return fetchImpl(String(url), init);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, value: hostValue }),
      };
    },
    navigator: { onLine: online },
    document: { documentElement: { lang } },
    localStorage: { getItem: () => null, setItem: () => {} },
    __ModuleLoader__: {
      load(definition) {
        registrations.push(definition);
      },
    },
  };
  context.window = context;
  context.window.addEventListener = (name, fn) => { (listeners[name] ??= []).push(fn); };
  context.window.removeEventListener = (name, fn) => {
    const list = listeners[name];
    if (list === undefined) return;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  };
  context.addEventListener = context.window.addEventListener;
  context.removeEventListener = context.window.removeEventListener;

  const sandbox = vm.createContext(context);
  new vm.Script(SOURCE, { filename: 'client.js' }).runInContext(sandbox);

  assert.equal(registrations.length, 1, 'client.js must register exactly one module');
  const registration = registrations[0];

  const moduleExports = registration.factory((specifier) => {
    if (specifier === 'react') return react.React;
    throw new Error(`unexpected require("${specifier}")`);
  });

  return { registration, moduleExports, react, requests, listeners, context };
}

/** Walk a rendered tree and collect its text + the button node. */
function inspect(tree) {
  let button = null;
  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (typeof node !== 'object') return;
    if (node.type === 'button') button = node;
    (node.children ?? []).forEach(walk);
    // Function components (glyphs) only matter for their side effects, not text.
  };
  walk(tree);
  return { button, text: texts.join('').trim(), texts };
}

/**
 * A fake `sessions` service shaped like the real one: `binding(id).session` with
 * the `beginSubmission` + `prompt` pair the composer uses.
 *
 * `fail` injects a specific misbehaviour so the tests can pin the handling of
 * each one instead of only the happy path.
 */
function makeSessions({ fail = '', requestId = 'rid-1', noBinding = false, promptResult = { ok: true } } = {}) {
  const calls = { binding: [], begin: [], prompt: [], abandon: 0 };
  const sessions = {
    binding(sessionId) {
      calls.binding.push(sessionId);
      if (noBinding) return undefined;
      return {
        session: {
          beginSubmission(options) {
            calls.begin.push(options);
            if (fail === 'begin') throw new Error('echo registration refused');
            return { requestId, abandon() { calls.abandon += 1; } };
          },
          async prompt(parts, mode, _signal, rid) {
            calls.prompt.push({ parts, mode, rid });
            if (fail === 'prompt') throw new Error('transport died');
            return promptResult;
          },
        },
      };
    },
  };
  return { sessions, calls };
}

/** The plugin context a client half is handed, minus the parts under test. */
function makeCtx({ sessions = undefined, registrations = [], disposers = [] } = {}) {
  return {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    // A service that is absent means the inject callback NEVER runs — that is
    // the whole reason the capture is deferred.
    inject(names, fn) {
      registrations.push({ kind: 'inject', names });
      if (names.includes('sessions') && sessions !== null && sessions !== undefined) fn({ sessions });
    },
    slots: {
      inject(name, fn) { registrations.push({ kind: 'slotInject', name }); fn(); },
      register(options, Component) { registrations.push({ kind: 'register', options, Component }); },
    },
  };
}

/** Mount the pill against a given host snapshot and return it rendered. */
async function render(hostValue, extra = {}) {
  const loaded = load({ hostValue, ...extra });
  const apply = loaded.moduleExports;
  assert.equal(typeof apply.apply, 'function', 'the module must expose apply()');

  const registrations = [];
  const disposers = [];
  const ctx = makeCtx({ sessions: 'sessions' in extra ? extra.sessions : makeSessions().sessions, registrations, disposers });
  apply.apply(ctx);
  const registered = registrations.find((r) => r.kind === 'register');
  assert.ok(registered !== undefined, 'nothing was registered into a slot');

  const instance = loaded.react.mount(registered.Component, { sessionId: 's1' });
  // The poll lives in an effect; run it, let the fetch resolve, then re-render so
  // the pill paints the host's answer. Two passes because the state-driven
  // effects (the countdown ticker, the success flash) are registered by the
  // SECOND render, not the first.
  for (let pass = 0; pass < 3; pass += 1) {
    loaded.react.runEffects(instance);
    await settle();
  }
  loaded.react.rerender(instance);
  loaded.react.runEffects(instance);
  loaded.react.rerender(instance);
  return { ...loaded, instance, rendered: inspect(instance.tree), registered, registrations };
}

/** Flush the microtask + macrotask queue so awaited fetches land. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Strip an object down to plain data.
 *
 * Values that cross the VM boundary keep the OTHER realm's Object/Array
 * prototypes, and `assert.deepEqual` (strict) compares prototypes — so a
 * perfectly correct `{mode:'queue',text:'继续',attachments:[]}` would fail
 * against an identical literal. A JSON round-trip normalises the realm without
 * weakening the comparison.
 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const IDLE = {
  sessionId: 's1', stopped: false, armed: false, probing: false, networkDown: false,
  attempts: 0, maxAutoResumes: 3, autoResume: true, text: '继续', pill: true,
  showReason: true, now: 1000, resumeAt: 0, hasAgent: true, resumable: false,
};
const stoppedState = (over = {}) => ({ ...IDLE, stopped: true, resumable: true, ...over });

// ── registration ────────────────────────────────────────────────────────────

await check('registers into the composer dock after the shipped pills', async () => {
  const { registered } = await render(IDLE);
  assert.equal(registered.options.name, 'conversation.composer.dock');
  assert.equal(registered.options.id, 'dsh-continue-guard');
  // The shell's own stats pill is order 0, dsh-live-token-stats is 10.
  assert.ok(registered.options.order > 10, `order ${registered.options.order} would push a shipped pill left`);
});

await check('renders nothing without a session id', async () => {
  const loaded = load({ hostValue: IDLE });
  const registrations = [];
  const ctx = makeCtx({ sessions: makeSessions().sessions, registrations });
  loaded.moduleExports.apply(ctx);
  const Component = registrations.find((r) => r.kind === 'register').Component;
  // Mount rather than call: the component runs hooks before its early return,
  // so it needs a live instance the way React would provide one.
  for (const sessionId of [undefined, null]) {
    const instance = loaded.react.mount(Component, { sessionId });
    assert.equal(instance.tree, null, `rendered something for sessionId=${sessionId}`);
  }
});

// ── the state table ─────────────────────────────────────────────────────────

await check('idle: shows the bare word and stays clickable', async () => {
  const { rendered } = await render(IDLE);
  assert.equal(rendered.button.props.disabled, false, 'an idle pill must still be clickable');
  assert.ok(rendered.text.includes('继续'), `label was "${rendered.text}"`);
});

await check('stopped: highlights as actionable', async () => {
  const { rendered } = await render(stoppedState({ reason: 'network.stream' }));
  assert.equal(rendered.button.props.disabled, false);
  const colour = String(rendered.button.props.style.color);
  assert.ok(colour.includes('brand-primary') || colour.includes('4f8cff'), `not highlighted: ${colour}`);
});

await check('armed: shows a live countdown in seconds', async () => {
  // Host clock is 1000, the fire time is 3000 => 2s left.
  const { rendered } = await render(stoppedState({ armed: true, resumeAt: 3000, now: 1000 }));
  assert.match(rendered.text, /2\s*秒/, `expected a countdown, got "${rendered.text}"`);
  const colour = String(rendered.button.props.style.color);
  assert.ok(colour.includes('warning') || colour.includes('d9a13c'), `armed should be amber: ${colour}`);
});

await check('armed: a past deadline never renders a negative countdown', async () => {
  const { rendered } = await render(stoppedState({ armed: true, resumeAt: 100, now: 9999 }));
  assert.ok(!rendered.text.includes('-'), `rendered "${rendered.text}"`);
  assert.match(rendered.text, /1\s*秒/, 'clamps to a 1s floor while the send lands');
});

await check('offline and waiting: says so instead of offering a dead click', async () => {
  const { rendered } = await render(stoppedState({ networkDown: true }));
  assert.ok(/网络|检测/.test(rendered.text), `label was "${rendered.text}"`);
});

await check('probing offline: distinguishes "checking" from "waiting"', async () => {
  const waiting = await render(stoppedState({ networkDown: true, probing: false }));
  const probing = await render(stoppedState({ networkDown: true, probing: true }));
  assert.notEqual(waiting.rendered.text, probing.rendered.text, 'probing and waiting must differ');
});

await check('budget spent: explains why nothing fires automatically', async () => {
  const { rendered } = await render(stoppedState({ attempts: 3, maxAutoResumes: 3 }));
  assert.ok(/上限/.test(rendered.text), `label was "${rendered.text}"`);
});

await check('every state renders a non-empty label', async () => {
  const states = [
    IDLE,
    stoppedState(),
    stoppedState({ armed: true, resumeAt: 3000, now: 1000 }),
    stoppedState({ networkDown: true }),
    stoppedState({ networkDown: true, probing: true }),
    stoppedState({ attempts: 3 }),
    stoppedState({ reason: 'upstream.truncated' }),
  ];
  for (const state of states) {
    const { rendered } = await render(state);
    assert.ok(rendered.text.length > 0, `blank label for ${JSON.stringify(state)}`);
  }
});

// ── actions: the real user-input path ───────────────────────────────────────

await check('sessions is DEFERRED: a missing service must not unmount the pill', async () => {
  const loaded = load({ hostValue: IDLE });
  // A static dependency here would leave the whole client plugin pending, so
  // the button would not render at all on a profile without `sessions`.
  // Compared element-wise: the array crosses the VM boundary.
  assert.equal(loaded.moduleExports.inject.length, 1, `static inject is ${JSON.stringify(plain(loaded.moduleExports.inject))}`);
  assert.equal(loaded.moduleExports.inject[0], 'slots');
  const registered = await render(IDLE, { sessions: null });
  assert.ok(
    registered.registrations.some((r) => r.kind === 'inject' && Array.isArray(r.names) && r.names.includes('sessions')),
    'the sessions capture must be requested through a deferred inject',
  );
});

await check('a click sends through the real submission pipeline, not the HTTP route', async () => {
  const api = makeSessions();
  const { rendered, requests } = await render(IDLE, { sessions: api.sessions });
  await rendered.button.props.onClick();
  assert.equal(api.calls.binding.length, 1, 'the session binding must be resolved once');
  assert.equal(api.calls.begin.length, 1, 'beginSubmission must be called once');
  assert.deepEqual(plain(api.calls.begin[0]), { mode: 'queue', text: '继续', attachments: [] });
  assert.equal(api.calls.prompt.length, 1, 'prompt must be called once');
  assert.deepEqual(plain(api.calls.prompt[0].parts), [{ type: 'text', text: '继续' }]);
  assert.equal(api.calls.prompt[0].mode, 'queue');
  // The echo handle's requestId must reach prompt, or the optimistic bubble the
  // input box would have shown is never matched to the real message.
  assert.equal(api.calls.prompt[0].rid, 'rid-1', 'the echo handle must be threaded into prompt');
  // This is the point of the change: a manual click is ordinary user input, so
  // it must NOT go down the plugin-signed host route.
  assert.equal(
    requests.find((r) => r.url.includes('/resume')),
    undefined,
    'the primary path must not touch the host route',
  );
});

await check('the sent word comes from config, not a hard-coded 「继续」', async () => {
  const api = makeSessions();
  const { rendered } = await render({ ...IDLE, text: '接着干' }, { sessions: api.sessions });
  await rendered.button.props.onClick();
  assert.equal(api.calls.begin[0].text, '接着干', `sent "${api.calls.begin[0].text}"`);
  assert.deepEqual(plain(api.calls.prompt[0].parts), [{ type: 'text', text: '接着干' }]);
});

await check('a successful user submission is acknowledged on the pill', async () => {
  const api = makeSessions();
  const { instance, rendered, react } = await render(IDLE, { sessions: api.sessions });
  await rendered.button.props.onClick();
  react.rerender(instance);
  assert.ok(inspect(instance.tree).text.includes('已发送'), 'success must be acknowledged on the pill');
});

await check('a click while already sending cannot double-send', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = makeSessions();
  const slow = {
    binding(sessionId) {
      const inner = api.sessions.binding(sessionId).session;
      return {
        session: {
          beginSubmission: (o) => inner.beginSubmission(o),
          prompt: async (parts, mode, signal, rid) => { await gate; return inner.prompt(parts, mode, signal, rid); },
        },
      };
    },
  };
  const { rendered } = await render(IDLE, { sessions: slow });
  const first = rendered.button.props.onClick();
  const second = rendered.button.props.onClick(); // the ref guard is synchronous
  release();
  await Promise.all([first, second]);
  assert.equal(api.calls.prompt.length, 1, `two clicks produced ${api.calls.prompt.length} sends`);
});

// ── actions: the fallback and the failure modes ─────────────────────────────

await check('with no sessions service, the click falls back to the host route', async () => {
  const { instance, rendered, requests, react } = await render(IDLE, { sessions: null });
  await rendered.button.props.onClick();
  const posted = requests.find((r) => r.url.includes('/resume') && r.init?.method === 'POST');
  assert.ok(posted !== undefined, `no resume POST; saw ${requests.map((r) => r.url).join(', ')}`);
  assert.equal(JSON.parse(posted.init.body).sessionId, 's1');
  react.rerender(instance);
  assert.ok(inspect(instance.tree).text.includes('已发送'), 'the fallback must also be acknowledged');
});

await check('an unresolvable binding falls back rather than failing hard', async () => {
  const api = makeSessions({ noBinding: true });
  const { rendered, requests } = await render(IDLE, { sessions: api.sessions });
  await rendered.button.props.onClick();
  assert.equal(api.calls.prompt.length, 0);
  assert.ok(
    requests.find((r) => r.url.includes('/resume') && r.init?.method === 'POST') !== undefined,
    'a missing binding is "unavailable", so the route must be tried',
  );
});

await check('a REAL rejection is reported, never retried down the fallback', async () => {
  // Falling through here would send the word twice — once rejected, once via the
  // route — which is worse than showing the error.
  const api = makeSessions({ promptResult: { ok: false, error: { message: '上游拒绝' } } });
  const { instance, rendered, react, requests } = await render(IDLE, { sessions: api.sessions });
  await rendered.button.props.onClick();
  assert.equal(requests.find((r) => r.url.includes('/resume')), undefined, 'a rejection must not fall through to the route');
  assert.equal(api.calls.abandon, 1, 'the optimistic echo must be abandoned on failure');
  react.rerender(instance);
  const text = inspect(instance.tree).text;
  assert.ok(text.includes('发送失败') && text.includes('上游拒绝'), `no explanation rendered: "${text}"`);
});

await check('a throwing prompt abandons the echo handle and is reported', async () => {
  const api = makeSessions({ fail: 'prompt' });
  const { instance, rendered, react, requests } = await render(IDLE, { sessions: api.sessions });
  await rendered.button.props.onClick();
  assert.equal(api.calls.abandon, 1, 'a thrown prompt must still release the echo handle');
  assert.equal(requests.find((r) => r.url.includes('/resume')), undefined);
  react.rerender(instance);
  assert.ok(inspect(instance.tree).text.includes('发送失败'), 'a throw must be surfaced');
});

await check('a broken echo registration still sends the message', async () => {
  // beginSubmission is cosmetic (the optimistic bubble). Losing it must not cost
  // the user their resume.
  const api = makeSessions({ fail: 'begin' });
  const { instance, rendered, react } = await render(IDLE, { sessions: api.sessions });
  await rendered.button.props.onClick();
  assert.equal(api.calls.prompt.length, 1, 'the send must survive a failed echo registration');
  assert.equal(api.calls.prompt[0].rid, undefined, 'with no handle there is no requestId to thread');
  react.rerender(instance);
  assert.ok(inspect(instance.tree).text.includes('已发送'), 'the send succeeded and must say so');
});

await check('a no-agent refusal from the fallback is explained, not swallowed', async () => {
  const { instance, rendered, react } = await render(IDLE, {
    sessions: null,
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: false, error: 'no-agent', value: { ok: false, status: 'no-agent' } }),
    }),
  });
  await rendered.button.props.onClick();
  react.rerender(instance);
  const text = inspect(instance.tree).text;
  assert.ok(text.includes('Agent') || text.includes('发送失败'), `no explanation rendered: "${text}"`);
});

await check('routes are document-relative', async () => {
  const { requests } = await render(IDLE, { sessions: null });
  for (const request of requests) {
    assert.ok(!request.url.startsWith('/'), `root-absolute request would bypass <base>: ${request.url}`);
  }
});

await check('a page loaded while already offline reports that state on mount', async () => {
  // A WiFi drop that happened BEFORE the page loaded fires no `offline` event —
  // there is no edge to observe. Without this report the host never learns the
  // machine is offline, so the evidence it uses to tell a link failure from a
  // model error would be missing for exactly the sessions that need it.
  const { requests } = await render(IDLE, { online: false });
  const reported = requests.filter((r) => r.url.includes('/network'));
  assert.ok(reported.length >= 1, `no network report on mount; saw ${requests.map((r) => r.url).join(', ')}`);
  assert.equal(JSON.parse(reported[0].init.body).down, true, 'the standing offline state must be reported as down');
  // An ONLINE page must stay quiet: reporting "down" when nothing is wrong would
  // manufacture evidence and weaken the discriminator.
  const online = await render(IDLE, { online: true });
  assert.equal(online.requests.filter((r) => r.url.includes('/network')).length, 0,
    'an online page must not report a phantom offline state');
});

await check('the browser edges are still forwarded after mount', async () => {
  const { listeners } = await render(IDLE, { online: true });
  assert.ok(Array.isArray(listeners.offline) && listeners.offline.length > 0, 'no offline listener registered');
  assert.ok(Array.isArray(listeners.online) && listeners.online.length > 0, 'no online listener registered');
});

console.log(`\n${failures.length === 0 ? 'All' : `${failures.length} FAILED,`} ${passed} client checks ${failures.length === 0 ? 'passed' : ''}.\n`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
// Every mounted pill keeps polling (that is the feature), so the event loop is
// never empty. Exit explicitly instead of waiting for a drain that cannot come.
process.exit(0);
