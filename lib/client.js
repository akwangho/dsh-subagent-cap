/**
 * dsh-subagent-cap — browser half.
 *
 * Served at /plugins/dsh-subagent-cap/client.js and mounted by the web kernel.
 * Registers a settings section ("Subagent 上限").
 *
 * Two distinct data sources, deliberately kept apart:
 *   - CONFIGURATION ({maxSubagents, mode}) is ordinary volatile plugin Config on
 *     the Host. It is read and written through the Host's own settings form,
 *     `ctx.configForms.get(NAMESPACE)`, which persists into the profile's
 *     cordis.patch.yml. We do not keep a second copy.
 *   - RUNTIME STATE (queue depth, in-flight slots, recent rejections) is this
 *     plugin's own Remote service, read over the Connection RPC channel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-cap',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    /**
     * Settings namespace. MUST equal the host plugin's profile entry id in
     * `cordis.patch.yml` (`id: subagent-cap`); a mismatch surfaces as an
     * `unavailable` snapshot and is reported rather than silently doing nothing.
     */
    const NAMESPACE = 'subagent-cap'

    // ------------------------------------------------------------------- utils
    const injectCss = (css) => {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-subagent-cap', '')
      style.textContent = css
      document.head.appendChild(style)
      return () => style.remove()
    }

    const CSS = `
      .scap-settings { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; font-size: 13px; }
      .scap-settings h3 { margin: 0; font-size: 15px; }
      .scap-desc { opacity: 0.7; font-size: 12px; margin: 0; }
      .scap-row { display: flex; align-items: center; gap: 8px; }
      .scap-input { width: 90px; padding: 6px 8px; border: 1px solid rgba(255,255,255,0.12);
        border-radius: 6px; background: rgba(255,255,255,0.04); color: inherit; font-size: 13px; }
      .scap-btn { padding: 6px 14px; border: 1px solid rgba(255,255,255,0.14); border-radius: 6px;
        background: rgba(255,255,255,0.06); color: inherit; cursor: pointer; font-size: 12px; }
      .scap-btn:hover { background: rgba(255,255,255,0.12); }
      .scap-btn-active { border-color: rgba(120,180,255,0.6); background: rgba(120,180,255,0.14); }
      .scap-current { font-weight: 600; }
      .scap-muted { opacity: 0.6; font-size: 12px; }
      .scap-list { display: flex; flex-direction: column; gap: 4px; }
      .scap-rej { font-size: 12px; opacity: 0.85; }
      .scap-msg { color: #ff8a8a; font-size: 12px; }
      .scap-diag { margin-top: 10px; padding: 10px 12px; border: 1px solid #ff8a8a; border-radius: 8px;
        background: rgba(255,90,90,0.08); color: #ff9a9a; font-size: 12px; line-height: 1.5; }
      .scap-diag-title { font-weight: 600; margin-bottom: 6px; }
      .scap-diag-list { margin: 0; padding-left: 18px; }
      .scap-diag-list li { margin: 2px 0; word-break: break-word; }
      .scap-diag-banner { position: fixed; left: 16px; bottom: 16px; z-index: 10001; display: none;
        max-width: 380px; padding: 8px 12px; border: 1px solid #ff8a8a; border-radius: 8px;
        background: rgba(20,20,28,0.95); color: #ff9a9a; font-size: 12px; line-height: 1.4;
        font-family: system-ui, -apple-system, sans-serif; }
      .scap-footer { margin-top: 8px; font-size: 11px; opacity: 0.5; }
    `

    // ------------------------------------------------------- configuration
    // The Host's own form for this entry's namespace: a live view whose
    // `getSnapshot()` is stable until something changes, plus queued,
    // revision-fenced writes. Reading and writing it is how this page persists
    // settings without owning a copy of them.
    let configForm = null
    let configSnapshot = { status: 'loading', value: undefined, writable: false, mode: 'host' }

    const bindConfigForm = (ctx) => {
      const forms = ctx.get('configForms')
      if (!forms || typeof forms.get !== 'function') {
        throw new Error('the "configForms" service is unavailable, so settings cannot be read or saved')
      }
      configForm = forms.get(NAMESPACE)
      if (!configForm || typeof configForm.subscribe !== 'function') {
        throw new Error('the settings service exposes no form for namespace "' + NAMESPACE + '"')
      }
      configSnapshot = configForm.getSnapshot()
      configForm.subscribe(() => {
        configSnapshot = configForm.getSnapshot()
        notify()
      })
    }

    // One queued Host write. Resolves with the Host's acceptance; the snapshot
    // (not this promise) is what the page renders.
    const setConfigField = async (field, value) => {
      if (!configForm) throw new Error('settings are not wired')
      return configForm.set(field, value)
    }

    // -------------------------------------------------------------- host RPC
    // Runtime state only. Configuration does NOT travel this path any more.
    let rpcCtx = null
    async function call(method, args) {
      const result = await rpcCtx.connection.rpc.call('/api', 'subagentCap/' + method, { args })
      if (!result || result.ok !== true) {
        const m = result && result.error && result.error.message ? result.error.message : '呼叫失敗'
        throw new Error(m)
      }
      return result.value
    }

    // Boot problems that must be visible instead of silent. A plugin that
    // cannot reach either the settings form or its own host half used to sit on
    // "載入中…" forever, which reads as "the plugin is gone".
    const diagnostics = []
    const notify = () => { for (const fn of Array.from(listeners)) fn() }
    const noteDiagnostic = (text) => {
      const line = String(text)
      if (diagnostics.some((d) => d.text === line)) return
      diagnostics.push({ text: line })
      renderFallbackBanner()
      notify()
    }

    // Last-resort surface: painted straight into the document, so a broken
    // `slots` service cannot hide the reason. Hidden while everything is healthy.
    let fallbackBanner = null
    const renderFallbackBanner = () => {
      if (typeof document === 'undefined') return
      if (!fallbackBanner) {
        fallbackBanner = document.createElement('div')
        fallbackBanner.setAttribute('data-dsh-subagent-cap', 'diag')
        fallbackBanner.className = 'scap-diag-banner'
        const body = document.body || document.head
        if (!body) return
        body.appendChild(fallbackBanner)
      }
      fallbackBanner.textContent = diagnostics.length + ' · ' + diagnostics[0].text
      fallbackBanner.style.display = diagnostics.length > 0 ? 'block' : 'none'
    }

    function SettingsSection(props) {
      const h = React.createElement
      // Runtime state (queue / rejections) still comes from our own Remote.
      const [state, setState] = useRuntimeState()
      const [msg, setMsg] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      // The Host's form is the source of truth for the two settings fields; the
      // text box keeps a local copy while typing and commits on save.
      const cfg = configSnapshot && configSnapshot.value
      const [input, setInput] = React.useState(null)
      React.useEffect(() => {
        if (cfg && typeof cfg.maxSubagents === 'number') setInput(String(cfg.maxSubagents))
      }, [cfg && cfg.maxSubagents])

      const formUnavailable = !configSnapshot || configSnapshot.status === 'unavailable'
      const readonly = formUnavailable || configSnapshot.writable === false

      const save = async () => {
        const v = Number(String(input == null ? '' : input).trim())
        if (!Number.isFinite(v)) { setMsg('請輸入有效數字'); return }
        setSaving(true); setMsg(null)
        try {
          const accepted = await setConfigField('maxSubagents', v)
          if (!accepted) setMsg('Host 拒絕了這次變更（可能已被其他分頁修改，請重試）。')
        } catch (e) {
          setMsg(String(e && e.message ? e.message : e))
        } finally {
          setSaving(false)
        }
      }

      const setMode = async (mode) => {
        setSaving(true); setMsg(null)
        try {
          const accepted = await setConfigField('mode', mode)
          if (!accepted) setMsg('Host 拒絕了這次變更（可能已被其他分頁修改，請重試）。')
        } catch (e) {
          setMsg(String(e && e.message ? e.message : e))
        } finally {
          setSaving(false)
        }
      }

      const Diagnostics = () => {
        if (diagnostics.length === 0) return null
        return h('div', { className: 'scap-diag' },
          h('div', { className: 'scap-diag-title' }, '⚠ 部分功能無法使用（相容性或安裝問題）'),
          h('ul', { className: 'scap-diag-list' },
            diagnostics.map((d, i) => h('li', { key: i }, d.text)),
          ),
        )
      }

      if (!state) {
        return h('div', { className: 'scap-settings' },
          Diagnostics(),
          state === null && diagnostics.length === 0
            ? h('p', { className: 'scap-muted' }, '載入中…')
            : null,
        )
      }

      const mode = cfg && cfg.mode
      return h('div', { className: 'scap-settings' },
        h('h3', null, 'Subagent 上限'),
        Diagnostics(),
        h('p', { className: 'scap-desc' }, '每個會話「同時執行」的 subagent 數量上限（0＝禁止啟動新 subagent）。'),
        readonly
          ? h('p', { className: 'scap-muted' }, cfg ? '設定目前唯讀：Host 未開放寫入。' : '設定表單尚未就緒（仍在載入，或 Host 尚未提供此外掛的設定）。')
          : null,
        h('div', { className: 'scap-row' },
          h('input', {
            className: 'scap-input', type: 'number', min: 0, max: 100, disabled: readonly,
            value: input == null ? '' : input, onChange: (ev) => setInput(ev.target.value),
          }),
          h('button', { className: 'scap-btn', onClick: save, disabled: saving || readonly }, '儲存'),
        ),
        h('p', { className: 'scap-current' }, '目前上限：' + (cfg && typeof cfg.maxSubagents === 'number' ? cfg.maxSubagents : '—')),
        h('div', { className: 'scap-row' },
          h('span', { className: 'scap-muted' }, '達上限時：'),
          h('button', {
            className: 'scap-btn' + (mode === 'reject' ? ' scap-btn-active' : ''),
            disabled: saving || readonly,
            onClick: () => setMode('reject'),
          }, '拒絕'),
          h('button', {
            className: 'scap-btn' + (mode === 'queue' ? ' scap-btn-active' : ''),
            disabled: saving || readonly,
            onClick: () => setMode('queue'),
          }, '排隊等待'),
        ),
        (state.rejections && state.rejections.length > 0)
          ? h('div', { className: 'scap-list' },
              h('p', { className: 'scap-muted' }, '最近被阻擋的委派：'),
              state.rejections.map((r, i) => h('div', { key: i, className: 'scap-rej' },
                r.sessionId + ' · ' + r.tool + ' · ' + r.reason)),
            )
          : h('p', { className: 'scap-muted' }, '尚無被阻擋的 subagent。'),
        msg ? h('p', { className: 'scap-msg' }, msg) : null,
        h('div', { className: 'scap-footer' }, '版本 ' + state.version),
      )
    }

    // Runtime state via the plugin's own Remote service. Polls once a second so
    // queue depth and recent rejections stay live while the page is open; the
    // countdowns this plugin used to show are gone, so a slow poll is enough.
    const listeners = new Set()
    let runtimeState = null
    let pollTimer = null
    const useRuntimeState = () => {
      const [snap, setSnap] = React.useState(runtimeState)
      React.useEffect(() => {
        const fn = () => setSnap(runtimeState)
        listeners.add(fn)
        if (pollTimer == null) {
          const tick = () => {
            call('getState', {})
              .then((s) => { runtimeState = s; notify() })
              .catch((e) => noteDiagnostic('Host RPC 失敗: ' + (e && e.message ? e.message : String(e))))
          }
          tick()
          pollTimer = setInterval(tick, 1000)
        }
        return () => {
          listeners.delete(fn)
          if (listeners.size === 0 && pollTimer != null) { clearInterval(pollTimer); pollTimer = null }
        }
      }, [])
      return snap
    }

    // ------------------------------------------------------------------- body
    // `configForms` carries configuration (the Host's own settings form for
    // this entry's namespace); `connection` still carries runtime state over
    // the plugin's Remote service. The typert `remote` service is NOT
    // injected: every host call rides the raw `connection.rpc.call` string
    // endpoint, so requiring the typed registry would needlessly fail the
    // mount on a build that does not provide it.
    const inject = ['slots', 'connection', 'configForms']

    // Run one optional piece of the UI. A failure is recorded and shown instead
    // of aborting `apply`: previously the first throw (a missing service, a
    // changed slots contract, a headless page) killed every later registration,
    // so the plugin vanished with no trace.
    const guard = (label, fn) => {
      try {
        return fn()
      } catch (error) {
        noteDiagnostic(label + ': ' + (error && error.message ? error.message : String(error)))
        return undefined
      }
    }

    function apply(ctx) {
      rpcCtx = ctx

      guard('Runtime RPC', () => {
        const conn = ctx.get('connection')
        if (!conn || !conn.rpc || typeof conn.rpc.call !== 'function') {
          throw new Error('the "connection" service exposes no rpc.call')
        }
      })
      if (!rpcCtx) noteDiagnostic('無法讀取執行狀態（queue / 被阻擋的委派）。')

      // Configuration is optional: without it the page still renders and still
      // shows runtime state, it just cannot save. That is better than refusing
      // to mount, and the reason is reported instead of swallowed.
      guard('Settings form', () => bindConfigForm(ctx))
      if (configForm && configSnapshot.status === 'unavailable') {
        noteDiagnostic('Host 沒有提供 namespace "' + NAMESPACE + '" 的設定表單。請確認此外掛在 cordis.patch.yml 的 entry 使用 `id: ' + NAMESPACE + '`，且 host 半部已啟用。')
      }

      const slots = ctx.get('slots')
      if (slots === undefined) {
        noteDiagnostic('the "slots" service is unavailable, so the settings section cannot be registered.')
        return
      }

      guard('Stylesheet', () => { ctx.effect(() => injectCss(CSS), 'subagent-cap: styles') })

      // Two surfaces, one page component.
      //
      // 1. `settings.plugins.tab` — THIS is the one that matters. The Plugins
      //    settings section renders the selected plugin's page with
      //    `renderSlot('settings.plugins.tab', {}, { only: single.id })`, i.e. it
      //    looks the page up by the plugin's profile entry id. Registering only
      //    `settings.section` below left the plugin showing NOTHING when you
      //    picked it in Settings -> Plugins. Its own comment says it plainly:
      //    "the configuration pages of the host-plane plugins live in their own
      //    companion packages, which register into the Plugins page; this
      //    section owns the Settings navigation entry and the tab chrome only".
      //    And because we declare `settings.configure({ auto: false })`, DSH is
      //    explicitly NOT auto-generating a page to fill the gap.
      //
      // 2. `settings.section` — the main Settings navigation list, so the cap is
      //    also reachable without going through Plugins.
      //
      // Registering on both costs one extra ledger entry and makes the page
      // reachable from whichever surface the user is looking at.
      const page = { name: 'settings.plugins.tab', id: NAMESPACE, order: 31, label: 'Subagent 上限' }
      guard('Plugins tab', () => {
        ctx.effect(() => slots.inject('settings.plugins.tab', () => guard('Plugins tab', () => slots.register(
          page, SettingsSection,
        ))), 'subagent-cap: plugins tab')
      })

      guard('Settings section', () => {
        ctx.effect(() => slots.inject('settings.section', () => guard('Settings section', () => slots.register(
          { name: 'settings.section', id: NAMESPACE, order: 31, label: 'Subagent 上限' },
          SettingsSection,
        ))), 'subagent-cap: settings section')
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})