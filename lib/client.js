// dsh-convmap — client face（对话地图：主对话区左缘的刻度导航）
//
// 挂载：conversation.input.overlay（附加式 + 会话作用域），组件收到框架给的
//       SessionStandardProps：useSession(selector) 与 sessionId。
// 数据源：
//   - 刻度全集来自 host /dsh-convmap/turns（全量轮次，含未渲染历史）；
//   - 实时交互用 useSession(snap.chat) 的已渲染轮次；
//   - 点击老轮次（未渲染）时经 sessions.binding(sessionId).session.loadOlder()
//     逐页加载直到目标行出现再滚动。
// 定位：entry 内 position:fixed 相对视口做「左缘垂直居中」，
//       滚动监听 [data-conversation-scroll] 刷新当前轮高亮。
// 生命周期：走 ctx.slots.inject + register，disposer 随 fiber unload 级联，
//       停用后无任何残留副作用。
window.__ModuleLoader__.load({
  id: "dsh-convmap",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots", "sessions"];

    var STYLE_ID = "dsh-convmap-style";
    var cssText =
      ".dcm-rail { position: fixed; left: 8px; top: 50%; transform: translateY(-50%); z-index: 40; " +
      "display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 6px 2px 6px 4px; " +
      "max-height: 60vh; overflow-y: auto; user-select: none; } " +
      ".dcm-rail::-webkit-scrollbar { width: 0; height: 0; } " +
      ".dcm-tick { position: relative; width: 8px; height: 14px; cursor: pointer; border: none; padding: 0; " +
      "background: transparent; display: block; transition: width .16s ease; } " +
      ".dcm-tick__bar { position: absolute; inset: 0 auto 0 0; width: 100%; border-radius: 3px; " +
      "background: var(--dsw-alias-label-disabled, rgba(120,120,128,.35)); transition: background .16s ease; } " +
      ".dcm-tick:hover .dcm-tick__bar, .dcm-tick--near .dcm-tick__bar { background: var(--dsw-alias-label-secondary, rgba(120,120,128,.65)); } " +
      ".dcm-tick--cur .dcm-tick__bar { background: var(--dsw-alias-accent-primary, #4f6ef7); } " +
      ".dcm-tick--loading .dcm-tick__bar { animation: dcm-pulse 1s ease-in-out infinite; } " +
      "@keyframes dcm-pulse { 0%,100%{opacity:.35} 50%{opacity:1} } " +
      ".dcm-preview { position: fixed; left: 52px; top: 50%; transform: translateY(-50%); z-index: 41; " +
      "max-width: 240px; background: var(--dsw-surface-primary, #fff); color: var(--dsw-text-primary, #1f2328); " +
      "border: 1px solid var(--dsw-border-default, rgba(0,0,0,.12)); border-radius: 8px; " +
      "box-shadow: 0 6px 24px rgba(0,0,0,.14); padding: 8px 10px; font-size: 11px; line-height: 1.45; " +
      "overflow: hidden; } " +
      ".dcm-preview__role { font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary); margin-bottom: 2px; } " +
      ".dcm-preview__text { color: var(--dsw-text-primary, #1f2328); display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; } " +
      ".dcm-preview__text--empty::after { content: \"(无文本)\"; color: var(--dsw-alias-label-disabled); }";

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = cssText;
      document.head.appendChild(style);
    }

    // 纯文本：ContentBlock[] 只拼 text 块。
    function textOfContent(blocks) {
      var out = "";
      if (Array.isArray(blocks)) {
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          if (b && b.type === "text" && typeof b.text === "string") out += b.text;
        }
      }
      return out.trim();
    }

    function summarize(s, max) {
      var t = String(s || "").replace(/\s+/g, " ").trim();
      if (!t) return "";
      return t.length > max ? t.slice(0, max) + "…" : t;
    }

    function indexOfKey(list, key) {
      for (var i = 0; i < list.length; i++) if (list[i].key === key) return i;
      return -1;
    }

    function findTurn(list, key) {
      for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
      return null;
    }

    // 当前可视轮次 key：遍历锚点行，找「底部已进入视口」的最靠上滚过的行。
    function visibleKey(port) {
      if (!port) return null;
      var rows = port.querySelectorAll("[data-chat-anchor-key]");
      if (!rows.length) return null;
      var portTop = port.getBoundingClientRect().top;
      var portBottom = portTop + port.clientHeight;
      var best = null;
      var bestTop = Infinity;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i].getBoundingClientRect();
        if (r.bottom > portTop + 4 && r.top < portBottom - 4) {
          var t = r.top - portTop;
          if (t < bestTop) { bestTop = t; best = rows[i].getAttribute("data-chat-anchor-key"); }
        }
      }
      return best;
    }

    function findRow(port, key) {
      if (!port) return null;
      var safe = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return port.querySelector('[data-chat-anchor-key="' + safe + '"]') || null;
    }

    function scrollToRow(port, row) {
      if (!port || !row) return;
      var delta = row.getBoundingClientRect().top - port.getBoundingClientRect().top;
      port.scrollTop += delta;
    }

    function ConvMap(props) {
      var sessionId = props.sessionId;
      var sessions = props.sessions;
      var useSession = props.useSession;
      var chat = useSession(function (snap) { return snap.chat; });

      var viewState = React.useState({ phase: "loading", turns: [] });
      var view = viewState[0];
      var setView = viewState[1];
      var hoverState = React.useState(null); // { key }
      var hover = hoverState[0];
      var setHover = hoverState[1];
      var curState = React.useState(null); // 当前可视轮次 key（随滚动刷新）
      var cur = curState[0];
      var setCur = curState[1];

      // 拉取 host 全量轮次，作为刻度全集（含未渲染历史）。
      React.useEffect(function () {
        var alive = true;
        setView({ phase: "loading", turns: [] });
        setCur(null);
        var qs = sessionId ? "?sessionId=" + encodeURIComponent(String(sessionId)) : "";
        fetch("/dsh-convmap/turns" + qs)
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (!alive) return;
            if (res && res.ok && Array.isArray(res.turns)) setView({ phase: "ok", turns: res.turns });
            else setView({ phase: "empty", turns: [] });
          })
          .catch(function () {
            if (!alive) return;
            setView({ phase: "empty", turns: [] });
          });
        return function () { alive = false; };
      }, [sessionId]);

      // 监听对话 scrollport，刷新当前轮高亮。
      React.useEffect(function () {
        function refresh() {
          setCur(visibleKey(document.querySelector("[data-conversation-scroll]")));
        }
        var port = document.querySelector("[data-conversation-scroll]");
        if (!port) return;
        port.addEventListener("scroll", refresh, { passive: true });
        refresh();
        return function () { port.removeEventListener("scroll", refresh); };
      }, [sessionId]);

      React.useEffect(function () { setHover(null); }, [sessionId]);

      var turns = view.turns || [];
      var ticks = [];
      for (var i = 0; i < turns.length; i++) {
        (function (turn, idx) {
          var key = turn.key;
          var rendered = chat && chat.nodes ? chat.nodes.get(key) : null;
          var prompt = turn.prompt || (rendered ? textOfContent(rendered.data && rendered.data.content) : "");
          var active = key === cur;
          var hIdx = hover ? indexOfKey(turns, hover.key) : -1;
          var dist = hIdx >= 0 ? Math.abs(hIdx - idx) : -1;
          var isNear = dist >= 0 && dist <= 3;
          var loading = view.phase === "ok" && view.loadingKey === key;
          var cls = "dcm-tick";
          if (active) cls += " dcm-tick--cur";
          else if (isNear) cls += " dcm-tick--near";
          if (loading) cls += " dcm-tick--loading";
          var w = active ? 16 : isNear ? Math.max(16 - dist * 4, 8) : 8;
          ticks.push(
            React.createElement("button", {
              key: key,
              className: cls,
              style: { width: w + "px" },
              title: summarize(prompt, 60) || key,
              onMouseEnter: function () { setHover({ key: key }); },
              onMouseLeave: function () { setHover(null); },
              onClick: function () { jumpTo(key); },
            }, React.createElement("span", { className: "dcm-tick__bar" })),
          );
        })(turns[i], i);
      }

      // 滚动到某轮：行已渲染 → 直接滚；未渲染 → loadOlder 逐页直到出现。
      function jumpTo(key) {
        var port = document.querySelector("[data-conversation-scroll]");
        if (!port) return;
        var row = findRow(port, key);
        if (row) {
          scrollToRow(port, row);
          setHover(null);
          setCur(key);
          return;
        }
        // 未渲染：标记脉冲 + 逐页加载直到行出现（上限防死循环）。
        setView({ phase: "ok", turns: turns, loadingKey: key });
        var binding = sessions && typeof sessions.binding === "function" ? sessions.binding(sessionId) : null;
        var face = binding && binding.session;
        if (!face || typeof face.loadOlder !== "function") {
          setView({ phase: "ok", turns: turns });
          return;
        }
        var tries = 0;
        (function step() {
          face.loadOlder().then(function () {
            var p2 = document.querySelector("[data-conversation-scroll]");
            var r2 = findRow(p2, key);
            if (r2) {
              scrollToRow(p2, r2);
              setCur(key);
              setHover(null);
              setView({ phase: "ok", turns: turns });
            } else if (tries++ < 10) {
              step();
            } else {
              setView({ phase: "ok", turns: turns });
            }
          });
        })();
      }

      // 悬停预览。
      var preview = null;
      if (hover) {
        var hit = findTurn(turns, hover.key);
        if (hit) {
          var pText = hit.prompt || "";
          var rText = hit.response || "";
          preview = React.createElement(
            "div",
            { className: "dcm-preview" },
            React.createElement("div", { className: "dcm-preview__role" }, "本轮提问 · " + summarize(pText, 26)),
            rText
              ? React.createElement("div", { className: "dcm-preview__text" }, summarize(rText, 160))
              : React.createElement("div", { className: "dcm-preview__text dcm-preview__text--empty" }),
          );
        }
      }

      // 显示条件：≥2 轮用户消息、对话区足够宽。
      if (view.phase !== "ok" || turns.length < 2) return null;
      if (window.innerWidth && window.innerWidth < 560) return null;

      return React.createElement("div", { className: "dcm-rail" }, ticks, preview);
    }

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject("conversation.input.overlay", function () {
        return ctx.slots.register(
          {
            name: "conversation.input.overlay",
            id: "dsh-convmap",
            order: 99,
            label: "对话地图",
          },
          function (entryProps) {
            // 会话级 slot entry：框架给 SessionStandardProps（useSession / sessionId）。
            return React.createElement(ConvMap, {
              sessionId: entryProps && entryProps.sessionId,
              useSession: entryProps && entryProps.useSession,
              sessions: ctx.sessions,
            });
          },
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});