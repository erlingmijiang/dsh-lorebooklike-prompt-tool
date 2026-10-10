/**
 * 客户端半边（lib/client.js）测试。
 *
 * 为什么需要自建一个迷你 React：真实的 react 只存在于浏览器 shell 的冻结模块表里，
 * profile 的 node_modules 里没有它，所以没法在 Node 中直接渲染。于是这里实现一个
 * 只够用的 hook 运行时——足以驱动这个组件的状态流转、调用事件处理器、走上重渲染。
 *
 * 目的不是像素级验证渲染结果，而是抓住真正会毁掉设置页的几类问题：
 *   - 槽位注册契约写错（页面根本不出现）
 *   - 组件挂载时抛错（页面一片空白）
 *   - 数据没接上（列表空着、徽标贴错行）
 *   - 保存时送出的 payload 结构不对（写回坏文件）
 */
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

// ---------------------------------------------------------------- 迷你 React

function createMiniReact() {
  // 挂在"当前渲染实例"上而不是模块级——否则第二次 mount 会复用第一次的 hook 状态，
  // 后面那些独立场景的断言就全在测同一份残留数据。
  let current = null

  const useState = (init) => {
    const c = current
    const i = c.index++
    if (c.hooks.length <= i) c.hooks[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      c.hooks[i] = typeof v === 'function' ? v(c.hooks[i]) : v
      if (c.scheduled) c.scheduled()
    }
    return [c.hooks[i], set]
  }
  const useEffect = (fn) => {
    const c = current
    const i = c.index++
    // 只在首次渲染跑。本组件唯一的 effect 是空依赖的初次加载。
    if (c.hooks.length <= i) {
      c.hooks[i] = true
      c.effects.push(fn)
    }
  }
  const useRef = (init) => {
    const c = current
    const i = c.index++
    if (c.hooks.length <= i) c.hooks[i] = { current: init }
    return c.hooks[i]
  }
  const createElement = (type, props, ...children) => {
    const p = Object.assign({}, props || {})
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { type, props: p }
  }

  function mount(Component) {
    const app = { tree: null, renders: 0 }
    const c = { hooks: [], index: 0, effects: [], scheduled: null }
    const rerender = () => {
      c.index = 0
      c.effects = []
      app.renders++
      current = c
      app.tree = Component()
    }
    c.scheduled = rerender
    rerender()
    for (const fn of c.effects) fn()
    return app
  }

  return { createElement, useState, useEffect, useRef, mount }
}

/**
 * 按完整类名匹配。用 includes 会误伤前缀相同的类——比如 `pr-item` 会连
 * 子元素 `pr-item-main` 一起匹配上，行数直接翻倍。
 */
function hasClass(node, cls) {
  const c = node && node.props ? node.props.className : undefined
  return typeof c === 'string' && c.split(/\s+/).includes(cls)
}

/** 深度优先收集满足条件的元素节点。 */
function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, out)
    return out
  }
  if (node.type !== undefined) {
    if (pred(node)) out.push(node)
    findAll(node.props ? node.props.children : undefined, pred, out)
  }
  return out
}

function findByText(tree, text) {
  return findAll(tree, (n) => {
    const c = n.props ? n.props.children : undefined
    return typeof c === 'string' && c.includes(text)
  })
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && node.props) return textOf(node.props.children)
  return ''
}

function flatText(tree) {
  return findAll(tree, () => true)
    .map((n) => textOf(n.props.children))
    .join(' | ')
}

// ---------------------------------------------------------------- 环境桩

const state = {
  path: 'C:\\Users\\example\\.dsh\\lorebook-prompt.json',
  statusPath: 'C:\\Users\\example\\.dsh\\lorebook-prompt.status.json',
  exists: true,
  raw: {
    version: 1,
    defaults: { cacheSafe: true, scanDepth: 2 },
    entries: [
      { id: 'blue-a', comment: '常驻风格', content: 'A', channel: 'system', mode: 'constant' },
      { id: 'green-b', comment: '审查清单', content: 'B', channel: 'system', mode: 'selective', keys: ['审查'] },
      { id: 'msg-c', comment: '概率提醒', content: 'C', channel: 'message', mode: 'constant', probability: 30 },
    ],
  },
  defaults: { cacheSafe: true, scanDepth: 2, caseSensitive: false, matchWholeWords: false },
  layers: { tail: 10300, 'before-persona': -500 },
  errors: [],
  cacheRouted: ['green-b'],
  entries: [
    { index: 0, id: 'blue-a', comment: '常驻风格', enabled: true, mode: 'constant', probability: 100, keys: [], layer: 'default', order: 0, declaredChannel: 'system', effectiveChannel: 'system', routedForCache: false, hasContent: true, replaceCount: 0 },
    { index: 1, id: 'green-b', comment: '审查清单', enabled: true, mode: 'selective', probability: 100, keys: ['审查'], layer: 'tool-policy', order: 10, declaredChannel: 'system', effectiveChannel: 'message', routedForCache: true, hasContent: true, replaceCount: 0 },
    { index: 2, id: 'msg-c', comment: '概率提醒', enabled: true, mode: 'constant', probability: 30, keys: [], layer: null, order: 0, declaredChannel: 'message', effectiveChannel: 'message', routedForCache: false, hasContent: true, replaceCount: 0 },
  ],
}

