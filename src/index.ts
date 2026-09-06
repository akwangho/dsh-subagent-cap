/**
 * dsh-subagent-cap — host half (TypeScript source of record; `lib/index.js` is
 * the compiled artifact the runtime loads).
 *
 * Strict per-session subagent concurrency cap with a real FIFO queue:
 *  - imperative model guidance via systemPrompt.context(),
 *  - pre-emptive gate at `tools/pre-execute` with in-flight slot accounting
 *    (parallel spawns cannot race past the cap),
 *  - queue mode holds the waterfall decision until a slot frees,
 *  - settings-backed persistence (~/.dsh/settings.yaml, namespace subagent-cap).
 */
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'dsh-subagent-cap'
// Only `subagents` is required (the gate reads running children from it).
// `systemPrompt` / `settings` are optional enhancements accessed via ctx.get()
// so a profile missing them still boots; `agents` was unused and is dropped.
// NOTE: this array MUST ALSO be visible as `apply.inject` (see bottom of file):
// the cordis loader unwraps the default export (the bare `apply` function) and
// reads `plugin.inject` off it — a named-only `export const inject` is discarded
// and the fiber starts with an empty inject map, crashing on `ctx.subagents`
// with `cannot get property "subagents" without inject`.
export const inject = ['subagents']

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

type Config = { maxSubagents: number; mode: 'reject' | 'queue' }

// ---- Remote decorator bookkeeping (hand-written) ----
const remoteInitializers: Array<(this: unknown) => void> = []
function declareRemote(method: string): void {
  const context: any = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: {},
    addInitializer(fn: (this: unknown) => void) { remoteInitializers.push(fn) },
  }
  Remote(method)(undefined, context)
}
declareRemote('getState')
declareRemote('setMax')
declareRemote('setMode')

class SubagentCapService extends TypertRemoteService {
  private readonly ctrl: any
  constructor(ctx: any, ctrl: any) {
    super(ctx, 'subagentCap')
    this.ctrl = ctrl
    for (const fn of remoteInitializers) fn.call(this)
  }
  getState() { return this.ctrl.getState() }
  setMax(maxSubagents: number) { return this.ctrl.setMax(maxSubagents) }
  setMode(mode: 'reject' | 'queue') { return this.ctrl.setMode(mode) }
}

