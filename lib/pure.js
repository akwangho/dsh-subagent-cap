/**
 * dsh-subagent-cap — pure, dependency-free core.
 *
 * Everything here is a deterministic function of its inputs, so it can be unit
 * tested with `node --test` from the repo (no runtime deps). `lib/index.js`
 * glues these onto the Cordis services / events that need them.
 */

export const MIN_MAX = 0
export const MAX_MAX = 100
export const DEFAULT_MAX = 1
export const DEFAULT_MODE = 'reject'

export const Modes = ['reject', 'queue']

/** Tool names whose execution spawns a subagent (and thus counts toward the cap). */
export const DELEGATE_TOOLS = ['subagent', 'subagent_fork', 'workflow']

export const DEFAULTS = Object.freeze({ maxSubagents: DEFAULT_MAX, mode: DEFAULT_MODE })

/** Coerce an arbitrary string/unknown into one of the two supported modes. */
export function normalizeMode(mode) {
  return mode === 'queue' ? 'queue' : 'reject'
}

/** Coerce a numeric max into the inclusive [MIN_MAX, MAX_MAX] range, or the default. */
export function normalizeMax(value) {
  // null/undefined/'' are "unspecified" — must NOT coerce to 0 (Number(null)===0
  // and Number('')===0 would silently turn "absent" into "cap 0 = block all").
  if (value === undefined || value === null || value === '') return DEFAULT_MAX
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(MIN_MAX, Math.min(MAX_MAX, Math.round(n))) : DEFAULT_MAX
}

/** Apply both coercions atomically, tolerating `undefined`/partial input. */
export function sanitize(value) {
  return {
    maxSubagents: normalizeMax(value && value.maxSubagents),
    mode: normalizeMode(value && value.mode),
  }
}

/**
 * A delegate may be admitted only when effective occupancy (running children +
 * already-admitted-but-unsettled `inFlight`) is strictly below the cap.
 * `maxSubagents` may be 0 (no new subagents at all) or unclamped; we clamp to
 * a floor so the `>= max` comparison behaves for degenerate inputs.
 */
export function canAdmit(running, inFlight, maxSubagents) {
  return (running + inFlight) < Math.max(Number(maxSubagents) || 0, 0)
}

/** Reject-mode denial message shown to the model/runtime when over the cap. */
export function denyReason(running, maxSubagents) {
  return (
    `Subagent cap reached (${running}/${maxSubagents} running). ` +
    'A new subagent cannot be started now.'
  )
}

/** Mark a delegate-tool name. Mirrors the exported DELEGATE_TOOLS list. */
export function isDelegateTool(name) {
  return typeof name === 'string' && DELEGATE_TOOLS.includes(name)
}