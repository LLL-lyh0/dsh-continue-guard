/**
 * dsh-continue-guard — Host half.
 *
 * One-click 「继续」 for a session that stopped unexpectedly, plus an automatic
 * resume that waits for the network (or the upstream cut) to recover.
 *
 * ## Why the decision lives here and not in the browser
 *
 * The only trustworthy witnesses of "this turn died" are the durable session
 * events (`turn/end` with a non-completed reason, `assistant/message` with a
 * length stop) and the live agent (`agent/error`, `agent/status`). The browser
 * sees neither the reason codes nor the log, so this half owns:
 *
 *  1. classification — one interruption per episode, with a machine code
 *     (network / upstream cut / model abort …);
 *  2. the resume budget — consecutive auto-resumes are capped, and a genuine
 *     human or goal input refills it;
 *  3. delivery — `agent.followup()`, which wakes a quiescent agent. Nothing
 *     here re-implements sending.
 *
 * ## Why resume uses followup() and not append()
 *
 * A stopped agent is not driving itself: writing a `user/message` into the log
 * would be visible but inert — the loop would never wake, which is exactly the
 * complaint this plugin exists to fix. `followup()` queues the next-turn prompt
 * *and* wakes the driver (the same channel the harness's own goal-round driver
 * and dsh-providers-hub's loop-recovery use). When no agent is live at all, the
 * caller falls back to the session's own `prompt()`, which re-activates it.
 *
 * The message is signed `{ kind: 'plugin:dsh-continue-guard', … }`.
 * It is deliberately NOT `{ kind: 'user' }`: that kind is the host's attestation
 * of direct human input and gates authority-bearing commands (goal create /
 * resume). An auto-resume must not pretend to be a person.
 *
 * ## Why this file imports nothing (important)
 *
 * A workspace bundle is installed into the profile as a `link:` dependency, so
 * Node resolves this file from its REAL path in the workspace — and the
 * workspace has no `node_modules/@deepseek-ai/*`. A bare `import ... from
 * '@deepseek-ai/schemastery'` therefore throws ERR_MODULE_NOT_FOUND at load and
 * the whole plugin never mounts. Every working local bundle here (dsh-autostart,
 * dsh-github-manager, the workspace's own dsh-web-llm) imports `node:` builtins
 * only. The two harness modules this plugin genuinely needs are therefore
 * reached lazily, through `createRequire(process.execPath)` +
 * `import(fileURL)`, which is the pattern dsh-session-handoff's
 * `loadHarnessModule` documents for an asar-packed install; each has a local
 * equivalent that keeps the feature working if the lookup fails.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
// Startup recovery reads the on-disk session log. `node:fs` + `node:zlib` are
// builtins, so they respect the rule above; the log is zstd-compressed in
// appended frames, and `zstdDecompressSync` is the only decoder available here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const NS = 'dsh-continue-guard';
const ROUTE_BASE = '/api/dsh-continue-guard';
/**
 * Honest署名 for a resume message. `kind: 'plugin:<name>'` with the plugin field
 * is the established convention (dsh-command-context-trim's trim marker,
 * openviking, hindsight all sign this way), and it is deliberately NOT
 * `{ kind: 'user' }` — that kind is the host's attestation of direct human input
 * and gates authority-bearing commands (goal create / edit / resume). An
 * auto-resume must never look like a person spoke.
 */
const SOURCE_KIND = `plugin:${NS}`;
const SOURCE = Object.freeze({ kind: SOURCE_KIND, plugin: NS });

/** Default resume prompt — short, so a manual click reads exactly like typing 继续. */
export const DEFAULT_TEXT = '继续';

/**
 * What a recovered「继续」should tell the model about why the last turn died.
 * Keyed by the reason codes produced by {@link classifyInterrupt}; the Client
 * shows the code, the model gets this prose.
 */
const RESUME_NOTE = Object.freeze({
  'network.down': '上一轮因为网络连接中断没有跑完。现在网络已经恢复，请接着做完。',
  'network.stream': '上一轮的模型响应被中断（流断开或超时），现在可能已经恢复，请接着做完。',
  'upstream.truncated': '上一轮的回复在输出上限处被截断，任务没有做完。请接着被截断的地方继续完成。',
  'upstream.context-window': '上一轮超出了模型的上下文窗口。请压缩后接着完成未做完的部分。',
  'upstream.aborted': '上一轮提前中断，没有给出结论。请接着完成。',
  /**
   * Only the startup scan produces this one. The log's tail turn was never
   * closed, which means the process died while the turn was still running — the
   * harness names the same condition `interrupted` when it appends its own
   * crash-recovery closers (`interruptedTurnClosers` in dsh-session).
   */
  'process.exit': '上一个进程在任务跑到一半时退出了，这一轮没有跑完。请接着把它做完。',
  error: '上一轮出了错误。请判断错误是否已经消除，然后接着完成。',
});

/** Built-in defaults; every field is overridable in cordis.patch.yml. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  text: DEFAULT_TEXT,
  /** Auto-resume master switch. Off = button only. */
  autoResume: true,
  /** Delay after a reconnect before sending 继续 (the requested 1–3 s). */
  resumeDelayMs: 2000,
  minResumeDelayMs: 1200,
  /** Consecutive auto-resumes per session; a human / goal input refills it. */
  maxAutoResumes: 3,
  /**
   * Auto-resume a plain model/agent error once the connectivity probe passes.
   * Off by default: AUTH and QUOTA look identical to a dead network from here,
   * and a paid-for retry storm is worse than a click.
   */
  autoResumeOnError: false,
  /** Auto-resume a length stop (输出超限). Context-window overflow never auto-fires. */
  resumeOnTruncation: true,
  /** Connectivity probe targets, tried in order. Override with your own gateway. */
  probeUrls: ['https://api.deepseek.com', 'https://www.baidu.com', 'https://github.com'],
  probeTimeoutMs: 4000,
  /** Attempts per probe pass; the pass fails (still offline) when none answer. */
  probeRetries: 5,
  /** Backoff between attempts inside one pass, and a ceiling for the streak. */
  probeBackoffMs: 3000,
  probeBackoffMaxMs: 30000,
  /** Floor between two auto-resumes of one session, whatever the cause. */
  minResumeGapMs: 4000,
  /** Draw the pill chrome (background + border). Off = a plain button. */
  pill: true,
  /** Append the interruption reason to the button's hover title. */
  showReason: true,
  verbose: false,
  /**
   * Startup recovery: after the host restarts, a session that was killed
   * mid-turn has no live agent and no in-memory episode, so nothing would ever
   * notice it. The scan rebuilds that episode from the session log on disk.
   */
  startupResume: true,
  /** How far back the scan looks. A day matches "最近、意外中断" without resurrecting stale work. */
  startupResumeWithinMs: 24 * 60 * 60 * 1000,
  /** Most sessions to wake at once. One crash usually leaves one or two. */
  startupResumeLimit: 3,
});

/** Non-empty string, else the default. */
function str(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** Finite number inside [min, max], else the default. */
function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Resolve the row's raw config against {@link DEFAULTS}.
 *
 * Never throws: a typo in a profile patch must degrade to the default, not stop
 * the whole profile from booting.
 */
export function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(value.probeUrls)
    ? value.probeUrls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim()))
    : [];
  const backoff = num(value.probeBackoffMs, DEFAULTS.probeBackoffMs, 100, 60000);
  const minDelay = num(value.minResumeDelayMs, DEFAULTS.minResumeDelayMs, 0, 60000);
  return {
    enabled: flag(value.enabled, DEFAULTS.enabled),
    text: str(value.text, DEFAULTS.text),
    autoResume: flag(value.autoResume, DEFAULTS.autoResume),
    resumeDelayMs: num(value.resumeDelayMs, DEFAULTS.resumeDelayMs, minDelay, 120000),
    minResumeDelayMs: minDelay,
    maxAutoResumes: Math.round(num(value.maxAutoResumes, DEFAULTS.maxAutoResumes, 0, 10)),
    autoResumeOnError: flag(value.autoResumeOnError, DEFAULTS.autoResumeOnError),
    resumeOnTruncation: flag(value.resumeOnTruncation, DEFAULTS.resumeOnTruncation),
    probeUrls: list.length > 0 ? list.map((u) => u.trim()) : [...DEFAULTS.probeUrls],
    probeTimeoutMs: num(value.probeTimeoutMs, DEFAULTS.probeTimeoutMs, 500, 30000),
    probeRetries: Math.round(num(value.probeRetries, DEFAULTS.probeRetries, 1, 20)),
    probeBackoffMs: backoff,
    probeBackoffMaxMs: num(value.probeBackoffMaxMs, DEFAULTS.probeBackoffMaxMs, backoff, 120000),
    minResumeGapMs: num(value.minResumeGapMs, DEFAULTS.minResumeGapMs, 0, 60000),
    pill: flag(value.pill, DEFAULTS.pill),
    showReason: flag(value.showReason, DEFAULTS.showReason),
    verbose: flag(value.verbose, DEFAULTS.verbose),
    startupResume: flag(value.startupResume, DEFAULTS.startupResume),
    startupResumeWithinMs: num(value.startupResumeWithinMs, DEFAULTS.startupResumeWithinMs, 60000, 30 * 24 * 60 * 60 * 1000),
    startupResumeLimit: Math.round(num(value.startupResumeLimit, DEFAULTS.startupResumeLimit, 0, 20)),
  };
}

