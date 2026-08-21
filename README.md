# dsh-convmap

DeepSeek Harness web 插件：**对话地图**。在主对话区**左缘垂直居中**渲染一列刻度，每条刻度对应当前会话的一轮用户提问——悬停按距离梯度展开并预览该轮提问/回复摘要，点击跳转到对应轮次，滚动对话时当前轮次刻度自动高亮跟随。

由动态插件形态（`msgmap-1` 的 `pkg-1`→`pkg-3`，逐轮调过的那版）逐字固化而来的正式 bundle，装好重启即自动挂载。

![对话地图：主对话区左缘的刻度列与悬停预览卡](docs/preview.png)

<img src="docs/preview-rail.png" width="640" alt="刻度按到鼠标的像素距离连续展开，右侧浮出该轮的提问与回复摘要">

> 截图说明：刻度数据是合成的（120 轮，用来演示刻度多时的渐变形态），预览卡里的文字也是合成的；
> 会话正文、侧栏与标题已整体虚化，画面里只有插件本体是原样渲染。

## 功能

- **全量轮次刻度**：host 侧直读会话完整日志，刻度覆盖当前对话**所有**轮次（不受客户端分页窗口限制），不再只有最近一两对；轮次多时刻度区自身可滚动，上下有渐变遮罩。
- **代理自跑的轮次也有刻度**：一轮里只要有你发的消息，就只给你的消息立刻度；**整轮没有人发言**的轮次（插件注入的通知起的头，例如审批策略变更、`Cordis run … completed`）留该轮第一条注入消息当刻度——否则这类会话整条地图会是空的。
- **先画后补（长会话不空等）**：刻度先用**已渲染的轮次**立刻画出来，host 的全量结果回来后再合并——历史在前，本地还没落盘的新轮次接在后面。长会话第一次要等 host 折一遍日志，这期间刻度不是空的。
- **Hover 梯度展开**：鼠标划过刻度区，邻近刻度按距离梯度展开（距离 0/1/2/3 条分别是 1 / 0.68 / 0.44 / 0.25，中间**按鼠标的像素位置连续插值**），右侧浮出预览卡：该轮提问摘要 + 该轮最后一次回复摘要。
- **刻度多也跟手**：渐变不走 React、也不走 CSS 过渡——每帧只改鼠标附近 7 条刻度的一个 CSS 变量（`transform: scaleX()`，纯合成），预览卡的内容另按 120ms 限频。几百条刻度时实测最长的那条刻度对鼠标的滞后从中位 2 条降到 0 条；6 倍降频的压力测试下中位帧 67ms→50ms、长任务 138→60。
- **预览卡可停可滚**：卡片 420×最高 320 px，**按位置**决定去留而不是按时长——指针在刻度区、卡片、或两者之间那条 8px 过道里就留着（够把鼠标挪进卡，斜着切进去也接得住），去了别处立刻收。进卡后提问标题钉在顶部，回复正文可滚轮下滑看完整段，滚动不外溢到对话。预览量有上限——host 侧把提问截到 200 字、回复截到 800 字，滚到底就是这么多（要改就改 `lib/index.js` 的 `PROMPT_LIMIT` / `RESPONSE_LIMIT`）。
- **点击跳转**：刻度按下即滚动对话到对应轮次；点击尚未渲染的老轮次时，自动逐页「加载更早」直到目标行出现再跳转（加载中该刻度脉冲闪烁）。
- **滚动高亮**：滚动对话时，当前可视轮次的刻度自动加粗高亮并保持在刻度区可视范围。
- **键盘可达**：Tab 聚焦后 ↑/↓/Home/End 移动，Enter 跳转。
- **无干扰**：刻度区不拦截周边交互（预览卡显示期间会接收鼠标事件，这是为了能滚它；卡一收起就完全不挡）；≥2 轮用户消息、内容溢出且对话区宽度足够时才显示；被 compaction 折叠进摘要的远古轮次没有可视行可跳时，跳转静默无效（预期行为）。

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/GeekRicardo/dsh-convmap/main/install.sh | bash
```

脚本做的事（可先 `--dry-run` 预览）：

1. 在 `~/.dsh/profiles/web/package.json` 写入依赖 `"dsh-convmap": "github:GeekRicardo/dsh-convmap"`；
2. 把 `dsh-convmap` 追加进 `dsh.profile.bundles`；
3. `cd ~/.dsh/profiles/web && pnpm install`；
4. 校验 bundles 已注册，提示重启。

重启 DSH 并硬刷新页面后生效：

```bash
pm2 restart dsh-web   # 若用 pm2 托管；否则用你的启动方式重启
```

## 卸载

```bash
bash install.sh --uninstall            # 加 --dry-run 可先看要做什么
```

它与安装完全对称：从 `~/.dsh/profiles/web/package.json` 的 `dependencies` 与
`dsh.profile.bundles` 里摘掉 `dsh-convmap`，再 `pnpm install`，最后校验确实摘干净。
加 `--restart` 可顺带重启 pm2 托管的 dsh-web。

手工卸载（等价步骤）：

```bash
# 1. 从 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 移除 "dsh-convmap"
# 2. 移除 dependencies 里的 "dsh-convmap"
# 3. cd ~/.dsh/profiles/web && pnpm install
# 4. 重启 DSH
```

停用后页面行为完全恢复出厂，插件不残留任何副作用。

## 前置条件

- DeepSeek Harness 已初始化 web profile（`~/.dsh/profiles/web` 存在）。
- Node.js ≥ 20、pnpm 可用。

## 工作原理

| 半区 | 职责 |
| --- | --- |
| Host | 注册同源路由 `GET /dsh-convmap/turns?sessionId=…`（loopback + 同源守卫）：经 `sessionPersistence.readRaw` 读**原始日志文本**（含未渲染历史）按行折出所有轮次 `{ key, prompt, response, seq }`；key 按引擎的 `conversationContextKey(kind, id)` 规则重建为 `13:input-message<messageId>`（`13` = `"input-message".length`），与客户端 DOM 锚点一一对应；提问/回复摘要在 host 侧就截到 200 / 800 字（`PROMPT_LIMIT` / `RESPONSE_LIMIT`，即预览的上限）|
| Client | 在 `conversation.input.overlay` 槽位（list 槽、会话作用域）挂刻度组件；刻度 = 已渲染轮次（`useSession` 的 chat 快照）与 host 全量轮次的合并；靠 `data-conversation-scroll` 定位对话滚动容器、`data-chat-anchor-key` 定位目标行；未渲染的老轮次经 `sessions.binding(sessionId).session.loadOlder()` 逐页加载后再跳转（上限 60 页） |

### 长会话为什么不再卡（实测）

最初 host 走 `sessionQuery.readSession`，它把整条日志喂给 `Session.create` 做**全量重放校验**——那是恢复会话用的路径，画刻度根本不需要。一条 2.4 MB / 5998 帧 / 8004 行的真实日志上：

| 读法 | 冷启 | 命中缓存 |
| --- | --- | --- |
| `sessionQuery.readSession`（重放校验） | **33 s** | — |
| `sessionPersistence.readRaw` + 折行 | **1.1 s**（其中解压 0.5 s、折行 0.12 s） | **0.02–0.12 s** |

缓存键是 `readStoredRevision`——它只 stat 不读字节，日志又是 append-only，所以没变就直接返回上次折好的结果。这套「revision 当缓存键 + 只折需要的行 + 先渲染已有的再补全量」是照着 Orca 扫描 transcript 的做法搬的：它对每个会话文件按 `dev:ino:birthtime` 记身份、按字节偏移增量续读、把解析结果持久化复用（其 issue #9210 记录的冷扫是 6.7 GB / 109 s）。

### 契约说明（对照 dsh 引擎）

- 刻度 key 与 DOM 锚点 key 同源（同一拼接规则），保证「点击 → 滚动到行」精确对应。
- host 提取判定与客户端渲染判定一致（`surfaceOp === 'append'` 的 `user/message`，人的消息优先），避免出现客户端不渲染的幽灵刻度。
- 只消费 host 服务（`webServer` / `sessionPersistence`，回退时 `sessionQuery`）、不发布服务，`cordis.patch.yml` 不包 isolate realm，卸载即完全还原。

## 开发

```bash
node --test test/*.test.mjs     # host 侧折轮次的契约测试（事件数组 + 原始日志两条路径）
node scripts/build-dynamic.mjs  # 生成 lib/client.dynamic.js（动态插件形态）
```

渲染逻辑只有一份，在 `lib/client.js` 的「共享本体」区间里。要在运行中的 DSH 里热改这个插件，
就跑一次 `build-dynamic`，把 `lib/client.dynamic.js` 贴进 `cordis_define` 的 `code.client`
（host 半边把 `lib/index.js` 的 `buildTurns` 挂到 `harness.handle("turns")` 上），
调好后改回 `lib/client.js` 再生成一次。两种形态的差别只有三处环境接线：

| 接线 | bundle | 动态插件 |
| --- | --- | --- |
| 样式 | `document.head` 常驻 `<style id="dsh-convmap-style">` | `styles.insert(CSS_TEXT)` |
| 取轮次 | `fetch("/dsh-convmap/turns?sessionId=…")` | `host.call("turns", { sessionId })` |
| 取服务 | `ctx.slots` / `ctx.sessions` | `ctx.get("slots")` / `ctx.get("sessions")` |

> 装了正式 bundle 之后，记得在原来定义动态插件的那个会话里 `dsh_plugin_undefine`（或删除该动态包）：
> 动态定义持久在会话日志里，重启会随会话复活，两份实现会同时抢 `conversation.input.overlay` 的
> `dsh-convmap` 这个 id。

## 许可

MIT