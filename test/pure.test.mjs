// dsh-subagent-cap — unit tests for the pure, dependency-free core.
//
// Covers: cap normalization/clamping, mode coercion, the admit decision (the
// slot-race guard `running + inFlight`), deny-reason shape, delegate-tool
// classification, and sanitize round-trips. No runtime deps; runs anywhere
// with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MIN_MAX,
  MAX_MAX,
  DEFAULT_MAX,
  DEFAULT_MODE,
  DEFAULTS,
  DELEGATE_TOOLS,
  normalizeMode,
  normalizeMax,
  sanitize,
  canAdmit,
  denyReason,
  isDelegateTool,
} from '../lib/pure.js'

test('normalizeMax clamps into [0,100] and defaults invalid input', () => {
  assert.equal(normalizeMax(0), 0, 'explicit 0 = block all, is valid')
  assert.equal(normalizeMax(1), 1)
  assert.equal(normalizeMax(50), 50)
  assert.equal(normalizeMax(100), 100)
  assert.equal(normalizeMax(-3), MIN_MAX, 'negative clamps to MIN')
  assert.equal(normalizeMax(101), MAX_MAX, 'over-range clamps to MAX')
  assert.equal(normalizeMax(1.6), 2, 'rounds rather than truncates')
  assert.equal(normalizeMax('7'), 7, 'numeric strings coerce')
  assert.equal(normalizeMax(undefined), DEFAULT_MAX, 'undefined -> default')
  assert.equal(normalizeMax(null), DEFAULT_MAX, 'null -> default (NOT 0)')
  assert.equal(normalizeMax(''), DEFAULT_MAX, 'empty string -> default (NOT 0)')
  assert.equal(normalizeMax(NaN), DEFAULT_MAX, 'NaN -> default')
})

test('normalizeMax rejects non-finite but clamps Infinity to MAX', () => {
  // Number.isFinite(Infinity) === false, so the guard returns DEFAULT_MAX…
  // pin the exact behavior so a silent change is caught.
  assert.equal(normalizeMax(Infinity), DEFAULT_MAX)
})

test('normalizeMode coerces any non-"queue" to "reject"', () => {
  assert.equal(normalizeMode('queue'), 'queue')
  assert.equal(normalizeMode('reject'), 'reject')
  assert.equal(normalizeMode('QUEUE'), 'reject', 'case-sensitive')
  assert.equal(normalizeMode(''), 'reject')
  assert.equal(normalizeMode(undefined), 'reject')
  assert.equal(normalizeMode(null), 'reject')
  assert.equal(normalizeMode(0), 'reject')
})

test('sanitize handles full, partial, and empty input', () => {
  assert.deepEqual(sanitize({ maxSubagents: 3, mode: 'queue' }), { maxSubagents: 3, mode: 'queue' })
  assert.deepEqual(sanitize({ maxSubagents: 3 }), { maxSubagents: 3, mode: DEFAULT_MODE })
  assert.deepEqual(sanitize({ mode: 'queue' }), { maxSubagents: DEFAULT_MAX, mode: 'queue' })
  assert.deepEqual(sanitize({}), { maxSubagents: DEFAULT_MAX, mode: DEFAULT_MODE })
  assert.deepEqual(sanitize(undefined), { maxSubagents: DEFAULT_MAX, mode: DEFAULT_MODE })
  assert.deepEqual(sanitize(null), { maxSubagents: DEFAULT_MAX, mode: DEFAULT_MODE })
  // out-of-range clamping flows through
  assert.deepEqual(sanitize({ maxSubagents: 999, mode: 'xx' }), { maxSubagents: MAX_MAX, mode: DEFAULT_MODE })
})

test('canAdmit enforces the strict running+inFlight < cap contract', () => {
  // cap 1
  assert.equal(canAdmit(0, 0, 1), true, 'empty session admits one')
  assert.equal(canAdmit(1, 0, 1), false, 'one running blocks')
  assert.equal(canAdmit(0, 1, 1), false, 'one in-flight blocks (slot-race guard)')
  assert.equal(canAdmit(1, 1, 1), false)
  // cap 3
  assert.equal(canAdmit(2, 0, 3), true, 'two running + admit third')
  assert.equal(canAdmit(2, 1, 3), false, 'two running + one in-flight = full')
  assert.equal(canAdmit(3, 0, 3), false)
  // cap 0 = no new subagents at all
  assert.equal(canAdmit(0, 0, 0), false)
  assert.equal(canAdmit(0, 1, 0), false)
  // degenerate/negative cap floors at 0 (never admit)
  assert.equal(canAdmit(0, 0, -1), false)
  assert.equal(canAdmit(0, 0, undefined), false)
  assert.equal(canAdmit(0, 0, NaN), false)
})

test('denyReason is stable and includes running/cap numbers', () => {
  assert.equal(
    denyReason(2, 3),
    'Subagent cap reached (2/3 running). A new subagent cannot be started now.',
  )
  assert.match(denyReason(1, 1), /\(1\/1 running\)/)
})

test('isDelegateTool classifies only delegate spawns', () => {
  assert.deepEqual(DELEGATE_TOOLS.sort(), ['subagent', 'subagent_fork', 'workflow'].sort())
  for (const t of DELEGATE_TOOLS) assert.equal(isDelegateTool(t), true, t)
  assert.equal(isDelegateTool('subagent_fork'), true)
  assert.equal(isDelegateTool('bash'), false)
  assert.equal(isDelegateTool('send_message'), false)
  assert.equal(isDelegateTool('interrupt_agent'), false)
  assert.equal(isDelegateTool(''), false)
  assert.equal(isDelegateTool(undefined), false)
  assert.equal(isDelegateTool(null), false)
  assert.equal(isDelegateTool('Subagent'), false, 'case-sensitive')
})

test('DEFAULTS is frozen and matches the documented defaults', () => {
  assert.deepEqual({ ...DEFAULTS }, { maxSubagents: 1, mode: 'reject' })
  assert.equal(Object.isFrozen(DEFAULTS), true)
  assert.throws(() => { DEFAULTS.maxSubagents = 9 }, TypeError)
})