/**
 * The Config the loader validates the row against.
 *
 * A plain object rather than a schemastery schema, because the schema package
 * cannot be imported here (see the module header). The loader only needs a
 * `Schema`-compatible object to render defaults and reject bad values; this one
 * is authored with the small surface `normalizeConfig` already implements, so a
 * malformed value is coerced in ONE place instead of two that could disagree.
 * `normalizeConfig` is the single source of truth and never throws.
 */
export const Config = {
  type: 'object',
  default: { ...DEFAULTS },
  description: '一键「继续」：意外中断的会话可一键续跑；网络中断、上游截断恢复后自动续跑。',
  properties: {
    enabled: { type: 'boolean', default: DEFAULTS.enabled, description: '总开关。关闭后按钮与自动续跑都不注册。' },
    text: { type: 'string', default: DEFAULTS.text, description: '点按钮 / 自动续跑时发送的文本。' },
    autoResume: { type: 'boolean', default: DEFAULTS.autoResume, description: '检测到网络恢复、上游截断后是否自动补发一次「继续」。' },
    resumeDelayMs: { type: 'number', default: DEFAULTS.resumeDelayMs, description: '网络恢复后到发出「继续」之间的等待（毫秒），建议 1000–3000。' },
    minResumeDelayMs: { type: 'number', default: DEFAULTS.minResumeDelayMs, description: 'resumeDelayMs 的下限（毫秒）：配得再小也不会比它更快。' },
    maxAutoResumes: { type: 'number', default: DEFAULTS.maxAutoResumes, description: '同一会话连续自动续跑的次数上限；有人类输入或目标驱动输入后清零。' },
    autoResumeOnError: { type: 'boolean', default: DEFAULTS.autoResumeOnError, description: '普通模型/代理错误是否也自动续跑（默认否：AUTH、额度耗尽与断网在本地无法区分，会白烧额度）。' },
    resumeOnTruncation: { type: 'boolean', default: DEFAULTS.resumeOnTruncation, description: '输出在 max-tokens 处被截断时是否自动续跑。' },
    probeUrls: { type: 'array', items: { type: 'string' }, default: DEFAULTS.probeUrls, description: '连通性探测目标，按顺序尝试；换成你自己的网关更可靠。' },
    probeTimeoutMs: { type: 'number', default: DEFAULTS.probeTimeoutMs, description: '单次探测超时（毫秒）。' },
    probeRetries: { type: 'number', default: DEFAULTS.probeRetries, description: '一轮探测的重试次数（断网瞬间第一两次通常失败）。' },
    probeBackoffMs: { type: 'number', default: DEFAULTS.probeBackoffMs, description: '重试退避基数（毫秒），指数递增到 probeBackoffMaxMs。' },
    probeBackoffMaxMs: { type: 'number', default: DEFAULTS.probeBackoffMaxMs, description: '重试退避上限（毫秒）。' },
    minResumeGapMs: { type: 'number', default: DEFAULTS.minResumeGapMs, description: '同一会话两次自动续跑之间的最小间隔（毫秒）。' },
    pill: { type: 'boolean', default: DEFAULTS.pill, description: '是否给按钮画胶囊底/描边；关掉就是一颗朴素按钮。' },
    showReason: { type: 'boolean', default: DEFAULTS.showReason, description: '中断原因写进按钮提示文案（hover 标题）里。' },
    verbose: { type: 'boolean', default: DEFAULTS.verbose, description: '把每次判定与续跑写进宿主日志，排查“为什么没自动继续”时打开。' },
    startupResume: { type: 'boolean', default: DEFAULTS.startupResume, description: '宿主重启后，扫描最近的会话日志，把「进程中途退出」而没跑完的会话自动接上。' },
    startupResumeWithinMs: { type: 'number', default: DEFAULTS.startupResumeWithinMs, description: '启动扫描往前看多久（毫秒，默认 24 小时）。' },
    startupResumeLimit: { type: 'number', default: DEFAULTS.startupResumeLimit, description: '一次启动最多自动接上几个会话（按最后活动时间从新到旧）。' },
  },
};

// ── interruption classification ─────────────────────────────────────────────

/**
 * Machine code for one failed turn, or `null` when the event is not an
 * interruption (a normally completed turn).
 *
 * The codes are the plugin's own contract with the Client and with
 * {@link RESUME_NOTE}. Two of them decide whether an auto-resume is allowed at
 * all: `network.*` and `upstream.truncated` may auto-fire, `error` only with
 * `autoResumeOnError`, and `upstream.context-window` never — an overflow needs
 * compaction, and firing 继续 at it just overflows again.
 */
export function classifyInterrupt(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return null;
  const type = event?.type;

  if (type === 'turn/end') {
    const reason = data.reason;
    const kind = typeof reason?.kind === 'string' ? reason.kind : undefined;
    // `completed` is a normal end; `cancelled`/`stop` is a human pressing stop,
    // and a running `goal` end is the driver's own business. None are ours.
    if (kind === undefined || kind === 'completed' || kind === 'cancelled' || kind === 'stop') return null;
    // WHO ended the turn decides whether it is ours to retry. The observed shapes
    // are `{"kind":"aborted","reason":{"kind":"user"}}` (a person pressed stop),
    // `...{"kind":"parent"}` (the driving parent went away) and
    // `...{"kind":"disposed"}` (the agent was torn down — a session was closed).
    // All three are deliberate, so none is a failure to retry: resuming them
    // would fight the human, and with `autoResumeOnError: true` it would fight
    // them on every single stop.
    const by = typeof reason?.reason?.kind === 'string' ? reason.reason.kind : undefined;
    if (kind === 'aborted' && (by === 'user' || by === 'parent' || by === 'disposed')) return null;
    if (kind === 'error') {
      const code = errorCodeOf(reason?.error ?? data.error ?? data.message?.error);
      return code === 'CONTEXT_WINDOW_EXCEEDED' ? 'upstream.context-window' : 'error';
    }
    // A length stop reaches this branch too — the harness records
    // `{"kind":"max-tokens"}` as a *turn/end* reason, not only as an
    // `assistant/message` finish chunk. Falling through to `upstream.aborted`
    // asked for `autoResumeOnError`, so with the default settings a truncated
    // turn never auto-resumed even though `resumeOnTruncation` was on: the
    // setting silently did nothing.
    if (kind === 'max-tokens' || kind === 'length') return 'upstream.truncated';
    return 'upstream.aborted';
  }

  if (type === 'assistant/message') {
    // A length stop is not an error — the request succeeded and the provider
    // simply stopped. Shape borrowed from dsh-command-context-trim's proven
    // reader: normalised `reason.kind`, or the raw adapter's `stopReason`.
    for (const entry of data.stream ?? []) {
      const chunk = entry?.chunk;
      if (chunk?.type !== 'finish') continue;
      if (chunk?.reason?.kind === 'max-tokens') return 'upstream.truncated';
      if (chunk?.reason?.kind === 'error') {
        const code = errorCodeOf(chunk.reason.error ?? chunk.error);
        return code === 'CONTEXT_WINDOW_EXCEEDED' ? 'upstream.context-window' : 'error';
      }
      if (chunk?.replayState?.response?.stopReason === 'length') return 'upstream.truncated';
    }
    return null;
  }

  // agent/error mirror: the harness records the request failure itself.
  if (type === 'agent/error' || data.kind === 'request-error') {
    const code = errorCodeOf(data.error ?? data.failure ?? data);
    return code === 'CONTEXT_WINDOW_EXCEEDED' ? 'upstream.context-window' : 'error';
  }
  return null;
}

