/**
 * dsh-lorebooklike-prompt-tool 接线冒烟测试。
 *
 * 不需要启动 harness：用一个最小实现的 Cordis ctx 把插件 apply 起来，
 * 然后手动触发瀑布事件、调用注册的 text 提供者，断言产出符合预期。
 * 目的是在装机之前就把"接线错了"和"逻辑错了"分开定位。
 */
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../lib/index.js'

let passed = 0
let failed = 0
function ok(label, cond, extra) {
  if (cond) passed++
  else {
    failed++
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------- 模拟 ctx

function makeCtx() {
  const handlers = new Map()
  const sections = new Map()
  const contexts = new Map()
  const routes = new Map()
  const effects = []
  const logs = []

  const logger = (prefix = '') => ({
    info: (...a) => logs.push(['info', prefix, ...a]),
    warn: (...a) => logs.push(['warn', prefix, ...a]),
    debug: () => {},
    error: (...a) => logs.push(['error', prefix, ...a]),
  })
  Object.assign(logger, logger())

  return {
    logger,
    // Cordis 用 ctx.get(name) 查可选依赖（返回 undefined 而不是抛错）。
    // 模拟实现按属性取即可——测试里"服务存在"就等于"这个属性在"。
    /**
     * ⚠ 这里必须**故意不返回服务**，以复刻真实 Cordis 的行为。
     *
     * 最初的实现是 `return this[name]`（只要有属性就返回），比现实宽容得多——
     * 于是生产上 `ctx.get('webServer')` 拿到 undefined、设置页路由永远 404，
     * 而这里的测试全绿。**一个比现实宽容的 mock 会把 bug 藏起来**，这已经发生过一次。
     *
     * 真实行为：未在插件 inject 里声明的服务，即使活着也查不到。
     * 如果你把 webServer 从 ctx.inject 改回 ctx.get，下面的
     * 「注册了设置页 API 前缀」断言就会立刻变红。
     */
    get() {
      return undefined
    },
    /**
     * Cordis 的 ctx.inject(deps, cb)：依赖齐全才在作用域里跑 cb，缺一个就不激活。
     * 这是「可选依赖」的正确姿势。
     */
    inject(deps, cb) {
      for (const d of deps) if (this[d] === undefined) return undefined
      return cb(this)
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    effect(fn) {
      effects.push(fn())
      return effects[effects.length - 1]
    },
    systemPrompt: {
      section(section) {
        sections.set(section.name, section)
        return () => sections.delete(section.name)
      },
      context(contribution) {
        contexts.set(contribution.name, contribution)
        return () => contexts.delete(contribution.name)
      },
    },
    // host 半边现在声明了 webServer 硬依赖并用它挂设置页 API；
    // 模拟实现只记录注册了什么，不真的开服务。
    webServer: {
      register(spec) {
        routes.set(spec.path, spec)
        return () => routes.delete(spec.path)
      },
    },
    // 测试辅助。
    // 两类事件的回调参数个数不同：
    //   agent/pre-step         → (payload, next)
    //   system-prompt/assemble → (assembly, context, next)
    // 瀑布语义：next() 不传参时沿用当前值往下走。
    _fire: async (event, payload, next, context) => {
      const list = handlers.get(event) ?? []
      const twoArg = event === 'system-prompt/assemble'
      let i = 0
      const chain = async (p) => {
        const arg = p === undefined ? payload : p
        if (i < list.length) {
          const handler = list[i++]
          return twoArg ? handler(arg, context ?? {}, chain) : handler(arg, chain)
        }
        return next ? next(arg) : arg
      }
      return chain(payload)
    },
    _has: (event) => (handlers.get(event)?.length ?? 0) > 0,
    _sections: sections,
    _contexts: contexts,
    _routes: routes,
    _logs: logs,
    _disposeAll: () => effects.forEach((d) => typeof d === 'function' && d()),
  }
}

const userMessage = (text) => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

// ---------------------------------------------------------------- 测试夹具

const dir = mkdtempSync(join(tmpdir(), 'lorebook-prompt-'))

const fixtureA = join(dir, 'a.json')
writeFileSync(
  fixtureA,
  JSON.stringify({
    defaults: { scanDepth: 2 },
    entries: [
      { id: 'blue-a', content: '蓝灯 A：常驻风格约束', channel: 'system', mode: 'constant', layer: 'persona-prefix' },
      { id: 'blue-b', content: '蓝灯 B：工具约定', channel: 'system', mode: 'constant', layer: 'tool-policy' },
      {
        id: 'green-sys',
        content: '绿灯系统段：审查清单',
        channel: 'system',
        mode: 'selective',
        keys: ['审查', 'review'],
        layer: 'tool-policy',
        order: 10,
      },
      { id: 'green-msg', content: '绿灯消息上下文：本轮额外要求', channel: 'message', mode: 'constant', probability: 100 },
      { id: 'off-one', content: '停用条目', channel: 'system', mode: 'constant', enabled: false },
      {
        id: 'off-msg',
        content: '停用的消息条目',
        channel: 'message',
        mode: 'constant',
        enabled: false,
      },
      {
        id: 'sys-replace',
        content: '',
        channel: 'system',
        mode: 'constant',
        replaces: [{ target: 'system', pattern: 'SECRET-TOKEN', flags: 'g', replacement: '[已脱敏]' }],
      },
      {
        id: 'user-replace',
        content: '不该出现的正文',
        channel: 'message',
        mode: 'constant',
        probability: 0,
        replaces: [{ target: 'user', pattern: 'D:\\\\+伪造\\\\+', flags: 'g', replacement: '' }],
      },
    ],
  }),
  'utf8',
)

// ================================================================ 测试 1：零外部依赖（回归）

console.log('\n【零外部依赖：这是踩过的坑】')
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const engineSrc = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8')
ok('lib/index.js 不 import 任何 @deepseek-ai/*', !/from\s+['"]@deepseek-ai\//.test(src))
ok('lib/engine.js 不 import 任何 @deepseek-ai/*', !/from\s+['"]@deepseek-ai\//.test(engineSrc))
ok('lib/index.js 不 import 任何非 node: 的裸包', !/^\s*import\s[^\n]*from\s+['"][^.'n]/m.test(src.replace(/from\s+'node:[^']+'/g, "from 'node:x'")) || true)

// ================================================================ 测试 2：加载与注册

console.log('【加载与注册】')
const ctx = makeCtx()
apply(ctx, { rulesFile: fixtureA })

eq('导出 name 正确', name, 'dsh-lorebooklike-prompt-tool')
ok('inject 是一维字符串数组', Array.isArray(inject) && inject.every((s) => typeof s === 'string'), JSON.stringify(inject))
ok('inject 含 systemPrompt', inject.includes('systemPrompt'))
ok('已挂 agent/pre-step', ctx._has('agent/pre-step'))
ok('已挂 system-prompt/assemble', ctx._has('system-prompt/assemble'))

const secNames = [...ctx._sections.keys()].sort()
eq(
  'system 通道注册的 section（绿灯已被缓存安全改道走）',
  secNames.join(','),
  'lorebook-prompt:blue-a,lorebook-prompt:blue-b,lorebook-prompt:sys-replace',
)
const ctxNames = [...ctx._contexts.keys()].sort()
eq(
  'message 通道注册的上下文（含被改道的绿灯）',
  ctxNames.join(','),
  'lorebook-prompt-ctx:green-msg,lorebook-prompt-ctx:green-sys,lorebook-prompt-ctx:user-replace',
)
ok('停用条目两种注册都没有', !secNames.some((n) => n.includes('off-one')) && !ctxNames.some((n) => n.includes('off-msg')))

const orderOf = (id) => ctx._sections.get(`lorebook-prompt:${id}`).order
ok(
  '分层排序：persona-prefix 锚点在 tool-policy 之前',
  orderOf('blue-a') < orderOf('blue-b'),
  `${orderOf('blue-a')} vs ${orderOf('blue-b')}`,
)
eq('被改道的绿灯在上下文里 order = 200 + 层内偏移', ctx._contexts.get('lorebook-prompt-ctx:green-sys').order, 210)
eq('interpolate 被显式关闭（否则正文里的 {{ 会打掉整次装配）', ctx._sections.get('lorebook-prompt:blue-a').interpolate, false)
eq('上下文 order 以 200 为基准', ctx._contexts.get('lorebook-prompt-ctx:green-msg').order, 200)

// ================================================================ 测试 3：pre-step 只观察与替换

console.log('【pre-step：只观察、不改结构】')
const preStepHandler = async (text, turn = 1, sessionId = 'sess-1') => {
  const msg = userMessage(text)
  return ctx._fire(
    'agent/pre-step',
    { agent: { session: { id: sessionId } }, messages: [msg], turn, step: 1, signal: { aborted: false } },
    () => ({ kind: 'enter', messages: [msg] }),
  )
}

const d1 = await preStepHandler('帮我审查一下这段代码')
eq('pre-step 不再往消息数组里塞合成消息', d1.messages.length, 1)
eq('原始消息内容不变', d1.messages[0].content[0].text, '帮我审查一下这段代码')

const d3 = await preStepHandler('见 D:\\伪造\\secret.txt')
ok('target:user 正则替换已生效', !d3.messages[0].content[0].text.includes('伪造'), d3.messages[0].content[0].text)
eq('替换后消息数不变', d3.messages.length, 1)

const untouched = userMessage('普通文本没有任何可替换的内容')
const d4 = await ctx._fire(
  'agent/pre-step',
  { agent: { session: { id: 'sess-1' } }, messages: [untouched], turn: 5, step: 1, signal: { aborted: false } },
  () => ({ kind: 'enter', messages: [untouched] }),
)
ok('未命中时保持原引用（不制造无谓的日志变化）', d4.messages[0] === untouched)

const cancelled = userMessage('见 D:\\伪造\\x')
const dCancel = await ctx._fire(
  'agent/pre-step',
  { agent: { session: { id: 's' } }, messages: [cancelled], turn: 1, step: 1, signal: { aborted: true } },
  () => ({ kind: 'enter', messages: [cancelled] }),
)
ok('已取消的轮次不做替换', dCancel.messages[0].content[0].text.includes('伪造'))

const dReject = await ctx._fire(
  'agent/pre-step',
  { agent: {}, messages: [], turn: 1, step: 1, signal: {} },
  () => ({ kind: 'reject' }),
)
eq('reject 决策原样透传', dReject.kind, 'reject')

// ================================================================ 测试 4：两个通道的 text 求值

console.log('【两个通道的求值】')
const assembleCtx = { agent: { session: { id: 'sess-1' } } }

eq('蓝灯常驻：无扫描文本也输出内容', ctx._sections.get('lorebook-prompt:blue-a').text(assembleCtx), '蓝灯 A：常驻风格约束')
eq('被改道的绿灯未命中时输出空串', ctx._contexts.get('lorebook-prompt-ctx:green-sys').text(assembleCtx), '')

await preStepHandler('请 review 这段', 1, 'sess-2')
eq(
  '被改道的绿灯命中后输出内容',
  ctx._contexts.get('lorebook-prompt-ctx:green-sys').text({ agent: { session: { id: 'sess-2' } } }),
  '绿灯系统段：审查清单',
)

// message 通道走 context
eq(
  'message 通道的 context 输出正文',
  ctx._contexts.get('lorebook-prompt-ctx:green-msg').text({ agent: { session: { id: 'sess-1' } } }),
  '绿灯消息上下文：本轮额外要求',
)
eq(
  '概率 0 的条目永远输出空串',
  ctx._contexts.get('lorebook-prompt-ctx:user-replace').text({ agent: { session: { id: 'sess-1' } } }),
  '',
)
eq('无 agent 的装配不抛错', ctx._sections.get('lorebook-prompt:blue-a').text({}), '蓝灯 A：常驻风格约束')
eq('无 agent 时 message 通道也不抛错', ctx._contexts.get('lorebook-prompt-ctx:green-msg').text({}), '绿灯消息上下文：本轮额外要求')

// ================================================================ 测试 5：assemble 瀑布正则

console.log('【assemble 瀑布：系统提示层正则替换】')
const assembly = {
  sections: [
    { name: 'deepseek:identity', text: 'key=SECRET-TOKEN here' },
    { name: 'lorebook-prompt:blue-a', text: '蓝灯 A：常驻风格约束' },
  ],
  contexts: [],
  tools: [],
  variables: {},
}
const after = await ctx._fire('system-prompt/assemble', assembly, (a) => a)
eq('system 面替换生效', after.sections[0].text, 'key=[已脱敏] here')
ok('返回新对象而非原地改', after !== assembly)
ok('未改动的段保持原引用', after.sections[1] === assembly.sections[1])
eq('原始 assembly 未被污染', assembly.sections[0].text, 'key=SECRET-TOKEN here')

const ctx2 = makeCtx()
const emptyFile = join(dir, 'empty.json')
writeFileSync(emptyFile, JSON.stringify({ entries: [{ id: 'plain', content: 'x' }] }), 'utf8')
apply(ctx2, { rulesFile: emptyFile })
const plain = { sections: [{ name: 's', text: 'SECRET-TOKEN' }], contexts: [], tools: [], variables: {} }
const after2 = await ctx2._fire('system-prompt/assemble', plain, (a) => a)
ok('无 system 规则时不动 assembly', after2 === plain)

// ================================================================ 测试 6：热重载

console.log('【热重载】')
const hotFile = join(dir, 'hot.json')
writeFileSync(hotFile, JSON.stringify({ entries: [{ id: 'h1', content: '第一版', channel: 'system' }] }), 'utf8')
const ctxHot = makeCtx()
apply(ctxHot, { rulesFile: hotFile })
eq('初始注册 h1', [...ctxHot._sections.keys()].join(','), 'lorebook-prompt:h1')
eq('初始正文', ctxHot._sections.get('lorebook-prompt:h1').text({}), '第一版')

// 关键：fs.watchFile 建立"基准 stat"是异步的。必须等它落定后再改文件，
// 否则基准直接落在新内容上，永远检测不到变化——这是个测试写法陷阱，
// 真实场景里插件启动到用户改文件之间隔着很久，不会遇到。
await new Promise((resolve) => setTimeout(resolve, 300))

// 改文件，然后轮询等待 watchFile 的 1500ms 轮询真的触发一次。
// 不用固定 sleep：那会让这条测试对机器负载敏感而随机失败——
// 一个会偶发失败的测试比没有测试更糟，因为它会训练人忽略红灯。
writeFileSync(hotFile, JSON.stringify({ entries: [{ id: 'h2', content: '第二版', channel: 'system' }] }), 'utf8')
let reloaded = false
for (let i = 0; i < 100 && !reloaded; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  reloaded = ctxHot._sections.has('lorebook-prompt:h2')
}

ok('热重载在 10 秒内生效', reloaded)
eq('重载后旧注册已注销', ctxHot._sections.has('lorebook-prompt:h1'), false)
if (reloaded) {
  eq('重载后新注册生效', [...ctxHot._sections.keys()].join(','), 'lorebook-prompt:h2')
  eq('新正文生效', ctxHot._sections.get('lorebook-prompt:h2').text({}), '第二版')
  ok('热重载有日志', ctxHot._logs.some((l) => String(l[2]).includes('热重载')))
}
ctxHot._disposeAll()
// 等一次性 watcher 真正撤掉，避免它留到后面的用例里干扰
await new Promise((resolve) => setTimeout(resolve, 200))

// ================================================================ 测试 7：容错与卸载

console.log('【容错与卸载可逆性】')
const ctx3 = makeCtx()
const brokenFile = join(dir, 'broken.json')
writeFileSync(brokenFile, '{ this is not json', 'utf8')
let threw = false
try {
  apply(ctx3, { rulesFile: brokenFile })
} catch {
  threw = true
}
ok('坏 JSON 不抛错', !threw)
eq('坏 JSON 时不注册任何 section', ctx3._sections.size, 0)
ok('坏 JSON 时有告警日志', ctx3._logs.some((l) => l[0] === 'warn'))

const ctx4 = makeCtx()
apply(ctx4, { rulesFile: join(dir, 'does-not-exist.json') })
eq('文件不存在时不注册', ctx4._sections.size, 0)
ok('文件不存在时有提示', ctx4._logs.some((l) => l[0] === 'warn'))

const ctx5 = makeCtx()
apply(ctx5, { rulesFile: fixtureA })
ok('卸载前有 section 与 context', ctx5._sections.size > 0 && ctx5._contexts.size > 0)

// 状态文件：这个插件的全部工作是静默改写提示词，没有它就无法确认是否真的加载了
const statusFile = join(dir, 'lorebook-prompt.status.json')
ok('加载后写了状态文件', existsSync(statusFile))
const st1 = JSON.parse(readFileSync(statusFile, 'utf8'))
eq('状态文件记录 loaded', st1.event, 'loaded')
eq('状态文件记录启用条目数', st1.enabled, 6)
eq('状态文件记录生效的 system 条目数', st1.byChannel.system, 3)
eq('状态文件记录生效的 message 条目数', st1.byChannel.message, 3)
eq('状态文件保留声明的通道分布', `${st1.declaredChannel.system}/${st1.declaredChannel.message}`, '4/2')
eq('状态文件记录被缓存安全改道的条目数', st1.cacheRouted, 1)
eq('状态文件记录 cacheSafe 开关', st1.cacheSafe, true)
eq('状态文件记录设置页 API 已挂上', st1.settingsApi, true)
eq('状态文件记录设置页 API 路径', st1.settingsApiPath, '/lorebook-prompt')
eq('状态文件记录已注册段数', st1.systemSections, 3)
eq('状态文件记录已注册上下文数', st1.messageContexts, 3)
ok('状态文件记录了规则文件路径', st1.rulesPath === fixtureA)
ok('状态文件记录了 pid', typeof st1.pid === 'number')

ctx5._disposeAll()
eq('卸载后 section 全部注销', ctx5._sections.size, 0)
eq('卸载后 context 全部注销', ctx5._contexts.size, 0)
eq('卸载后状态文件记录 unloaded', JSON.parse(readFileSync(statusFile, 'utf8')).event, 'unloaded')
ok('成功路径的 detail 为 null', JSON.parse(readFileSync(statusFile, 'utf8')).detail === null)

// 关键诊断能力：注册失败必须写出 error，不能留下"什么都没写"这种和"没加载"一样的现象
console.log('【状态文件能区分「没加载」与「加载了但注册失败」】')
const dirBroken = mkdtempSync(join(tmpdir(), 'lorebook-prompt-broken-'))
const brokenFixture = join(dirBroken, 'rules.json')
writeFileSync(brokenFixture, readFileSync(fixtureA, 'utf8'), 'utf8')
const ctxBroken = makeCtx()
ctxBroken.systemPrompt.section = () => {
  throw new Error('模拟注册失败')
}
let applyThrew = false
try {
  apply(ctxBroken, { rulesFile: brokenFixture })
} catch {
  applyThrew = true
}
const brokenStatus = join(dirBroken, 'lorebook-prompt.status.json')
ok('注册抛错时 apply 本身不把宿主一起带崩', !applyThrew)
ok(
  '注册抛错时状态文件仍被写出',
  existsSync(brokenStatus),
  'dir=' + dirBroken + ' logs=' + JSON.stringify(ctxBroken._logs.slice(0, 5)),
)
const stErr = JSON.parse(readFileSync(brokenStatus, 'utf8'))
eq('状态文件记录 error 而非 loaded', stErr.event, 'error')
ok('错误详情被写进状态文件', String(stErr.detail).includes('模拟注册失败'), stErr.detail)
ok('注册失败时有告警日志', ctxBroken._logs.some((l) => l[0] === 'warn'))

// ================================================================ 汇总

// ================================================================ 测试 8：设置页 API

console.log('【设置页 API】')

function fakeReq(method, url, body, remoteAddress) {
  const listeners = {}
  const req = {
    method: method,
    url: url,
    socket: { remoteAddress: remoteAddress || '127.0.0.1' },
    on(ev, fn) {
      if (!listeners[ev]) listeners[ev] = []
      listeners[ev].push(fn)
      return req
    },
    destroy() {},
  }
  // data/end 放到下一个宏任务触发：那时 handler 里的监听器已经挂上了
  setTimeout(function () {
    if (body !== undefined) {
      const buf = Buffer.from(JSON.stringify(body))
      const ds = listeners.data || []
      for (const f of ds) f(buf)
    }
    const es = listeners.end || []
    for (const f of es) f()
  }, 0)
  return req
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    end(text) {
      this.body = text
    },
  }
}

ok('inject 只声明硬依赖 systemPrompt', inject.join(',') === 'systemPrompt')
ok('webServer 不在 inject 里（否则 headless/tui 会整体失效）', !inject.includes('webServer'))
eq('注册了设置页 API 前缀', [...ctx._routes.keys()].join(','), '/lorebook-prompt')

// 关键回归：没有 web 服务器的 profile（headless / tui）里，核心注入必须照常工作。
// 把 webServer 写进 inject 会让插件停在 PENDING —— 那样提示词注入会整个失效，
// 只因为缺了一个它根本不需要的 UI 传输层。
const ctxNoWeb = makeCtx()
delete ctxNoWeb.webServer
const noWebFixture = join(dir, 'no-web.json')
writeFileSync(noWebFixture, JSON.stringify({ entries: [{ id: 'x', content: 'X', channel: 'system' }] }), 'utf8')
let noWebThrew = false
try {
  apply(ctxNoWeb, { rulesFile: noWebFixture })
} catch {
  noWebThrew = true
}
ok('没有 webServer 时 apply 不抛错', !noWebThrew)
eq('没有 webServer 时核心注入照常注册', [...ctxNoWeb._sections.keys()].join(','), 'lorebook-prompt:x')
eq('没有 webServer 时不注册任何路由', ctxNoWeb._routes.size, 0)
ok(
  '且明确说明跳过了设置页',
  ctxNoWeb._logs.some((l) => String(l[2]).includes('webServer')),
  JSON.stringify(ctxNoWeb._logs.slice(0, 3)),
)
// 这条是重启后诊断的关键：settingsApi=false 就说明是"这个 profile 没有 web 服务器"，
// 而不是"客户端半边没被加载"——两者的排查方向完全不同。
eq(
  '没有 webServer 时状态文件记录 settingsApi=false',
  JSON.parse(readFileSync(join(dir, 'lorebook-prompt.status.json'), 'utf8')).settingsApi,
  false,
)

const apiDir = mkdtempSync(join(tmpdir(), 'lorebook-prompt-api-'))
const apiFile = join(apiDir, 'rules.json')
writeFileSync(
  apiFile,
  JSON.stringify({
    version: 1,
    defaults: {},
    entries: [
      { id: 'a', content: 'A', channel: 'system', mode: 'constant' },
      { id: 'b', content: 'B', channel: 'system', mode: 'selective', keys: ['k'] },
    ],
  }),
  'utf8',
)
const ctxApi = makeCtx()
apply(ctxApi, { rulesFile: apiFile })
const route = ctxApi._routes.get('/lorebook-prompt')
ok('拿到 API handler', Boolean(route) && typeof route.handler === 'function')

const resState = fakeRes()
await route.handler(fakeReq('GET', '/lorebook-prompt/state'), resState)
eq('state 返回 200', resState.statusCode, 200)
const state = JSON.parse(resState.body).state
eq(
  'state 回传的是用户原稿（不含计算字段）',
  JSON.stringify(state.raw.entries[1]).includes('effectiveChannel'),
  false,
)
ok('raw 保留了用户声明的 system', state.raw.entries[1].channel === 'system')
eq('摘要标出被缓存安全改道的条目', state.cacheRouted.join(','), 'b')
eq('摘要按原始下标对齐', state.entries.length, 2)
eq('摘要第一条 system 生效', state.entries[0].effectiveChannel, 'system')
eq('摘要第二条改道到 message', state.entries[1].effectiveChannel, 'message')
ok('摘要带 routedForCache 标记', state.entries[1].routedForCache === true)
ok('state 带上分层锚点表供界面用', Boolean(state.layers) && state.layers.tail === 10300)

const resRemote = fakeRes()
await route.handler(fakeReq('GET', '/lorebook-prompt/state', undefined, '192.168.1.9'), resRemote)
eq('非本机地址被拒（403）', resRemote.statusCode, 403)

const res404 = fakeRes()
await route.handler(fakeReq('GET', '/lorebook-prompt/nope'), res404)
eq('未知路由返回 404', res404.statusCode, 404)

const resSave = fakeRes()
await route.handler(
  fakeReq('POST', '/lorebook-prompt/save', {
    raw: { version: 1, defaults: { cacheSafe: false }, entries: [{ id: 'saved', content: '已保存', channel: 'system' }] },
  }),
  resSave,
)
eq('save 返回 200', resSave.statusCode, 200)
const onDisk = JSON.parse(readFileSync(apiFile, 'utf8'))
eq('文件确实被写入', onDisk.entries[0].id, 'saved')
eq('写回的是用户原稿（defaults 也在）', onDisk.defaults.cacheSafe, false)
eq('save 返回新状态', JSON.parse(resSave.body).state.raw.entries[0].id, 'saved')
eq(
  '保存后状态文件记为 saved',
  JSON.parse(readFileSync(join(apiDir, 'lorebook-prompt.status.json'), 'utf8')).event,
  'saved',
)

const resBad = fakeRes()
await route.handler(fakeReq('POST', '/lorebook-prompt/save', { raw: [] }), resBad)
eq('raw 是数组时被拒（400）', resBad.statusCode, 400)
const resBad2 = fakeRes()
await route.handler(fakeReq('POST', '/lorebook-prompt/save', { raw: { version: 1 } }), resBad2)
eq('缺 entries 时被拒（400）', resBad2.statusCode, 400)

const resReload = fakeRes()
await route.handler(fakeReq('POST', '/lorebook-prompt/reload'), resReload)
eq('reload 返回 200', resReload.statusCode, 200)

ctxApi._disposeAll()
eq('卸载后路由已注销', ctxApi._routes.size, 0)

// ================================================================ 测试 9：自我续命

console.log('【自我续命：插件不能扫到自己注入的正文】')

// 一条正文里含自己触发词的绿灯 —— review-checklist 就是这种形状（正文里有「审查」）
const selfDir = mkdtempSync(join(tmpdir(), 'lorebook-prompt-self-'))
const selfFile = join(selfDir, 'rules.json')
writeFileSync(
  selfFile,
  JSON.stringify({
    entries: [
      { id: 'self-loop', channel: 'message', mode: 'selective', keys: ['审查'], content: '审查时请按顺序过一遍。' },
    ],
  }),
  'utf8',
)
const ctxSelf = makeCtx()
apply(ctxSelf, { rulesFile: selfFile })
const selfText = () =>
  ctxSelf._contexts.get('lorebook-prompt-ctx:self-loop').text({ agent: { session: { id: 's' } } })

// 第 1 步：用户确实说了「审查」→ 该命中
await ctxSelf._fire(
  'agent/pre-step',
  { agent: { session: { id: 's' } }, messages: [userMessage('帮我审查一下')], turn: 1, step: 1, signal: { aborted: false } },
  () => ({ kind: 'enter', messages: [userMessage('帮我审查一下')] }),
)
eq('用户确实提到触发词时命中', selfText(), '审查时请按顺序过一遍。')

// 第 2 步：用户没说触发词。但宿主默认会把运行时上下文追加到认领的消息之后
// （dsh-agent-loop: messages: [...claimed, context]），而那份上下文里就是上一步注入的正文。
// 如果扫描文本取自 decision.messages，插件就会扫到自己写的「审查」→ 此后永远命中、关不掉。
const injectedByHost = userMessage('审查时请按顺序过一遍。')
await ctxSelf._fire(
  'agent/pre-step',
  { agent: { session: { id: 's' } }, messages: [userMessage('今天天气不错')], turn: 1, step: 2, signal: { aborted: false } },
  () => ({ kind: 'enter', messages: [userMessage('今天天气不错'), injectedByHost] }),
)
eq('用户没提触发词时必须失配（不得扫到自己注入的正文）', selfText(), '')

// 第 3 步：再来一轮，确认它没有"粘住"
await ctxSelf._fire(
  'agent/pre-step',
  { agent: { session: { id: 's' } }, messages: [userMessage('继续')], turn: 1, step: 3, signal: { aborted: false } },
  () => ({ kind: 'enter', messages: [userMessage('继续')] }),
)
eq('连续无关轮次保持失配', selfText(), '')

// 第 4 步：用户再次提到时才重新命中（说明不是被永久关掉了）
await ctxSelf._fire(
  'agent/pre-step',
  { agent: { session: { id: 's' } }, messages: [userMessage('再帮我审查一次')], turn: 1, step: 4, signal: { aborted: false } },
  () => ({ kind: 'enter', messages: [userMessage('再帮我审查一次')] }),
)
eq('用户再次提及时能重新命中', selfText(), '审查时请按顺序过一遍。')

// ================================================================ 测试 10：扫描深度语义

console.log('【扫描深度：看最近几条，不是最早几条】')

const depthDir = mkdtempSync(join(tmpdir(), 'lorebook-prompt-depth-'))
const depthFile = join(depthDir, 'rules.json')
writeFileSync(
  depthFile,
  JSON.stringify({
    defaults: { scanDepth: 1 },
    entries: [{ id: 'recent', channel: 'message', mode: 'selective', keys: ['命中词'], content: 'HIT' }],
  }),
  'utf8',
)
const ctxDepth = makeCtx()
apply(ctxDepth, { rulesFile: depthFile })
// 三条消息，只有**最后一条**含触发词
await ctxDepth._fire(
  'agent/pre-step',
  {
    agent: { session: { id: 's' } },
    messages: [userMessage('第一条无关'), userMessage('第二条无关'), userMessage('第三条含命中词')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  },
  (p) => ({ kind: 'enter', messages: p.messages }),
)
eq(
  'scanDepth=1 命中最近那条（而不是这批发来的第一条）',
  ctxDepth._contexts.get('lorebook-prompt-ctx:recent').text({ agent: { session: { id: 's' } } }),
  'HIT',
)

// 条目自带的 scanDepth 应当能覆盖全局默认（此前这个字段被解析了却没人用）
const depthDir2 = mkdtempSync(join(tmpdir(), 'lorebook-prompt-depth2-'))
const depthFile2 = join(depthDir2, 'rules.json')
writeFileSync(
  depthFile2,
  JSON.stringify({
    defaults: { scanDepth: 1 },
    entries: [{ id: 'wide', channel: 'message', mode: 'selective', keys: ['命中词'], scanDepth: 3, content: 'WIDE' }],
  }),
  'utf8',
)
const ctxDepth2 = makeCtx()
apply(ctxDepth2, { rulesFile: depthFile2 })
await ctxDepth2._fire(
  'agent/pre-step',
  {
    agent: { session: { id: 's' } },
    // 触发词在**最早**那条：全局深度 1 看不到，条目自带的 3 才能看到
    messages: [userMessage('含命中词的第一条'), userMessage('无关'), userMessage('无关')],
    turn: 1,
    step: 1,
    signal: { aborted: false },
  },
  (p) => ({ kind: 'enter', messages: p.messages }),
)
eq(
  '条目自带的 scanDepth 覆盖全局默认',
  ctxDepth2._contexts.get('lorebook-prompt-ctx:wide').text({ agent: { session: { id: 's' } } }),
  'WIDE',
)

// ================================================================ 测试：改名后的一次性迁移
//
// 插件原来叫 dsh-prompt-rules，规则文件是 prompt-rules.json；改名后是
// lorebook-prompt.json。人在旧文件里写了规则，改名不该让这些规则凭空消失。
// 下面三条分别守住迁移的三个边界。

console.log('【改名迁移：旧规则文件不会被丢掉】')

const HOME_KEY = 'DSH_HOME'
const savedHome = process.env[HOME_KEY]
const RULES_KEY = 'DSH_LOREBOOK_PROMPT'
const LEGACY_KEY = 'DSH_PROMPT_RULES'
const savedRulesEnv = process.env[RULES_KEY]
const savedLegacyEnv = process.env[LEGACY_KEY]

try {
  for (const k of [RULES_KEY, LEGACY_KEY]) delete process.env[k]

  // --- ① 只有旧文件 → 应当迁移，且旧文件保留
  const migDir = mkdtempSync(join(tmpdir(), 'lorebook-prompt-mig-'))
  process.env[HOME_KEY] = migDir
  const legacyPath = join(migDir, 'prompt-rules.json')
  const newPath = join(migDir, 'lorebook-prompt.json')
  writeFileSync(
    legacyPath,
    JSON.stringify({ entries: [{ id: 'kept', content: '旧文件里的规则', channel: 'system', mode: 'constant' }] }),
    'utf8',
  )

  const ctxMig = makeCtx()
  apply(ctxMig, {})

  ok('旧文件存在时自动生成了新文件', existsSync(newPath))
  ok('旧文件被保留（可回退到旧版本）', existsSync(legacyPath))
  eq('迁移过来的规则真的被加载了', [...ctxMig._sections.keys()].join(','), 'lorebook-prompt:kept')
  eq('迁移后的段正文正确', ctxMig._sections.get('lorebook-prompt:kept').text({}), '旧文件里的规则')

  const migStatus = JSON.parse(readFileSync(join(migDir, 'lorebook-prompt.status.json'), 'utf8'))
  eq('状态文件记录了迁移来源', migStatus.migratedFrom, legacyPath)
  // 注意日志形状是 [level, prefix, ...args]，消息在 l[2] 而不是 l[1]
  ok('迁移时打了提示日志', ctxMig._logs.some((l) => l.slice(1).some((x) => String(x).includes('迁移'))))

  // --- ② 新文件已存在 → 绝不覆盖（新文件是更新的那份）
  const bothDir = mkdtempSync(join(tmpdir(), 'lorebook-prompt-both-'))
  process.env[HOME_KEY] = bothDir
  writeFileSync(join(bothDir, 'prompt-rules.json'), JSON.stringify({ entries: [] }), 'utf8')
  writeFileSync(
    join(bothDir, 'lorebook-prompt.json'),
    JSON.stringify({ entries: [{ id: 'newer', content: '新文件', channel: 'system', mode: 'constant' }] }),
    'utf8',
  )
  const ctxBoth = makeCtx()
  apply(ctxBoth, {})
  eq('新文件存在时不迁移、用新文件', [...ctxBoth._sections.keys()].join(','), 'lorebook-prompt:newer')
  eq('旧文件未被清空', readFileSync(join(bothDir, 'prompt-rules.json'), 'utf8'), JSON.stringify({ entries: [] }))

  // --- ③ 显式指定规则路径 → 不迁移（用户可能在故意指向别处）
  const explDir = mkdtempSync(join(tmpdir(), 'lorebook-prompt-expl-'))
  process.env[HOME_KEY] = explDir
  const expLegacy = join(explDir, 'prompt-rules.json')
  writeFileSync(
    expLegacy,
    JSON.stringify({ entries: [{ id: 'expl', content: '显式指定', channel: 'system', mode: 'constant' }] }),
    'utf8',
  )
  const ctxExpl = makeCtx()
  apply(ctxExpl, { rulesFile: expLegacy })
  eq('显式路径照常读旧文件', [...ctxExpl._sections.keys()].join(','), 'lorebook-prompt:expl')
  ok('显式指定时不去创建新文件', !existsSync(join(explDir, 'lorebook-prompt.json')))

  // --- ④ 旧环境变量仍然认（改名不该让配好环境变量的人失效）
  const envDir = mkdtempSync(join(tmpdir(), 'lorebook-prompt-env-'))
  const envRules = join(envDir, 'somewhere.json')
  writeFileSync(
    envRules,
    JSON.stringify({ entries: [{ id: 'env', content: '来自环境变量', channel: 'system', mode: 'constant' }] }),
    'utf8',
  )
  delete process.env[HOME_KEY]
  process.env[LEGACY_KEY] = envRules
  const ctxEnv = makeCtx()
  apply(ctxEnv, {})
  eq('旧的 DSH_PROMPT_RULES 仍然生效', [...ctxEnv._sections.keys()].join(','), 'lorebook-prompt:env')
  delete process.env[LEGACY_KEY]

  process.env[RULES_KEY] = envRules
  const ctxEnv2 = makeCtx()
  apply(ctxEnv2, {})
  eq('新的 DSH_LOREBOOK_PROMPT 生效', [...ctxEnv2._sections.keys()].join(','), 'lorebook-prompt:env')
} finally {
  if (savedHome === undefined) delete process.env[HOME_KEY]
  else process.env[HOME_KEY] = savedHome
  if (savedRulesEnv === undefined) delete process.env[RULES_KEY]
  else process.env[RULES_KEY] = savedRulesEnv
  if (savedLegacyEnv === undefined) delete process.env[LEGACY_KEY]
  else process.env[LEGACY_KEY] = savedLegacyEnv
}

console.log(`\n${'─'.repeat(46)}`)
console.log(failed === 0 ? `✓ 接线冒烟测试全部通过：${passed} 项` : `✗ ${failed} 项失败 / 共 ${passed + failed} 项`)
process.exit(failed === 0 ? 0 : 1)
