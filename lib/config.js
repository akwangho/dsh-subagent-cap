// dsh-subagent-cap — the plugin's live Config schema.
//
// Split out of lib/index.js so it can be unit-tested without the Host-only
// `@deepseek-ai/dsh-typert-protocol` dependency, and so the schema, the pure
// helpers in lib/pure.js, and the tests share one definition of the defaults.
//
// Why volatile
// ------------
// Every field is `.volatile()`. DSH's `settings` service projects ONLY volatile
// fields into an editable form (`volatileForm` in @deepseek-ai/dsh-settings), and
// the Loader commits a volatile change into the running references
// (`loader/volatile-update`) instead of remounting the plugin. That is what lets
// the settings page tighten or relax the cap while delegates are in flight and
// while queue waiters are being held — a remount would drop the allocator's
// inFlight counters and strand every held waiter.
//
// On an older Loader that does not know `volatile`, the flag is simply ignored:
// the schema still validates and still applies, only the form projection is a
// 0.2+ feature.

import { DEFAULTS, DEFAULT_MAX, Modes } from './pure.js'

/**
 * Build the plugin's Config schema.
 * @param {*} z - the schemastery module, injected so this file stays free of
 *   runtime dependencies and directly unit-testable.
 * @returns The Config schema object.
 */
export function configSchema(z) {
  return z.object({
    maxSubagents: z.number().default(DEFAULTS.maxSubagents).volatile(),
    mode: z.union([z.const('reject'), z.const('queue')]).default(DEFAULTS.mode).volatile(),
  })
}

/** The Config field names, in schema order. */
export const CONFIG_FIELDS = ['maxSubagents', 'mode']

/**
 * Settings namespace. MUST equal this plugin's profile entry id in
 * `cordis.patch.yml` (`id: subagent-cap`): DSH keys every settings form by that
 * entry id, and the browser half addresses the same string through
 * `ctx.configForms.get(...)`.
 */
export const NAMESPACE = 'subagent-cap'

/** Documented cap bounds, re-exported so callers need only this module. */
export { DEFAULT_MAX, Modes }