/** Codes that mean "the wire broke", as opposed to "the account/model refused". */
const NETWORK_CODES = new Set(['TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE', 'SERVER', 'NETWORK', 'CONNECTION']);
/** Codes that must never be treated as a recoverable network fault. */
const REFUSAL_CODES = new Set([
  'AUTH', 'QUOTA', 'QUOTA_EXCEEDED', 'ACCOUNT_QUOTA', 'PERMISSION_DENIED',
  'MISSING_CREDENTIAL', 'INVALID_REQUEST', 'NOT_FOUND', 'ABORTED',
]);
/** Lower-cased fragments of transport failures in messages and raw codes. */
const NETWORK_TEXT = [
  'fetch failed', 'econnrefused', 'econnreset', 'etimedout', 'enotfound', 'eai_again',
  'epipe', 'econnaborted', 'socket hang up', 'network', 'tls', 'ssl', 'certificate',
  'proxy', 'dns', 'stream idle', 'idle timeout', 'premature close', 'terminated',
  'connection closed', 'connection reset', 'client is disposed', 'upstream connect error',
  'could not connect', 'unable to connect', 'connection refused', 'no connection',
  'networkerror', 'err_http', 'http_499', 'request aborted by network',
];

/**
 * A transport-flavoured error, and therefore worth an auto-resume.
 *
 * ⚠️ Deliberately conservative: refusal codes veto first, so an expired session
 * or an empty quota never burns retries. An HTTP 4xx is likewise the server
 * ANSWERING — no amount of waiting fixes an expired token — so it can never be a
 * transport fault even when the body mentions "network". An *unclassified*
 * message with no code at all counts as transport: that is what
 * `TypeError: fetch failed` looks like with no cause, which is the most common
 * real-world "network dropped".
 */
export function isTransportError(info) {
  if (!info) return false;
  const code = String(info.code ?? '').toUpperCase();
  if (REFUSAL_CODES.has(code)) return false;
  const status = Number(info.status);
  if (Number.isFinite(status) && status >= 400 && status < 500) return false;
  if (NETWORK_CODES.has(code)) return true;
  if (Number.isFinite(status) && status >= 500 && status < 600) return true;
  const text = errorText(info).toLowerCase();
  if (text === '') return code === '';
  return NETWORK_TEXT.some((needle) => text.includes(needle));
}

/** Best-effort error record from whatever shape the event carried. */
export function errorRecordOf(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Error) {
    return { message: value.message, code: typeof value.code === 'string' ? value.code : undefined, status: Number(value.status) || undefined };
  }
  if (typeof value !== 'object') return null;
  const nested = value.error && typeof value.error === 'object' ? value.error : undefined;
  const message =
    typeof value.message === 'string' ? value.message
      : typeof value.msg === 'string' ? value.msg
        : typeof nested?.message === 'string' ? nested.message
          : undefined;
  const rawCode = value.code ?? value.error_code ?? value.errorCode ?? nested?.code ?? value.type;
  const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : typeof rawCode === 'number' ? String(rawCode) : undefined;
  const status = Number(value.status ?? value.statusCode ?? value.response?.status ?? value.responseStatus);
  return {
    message,
    code,
    status: Number.isFinite(status) ? status : undefined,
    text: message ?? code ?? undefined,
  };
}

function errorText(info) {
  if (typeof info?.message === 'string') return info.message;
  if (typeof info?.text === 'string') return info.text;
  return '';
}

function errorCodeOf(value) {
  const record = errorRecordOf(value);
  return record?.code ? String(record.code).toUpperCase() : undefined;
}

/**
 * The failure carried by one event: structured first, then a keyword scan over
 * the serialised tail — adapters disagree about where the reason goes and a
 * dead stream often shows up as nothing but prose.
 */
export function extractFailure(event) {
  const data = event?.data ?? {};
  const direct = [
    data.reason?.error, data.error, data.failure, data.message?.error, data.message?.failure,
  ];
  for (const candidate of direct) {
    const record = errorRecordOf(candidate);
    if (record && (record.message || record.code)) return record;
  }
  let blob = '';
  try {
    blob = JSON.stringify(data)?.slice(-1800) ?? '';
  } catch {
    blob = '';
  }
  if (blob === '') return null;
  const lower = blob.toLowerCase();
  if (NETWORK_TEXT.some((needle) => lower.includes(needle))) {
    const found = /"(?:message|msg|error)"\s*:\s*"([^"]{1,200})"/.exec(blob);
    return { message: found?.[1] ?? 'transport failure', code: 'NETWORK' };
  }
  return null;
}

/** Finish-reason reader for `assistant/message`; `max-tokens` means a length stop. */
export function stopReasonOf(event) {
  for (const entry of event?.data?.stream ?? []) {
    const chunk = entry?.chunk;
    if (chunk?.type !== 'finish') continue;
    if (chunk?.reason?.kind === 'max-tokens') return 'max-tokens';
    if (chunk?.replayState?.response?.stopReason === 'length') return 'max-tokens';
  }
  return undefined;
}

// ── per-session state ───────────────────────────────────────────────────────

/**
 * Source kinds that count as a genuine intervention — someone actually spoke
 * for the model. Mirrors dsh-providers-hub's proven whitelist (its loop-recovery
 * comment walks the real词表 and why auto-injected notices are excluded): a
 * plugin that injects a notice every step would otherwise reset the resume
 * budget endlessly and make the cap meaningless.
 *
 * `undefined` is treated as intervention: an absent kind in practice means the
 * host's own direct user input, the strongest case.
 */
const INTERVENTION_SOURCE_KINDS = new Set([
  'user', 'goal', 'agent-message', 'subagent-settled', 'subagent-report', 'user-approval',
]);

/**
 * How often open episodes are re-examined. The probe itself retries inside a
 * pass, so this only bounds how long a recovered link stays unnoticed — small
 * enough to feel automatic, large enough to be free while genuinely offline.
 */
const SWEEP_INTERVAL_MS = 10000;

function sessionIdOf(session) {
  if (typeof session === 'string') return session;
  const id = session?.id ?? session?.sessionId;
  return id === undefined || id === null ? undefined : String(id);
}

/** Live agents from the registry, tolerating an absent or throwing `list()`. */
function listAgents(scope) {
  try {
    const list = scope?.agents?.list?.();
    return Array.isArray(list) ? list.filter((agent) => agent !== null && agent !== undefined) : [];
  } catch {
    return [];
  }
}

/**
 * Inbox emptiness, read through the declared contract only.
 * `hasPending` is a loop-implementation detail; the public `Inbox` shape is the
 * two arrays (same equivalence dsh-providers-hub uses).
 */
function inboxHasPending(inbox) {
  if (!inbox || typeof inbox !== 'object') return false;
  const nextTurn = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0;
  const nextStep = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0;
  if (nextTurn + nextStep > 0) return true;
  return typeof inbox.hasPending === 'boolean' ? inbox.hasPending : false;
}

// ── connectivity probe ──────────────────────────────────────────────────────

/**
 * One reachability pass over the probe targets.
 *
 * `AbortSignal.timeout` is the whole point: without it a black-holed TCP
 * connection hangs on the OS timeout (~21 s on Windows) and the plugin looks
 * frozen. Attempts back off exponentially, because the first try after a drop
 * usually fails for a second or two even when the link is back.
 */
export async function probeOnce(options) {
  const urls = options.urls ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULTS.probeTimeoutMs;
  const retries = Math.max(1, options.retries ?? 1);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const backoff = Math.max(50, options.backoffMs ?? DEFAULTS.probeBackoffMs);
  const backoffMax = Math.max(backoff, options.backoffMaxMs ?? DEFAULTS.probeBackoffMaxMs);
  const startedAt = now();
  let attempts = 0;
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    for (const url of urls) {
      attempts += 1;
      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          signal: AbortSignal.timeout(timeoutMs),
        });
        // 4xx still proves the wire works — the failure would have thrown.
        if (typeof response.status === 'number') return { ok: true, url, status: response.status, attempts, ms: now() - startedAt };
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt + 1 < retries) {
      await sleep(Math.min(backoffMax, backoff * 2 ** attempt));
    }
  }
  return {
    ok: false,
    attempts,
    ms: now() - startedAt,
    lastError: errorRecordOf(lastError) ?? (lastError ? { message: String(lastError?.message ?? lastError) } : undefined),
  };
}

/**
 * Watchdog for a pass that outlives its own budget (a stalled DNS lookup is not
 * always interruptible). `watchProbe` resolves to a failure object when that
 * happens, so a hung probe never takes the resume timer down with it.
 */
