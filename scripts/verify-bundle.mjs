/**
 * Static gates for the bundle before it is installed.
 *
 * These catch the class of failure that is silent at runtime: a patch telling the
 * loader about a config key the schema does not accept (the row is rejected and
 * the plugin simply never appears), a declared export that points at a missing
 * file, or an icon that is not a readable image. Each gate prints FAIL and exits
 * non-zero, so "it installed" can never stand in for "it is wired".
 *
 * Run: node scripts/verify-bundle.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;

function check(name, fn) {
  checks += 1;
  try {
    const detail = fn();
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n         ${error.message}`);
  }
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

/**
 * Strip comments before scanning for a forbidden needle.
 *
 * A ban that also matches prose punishes the comment explaining why the ban
 * exists — the gate would fail on its own documentation, and the tempting fix
 * (delete the explanation) would leave the next reader without the reason. So
 * scan the CODE.
 */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('\n== manifest ==');

const pkg = json('package.json');

check('package.json parses, is publishable and ESM', () => {
  // This package is published to GitHub and to plugin markets, so it must NOT
  // be private. What matters instead is that it carries the metadata a market
  // loader needs to accept it.
  if (pkg.private === true) throw new Error('expected no "private": true (this package is published)');
  if (pkg.type !== 'module') throw new Error('expected "type": "module"');
  if (typeof pkg.dsh?.bundle?.patch !== 'string') throw new Error('expected "dsh.bundle.patch"');
  if (pkg.repository === undefined) throw new Error('expected a "repository" field');
  if (pkg.license === undefined) throw new Error('expected a "license" field');
  return `${pkg.name}@${pkg.version}`;
});

check('every declared export points at a real file', () => {
  const missing = [];
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    if (target.includes('*')) continue; // glob exports are checked below
    if (!existsSync(join(ROOT, target))) missing.push(`${sub} -> ${target}`);
  }
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`);
  return `${Object.keys(pkg.exports).length} exports`;
});

check('every file in `files` exists', () => {
  const missing = (pkg.files ?? []).filter((f) => !f.includes('*') && !existsSync(join(ROOT, f)));
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`);
  return `${pkg.files.length} entries`;
});

check('the bundle patch is declared and present', () => {
  const patch = pkg.dsh?.bundle?.patch;
  if (typeof patch !== 'string') throw new Error('dsh.bundle.patch is not declared');
  if (!existsSync(join(ROOT, patch))) throw new Error(`${patch} does not exist`);
  return patch;
});

check('the client half is declared for the web platform', () => {
  const client = pkg.dsh?.client;
  if (client?.platform !== 'web') throw new Error('dsh.client.platform must be "web"');
  if (!existsSync(join(ROOT, 'client.js'))) throw new Error('client.js does not exist');
  return `inject: ${(client.inject ?? []).join(', ') || '(none)'}`;
});

console.log('\n== config surface ==');

const host = await import(new URL('../index.js', import.meta.url).href);
const schemaKeys = Object.keys(host.Config.properties ?? {});
const defaultKeys = Object.keys(host.Config.default ?? {});

check('Config exposes properties and defaults', () => {
  if (schemaKeys.length === 0) throw new Error('Config.properties is empty');
  if (defaultKeys.length === 0) throw new Error('Config.default is empty');
  return `${schemaKeys.length} keys`;
});

check('every default has a matching property', () => {
  const orphans = defaultKeys.filter((k) => !schemaKeys.includes(k));
  if (orphans.length > 0) throw new Error(`defaults without a property: ${orphans.join(', ')}`);
});

check('the patch only sets keys the schema accepts', () => {
  const yaml = read('cordis.patch.yml');
  // Config keys live at the deepest indentation level in this patch's shape.
  const patchKeys = [...yaml.matchAll(/^ {8}([A-Za-z][\w]*):/gm)].map((m) => m[1]);
  if (patchKeys.length === 0) throw new Error('no config keys found in the patch');
  const unknown = patchKeys.filter((k) => !schemaKeys.includes(k));
  if (unknown.length > 0) {
    throw new Error(`the loader would reject these: ${unknown.join(', ')}`);
  }
  return `${patchKeys.length} keys accepted`;
});