const fetchCalls = []
/** 组件的 useEffect 没有返回 load() 的 promise（它只是调用），所以拿不到句柄去 await。
 *  这里改为把宏任务队列抽干——fetch 桩是同步 resolve 的，几轮就够。 */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
function jsonRes(body, status) {
  const code = status || 200
  return { ok: code < 400, status: code, json: async () => body }
}
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : undefined })
  if (url === '/lorebook-prompt/state') return jsonRes({ ok: true, state })
  if (url === '/lorebook-prompt/save') return jsonRes({ ok: true, state, dropped: [] })
  if (url === '/lorebook-prompt/reload') return jsonRes({ ok: true, state })
  return jsonRes({ ok: false, error: '未预期路由 ' + url }, 404)
}

const styleEls = []
globalThis.document = {
  getElementById: (id) => styleEls.find((e) => e.id === id) || null,
  createElement: () => ({ id: '', textContent: '' }),
  head: {
    appendChild: (el) => {
      styleEls.push(el)
      return el
    },
  },
}

// 捕获 bundle 注册
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

// ---------------------------------------------------------------- 加载客户端

console.log('\n【加载与槽位契约】')

// 从本文件位置推导客户端半边入口，不写死任何本机绝对路径
await import(new URL('../lib/client.js', import.meta.url).href)
ok('client.js 调用了 __ModuleLoader__.load', captured !== null)
eq('bundle id 正确', captured && captured.id, 'dsh-lorebooklike-prompt-tool')

const mini = createMiniReact()
const fakeRequire = (name) => {
  if (name === 'react') return mini
  throw new Error('客户端半边不应 require 其它模块，实际要求：' + name)
}
const exportsObj = captured.factory(fakeRequire)
eq('导出 name', exportsObj.name, 'dsh-lorebooklike-prompt-tool')
eq('只声明 slots 依赖', JSON.stringify(exportsObj.inject), '["slots"]')
eq('apply 是函数', typeof exportsObj.apply, 'function')

let registeredSpec = null
let registeredComponent = null
let injectedInto = null
const fakeCtx = {
  effect(fn) {
    return fn()
  },
  slots: {
    inject(seat, fn) {
      injectedInto = seat
      return fn()
    },
    register(spec, component) {
      registeredSpec = spec
      registeredComponent = component
    },
  },
}
exportsObj.apply(fakeCtx)
eq('注入到 settings.section 座位', injectedInto, 'settings.section')
eq('注册名', registeredSpec && registeredSpec.name, 'settings.section')
eq('设置页 id', registeredSpec && registeredSpec.id, 'lorebook-prompt')
eq('导航标题', registeredSpec && registeredSpec.label(), '世界书提示词')
ok('order 是数字', typeof registeredSpec.order === 'number')
eq('传入的组件是函数', typeof registeredComponent, 'function')
ok('样式被注入', styleEls.length === 1)

// ---------------------------------------------------------------- 挂载

console.log('【挂载与首屏】')
fetchCalls.length = 0
const app = mini.mount(registeredComponent)
ok('挂载未抛错', app.tree !== null)
ok('首屏给出了占位（此刻数据还没回来）', flatText(app.tree).includes('载入中') || flatText(app.tree).includes('没有可用状态'))

await flush()
ok('挂载后请求了 /lorebook-prompt/state', fetchCalls.some((c) => c.url === '/lorebook-prompt/state'))
const t1 = flatText(app.tree)
ok('渲染出规则文件路径', t1.includes('lorebook-prompt.json'), t1.slice(0, 160))
ok('渲染出三个条目', t1.includes('常驻风格') && t1.includes('审查清单') && t1.includes('概率提醒'))

