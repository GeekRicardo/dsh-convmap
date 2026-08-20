// dsh-convmap — host face（对话地图的轮次数据源）
//
// 职责（纯消费 host 服务，不发布服务，全部进程内、可逆）：
// 1. 读该会话的完整日志——包括 web 端分页窗口之外、尚未渲染的历史轮次。
// 2. 折出全部用户轮次：每条 `surfaceOp === 'append'` 的 `user/message`
//    （source.kind === 'user'）是一条刻度，其后最后一条非空 `assistant/message`
//    的文本是该轮回复摘要。
// 3. 每条轮次带 `key`，按引擎的 conversationContextKey 规则重建，和 web 端
//    DOM 上的 `data-chat-anchor-key` 一一对应——client 靠它定位并滚动到该行。
// 4. 注册 /dsh-convmap/turns 路由供 client 拉取；只放行同源 loopback 请求。
//
// 为什么不用 sessionQuery.readSession：它会把整条日志喂给 Session.create 做
// 全量重放校验，而我们只要按行折文本。实测一条 2.4 MB / 6000 帧的日志，
// readSession 要 33 s，`sessionPersistence.readRaw` + 折行只要 0.5 s——
// 校验是给恢复会话用的，画刻度不需要它。
//
// 缓存：日志是 append-only，`readStoredRevision` 只 stat 不读字节，拿它当缓存
// 键——没变直接返回上次折好的轮次，变了才重折。这样长会话只有第一次要等。
//
// 摘要在 host 侧就截断（提问 100 字 / 回复 240 字）：刻度只用来预览，
// 整段正文没必要过网络，长会话下这一刀省掉的是数量级的传输量。

const inject = ["webServer", "sessionPersistence"];

/** 客户端会话节点的 kind：user / steering / context 三种消息同属这一个 Definition。 */
const CHAT_NODE_KIND = "input-message";

/** 提问摘要上限（字符数，按 code point 计）。 */
const PROMPT_LIMIT = 100;

/** 回复摘要上限（字符数，按 code point 计）。 */
const RESPONSE_LIMIT = 240;

/** 折好的轮次最多缓存多少个会话（按插入序淘汰最早的）。 */
const MAX_CACHED_SESSIONS = 32;

/**
 * 重建客户端节点 key，与引擎 `conversationContextKey(kind, id)` 同规则：
 * `${kind.length}:${kind}${id}`（见 dsh-client-runtime/client contract/conversation）。
 * @param {unknown} messageId - user/message 事件的 data.id。
 * @returns {string} 与 DOM 上 data-chat-anchor-key 相同的锚点 key。
 */
function chatAnchorKey(messageId) {
  return CHAT_NODE_KIND.length + ":" + CHAT_NODE_KIND + String(messageId);
}

/**
 * 折叠空白并按字符数截断（emoji 等代理对不切半）。
 * @param {unknown} text - 原文。
 * @param {number} limit - 保留的字符数。
 * @returns {string} 摘要。
 */
function snippet(text, limit) {
  const normalized = String(text || "").trim().split(/\s+/).join(" ");
  const chars = Array.from(normalized);
  return chars.length > limit ? chars.slice(0, limit).join("") + "…" : normalized;
}

/**
 * 取 ContentBlock[] 里的纯文本（忽略图片、工具等非 text 块）。
 * @param {unknown} content - 消息 content。
 * @returns {string} 拼接后的文本。
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * 把一条事件折进轮次列表。
 * 只认 append 事件：replace 事件（压缩检查点等）在 web 端不成节点，收进来会
 * 得到一条永远跳不过去的刻度。
 * @param {{ key: string, prompt: string, response: string, seq: number }[]} turns - 累积的轮次。
 * @param {unknown} event - 一条会话事件。
 */
function foldEvent(turns, event) {
  if (!event || event.surfaceOp !== "append") return;
  if (event.type === "user/message") {
    const data = event.data;
    if (!data || !data.source || data.source.kind !== "user") return;
    turns.push({
      key: chatAnchorKey(data.id),
      prompt: snippet(textOfContent(data.content), PROMPT_LIMIT) || "(空消息)",
      response: "",
      seq: event.seq,
    });
  } else if (event.type === "assistant/message" && turns.length > 0) {
    const message = event.data && event.data.message;
    const text = textOfContent(message && message.content);
    if (text.trim()) turns[turns.length - 1].response = snippet(text, RESPONSE_LIMIT);
  }
}