export function watchProbe(pass, extraMs, now = Date.now) {
  const budget = Math.max(0, extraMs ?? 0);
  const ceiling = budget + 1500;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, timeout: true, attempts: 0, ms: now() - budget }), ceiling);
    pass.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); resolve({ ok: false, error: String(error?.message ?? error), attempts: 0, ms: 0 }); },
    );
  });
}

export function probeBudgetMs(config) {
  const targets = Math.max(1, config.probeUrls.length);
  const backoff = Math.max(50, config.probeBackoffMs);
  let backoffTotal = 0;
  for (let attempt = 0; attempt < Math.max(1, config.probeRetries); attempt += 1) {
    backoffTotal += Math.min(config.probeBackoffMaxMs, backoff * 2 ** attempt);
  }
  return config.probeRetries * targets * config.probeTimeoutMs + backoffTotal + 2000;
}

/**
 * The resume decision core. No cordis, no timers it owns, no transport: every
 * external action arrives through injected callbacks, so the whole state machine
 * is testable against a virtual clock.
 *
 * Safety rules, each traceable to a line of code:
 *  - one episode, one verdict: a second failure inside the same turn is ignored
 *    while `episodeSeq` still matches;
 *  - a genuine intervention (human or goal input) clears the episode *and* the
 *    budget, so a person taking over always refills the auto-resume allowance;
 *  - auto-resume requires: `autoResume` on, the reason allowed, budget left, no
 *    pending inbox, agent idle, network up, and the gap since the last resume;
 *  - the probe runs *before* the delay is armed, so the countdown the UI shows
 *    starts from a link that was just proven alive;
 *  - a failed probe is retried by `sweep()` on the host's timer, because a link
 *    that comes back emits no event anywhere — parking on a "recovered" edge
 *    would wait forever.
 */
// ── startup recovery: rebuild a lost episode from the session log ────────────
//
// Why this exists: every other resume path in this plugin needs a live agent.
// When the process dies mid-turn there is no agent, no in-memory episode and no
// event — so after a restart nothing would ever notice the unfinished work. The
// only surviving evidence is the session log on disk, and the only reliable
// signature is a turn that was never closed. (The harness reaches the same
// conclusion from `interruptedTurnClosers` in dsh-session, which appends
// synthetic `interrupted` closers when `agents.resume` reopens such a log.)

/** zstd frame magic. Logs are appended as whole frames, so the newest events are in the LAST frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Log file names, newest format first — the same list dsh-archived-digest reads. */
export const SESSION_LOG_NAMES = Object.freeze(['session.jsonl.zstd', 'session.v4.jsonl.zstd']);

/** Every offset where a zstd frame could start. */
function magicOffsets(buf) {
  const offsets = [];
  let at = buf.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + 4);
  }
  return offsets;
}

/**
 * Decode the tail of a multi-frame zstd session log.
 *
 * Reading backwards from the newest frame is what keeps this cheap: a 3 MB log
 * is thousands of frames, but the answer usually sits in the last one or two.
 * Decoding stops at the first turn boundary, because that boundary is the
 * question being asked — anything older cannot change the verdict.
 *
 * A magic-byte match inside a compressed payload is a false positive, so each
 * slice is decoded and validated, widening the window on failure. A bad slice
 * must never swallow the boundary that precedes a real frame.
 *
 * @returns raw JSONL text of the tail, or '' when unreadable.
 */
export function decodeZstdTail(buf, options = {}) {
  const minLines = Number.isFinite(options.minLines) ? options.minLines : 4;
  const maxFrames = Number.isFinite(options.maxFrames) ? options.maxFrames : 64;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  if (buf.indexOf(ZSTD_MAGIC) === -1) return '';
  const offsets = magicOffsets(buf);
  const parts = [];
  let lines = 0;
  let frames = 0;
  for (let i = offsets.length - 1; i >= 0 && frames < maxFrames; i -= 1) {
    const start = offsets[i];
    let decoded = null;
    for (let j = i + 1; j <= offsets.length; j += 1) {
      const stop = j < offsets.length ? offsets[j] : buf.length;
      if (stop <= start) continue;
      try {
        decoded = zstdDecompressSync(buf.subarray(start, stop)).toString('utf8');
        break;
      } catch {
        /* false positive or truncated frame: widen the window */
      }
    }
    if (decoded === null) break;
    parts.unshift(decoded);
    frames += 1;
    lines += decoded.split('\n').filter((line) => line.trim() !== '').length;
    if (lines < minLines) continue;
    const accumulated = parts.join('');
    if (accumulated.includes('"turn/start"') || accumulated.includes('"turn/end"')) break;
  }
  return parts.join('');
}

/** Read + decode one session log's tail. Never throws: recovery must not break boot. */
export function readSessionLogTail(file, options = {}) {
  try {
    return decodeZstdTail(readFileSync(file), options);
  } catch {
    return '';
  }
}

/** Parse JSONL defensively: a bad line is skipped, never fatal. */
export function parseLogLines(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') events.push(parsed);
    } catch {
      /* a torn final line is expected on a crashed writer */
    }
  }
  return events;
}

/** Where sessions live: `$DSH_HOME`, else `~/.dsh`. */
export function resolveSessionHome(env = process.env) {
  const fromEnv = env !== null && env !== undefined && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (fromEnv !== '') return fromEnv;
  try {
    return join(homedir(), '.dsh');
  } catch {
    return null;
  }
}

/**
 * Session logs touched inside the window, newest first.
 *
 * Sorted by last activity because the caller caps how many it will wake, and the
 * most recently interrupted session is the one the person is waiting on.
 */
