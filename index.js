/**
 * Host half of the session-delete bundle.
 *
 * One authenticated Fetch route owns the destructive operation: it removes the
 * stored log directory of one Session, plus the directories of its subagent
 * descendants, from disk. The Client half owns the row action and the
 * confirmation dialog.
 *
 * Two delivery modes, because a Session that any Agent still holds cannot be
 * erased underneath it — its log handle is open and the live Session is listed
 * from memory, so a delete would be undone by the next write:
 *
 * - **Immediate**: a Session with no live Agent is removed now, and the Client
 *   drops the row through the `api-session/removed` broadcast.
 * - **Queued**: a Session that is open (or still running) is recorded in a
 *   pending list and removed by the next Host start, before anything attaches
 *   to it. The route reports `restartRequired`, and the dialog says so.
 *
 * Safety: every directory is validated against the persistence backend's own
 * path encoding before anything is removed, so a mismatch refuses instead of
 * deleting a neighbouring directory. The shared `/api` carrier admits only
 * owner Peers to an exact route, so a remote peer cannot reach this operation.
 */

import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Plugin name, used as the Loader row id basis and in diagnostics. */
export const name = 'session-delete'

/** Required Host services: the route carrier and the storage that resolves paths. */
export const inject = ['connection', 'sessionPersistence']

/** Exact Fetch route owned by this plugin, below the shared `/api` channel. */
export const SESSION_DELETE_PATH = '/api/session.delete'

// Exported for the verification harness: the route body, the startup sweep, and
// the two helpers that decide which directory may be removed.
export { handleDelete, measure, planDeletion, sessionDirectory, sweepPending, encodeSegment }

const SESSION_ID_MAX_LENGTH = 200
const MEASURE_ENTRY_LIMIT = 4000
const LOG_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/**
 * Register the delete route, and sweep sessions a previous run queued.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: SESSION_DELETE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleDelete(ctx, request),
  }), 'session-delete: delete route')
  // Runs before anything can attach to a Session, so queued Sessions are cold.
  void sweepPending(ctx).catch((error) => {
    ctx.logger.warn(`session-delete: queued cleanup failed: ${String(error)}`)
  })
}

/**
 * Answer one delete request: `{ sessionId, dryRun? }`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Request} request - authenticated request from the owner Peer.
 * @returns {Promise<Response>} JSON outcome; never echoes an unfiltered error.
 */
async function handleDelete(ctx, request) {
  let body
  try {
    body = await request.json()
  } catch {
    return reply(400, { ok: false, code: 'invalid-request', message: 'Request body must be JSON.' })
  }
  const sessionId = body !== null && typeof body === 'object' ? body.sessionId : undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > SESSION_ID_MAX_LENGTH) {
    return reply(400, { ok: false, code: 'invalid-request', message: 'sessionId must be a non-empty string.' })
  }
  const dryRun = body !== null && typeof body === 'object' && body.dryRun === true
  const signal = request.signal
  try {
    const plan = await planDeletion(ctx, sessionId, signal)
    if (plan.kind === 'missing') {
      return reply(404, { ok: false, code: 'session-not-found', message: 'No stored log exists for this session.' })
    }
    if (plan.kind === 'unlocatable') {
      return reply(409, {
        ok: false,
        code: 'session-unlocatable',
        message: 'The session backend did not resolve a removable artifact for this session.',
      })
    }
    if (dryRun) {
      return reply(200, {
        ok: true,
        dryRun: true,
        attached: plan.attached,
        running: plan.running,
        ...describe(plan),
      })
    }
    if (plan.attached.length > 0) {
      // A live Agent owns the log handle and the Session is listed from memory:
      // removing files now would be undone by its next write. Queue it instead.
      await queuePending(plan.entries.map(entry => entry.id))
      return reply(200, {
        ok: true,
        queued: true,
        restartRequired: true,
        attached: plan.attached,
        running: plan.running,
        ...describe(plan),
      })
    }

    const deleted = await deleteEntries(ctx, plan.entries)
    if (deleted.error !== undefined) return deleted.error
    await forgetPending(plan.entries.map(entry => entry.id))
    await tidyRegistry(ctx, sessionId)
    for (const entry of deleted.done) ctx.emit('api-session/removed', entry.id)
    return reply(200, {
      ok: true,
      deleted: deleted.done.map(entry => entry.id),
      freedBytes: deleted.bytes,
      ...describe(plan),
    })
  } catch (error) {
    if (signal.aborted) return reply(499, { ok: false, code: 'cancelled', message: 'Request cancelled.' })
    return reply(500, {
      ok: false,
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Remove every validated directory, descendants before their root.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Array<{id: string, directory: string, sizeBytes: number}>} entries - planned targets.
 * @returns {Promise<{done: Array<any>, bytes: number, error?: Response}>} removed entries, or the refusal response.
 */
async function deleteEntries(ctx, entries) {
  const done = []
  let bytes = 0
  for (const entry of entries) {
    try {
      await rm(entry.directory, { recursive: true, force: false, maxRetries: 2, retryDelay: 120 })
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOENT') {
        for (const removed of done) ctx.emit('api-session/removed', removed.id)
        return {
          done,
          bytes,
          error: reply(409, {
            ok: false,
            code: BUSY_CODES.has(code) ? 'session-busy' : 'delete-failed',
            message: BUSY_CODES.has(code)
              ? 'The session files are locked by a running process.'
              : `Could not remove ${basename(entry.directory)} (${code}).`,
            deleted: done.map(removed => removed.id),
          }),
        }
      }
    }
    done.push(entry)
    bytes += entry.sizeBytes
  }
  return { done, bytes }
}

/**
 * Remove queued Sessions that a previous run could not delete.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @returns {Promise<void>} after the queue is rewritten.
 */
async function sweepPending(ctx) {
  const queued = await readPending()
  if (queued.length === 0) return
  const remaining = []
  for (const id of queued) {
    let snapshot
    try {
      snapshot = await ctx.sessionPersistence.stat(id)
    } catch {
      remaining.push(id)
      continue
    }
    // An already-absent Session completes its deletion.
    if (snapshot === undefined) continue
    const directory = sessionDirectory(id, snapshot)
    if (directory === undefined) continue
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 })
    } catch {
      remaining.push(id)
    }
  }
  await writePending(remaining)
}

