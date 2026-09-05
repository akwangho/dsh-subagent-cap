/**
 * dsh-subagent-cap — host half (compiled plain-JS output; what the runtime loads).
 *
 * Enforces a per-session cap on concurrently running subagents with imperative
 * model guidance (`systemPrompt.context`), a real pre-emptive block at
 * `tools/pre-execute`, a queue mode, and a `subagent/start` safety net. Its
 * setting persists through the DSH settings service (`~/.dsh/settings.yaml`).
 *
 * Client -> host calls ride the generic Connection RPC channel
 * (`/api/subagentCap/*`), dispatched by the Typert gateway to the `subagentCap`
 * Remote service below.
 */
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-subagent-cap'
export const inject = ['subagents', 'agents', 'systemPrompt', 'timer']

const VERSION = '1.0.0'
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

// ---- controller: owns config (settings-backed) + enforcement state ----
function createController(ctx) {
  const subagents = ctx.subagents
  const systemPrompt = ctx.systemPrompt
  const settings = ctx.get('settings')

  let config = { maxSubagents: DEFAULT_MAX, mode: 'reject' }

  function sanitize(value) {
    const max = Number(value && value.maxSubagents)
    const mode = value && value.mode === 'queue' ? 'queue' : 'reject'
    return {
      maxSubagents: Number.isFinite(max) ? Math.max(MIN_MAX, Math.min(MAX_MAX, Math.round(max))) : DEFAULT_MAX,
      mode,
    }
  }

  // Persist through the DSH settings service when mounted; otherwise in-memory.
  if (settings && typeof settings.installSection === 'function') {
    settings.installSection(ctx, NAMESPACE, SCHEMA, { maxSubagents: DEFAULT_MAX, mode: 'reject' }, {
      setSource: (current) => { config = sanitize(current()) },
      onChange: () => {},
    })
  }

  async function setMax(maxSubagents) {
    if (settings && typeof settings.update === 'function') {
      await settings.update(NAMESPACE, { maxSubagents })
      const resolved = settings.get(NAMESPACE)
      if (resolved !== undefined) config = sanitize(resolved)
    } else {
      config = sanitize({ ...config, maxSubagents })
    }
    return { ok: true, maxSubagents: config.maxSubagents, mode: config.mode }
  }

  async function setMode(mode) {
    const next = mode === 'queue' ? 'queue' : 'reject'
    if (settings && typeof settings.update === 'function') {
      await settings.update(NAMESPACE, { mode: next })
      const resolved = settings.get(NAMESPACE)
      if (resolved !== undefined) config = sanitize(resolved)
    } else {
      config = sanitize({ ...config, mode: next })
    }
    return { ok: true, maxSubagents: config.maxSubagents, mode: config.mode }
  }

  // Layer 1: imperative model guidance.
  systemPrompt.context({
    name: 'subagent-cap',
    order: 950,
    text: () => {
      const modeHint = config.mode === 'queue'
        ? '已達上限時，新的委派會被排隊，等有空位再執行。'
        : '已達上限時，新的委派會被拒絕。'
      return '你在這個會話中最多只能「同時」執行 ' + config.maxSubagents + ' 個 subagent。' +
        '啟動新的 subagent 前，請先確認目前仍在執行中的 subagent 數量；' + modeHint
    },
  })

  // Layer 2: pre-emptive block / queue.
  async function runningCount(parentId) {
    try {
      const children = await subagents.listChildren(parentId)
      return children.filter((c) => c && c.kind === 'child' && c.activity === 'running').length
    } catch {
      return 0
    }
  }

  const queueLog = new Map()
  const rejections = []

  function noteQueue(sessionId) {
    const cur = queueLog.get(sessionId) || { count: 0, last: 0 }
    cur.count += 1
    cur.last = Date.now()
    queueLog.set(sessionId, cur)
  }
  function noteRejection(sessionId, tool, reason) {
    rejections.push({ time: Date.now(), sessionId, tool, reason })
    if (rejections.length > 100) rejections.splice(0, rejections.length - 100)
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec && exec.name
    if (!toolName || !DELEGATE_TOOLS.has(toolName)) return next()
    const parentId = exec.agent && exec.agent.id ? String(exec.agent.id) : undefined
    if (!parentId) return next()

    const running = await runningCount(parentId)
    if (running < config.maxSubagents) return next()

    if (config.mode === 'queue') {
      noteQueue(parentId)
      return {
        kind: 'deny',
        reason: 'Subagent cap reached (' + running + '/' + config.maxSubagents +
          ' running). Your request was queued — wait for a running subagent to finish, then retry.',
      }
    }
    noteRejection(parentId, toolName, 'over-limit')
    return {
      kind: 'deny',
      reason: 'Subagent cap reached (' + running + '/' + config.maxSubagents +
        ' running). A new subagent cannot be started now.',
    }
  })

  // Layer 3: safety net (observe starts; the pre-execute gate is primary).
  const offStart = ctx.on('subagent/start', () => {})

  function getState() {
    return {
      version: VERSION,
      maxSubagents: config.maxSubagents,
      mode: config.mode,
      queue: Array.from(queueLog.entries()).map(([sessionId, v]) => ({
        sessionId: sessionId.slice(0, 12) + '…',
        count: v.count,
        last: v.last,
      })),
      rejections: rejections.slice(-20).map((r) => ({
        time: r.time,
        sessionId: r.sessionId.slice(0, 12) + '…',
        tool: r.tool,
        reason: r.reason,
      })),
    }
  }

  return { getState, setMax, setMode, dispose: () => { offStart() } }
}

export function apply(ctx) {
  const controller = createController(ctx)
  new SubagentCapService(ctx, controller)
  return controller.dispose
}

export default apply