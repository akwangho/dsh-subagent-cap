/**
 * dsh-subagent-cap — browser half (TypeScript source of record).
 *
 * Mirrors `lib/client.js` (the plain-JS artifact the runtime loads). Registers a
 * settings section that reads/writes the host Remote service via the Connection
 * RPC channel (`/api`, endpoint `subagentCap/*`).
 */
declare const window: any

export const apply = (ctx: any): void => {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  // See lib/client.js for the concrete React implementation.
  void slots
}

export const inject = ['slots', 'connection']