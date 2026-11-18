/**
 * Browser half of the session-delete bundle.
 *
 * Adds one entry to the session row menu (the `…` button and the right-click
 * menu), and one confirmation dialog in `shell.overlay`. The dialog first asks
 * the Host for a read-only preflight so it can name the exact directory and
 * size, then posts the destructive request.
 *
 * Two outcomes come back from the Host:
 * - a Session with no live Agent is erased now, and `api-session/removed` drops
 *   its row without a page reload;
 * - a Session that is open (or still running) cannot be erased underneath its
 *   Agent, so it is queued and removed by the next Host start. The dialog says
 *   so before confirming and the button carries the restart wording.
 */
window.__ModuleLoader__.load({
  id: '@local/session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    /** Document-relative Fetch route; the desktop IPC bridge and the web server both resolve it. */
    const ROUTE = 'api/session.delete'
    const NS = 'sessionDelete'
    const ICON_KEY = 'session-delete.trash'

    const zh = {
      'menu.delete': '删除会话',
      'menu.deleteFailed': '删除会话失败，请重试。',
      'dialog.title': '永久删除这个会话？',
      'dialog.desc': '“{title}”的会话记录会从磁盘上删除，删除后无法恢复。',
      'dialog.path': '存储位置',
      'dialog.size': '占用空间',
      'dialog.descendants': '子智能体会话',
      'dialog.descendantsValue': '{n} 个，一并删除',
      'dialog.none': '无',
      'dialog.loading': '正在读取会话信息…',
      'dialog.deleting': '正在删除…',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.confirmQueued': '标记删除，重启后生效',
      'dialog.inUse': '这个会话还驻留在本次 DSH 运行里（打开过就会驻留到重启），现在直接删文件会被它写回来。确认后会标记为待删除，下次启动 DSH 时自动清除。',
      'dialog.busy': '会话文件被占用，删除没有完成。请重启 DSH 后再删。',
      'dialog.notFound': '没有找到这个会话的存储记录，可能已经被删除了。',
      'dialog.unlocatable': '无法确认这个会话的存储位置，已取消删除。',
      'dialog.failed': '删除失败：{message}',
      'toast.deleted': '会话已从磁盘删除',
      'toast.deletedWithDescendants': '会话及其 {n} 个子会话已从磁盘删除',
      'toast.queued': '已标记删除，重启 DSH 后自动清除',
    }

    const en = {
      'menu.delete': 'Delete session',
      'menu.deleteFailed': 'Could not delete the session. Try again.',
      'dialog.title': 'Permanently delete this session?',
      'dialog.desc': 'The stored log of “{title}” is removed from disk. This cannot be undone.',
      'dialog.path': 'Storage location',
      'dialog.size': 'Size on disk',
      'dialog.descendants': 'Subagent sessions',
      'dialog.descendantsValue': '{n}, deleted too',
      'dialog.none': 'None',
      'dialog.loading': 'Reading session storage…',
      'dialog.deleting': 'Deleting…',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.confirmQueued': 'Mark for deletion',
      'dialog.inUse': 'This session is still resident in this DSH run (opened once, it stays until a restart), so erasing the files now would be written back. Confirming queues it for removal at the next DSH start.',
      'dialog.busy': 'The session files are locked, so nothing was deleted. Restart DSH and delete it again.',
      'dialog.notFound': 'No stored log was found for this session; it may already be deleted.',
      'dialog.unlocatable': 'This session’s storage location could not be confirmed, so nothing was deleted.',
      'dialog.failed': 'Deletion failed: {message}',
      'toast.deleted': 'Session deleted from disk',
      'toast.deletedWithDescendants': 'Session and {n} subagent sessions deleted from disk',
      'toast.queued': 'Queued for deletion; it clears at the next DSH start',
    }

    const CSS = `
      .sd-backdrop{position:fixed;inset:0;z-index:1400;display:grid;place-items:center;padding:24px;background:var(--dsw-alias-bg-mask-1)}
      .sd-dialog{box-sizing:border-box;width:min(460px,100%);max-height:calc(100dvh - 48px);overflow:auto;padding:20px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px}
      .sd-title{margin:0 0 6px;font-size:15px;line-height:22px;font-weight:600}
      .sd-desc{margin:0 0 14px;color:var(--dsw-alias-label-secondary)}
      .sd-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;margin:0 0 14px;padding:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
      .sd-fact-label{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .sd-mono{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;word-break:break-all;color:var(--dsw-alias-label-secondary)}
      .sd-value{margin:0;color:var(--dsw-alias-label-primary)}
      .sd-note{margin:0 0 14px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-warn-label)}
      .sd-error{margin:0 0 14px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-error)}
      .sd-status{margin:0 0 14px;color:var(--dsw-alias-label-secondary)}
      .sd-footer{display:flex;justify-content:flex-end;gap:8px}
      .sd-button{appearance:none;cursor:pointer;padding:6px 14px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
      .sd-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .sd-button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
      .sd-button:disabled{opacity:.55;cursor:default}
      .sd-danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
      .sd-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);filter:brightness(1.06)}
    `

    /**
     * Interpolate a `{name}` template without the locale service.
     * @param {string} template - dictionary text.
     * @param {Record<string, unknown>} [params] - placeholder values.
     * @returns {string} rendered text.
     */
    function interpolate(template, params) {
      if (params === undefined) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match)
    }

    /** Fallback translator used before (or without) the locale service. */
    let translate = (key, params) => interpolate(en[key] ?? key, params)

    /**
     * One pending dialog request plus a small listener set.
     * @returns {{get: () => any, set: (value: any) => void, subscribe: (listener: () => void) => () => void}} store
     */
    function createStore() {
      let value = null
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /**
     * Subscribe one component to the store.
     * @param {ReturnType<typeof createStore>} store - dialog store.
     * @returns {any} current request.
     */
    function useStore(store) {
      const [value, setValue] = useState(store.get())
      useEffect(() => store.subscribe(() => setValue(store.get())), [store])
      return value
    }

    /**
     * Post one delete request.
     * @param {string} sessionId - target Session.
     * @param {boolean} dryRun - read-only preflight.
     * @param {AbortSignal} signal - abort when the dialog closes.
     * @returns {Promise<any>} parsed JSON outcome.
     */
    async function requestDelete(sessionId, dryRun, signal) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dryRun ? { sessionId, dryRun: true } : { sessionId }),
        signal,
      })
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      payload.status = response.status
      return payload
    }

    /**
     * Render one byte count for the dialog.
     * @param {number} bytes - size in bytes.
     * @returns {string} human size.
     */
    function formatBytes(bytes) {
      const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
      if (value < 1024) return `${String(Math.round(value))} B`
      const units = ['KB', 'MB', 'GB']
      let scaled = value / 1024
      let unit = 0
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024
        unit += 1
      }
      return `${scaled.toFixed(1)} ${units[unit]}`
    }

    /**
     * Map a Host failure code to dialog copy.
     * @param {any} payload - failed outcome.
     * @returns {string} localized explanation.
     */
    function failureText(payload) {
      switch (payload.code) {
        case 'session-busy': return translate('dialog.busy')
        case 'session-not-found': return translate('dialog.notFound')
        case 'session-unlocatable': return translate('dialog.unlocatable')
        default: return translate('dialog.failed', { message: payload.message ?? `HTTP ${String(payload.status ?? 500)}` })
      }
    }

    /**
     * The `shell.overlay` entry: renders nothing until a row action asks for a
     * confirmation, then one dialog per request.
     * @returns {any} dialog element or null.
     */
    function DeleteDialog({ store, notify }) {
      const request = useStore(store)
      if (request === null) return null
      return h(DeleteForm, { key: request.sessionId, request, store, notify })
    }

    /**
     * One request's dialog. Preflight state dies with it.
     * @param {{request: any, store: any, notify: any}} props - pending request and owners.
     * @returns {any} dialog element.
     */
    function DeleteForm({ request, store, notify }) {
      const [phase, setPhase] = useState('loading')
      const [info, setInfo] = useState(null)
      const [queuedOnly, setQueuedOnly] = useState(false)
      const [error, setError] = useState(null)
      const cancelRef = useRef(null)
      const abortRef = useRef(null)

      const close = () => {
        if (phase === 'deleting') return
        store.set(null)
      }

      useEffect(() => {
        const controller = new AbortController()
        abortRef.current = controller
        setPhase('loading')
        requestDelete(request.sessionId, true, controller.signal).then((payload) => {
          if (controller.signal.aborted) return
          if (payload.ok === true) {
            setInfo(payload)
            setQueuedOnly(Array.isArray(payload.attached) && payload.attached.length > 0)
            setPhase('ready')
            return
          }
          setError(failureText(payload))
          setPhase('ready')
        }).catch((reason) => {
          if (controller.signal.aborted) return
          setError(reason instanceof Error ? reason.message : String(reason))
          setPhase('ready')
        })
        return () => {
          controller.abort()
          abortRef.current = null
        }
      }, [request.sessionId])

      useEffect(() => {
        cancelRef.current?.focus()
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (phase !== 'deleting') store.set(null)
        }
        document.addEventListener('keydown', onKeyDown, true)
        const previous = document.activeElement
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && typeof previous.focus === 'function') previous.focus()
        }
      }, [phase, store])

      const confirm = () => {
        if (phase !== 'ready') return
        const controller = new AbortController()
        abortRef.current = controller
        setError(null)
        setPhase('deleting')
        requestDelete(request.sessionId, false, controller.signal).then((payload) => {
          if (controller.signal.aborted) return
          if (payload.ok === true && payload.queued === true) {
            notify(translate('toast.queued'), true)
            store.set(null)
            return
          }
          if (payload.ok === true) {
            const descendants = Array.isArray(payload.deleted) ? payload.deleted.length - 1 : 0
            notify(descendants > 0
              ? translate('toast.deletedWithDescendants', { n: descendants })
              : translate('toast.deleted'), true)
            store.set(null)
            return
          }
          setError(failureText(payload))
          setPhase('ready')
        }).catch((reason) => {
          if (controller.signal.aborted) return
          setError(reason instanceof Error ? reason.message : String(reason))
          setPhase('ready')
        })
      }

      const session = info?.session ?? null
      const descendants = Array.isArray(info?.descendants) ? info.descendants : []
      const canConfirm = phase === 'ready' && session !== null

      return h('div', {
        className: 'sd-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close()
        },
      }, [
        h('style', { key: 'style' }, CSS),
        h('div', {
          key: 'dialog',
          className: 'sd-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'sd-title',
          'aria-describedby': 'sd-desc',
        }, [
          h('h2', { key: 'title', id: 'sd-title', className: 'sd-title' }, translate('dialog.title')),
          h('p', { key: 'desc', id: 'sd-desc', className: 'sd-desc' }, translate('dialog.desc', { title: request.title })),
          session === null ? null : h('div', { key: 'facts', className: 'sd-facts' }, [
            h('span', { key: 'path-label', className: 'sd-fact-label' }, translate('dialog.path')),
            h('p', { key: 'path', className: 'sd-mono' }, session.directory),
            h('span', { key: 'size-label', className: 'sd-fact-label' }, translate('dialog.size')),
            h('p', { key: 'size', className: 'sd-value' }, formatBytes(info?.totalBytes)),
            h('span', { key: 'sub-label', className: 'sd-fact-label' }, translate('dialog.descendants')),
            h('p', { key: 'sub', className: 'sd-value' }, descendants.length === 0
              ? translate('dialog.none')
              : translate('dialog.descendantsValue', { n: descendants.length })),
          ]),
          queuedOnly && phase === 'ready' ? h('p', { key: 'queued', className: 'sd-note', role: 'status' }, translate('dialog.inUse')) : null,
          error === null ? null : h('p', { key: 'error', className: 'sd-error', role: 'alert' }, error),
          phase === 'loading' ? h('p', { key: 'loading', className: 'sd-status', role: 'status' }, translate('dialog.loading')) : null,
          phase === 'deleting' ? h('p', { key: 'deleting', className: 'sd-status', role: 'status' }, translate('dialog.deleting')) : null,
          h('div', { key: 'footer', className: 'sd-footer' }, [
            h('button', {
              key: 'cancel',
              type: 'button',
              ref: cancelRef,
              className: 'sd-button',
              disabled: phase === 'deleting',
              onClick: close,
            }, translate('dialog.cancel')),
            h('button', {
              key: 'confirm',
              type: 'button',
              className: 'sd-button sd-danger',
              disabled: !canConfirm,
              onClick: confirm,
            }, translate(queuedOnly ? 'dialog.confirmQueued' : 'dialog.confirm')),
          ]),
        ]),
      ])
    }

    /** Small trash glyph for the menu row. */
    function TrashIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      }, [
        h('path', { key: 'lid', d: 'M2.8 4.4h10.4' }),
        h('path', { key: 'handle', d: 'M6.2 4.4V3.2a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.2' }),
        h('path', { key: 'body', d: 'M4.2 4.4l.6 8.1a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.6-8.1' }),
        h('path', { key: 'bar', d: 'M6.8 7v3.6M9.2 7v3.6' }),
      ])
    }

    return {
      inject: ['slots', 'contextMenus', 'locale'],
      apply(ctx) {
        // Localize both baseline languages; a missing locale service keeps the
        // English fallback above, so the action never renders a raw key.
        try {
          ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'session-delete: zh dictionary')
          ctx.effect(() => ctx.locale.register(NS, 'en', en), 'session-delete: en dictionary')
          translate = ctx.locale.bind(NS)
        } catch (error) {
          console.warn('session-delete: locale dictionaries unavailable:', error)
        }

        const store = createStore()
        const notify = (text, success) => {
          try {
            ctx.contextMenus.notify(text, success)
          } catch (error) {
            console.warn('session-delete: notification unavailable:', error)
          }
        }

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session-delete.row',
          target: 'session',
          order: 700,
          resolve: (target, signal) => {
            if (signal.aborted) return []
            return [{
              id: 'delete',
              label: translate('menu.delete'),
              icon: { key: ICON_KEY },
              danger: true,
              separatorBefore: true,
              afterContent: true,
              failureLabel: translate('menu.deleteFailed'),
              run: () => {
                store.set({ sessionId: target.sessionId, title: target.displayTitle })
              },
            }]
          },
        }), 'session-delete: session menu')

        ctx.effect(() => ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: ICON_KEY,
        }, TrashIcon)), 'session-delete: menu icon')

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete.dialog',
        }, function SessionDeleteOverlay() {
          return h(DeleteDialog, { store, notify })
        })), 'session-delete: confirmation dialog')
      },
    }
  },
})
