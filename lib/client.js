/**
 * dsh-subagent-cap — browser half.
 *
 * Served at /plugins/dsh-subagent-cap/client.js and mounted by the web kernel.
 * Registers a settings section ("Subagent 上限") that reads/writes the host
 * Remote service (`subagentCap/getState|setMax|setMode`) through the Connection
 * RPC channel (`/api`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-cap',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

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
      .scap-footer { margin-top: 8px; font-size: 11px; opacity: 0.5; }
    `

    // -------------------------------------------------------------- host RPC
    let rpcCtx = null
    async function call(method, args) {
      const result = await rpcCtx.connection.rpc.call('/api', 'subagentCap/' + method, { args })
      if (!result || result.ok !== true) {
        const m = result && result.error && result.error.message ? result.error.message : '呼叫失敗'
        throw new Error(m)
      }
      return result.value
    }

    function SettingsSection(props) {
      const h = React.createElement
      const [state, setState] = React.useState(null)
      const [input, setInput] = React.useState('1')
      const [msg, setMsg] = React.useState(null)
      const [loading, setLoading] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        call('getState', {}).then((s) => {
          if (!alive) return
          setState(s)
          setInput(String(s.maxSubagents))
        }).catch((e) => { if (alive) setMsg(String(e && e.message ? e.message : e)) })
        return () => { alive = false }
      }, [])

      if (!state) {
        return h('div', { className: 'scap-settings' },
          h('p', { className: 'scap-muted' }, '載入中…'))
      }

      const save = async () => {
        const v = Number(String(input).trim())
        if (!Number.isFinite(v)) { setMsg('請輸入有效數字'); return }
        setLoading(true); setMsg(null)
        try {
          const r = await call('setMax', { maxSubagents: v })
          setState({ ...state, maxSubagents: r.maxSubagents, mode: r.mode })
          setInput(String(r.maxSubagents))
        } catch (e) {
          setMsg(String(e && e.message ? e.message : e))
        } finally {
          setLoading(false)
        }
      }

      const setMode = async (mode) => {
        setLoading(true); setMsg(null)
        try {
          const r = await call('setMode', { mode })
          setState({ ...state, mode: r.mode })
        } catch (e) {
          setMsg(String(e && e.message ? e.message : e))
        } finally {
          setLoading(false)
        }
      }

      return h('div', { className: 'scap-settings' },
        h('h3', null, 'Subagent 上限'),
        h('p', { className: 'scap-desc' }, '每個會話「同時執行」的 subagent 數量上限（0＝禁止啟動新 subagent）。'),
        h('div', { className: 'scap-row' },
          h('input', {
            className: 'scap-input', type: 'number', min: 0, max: 100,
            value: input, onChange: (ev) => setInput(ev.target.value),
          }),
          h('button', { className: 'scap-btn', onClick: save, disabled: loading }, '儲存'),
        ),
        h('p', { className: 'scap-current' }, '目前上限：' + state.maxSubagents),
        h('div', { className: 'scap-row' },
          h('span', { className: 'scap-muted' }, '達上限時：'),
          h('button', {
            className: 'scap-btn' + (state.mode === 'reject' ? ' scap-btn-active' : ''),
            onClick: () => setMode('reject'),
          }, '拒絕'),
          h('button', {
            className: 'scap-btn' + (state.mode === 'queue' ? ' scap-btn-active' : ''),
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

    // ------------------------------------------------------------------- body
    const inject = ['slots', 'connection']

    function apply(ctx) {
      rpcCtx = ctx
      // injectCss + section registration are fiber effects cleaned on unload.
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => injectCss(CSS), 'subagent-cap: styles')
      ctx.effect(() => slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'subagent-cap', order: 31, label: 'Subagent 上限' },
        SettingsSection,
      )), 'subagent-cap: settings section')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})