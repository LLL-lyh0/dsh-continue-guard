/**
 * dsh-continue-guard — Client half.
 *
 * Renders one 「继续」 pill in the composer dock (`conversation.composer.dock`,
 * the ambient row below the input card where the shell draws its own
 * round/step/token pills) and drives the host operation behind it.
 *
 * The browser holds no opinion about whether a session was interrupted: it asks
 * the host every poll and paints whatever the host reports. Its only local
 * authority is `navigator.onLine` and the window online/offline events, which
 * are forwarded as HINTS — the host's outbound probe is the verdict, because
 * `onLine` is true whenever a network adapter is up even when the internet is
 * not (a captive portal, a dead uplink, or a VPN with no route).
 *
 * A manual click sends 「继续」 through the session's REAL submission pipeline
 * (`sessions.binding(id).session.beginSubmission` + `.prompt`) — the same pair
 * the composer calls when the user types and presses Enter. So the message
 * appears in the transcript as an ordinary user message. Note what this is NOT:
 * no message source is fabricated anywhere in this file — the human really did
 * click, and routing the click through the real pipe lets the harness attest the
 * input itself. The host HTTP route is only the FALLBACK for a profile whose
 * client half cannot reach `sessions`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-continue-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-continue-guard';
    /** Document-relative on purpose (see the host route comment). */
    const API = {
      state: 'api/dsh-continue-guard/state',
      resume: 'api/dsh-continue-guard/resume',
      probe: 'api/dsh-continue-guard/probe',
      network: 'api/dsh-continue-guard/network',
    };
    /** What the composer would have sent had the user typed it themselves. */
    const DEFAULT_TEXT = '继续';

    /**
     * The live `sessions` service, captured by the deferred inject in `apply`.
     *
     * Held in a module slot rather than React state because the click handler
     * only reads it at call time, and because the pill must keep RENDERING on a
     * profile that never provides it — the fallback path covers that case.
     * @type {object | null}
     */
    let sessionsService = null;

    /**
     * Send the resume text the way the composer sends anything.
     *
     * `beginSubmission` registers the optimistic echo bubble the input box would
     * show; it is cosmetic, so a failure there is a warning, not an abort — the
     * send still goes through. Only a rejected `prompt` is a real failure.
     *
     * @param {string} sessionId
     * @param {string} text
     * @returns {Promise<{ok: true} | {ok: false, unavailable?: true, error?: string}>}
     *   `unavailable` means "no sessions service / no binding" — the caller
     *   should fall back. A plain `ok:false` is a real rejection and must be
     *   reported rather than retried down another path.
     */
    async function submitAsUser(sessionId, text) {
      const sessions = sessionsService;
      if (sessions === null || sessions === undefined || typeof sessions.binding !== 'function') {
        return { ok: false, unavailable: true };
      }
      let binding;
      try {
        binding = sessions.binding(sessionId);
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
      const session = binding === undefined || binding === null ? undefined : binding.session;
      if (session === undefined || session === null || typeof session.prompt !== 'function') {
        return { ok: false, unavailable: true };
      }

      let handle;
      try {
        handle = session.beginSubmission({ mode: 'queue', text, attachments: [] });
      } catch (error) {
        console.warn('[dsh-continue-guard] 提交回显注册失败，改为直接发送', error);
      }

      let result;
      try {
        result = await session.prompt(
          [{ type: 'text', text }],
          'queue',
          undefined,
          handle === undefined ? undefined : handle.requestId,
        );
      } catch (error) {
        if (handle !== undefined && typeof handle.abandon === 'function') handle.abandon();
        return { ok: false, error: String(error?.message ?? error) };
      }
      if (result === null || result === undefined || result.ok !== true) {
        if (handle !== undefined && typeof handle.abandon === 'function') handle.abandon();
        const failure = result === null || result === undefined ? undefined : result.error;
        const message = typeof failure === 'string' ? failure : (failure?.message ?? '');
        return { ok: false, error: message };
      }
      return { ok: true };
    }

    const COPY = {
      zh: {
        resume: '继续',
        resuming: '发送中…',
        sent: '已发送，任务重新跑起来了',
        armed: (s) => `网络已恢复，${s}秒后自动继续…`,
        waitingNetwork: '等网络恢复后自动继续',
        probing: '正在检测网络…',
        budget: '自动续跑已达上限',
        failed: '发送失败',
        noAgent: '这个会话当前没有运行中的 Agent，重新打开它再点',
        tip: '一键把意外中断的会话重新跑起来。网络中断、上游截断（输出超限）恢复后会自动点这一下。',
        tipOffline: '网络还没恢复，恢复后会自动继续。',
        tipIdle: '没有检测到中断。点一下也会补发「继续」。',
        netDown: '离线',
      },
      en: {
        resume: 'Continue',
        resuming: 'Sending…',
        sent: 'Sent — the task is running again',
        armed: (s) => `Back online — auto-resume in ${s}s…`,
        waitingNetwork: 'Waiting for the network to come back…',
        probing: 'Checking the connection…',
        budget: 'Auto-resume limit reached',
        failed: 'Send failed',
        noAgent: 'No live agent for this session; open it and try again',
        tip: 'Re-runs a session that stopped unexpectedly. After a network drop or an upstream cut (output limit) it clicks itself once the link is back.',
        tipOffline: 'Offline — it will resume automatically when the link returns.',
        tipIdle: 'No interruption detected. Clicking still sends a「继续」.',
        netDown: 'offline',
      },
    };

    function pickCopy() {
      const lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || '';
      return lang.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en;
    }

    // ── styles ──────────────────────────────────────────────────────────────
    // Only --dsw-alias-* tokens, with a fallback each, so a renamed token
    // degrades the look without ever breaking the render.
    const PILL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      height: '22px',
      padding: '0 9px 0 7px',
      borderRadius: '11px',
      border: '0.5px solid var(--dsw-alias-border-l2, #4a4a4a)',
      background: 'var(--dsw-alias-fill-l1, rgba(255,255,255,0.06))',
      color: 'var(--dsw-alias-label-primary, #e8e8e8)',
      fontSize: '12px',
      lineHeight: '22px',
      cursor: 'pointer',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      userSelect: 'none',
      transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms ease',
    };
    const ACTIVE_STYLE = {
      border: '0.5px solid var(--dsw-alias-brand-primary, #4f8cff)',
      background: 'rgba(79,140,255,0.14)',
      color: 'var(--dsw-alias-brand-primary, #4f8cff)',
      fontWeight: 600,
    };
    const ARMED_STYLE = {
      border: '0.5px solid var(--dsw-alias-brand-warning, #d9a13c)',
      background: 'rgba(217,161,60,0.14)',
      color: 'var(--dsw-alias-brand-warning, #d9a13c)',
      fontWeight: 600,
    };
    const DONE_STYLE = {
      border: '0.5px solid var(--dsw-alias-brand-success, #4caf78)',
      background: 'rgba(76,175,120,0.13)',
      color: 'var(--dsw-alias-brand-success, #4caf78)',
    };
    const ICON_WRAP = { display: 'inline-flex', alignItems: 'center' };
    const HIDDEN = { display: 'none' };

    function ResumeGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 12, height: 12, fill: 'currentColor',
        'aria-hidden': 'true', style: ICON_WRAP,
      }, h('path', { d: 'M3 2.6c0-.5.55-.79.98-.54l8.1 4.4a.64.64 0 0 1 0 1.12l-8.1 4.4A.64.64 0 0 1 3 11.4z' }));
    }

    function SpinnerGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': 'true', style: ICON_WRAP,
      }, h('circle', { cx: 8, cy: 8, r: 5.6, opacity: 0.25 }),
        h('path', { d: 'M13.6 8a5.6 5.6 0 0 0-5.6-5.6', strokeLinecap: 'round' }));
    }

    /**
     * Poll the host for this session's state. Cadence follows the work: fast
     * while a resume is counting down (the pill shows a live second), medium
     * while an interruption is pending, slow once the session is back to normal
     * — an idle chat must not cost one request every second.
     */
    function useHostState(sessionId, online) {
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [flash, setFlash] = React.useState('');

      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null) { setState(null); return undefined; }
        let stopped = false;
        let timer;
        const tick = async () => {
          let delay = 4000;
          try {
            const response = await fetch(`${API.state}?sessionId=${encodeURIComponent(String(sessionId))}`, {
              headers: { accept: 'application/json' }, cache: 'no-store',
            });
            const payload = response.ok ? await response.json() : null;
            if (stopped) return;
            if (payload && payload.ok === true) {
              const value = payload.value;
              setState(value);
              // An armed countdown needs ~1 Hz to show honest seconds; anything
              // else can wait for the next slow beat.
              if (value && value.armed === true) delay = 500;
              else if (value && value.stopped === true) delay = 1500;
              else if (value && value.probing === true) delay = 1000;
              else delay = 4000;
            }
          } catch {
            if (stopped) return;
            // A failed poll says nothing about the session — it means THIS page
            // lost the host (a restart, a dropped loopback call). Keep the last
            // known state rather than blanking the pill, and back off further
            // when the browser already believes it is offline.
            delay = online ? 3000 : 8000;
          }
          if (!stopped) timer = setTimeout(() => void tick(), delay);
        };
        void tick();
        return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
      }, [sessionId, online]);

      /** Post an intent and let the host decide; every path refreshes once. */
      const call = React.useCallback(async (path, body) => {
        try {
          const response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            cache: 'no-store',
          });
          const payload = await response.json().catch(() => null);
          return payload && payload.ok === true ? (payload.value ?? {}) : { ok: false, error: payload?.error ?? `HTTP ${response.status}` };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      }, []);

      return { state, setState, busy, setBusy, flash, setFlash, call };
    }

    function ContinueButton(props) {
      const t = React.useMemo(pickCopy, []);
      const sessionId = props.sessionId;
      const [online, setOnline] = React.useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
      const { state, setState, busy, setBusy, flash, setFlash, call } = useHostState(sessionId, online);

      // The browser's own edge is a hint, never a verdict: forward both, and let
      // the host's probe decide whether anything actually fires.
      React.useEffect(() => {
        const goDown = () => { setOnline(false); void call(API.network, { sessionId, down: true }); };
        const goUp = () => { setOnline(true); void call(API.network, { sessionId, down: false }); };
        // ⚠️ Report the CURRENT state once on mount. A WiFi drop that happened
        // BEFORE this page loaded fires no `offline` event — there is no edge to
        // observe — so the host would never learn this machine is offline, and the
        // discriminator it uses to tell a link failure from a model error would
        // have no evidence to work with. Reporting the standing state closes that
        // hole; the host treats it as a hint either way, never as a verdict.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          void call(API.network, { sessionId, down: true });
        }
        window.addEventListener('offline', goDown);
        window.addEventListener('online', goUp);
        return () => {
          window.removeEventListener('offline', goDown);
          window.removeEventListener('online', goUp);
        };
      }, [call, sessionId]);

      // Re-render the countdown from the host's absolute deadline, so the pill's
      // seconds stay honest between polls.
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        if (!state || state.armed !== true) return undefined;
        const timer = setInterval(force, 250);
        return () => clearInterval(timer);
      }, [state && state.armed]);

      React.useEffect(() => {
        if (flash === '') return undefined;
        const timer = setTimeout(() => setFlash(''), 2600);
        return () => clearTimeout(timer);
      }, [flash]);

      // A session that started turning again means the resume worked: the host
      // clears the episode on turn/start, so `stopped` flipping to false is the
      // success signal and needs no separate ack.
      const wasStopped = React.useRef(false);
      React.useEffect(() => {
        const stoppedNow = state ? state.stopped === true : false;
        if (wasStopped.current && !stoppedNow) setFlash(t.sent);
        wasStopped.current = stoppedNow;
      }, [state, t.sent, setFlash]);

      /** Pull one fresh snapshot; used after any send so the pill repaints. */
      const refresh = React.useCallback(async () => {
        if (sessionId === undefined || sessionId === null) return;
        const next = await fetch(`${API.state}?sessionId=${encodeURIComponent(String(sessionId))}`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (next && next.ok === true) setState(next.value);
      }, [sessionId, setState]);

      // A ref, not `busy`: React state is not updated synchronously, so two
      // clicks landing in the same tick would both pass a state-based guard and
      // send twice.
      const sending = React.useRef(false);
      const onClick = async () => {
        if (sending.current || sessionId === undefined || sessionId === null) return;
        sending.current = true;
        setBusy('resume');
        setFlash('');
        try {
          const text = state && typeof state.text === 'string' && state.text !== '' ? state.text : DEFAULT_TEXT;

          // Primary path: the composer's own submission pipeline, so the
          // transcript shows an ordinary user message.
          const direct = await submitAsUser(sessionId, text);
          if (direct.ok === true) {
            // A manual click on an IDLE session produces no stopped->running
            // edge, so the wasStopped effect below would never fire and the
            // pill would look inert. Acknowledge the send here instead; a click
            // that really did wake a stopped session is confirmed again by that
            // edge. The sent user message also reaches the host's own
            // `session/event` listener, which refills the budget and cancels any
            // armed auto-resume — so this path cannot double-send.
            setFlash(t.sent);
            await refresh();
            return;
          }
          // A real rejection (not "unavailable") is the answer: report it
          // instead of retrying down the fallback and doubling the attempt.
          if (direct.unavailable !== true) {
            setFlash(`${t.failed}${direct.error ? `：${direct.error}` : ''}`);
            return;
          }

          // Fallback for a profile whose client half cannot reach `sessions`:
          // the host route, which signs the message as this plugin.
          const result = await call(API.resume, { sessionId });
          if (result.ok === false) {
            setFlash(result.status === 'no-agent' ? t.noAgent : `${t.failed}${result.error ? `：${result.error}` : ''}`);
            return;
          }
          setFlash(t.sent);
          await refresh();
        } finally {
          sending.current = false;
          setBusy('');
        }
      };

      if (sessionId === undefined || sessionId === null) return null;

      const stopped = state ? state.stopped === true : false;
      const armed = state ? state.armed === true : false;
      const probing = state ? state.probing === true : false;
      const offline = state ? state.networkDown === true : !online;
      const budgetSpent = state ? (state.attempts >= state.maxAutoResumes && state.autoResume === true) : false;
      const secondsLeft = armed && state ? Math.max(0, Math.ceil((state.resumeAt - (state.now || Date.now())) / 1000)) : 0;

      let label = state && state.text ? state.text : t.resume;
      let tone = null;
      let title = t.tip;
      if (busy === 'resume') {
        label = t.resuming; tone = ACTIVE_STYLE; title = t.resuming;
      } else if (flash !== '') {
        label = flash; tone = DONE_STYLE; title = flash;
      } else if (armed) {
        label = t.armed(secondsLeft || 1); tone = ARMED_STYLE; title = label;
      } else if (stopped && offline) {
        label = probing ? t.probing : t.waitingNetwork; tone = ARMED_STYLE; title = t.tipOffline;
      } else if (budgetSpent && stopped) {
        label = t.budget; tone = null; title = t.budget;
      } else if (stopped) {
        tone = ACTIVE_STYLE; title = t.tip;
      } else {
        title = t.tipIdle;
      }

      const style = { ...PILL_STYLE, ...(tone === null ? null : tone) };
      // `pill: false` means "no capsule" — drop the chrome, keep the affordance.
      // Mutating only the weight would silently disagree with the option name,
      // which is worse than not having the option.
      if (state && state.pill === false) {
        style.border = '0.5px solid transparent';
        style.background = 'transparent';
        style.padding = '0 4px';
      }

      return h('div', { style: { display: 'inline-flex', alignItems: 'center' }, 'data-dsh-continue-guard': NS },
        h('button', {
          type: 'button',
          onClick,
          title,
          'aria-label': title,
          disabled: busy !== '',
          style: { ...style, opacity: busy !== '' ? 0.7 : (stopped || armed || flash !== '' ? 1 : 0.72) },
        },
          h('span', { style: ICON_WRAP, 'aria-hidden': 'true' },
            busy === 'resume' || armed || probing ? h(SpinnerGlyph, null) : h(ResumeGlyph, null)),
          h('span', null, label),
          // The offline dot is deliberately secondary: the pill text already
          // says what is happening, and this keeps it honest when the host
          // reports a down network the browser cannot see (vpn / captive portal).
          offline && !armed ? h('span', {
            'aria-hidden': 'true',
            title: t.netDown,
            style: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-brand-danger, #e05c5c)', display: 'inline-block' },
          }) : null,
        ),
        h('span', { style: HIDDEN, role: 'status', 'aria-live': 'polite' }, flash),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        /**
         * Capture the real user-input surface.
         *
         * Deferred on purpose, twice over: a profile that never provides
         * `sessions` must still RENDER the pill (it falls back to the host
         * route), and a static dependency here would leave the whole client
         * plugin pending — the button would not appear at all. The disposer
         * clears the capture so a torn-down client cannot send into a dead
         * service.
         */
        ctx.inject(['sessions'], (scope) => {
          sessionsService = scope.sessions;
          ctx.effect(() => () => { sessionsService = null; });
        });
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: NS,
          // The shell's own stats pill registers at 0 and dsh-live-token-stats at
          // 10; sit after both so nothing shipped gets pushed left.
          order: 12,
        }, ContinueButton));
      },
    };
  },
});
