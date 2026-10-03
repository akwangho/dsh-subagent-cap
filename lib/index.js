/**
 * dsh-subagent-cap — host half (compiled plain-JS output; what the runtime loads).
 *
 * Enforces a per-session cap on concurrently running subagents with:
 *   1) imperative model guidance via systemPrompt.context(),
 *   2) a REAL pre-emptive gate at `tools/pre-execute` — an in-flight-aware slot
 *      allocator so two parallel spawns cannot race past the cap,
 *   3) a true FIFO queue mode: the pre-execute waterfall promise is HELD until a
 *      slot frees (subagent/end or the gate's own settle) instead of denied,
 *   4) settings-backed persistence of { maxSubagents, mode } as ordinary
 *      VOLATILE plugin Config, so DSH writes it into the profile's
 *      cordis.patch.yml and an edit applies live (see lib/config.js).
 *
 * Client -> host calls ride the generic Connection RPC channel
 * (`/api/subagentCap/*`), dispatched by the Typert gateway to the `subagentCap`
 * Remote service below. Session/allocator state travels that path; CONFIGURATION
 * does not — the browser half edits the Host's own settings form.
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULTS,
  DEFAULT_MAX,
  canAdmit,
  denyReason,
  isDelegateTool,
  sanitize,
} from './pure.js'
import { configSchema, CONFIG_FIELDS, NAMESPACE } from './config.js'

export const name = 'dsh-subagent-cap'
// Only `subagents` is required (the gate reads running children from it).
// `systemPrompt` / `settings` are optional enhancements accessed via ctx.get()
// so a profile missing them still boots; `agents` was unused and is dropped.
// This stays a NAMED export and the module deliberately has no default export,
// so the Loader keeps the module namespace and reads `inject`, `name` and
// `Config` off it — see the note at the bottom of this file.
export const inject = ['subagents']

const VERSION = '1.3.2'

/**
 * Live plugin configuration. The schema lives in lib/config.js (dependency-free,
 * unit-tested); see there for why every field is volatile.
 */
export const Config = configSchema(z)

export { CONFIG_FIELDS, NAMESPACE }

// ---- Remote marker bookkeeping (hand-written `@Remote` decorator runtime) ----
const remoteInitializers = []
function declareRemote(method) {
  const context = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: {},
    addInitializer(fn) {
      remoteInitializers.push(fn)
    },
  }
  Remote(method)(undefined, context)
}
declareRemote('getState')

class SubagentCapService extends TypertRemoteService {
  constructor(ctx, ctrl) {
    super(ctx, 'subagentCap')
    this.ctrl = ctrl
    for (const fn of remoteInitializers) fn.call(this)
  }

  getState() { return this.ctrl.getState() }
}