export function listRecentSessionLogs(home, options = {}) {
  const withinMs = Number.isFinite(options.withinMs) ? options.withinMs : DEFAULTS.startupResumeWithinMs;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const found = [];
  if (typeof home !== 'string' || home === '') return found;
  let projects;
  try {
    projects = readdirSync(join(home, 'sessions'), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(home, 'sessions', project.name);
    let sessions;
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dir = join(projectDir, session.name);
      // The names are alternatives for one log, so the first that exists wins.
      let hit = null;
      for (const name of SESSION_LOG_NAMES) {
        try {
          const stat = statSync(join(dir, name));
          if (stat.isFile()) {
            hit = { file: join(dir, name), mtimeMs: stat.mtimeMs };
            break;
          }
        } catch {
          /* try the next name */
        }
      }
      if (hit === null) continue;
      if (now - hit.mtimeMs > withinMs) continue;
      found.push({ sessionId: session.name, project: project.name, ...hit });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Decide whether one session's log ended in an interruption worth resuming.
 *
 * Pure, so the whole rule set is testable without a filesystem or a host.
 * `null` means "leave it alone": a completed turn, a turn a person stopped, a
 * deliberate teardown, or a log that never ran a turn.
 *
 * @returns `{ reason, event }` where `reason` is a classifyInterrupt code, or
 *   `'process.exit'` for an unclosed turn.
 */
export function classifyRecovery(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let lastStart = -1;
  let lastEnd = -1;
  for (let i = 0; i < events.length; i += 1) {
    const type = events[i]?.type;
    if (type === 'turn/start') lastStart = i;
    else if (type === 'turn/end') lastEnd = i;
  }
  // A turn that opened and never closed is the signature of a process that died
  // while it was still running. This is exactly the condition the harness calls
  // `interrupted` when it repairs the log on resume.
  if (lastStart > lastEnd) return { reason: 'process.exit', event: events[lastStart] };
  if (lastEnd === -1) return null;
  const reason = classifyInterrupt(events[lastEnd]);
  if (reason === null) return null;
  // A transport failure is the case this scan exists for: "the session died
  // because the link died" has to resume once the link is back, with no extra
  // opt-in. classifyInterrupt reports a generic `error` for every failure
  // because the LIVE path must stay conservative — there, an unclassified error
  // may be an exhausted quota, and retrying that burns money. The log carries
  // the raw error, so a wire failure can be told apart from a refusal and mapped
  // onto the probe-gated `network.down`, which waits for the link instead of
  // firing blind.
  if (reason === 'error') {
    const raw = events[lastEnd]?.data;
    const record = errorRecordOf(raw?.reason?.error ?? raw?.error ?? raw?.message?.error);
    if (isTransportError(record)) return { reason: 'network.down', event: events[lastEnd] };
  }
  return { reason, event: events[lastEnd] };
}

/**
 * Run the startup scan and feed each interrupted session into the scheduler.
 *
 * Every dependency is injectable so the whole path is testable: `listLogs`,
 * `readTail`, `resolveAgent` and `wake` are replaced in tests, and the real ones
 * read the disk and call `agents.resume`.
 *
 * @returns a summary of what was seen and done, for the log line and the tests.
 */
export async function recoverInterruptedSessions(deps = {}) {
  const config = deps.config ?? DEFAULTS;
  const core = deps.core;
  const log = deps.log;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const listLogs = deps.listLogs ?? listRecentSessionLogs;
  const readTail = deps.readTail ?? readSessionLogTail;
  const resolveAgent = deps.resolveAgent ?? (() => undefined);
  const wake = deps.wake;
  const summary = { scanned: 0, resumed: 0, woken: 0, skipped: [] };
  if (core === undefined || core === null) return summary;
  // Startup recovery is an automatic resume, so it obeys the auto-resume switch.
  if (config.startupResume !== true || config.autoResume !== true) return summary;
  const home = deps.home !== undefined ? deps.home : resolveSessionHome(deps.env);
  if (typeof home !== 'string' || home === '') {
    summary.skipped.push('no-home');
    return summary;
  }
  const limit = Math.max(0, Number(config.startupResumeLimit) || 0);
  const logs = listLogs(home, { withinMs: config.startupResumeWithinMs, now: now() });
  summary.scanned = logs.length;
  for (const entry of logs) {
    if (summary.resumed >= limit) break;
    const agent = resolveAgent(entry.sessionId);
    // Someone is already driving this session — the GUI may have reopened it
    // first, and racing that would start a second turn in the same log.
    if (agent !== undefined && agent !== null && String(agent.status ?? '').toLowerCase() === 'running') {
      summary.skipped.push(entry.sessionId);
      continue;
    }
    let verdict = null;
    try {
      verdict = classifyRecovery(parseLogLines(readTail(entry.file, { minLines: 4 })));
    } catch {
      verdict = null;
    }
    if (verdict === null) continue;
    summary.resumed += 1;
    // Seed the episode BEFORE waking: the delay, budget, probe and gap rules are
    // already implemented there, so recovery reuses them instead of inventing a
    // second, subtly different send path.
    core.observeInterrupt(entry.sessionId, verdict.reason, {
      recovered: true,
      fromLog: entry.project,
      at: entry.mtimeMs,
    }, undefined);
    if (log !== undefined && (config.verbose === true || verdict.reason === 'process.exit')) {
      log.info(`${NS}: 启动恢复 ${entry.sessionId}（${verdict.reason}，最后活动 ${new Date(entry.mtimeMs).toISOString()}）`);
    }
    if (agent !== undefined && agent !== null) continue;
    if (typeof wake !== 'function') continue;
    try {
      await wake(entry.sessionId);
      summary.woken += 1;
    } catch (error) {
      // A session that cannot be reopened still keeps its seeded episode, so
      // opening it by hand later still resumes it.
      summary.skipped.push(entry.sessionId);
      if (log !== undefined) log.info(`${NS}: 无法唤醒 ${entry.sessionId}：${error?.message ?? error}`);
    }
  }
  return summary;
}

export class LoopResumeScheduler {
  constructor(options) {
    this.config = options.config;
    this.probe = options.probe;
    this.deliver = options.deliver;
    this.now = options.now ?? Date.now;
    /**
     * Timer triple, injectable so the state machine is testable against a virtual
     * clock. Production passes nothing and gets the globals.
     */
    this.setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle));
    this.log = options.log ?? { info() {}, warn() {} };
    /** @type {(id: string) => any} */
    this.resolveAgent = options.resolveAgent;
    this.sessions = new Map();
    this.pending = new Set();
    this.disposed = false;
    this.networkDown = false;
    this.lastProbe = null;
    /** In-flight probe pass shared by every session (see `runProbe`). */
    this.probePass = undefined;
  }

  state(sessionId) {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        stopped: false, reason: null, detail: null, episodeSeq: null,
        attempts: 0, armed: false, resumeAt: 0, probing: false, lastResumeAt: 0,
        lastError: null, timer: null,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** `turn/end` / `assistant/message` / `agent/error` for one session. */
  observeInterrupt(sessionId, reason, detail, seq) {
    if (this.disposed) return;
    const state = this.state(sessionId);
    if (state.episodeSeq !== null && seq !== undefined && seq === state.episodeSeq) return;
    state.stopped = true;
    state.reason = reason;
    state.detail = detail ?? null;
    state.episodeSeq = seq ?? null;
    state.armed = false;
    if (state.timer !== null) { this.clearTimeout(state.timer); state.timer = null; }
    if (this.config.verbose) this.log.info(`${NS}: ${sessionId} 记录中断 ${reason}${detail?.message ? `（${detail.message}）` : ''}`);
    this.evaluate(sessionId, 'interrupt');
  }

  /** A message entered one session's inbox: decide intervention vs our own echo. */
  observeInput(sessionId, message) {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    // Our own resume, arriving back through the inbox: neither an intervention
    // nor a new episode. Recognised by source kind, not message id, so it still
    // holds across a replay or a restart (ids are process-local, kinds are durable).
    if (message?.source?.kind === SOURCE_KIND) return;
    const kind = message?.source?.kind;
    if (kind !== undefined && !INTERVENTION_SOURCE_KINDS.has(kind)) return;
    this.clearEpisode(sessionId, 'intervention');
    // A person taking over resets BOTH limits: the retry budget (a fresh episode
    // deserves a fresh allowance) and the minimum-gap floor. The floor exists to
    // stop the plugin firing twice at one broken link; once a human has spoken,
    // the next failure is a new episode and must not inherit that suspicion.
    state.attempts = 0;
    state.lastResumeAt = 0;
  }

  clearEpisode(sessionId, why) {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    if (!state.stopped && !state.armed) return;
    if (state.timer !== null) this.clearTimeout(state.timer);
    state.stopped = false;
    state.armed = false;
    state.timer = null;
    state.episodeSeq = null;
    state.reason = null;
    state.detail = null;
    if (this.config.verbose) this.log.info(`${NS}: ${sessionId} 中断episode结束（${why}）`);
  }

  /** Agent went idle: the only moment a followup can actually wake the loop. */
  observeIdle(sessionId) {
    this.evaluate(sessionId, 'idle');
  }

  /** `navigator.onLine` edge from the Client half. */
  observeNetworkHint(sessionId, down) {
    const state = this.sessions.get(sessionId);
    if (state === undefined || !state.stopped) return;
    if (!down) this.onNetworkRecovered('browser');
    else if (!this.networkDown) this.networkDown = true;
  }

  onNetworkDown(source) {
    if (this.networkDown) return;
    this.networkDown = true;
    this.log.info(`${NS}: 网络中断（${source}），自动续跑挂起`);
  }

  onNetworkRecovered(source) {
    if (!this.networkDown) return;
    this.networkDown = false;
    this.lastProbe = { at: this.now(), ok: true, via: source };
    if (this.config.autoResume) {
      for (const sessionId of [...this.sessions.keys()]) {
        this.evaluate(sessionId, `recovered:${source}`);
      }
    }
  }

  /**
   * Manual click. A person asked, so it skips the budget, the delay and the
   * "did we actually detect an interruption" test — with no episode on record
   * the bare word is still exactly what the user would have typed. Only the
   * conditions that make delivery possible at all survive (a live agent).
   */
  async resumeNow(sessionId) {
    const state = this.state(sessionId);
    if (state.timer !== null) { this.clearTimeout(state.timer); state.timer = null; }
    state.armed = false;
    return this.deliverResume(sessionId, 'manual');
  }

  evaluate(sessionId, trigger) {
    const config = this.config;
    const state = this.state(sessionId);
    if (this.disposed || !state.stopped || state.armed || state.probing) return;
    if (!config.autoResume) return;
    if (!this.reasonAllowed(state.reason)) return;
    if (state.attempts >= config.maxAutoResumes) return;
    const agent = this.resolveAgent(sessionId);
    if (agent === undefined || agent === null) return;
    if (String(agent.status ?? '').toLowerCase() !== 'idle') return;
    if (inboxHasPending(agent.inbox)) return;
    const elapsed = this.now() - state.lastResumeAt;
    if (state.lastResumeAt > 0 && elapsed < config.minResumeGapMs) return;

    // The probe result — not the `networkDown` flag — is the gate. A failed pass
    // must NOT park the episode waiting for a recovery edge: a link that dropped
    // usually comes back with no event anywhere (nobody tells a Node process or
    // the harness's loop that the internet is back), so `sweep()` re-probes on a
    // timer. A browser `online` hint stamps `lastProbe.ok`, which short-circuits
    // the wait and arms immediately.
    if (!this.lastProbeFresh()) {
      void this.runProbe(sessionId);
      return;
    }
    this.arm(sessionId, config.resumeDelayMs, trigger);
  }

  /**
   * Periodic re-examination of every open episode — the retry edge for a failed
   * probe, driven by a host timer. Returns how many episodes it looked at, so a
   * test can assert the sweep really ran (a silent no-op sweep is exactly the
   * bug this fixes).
   */
  sweep() {
    if (this.disposed) return 0;
    let examined = 0;
    for (const sessionId of [...this.sessions.keys()]) {
      const state = this.sessions.get(sessionId);
      if (state === undefined || !state.stopped || state.armed) continue;
      if (!this.reasonAllowed(state.reason)) continue;
      if (state.attempts >= this.config.maxAutoResumes) continue;
      if (this.resolveAgent(sessionId) == null) continue;
      examined += 1;
      this.evaluate(sessionId, 'sweep');
    }
    return examined;
  }

  reasonAllowed(reason) {
    if (reason === null || reason === undefined) return false;
    if (reason === 'upstream.context-window') return false;
    if (reason.startsWith('network.')) return true;
    if (reason === 'upstream.truncated') return this.config.resumeOnTruncation;
    if (reason === 'error') return this.config.autoResumeOnError;
    if (reason === 'upstream.aborted') return this.config.autoResumeOnError;
    // Produced only by the startup scan, so `startupResume` is its own switch:
    // someone who wants crash recovery but not error-retry storms gets exactly
    // that, with no extra knob.
    if (reason === 'process.exit') return this.config.startupResume;
    return false;
  }

  lastProbeFresh() {
    const probe = this.lastProbe;
    return probe !== null && probe !== undefined && probe.ok === true && this.now() - probe.at < 15000;
  }

  async runProbe(sessionId) {
    const state = this.state(sessionId);
    if (state.probing) return;
    state.probing = true;
    try {
      // One pass serves the whole plugin: several stopped sessions must not fan
      // out into several simultaneous probes of the same dead link.
      if (this.probePass === undefined) {
        this.probePass = watchProbe(Promise.resolve().then(() => this.probe()), probeBudgetMs(this.config), this.now);
      }
      const pass = this.probePass;
      const result = await pass;
      if (this.probePass === pass) this.probePass = undefined;
      this.lastProbe = { at: this.now(), ok: result.ok === true, attempts: result.attempts, via: 'probe' };
      if (result.ok === true) {
        // `networkDown` before this line IS the previous state: log only the edge.
        if (this.networkDown) this.log.info(`${NS}: 网络已恢复（探针 ${result.url ?? ''}）`);
        this.networkDown = false;
        if (this.sessions.get(sessionId) === state && state.stopped) {
          this.arm(sessionId, this.config.resumeDelayMs, 'probed');
        }
        return;
      }
      this.networkDown = true;
      if (state.stopped) {
        state.lastError = { at: this.now(), message: '连通性探测失败，等网络恢复后自动重试' };
        if (this.config.verbose) {
          this.log.info(`${NS}: ${sessionId} 探测失败（${result.attempts ?? 0} 次尝试），稍后由巡检重试`);
        }
      }
    } finally {
      state.probing = false;
    }
  }

  arm(sessionId, delayMs, trigger) {
    const state = this.state(sessionId);
    if (this.disposed || state.armed || !state.stopped) return;
    state.armed = true;
    state.resumeAt = this.now() + delayMs;
    state.lastError = null;
    if (state.timer !== null) this.clearTimeout(state.timer);
    state.timer = this.setTimeout(() => {
      state.timer = null;
      state.armed = false;
      void this.deliverResume(sessionId, trigger);
    }, Math.max(0, delayMs));
    if (this.config.verbose) this.log.info(`${NS}: ${sessionId} 将在 ${delayMs}ms 后自动续跑（${trigger}）`);
  }

  async deliverResume(sessionId, trigger) {
    const config = this.config;
    const state = this.state(sessionId);
    if (this.disposed) return { ok: false, status: 'disposed', sessionId };
    // A manual click with no episode on record is legitimate: it sends the bare
    // word. An *automatic* send with no episode has nothing to resume.
    if (!state.stopped && trigger !== 'manual') return { ok: false, status: 'not-stopped', sessionId };
    // The armed timer and a manual click can collide on the same session; the
    // in-flight marker makes the second one a no-op instead of a double send.
    if (this.pending.has(sessionId)) return { ok: false, status: 'in-flight', sessionId };
    const agent = this.resolveAgent(sessionId);
    if (agent === undefined || agent === null) {
      state.lastError = { at: this.now(), message: '这个会话当前没有运行的 Agent，请在界面里重新打开它' };
      return { ok: false, status: 'no-agent', sessionId, reason: state.reason };
    }
    if (trigger !== 'manual') {
      if (String(agent.status ?? '').toLowerCase() !== 'idle') {
        state.armed = false;
        return { ok: false, status: 'busy', sessionId };
      }
      if (inboxHasPending(agent.inbox)) {
        state.armed = false;
        return { ok: false, status: 'inbox-busy', sessionId };
      }
      if (state.attempts >= config.maxAutoResumes) {
        state.lastError = { at: this.now(), message: `自动续跑已达上限（${config.maxAutoResumes} 次），请手动点「继续」` };
        this.log.warn(`${NS}: ${sessionId} 自动续跑达到上限 ${config.maxAutoResumes} 次，停止自动重试`);
        return { ok: false, status: 'budget', sessionId };
      }
      if (!this.lastProbeFresh()) {
        state.armed = false;
        void this.runProbe(sessionId);
        return { ok: false, status: 'offline', sessionId };
      }
    }    // Manual sends are the user's own clicks: they must not eat the auto budget.
    const counted = trigger !== 'manual';
    if (counted) state.attempts += 1;
    state.lastResumeAt = this.now();
    const text = composeResumeText(state.reason, config.text);
    this.pending.add(sessionId);
    try {
      await this.deliver(agent, text, { auto: counted, attempt: state.attempts });
    } catch (error) {
      if (counted) state.attempts = Math.max(0, state.attempts - 1);
      state.lastError = { at: this.now(), message: String(error?.message ?? error) };
      this.log.warn(`${NS}: ${sessionId} 续跑发送失败：${state.lastError.message}`);
      return { ok: false, status: 'send-failed', sessionId, error: state.lastError.message };
    } finally {
      this.pending.delete(sessionId);
    }
    // Optimistic: the next turn/start clears the episode. If the loop never
    // woke, the idle re-evaluation arms again within the budget.
    if (this.config.verbose || trigger === 'manual') {
      this.log.info(`${NS}: ${sessionId} 已发送「${config.text}」（${trigger}${counted ? `，第 ${state.attempts} 次` : ''}）`);
    }
    return { ok: true, status: 'sent', sessionId, reason: state.reason, attempt: state.attempts, trigger, text };
  }

  snapshot(sessionId) {
    const state = this.sessions.get(sessionId);
    const config = this.config;
    return {
      sessionId,
      stopped: state?.stopped ?? false,
      reason: state?.reason ?? null,
      detail: state?.detail ?? null,
      resumable: (state?.stopped ?? false) || (state?.attempts ?? 0) > 0,
      armed: state?.armed ?? false,
      resumeAt: state?.armed ? state.resumeAt : 0,
      networkDown: this.networkDown,
      probing: state?.probing ?? false,
      inFlight: this.pending.has(sessionId),
      attempts: state?.attempts ?? 0,
      maxAutoResumes: config.maxAutoResumes,
      autoResume: config.autoResume,
      autoAllowed: config.autoResume && this.reasonAllowed(state?.reason ?? null),
      text: config.text,
      pill: config.pill,
      showReason: config.showReason,
      lastError: state?.lastError ?? null,
      hasAgent: this.resolveAgent(sessionId) != null,
      now: this.now(),
    };
  }

  /**
   * Accept an externally measured probe result (`/probe` route), so an explicit
   * connectivity check counts as evidence for the next sweep instead of being
   * thrown away.
   */
  recordProbe(result) {
    this.lastProbe = { at: this.now(), ok: result?.ok === true, attempts: result?.attempts, via: 'api' };
    if (result?.ok === true) {
      if (this.networkDown) this.log.info(`${NS}: 网络已恢复（手动探测）`);
      this.networkDown = false;
    } else {
      this.networkDown = true;
    }
  }

  dispose() {
    this.disposed = true;
    for (const state of this.sessions.values()) {
      if (state.timer !== null) this.clearTimeout(state.timer);
    }
    this.sessions.clear();
    this.pending.clear();
  }
}

/**
 * Resume text. The manual click sends the bare word so the transcript looks
 * exactly like a human typing 继续; an auto-resume adds one sentence naming the
 * cause, because the model cannot see the failure and otherwise repeats the
 * exact request that just broke.
 */
export function composeResumeText(reason, text) {
  const body = str(text, DEFAULT_TEXT);
  if (reason === null || reason === undefined) return body;
  const note = RESUME_NOTE[reason];
  return note === undefined || note === '' ? body : `${body}（${note}）`;
}

// ── live agent index ────────────────────────────────────────────────────────

/**
 * session id → live agent, from `agent/created` / `agent/disposed`.
 *
 * The registry is a cache: every read re-checks `session.id`, because a disposed
 * agent can linger in a map if a lifecycle event is missed, and a stale handle
 * would silently drop a resume.
 */
class AgentIndex {
  constructor() {
    this.bySession = new Map();
  }

  add(agent) {
    const id = sessionIdOf(agent?.session);
    if (id === undefined) return;
    this.bySession.set(id, agent);
  }

  remove(agent) {
    const id = sessionIdOf(agent?.session);
    if (id === undefined) return;
    if (this.bySession.get(id) === agent) this.bySession.delete(id);
  }

  removeSession(sessionId) {
    this.bySession.delete(String(sessionId));
  }

  get(sessionId) {
    const id = String(sessionId);
    const agent = this.bySession.get(id);
    if (agent === undefined) return undefined;
    if (sessionIdOf(agent.session) !== id) {
      this.bySession.delete(id);
      return undefined;
    }
    return agent;
  }

  ids() {
    return [...this.bySession.keys()];
  }

  clear() {
    this.bySession.clear();
  }
}

// ── HTTP surface ────────────────────────────────────────────────────────────

function sendJson(res, code, payload) {
  try {
    const body = JSON.stringify(payload);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  } catch {
    /* peer gone */
  }
}

function isLoopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const name = parsed.hostname;
  if (name === 'localhost' || name === '[::1]' || name === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/** Reject cross-site callers: this surface can drive an agent. */
function checkOrigin(req) {
  const host = req.headers.host;
  if (!isLoopbackAuthority(host)) return 'forbidden host';
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'cross-site';
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== host) return 'origin mismatch';
    } catch {
      return 'bad origin';
    }
  }
  return null;
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {};
  } catch {
    throw new Error('body is not JSON');
  }
}

