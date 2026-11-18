/**
 * Verification harness for the session-delete Client half.
 *
 * Stubs the browser module loader, React, and the Client services, executes the
 * real factory, and checks the published registrations: the locale
 * dictionaries, the session menu contribution, the menu icon, the overlay
 * dialog, and the menu action's shape.
 * Run with the Harness Node runtime: ELECTRON_RUN_AS_NODE=1 <node> this-file.mjs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const BUNDLE = 'D:\\deepseek\\deepseekh_work\\plugins\\dsh-session-delete'
const source = await readFile(join(BUNDLE, 'client.js'), 'utf8')

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, ok: condition === true, detail })
  if (condition !== true) console.log(`FAIL ${name} ${detail}`)
}

const React = {
  createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  useState: () => { throw new Error('useState called outside a render') },
  useEffect: () => { throw new Error('useEffect called outside a render') },
  useRef: () => ({ current: null }),
}

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (definition) => { loaded = definition },
    },
  },
  document: { addEventListener: () => {}, removeEventListener: () => {}, activeElement: null },
  console,
  fetch: async () => { throw new Error('fetch must not run during registration') },
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('module registers itself with the loader', loaded !== null)
check('module id', loaded?.id === '@local/session-delete', String(loaded?.id))

const module = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected import ${specifier}`)
})
check('module injects slots/contextMenus/locale', JSON.stringify(module.inject) === JSON.stringify(['slots', 'contextMenus', 'locale']), JSON.stringify(module.inject))

const effects = []
const dictionaries = new Map()
const menus = []
const slots = []
const locales = []
const calls = []

const ctx = {
  effect: (factory) => {
    const disposer = factory()
    effects.push(disposer)
    return disposer
  },
  get: (name) => {
    if (name === 'remote') {
      return { session: { cancel: async (request) => { calls.push(['cancel', request.sessionId]) } } }
    }
    if (name === 'sessions') {
      return {
        retainInfo: (sessionId) => ({
          getSnapshot: () => ({ retainedBy: sessionId === 'session-open' ? { mainView: 1 } : {} }),
        }),
      }
    }
    if (name === 'uiWorkspace') {
      return { startSession: () => { calls.push(['startSession']) } }
    }
    return undefined
  },
  locale: {
    register: (ns, locale, dict) => {
      locales.push({ ns, locale, keys: Object.keys(dict) })
      dictionaries.set(locale, dict)
      return () => {}
    },
    bind: () => (key, params) => {
      const template = dictionaries.get('en')?.[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    },
  },
  contextMenus: {
    register: (contribution) => {
      menus.push(contribution)
      return () => {}
    },
    notify: () => {},
  },
  slots: {
    inject: (key, factory) => {
      const disposer = factory()
      effects.push(disposer)
      return disposer
    },
    register: (options, component) => {
      slots.push({ options, component })
      return () => {}
    },
  },
}

module.apply(ctx)

check('two baseline dictionaries', locales.length === 2 && locales.some(entry => entry.locale === 'zh') && locales.some(entry => entry.locale === 'en'), JSON.stringify(locales.map(entry => entry.locale)))
check('zh dictionary is complete', locales.find(entry => entry.locale === 'zh')?.keys.length === locales.find(entry => entry.locale === 'en')?.keys.length)

const menu = menus[0]
check('one session menu contribution', menus.length === 1, String(menus.length))
check('menu target is session', menu?.target === 'session', String(menu?.target))
check('menu order after archive', menu?.order === 700, String(menu?.order))

const actions = await menu.resolve({ sessionId: 'session-1', displayTitle: 'Test session' }, new AbortController().signal)
check('resolve returns one action', Array.isArray(actions) && actions.length === 1, JSON.stringify(actions))
check('action label', actions[0]?.label === 'Delete session', String(actions[0]?.label))
check('action is dangerous', actions[0]?.danger === true)
check('action icon key', actions[0]?.icon?.key === 'session-delete.trash', JSON.stringify(actions[0]?.icon))
check('action runs', typeof actions[0]?.run === 'function')
actions[0].run()

const iconSlot = slots.find(entry => entry.options?.name === 'contextMenu.icon')
check('menu icon registered', iconSlot?.options?.key === 'session-delete.trash', JSON.stringify(iconSlot?.options))
const overlay = slots.find(entry => entry.options?.name === 'shell.overlay')
check('overlay dialog registered', overlay?.options?.id === 'session-delete.dialog', JSON.stringify(overlay?.options))
check('overlay renders a component', typeof overlay?.component === 'function')

const rendered = overlay.component({})
check('overlay renders the dialog root', rendered?.type?.name === 'DeleteDialog', String(rendered?.type?.name))
check('dialog receives the shared store', typeof rendered?.props?.store?.set === 'function')
check('dialog receives a notifier', typeof rendered?.props?.notify === 'function')
check('pending request is visible to the dialog', rendered?.props?.store.get()?.sessionId === 'session-1', JSON.stringify(rendered?.props?.store.get()))

const icon = iconSlot.component({ icon: { key: 'session-delete.trash' } })
check('icon renders an svg', icon?.type === 'svg', String(icon?.type))

for (const disposer of effects) {
  if (typeof disposer === 'function') disposer()
}
check('disposers are callable', true)

const failed = checks.filter(entry => !entry.ok)
console.log(JSON.stringify({ total: checks.length, failed: failed.length, failures: failed }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
