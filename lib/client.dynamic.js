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
    // 卡片左缘相对刻度区左缘的偏移；刻度区宽 44，所以中间留 8px 过道。
    const PREVIEW_LEFT = 52
    // 卡片最快多久换一次内容。渐变必须跟满 60fps 才顺，但卡片换一次要重排
    // 几百字的正文再重绘 420×320——快速划过刻度区时没人在读它，降到 ~8Hz。
    const PREVIEW_RATE = 120
    // 渐变不再靠 CSS 过渡去补台阶——它按鼠标的像素位置连续算，本来就没有台阶。
    // 过渡只留给 opacity（高亮切换）。原来 transform 上那条 300ms 过渡是"卡"
    // 的主因之一：鼠标每跨一条刻度就把邻近几条的过渡重起一遍，动画永远跑不完、
    // 一直被改目标，既拖手又贵（实测占 hover 开销的近一半）。
    const GRADIENT_MS = 130
    // 渐变的取值：距离 0/1/2/3 条刻度分别是这几档，中间线性插值。
    // 之前是按整数距离取档，所以鼠标在一条刻度内移动时长短纹丝不动、
    // 跨过去又突然跳一档；按连续距离算就成了真正跟手的放大镜。
    const GRADIENT_STEPS = [1, 0.68, 0.44, 0.25]
    const GRADIENT_MIN = 0.25
    const GRADIENT_REACH = 3
    // 卡片上下缘离对话区的最小留白（夹紧竖直位置用）。
    const PREVIEW_MARGIN = 12
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
.dsh-convmap-line { display: block; width: 32px; height: 2px; border-radius: 999px; transform-origin: left center; transform: scaleX(var(--dsh-convmap-k, ${GRADIENT_MIN})); transition: opacity ${GRADIENT_MS}ms ease-out; }
.dsh-convmap-line--idle { background: var(--dsw-alias-label-secondary); opacity: .35; }
.dsh-convmap-line--hot { background: var(--dsw-alias-label-primary); opacity: 1; }
.dsh-convmap-line--pending { background: var(--dsw-alias-brand-primary); opacity: 1; animation: dsh-convmap-pulse .8s ease-in-out infinite alternate; }
.dsh-convmap-line--hover { background: var(--dsw-alias-label-primary); opacity: 1; }
@keyframes dsh-convmap-pulse { from { opacity: .35; } to { opacity: 1; } }
.dsh-convmap-fade { position: absolute; left: 0; right: 0; height: 20px; pointer-events: none; transition: opacity .2s; z-index: 1; }
.dsh-convmap-fade--top { top: 0; background: linear-gradient(to bottom, var(--dsw-alias-bg-base), transparent); }
.dsh-convmap-fade--bottom { bottom: 0; background: linear-gradient(to top, var(--dsw-alias-bg-base), transparent); }
.dsh-convmap-preview { position: absolute; left: ${PREVIEW_LEFT}px; top: 0; will-change: transform; contain: layout; width: ${PREVIEW_WIDTH}px; max-height: ${PREVIEW_MAX_HEIGHT}px; display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); box-shadow: 0 8px 28px rgba(0,0,0,.18); z-index: 2; }
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

    // 距离（单位：刻度）→ 长短系数。整数距离上与旧版逐档取值完全一致。
    function tickScale(distance) {
      if (distance >= GRADIENT_REACH) return GRADIENT_MIN
      const step = Math.floor(distance)
      return GRADIENT_STEPS[step] + (GRADIENT_STEPS[step + 1] - GRADIENT_STEPS[step]) * (distance - step)
    }

    function lineAt(rail, index) {
      const tick = rail.children[index]
      return tick === undefined ? null : tick.firstElementChild
    }

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }

    // 单条刻度。memo 掉，而且 props 里**没有**跟 hover 有关的东西——长短和高亮
    // 都由 paintGradient 直接写 DOM（CSS 变量 + 一个 class）。所以鼠标划过刻度区
    // 时 React 一次都不用重渲染这几百条，这是 hover 开销里最后那一块。
    const Tick = React.memo(function Tick(props) {
      return e(
        'button',
        {
          type: 'button',
          className: 'dsh-convmap-tick',
          'data-index': props.index,
          'aria-label': '第 ' + (props.index + 1) + ' 轮：' + props.label,
          'aria-current': props.current ? 'step' : undefined,
          tabIndex: props.current ? 0 : -1,
          onClick: props.handlers.onClick,
          onFocus: props.handlers.onFocus,
          onBlur: props.handlers.onBlur,
          onKeyDown: props.handlers.onKeyDown,
        },
        // 长短是 transform: scaleX(var(--dsh-convmap-k))，只走合成，不触发重排。
        e('span', { className: 'dsh-convmap-line dsh-convmap-line--' + props.tone }),
      )
    })

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
      // 当前 hover 到哪条刻度。是 ref 不是 state——hover 时不需要 React 重渲染。
      const hoverRef = React.useRef(null)
      const paintedRef = React.useRef([])
      const [geo, setGeo] = React.useState(null)
      const [overflows, setOverflows] = React.useState(false)
      const [active, setActive] = React.useState(0)
      // 渐变由 paintGradient 直接写 DOM（hoverRef），卡片才是 React 状态且限频。
      // 两者分开的意义：扫过刻度区时只有几个 CSS 变量在动，React 和卡片都不参与。
      const [preview, setPreview] = React.useState(null)
      const [previewTop, setPreviewTop] = React.useState(0)
      const anchorRef = React.useRef(0)
      const previewRateRef = React.useRef({ at: 0, timer: 0 })
      const previewRef = React.useRef(null)
      const previewRefIndex = React.useRef(null)
      const hoverFrameRef = React.useRef(0)
      const [pending, setPending] = React.useState(null)
      const [railAtTop, setRailAtTop] = React.useState(true)
      const [railAtBottom, setRailAtBottom] = React.useState(true)
      const geoRef = React.useRef(null)
      geoRef.current = geo
      // 安全区的矩形缓存：命中测试每次 mousemove 都跑，不能在里面量布局
      // （getBoundingClientRect 会逼一次同步重排，刻度多时非常贵）。
      const zoneRef = React.useRef(null)

      // 卡片什么时候收：按位置判，不按时长判。安全区 = 刻度区 ∪ 卡片 ∪ 两者
      // 之间那条 8px 的过道（过道的纵向范围取卡片与当前刻度的并集，斜着切进
      // 卡里也接得住）。这样「从刻度挪去卡里」怎么绕都不消失，而「甩去页面别
      // 处」零延迟消失——定时器做不到这个区分，它对两种去向一视同仁。
      const inSafeZone = (x, y) => {
        const rail = railRef.current
        const zone = zoneRef.current
        if (rail === null || zone === null) return false
        // 键盘聚焦弹出的卡不归鼠标管，否则手一碰鼠标卡就没了。
        if (rail.contains(document.activeElement)) return true
        if (x >= zone.railLeft && x <= zone.railRight && y >= zone.railTop && y <= zone.railBottom) return true
        if (x >= zone.cardLeft && x <= zone.cardRight && y >= zone.cardTop && y <= zone.cardBottom) return true
        return x >= zone.railRight && x <= zone.cardLeft
          && y >= Math.min(zone.cardTop, zone.anchor - PITCH)
          && y <= Math.max(zone.cardBottom, zone.anchor + PITCH)
      }

      React.useEffect(() => {
        if (preview === null) return undefined
        const onMove = (ev) => {
          if (!inSafeZone(ev.clientX, ev.clientY)) dismiss()
        }
        const onLeaveWindow = () => dismiss()
        document.addEventListener('mousemove', onMove, true)
        document.documentElement.addEventListener('mouseleave', onLeaveWindow)
        return () => {
          document.removeEventListener('mousemove', onMove, true)
          document.documentElement.removeEventListener('mouseleave', onLeaveWindow)
        }
      }, [preview])

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
        if (!rail || hoverRef.current !== null) return
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

      // 渐变直接写进 DOM：只碰鼠标附近 2*GRADIENT_REACH+1 条刻度的一个 CSS 变量，
      // 不重排、不重绘别的、也不惊动 React。位置用鼠标的像素坐标算成"小数刻度"，
      // 所以在一条刻度内部移动长短也在连续变——这就是跟手的来源。
      const paintGradient = (index, tickRect, pointerY) => {
        const rail = railRef.current
        if (rail === null) return
        const focus = index + (pointerY - tickRect.top) / tickRect.height - 0.5
        const lo = Math.max(0, Math.ceil(focus - GRADIENT_REACH))
        const hi = Math.min(rail.children.length - 1, Math.floor(focus + GRADIENT_REACH))
        for (const painted of paintedRef.current) {
          if (painted >= lo && painted <= hi) continue
          const line = lineAt(rail, painted)
          if (line === null) continue
          line.style.removeProperty('--dsh-convmap-k')
          line.classList.remove('dsh-convmap-line--hover')
        }
        const next = []
        for (let i = lo; i <= hi; i++) {
          const line = lineAt(rail, i)
          if (line === null) continue
          line.style.setProperty('--dsh-convmap-k', String(tickScale(Math.abs(i - focus))))
          line.classList.toggle('dsh-convmap-line--hover', i === index)
          next.push(i)
        }
        paintedRef.current = next
        hoverRef.current = index
        anchorRef.current = tickRect.top + tickRect.height / 2
      }

      const clearGradient = () => {
        const rail = railRef.current
        if (rail !== null) {
          for (const painted of paintedRef.current) {
            const line = lineAt(rail, painted)
            if (line === null) continue
            line.style.removeProperty('--dsh-convmap-k')
            line.classList.remove('dsh-convmap-line--hover')
          }
        }
        paintedRef.current = []
        hoverRef.current = null
      }

      // 卡片跟随 hover，但最快 PREVIEW_RATE 换一次内容；收起是立刻的。
      previewRefIndex.current = preview === null ? null : preview.index
      const pushPreview = () => {
        const rate = previewRateRef.current
        rate.at = performance.now()
        const index = hoverRef.current
        setPreview(index === null ? null : { index, anchor: anchorRef.current })
      }
      const schedulePreview = () => {
        const rate = previewRateRef.current
        if (hoverRef.current === null) {
          if (rate.timer !== 0) { clearTimeout(rate.timer); rate.timer = 0 }
          setPreview(null)
          return
        }
        // 卡片还没出来时立刻出，别让第一次 hover 有延迟。
        const elapsed = performance.now() - rate.at
        if (previewRefIndex.current === null || elapsed >= PREVIEW_RATE) {
          if (rate.timer !== 0) { clearTimeout(rate.timer); rate.timer = 0 }
          pushPreview()
          return
        }
        if (rate.timer !== 0) return
        rate.timer = setTimeout(() => {
          rate.timer = 0
          pushPreview()
        }, PREVIEW_RATE - elapsed)
      }

      const dismiss = () => {
        clearGradient()
        schedulePreview()
      }

      React.useEffect(() => () => {
        if (previewRateRef.current.timer !== 0) clearTimeout(previewRateRef.current.timer)
      }, [])

      // 卡片高度随内容长短变，位置只能等它上了屏再量：以刻度中心对齐，再把整张
      // 卡夹进对话区的上下缘。useLayoutEffect 在浏览器绘制前跑完，看不到位移。
      React.useLayoutEffect(() => {
        const node = previewRef.current
        const rail = railRef.current
        if (node === null || rail === null) {
          zoneRef.current = null
          return
        }
        const bounds = geoRef.current
        const half = node.offsetHeight / 2
        const min = (bounds === null ? 0 : bounds.top) + PREVIEW_MARGIN + half
        const max = (bounds === null ? window.innerHeight : bounds.top + bounds.height) - PREVIEW_MARGIN - half
        const center = Math.max(min, Math.min(Math.max(min, max), preview === null ? 0 : preview.anchor))
        const railRect = rail.getBoundingClientRect()
        setPreviewTop(center - railRect.top)
        // 卡片夹紧后会落在哪儿是算得出来的，直接记下来，省得命中测试再量一次。
        zoneRef.current = {
          railLeft: railRect.left, railRight: railRect.right,
          railTop: railRect.top, railBottom: railRect.bottom,
          cardLeft: railRect.left + PREVIEW_LEFT,
          cardRight: railRect.left + PREVIEW_LEFT + node.offsetWidth,
          cardTop: center - half, cardBottom: center + half,
          anchor: preview === null ? 0 : preview.anchor,
        }
      }, [preview, geo])

      // 鼠标划过刻度区一帧能来好几个 mousemove，按帧节流，一帧最多重渲染一次。
      const onRailMouseMove = (ev) => {
        const tick = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('.dsh-convmap-tick')
          : null
        if (!tick || hoverFrameRef.current !== 0) return
        const pointerY = ev.clientY
        hoverFrameRef.current = requestAnimationFrame(() => {
          hoverFrameRef.current = 0
          paintGradient(Number(tick.dataset.index), tick.getBoundingClientRect(), pointerY)
          schedulePreview()
        })
      }

      const onRailScroll = (ev) => {
        const rail = ev.currentTarget
        setRailAtTop(rail.scrollTop <= 1)
        setRailAtBottom(rail.scrollHeight - rail.scrollTop - rail.clientHeight <= 1)
      }

      // Tick 被 memo 掉了，处理器必须是稳定引用，否则每次渲染都换一批新闭包，
      // memo 全部落空。索引从 dataset 上读，最新的状态从 apiRef 上读。
      const apiRef = React.useRef(null)
      apiRef.current = { jumpTo, paintGradient, schedulePreview, dismiss, count: turns.length }
      const handlers = React.useMemo(() => ({
        onClick: (ev) => {
          const api = apiRef.current
          api.dismiss()
          if (ev.detail > 0) ev.currentTarget.blur()
          api.jumpTo(Number(ev.currentTarget.dataset.index))
        },
        onFocus: (ev) => {
          const rect = ev.currentTarget.getBoundingClientRect()
          apiRef.current.paintGradient(Number(ev.currentTarget.dataset.index), rect, rect.top + rect.height / 2)
          apiRef.current.schedulePreview()
        },
        onBlur: (ev) => {
          if (hoverRef.current !== Number(ev.currentTarget.dataset.index)) return
          apiRef.current.dismiss()
        },
        onKeyDown: (ev) => {
          const api = apiRef.current
          const index = Number(ev.currentTarget.dataset.index)
          let target = null
          if (ev.key === 'ArrowUp') target = Math.max(0, index - 1)
          else if (ev.key === 'ArrowDown') target = Math.min(api.count - 1, index + 1)
          else if (ev.key === 'Home') target = 0
          else if (ev.key === 'End') target = api.count - 1
          else if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault()
            api.jumpTo(index)
            return
          }
          if (target === null) return
          ev.preventDefault()
          const rail = railRef.current
          if (rail && rail.children[target]) rail.children[target].focus()
        },
      }), [])

      React.useEffect(() => () => {
        if (hoverFrameRef.current !== 0) cancelAnimationFrame(hoverFrameRef.current)
      }, [])

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
                },
                turns.map((turn, index) => {
                  return e(Tick, {
                    key: turn.key,
                    index,
                    label: turn.prompt,
                    tone: index === pending ? 'pending' : index === activeIndex ? 'hot' : 'idle',
                    current: index === activeIndex,
                    handlers,
                  })
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
              preview !== null && turns[preview.index]
                ? e(
                    'div',
                    {
                      className: 'dsh-convmap-preview',
                      ref: previewRef,
                      style: { transform: 'translateY(' + previewTop + 'px) translateY(-50%)' },
                    },
                    e('div', { className: 'dsh-convmap-prompt' }, turns[preview.index].prompt),
                    turns[preview.index].response
                      ? e('div', { className: 'dsh-convmap-response' }, turns[preview.index].response)
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