function createController(ctx: any) {
  const subagents = ctx.subagents
  // Optional services: must NOT be in `inject` (which is all-required) and must
  // NOT be read via direct property access (that throws "without inject" when
  // undeclared). ctx.get() returns undefined when absent instead of throwing.
  const systemPrompt = ctx.get('systemPrompt')
  const settings = ctx.get('settings')

  let config: Config = { maxSubagents: DEFAULT_MAX, mode: 'reject' }

  function sanitize(value: any): Config {
    const max = Number(value && value.maxSubagents)
    const mode = value && value.mode === 'queue' ? 'queue' : 'reject'
    return {
      maxSubagents: Number.isFinite(max) ? Math.max(MIN_MAX, Math.min(MAX_MAX, Math.round(max))) : DEFAULT_MAX,
      mode,
    }
  }

  if (settings && typeof settings.installSection === 'function') {
    settings.installSection(ctx, NAMESPACE, SCHEMA, { maxSubagents: DEFAULT_MAX, mode: 'reject' }, {
      setSource: (current: () => Config) => { config = sanitize(current()) },
      onChange: () => { deliverAll() },
    })
  }

  async function updateSetting(patch: Partial<Config>) {
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
  const setMax = (maxSubagents: number) => updateSetting({ maxSubagents })
  const setMode = (mode: 'reject' | 'queue') => updateSetting({ mode: mode === 'queue' ? 'queue' : 'reject' })

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

  // ---- strict slot allocator + FIFO queue ----
  const counters = new Map<string, { inFlight: number; waiters: any[]; delivering: Promise<void> | null }>()
  const heldBy = new Map<string, string>()

  function counter(parentId: string) {
    let c = counters.get(parentId)
    if (!c) { c = { inFlight: 0, waiters: [], delivering: null }; counters.set(parentId, c) }
    return c
  }

  async function runningCount(parentId: string): Promise<number> {
    try {
      const children = await subagents.listChildren(parentId)
      return children.filter((c: any) => c && c.kind === 'child' && c.activity === 'running').length
    } catch {
      return 0
    }
  }

  // Release an admitted slot exactly once. Idempotent — safe to call from the
  // three possible settle paths (tool result, caller abort, waterfall reject).
  function releaseHeld(callId: unknown) {
    if (callId === undefined || callId === null) return
    const key = String(callId)
    const parentId = heldBy.get(key)
    if (parentId === undefined) return
    heldBy.delete(key)
    const c = counter(parentId)
    if (c.inFlight > 0) c.inFlight -= 1
    deliver(parentId)
  }

  function acquire(parentId: string, exec: any) {
    const c = counter(parentId)
    c.inFlight += 1
    const callId = exec && exec.callId
    if (callId !== undefined && callId !== null) {
      heldBy.set(String(callId), parentId)
      // If the caller aborts before dispatch completes, tools/result may never
      // fire — without this hook the slot would leak permanently.
      const signal = exec.signal
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => releaseHeld(callId), { once: true })
      }
    }
  }

  function maybeGC(parentId: string) {
    const c = counters.get(parentId)
    if (c && c.waiters.length === 0 && c.inFlight === 0) counters.delete(parentId)
  }

  async function deliverStep(parentId: string) {
    const c = counter(parentId)
    while (c.waiters.length > 0) {
      const running = await runningCount(parentId)
      if (running + c.inFlight >= Math.max(config.maxSubagents, 0)) return
      if (config.mode !== 'queue') {
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
        // A later rejection is NOT caught by the try/catch — release on it.
        Promise.resolve(decision).catch(() => releaseHeld(callId))
        w.resolve(decision)
      } catch {
        releaseHeld(callId)
        try { w.resolve({ kind: 'deny', reason: 'Subagent queue admission failed.' }) } catch { /* noop */ }
      }
    }
    maybeGC(parentId)
  }

  // Serialized per-parent so concurrent triggers never over-admit.
  function deliver(parentId: string) {
    const c = counter(parentId)
    c.delivering = (c.delivering || Promise.resolve())
      .then(() => deliverStep(parentId))
      .catch(() => {})
    return c.delivering
  }

  function deliverAll() {
    for (const parentId of Array.from(counters.keys())) deliver(parentId)
  }

  const offPre = ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    const toolName = exec && exec.name
    if (!toolName || !DELEGATE_TOOLS.has(toolName)) return next()
    const parentId = exec.agent && exec.agent.id ? String(exec.agent.id) : undefined
    if (!parentId) return next()

    const running = await runningCount(parentId)
    if (running + counter(parentId).inFlight < Math.max(config.maxSubagents, 0)) {
      acquire(parentId, exec)
      try {
        const decision = next()
        Promise.resolve(decision).catch(() => releaseHeld(exec.callId))
        return decision
      } catch (err) {
        releaseHeld(exec.callId)
        throw err
      }
    }

    if (config.mode !== 'queue') {
      noteRejection(parentId, toolName, 'over-limit')
      return {
        kind: 'deny',
        reason: 'Subagent cap reached (' + running + '/' + config.maxSubagents +
          ' running). A new subagent cannot be started now.',
      }
    }

    noteQueue(parentId, toolName)
    return await new Promise((resolve) => {
      const c = counter(parentId)
      const signal = exec && exec.signal
      const waiter = { exec, next, resolve, admitted: false }
      const onAbort = () => {
        const i = c.waiters.indexOf(waiter)
        if (i >= 0) {
          c.waiters.splice(i, 1)
          maybeGC(parentId)
          resolve({ kind: 'deny', reason: 'Subagent queue wait cancelled.' })
        }
        // If already admitted, acquire()'s abort hook releases the slot;
        // the promise was already settled by deliver().
      }
      const origResolve = resolve
      waiter.resolve = ((decision: any) => { waiter.admitted = true; origResolve(decision) }) as typeof resolve
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      c.waiters.push(waiter)
    })
  })

  const offResult = ctx.on('tools/result', (exec: any) => {
    const toolName = exec && exec.name
    if (!toolName || !DELEGATE_TOOLS.has(toolName)) return
    const callId = exec && exec.callId
    if (callId !== undefined && callId !== null) releaseHeld(callId)
  })

  const offEnd = ctx.on('subagent/end', () => { deliverAll() })

  const queueLog = new Map<string, { count: number; last: number; tool: string }>()
  const rejections: Array<{ time: number; sessionId: string; tool: string; reason: string }> = []
  function noteQueue(sessionId: string, tool: string) {
    const cur = queueLog.get(sessionId) || { count: 0, last: 0, tool }
    cur.count += 1
    cur.last = Date.now()
    cur.tool = tool
    queueLog.set(sessionId, cur)
  }
  function noteRejection(sessionId: string, tool: string, reason: string) {
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

export function apply(ctx: any) {
  const controller = createController(ctx)
  new SubagentCapService(ctx, controller)
  return controller.dispose
}

// The cordis plugin loader normalizes modules via unwrapExports():
//   exports = exports.default ?? exports
// i.e. when a default export exists it is used AS the plugin and
// `plugin.inject` is read off it. A named-only `export const inject` is then
// invisible and the fiber boots with no injects, so the first `ctx.subagents`
// read throws `cannot get property "subagents" without inject` and takes down
// the whole profile boot (dsh: plugin tree failed to load). Attaching the same
// array to the function keeps BOTH shapes working:
//   - namespace path (no-default consumers):  module.inject
//   - default path (loader):                  module.default.inject
// The sibling plugin dsh-plugin-fallback-continue avoids this by having NO
// default export; we keep ours for back-compat but mirror inject onto it.
;(apply as any).inject = inject
try {
  // Give the default path a proper plugin identity too: without this the
  // loader sees function name "apply" and records runtime.name as undefined.
  // Function `name` is configurable, so redefining it is safe.
  Object.defineProperty(apply, 'name', { value: name, configurable: true })
} catch { /* noop — cosmetic only */ }

export default apply