// ── harness module access ───────────────────────────────────────────────────

/** Cache for the lazily reached harness modules; `null` means "tried and failed". */
const harnessModules = new Map();

/**
 * Load one `@deepseek-ai/*` module from the *harness*, not from this file.
 *
 * Why not a bare import: a `link:`-installed bundle resolves from the workspace,
 * which has no harness packages (see the module header). Why not import it from
 * the profile either: the profile only carries the few packages its own bundles
 * happen to hoist. `createRequire(process.execPath)` anchors resolution at the
 * running harness binary, which is the one place the packages are guaranteed to
 * be — including inside app.asar, which Electron's fs can read.
 *
 * @param specifier - bare package name.
 * @returns the module namespace, or `null` when it cannot be reached. Never throws.
 */
async function loadHarnessModule(specifier) {
  if (harnessModules.has(specifier)) return harnessModules.get(specifier);
  const bases = [];
  if (process.argv[1]) bases.push(process.argv[1]);
  bases.push(process.execPath);
  let found = null;
  // A bare import first: it costs nothing and covers a normal (non-asar) install
  // where the profile or the workspace CAN see the package.
  try {
    found = await import(specifier);
  } catch {
    /* fall through to the anchored attempts */
  }
  if (found === null) {
    for (const base of bases) {
      try {
        const resolved = createRequire(base).resolve(specifier);
        found = await import(pathToFileURL(resolved).href);
        break;
      } catch {
        /* try the next anchor */
      }
    }
  }
  harnessModules.set(specifier, found);
  return found;
}