check('the patch names the package it ships', () => {
  const yaml = read('cordis.patch.yml');
  if (!yaml.includes(`name: '${pkg.name}'`)) throw new Error(`patch does not name ${pkg.name}`);
  if (!yaml.includes(`id: ${pkg.name}`)) throw new Error(`patch row id is not ${pkg.name}`);
});

check('normalizeConfig survives hostile input', () => {
  const cases = [
    undefined, null, {}, { probeUrls: 'not-an-array' },
    { probeUrls: [1, 2, 'ftp://x', 'https://ok.example'] },
    { resumeDelayMs: -5, maxAutoResumes: 9999, probeRetries: 0 },
    { text: '   ', enabled: 'yes' },
  ];
  for (const raw of cases) {
    const out = host.normalizeConfig(raw);
    if (typeof out.text !== 'string' || out.text === '') throw new Error(`text not defaulted for ${JSON.stringify(raw)}`);
    if (!Array.isArray(out.probeUrls) || out.probeUrls.length === 0) throw new Error(`probeUrls empty for ${JSON.stringify(raw)}`);
    if (!(out.resumeDelayMs >= out.minResumeDelayMs)) throw new Error(`delay below floor for ${JSON.stringify(raw)}`);
    if (out.probeRetries < 1) throw new Error(`retries < 1 for ${JSON.stringify(raw)}`);
  }
});

console.log('\n== localization and artwork ==');

check('both locale files parse and carry display metadata', () => {
  for (const locale of ['en', 'zh']) {
    const doc = json(`locale/${locale}.json`);
    if (typeof doc.meta?.title !== 'string' || doc.meta.title.trim() === '') {
      throw new Error(`locale/${locale}.json: meta.title missing`);
    }
    if (typeof doc.meta?.description !== 'string' || doc.meta.description.trim() === '') {
      throw new Error(`locale/${locale}.json: meta.description missing`);
    }
  }
  return 'en + zh';
});

check('the localized strings are not template leftovers', () => {
  const en = json('locale/en.json');
  const zh = json('locale/zh.json');
  if (en.meta.title === zh.meta.title) throw new Error('titles are identical; one is untranslated');
  const templateWords = /my-plugin|lorem ipsum|TODO/i;
  for (const [locale, doc] of [['en', en], ['zh', zh]]) {
    const blob = JSON.stringify(doc);
    if (templateWords.test(blob)) throw new Error(`locale/${locale}.json still carries template copy`);
  }
});

check('the Client copy covers every state the Host can report', () => {
  const client = read('client.js');
  // The pill reads these off its own COPY table; a missing one renders blank.
  for (const key of ['resume', 'resuming', 'sent', 'armed', 'waitingNetwork', 'probing', 'budget', 'failed', 'noAgent']) {
    if (!client.includes(`${key}:`)) throw new Error(`client.js has no copy for "${key}"`);
  }
});

check('icon.svg is a real, renderable SVG within the size limit', () => {
  const path = join(ROOT, 'icon.svg');
  if (!existsSync(path)) throw new Error('icon.svg is missing');
  const size = statSync(path).size;
  if (size > 256 * 1024) throw new Error(`icon is ${size} bytes (limit 256 KiB)`);
  const svg = read('icon.svg');
  if (!/^<svg[\s>]/u.test(svg.trim())) throw new Error('does not start with <svg');
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) throw new Error('missing svg namespace');
  if (!svg.includes('viewBox=')) throw new Error('missing viewBox');
  return `${size} bytes`;
});

console.log('\n== client wiring ==');

check('the client registers through the module loader as the package name', () => {
  const client = read('client.js');
  if (!client.includes('window.__ModuleLoader__.load')) throw new Error('no __ModuleLoader__.load call');
  if (!client.includes(`id: '${pkg.name}'`)) throw new Error(`factory id is not "${pkg.name}"`);
});

check('the client targets the allocated composer dock slot', () => {
  const client = read('client.js');
  if (!client.includes("conversation.composer.dock")) throw new Error('not registered into conversation.composer.dock');
  if (!client.includes('ctx.slots.inject')) throw new Error('does not use ctx.slots.inject');
});

