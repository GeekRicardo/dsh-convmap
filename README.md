# dsh-convmap

DeepSeek Harness web 插件：**对话地图**。在主对话区**左缘垂直居中**渲染一列刻度，每条刻度对应当前会话的一轮用户提问——悬停按距离梯度展开并预览该轮提问/回复摘要，点击跳转到对应轮次，滚动对话时当前轮次刻度自动高亮跟随。

基于之前动态验证（`pkg-1`→`pkg-3`）固化的正式 bundle，重启后自动挂载。

## 功能

- **全量轮次刻度**：host 侧直读会话完整日志，刻度覆盖当前对话**所有**用户轮次（不受客户端分页窗口限制），不再只有最近一两对；轮次多时刻度区自身可滚动，上下有渐变遮罩。
- **Hover 梯度展开**：鼠标划过刻度区，邻近刻度按距离梯度展开（1 / 0.68 / 0.44 / 0.25 宽度），右侧浮出预览卡：该轮提问摘要 + 该轮最后一次回复摘要。
- **点击跳转**：刻度按下即滚动对话到对应轮次；点击尚未渲染的老轮次时，自动逐页「加载更早」直到目标行出现再跳转（加载中该刻度脉冲闪烁）。
- **滚动高亮**：滚动对话时，当前可视轮次的刻度自动加粗高亮并保持在刻度区可视范围。
- **键盘可达**：Tab 聚焦后 ↑/↓/Home/End 移动，Enter 跳转。
- **无干扰**：刻度区不拦截周边交互；≥2 轮用户消息、内容溢出且对话区宽度足够时才显示；被 compaction 折叠进摘要的远古轮次没有可视行可跳时，跳转静默无效（预期行为）。

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
| Host | 注册 harness 命令 `turns`：经 `sessionQuery.readSession` 读**全量**会话事件（含未渲染历史），按「用户消息事件」提取所有轮次 `{ key, prompt, response }`，key 按引擎规则重建（`<turn>:input-message<messageId>`），与客户端 DOM 锚点一一对应 |
| Client | 在 `conversation.input.overlay` 槽位附加式挂载刻度组件；读取款式锚点 `data-chat-anchor-key` / `data-conversation-scroll` 做滚动定位与跳转；未渲染的老轮次经 `sessions.binding(sessionId).session.loadOlder()` 逐页加载后再跳转 |

### 契约说明（对照 dsh 引擎）

- 刻度 key 与 DOM 锚点 key 同源（同一拼接规则），保证「点击 → 滚动到行」精确对应。
- host 提取判定与客户端渲染判定一致（`source.kind === 'user'` + `surfaceOp === 'append'`），避免出现客户端不渲染的幽灵刻度。
- 只消费 host 服务、不发布服务，`cordis.patch.yml` 不包 isolate realm，卸载即完全还原。

## 许可

MIT