// dsh-convmap — 动态 Cordis 插件形态（由 scripts/build-dynamic.mjs 从 lib/client.js 生成，勿手改）
// 与固化版的差异只有环境接线：styles.insert / host.call / ctx.get。
// host 半边不用生成：把 lib/index.js 的 buildTurns 原样搬进
// harness.handle("turns", …) 即可（动态沙盒里没有 webServer 路由）。
return {
  name: "dsh-convmap",
  inject: ["slots", "sessions"],
  apply(ctx) {
    const e = React.createElement

    const PITCH = 12
    // 预览卡：够放下 host 截过来的整段摘要的一大半，滚一两屏就到底。
    const PREVIEW_WIDTH = 420
    const PREVIEW_MAX_HEIGHT = 320
    // 卡片上下缘离对话区的最小留白（夹紧竖直位置用）。
    const PREVIEW_MARGIN = 12
    // 鼠标移出刻度后卡片的驻留时间：这段时间里可以把鼠标挪进卡里接住它。
    const HIDE_DELAY = 500
    // 本地快照里的提问摘要上限，与 host 的 PROMPT_LIMIT 对齐，免得同一条刻度
    // 在 host 数据回来前后长短跳变。
    const PROMPT_LIMIT = 200
    const MIN_CONVERSATION_WIDTH = 560
    const BOTTOM_THRESHOLD = 100
    const OVERFLOW_MARGIN = 60
    const MAX_PAGE_LOADS = 60

    const CSS_TEXT = `
.dsh-convmap-nav { position: fixed; z-index: 30; width: 44px; }
.dsh-convmap-rail { height: 100%; width: 44px; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; }
.dsh-convmap-rail::-webkit-scrollbar { display: none; }
.dsh-convmap-tick { display: flex; align-items: center; width: 44px; height: 12px; padding: 0; border: 0; background: transparent; cursor: pointer; border-radius: 4px; }
.dsh-convmap-tick:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dsh-convmap-line { display: block; height: 2px; border-radius: 999px; transition: width .3s ease-out, opacity .3s ease-out; }
.dsh-convmap-line--idle { background: var(--dsw-alias-label-secondary); opacity: .35; }
.dsh-convmap-line--hot { background: var(--dsw-alias-label-primary); opacity: 1; }
.dsh-convmap-line--pending { background: var(--dsw-alias-brand-primary); opacity: 1; animation: dsh-convmap-pulse .8s ease-in-out infinite alternate; }
@keyframes dsh-convmap-pulse { from { opacity: .35; } to { opacity: 1; } }
.dsh-convmap-fade { position: absolute; left: 0; right: 0; height: 20px; pointer-events: none; transition: opacity .2s; z-index: 1; }
.dsh-convmap-fade--top { top: 0; background: linear-gradient(to bottom, var(--dsw-alias-bg-base), transparent); }
.dsh-convmap-fade--bottom { bottom: 0; background: linear-gradient(to top, var(--dsw-alias-bg-base), transparent); }
.dsh-convmap-preview { position: absolute; left: 52px; top: 0; width: ${PREVIEW_WIDTH}px; max-height: ${PREVIEW_MAX_HEIGHT}px; display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); box-shadow: 0 8px 28px rgba(0,0,0,.18); z-index: 2; }
.dsh-convmap-prompt { flex: none; font-size: 13px; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-primary); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; }
.dsh-convmap-response { flex: 1 1 auto; min-height: 0; font-size: 12px; line-height: 19px; overflow-y: auto; overscroll-behavior: contain; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-border-l1) transparent; }
.dsh-convmap-response::-webkit-scrollbar { width: 6px; }
.dsh-convmap-response::-webkit-scrollbar-thumb { border-radius: 999px; background: var(--dsw-alias-border-l1); }
.dsh-convmap-response::-webkit-scrollbar-track { background: transparent; }
`

    // 样式安装：bundle 形态挂常驻 <style>，动态插件形态换成 styles.insert。
    function installStyles() {
      styles.insert(CSS_TEXT)
    }

    // 轮次拉取：bundle 形态走 host 注册的同源路由，动态插件形态换成 host.call。
    function loadTurns(sessionId) {
      return host.call("turns", { sessionId })
        .then((result) => (result && Array.isArray(result.turns) ? result.turns : []))
    }

    const EMPTY_TURNS = []

    function snippet(text, limit) {
      const normalized = String(text || '').trim().split(/\s+/).join(' ')
      const chars = Array.from(normalized)
      return chars.length > limit ? chars.slice(0, limit).join('') + '…' : normalized
    }

    function textOfContent(content) {
      if (!Array.isArray(content)) return ''
      return content
        .map((block) => (block && block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n')
    }

    // 已渲染的用户轮次：零网络、零等待，长会话里先拿它撑住刻度。
    // 回复摘要留空——那要读整轮的 assistant 节点，等 host 的全量数据补。
    function renderedTurns(chat) {
      if (!chat || !chat.nodes || typeof chat.nodes.get !== 'function' || !Array.isArray(chat.order)) return EMPTY_TURNS
      const list = []
      for (const key of chat.order) {
        const node = chat.nodes.get(key)
        if (!node || node.kind !== 'user') continue
        list.push({
          key,
          prompt: snippet(textOfContent(node.data && node.data.content), PROMPT_LIMIT) || '(空消息)',
          response: '',
        })
      }
      return list.length === 0 ? EMPTY_TURNS : list
    }

    // useSession 的相等判断：轮次列表按 key 序列比，避免每帧新数组触发重渲染。
    function sameKeys(a, b) {
      if (a === b) return true
      if (a.length !== b.length) return false
      for (let i = 0; i < a.length; i++) if (a[i].key !== b[i].key) return false
      return true
    }

    // 合并：host 的全量历史为准，本地新出现、host 还没落盘的轮次接在末尾。
    function mergeTurns(hostTurns, localTurns) {
      if (hostTurns.length === 0) return localTurns
      const known = new Set(hostTurns.map((turn) => turn.key))
      const tail = localTurns.filter((turn) => !known.has(turn.key))
      return tail.length === 0 ? hostTurns : hostTurns.concat(tail)
    }

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }

    function ConversationMap(props) {
      const localTurns = props.useSession((snapshot) => renderedTurns(snapshot.chat), sameKeys)
      const [hostTurns, setHostTurns] = React.useState(EMPTY_TURNS)
      const turns = React.useMemo(() => mergeTurns(hostTurns, localTurns), [hostTurns, localTurns])
      const probeRef = React.useRef(null)
      const railRef = React.useRef(null)
      const scrollerRef = React.useRef(null)
      const turnsRef = React.useRef(turns)
      turnsRef.current = turns
      const frameRef = React.useRef(0)
      const emphasizedRef = React.useRef(null)
      const [geo, setGeo] = React.useState(null)
      const [overflows, setOverflows] = React.useState(false)
      const [active, setActive] = React.useState(0)
      const [emphasized, setEmphasized] = React.useState(null)
      const [previewAnchor, setPreviewAnchor] = React.useState(0)
      const [previewTop, setPreviewTop] = React.useState(0)
      const previewRef = React.useRef(null)
      const hideTimerRef = React.useRef(0)
      const [pending, setPending] = React.useState(null)
      const [railAtTop, setRailAtTop] = React.useState(true)
      const [railAtBottom, setRailAtBottom] = React.useState(true)
      emphasizedRef.current = emphasized
      const geoRef = React.useRef(null)
      geoRef.current = geo

      // 移出刻度不立刻收卡：留 HIDE_DELAY 的窗口，鼠标进了卡里就撤销这次收起，
      // 于是可以在卡内滚动看完整段摘要。
      const cancelHide = () => {
        if (hideTimerRef.current === 0) return
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = 0
      }
      const scheduleHide = () => {
        cancelHide()
        hideTimerRef.current = setTimeout(() => {
          hideTimerRef.current = 0
          setEmphasized(null)
        }, HIDE_DELAY)
      }
      React.useEffect(() => cancelHide, [])

      React.useEffect(() => {
        setHostTurns(EMPTY_TURNS)
      }, [props.sessionId])

      React.useEffect(() => {
        let cancelled = false
        loadTurns(props.sessionId).then((list) => {
          if (!cancelled) setHostTurns(list.length === 0 ? EMPTY_TURNS : list)
        }).catch(() => {})
        return () => { cancelled = true }
      }, [props.sessionId, localTurns.length])

      const measure = () => {
        const scroller = scrollerRef.current
        if (!scroller) return
        const rect = scroller.getBoundingClientRect()
        setOverflows(scroller.scrollHeight > scroller.clientHeight + OVERFLOW_MARGIN)
        setGeo({ left: rect.left + 10, top: rect.top, width: rect.width, height: rect.height })
      }

      const updateActive = () => {
        const scroller = scrollerRef.current
        const list = turnsRef.current
        if (!scroller || list.length === 0) return
        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_THRESHOLD) {
          setActive(list.length - 1)
          return
        }
        const rect = scroller.getBoundingClientRect()
        const line = rect.top + Math.min(120, rect.height * 0.3)
        const indexByKey = new Map(list.map((turn, index) => [turn.key, index]))
        let current = 0
        scroller.querySelectorAll('[data-chat-flow-kind="user"]').forEach((row) => {
          if (row.getBoundingClientRect().top <= line) {
            const index = indexByKey.get(row.dataset.chatAnchorKey)
            if (index !== undefined) current = index
          }
        })
        setActive(current)
      }

      React.useEffect(() => {
        const probe = probeRef.current
        if (!probe) return undefined
        let scroller = null
        let parent = probe.parentElement
        while (parent) {
          if (typeof parent.matches === 'function' && parent.matches('[data-conversation-scroll]')) {
            scroller = parent
            break
          }
          const found = parent.querySelector('[data-conversation-scroll]')
          if (found) { scroller = found; break }
          parent = parent.parentElement
        }
        scrollerRef.current = scroller
        if (!scroller) return undefined
        measure()
        updateActive()
        const onScroll = () => {
          if (frameRef.current) return
          frameRef.current = requestAnimationFrame(() => {
            frameRef.current = 0
            measure()
            updateActive()
          })
        }
        scroller.addEventListener('scroll', onScroll, { passive: true })
        const observer = new ResizeObserver(measure)
        observer.observe(scroller)
        if (scroller.firstElementChild) observer.observe(scroller.firstElementChild)
        return () => {
          scroller.removeEventListener('scroll', onScroll)
          observer.disconnect()
          if (frameRef.current) {
            cancelAnimationFrame(frameRef.current)
            frameRef.current = 0
          }
        }
      }, [turns.length])

      const activeIndex = Math.min(active, Math.max(0, turns.length - 1))

      React.useEffect(() => {
        const rail = railRef.current
        if (!rail || emphasizedRef.current !== null) return
        const target = activeIndex * PITCH - rail.clientHeight / 2 + PITCH / 2
        rail.scrollTop = Math.max(0, target)
      }, [activeIndex, turns.length])

      const findRow = (key) => {
        const scroller = scrollerRef.current
        if (!scroller) return null
        const rows = scroller.querySelectorAll('[data-chat-anchor-key]')
        for (const row of rows) {
          if (row.dataset.chatAnchorKey === key) return row
        }
        return null
      }

      const jumpTo = async (index) => {
        const turn = turnsRef.current[index]
        if (!turn) return
        setActive(index)
        let row = findRow(turn.key)
        if (row === null) {
          const binding = sessionsSvc && sessionsSvc.binding(props.sessionId)
          const session = binding && binding.session
          if (!session || typeof session.loadOlder !== 'function') return
          setPending(index)
          try {
            for (let page = 0; page < MAX_PAGE_LOADS && row === null; page++) {
              await session.loadOlder()
              await nextFrame()
              await nextFrame()
              row = findRow(turn.key)
            }
          } finally {
            setPending(null)
          }
        }
        if (row !== null) row.scrollIntoView({ block: 'start', behavior: 'auto' })
      }

      const emphasize = (index, target) => {
        cancelHide()
        if (emphasizedRef.current === index) return
        setEmphasized(index)
        if (!target) return
        const tickRect = target.getBoundingClientRect()
        setPreviewAnchor(tickRect.top + tickRect.height / 2)
      }

      // 卡片高度随内容长短变，位置只能等它上了屏再量：以刻度中心对齐，再把整张
      // 卡夹进对话区的上下缘。useLayoutEffect 在浏览器绘制前跑完，看不到位移。
      React.useLayoutEffect(() => {
        const node = previewRef.current
        const rail = railRef.current
        if (node === null || rail === null) return
        const bounds = geoRef.current
        const half = node.offsetHeight / 2
        const min = (bounds === null ? 0 : bounds.top) + PREVIEW_MARGIN + half
        const max = (bounds === null ? window.innerHeight : bounds.top + bounds.height) - PREVIEW_MARGIN - half
        const center = Math.max(min, Math.min(Math.max(min, max), previewAnchor))
        setPreviewTop(center - rail.getBoundingClientRect().top)
      }, [previewAnchor, emphasized])

      const onRailMouseMove = (ev) => {
        const tick = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('.dsh-convmap-tick')
          : null
        if (!tick) return
        emphasize(Number(tick.dataset.index), tick)
      }

      const onRailScroll = (ev) => {
        const rail = ev.currentTarget
        setRailAtTop(rail.scrollTop <= 1)
        setRailAtBottom(rail.scrollHeight - rail.scrollTop - rail.clientHeight <= 1)
      }

      const show = geo !== null && turns.length >= 2 && overflows && geo.width >= MIN_CONVERSATION_WIDTH

      return e(
        React.Fragment,
        null,
        e('span', { ref: probeRef, style: { display: 'none' } }),
        show
          ? e(
              'nav',
              {
                className: 'dsh-convmap-nav',
                'aria-label': '对话地图',
                style: {
                  left: geo.left,
                  top: geo.top + geo.height / 2,
                  transform: 'translateY(-50%)',
                  height: Math.min(turns.length * PITCH, geo.height * 0.8),
                },
              },
              e(
                'div',
                {
                  className: 'dsh-convmap-rail',
                  ref: railRef,
                  onScroll: onRailScroll,
                  onMouseMove: onRailMouseMove,
                  onMouseEnter: cancelHide,
                  onMouseLeave: scheduleHide,
                },
                turns.map((turn, index) => {
                  const distance = emphasized === null ? Infinity : Math.abs(index - emphasized)
                  const scale = distance === 0 ? 1 : distance === 1 ? 0.68 : distance === 2 ? 0.44 : 0.25
                  const hot = index === activeIndex || index === emphasized
                  const lineClass = index === pending
                    ? 'dsh-convmap-line--pending'
                    : hot ? 'dsh-convmap-line--hot' : 'dsh-convmap-line--idle'
                  return e(
                    'button',
                    {
                      key: turn.key,
                      type: 'button',
                      className: 'dsh-convmap-tick',
                      'data-index': index,
                      'aria-label': '第 ' + (index + 1) + ' 轮：' + turn.prompt,
                      'aria-current': index === activeIndex ? 'step' : undefined,
                      tabIndex: index === activeIndex ? 0 : -1,
                      onClick: (ev) => {
                        cancelHide()
                        setEmphasized(null)
                        if (ev.detail > 0) ev.currentTarget.blur()
                        jumpTo(index)
                      },
                      onFocus: (ev) => emphasize(index, ev.currentTarget),
                      onBlur: () => setEmphasized((cur) => (cur === index ? null : cur)),
                      onKeyDown: (ev) => {
                        let target = null
                        if (ev.key === 'ArrowUp') target = Math.max(0, index - 1)
                        else if (ev.key === 'ArrowDown') target = Math.min(turns.length - 1, index + 1)
                        else if (ev.key === 'Home') target = 0
                        else if (ev.key === 'End') target = turns.length - 1
                        else if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault()
                          jumpTo(index)
                          return
                        }
                        if (target === null) return
                        ev.preventDefault()
                        const rail = railRef.current
                        if (rail && rail.children[target]) rail.children[target].focus()
                      },
                    },
                    e('span', {
                      className: 'dsh-convmap-line ' + lineClass,
                      style: { width: 32 * scale },
                    }),
                  )
                }),
              ),
              e('div', {
                className: 'dsh-convmap-fade dsh-convmap-fade--top',
                style: { opacity: railAtTop ? 0 : 1 },
              }),
              e('div', {
                className: 'dsh-convmap-fade dsh-convmap-fade--bottom',
                style: { opacity: railAtBottom ? 0 : 1 },
              }),
              emphasized !== null && turns[emphasized]
                ? e(
                    'div',
                    {
                      className: 'dsh-convmap-preview',
                      ref: previewRef,
                      style: { top: previewTop, transform: 'translateY(-50%)' },
                      onMouseEnter: cancelHide,
                      onMouseLeave: scheduleHide,
                    },
                    e('div', { className: 'dsh-convmap-prompt' }, turns[emphasized].prompt),
                    turns[emphasized].response
                      ? e('div', { className: 'dsh-convmap-response' }, turns[emphasized].response)
                      : null,
                  )
                : null,
            )
          : null,
      )
    }

    // 会话服务：跳转到未渲染的老轮次时用它的 loadOlder 逐页补齐。
    let sessionsSvc = null

    function apply(ctx) {
      const slots = ctx.get('slots')
      sessionsSvc = ctx.get('sessions')
      if (slots === undefined) return
      installStyles()
      slots.inject('conversation.input.overlay', () =>
        slots.register(
          { name: 'conversation.input.overlay', id: 'dsh-convmap', order: 60, label: '对话地图' },
          (props) => e(ConversationMap, props),
        ),
      )
    }
    apply(ctx)
  },
}