check('the client addresses routes document-relatively', () => {
  const client = read('client.js');
  // A leading slash escapes <base href="./"> and the request never reaches the
  // plugin route on a sub-path deployment.
  const absolute = [...client.matchAll(/['"]\/(api|plugins)\//g)];
  if (absolute.length > 0) throw new Error(`root-absolute path found: ${absolute[0][0]}`);
});

check('the client never hardcodes colours instead of theme tokens', () => {
  const client = read('client.js');
  // Every literal colour must sit inside a var(--dsw-alias-*) fallback.
  const literals = [...client.matchAll(/#[0-9a-fA-F]{6}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
  const bare = literals.filter((literal) => {
    const at = client.indexOf(literal);
    const window = client.slice(Math.max(0, at - 120), at + literal.length);
    return !window.includes('var(--dsw-alias-');
  });
  if (bare.length > 0) throw new Error(`colours outside a token fallback: ${bare.slice(0, 3).join(', ')}`);
});

check('a manual click sends through the real submission pipeline', () => {
  const client = code(read('client.js'));
  // The requirement: a click must produce an ORDINARY user message. That is only
  // true if it goes through the composer's own pair, so all four parts must be
  // present — dropping any one silently degrades the click back into a
  // plugin-authored message that appears under a different source.
  for (const needle of ['beginSubmission', '.prompt(', "mode: 'queue'", 'attachments: []']) {
    if (!client.includes(needle)) throw new Error(`the client never calls ${needle}`);
  }
  // And it must still never forge the host's own attestation: the harness marks
  // real human input, and a plugin claiming that kind would be a lie.
  if (/kind:\s*'user'/.test(client)) throw new Error("the client forges { kind: 'user' }");
});

check('the client captures sessions through a deferred inject, not a static one', () => {
  const client = read('client.js');
  const staticInject = /inject:\s*\[([^\]]*)\]/.exec(client);
  if (staticInject === null) throw new Error('no static inject declared');
  if (staticInject[1].includes('sessions')) {
    throw new Error('sessions is a static inject — the pill would vanish wherever the service is absent');
  }
  if (!/ctx\.inject\(\s*\[\s*'sessions'\s*\]/.test(client)) {
    throw new Error('sessions is never captured via a deferred ctx.inject([...])');
  }
});

check('the client keeps the HTTP fallback for a profile without sessions', () => {
  const client = read('client.js');
  if (!client.includes('API.resume')) throw new Error('the host-route fallback was dropped');
  // "unavailable" is the only condition that may fall through; a REAL rejection
  // must not, or the word would be sent twice.
  if (!client.includes('unavailable')) throw new Error('the fallback trigger is gone');
});

check('webServer is a static inject; agents is deferred', () => {
  // `webServer` must be a hard dependency so the Loader resolves it BEFORE
  // apply() runs and the pill's HTTP surface always registers. `agents` must NOT
  // be static: it is absent in profiles without a loop driver, and depending on
  // it statically would leave the whole plugin — routes included — pending
  // forever there. That mismatch is what made every click answer 404.
  const src = read('index.js');
  const match = src.match(/export const inject = \[([^\]]*)\]/);
  if (match === null) throw new Error('no static `export const inject` declaration');
  const declared = match[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter((s) => s !== '');
  if (!declared.includes('webServer')) throw new Error('webServer must be a static inject');
  if (declared.includes('agents')) throw new Error('agents must not be static; use a deferred ctx.inject');
  if (!/ctx\.inject\(\['agents'\]/.test(src)) throw new Error("agents is not requested with a deferred ctx.inject(['agents'])");
  return declared.join(', ');
});

check('the HTTP route is registered on the plugin context, not inside the inject', () => {
  // The routes are the pill's ONLY path to the host. Registering them inside the
  // deferred `agents` callback ties them to a service the profile may never
  // provide — silent total failure, seen from the browser as 404 on every click.
  const src = read('index.js');
  const at = src.indexOf('ctx.webServer.register');
  const injectAt = src.indexOf("ctx.inject(['agents']");
  if (at === -1) throw new Error('no ctx.webServer.register call');
  if (injectAt !== -1 && at > injectAt) {
    throw new Error('the route is registered AFTER the agents inject — it would vanish without a loop driver');
  }
  return 'registered before the agents inject';
});

check('every host route handler matches the dispatcher signature', () => {
  // The dispatcher calls handler(body, query). A handler declared `(query)` gets
  // the request body and throws on `.get` — a 500 on the busiest route.
  const src = read('index.js');
  const from = src.indexOf('const routes = {');
  const to = src.indexOf('ctx.webServer.register');
  if (from === -1 || to === -1) throw new Error('cannot locate the route table');
  const table = src.slice(from, to);
  const handlers = [...table.matchAll(/async (\w+)\(([^)]*)\)/g)];
  if (handlers.length === 0) throw new Error('no route handlers found');
  const offenders = [];
  for (const [, name, params] of handlers) {
    const at = table.indexOf(`async ${name}(`);
    const next = table.slice(at + 1).search(/\n    async /);
    const slice = next === -1 ? table.slice(at) : table.slice(at, at + 1 + next);
    const usesQuery = /query\./.test(slice);
    const list = params.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (usesQuery && list.length < 2) {
      offenders.push(`${name}(${params}) reads query but does not take it as the 2nd argument`);
    }
  }
  if (offenders.length > 0) throw new Error(offenders.join('; '));
  return `${handlers.length} handlers`;
});

console.log('\n== host wiring ==');

check('the host exports an apply function', () => {
  if (typeof host.apply !== 'function') throw new Error('no apply export');
});

check('the host calls the agents service the way the service is actually shaped', () => {
  // `ctx.agents` is the AgentRegistry FACADE, not AgentLoop. The facade's
  // `resume(options)` takes ONE argument and supplies `ownerCtx = this.ctx`
  // itself (`dsh-agent/lib/index.js:467` — `Reflect.apply(target.resume,
  // receiver, [ownerCtx, options])`); the two-argument `resume(ownerCtx, options)`
  // is the loop's own method and is NOT reachable from a plugin. Pass a context
  // first and the CONTEXT becomes `options`, `options.resumeSessionId` is
  // undefined, and the resume dies on a schema check before it opens the log —
  // a silent no-op that shipped once and survived every gate. This check is
  // static on purpose: the behavioural gate in verify-mount needs a fake shaped
  // like the real service, and this one still catches the call site if that fake
  // ever drifts back to being permissive.
  // Scan CODE, not prose: the caller above documents the two `resume` shapes in
  // a comment, and a naive scan matches that text instead of the call site. This
  // is the same comment-anchor trap that produced a false failure once already.
  const src = code(read('index.js'));
  const calls = [...src.matchAll(/agents\.resume\(([^)]*)/g)].map((m) => m[1].trim());
  if (calls.length === 0) throw new Error('agents.resume is never called — recovery has no way to wake a session');
  for (const args of calls) {
    if (!args.startsWith('{')) throw new Error(`agents.resume(...) takes exactly one options object; saw resume(${args}`);
  }
  return `${calls.length} call(s), all one-argument`;
});

check('the host does not import harness packages at module scope', () => {
  // A link:-installed bundle resolves from the workspace, which has no
  // node_modules/@deepseek-ai; a bare import there throws ERR_MODULE_NOT_FOUND
  // and the plugin never mounts (measured, not assumed).
  const src = read('index.js');
  const staticImports = [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const forbidden = staticImports.filter((spec) => spec.startsWith('@deepseek-ai/'));
  if (forbidden.length > 0) throw new Error(`bare harness imports: ${forbidden.join(', ')}`);
  return staticImports.join(', ') || '(none)';
});

check('the host reaches createUserMessage lazily and has a local fallback', () => {
  const src = read('index.js');
  if (!src.includes('createRequire')) throw new Error('no createRequire anchor for the harness packages');
  if (!src.includes('role: \'user\'')) throw new Error('no local message fallback');
});

check('every host route the client calls exists', () => {
  const client = read('client.js');
  const src = read('index.js');
  const called = [...client.matchAll(/api\/dsh-continue-guard\/([a-z]+)/g)].map((m) => m[1]);
  const unique = [...new Set(called)];
  const missing = unique.filter((name) => !new RegExp(`async ${name}\\(`).test(src));
  if (missing.length > 0) throw new Error(`client calls routes the host lacks: ${missing.join(', ')}`);
  return unique.join(', ');
});

console.log(`\n${failures === 0 ? 'All' : `${failures} of`} ${checks} bundle checks ${failures === 0 ? 'passed' : 'FAILED'}.\n`);
process.exit(failures === 0 ? 0 : 1);