// ---------------------------------------------------------------- 列表与徽标

console.log('【列表徽标】')
const badges = findAll(app.tree, (n) => hasClass(n, 'pr-badge'))
const badgeText = badges.map((b) => textOf(b.props.children)).join(',')
ok('蓝灯条目标为「蓝」', badgeText.includes('蓝'))
ok('绿灯条目标为「绿」', badgeText.includes('绿'))
ok('被缓存安全改道的条目标为「改道」', badgeText.includes('改道'))
ok('概率 30 的条目标出百分比', badgeText.includes('30%'))

// 徽标必须贴在正确的行：改道标记只能出现在 green-b 那一行
const rows = findAll(app.tree, (n) => hasClass(n, 'pr-item'))
eq('条目行数', rows.length, 3)
if (rows.length === 3) {
  ok('第 1 行（blue-a）不带改道', !textOf(rows[0].props.children).includes('改道'))
  ok('第 2 行（green-b）带改道', textOf(rows[1].props.children).includes('改道'))
  ok('第 3 行（msg-c）不带改道', !textOf(rows[2].props.children).includes('改道'))
}

// ---------------------------------------------------------------- 交互

console.log('【交互】')
// 新增条目
const addBtn = findAll(app.tree, (n) => n.type === 'button' && textOf(n.props.children).includes('新增条目'))[0]
ok('找到「新增条目」按钮', Boolean(addBtn))
const before = app.renders
addBtn.props.onClick()
ok('新增触发了重渲染', app.renders > before)
const rows2 = findAll(app.tree, (n) => hasClass(n, 'pr-item'))
eq('新增后条目行数 +1', rows2.length, 4)
ok('新增后出现未保存提示', flatText(app.tree).includes('未保存'))

// 切换启用
const cbs = findAll(app.tree, (n) => n.type === 'input' && n.props.type === 'checkbox')
ok('渲染出复选框', cbs.length > 0)

// 保存
const saveBtn = findAll(app.tree, (n) => n.type === 'button' && /保存/.test(textOf(n.props.children)))[0]
ok('找到保存按钮', Boolean(saveBtn))
ok('有未保存改动时保存按钮可用', saveBtn.props.disabled === false)
fetchCalls.length = 0
saveBtn.props.onClick()
await new Promise((r) => setTimeout(r, 0))
const saveCall = fetchCalls.find((c) => c.url === '/lorebook-prompt/save')
ok('保存发出了 POST /lorebook-prompt/save', Boolean(saveCall))
eq('保存用 POST', saveCall && saveCall.opts.method, 'POST')
ok('payload 是 { raw: ... } 结构', Boolean(saveCall && saveCall.body && saveCall.body.raw))
eq('payload 里含新增的那条', saveCall.body.raw.entries.length, 4)
ok(
  'payload 不含引擎计算字段（不污染用户原稿）',
  !JSON.stringify(saveCall.body.raw).includes('effectiveChannel') &&
    !JSON.stringify(saveCall.body.raw).includes('sortKey') &&
    !JSON.stringify(saveCall.body.raw).includes('routedForCache'),
)

// ---------------------------------------------------------------- 降级路径

console.log('【降级路径】')
// 服务端报错时界面必须给出提示而不是白屏
globalThis.fetch = async () => jsonRes({ ok: false, error: '后端炸了' }, 500)
const app2 = mini.mount(registeredComponent)
await flush()
ok('请求失败时给出错误提示', flatText(app2.tree).includes('读取失败') || flatText(app2.tree).includes('后端炸了'))
const retryBtn = findAll(app2.tree, (n) => n.type === 'button' && textOf(n.props.children) === '重试')[0]
ok('失败时给出「重试」按钮，而不是让用户以为页面坏了又无从下手', Boolean(retryBtn))

// 失败 → 重试 → 恢复，走一个完整回合
globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts })
  return jsonRes({ ok: true, state })
}
retryBtn.props.onClick()
await flush()
ok('重试成功后渲染出条目列表', flatText(app2.tree).includes('常驻风格'))
ok('重试成功后错误提示消失', !flatText(app2.tree).includes('读取失败'))

// ---------------------------------------------------------------- 汇总

console.log(`\n${'─'.repeat(46)}`)
console.log(failed === 0 ? `✓ 客户端半边测试全部通过：${passed} 项` : `✗ ${failed} 项失败 / 共 ${passed + failed} 项`)
process.exit(failed === 0 ? 0 : 1)