/**
 * 从事件数组折出轮次（重放回退路径用）。
 * @param {unknown} events - 会话事件数组。
 * @returns {{ key: string, prompt: string, response: string, seq: number }[]} 轮次列表。
 */
function buildTurns(events) {
  const turns = [];
  for (const event of Array.isArray(events) ? events : []) foldEvent(turns, event);
  return turns;
}

/**
 * 从原始日志文本折出轮次（快路径）。
 * 日志里绝大多数行是打包的 chunk 行，先按子串筛掉再 JSON.parse——省掉的解析
 * 量是数量级的（实测 8000 行里只有几十行需要真正解析）。
 * @param {unknown} content - readRaw 给的 JSONL 全文。
 * @returns {{ key: string, prompt: string, response: string, seq: number }[]} 轮次列表。
 */
function buildTurnsFromLog(content) {
  const turns = [];
  for (const line of String(content || "").split("\n")) {
    if (line.indexOf('"user/message"') < 0 && line.indexOf('"assistant/message"') < 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 撕裂的尾行：忽略，下次日志增长时会重折
    }
    foldEvent(turns, event);
  }
  return turns;
}

/**
 * JSON 应答。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} body - 应答体。
 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * 主机名是否是回环地址。
 * @param {string} hostname - 请求 Host 头里的主机名部分。
 * @returns {boolean} 是回环则 true。
 */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * 同源 loopback 守卫：会话正文不该被跨站页面读走。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {boolean} 可信则 true。
 */
function isTrusted(req) {
  const host = req.headers.host;
  if (!host) return false;
  if (!isLoopbackHostname(host.split(":")[0])) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 插件入口：挂 /dsh-convmap/turns 路由。
 * @param {any} ctx - cordis 上下文（已注入 webServer / sessionPersistence）。
 */
function apply(ctx) {
  /** sessionId → { revision, turns }；revision 变了才重折。 */
  const cache = new Map();

  /**
   * 读一个会话的轮次，尽量走缓存与原始日志。
   * @param {string} sessionId - 目标会话。
   * @returns {Promise<{ turns: unknown[], source: string }>} 轮次与数据来源。
   */
  async function readTurns(sessionId) {
    const persistence = ctx.sessionPersistence;
    let revision;
    try {
      revision = JSON.stringify(await persistence.readStoredRevision(sessionId));
    } catch {
      revision = undefined; // 拿不到 revision 就不缓存，老老实实重折
    }
    const cached = cache.get(sessionId);
    if (cached !== undefined && revision !== undefined && cached.revision === revision) {
      return { turns: cached.turns, source: "cache" };
    }

    const raw = await persistence.readRaw(sessionId);
    if (raw !== undefined) {
      const turns = buildTurnsFromLog(raw.content);
      if (revision !== undefined) {
        cache.set(sessionId, { revision, turns });
        if (cache.size > MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value);
      }
      return { turns, source: "log" };
    }

    // 后端不提供原始产物（如 sqlite 持久化）：退回重放读，慢但正确。
    const sessionQuery = ctx.get("sessionQuery");
    if (sessionQuery === undefined) throw new Error("no raw session artifact and no sessionQuery");
    const snapshot = await sessionQuery.readSession(sessionId);
    return { turns: buildTurns(snapshot && snapshot.events), source: "replay" };
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/dsh-convmap/turns",
        handler: async (req, res) => {
          if (!isTrusted(req)) {
            writeJson(res, 403, { ok: false, error: "forbidden" });
            return;
          }
          try {
            const url = new URL(req.url ?? "/", "http://dsh.internal");
            const sessionId = url.searchParams.get("sessionId");
            if (!sessionId) {
              writeJson(res, 400, { ok: false, error: "missing sessionId" });
              return;
            }
            const started = Date.now();
            const { turns, source } = await readTurns(sessionId);
            writeJson(res, 200, {
              ok: true,
              sessionId,
              count: turns.length,
              source,
              ms: Date.now() - started,
              turns,
            });
          } catch (error) {
            writeJson(res, 500, {
              ok: false,
              error: error && error.message ? error.message : String(error),
            });
          }
        },
      }),
    "dsh-convmap: /dsh-convmap/turns route",
  );
}

export { apply, inject, buildTurns, buildTurnsFromLog, chatAnchorKey, snippet, textOfContent };
