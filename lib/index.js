// dsh-convmap — host face（对话地图全量轮次服务）
//
// 职责（全部进程内、可逆，纯消费 host 服务，不发布服务）：
// 1. 经 `sessionQuery.readSession(sessionId)` 读当前会话的完整原始日志
//    （含客户端尚未渲染的历史轮次，不受分页窗口限制）。
// 2. 从 events 提取所有 `user/message`（source.kind==='user'、有文本）轮次，
//    key 按引擎规则重建 `13:input-message<messageId>`，与客户端 DOM 锚点
//    `data-chat-anchor-key` 一一对应；response 取该轮之后最后一条
//    `assistant/message` 的文本。
// 3. 注册 /dsh-convmap/turns HTTP route，供 client 首帧与会话切换时拉全量。
//
// 说明：正式 bundle 的 host 半边是 cordis 加载的真实 ESM 模块，
// 不走动态插件的 harness.handle；读全量日志用 ctx.sessionQuery（cordis 服务）。

const inject = ["webServer", "sessionQuery"];

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// 同源/本机请求防护：拒绝跨站读会话轮次，只放行 loopback 同源请求。
function isTrusted(req) {
  const host = req.headers.host;
  if (!host) return false;
  const hostname = host.split(":")[0];
  if (!isLoopbackHostname(hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// 从消息 data 取纯文本（content 是可读 ContentBlock[]，只拼 text 块）。
function textOf(data) {
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  let out = "";
  for (const b of blocks) {
    if (b && b.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out.trim();
}

// 从全量 events 提取轮次。不过滤 surfaceOp：折叠进摘要的远古 append 轮次
// 也要进刻度（它们没有可视行可跳，但预览与数量仍完整）。
function buildTurns(events) {
  const turns = [];
  let current = null;
  for (const ev of events || []) {
    const t = ev && ev.type;
    if (t === "user/message") {
      const data = ev.data || {};
      const src = data.source && data.source.kind;
      const id = data.id;
      if (data.role === "user" && src === "user" && id) {
        const prompt = textOf(data);
        if (prompt) {
          if (current) turns.push(current);
          current = { key: "13:input-message" + String(id), prompt, response: "" };
        }
      }
      continue;
    }
    if (current && t === "assistant/message") {
      const text = textOf(ev.data);
      if (text) current.response = text; // 该轮最后一次非空回复
    }
  }
  if (current) turns.push(current);
  return turns;
}

function apply(ctx) {
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
            const read = await ctx.sessionQuery.readSession(sessionId);
            const turns = buildTurns(read && read.events);
            writeJson(res, 200, { ok: true, sessionId, count: turns.length, turns });
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

export { apply, inject, buildTurns, textOf };
