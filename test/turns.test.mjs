import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurns, textOf } from "../lib/index.js";

test("buildTurns 提取用户轮次，key 按引擎规则重建", () => {
  const events = [
    { type: "user/message", seq: 1, data: { id: "m1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: " 第一轮提问 " }] } },
    { type: "assistant/message", seq: 2, data: { id: "a1", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "第一轮回复" }] } },
    { type: "assistant/message", seq: 3, data: { id: "a2", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "第一轮补充回复" }] } },
    { type: "user/message", seq: 4, data: { id: "m2", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "第二轮提问" }] } },
    { type: "assistant/message", seq: 5, data: { id: "a3", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "第二轮回复" }] } },
  ];
  assert.deepEqual(buildTurns(events), [
    { key: "13:input-messagem1", prompt: "第一轮提问", response: "第一轮补充回复" },
    { key: "13:input-messagem2", prompt: "第二轮提问", response: "第二轮回复" },
  ]);
});

test("buildTurns 忽略非 user source / 无 id / 无文本的比例外节点", () => {
  const events = [
    { type: "user/message", seq: 1, data: { id: "m1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "提问" }] } },
    // tool / 系统 / 无 id 的用户事件不进刻度
    { type: "user/message", seq: 2, data: { id: "m2", role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "插件注入" }] } },
    { type: "user/message", seq: 3, data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "无 id" }] } },
    { type: "user/message", seq: 4, data: { id: "m4", role: "user", source: { kind: "user" }, content: [{ type: "image" }] } },
    // 折叠进摘要、但文本为空的远古轮次（无 text 块）不进刻度
    { type: "user/message", seq: 5, data: { id: "m5", role: "user", source: { kind: "user" }, content: [{ type: "image" }] } },
    // 有文本的折叠轮次（客户端不渲染，但 host 全量仍覆盖）仍进刻度
    { type: "user/message", seq: 6, data: { id: "m6", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "折叠轮次" }] } },
  ];
  const turns = buildTurns(events);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t) => t.key), ["13:input-messagem1", "13:input-messagem6"]);
  assert.equal(turns[1].response, "");
});

test("textOf 只拼 text 块", () => {
  assert.equal(
    textOf({ content: [{ type: "reasoning", text: "思考" }, { type: "text", text: "A" }, { type: "text", text: "B" }] }),
    "AB",
  );
  assert.equal(textOf({ content: [] }), "");
  assert.equal(textOf(null), "");
});
