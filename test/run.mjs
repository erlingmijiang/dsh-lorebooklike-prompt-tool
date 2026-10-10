/**
 * dsh-lorebooklike-prompt-tool 引擎自测。零依赖，直接 `node test/run.mjs`。
 *
 * 只测纯引擎——它不碰 DSH，所以这些断言在插件装进 harness 之前就能全部跑通。
 */
import {
  stableUnit,
  passesProbability,
  matchText,
  evaluateKeys,
  applyReplaces,
  normalizeEntry,
  normalizeRules,
  buildScanText,
  selectEntries,
  cacheRoutedEntries,
  LAYER_ORDERS,
} from '../lib/engine.js'

let passed = 0
let failed = 0

function ok(name, cond, extra) {
  if (cond) {
    passed++
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`)
}

function entry(over = {}) {
  return normalizeEntry({ content: 'x', ...over }, 0)
}

// ---------------------------------------------------------------- 稳定随机
console.log('\n【稳定随机】')
eq('同键同值', stableUnit('a', 1), stableUnit('a', 1))
ok('不同键不同值', stableUnit('a') !== stableUnit('b'))
ok('落在 [0,1)', [...Array(200).keys()].every((i) => {
  const v = stableUnit('k', i)
  return v >= 0 && v < 1
}))
ok('分隔符不会被拼接歧义吃掉', stableUnit('a', 'b') !== stableUnit('ab', ''))

// ---------------------------------------------------------------- 概率门
console.log('【概率激活】')
eq('100 恒定通过', passesProbability(entry({ probability: 100 }), {}), true)
eq('0 恒定拒绝', passesProbability(entry({ probability: 0 }), {}), false)

const alwaysOn = entry({ id: 'p1', probability: 100 })
eq('概率门对 100 不消耗哈希', passesProbability(alwaysOn, { turn: 1 }), true)

const coin = entry({ id: 'coin', probability: 50, channel: 'message' })
const rolls1 = [...Array(200).keys()].map((t) => passesProbability(coin, { sessionKey: 's1', turn: t }))
const rolls2 = [...Array(200).keys()].map((t) => passesProbability(coin, { sessionKey: 's1', turn: t }))
ok('同一轮次结果可复现', rolls1.every((v, i) => v === rolls2[i]))
const hitRate = rolls1.filter(Boolean).length / rolls1.length
ok('50% 门命中率大致合理', hitRate > 0.3 && hitRate < 0.7, `实得 ${(hitRate * 100).toFixed(1)}%`)

const sysA = entry({ id: 'sys', probability: 50, channel: 'system' })
ok(
  'system 通道忽略轮次（系统提示不逐轮抖动）',
  passesProbability(sysA, { sessionKey: 's', turn: 1 }) === passesProbability(sysA, { sessionKey: 's', turn: 99 }),
)
ok(
  'system 通道区分会话',
  [...Array(64).keys()].some(
    (i) => passesProbability(sysA, { sessionKey: `s${i}`, turn: 1 }) !== passesProbability(sysA, { sessionKey: `s${i + 1}`, turn: 1 }),
  ),
)

// ---------------------------------------------------------------- 关键词
console.log('【关键词匹配】')
const plain = entry()
eq('子串命中', matchText('请帮我重构这段代码', '重构', plain), true)
eq('子串未命中', matchText('你好', '重构', plain), false)
const cs = entry({ caseSensitive: true })
eq('大小写敏感时不匹配', matchText('Hello', 'hello', cs), false)
eq('大小写敏感时匹配', matchText('Hello', 'Hello', cs), true)
eq('默认忽略大小写', matchText('Hello', 'hello', plain), true)

const ww = entry({ matchWholeWords: true })
eq('全词匹配命中', matchText('use foo here', 'foo', ww), true)
eq('全词匹配拒绝词内命中', matchText('foobar', 'foo', ww), false)
eq('全词匹配接受标点边界', matchText('foo, bar', 'foo', ww), true)

eq('正则字面量命中', matchText('好感度 42', '/好感度\\s*\\d+/', plain), true)
eq('正则字面量未命中', matchText('好感度 未知', '/好感度\\s*\\d+/', plain), false)
eq('keyIsRegex 生效', matchText('v1.2.3', '^v\\d+\\.\\d+', entry({ keyIsRegex: true })), true)
eq('坏正则不抛错且不匹配', matchText('anything', '/([unclosed/', plain), false)

// ---------------------------------------------------------------- 激活判定
console.log('【蓝绿灯与副键逻辑】')
eq('蓝灯无条件激活', evaluateKeys(entry({ mode: 'constant', keys: ['永不出现'] }), '文本'), true)
eq('绿灯需主键命中', evaluateKeys(entry({ mode: 'selective', keys: ['重构'] }), '请重构一下'), true)
eq('绿灯主键未命中则拒绝', evaluateKeys(entry({ mode: 'selective', keys: ['重构'] }), '你好'), false)
eq('绿灯没给主键则永不触发', evaluateKeys(entry({ mode: 'selective', keys: [] }), '任意文本'), false)

const withSec = (logic, sec) => entry({ mode: 'selective', keys: ['主'], keySecondary: sec, keyLogic: logic })
eq('any 副键任一命中', evaluateKeys(withSec('any', ['a', 'b']), '主 b'), true)
eq('any 副键全未命中', evaluateKeys(withSec('any', ['a', 'b']), '主'), false)
eq('all 副键全命中', evaluateKeys(withSec('all', ['a', 'b']), '主 a b'), true)
eq('all 缺一个即拒绝', evaluateKeys(withSec('all', ['a', 'b']), '主 a'), false)
eq('notAny 副键全未命中才激活', evaluateKeys(withSec('notAny', ['a', 'b']), '主'), true)
eq('notAny 命中任一即拒绝', evaluateKeys(withSec('notAny', ['a', 'b']), '主 a'), false)
eq('notAll 非全中即激活', evaluateKeys(withSec('notAll', ['a', 'b']), '主 a'), true)
eq('notAll 全中则拒绝', evaluateKeys(withSec('notAll', ['a', 'b']), '主 a b'), false)
eq('副键为空时主键命中即通过', evaluateKeys(entry({ mode: 'selective', keys: ['主'] }), '主'), true)

// ---------------------------------------------------------------- 正则替换
console.log('【正则替换】')
const reps = [
  { target: 'injected', pattern: '\\bfoo\\b', flags: 'gi', replacement: 'bar' },
  { target: 'system', pattern: 'SECRET', flags: 'g', replacement: '[已脱敏]' },
]
eq('injected 面替换', applyReplaces('foo and FOO', reps, 'injected'), 'bar and bar')
eq('target 隔离：system 规则不动 injected', applyReplaces('SECRET foo', reps, 'injected'), 'SECRET bar')
eq('system 面替换', applyReplaces('a SECRET b', reps, 'system'), 'a [已脱敏] b')
eq('无匹配则原样返回', applyReplaces('nothing', reps, 'injected'), 'nothing')
eq('坏正则被跳过而非抛错', applyReplaces('abc', [{ target: 'injected', pattern: '([bad', replacement: 'x' }], 'injected'), 'abc')
eq('entryIds 过滤生效', applyReplaces('foo', [{ target: 'injected', pattern: 'foo', replacement: 'z', entryIds: ['other'] }], 'injected', 'mine'), 'foo')
eq('entryIds 匹配时生效', applyReplaces('foo', [{ target: 'injected', pattern: 'foo', replacement: 'z', entryIds: ['mine'] }], 'injected', 'mine'), 'z')
eq('替换捕获组可用', applyReplaces('key=abc', [{ target: 'injected', pattern: 'key=(\\w+)', replacement: '$1!' }], 'injected'), 'abc!')

// ---------------------------------------------------------------- 归一化与分层
console.log('【归一化与分层】')
eq('缺 content 与 replaces 的条目被丢弃', normalizeEntry({ id: 'x' }, 0), null)
eq('只给 replaces 的条目保留', normalizeEntry({ id: 'x', replaces: [{ pattern: 'a' }] }, 0) !== null, true)
eq('默认蓝灯', entry().mode, 'constant')
eq('默认概率 100', entry().probability, 100)
eq('非法 keyLogic 回落 any', entry({ keyLogic: 'bogus' }).keyLogic, 'any')
eq('概率越界被夹紧', entry({ probability: 999 }).probability, 100)
eq('概率负数被夹紧', entry({ probability: -5 }).probability, 0)
eq('未知名层回落默认锚点', entry({ layer: 'nope' }).sortKey, 700)
eq('tail 层排序键', entry({ layer: 'tail' }).sortKey, LAYER_ORDERS.tail)
eq('层内 order 叠加', entry({ layer: 'tool', order: 5 }).sortKey, LAYER_ORDERS.tool + 5)
eq('兜底 id', normalizeEntry({ content: 'x' }, 7).id, 'entry-7')

const norm = normalizeRules({ entries: [{ content: 'a' }, { id: 'bad' }, { content: 'c' }] })
eq('归一化跳过坏条目', norm.entries.length, 2)
eq('归一化记录错误', norm.errors.length, 1)

// ---------------------------------------------------------------- 扫描文本与筛选
console.log('【扫描深度与筛选】')
eq('scanDepth=1 只取最新一条', buildScanText(['新', '旧'], 1), '新')
eq('scanDepth=2 取两条', buildScanText(['新', '旧', '更旧'], 2), '新\n旧')
eq('越界 depth 被夹紧', buildScanText(['新', '旧'], 99), '新\n旧')

const entries = normalizeRules({
  entries: [
    { id: 'late', content: 'L', layer: 'tail' },
    { id: 'early', content: 'E', layer: 'before-persona' },
    { id: 'mid', content: 'M', layer: 'tool' },
    { id: 'msg', content: 'G', channel: 'message', mode: 'selective', keys: ['重构'] },
    { id: 'off', content: 'O', enabled: false },
  ],
}).entries

const sysSel = selectEntries(entries, { scanText: '', sessionKey: 's', turn: 1, channel: 'system' })
eq('system 通道只出 system 条目', sysSel.length, 3)
eq('按层锚点升序', sysSel.map((e) => e.id).join(','), 'early,mid,late')

const msgSel = selectEntries(entries, { scanText: '请帮我重构', sessionKey: 's', turn: 1, channel: 'message' })
eq('message 通道只出命中的绿灯条目', msgSel.map((e) => e.id).join(','), 'msg')
eq('message 通道未命中则为空', selectEntries(entries, { scanText: '你好', sessionKey: 's', turn: 1, channel: 'message' }).length, 0)
eq('停用条目不出现在任何通道', sysSel.some((e) => e.id === 'off'), false)

// ---------------------------------------------------------------- 缓存安全
console.log('【缓存安全：绿灯不进系统提示】')

// 唯一的缓存杀手：system 通道 + 绿灯。它逐轮开关，会重写请求前缀。
const toggler = entry({ id: 't', channel: 'system', mode: 'selective', keys: ['x'] })
eq('绿灯 + system 被改道到 message', toggler.effectiveChannel, 'message')
eq('改道标记为真', toggler.routedForCache, true)
eq('声明的通道被保留（不篡改用户写的值）', toggler.channel, 'system')

// 常驻条目永不变化，待在系统提示里安全
const blue = entry({ id: 'b', channel: 'system', mode: 'constant' })
eq('常驻 + system 不改道', blue.effectiveChannel, 'system')
eq('常驻不改道', blue.routedForCache, false)

// 概率条目在 system 通道按会话抽取，一个会话内恒定 → 也安全
const prob = entry({ id: 'p', channel: 'system', mode: 'constant', probability: 50 })
eq('概率 + system 不改道（会话内稳定）', prob.effectiveChannel, 'system')

// 本来就在 message 通道的不动
eq('message 通道不改道', entry({ id: 'm', channel: 'message', mode: 'selective' }).effectiveChannel, 'message')

// 全局关掉 / 单条豁免
const rulesOff = normalizeRules({
  defaults: { cacheSafe: false },
  entries: [{ id: 't', channel: 'system', mode: 'selective', keys: ['x'], content: 'c' }],
})
eq('defaults.cacheSafe=false 时不改道', rulesOff.entries[0].effectiveChannel, 'system')
eq('cacheSafe=false 被解析出来', rulesOff.defaults.cacheSafe, false)
eq('默认 cacheSafe 为真', normalizeRules({ entries: [{ content: 'c' }] }).defaults.cacheSafe, true)

const exempt = entry({ id: 't', channel: 'system', mode: 'selective', keys: ['x'], cacheUnsafe: true })
eq('单条 cacheUnsafe 豁免改道', exempt.effectiveChannel, 'system')
eq('豁免后 routedForCache 为假', exempt.routedForCache, false)

// selectEntries 必须按 effectiveChannel 分流
const mixed = normalizeRules({
  entries: [
    { id: 'sys-blue', channel: 'system', mode: 'constant', content: 'A' },
    { id: 'sys-green', channel: 'system', mode: 'selective', keys: ['命中'], content: 'B' },
    { id: 'msg-blue', channel: 'message', mode: 'constant', content: 'C' },
  ],
}).entries

eq(
  'system 通道只剩常驻那条',
  selectEntries(mixed, { scanText: '命中', channel: 'system', sessionKey: 's', turn: 1 }).map((e) => e.id).join(','),
  'sys-blue',
)
eq(
  '改道后的绿灯出现在 message 通道',
  selectEntries(mixed, { scanText: '命中', channel: 'message', sessionKey: 's', turn: 1 }).map((e) => e.id).join(','),
  'msg-blue,sys-green',
)
eq(
  'message 通道未命中时只剩常驻',
  selectEntries(mixed, { scanText: '无关', channel: 'message', sessionKey: 's', turn: 1 }).map((e) => e.id).join(','),
  'msg-blue',
)

// 概率粒度跟随实际通道：改道后的条目住在消息末尾，就该拿轮次级语义
const routedProb = normalizeRules({
  entries: [{ id: 'rp', channel: 'system', mode: 'selective', keys: ['k'], probability: 50, content: 'c' }],
}).entries[0]
eq('被改道条目按轮次抽取', routedProb.effectiveChannel, 'message')
const rpTurns = [...Array(120).keys()].map((t) => passesProbability(routedProb, { sessionKey: 's', turn: t }))
ok('改道条目在不同轮次结果会变', new Set(rpTurns).size > 1)
ok(
  '改道条目同轮次可复现',
  rpTurns.every((v, i) => v === [...Array(120).keys()].map((t) => passesProbability(routedProb, { sessionKey: 's', turn: t }))[i]),
)

eq('cacheRoutedEntries 只列改道条目', cacheRoutedEntries(mixed).map((e) => e.id).join(','), 'sys-green')

// ---------------------------------------------------------------- 汇总
console.log(`\n${'─'.repeat(46)}`)
console.log(failed === 0 ? `✓ 全部通过：${passed} 项断言` : `✗ ${failed} 项失败 / 共 ${passed + failed} 项`)
process.exit(failed === 0 ? 0 : 1)