/**
 * Build the user-role message a resume delivers.
 *
 * Uses the harness factory when it is reachable (it deep-freezes and assigns the
 * canonical id) and otherwise constructs the same shape locally — `role: 'user'`,
 * a fresh UUID and the given content/source, which is all `followup()` reads.
 * The fallback is why a failed module lookup cannot disable the whole feature.
 *
 * @param text - resume body.
 * @returns the message to hand to `agent.followup()`.
 */
async function buildResumeMessage(text) {
  const mod = await loadHarnessModule('@deepseek-ai/dsh-llm');
  const factory = mod?.createUserMessage ?? mod?.default?.createUserMessage;
  const input = { content: [{ type: 'text', text }], source: SOURCE };
  if (typeof factory === 'function') {
    try {
      return factory(input);
    } catch {
      /* fall back to the local shape */
    }
  }
  return { ...input, role: 'user', id: randomUUID() };
}

// ── plugin entry ────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  if (!resolved.enabled) {
    ctx.logger.info(`${NS}: 配置 enabled=false，未挂载。`);
    return;
  }

  /**
   * The decision core, created when the loop driver's `agents` service appears.
   * Null until then, which is why every reader checks it.
   * @type {LoopResumeScheduler | null}
   */
  let core = null;

  /**
   * Live agents by session id. Held at plugin scope so the HTTP routes can
   * report `hasAgent` even when the loop driver is absent.
   */
  const index = new AgentIndex();
  /**
   * The authoritative interruption record.
   *
   * Registered on the *plugin* context, not on the injected `agents` scope: the
   * harness dispatches `session/event` on the plugin context (every working
   * listener in this codebase registers it exactly this way), whereas the
   * `agent/*` lifecycle events are dispatched on the injected scope.
   */
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (core === null) return;
    const id = sessionIdOf(session);
    if (id === undefined) return;
    const type = event?.type;
    const seq = typeof event?.seq === 'number' ? event.seq : undefined;

    if (type === 'turn/start') {
      // The loop really woke: whatever the cause was, it is over.
      core.clearEpisode(id, 'turn/start');
      return;
    }
    if (type === 'user/message') {
      core.observeInput(id, event?.data?.message ?? event?.data);
      return;
    }

    const reason = classifyInterrupt(event);
    if (reason === null) {
      if (type === 'assistant/message' && stopReasonOf(event) === undefined) core.clearEpisode(id, 'assistant/message ok');
      return;
    }
    let detail = extractFailure(event);
    if (detail === null && reason === 'upstream.truncated') {
      detail = { message: '输出在长度上限处被截断', code: 'MAX_TOKENS' };
    }
    if (detail === null) detail = { message: undefined, code: reason };
    const networkish = isTransportError(detail) || reason.startsWith('network.');
    core.observeInterrupt(id, networkish && reason === 'error' ? 'network.stream' : reason, detail, seq);
  }), `${NS}: session/event`);
  /**
   * A snapshot that works even before the loop driver exists, so the pill can
   * render and explain itself rather than failing every poll.
   */
  const snapshotOf = (sessionId) => (core === null
    ? {
        sessionId, stopped: false, reason: null, detail: null, resumable: false,
        armed: false, resumeAt: 0, networkDown: false, probing: false,
        inFlight: false, attempts: 0, maxAutoResumes: resolved.maxAutoResumes,
        autoResume: resolved.autoResume, autoAllowed: false, text: resolved.text,
        pill: resolved.pill, showReason: resolved.showReason, lastError: null,
        hasAgent: index.get(sessionId) !== undefined, now: Date.now(),
      }
    : core.snapshot(sessionId));

  /** The loop driver is optional in a profile; the routes say so, not throw. */
  const noCore = () => ({ ok: false, error: '这个 profile 没有循环驱动器（agents 服务缺席）' });

  // ── HTTP surface for the Client half ──
  // Sub-paths under the registered prefix `/api/dsh-continue-guard`. The Client
  // addresses them document-relative (`api/dsh-continue-guard/state`) because
  // the GUI is served with <base href="./"> and may sit under a sub-path
  // deployment; a root-absolute fetch would escape the prefix.
  //
  // ⚠️ Registered on the PLUGIN context, not inside the `agents` inject. The
  // pill reaches the host exclusively through these routes, so they must exist
  // in every profile that has a web server — including one where the loop driver
  // never appears. Binding them to a service pair meant the callback never fired
  // and every click answered 404.
  //
  // Every handler takes `(body, query)` — the dispatcher below calls them that
  // way. A handler that only needs the query still declares both, because
  // getting the positions wrong is a 500 on the most-used route.
  const routes = {
    async state(_body, query) {
      const sessionId = query.get('sessionId');
      if (sessionId === null || sessionId === '') return { ok: false, error: 'sessionId required' };
      return { ok: true, value: snapshotOf(sessionId) };
    },
    async list() {
      return {
        ok: true,
        value: {
          now: Date.now(),
          networkDown: core === null ? false : core.networkDown,
          sessions: index.ids().map((id) => snapshotOf(id)),
        },
      };
    },
    async resume(body) {
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
      if (sessionId === '') return { ok: false, error: 'sessionId required' };
      if (core === null) return noCore();
      const result = await core.resumeNow(sessionId);
      return { ok: result.ok === true, value: result, error: result.error ?? result.status };
    },
    async probe() {
      if (core === null) return noCore();
      const result = await watchProbe(
        probeOnce({
          urls: resolved.probeUrls, timeoutMs: resolved.probeTimeoutMs,
          retries: resolved.probeRetries, backoffMs: resolved.probeBackoffMs,
          backoffMaxMs: resolved.probeBackoffMaxMs,
        }),
        probeBudgetMs(resolved),
      );
      // A passing probe is itself the recovery evidence; the sweep picks it up
      // on the next tick. `sweep` is called explicitly so a click-rich UI sees
      // the arm immediately rather than up to a sweep interval later.
      core.recordProbe(result);
      if (result.ok === true) core.sweep();
      return { ok: true, value: { reachable: result.ok === true, attempts: result.attempts, ms: result.ms } };
    },
    async network(body) {
      if (core === null) return noCore();
      const down = body?.down === true;
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
      if (down) core.onNetworkDown('browser');
      else core.onNetworkRecovered('browser');
      if (sessionId !== '') core.observeNetworkHint(sessionId, down);
      return { ok: true, value: { networkDown: core.networkDown } };
    },
    async clear(body) {
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
      if (sessionId === '') return { ok: false, error: 'sessionId required' };
      if (core === null) return { ok: true, value: snapshotOf(sessionId) };
      core.clearEpisode(sessionId, 'client-clear');
      return { ok: true, value: snapshotOf(sessionId) };
    },
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE,
    handler: async (req, res) => {
      const denied = checkOrigin(req);
      if (denied !== null) {
        sendJson(res, 403, { ok: false, error: denied });
        return;
      }
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad url' });
        return;
      }
      let path = url.pathname.replace(/\/+$/, '') || '/';
      if (path.startsWith(ROUTE_BASE)) path = path.slice(ROUTE_BASE.length) || '/';
      const name = path.replace(/^\//, '').replace(/\/$/, '');
      const handler = routes[name];
      if (handler === undefined) {
        sendJson(res, 404, { ok: false, error: `unknown route: ${name}` });
        return;
      }
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
        sendJson(res, 200, await handler(body, url.searchParams));
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  }), `${NS}: http surface`);

  // ── the decision core (needs the loop driver) ──
  // `agents` is absent in profiles without a loop driver, so this stays a
  // deferred inject: the plugin still mounts and still serves its HTTP surface
  // there, and the pill reports that no agent is running rather than 404-ing.
  ctx.inject(['agents'], (scope) => {
    const created = new LoopResumeScheduler({
      config: resolved,
      now: Date.now,
      log: ctx.logger,
      resolveAgent: (sessionId) => index.get(sessionId),
      probe: () => probeOnce({
        urls: resolved.probeUrls,
        timeoutMs: resolved.probeTimeoutMs,
        retries: resolved.probeRetries,
        backoffMs: resolved.probeBackoffMs,
        backoffMaxMs: resolved.probeBackoffMaxMs,
      }),
      deliver: async (agent, text, meta) => {
        const message = await buildResumeMessage(text);
        // withoutInitiator: a resume is not some other agent's child task.
        scope.agents.withoutInitiator(() => { agent.followup(message); });
        if (resolved.verbose) {
          ctx.logger.info(`${NS}: followup 已投递（${meta.auto ? '自动' : '手动'}，第 ${meta.attempt} 次）`);
        }
      },
    });
    core = created;

    scope.effect(() => () => {
      created.dispose();
      index.clear();
      if (core === created) core = null;
    }, `${NS}: core teardown`);

    // The retry edge for a failed probe. A link that comes back emits no event
    // anywhere, so without this timer an episode could sit waiting forever.
    scope.effect(() => {
      const timer = setInterval(() => created.sweep(), SWEEP_INTERVAL_MS);
      return () => clearInterval(timer);
    }, `${NS}: resume sweep`);

    // Seed from whatever is already live: `agent/created` only fires for agents
    // born after this plugin loaded, and a profile reload has live agents.
    for (const agent of listAgents(scope)) index.add(agent);

    scope.on('agent/created', ({ agent }) => index.add(agent));
    scope.on('agent/disposed', ({ agent }) => {
      const id = sessionIdOf(agent?.session);
      if (id !== undefined) created.clearEpisode(id, 'agent-disposed');
      index.remove(agent);
    });
    scope.on('agent/status', ({ agent, status }) => {
      const id = sessionIdOf(agent?.session);
      if (id === undefined) return;
      if (String(status).toLowerCase() === 'idle') created.observeIdle(id);
    });
    scope.on('agent/error', ({ agent, error }) => {
      const id = sessionIdOf(agent?.session);
      if (id === undefined) return;
      const record = errorRecordOf(error) ?? { message: String(error?.message ?? error) };
      const reason = isTransportError(record) ? 'network.stream' : 'error';
      created.observeInterrupt(id, reason, record, undefined);
    });
    scope.on('agent/inbox/inserted', ({ agent, message }) => {
      const id = sessionIdOf(agent?.session);
      if (id === undefined) return;
      created.observeInput(id, message);
    });

    /**
     * Startup recovery, once, after the index is seeded and the listeners are
     * attached — so a seeded episode immediately has the idle/status edges it
     * needs to fire. Deferred as a microtask-free async IIFE because `apply()`
     * must return promptly.
     */
    scope.effect(() => {
      let cancelled = false;
      void (async () => {
        try {
          const summary = await recoverInterruptedSessions({
            config: resolved,
            core: created,
            log: ctx.logger,
            resolveAgent: (sessionId) => index.get(sessionId),
            wake: async (sessionId) => {
              // The supported crash-recovery path: it repairs the interrupted
              // turn (its own `interruptedTurnClosers`) and publishes an agent
              // for an otherwise dormant session. Throws when the id is already
              // owned, which is exactly the race we want to lose quietly.
              if (typeof scope.agents?.resume !== 'function') throw new Error('agents.resume 不可用');
              await scope.agents.resume(scope, { resumeSessionId: sessionId });
              // The published agent may already be idle, in which case no status
              // edge will arrive to arm the delay.
              created.observeIdle(sessionId);
            },
          });
          if (cancelled) return;
          if (resolved.verbose || summary.resumed > 0) {
            ctx.logger.info(
              `${NS}: 启动扫描完成（查看 ${summary.scanned} 个会话，判定中断 ${summary.resumed}，唤醒 ${summary.woken}）`,
            );
          }
        } catch (error) {
          // Recovery is a convenience: a failure here must never take the
          // plugin (or the boot) down with it.
          ctx.logger.info(`${NS}: 启动扫描失败：${error?.message ?? error}`);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, `${NS}: startup recovery`);

    ctx.logger.info(
      `${NS}: 续跑核心已挂载（自动续跑 ${resolved.autoResume ? '开' : '关'}，延时 ${resolved.resumeDelayMs}ms，上限 ${resolved.maxAutoResumes} 次，探测 ${resolved.probeUrls.length} 个目标）`,
    );
  });

  ctx.logger.info(`${NS}: 已挂载（HTTP 路由 ${ROUTE_BASE} 已注册）`);
}

export const name = NS;

/**
 * `webServer` is a HARD dependency, declared statically so the Loader waits for
 * the HTTP server before calling `apply()` and `ctx.webServer` is usable here.
 *
 * `agents` is deliberately NOT in this list: it is absent in profiles without a
 * loop driver, and a static dependency on it would leave the whole plugin —
 * including the pill's HTTP surface — pending forever there. It is requested
 * with a deferred `ctx.inject` inside `apply()` instead.
 */
export const inject = ['webServer'];
