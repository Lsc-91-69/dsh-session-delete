/**
 * Verification harness for the session-delete Host half.
 *
 * Builds a throwaway sessions tree that mimics the JSONL backend layout, then
 * drives the real route handler with a fabricated Host context: dry run,
 * immediate deletion of a cold Session, queueing of a Session a live Agent
 * holds, the next-start sweep, path-mismatch refusal, and a missing id.
 * Run with the Harness Node runtime: ELECTRON_RUN_AS_NODE=1 <node> this-file.mjs
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const BUNDLE = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-session-delete'
const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-home-'))
// The plugin resolves its pending queue under DSH_HOME at call time.
process.env.DSH_HOME = home

const {
  handleDelete, readPending, sweepPending, encodeSegment,
} = await import(pathToFileURL(join(BUNDLE, 'index.js')).href)

const project = join(root, '--D-work--')
const other = join(root, '--D-other--')

const ids = {
  root: 'session-root-0001',
  child: 'session-child-0002',
  grandchild: 'session-grandchild-0003',
  other: 'session-other-0004',
  mismatch: 'session-mismatch-0005',
  live: 'session-live-0006',
  swept: 'session-swept-0007',
}

async function materialize(directory, bytes) {
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'session.v4.jsonl.zstd')
  await writeFile(file, Buffer.alloc(bytes, 7))
  return file
}

const files = {
  root: await materialize(join(project, ids.root), 128),
  child: await materialize(join(project, ids.child), 64),
  grandchild: await materialize(join(project, ids.grandchild), 32),
  other: await materialize(join(other, ids.other), 16),
  mismatch: await materialize(join(project, 'someone-elses-directory'), 8),
  live: await materialize(join(project, ids.live), 24),
  swept: await materialize(join(project, ids.swept), 40),
}

const snapshots = new Map([
  [ids.root, { header: { id: ids.root, cwd: 'D:\\work' }, location: { kind: 'jsonl', path: files.root } }],
  [ids.child, { header: { id: ids.child, cwd: 'D:\\work', parentSession: ids.root, origin: 'subagent' }, location: { kind: 'jsonl', path: files.child } }],
  [ids.grandchild, { header: { id: ids.grandchild, cwd: 'D:\\work', parentSession: ids.child, origin: 'subagent' }, location: { kind: 'jsonl', path: files.grandchild } }],
  [ids.other, { header: { id: ids.other, cwd: 'D:\\other' }, location: { kind: 'jsonl', path: files.other } }],
  [ids.mismatch, { header: { id: ids.mismatch, cwd: 'D:\\work' }, location: { kind: 'jsonl', path: files.mismatch } }],
  [ids.live, { header: { id: ids.live, cwd: 'D:\\work' }, location: { kind: 'jsonl', path: files.live } }],
  [ids.swept, { header: { id: ids.swept, cwd: 'D:\\work' }, location: { kind: 'jsonl', path: files.swept } }],
])

const removed = []

/**
 * Fabricate the Host surface the route uses.
 * @param {{agents?: string[]}} options - ids with a live Agent.
 * @returns {object} fake Host context.
 */
function context(options = {}) {
  const agentIds = options.agents ?? []
  const agents = {
    get: id => (agentIds.includes(id) ? { id, status: 'running' } : undefined),
  }
  return {
    sessionPersistence: {
      stat: async id => snapshots.get(id),
      list: async () => [...snapshots.values()],
    },
    agents,
    get: (name) => {
      if (name === 'agents') return agents
      if (name === 'sessionQuery') {
        return {
          traceSession: async (id) => id === ids.root
            ? {
                target: { header: snapshots.get(id).header },
                descendants: [
                  {
                    session: { header: snapshots.get(ids.child).header },
                    descendants: [{ session: { header: snapshots.get(ids.grandchild).header }, descendants: [] }],
                  },
                ],
              }
            : { target: { header: snapshots.get(id).header }, descendants: [] },
        }
      }
      return undefined
    },
    emit: (event, value) => { if (event === 'api-session/removed') removed.push(value) },
    logger: { warn: () => {} },
  }
}