// ---- controller: owns config (volatile Config) + the slot allocator ----
// `deps.config` is the Loader-parsed Config (one reference per field, read with
// `.get()`), injected by apply so this stays testable without a Loader.
function createController(ctx, deps = {}) {
  const subagents = ctx.subagents
  // Optional services: must NOT be in `inject` (which is all-required) and must
  // NOT be read via direct property access (that throws "without inject" when
  // undeclared). ctx.get() returns undefined when absent instead of throwing.
  const systemPrompt = ctx.get('systemPrompt')

  // Live configuration source (v1.3.0) -------------------------------------
  //
  // Config is declared volatile in lib/config.js, so the Loader owns it: the
  // profile patch is the single source of truth, DSH's `settings` service
  // projects the fields into a form, and the browser half writes them through
  // `configForms`. This controller only READS. That replaces the removed
  // `settings.installSection` API, which no longer exists in DSH 0.2 and left
  // the cap unable to survive a restart.
  //
  // Each field arrives as a cordis reference (`.get()`); a plain value is also
  // accepted so the controller stays unit-testable without a Loader.
  const configRefs = deps.config || {}
  const readField = (field) => {
    const ref = configRefs[field]
    if (ref == null) return undefined
    if (typeof ref === 'object' && typeof ref.get === 'function') {
      try {
        return ref.get()
      } catch (_) {
        return undefined
      }
    }
    return ref
  }
  const readConfig = () => sanitize({
    maxSubagents: readField('maxSubagents'),
    mode: readField('mode'),
  })

  let config = readConfig()

  // Re-read after any committed volatile change, then release any queue waiters
  // a mode flip to 'reject' makes unadmittable. `deliverAll` is a function
  // declaration below, so hoisting covers it; the allocator Maps it touches are
  // initialized before any event can fire.
  function adoptConfig() {
    config = readConfig()
    deliverAll()
  }

  // Tell DSH's settings service that this plugin ships its own settings section,
  // so it does not ALSO auto-generate a page from the same volatile fields.
  // Skipped — not fatal — when the service is absent (DSH 0.1.x).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx && settingsCtx.settings
      if (!settings || typeof settings.configure !== 'function') return
      try {
        settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber))
      } catch (err) {
        console.error('subagent-cap: settings page policy unavailable:', String(err))
      }
    })
  }
  if (typeof ctx.on === 'function') {
    // Loader: volatile values were committed into the running references.
    ctx.on('loader/volatile-update', () => adoptConfig())
    // Settings service: this entry's form values or availability changed.
    ctx.on('settings/document-updated', (ns) => {
      if (ns === undefined || String(ns) === NAMESPACE) adoptConfig()
    })
  }

  // ---- Layer 1: imperative model guidance ----
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    systemPrompt.context({
      name: 'subagent-cap',
      order: 950,
      text: () => {
        const modeHint = config.mode === 'queue'
          ? '已達上限時，新的委派會被排隊等待，等有空位自動執行，不用重試。'
          : '已達上限時，新的委派會被拒絕，請等現有 subagent 完成後再嘗試。'
        return '你在這個會話中最多只能「同時」執行 ' + config.maxSubagents + ' 個 subagent。' +
          '啟動新的 subagent 前，請先確認目前仍在執行中的 subagent 數量；' + modeHint
      },
    })
  }

  // ---- Layer 2: strict slot allocator + true FIFO queue ----
  //
  // `running()` alone races: two delegates can both observe "1 free slot"
  // before either spawn lands. So we keep a per-parent `inFlight` count of
  // admitted-but-not-yet-settled spawns, correlated by tool callId, and count
  // occupancy as running + inFlight. inFlight is released on `tools/result`
  // for that exact call (by then the child is counted in `running`, or the
  // spawn failed and the slot is genuinely free again).
  //
  // maps parentId -> { inFlight: number, waiters: Waiter[], delivering }
  const counters = new Map()
  // tool callId -> parentId, so tools/result can release the exact slot.
  const heldBy = new Map()
  function counter(parentId) {
    let c = counters.get(parentId)
    if (!c) { c = { inFlight: 0, waiters: [], delivering: null }; counters.set(parentId, c) }
    return c
  }

  async function runningCount(parentId) {
    try {
      const children = await subagents.listChildren(parentId)
      return children.filter((c) => c && c.kind === 'child' && c.activity === 'running').length
    } catch {
      return 0
    }
  }

  // Release an admitted slot exactly once. Idempotent — safe to call from the
  // three possible settle paths (tool result, caller abort, waterfall reject).
  function releaseHeld(callId) {
    if (callId === undefined || callId === null) return
    const key = String(callId)
    const parentId = heldBy.get(key)
    if (parentId === undefined) return
    heldBy.delete(key)
    const c = counter(parentId)
    if (c.inFlight > 0) c.inFlight -= 1
    deliver(parentId)
  }

  function acquire(parentId, exec) {
    const c = counter(parentId)
    c.inFlight += 1
    const callId = exec && exec.callId
    if (callId !== undefined && callId !== null) {
      heldBy.set(String(callId), parentId)
      // If the caller aborts before dispatch completes, the waterfall may drop
      // our decision without ever emitting tools/result — release must not
      // depend on the result event alone, or the slot leaks permanently.
      const signal = exec.signal
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => releaseHeld(callId), { once: true })
      }
    }
  }

  // A slot was freed — admit queued waiters in FIFO order while there is room.
  // Serialized per-parent through a promise chain: concurrent triggers
  // (subagent/end + tools/result + settings change) must not both observe the
  // same free slot and admit two waiters over the cap.
  async function deliverStep(parentId) {
    const c = counter(parentId)
    while (c.waiters.length > 0) {
      // The mode check comes FIRST, before occupancy. "reject" means "do not
      // hold anything", so a mode flip must release the waiters immediately even
      // while the cap is still full. Checking occupancy first returned early and
      // left them queued behind the cap until a slot happened to free — the user
      // flips to reject and the delegate stays hung, which is the exact wedge
      // this plugin is supposed to avoid.
      if (config.mode !== 'queue') {
        const held = c.waiters.splice(0)
        for (const w of held) {
          try { w.resolve({ kind: 'deny', reason: 'subagent-cap switched to reject mode' }) } catch { /* noop */ }
        }
        maybeGC(parentId)
        return
      }
      const running = await runningCount(parentId)
      // Effective occupancy for the decision doesn't include the waiter itself
      // yet (it is neither running nor inFlight until we admit it).
      if (!canAdmit(running, c.inFlight, config.maxSubagents)) return
      const w = c.waiters.shift()
      if (!w) return
      const callId = w.exec && w.exec.callId
      acquire(parentId, w.exec)
      try {
        const decision = w.next()
        // next() resolving to a rejected promise later is NOT caught by the
        // try/catch below — attach a rejection cleanup explicitly.
        Promise.resolve(decision).catch(() => releaseHeld(callId))
        w.resolve(decision) // admits the held delegate call
      } catch (err) {
        releaseHeld(callId)
        try { w.resolve({ kind: 'deny', reason: 'Subagent queue admission failed.' }) } catch { /* noop */ }
      }
    }
    maybeGC(parentId)
  }

  function maybeGC(parentId) {
    const c = counters.get(parentId)
    if (c && c.waiters.length === 0 && c.inFlight === 0) counters.delete(parentId)
  }

  function deliver(parentId) {
    const c = counter(parentId)
    c.delivering = (c.delivering || Promise.resolve())
      .then(() => deliverStep(parentId))
      .catch(() => {})
    return c.delivering
  }

  function deliverAll() {
    for (const parentId of Array.from(counters.keys())) deliver(parentId)
  }

  const offPre = ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec && exec.name
    if (!isDelegateTool(toolName)) return next()
    const parentId = exec.agent && exec.agent.id ? String(exec.agent.id) : undefined
    if (!parentId) return next()

    const running = await runningCount(parentId)
    if (canAdmit(running, counter(parentId).inFlight, config.maxSubagents)) {
      acquire(parentId, exec)
      try {
        const decision = next()
        // If the waterfall or the spawn later rejects, release the slot —
        // otherwise a failed admission leaks inFlight permanently.
        Promise.resolve(decision).catch(() => releaseHeld(exec.callId))
        return decision
      } catch (err) {
        releaseHeld(exec.callId)
        throw err
      }
    }

    // Over the cap.
    if (config.mode !== 'queue') {
      noteRejection(parentId, toolName, 'over-limit')
      return { kind: 'deny', reason: denyReason(running, config.maxSubagents) }
    }

    // Real queue: hold the waterfall decision until a slot frees or the caller
    // cancels. The runtime never abandons a pending pre-execute promise.
    noteQueue(parentId, toolName)
    return await new Promise((resolve) => {
      const c = counter(parentId)
      const signal = exec && exec.signal
      const waiter = { exec, next, resolve, admitted: false }
      const onAbort = () => {
        const i = c.waiters.indexOf(waiter)
        if (i >= 0) {
          // Still queued: remove and deny — nothing was admitted for it.
          c.waiters.splice(i, 1)
          maybeGC(parentId)
          resolve({ kind: 'deny', reason: 'Subagent queue wait cancelled.' })
        } else if (waiter.admitted) {
          // Already admitted: the slot was taken by acquire(); let the
          // abort-hook installed there release it. Nothing to resolve —
          // deliver() already settled this promise with next()'s decision.
        }
      }
      // Wrap resolve so we can tell whether admission already happened.
      const origResolve = resolve
      waiter.resolve = (decision) => { waiter.admitted = true; origResolve(decision) }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      c.waiters.push(waiter)
    })
  })

  // Release a held slot when the delegate tool settles (success or error).
  const offResult = ctx.on('tools/result', (exec) => {
    if (!isDelegateTool(exec && exec.name)) return
    const callId = exec && exec.callId
    if (callId !== undefined && callId !== null) releaseHeld(callId)
  })

  // A child settled => a running slot freed.
  const offEnd = ctx.on('subagent/end', () => { deliverAll() })

  const queueLog = new Map()
  const rejections = []
  function noteQueue(sessionId, tool) {
    const cur = queueLog.get(sessionId) || { count: 0, last: 0, tool }
    cur.count += 1
    cur.last = Date.now()
    cur.tool = tool
    queueLog.set(sessionId, cur)
  }
  function noteRejection(sessionId, tool, reason) {
    rejections.push({ time: Date.now(), sessionId, tool, reason })
    if (rejections.length > 100) rejections.splice(0, rejections.length - 100)
  }

  function getState() {
    return {
      version: VERSION,
      maxSubagents: config.maxSubagents,
      mode: config.mode,
      queue: Array.from(queueLog.entries()).map(([sessionId, v]) => ({
        sessionId: sessionId.slice(0, 12) + '…',
        count: v.count,
        tool: v.tool,
        last: v.last,
      })),
      waiters: Array.from(counters.entries())
        .filter(([, c]) => c.waiters.length > 0 || c.inFlight > 0)
        .map(([parentId, c]) => ({
          sessionId: parentId.slice(0, 12) + '…',
          inFlight: c.inFlight,
          waiting: c.waiters.length,
        })),
      rejections: rejections.slice(-20).map((r) => ({
        time: r.time,
        sessionId: r.sessionId.slice(0, 12) + '…',
        tool: r.tool,
        reason: r.reason,
      })),
    }
  }

  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    offPre()
    offResult()
    offEnd()
    // Fail any held queue waiters so a plugin stop cannot wedge the loop.
    for (const [, c] of counters) {
      for (const w of c.waiters) {
        try { w.resolve({ kind: 'deny', reason: 'subagent-cap plugin stopped' }) } catch { /* noop */ }
      }
      c.waiters.length = 0
    }
    counters.clear()
    heldBy.clear()
  }

  return { getState, dispose }
}

