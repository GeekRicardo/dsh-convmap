// lib/client.js（正式 bundle 形态）→ 动态 Cordis 插件的 client 半边源码。
//
// 两种形态的渲染逻辑一字不改，差的只有三处环境接线，全部在这里换：
//   document.head <style>        → styles.insert（随插件卸载自动清理）
//   fetch("/dsh-convmap/turns")  → host.call("turns", …)（沙盒里没有 host 路由）
//   ctx.slots / ctx.sessions     → ctx.get("slots") / ctx.get("sessions")
// React 不用换：bundle 里是 require("react") 拿到的闭包符号，动态形态里由
// evaluator 以同名参数注入，本体两边都只写 React.xxx。
//
// 用法：node scripts/build-dynamic.mjs   （写出 lib/client.dynamic.js）
// 用途：需要在 dsh 里热改这个插件时，把产物贴进 cordis_define 的 code.client，
//       改完再回到 lib/client.js 固化——本体只有一份，不会两边漂移。

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = readFileSync(join(root, 'lib/client.js'), 'utf8')

const BEGIN = '    // ---- 与动态插件形态共享的本体'
const END = '    // ---- 共享本体到此为止 ----'
const start = src.indexOf(BEGIN)
const end = src.indexOf(END)
if (start < 0 || end < 0) throw new Error('lib/client.js 的本体边界注释变了，转换脚本要跟着改')

let body = src.slice(src.indexOf('\n', start) + 1, end)

const swap = (from, to) => {
  if (!body.includes(from)) throw new Error(`转换锚点丢失：${from.slice(0, 60)}`)
  body = body.replace(from, to)
}

// 1) 样式：动态插件用 styles.insert，卸载时自动撤掉，不留常驻 <style>。
swap(
  `    const STYLE_ID = "dsh-convmap-style"
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement("style")
      style.id = STYLE_ID
      style.dataset.plugin = "dsh-convmap"
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
    }`,
  `    function installStyles() {
      styles.insert(CSS_TEXT)
    }`,
)

// 2) 轮次数据：动态形态没有 host 侧 HTTP 路由，走包私有的 client→host 调用。
swap(
  `      const qs = "?sessionId=" + encodeURIComponent(String(sessionId))
      return fetch("/dsh-convmap/turns" + qs)
        .then((response) => response.json())
        .then((result) => (result && result.ok && Array.isArray(result.turns) ? result.turns : []))`,
  `      return host.call("turns", { sessionId })
        .then((result) => (result && Array.isArray(result.turns) ? result.turns : []))`,
)

// 3) 服务取用：动态插件的 ctx 没有静态服务属性，只能按名字取。
swap(
  `      const slots = ctx.slots
      sessionsSvc = ctx.sessions`,
  `      const slots = ctx.get('slots')
      sessionsSvc = ctx.get('sessions')`,
)

const header = `// dsh-convmap — 动态 Cordis 插件形态（由 scripts/build-dynamic.mjs 从 lib/client.js 生成，勿手改）
// 与固化版的差异只有环境接线：styles.insert / host.call / ctx.get。
// host 半边不用生成：把 lib/index.js 的 buildTurns 原样搬进
// harness.handle("turns", …) 即可（动态沙盒里没有 webServer 路由）。
`
const out = `${header}return {\n  name: "dsh-convmap",\n  inject: ["slots", "sessions"],\n  apply(ctx) {\n${body}    apply(ctx)\n  },\n}\n`
writeFileSync(join(root, 'lib/client.dynamic.js'), out)
process.stdout.write(`lib/client.dynamic.js 已生成（${out.length} 字符）\n`)
