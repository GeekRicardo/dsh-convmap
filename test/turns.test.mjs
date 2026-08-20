// buildTurns 的契约：只认 append 的用户消息，key 与客户端锚点同规则，
// 回复取该轮最后一条非空 assistant/message。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTurns, chatAnchorKey, snippet, textOfContent } from '../lib/index.js'

const userMessage = (seq, id, text, extra = {}) => ({
  seq,
  type: 'user/message',
  surfaceOp: 'append',
  data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }], ...extra },
})

const assistantMessage = (seq, text) => ({
  seq,
  type: 'assistant/message',
  surfaceOp: 'append',
  data: { message: { content: [{ type: 'text', text }] } },
})

test('chatAnchorKey 复刻引擎的 conversationContextKey 规则', () => {
  assert.equal(chatAnchorKey('m1'), '13:input-messagem1')
  assert.equal(chatAnchorKey(7), '13:input-message7')
})

test('每条用户消息一条刻度，回复取该轮最后一条非空回复', () => {
  const turns = buildTurns([
    userMessage(1, 'a', '第一问'),
    assistantMessage(2, '第一答上半'),
    assistantMessage(3, '第一答下半'),
    userMessage(4, 'b', '第二问'),
    assistantMessage(5, '第二答'),
  ])
  assert.deepEqual(turns.map(t => [t.key, t.prompt, t.response, t.seq]), [
    ['13:input-messagea', '第一问', '第一答下半', 1],
    ['13:input-messageb', '第二问', '第二答', 4],
  ])
})

test('非 append 事件与非用户来源的消息都不成刻度', () => {
  const turns = buildTurns([
    { ...userMessage(1, 'compact', '压缩检查点'), surfaceOp: { op: 'replace', start: 0, end: 1 } },
    { ...userMessage(2, 'ctx', '注入的上下文'), data: { id: 'ctx', source: { kind: 'plugin', plugin: 'x' }, content: [] } },
    userMessage(3, 'real', '真提问'),
  ])
  assert.deepEqual(turns.map(t => t.key), ['13:input-messagereal'])
})

test('没有文本块的用户消息仍占一条刻度', () => {
  const [turn] = buildTurns([{
    seq: 1,
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'img', source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] },
  }])
  assert.equal(turn.prompt, '(空消息)')
})

test('回复先于任何用户消息时被丢弃，不会写到不存在的轮次上', () => {
  assert.deepEqual(buildTurns([assistantMessage(1, '孤儿回复')]), [])
})

test('摘要折叠空白并按字符截断', () => {
  assert.equal(snippet('  多行\n  文本  ', 100), '多行 文本')
  assert.equal(snippet('abcdef', 3), 'abc…')
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOfContent('不是数组'), '')
})

test('损坏或缺失的事件流不抛错', () => {
  assert.deepEqual(buildTurns(undefined), [])
  assert.deepEqual(buildTurns([null, {}, { type: 'user/message', surfaceOp: 'append' }]), [])
})

// 快路径：直接折原始日志文本，结果必须与折事件数组一致。
test('buildTurnsFromLog 与 buildTurns 折出同样的轮次', async () => {
  const { buildTurnsFromLog } = await import('../lib/index.js')
  const events = [
    userMessage(1, 'a', '第一问'),
    { seq: 2, type: 'text-chunks', surfaceOp: 'append', data: { runs: ['忽略我'] } },
    assistantMessage(3, '第一答'),
    userMessage(4, 'b', '第二问'),
  ]
  const log = events.map(e => JSON.stringify(e)).join('\n') + '\n'
  assert.deepEqual(buildTurnsFromLog(log), buildTurns(events))
})

test('buildTurnsFromLog 忽略撕裂的尾行', async () => {
  const { buildTurnsFromLog } = await import('../lib/index.js')
  const log = JSON.stringify(userMessage(1, 'a', '完整')) + '\n' + '{"type":"user/message","sur'
  assert.deepEqual(buildTurnsFromLog(log).map(t => t.prompt), ['完整'])
})

// 代理自跑的会话：整轮没有人发言时，用该轮第一条注入消息当刻度。
const turnStart = (seq, turn) => ({ seq, type: 'turn/start', data: { turn } })
const injected = (seq, id, text, plugin = 'cordis-host-runner') => ({
  seq,
  type: 'user/message',
  surfaceOp: 'append',
  data: { id, source: { kind: 'plugin', plugin }, content: [{ type: 'text', text }] },
})

test('整轮没有人发言时，注入消息顶上一条刻度（每轮只留第一条）', () => {
  const turns = buildTurns([
    turnStart(1, 1),
    injected(2, 'n1', '审批策略从 never 变成 ask'),
    injected(3, 'n2', 'Cordis run 完成'),
    assistantMessage(4, '好的'),
    turnStart(5, 2),
    injected(6, 'n3', '又一条通知'),
  ])
  assert.deepEqual(turns.map(t => [t.key, t.prompt, t.response]), [
    ['13:input-messagen1', '审批策略从 never 变成 ask', '好的'],
    ['13:input-messagen3', '又一条通知', ''],
  ])
})

test('轮里有人发言时，同轮的注入消息不占刻度', () => {
  const turns = buildTurns([
    turnStart(1, 1),
    injected(2, 'sys', '<system-reminder>技能目录…'),
    userMessage(3, 'me', '真提问'),
    assistantMessage(4, '答'),
  ])
  assert.deepEqual(turns.map(t => t.prompt), ['真提问'])
})

test('注入刻度也从原始日志路径折得出来（turn/start 行不能被筛掉）', async () => {
  const { buildTurnsFromLog } = await import('../lib/index.js')
  const events = [turnStart(1, 1), injected(2, 'n1', '通知'), assistantMessage(3, '答')]
  assert.deepEqual(buildTurnsFromLog(events.map(e => JSON.stringify(e)).join('\n')), buildTurns(events))
})