export function apply(ctx, config) {
  // `config` is the documented channel for the Loader-parsed Config; fall back
  // to a context-exposed `ctx.config`, and finally to nothing — the controller
  // then normalizes DEFAULTS rather than throwing, so an unexpected loader shape
  // degrades to "default cap" instead of taking the plugin down.
  const refs = config !== undefined && config !== null
    ? config
    : (ctx && ctx.config !== undefined ? ctx.config : undefined)
  const controller = createController(ctx, { config: refs })
  new SubagentCapService(ctx, controller)
  return controller.dispose
}

// NO default export, on purpose.
//
// The Loader normalizes a module through `unwrapExports()`:
//     exports = exports.default ?? exports
// so a default export REPLACES the module namespace with whatever it points at.
// This plugin used to `export default apply`, which made the runtime the bare
// `apply` function — and then `Config`, `name` and `inject`, which live on the
// namespace, were invisible to the loader. The visible symptom was silent: DSH
// reported this entry's config as `unknownConfig`, so no volatile form was
// projected and the settings section could not save anything. `apply.inject` was
// already mirrored by hand for the same reason; mirroring `Config` too would only
// treat the symptom, since every future export would have to be remembered.
//
// Exporting only named bindings lets the loader use the module namespace, where
// `apply`, `inject`, `name` and `Config` all live — the same shape the sibling
// dsh-subagent-cap / dsh-fallback-continue plugins use.