/**
 * Add Session ids to the pending list.
 * @param {readonly string[]} ids - Sessions to remove on the next start.
 * @returns {Promise<void>} after the list is written.
 */
async function queuePending(ids) {
  const queued = await readPending()
  const next = [...new Set([...queued, ...ids])]
  await writePending(next)
}

/**
 * Drop ids from the pending list (already removed some other way).
 * @param {readonly string[]} ids - Sessions no longer pending.
 * @returns {Promise<void>} after the list is written.
 */
async function forgetPending(ids) {
  const queued = await readPending()
  if (queued.length === 0) return
  const drop = new Set(ids)
  const next = queued.filter(id => !drop.has(id))
  if (next.length !== queued.length) await writePending(next)
}

/**
 * Read the pending list; a missing or unreadable file reads as empty.
 * @returns {Promise<string[]>} queued Session ids.
 */
export async function readPending() {
  try {
    const text = await readFile(pendingFile(), 'utf8')
    const parsed = JSON.parse(text)
    const ids = Array.isArray(parsed) ? parsed : parsed?.sessions
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id.length > 0) : []
  } catch {
    return []
  }
}

/**
 * Replace the pending list; an empty list removes the file.
 * @param {readonly string[]} ids - remaining ids.
 * @returns {Promise<void>} after the write settles.
 */
async function writePending(ids) {
  const file = pendingFile()
  try {
    if (ids.length === 0) {
      await rm(file, { force: true })
      return
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ sessions: [...ids] }, null, 2), 'utf8')
  } catch (error) {
    // Queueing must never mask the deletion outcome; the next run simply retries.
    console.warn(`session-delete: could not write the pending queue: ${String(error)}`)
  }
}

/**
 * Absolute path of the pending-deletion queue.
 * @returns {string} queue file path.
 */
function pendingFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'session-delete', 'pending.json')
}

/**
 * Remove the deleted id from the workspace registry's archived and pinned sets.
 * Both calls are idempotent and best-effort: the stored log is already gone, so
 * a registry refusal must not turn a successful deletion into a failure.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - deleted Session id.
 */
async function tidyRegistry(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  for (const operation of ['unarchiveSession', 'unpinSession']) {
    const call = registry[operation]
    if (typeof call !== 'function') continue
    try {
      await call.call(registry, sessionId)
    } catch {
      // A missing membership is not an error for this cleanup.
    }
  }
}

/**
 * Resolve every directory the deletion would remove, without touching disk.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - requested root Session.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<Plan>} missing/unlocatable marker, or validated entries with live flags.
 */
