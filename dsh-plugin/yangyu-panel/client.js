/**
 * dsh-yangyu-panel —— 浏览器半侧（非 ESM，由 DSH 模块加载器执行）
 *
 * 做两件事：
 * 1. 在左栏 `sidebar.panellist` 注册一行「养鱼面板」（id / order / label / 图标）；
 *    点击该行由 DSH 侧栏自己调 ctx.layout.selectPanel(id)，本插件不处理点击。
 * 2. 在 `main` keyed slot 用同一个 key 注册整页组件：顶部工具条（状态 + 启动/重启/停止/
 *    刷新/在内置浏览器打开）+ 主体 iframe 嵌入 http://127.0.0.1:8899/ 养鱼面板。
 *
 * 硬约束：不 require 任何 DSH client 包；图标内联 SVG；样式只用宿主 --dsw-alias-* token
 * 且都带字面兜底；不写 document.body、不碰别的插件 DOM。
 */
window.__ModuleLoader__.load({
  id: 'dsh-yangyu-panel',
  factory(require) {
    const React = require('react')
    const { jsx: h, jsxs: hs } = require('react/jsx-runtime')

    const NS = 'dsh-yangyu-panel'
    /** 左栏行的 id 与 main 的 key 必须一致。 */
    const PANEL_ID = 'yangyu-panel'
    /** 排在宿主自带面板（Plugins=0、Scheduled=10）与既有插件之后。 */
    const PANEL_ORDER = 30
    const STATUS_URL = '/yangyu-panel/status'
    const START_URL = '/yangyu-panel/start'
    const STOP_URL = '/yangyu-panel/stop'
    /** 默认地址；就绪后优先用宿主 status 返回的 url（跟随 config.panelPort）。 */
    const FALLBACK_FRAME_URL = 'http://127.0.0.1:8899/'
    const POLL_MS = 1000
    const MAX_WAIT_MS = 60000
    /** 面板启动等待上限需 ≥ 宿主 config.startTimeoutMs（默认 30s），留出余量。 */
    /**
     * 就绪后是否常显工具条。false（默认）= 就绪后隐藏工具条与状态行，只留页面顶部 6px 感应条，
     * 鼠标移上去才滑出，把整屏让给面板；未就绪/启动中/失败时工具条照常出现。
     * 想恢复常显就把它改成 true。
     */
    const SHOW_BAR_WHEN_READY = false

    const zh = {
      panel: '养鱼面板',
      'toolbar.start': '启动',
      'toolbar.restart': '重启',
      'toolbar.stop': '停止',
      'toolbar.refresh': '刷新',
      'toolbar.openInBrowser': '在内置浏览器打开',
      'toolbar.hide': '收起',
      'handle.hint': '把鼠标移到顶部可显示状态栏',
      'status.checking': '检查状态…',
      'status.idle': '未启动',
      'status.starting': '启动中…',
      'status.stopping': '停止中…',
      'status.ready': '已就绪',
      'status.failed': '失败',
      'status.notReady': '启动已结束，但面板未就绪',
      'status.timeout': '启动超时（30 秒）',
      'status.unknown': '未知原因',
      'service.panel': '面板',
      'service.ready': '已就绪',
      'service.pending': '未就绪',
      'service.failed': '失败',
      'service.reused': '复用现有进程',
      'service.managed': '由插件启动',
      'hint.needStart': '面板尚未启动。点「启动」后由 DSH 拉起 panel.mjs，就绪即在此页嵌入。',
      'hint.opening': '正在等待面板就绪，进度实时显示在工具条上。',
    }

    const en = {
      panel: 'Fish Panel',
      'toolbar.start': 'Start',
      'toolbar.restart': 'Restart',
      'toolbar.stop': 'Stop',
      'toolbar.refresh': 'Reload',
      'toolbar.openInBrowser': 'Open in built-in browser',
      'toolbar.hide': 'Hide',
      'handle.hint': 'Move the pointer to the top edge to show the status bar',
      'status.checking': 'Checking…',
      'status.idle': 'Not started',
      'status.starting': 'Starting…',
      'status.stopping': 'Stopping…',
      'status.ready': 'Ready',
      'status.failed': 'Failed',
      'status.notReady': 'Start finished, but the panel is not ready',
      'status.timeout': 'Start timed out (30s)',
      'status.unknown': 'unknown reason',
      'service.panel': 'Panel',
      'service.ready': 'ready',
      'service.pending': 'pending',
      'service.failed': 'failed',
      'service.reused': 'reused existing process',
      'service.managed': 'started by plugin',
      'hint.needStart':
        'The panel is not running yet. Press Start: the host launches panel.mjs, then embeds it here.',
      'hint.opening': 'Waiting for the panel to become ready; progress shows in the toolbar.',
    }

    const CSS = `
.ydp-root{position:relative;box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;gap:10px;
  padding:calc(8px + var(--dsh-frame-top-clearance,48px)) 16px 14px;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-primary,#1f2328)}
.ydp-handle{position:absolute;top:0;left:0;right:0;height:6px;z-index:3;cursor:default}
.ydp-handle:hover{background:var(--dsw-alias-border-l1,rgba(127,127,127,.35))}
.ydp-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));
  background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}
.ydp-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8b93a1)}
.ydp-dot[data-state=ready]{background:var(--dsw-alias-state-success-primary,#15803d)}
.ydp-dot[data-state=error]{background:var(--dsw-alias-state-error-primary,#dc2626)}
.ydp-dot[data-state=busy]{background:var(--dsw-alias-state-business-primary,#4f6ef7);animation:ydp-pulse 1.1s ease-in-out infinite}
@keyframes ydp-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.ydp-dot[data-state=busy]{animation:none;opacity:.7}}
.ydp-state{color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;overflow-wrap:anywhere}
.ydp-state[data-state=error]{color:var(--dsw-alias-state-error-primary,#dc2626)}
.ydp-meta{min-width:0;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;line-height:16px;
  overflow-wrap:anywhere}
.ydp-err{min-width:0;color:var(--dsw-alias-state-error-primary,#dc2626);font-size:11px;line-height:16px;
  overflow-wrap:anywhere}
.ydp-spacer{flex:1 1 auto}
.ydp-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ydp-btn{font:inherit;font-size:12px;line-height:16px;padding:5px 10px;border-radius:6px;cursor:pointer;
  color:var(--dsw-alias-label-primary,#1f2328);background:transparent;
  border:1px solid var(--dsw-alias-border-l2,#d9dde3)}
.ydp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ydp-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2))}
.ydp-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f6ef7);outline-offset:1px}
.ydp-btn:disabled{opacity:.45;cursor:not-allowed}
.ydp-btn[data-primary=true]{color:var(--dsw-alias-label-primary-foreground,#fff);
  background:var(--dsw-alias-button-info-fill,#4f6ef7);border-color:transparent}
.ydp-body{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;border-radius:8px;
  overflow:hidden;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));
  background:var(--dsw-alias-bg-layer-1,#fff)}
.ydp-frame{display:block;flex:1 1 auto;width:100%;height:100%;min-height:0;border:0;background:var(--dsw-alias-bg-base,#fff)}
.ydp-hint{display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;
  color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px;line-height:19px}
`

    /** 服务探测与文案：宿主 ctx 上取不到的服务按「不存在」处理，绝不因为探测抛错而白屏。 */
    function safeGet(read) {
      try {
        return read()
      } catch (error) {
        return null
      }
    }

    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    function createSleeper() {
      const pending = new Set()
      return {
        wait(ms) {
          return new Promise((resolve) => {
            const entry = { id: 0, resolve }
            entry.id = setTimeout(() => {
              pending.delete(entry)
              resolve()
            }, ms)
            pending.add(entry)
          })
        },
        clearAll() {
          for (const entry of pending) {
            clearTimeout(entry.id)
            entry.resolve()
          }
          pending.clear()
        },
      }
    }

    /** 原创图标：一条侧视小鱼（肥鱼的招牌形象），线条风、跟随 currentColor。 */
    function FishIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      return hs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        role: 'img',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
        children: [
          h(
            'path',
            {
              d: 'M3.1 12c2.4-3.3 5.4-4.9 8.8-4.9 3.4 0 6.2 1.6 8.4 4.9-2.2 3.3-5 4.9-8.4 4.9-3.4 0-6.4-1.6-8.8-4.9Z',
            },
            'body',
          ),
          h('path', { d: 'M3.1 12 1 8.6v6.8L3.1 12Z' }, 'tail'),
          h('path', { d: 'M12.6 7.4c-1.2 1.6-1.2 7.6 0 9.2' }, 'gill'),
          h('path', { d: 'M15.9 10.4h.01' }, 'eye'),
        ],
      })
    }

    function apply(ctx) {
      // ---------------------------------------------------------------- 文案
      ctx.effect(() => {
        const locale = safeGet(() => ctx.locale)
        if (!locale || typeof locale.register !== 'function') return () => {}
        const dispose = locale.register(NS, { zh, en })
        return typeof dispose === 'function' ? dispose : () => {}
      }, 'dsh-yangyu-panel: 字典')

      let bound = null
      function t(key) {
        const locale = safeGet(() => ctx.locale)
        if (locale && typeof locale.bind === 'function') {
          try {
            if (bound === null) bound = locale.bind(NS)
            const text = bound(key)
            if (typeof text === 'string' && text !== '' && text !== key) return text
          } catch (error) {
            bound = null
          }
        }
        const fallback = zh[key]
        return typeof fallback === 'string' ? fallback : key
      }

      function describeService(service) {
        if (!service) return t('service.pending')
        if (service.ready) {
          const suffix = service.pid
            ? ' (pid ' +
              service.pid +
              '，' +
              (service.managed ? t('service.managed') : t('service.reused')) +
              ')'
            : ''
          return t('service.ready') + suffix
        }
        if (service.error) return t('service.failed') + ' — ' + service.error
        return t('service.pending')
      }

      // ---------------------------------------------------------------- 左栏一行
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => t('panel'),
            locale: NS,
          },
          FishIcon,
        ),
      )

      // ---------------------------------------------------------------- 主区整页
      function PanelPage() {
        const [phase, setPhase] = React.useState('checking')
        const [status, setStatus] = React.useState(null)
        const [errorText, setErrorText] = React.useState('')
        const [frameKey, setFrameKey] = React.useState(0)
        // 就绪后工具条默认不占版面（只留顶部感应条）；悬停唤出后由「收起」复位。
        const [barOpen, setBarOpen] = React.useState(false)

        const genRef = React.useRef(0)
        const sleeperRef = React.useRef(null)
        if (sleeperRef.current === null) sleeperRef.current = createSleeper()
        const sleeper = sleeperRef.current

        /** 每次用户动作开一代；旧一代的轮询自行退出。 */
        const beginEpoch = () => {
          const gen = ++genRef.current
          return () => genRef.current === gen
        }

        const fetchStatus = async () => {
          const res = await fetch(STATUS_URL, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!res.ok) throw new Error('GET ' + STATUS_URL + ' → HTTP ' + res.status)
          return await res.json()
        }

        const post = async (url) => {
          const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } })
          if (!res.ok) throw new Error('POST ' + url + ' → HTTP ' + res.status)
          return await res.json()
        }

        const isReady = (value) => !!(value && value.panel && value.panel.ready)

        const pickError = (value) => (value && value.panel && value.panel.error) || ''

        /** 已就绪 → 进入 ready 并收敛；返回是否收敛。 */
        const settle = (value) => {
          setStatus(value)
          if (!isReady(value)) return false
          setErrorText('')
          setPhase('ready')
          return true
        }

        const fail = (detail) => {
          setPhase('error')
          setErrorText(detail || t('status.unknown'))
        }

        const runStart = async (isAlive) => {
          setErrorText('')
          setPhase('starting')

          let current = null
          try {
            current = await fetchStatus()
          } catch (error) {
            // 宿主路由本身异常时这里为空，后续 POST 会把真实原因带回来。
          }
          if (!isAlive()) return
          if (current && settle(current)) return

          let startReturned = false
          const started = post(START_URL)
            .then((value) => {
              startReturned = true
              return value
            })
            .catch((error) => {
              startReturned = true
              return { __error: messageOf(error) }
            })

          const deadline = Date.now() + MAX_WAIT_MS
          while (isAlive() && Date.now() < deadline) {
            await sleeper.wait(POLL_MS)
            if (!isAlive()) return
            let next = null
            try {
              next = await fetchStatus()
            } catch (error) {
              next = null
            }
            if (!isAlive()) return
            if (!next) continue
            setStatus(next)
            if (settle(next)) return
            if (startReturned) {
              const detail = pickError(next) || t('status.notReady')
              try {
                const settled = await started
                fail(pickError(next) || (settled && settled.__error) || detail)
              } catch (error) {
                fail(detail)
              }
              return
            }
          }

          const result = await started
          let final = null
          try {
            final = await fetchStatus()
          } catch (error) {
            final = null
          }
          if (!isAlive()) return
          if (final && settle(final)) return
          fail(pickError(final) || (result && result.__error) || t('status.timeout'))
        }

        const runStop = async (isAlive) => {
          setPhase('stopping')
          setErrorText('')
          try {
            const value = await post(STOP_URL)
            if (!isAlive()) return
            setStatus(value)
            if (isReady(value)) setPhase('ready')
            else if (pickError(value)) fail(pickError(value))
            else setPhase('idle')
          } catch (error) {
            if (!isAlive()) return
            fail(messageOf(error))
          }
        }

        const runRestart = async (isAlive) => {
          setPhase('stopping')
          setErrorText('')
          try {
            await post(STOP_URL)
          } catch (error) {
            // 停止失败不阻塞重启，启动阶段会报出真实原因。
          }
          if (!isAlive()) return
          await runStart(isAlive)
        }

        React.useEffect(() => {
          const isAlive = beginEpoch()
          void runStart(isAlive)
          return () => {
            // 卸载即作废当前代并唤醒所有挂起的等待，轮询立刻退出（定时器一并清掉）。
            genRef.current += 1
            sleeper.clearAll()
          }
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [])

        const frameUrl = (status && status.url) || FALLBACK_FRAME_URL
        const ready = isReady(status)

        const onStart = () => {
          void runStart(beginEpoch())
        }
        const onStop = () => {
          void runStop(beginEpoch())
        }
        const onRestart = () => {
          void runRestart(beginEpoch())
        }
        const onRefresh = () => {
          setFrameKey((value) => value + 1)
        }

        /**
         * 内置浏览器标签：只有在宿主真的注册了 `browser` 这个 tab kind 时才可用。
         * 之前只查 openTab 存不存在就渲染按钮，而 live 里 ui-sidebar-browser 未注册，
         * `placeTab` 会抛错并被 safeGet 吞掉 —— 点下去毫无反应的死按钮。
         * 现在点了先试内置浏览器，失败就退回系统浏览器新窗口，保证按钮永远有反应。
         */
        const onOpenBrowser = () => {
          const usedBuiltin = safeGet(() => {
            const right = ctx.sidebarRight
            if (right && typeof right.openTab === 'function') {
              right.openTab('browser', { params: { url: frameUrl } })
              return true
            }
            return false
          })
          if (usedBuiltin) return
          safeGet(() => {
            window.open(frameUrl, '_blank', 'noopener,noreferrer')
          })
        }

        const busy = phase === 'starting' || phase === 'checking' || phase === 'stopping'
        const stateKind = ready ? 'ready' : phase === 'error' ? 'error' : busy ? 'busy' : 'idle'
        const stateText =
          phase === 'checking'
            ? t('status.checking')
            : phase === 'starting'
              ? t('status.starting')
              : phase === 'stopping'
                ? t('status.stopping')
                : phase === 'ready'
                  ? t('status.ready')
                  : phase === 'error'
                    ? t('status.failed') + '：' + (errorText || t('status.unknown'))
                    : t('status.idle')

        const metaText = status
          ? t('service.panel') + '：' + describeService(status.panel)
          : t('hint.needStart')

        const hintText =
          phase === 'error'
            ? t('status.failed') + '：' + (errorText || t('status.unknown'))
            : phase === 'idle'
              ? t('hint.needStart')
              : t('hint.opening')

        const body = h('div', {
          className: 'ydp-body',
          children: ready
            ? h(
                'iframe',
                {
                  className: 'ydp-frame',
                  src: frameUrl,
                  title: t('panel'),
                  allow: 'clipboard-write; fullscreen',
                },
                'frame-' + frameKey,
              )
            : h('div', { className: 'ydp-hint', children: hintText }),
        })

        // key 一律走 jsx(type, props, key) 的第三参：塞进 props 会触发 React DEV 的 key-spread 警告。
        const button = (key, props) =>
          h('button', { type: 'button', className: 'ydp-btn', ...props }, key)
        const actions = [
          button('start', {
            'data-primary': 'true',
            disabled: phase === 'starting' || ready,
            onClick: onStart,
            children: t('toolbar.start'),
          }),
          button('restart', {
            disabled: busy,
            onClick: onRestart,
            children: t('toolbar.restart'),
          }),
          button('stop', {
            disabled: busy || (!ready && phase !== 'error'),
            onClick: onStop,
            children: t('toolbar.stop'),
          }),
          button('refresh', {
            disabled: !ready,
            onClick: onRefresh,
            children: t('toolbar.refresh'),
          }),
        ]
        // 内置浏览器按钮改成「总是可用」：onOpenBrowser 内部先试宿主 tab，
        // 失败就退回 window.open，所以不再需要 canOpenTab 预判（之前那次预判是错的，
        // 它只查 openTab 存在，而 browser 这个 tab kind 在 live 里并未注册）。
        actions.push(
          button('open', { disabled: !ready, onClick: onOpenBrowser, children: t('toolbar.openInBrowser') }),
        )
        if (ready && barOpen && !SHOW_BAR_WHEN_READY) {
          // 悬停临时唤出的工具条：给一个明确的收起入口，避免它一直占着版面。
          actions.push(button('hide', { onClick: () => setBarOpen(false), children: t('toolbar.hide') }))
        }

        // 就绪后默认不占版面：隐藏工具条与状态行，只在顶部留 6px 感应条，鼠标移上去才滑出。
        const showBar = SHOW_BAR_WHEN_READY || barOpen || !ready
        const barNode = hs(
          'div',
          {
            className: 'ydp-bar',
            children: [
              h('span', { className: 'ydp-dot', 'data-state': stateKind }, 'dot'),
              h(
                'span',
                { className: 'ydp-state', 'data-state': stateKind, children: stateText },
                'state',
              ),
              h('span', { className: 'ydp-spacer' }, 'spacer'),
              hs('span', { className: 'ydp-actions', children: actions }, 'actions'),
            ],
          },
          'bar',
        )
        const metaNode = h(
          'div',
          {
            className: phase === 'error' ? 'ydp-err' : 'ydp-meta',
            children: metaText,
          },
          'meta',
        )
        const handleNode = h(
          'div',
          {
            className: 'ydp-handle',
            title: t('handle.hint'),
            onMouseEnter: () => setBarOpen(true),
          },
          'handle',
        )

        return hs('div', {
          className: 'ydp-root',
          children: [
            h('style', { children: CSS }, 'styles'),
            ...(showBar ? [barNode, metaNode] : [handleNode]),
            body,
          ],
        })
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
          PanelPage,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