async function post(ctx, body) {
  const response = await handleDelete(ctx, new Request('http://127.0.0.1/api/session.delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, payload: await response.json() }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, ok: condition === true, detail })
  if (condition !== true) console.log(`FAIL ${name} ${detail}`)
}

// 1. Dry run names the exact directories and sizes without touching disk.
const dry = await post(context(), { sessionId: ids.root, dryRun: true })
check('dry run status 200', dry.status === 200, JSON.stringify(dry.payload))
check('dry run lists two descendants', dry.payload.descendants?.length === 2, JSON.stringify(dry.payload.descendants))
check('dry run total bytes', dry.payload.totalBytes === 128 + 64 + 32, String(dry.payload.totalBytes))
check('dry run reports no live agent', JSON.stringify(dry.payload.attached) === '[]', JSON.stringify(dry.payload.attached))
check('dry run keeps files', await exists(files.root) && await exists(files.child))
check('dry run emits nothing', removed.length === 0)

// 2. A Session a live Agent holds is queued, never erased underneath it.
const live = await post(context({ agents: [ids.live] }), { sessionId: ids.live })
check('live agent is queued', live.status === 200 && live.payload.queued === true, JSON.stringify(live.payload))
check('live agent requires restart', live.payload.restartRequired === true, JSON.stringify(live.payload))
check('live agent keeps files', await exists(files.live))
check('live agent enters the pending queue', (await readPending()).includes(ids.live), JSON.stringify(await readPending()))
check('queueing emits nothing', removed.length === 0)

// 3. The next start removes what the previous run queued.
await sweepPending(context())
check('sweep removed the queued directory', !(await exists(join(project, ids.live))))
check('sweep empties the queue', (await readPending()).length === 0, JSON.stringify(await readPending()))

// 4. A directory whose name does not match the id is refused, not deleted.
const mismatch = await post(context(), { sessionId: ids.mismatch })
check('path mismatch refused', mismatch.status === 409 && mismatch.payload.code === 'session-unlocatable', JSON.stringify(mismatch.payload))
check('path mismatch keeps directory', await exists(files.mismatch))

// 5. Unknown id answers 404.
const missing = await post(context(), { sessionId: 'session-does-not-exist' })
check('missing id 404', missing.status === 404 && missing.payload.code === 'session-not-found', JSON.stringify(missing.payload))

// 6. A cold Session is erased now: descendants first, then the root.
removed.length = 0
const real = await post(context(), { sessionId: ids.root })
check('cold delete status 200', real.status === 200 && real.payload.ok === true, JSON.stringify(real.payload))
check('cold delete reports three ids', real.payload.deleted?.length === 3, JSON.stringify(real.payload.deleted))
check('root directory gone', !(await exists(join(project, ids.root))))
check('child directory gone', !(await exists(join(project, ids.child))))
check('grandchild directory gone', !(await exists(join(project, ids.grandchild))))
check('unrelated session survives', await exists(files.other))
check('removals emitted', removed.length === 3 && removed.includes(ids.root), JSON.stringify(removed))

// 7. Invalid body answers 400.
const invalid = await post(context(), { sessionId: 42 })
check('invalid body 400', invalid.status === 400 && invalid.payload.code === 'invalid-request', JSON.stringify(invalid.payload))

// 8. encodeSegment escapes everything the backend escapes.
check('encodeSegment keeps safe chars', encodeSegment('session-a_1.b') === 'session-a_1.b')
check('encodeSegment escapes separators', encodeSegment('a/b\\c') === 'a~002Fb~005Cc', encodeSegment('a/b\\c'))
check('encodeSegment escapes tilde', encodeSegment('a~b') === 'a~007Eb', encodeSegment('a~b'))
check('encodeSegment guards dot segments', encodeSegment('..') === '~002E~002E')

await rm(root, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

const failed = checks.filter(entry => !entry.ok)
console.log(JSON.stringify({ total: checks.length, failed: failed.length, failures: failed }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