async function planDeletion(ctx, sessionId, signal) {
  const persistence = ctx.sessionPersistence
  const rootSnapshot = await persistence.stat(sessionId, { signal })
  if (rootSnapshot === undefined) return { kind: 'missing' }
  const rootDirectory = sessionDirectory(sessionId, rootSnapshot)
  if (rootDirectory === undefined) return { kind: 'unlocatable' }

  const entries = []
  const attached = []
  const running = []
  for (const id of [sessionId, ...await descendantIds(ctx, sessionId, signal)]) {
    signal.throwIfAborted()
    const snapshot = id === sessionId ? rootSnapshot : await persistence.stat(id, { signal })
    if (snapshot === undefined) continue
    const directory = sessionDirectory(id, snapshot)
    if (directory === undefined) continue
    // Only an Agent owns a persistence write handle, so only an Agent keeps the
    // log from being erasable (and would write it back afterwards).
    const agent = ctx.get('agents')?.get(id)
    if (agent !== undefined) {
      attached.push(id)
      if (agent.status === 'running') running.push(id)
    }
    entries.push({
      id,
      directory,
      // Descendants are removed before their root: a partial run leaves the
      // root row (and therefore a retryable target) intact.
      sizeBytes: await measure(directory),
      root: id === sessionId,
    })
  }
  entries.sort((left, right) => Number(left.root) - Number(right.root))
  return { kind: 'ok', entries, attached, running }
}

/**
 * The subagent Sessions whose ancestry reaches this root Session.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - root Session id.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<string[]>} descendant ids, nearest first when the trace is available.
 */
async function descendantIds(ctx, sessionId, signal) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.traceSession === 'function') {
    try {
      const trace = await query.traceSession(sessionId, signal)
      const ids = []
      const walk = (nodes) => {
        for (const node of nodes ?? []) {
          const id = node?.session?.header?.id
          if (typeof id === 'string') ids.push(id)
          walk(node?.descendants)
        }
      }
      walk(trace?.descendants)
      return ids
    } catch {
      // Fall back to a header scan below rather than failing the deletion.
    }
  }
  const persistence = ctx.sessionPersistence
  const snapshots = await persistence.list({ signal })
  const parents = new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot.header.parentSession]))
  const ids = []
  for (const snapshot of snapshots) {
    if (snapshot.header.id === sessionId) continue
    const seen = new Set()
    let cursor = snapshot.header.parentSession
    while (typeof cursor === 'string' && !seen.has(cursor)) {
      if (cursor === sessionId) {
        ids.push(snapshot.header.id)
        break
      }
      seen.add(cursor)
      cursor = parents.get(cursor)
    }
  }
  return ids
}

/**
 * Validate the backend artifact path and return the Session's own directory.
 * @param {string} sessionId - Session identity the artifact must belong to.
 * @param {{ location?: { path?: string } }} snapshot - persistence stat snapshot.
 * @returns {string | undefined} removable directory, or undefined when the path is not provably this Session's.
 */
function sessionDirectory(sessionId, snapshot) {
  const file = snapshot?.location?.path
  if (typeof file !== 'string' || file.length === 0) return undefined
  if (!LOG_FILE.test(basename(file))) return undefined
  const directory = dirname(file)
  if (basename(directory) !== encodeSegment(sessionId)) return undefined
  if (dirname(directory) === directory) return undefined
  return directory
}

/**
 * Encode one Session id exactly as the JSONL backend names its directory.
 * Mirrors the backend's injective `~XXXX` escaping so a validated directory can
 * never be a neighbour's.
 * @param {string} raw - Session id.
 * @returns {string} single safe path segment.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Total size of a Session directory, bounded so a pathological tree cannot
 * stall the request.
 * @param {string} directory - Session directory.
 * @returns {Promise<number>} summed file bytes.
 */
async function measure(directory) {
  let total = 0
  let seen = 0
  const pending = [directory]
  while (pending.length > 0 && seen < MEASURE_ENTRY_LIMIT) {
    const current = pending.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (seen >= MEASURE_ENTRY_LIMIT) break
      seen += 1
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      try {
        total += (await stat(path)).size
      } catch {
        // A vanished file contributes nothing.
      }
    }
  }
  return total
}

/**
 * Response payload naming the target, for both the dry run and the confirmation.
 * @param {Plan} plan - validated plan.
 * @returns {object} redacted outcome without side effects.
 */
function describe(plan) {
  const root = plan.entries.find(entry => entry.root)
  const descendants = plan.entries.filter(entry => !entry.root)
  return {
    session: root === undefined ? null : { id: root.id, directory: root.directory, sizeBytes: root.sizeBytes },
    descendants: descendants.map(entry => ({ id: entry.id, directory: entry.directory, sizeBytes: entry.sizeBytes })),
    totalBytes: plan.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  }
}

/**
 * Machine code of a filesystem failure.
 * @param {unknown} error - rejection from `rm`.
 * @returns {string} stable code, or `UNKNOWN`.
 */
function errorCode(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN'
}

/**
 * Build a JSON response.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON-serializable payload.
 * @returns {Response} response.
 */
function reply(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
