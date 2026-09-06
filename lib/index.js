/**
 * dsh-subagent-cap — host half (compiled plain-JS output; what the runtime loads).
 *
 * Enforces a per-session cap on concurrently running subagents with:
 *   1) imperative model guidance via systemPrompt.context(),
 *   2) a REAL pre-emptive gate at `tools/pre-execute` — an in-flight-aware slot
 *      allocator so two parallel spawns cannot race past the cap,
 *   3) a true FIFO queue mode: the pre-execute waterfall promise is HELD until a
 *      slot frees (subagent/end or the gate's own settle) instead of denied,
 *   4) settings-backed persistence of { maxSubagents, mode } (settings.yaml).
 *
 * Client -> host calls ride the generic Connection RPC channel
 * (`/api/subagentCap/*`), dispatched by the Typert gateway to the `subagentCap`
 * Remote service below.
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-subagent-cap'
export const inject = ['subagents', 'agents', 'systemPrompt', 'settings']

const VERSION = '1.2.0'
const NAMESPACE = 'subagent-cap'
const DELEGATE_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow'])
const DEFAULT_MAX = 1
const MIN_MAX = 0
const MAX_MAX = 100

const SCHEMA = z.object({
  maxSubagents: z.number().default(DEFAULT_MAX),
  mode: z.union([z.const('reject'), z.const('queue')]).default('reject'),
})

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
declareRemote('setMax')
declareRemote('setMode')

class SubagentCapService extends TypertRemoteService {
  constructor(ctx, ctrl) {
    super(ctx, 'subagentCap')
    this.ctrl = ctrl
    for (const fn of remoteInitializers) fn.call(this)
  }

  getState() { return this.ctrl.getState() }
  setMax(maxSubagents) { return this.ctrl.setMax(maxSubagents) }
  setMode(mode) { return this.ctrl.setMode(mode) }
}

// ---- controller: owns config (settings-backed) + the slot allocator ----
function createController(ctx) {
  const subagents = ctx.subagents
  const systemPrompt = ctx.systemPrompt
  const settings = ctx.settings

  let config = { maxSubagents: DEFAULT_MAX, mode: 'reject' }

  function sanitize(value) {
    const max = Number(value && value.maxSubagents)
    const mode = value && value.mode === 'queue' ? 'queue' : 'reject'
    return {
      maxSubagents: Number.isFinite(max) ? Math.max(MIN_MAX, Math.min(MAX_MAX, Math.round(max))) : DEFAULT_MAX,
      mode,
    }
  }

  // Persist through the DSH settings service; a live editor of settings.yaml
  // updates the source through `onChange`.
  if (settings && typeof settings.installSection === 'function') {
    settings.installSection(ctx, NAMESPACE, SCHEMA, { maxSubagents: DEFAULT_MAX, mode: 'reject' }, {
      setSource: (current) => { config = sanitize(current()) },
      onChange: () => { deliverAll() },
    })
  }

  async function updateSetting(patch) {
    if (settings && typeof settings.update === 'function') {
      await settings.update(NAMESPACE, patch)
      const resolved = settings.get(NAMESPACE)
      if (resolved !== undefined) config = sanitize(resolved)
    } else {
      config = sanitize({ ...config, ...patch })
    }
    deliverAll()
    return { ok: true, maxSubagents: config.maxSubagents, mode: config.mode }
  }

  function setMax(maxSubagents) { return updateSetting({ maxSubagents }) }
  function setMode(mode) { return updateSetting({ mode: mode === 'queue' ? 'queue' : 'reject' }) }

  // ---- Layer 1: imperative model guidance ----
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
      const running = await runningCount(parentId)
      // Effective occupancy for the decision doesn't include the waiter itself
      // yet (it is neither running nor inFlight until we admit it).
      if (running + c.inFlight >= Math.max(config.maxSubagents, 0)) return
      if (config.mode !== 'queue') {
        // Mode flipped to reject while waiters are held: deny them, never hang.
        const held = c.waiters.splice(0)
        for (const w of held) {
          try { w.resolve({ kind: 'deny', reason: 'subagent-cap switched to reject mode' }) } catch { /* noop */ }
        }
        maybeGC(parentId)
        return
      }
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
    if (!toolName || !DELEGATE_TOOLS.has(toolName)) return next()
    const parentId = exec.agent && exec.agent.id ? String(exec.agent.id) : undefined
    if (!parentId) return next()

    const running = await runningCount(parentId)
    if (running + counter(parentId).inFlight < Math.max(config.maxSubagents, 0)) {
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
      return {
        kind: 'deny',
        reason: 'Subagent cap reached (' + running + '/' + config.maxSubagents +
          ' running). A new subagent cannot be started now.',
      }
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
    const toolName = exec && exec.name
    if (!toolName || !DELEGATE_TOOLS.has(toolName)) return
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

  return { getState, setMax, setMode, dispose }
}

export function apply(ctx) {
  const controller = createController(ctx)
  new SubagentCapService(ctx, controller)
  return controller.dispose
}

export default apply
