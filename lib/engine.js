/**
 * dsh-lorebooklike-prompt-tool 纯规则引擎
 *
 * 本文件**不 import 任何 DSH 包，也不 import 任何 node: 模块**——它是纯粹的数据变换，
 * 因此可以脱离 harness 单独单元测试（见 test/run.mjs）。
 *
 * 四项核心能力的落点：
 *   ① 分层提示词 —— LAYER_ORDERS 把语义化层名映射成 systemPrompt.section 的 order
 *   ② 蓝绿灯     —— evaluateKeys()：constant 无条件常驻 / selective 按关键词
 *   ③ 概率激活   —— passesProbability()：FNV-1a 稳定哈希，同一 (会话, 轮次, 条目) 结果恒定
 *   ④ 正则替换   —— applyReplaces()：按 target 分别作用于注入正文 / 系统提示 / 用户消息
 */

// ---------------------------------------------------------------- 稳定随机

/** FNV-1a 32 位哈希。选择它是因为短、无依赖、跨进程稳定。 */
function fnv1a32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 把任意几个标识拼成一个 [0,1) 的稳定小数。
 *
 * 为什么不用 Math.random()：DSH 的会话日志必须能完整重放出模型看到的内容
 * （「模型可见 ⟺ 已记录」）。真随机会让重放结果与当初不一致，所以这里用
 * 确定性哈希——同一个键永远得到同一个值，换一轮/换一个会话才变。
 *
 * @param {...(string|number)} parts 参与哈希的键片段
 * @returns {number} [0, 1)
 */
export function stableUnit(...parts) {
  return fnv1a32(parts.map((p) => String(p)).join('\u0000')) / 0x100000000
}

/**
 * 概率门。100 恒定通过，0 恒定拒绝，其余按稳定哈希落在区间内。
 *
 * system 通道按「会话」抽取（每轮结果一致，避免系统提示逐轮抖动）；
 * message 通道按「轮次」抽取（每轮可复现但会变化）。
 *
 * @param {object} entry 已归一化的条目
 * @param {{sessionKey?: string, turn?: number}} ctx
 * @returns {boolean}
 */
export function passesProbability(entry, ctx = {}) {
  const p = entry.probability
  if (p >= 100) return true
  if (p <= 0) return false
  // 按**实际生效**的通道决定抽取粒度：一条声明 system 但被缓存安全改道到 message
  // 的条目，现在住在消息末尾，就该拿轮次级语义，而不是会话级。
  const home = entry.effectiveChannel ?? entry.channel
  const scope = home === 'message' ? String(ctx.turn ?? 't') : 'session'
  const unit = stableUnit(entry.id, entry.seedSalt || '', ctx.sessionKey || 'global', scope)
  return unit * 100 < p
}

// ---------------------------------------------------------------- 关键词匹配

/** 转义正则元字符，用于全词匹配时把纯文本关键字变成字面量。 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把一个 key 编译成正则，编译不出来就返回 null（退回纯子串匹配）。
 *
 * 支持三种写法：
 *   - `/pattern/flags` 字面量（酒馆式写法，优先级最高）
 *   - `keyIsRegex: true` 时把 key 本身当正则源码
 *   - 其余情况返回 null，走纯子串（可选全词）匹配
 */
function keyToRegex(key, entry) {
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(key)
  if (literal) {
    try {
      return new RegExp(literal[1], literal[2] || (entry.caseSensitive ? '' : 'i'))
    } catch {
      return undefined // 写坏了的正则：明确区别于"不是正则"，交由调用方跳过该键
    }
  }
  if (entry.keyIsRegex) {
    try {
      return new RegExp(key, entry.caseSensitive ? '' : 'i')
    } catch {
      return undefined
    }
  }
  return null
}

/**
 * 单键匹配。语义对齐 SillyTavern 的 WorldInfoBuffer.matchKeys：
 * 正则会**覆盖**大小写与全词设置（正则里自己写 flag 自己负责）。
 *
 * @param {string} haystack 待扫描文本
 * @param {string} key 关键字
 * @param {object} entry 条目
 * @returns {boolean}
 */
export function matchText(haystack, key, entry) {
  const re = keyToRegex(key, entry)
  if (re === undefined) return false // 坏正则：不匹配，且不抛错
  if (re) return re.test(haystack)

  const cs = entry.caseSensitive === true
  const h = cs ? haystack : haystack.toLowerCase()
  const k = cs ? key : key.toLowerCase()

  if (entry.matchWholeWords) {
    // 多词关键字按酒馆的做法直接子串匹配（避免把一个短语拆成词边界）
    if (/\s/.test(k)) return h.includes(k)
    return new RegExp(`(?:^|\\W)${escapeRegex(k)}(?:$|\\W)`).test(h)
  }
  return h.includes(k)
}

/**
 * 决定一个条目在当前扫描文本下是否激活。
 *
 * 蓝灯（constant）：无条件激活，keys 被忽略。
 * 绿灯（selective）：主键必须命中（有主键时），再用副键 + keyLogic 二次判定。
 *
 * keyLogic 四种逻辑对齐酒馆（主键已命中为前提）：
 *   any    —— 副键任意一个命中      （酒馆 AND_ANY）
 *   all    —— 副键全部命中          （酒馆 AND_ALL）
 *   notAny —— 副键一个都没命中      （酒馆 NOT_ANY）
 *   notAll —— 不是所有副键都命中    （酒馆 NOT_ALL）
 *
 * @param {object} entry 条目
 * @param {string} scanText 待扫描文本
 * @returns {boolean}
 */
export function evaluateKeys(entry, scanText) {
  if (entry.mode === 'constant') return true

  const keys = toStrArray(entry.keys)
  const secondary = toStrArray(entry.keySecondary)

  if (keys.length === 0) return false // 绿灯却没给主键：永远不触发（而不是意外常驻）

  const primaryMatch = keys.some((k) => matchText(scanText, k, entry))
  if (!primaryMatch) return false

  if (secondary.length === 0) return true

  const anySec = secondary.some((k) => matchText(scanText, k, entry))
  const allSec = secondary.every((k) => matchText(scanText, k, entry))

  switch (entry.keyLogic) {
    case 'all':
      return allSec
    case 'notAny':
      return !anySec
    case 'notAll':
      return !allSec
    case 'any':
    default:
      return anySec
  }
}

// ---------------------------------------------------------------- 正则替换

/**
 * 对一段文本套用所有匹配 target 的替换规则。
 *
 * 坏正则**静默跳过**而不是抛错——插件挂在一轮对话的关键路径上，
 * 一条写错的规则绝不该让整轮请求失败。跳过时通过 onError 回调上报。
 *
 * @param {string} text 原文
 * @param {Array<object>} rules 替换规则数组
 * @param {'injected'|'system'|'user'} target 作用面
 * @param {string} [entryId] 当前条目 id（供规则的 entryIds 过滤）
 * @param {(msg: string) => void} [onError] 坏规则上报
 * @returns {string}
 */
export function applyReplaces(text, rules, target, entryId, onError) {
  if (!text || !Array.isArray(rules) || rules.length === 0) return text
  let out = text
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== 'string') continue
    if (rule.target !== target) continue
    const only = toStrArray(rule.entryIds)
    if (only.length > 0 && entryId && !only.includes(entryId)) continue
    if (only.length > 0 && !entryId) continue

    let re
    try {
      // 每次都新建 RegExp：带 /g 的正则对象有 lastIndex 状态，复用会漏匹配
      re = new RegExp(rule.pattern, rule.flags || 'g')
    } catch (err) {
      onError?.(`replacement pattern is not a valid regex: ${rule.pattern} (${err.message})`)
      continue
    }
    try {
      out = out.replace(re, rule.replacement ?? '')
    } catch (err) {
      onError?.(`replacement failed for pattern ${rule.pattern}: ${err.message}`)
    }
  }
  return out
}

// ---------------------------------------------------------------- 分层锚点

/**
 * 语义化层名 → systemPrompt 的 order 锚点。
 *
 * 数值直接对齐 @deepseek-ai/dsh-system-prompt 里导出的 SECTION_ORDERS 常量，
 * 所以「插到工具指引之后、文件交付引用之前」这种意图可以精确表达，
 * 而不是靠猜一个魔数。层与层之间留了空档，条目的 order 作为层内微调叠加在这上面。
 */
export const LAYER_ORDERS = {
  identity: -1000, // 与 harness 身份同层（谨慎使用）
  'before-persona': -500, // 身份之后、部署人格之前
  'persona-prefix': 1, // 紧跟人格前缀
  plan: 500, // 计划策略层
  team: 600, // 团队策略层
  ptc: 800, // PTC 模式专属层
  'file-reference': 900,
  tool: 1000, // 工具说明起点
  'tool-policy': 3150, // MCP(3100) 之后、TOOLS_SDK(5000) 之前
  'tool-sdk': 5000,
  deliverable: 9000, // 交付物引用层
  structured: 9900, // 结构化输出层
  source: 10000, // harness 自身源码说明层
  web: 10100, // web 界面说明层
  'persona-suffix': 10200, // 部署人格后缀
  tail: 10300, // 最末尾
  'after-persona': 10300,
}

/** 未指定 layer 时的默认锚点：落在工具说明之前、人格与策略之间。 */
export const DEFAULT_LAYER_ORDER = 700

// ---------------------------------------------------------------- 归一化

function toStrArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.length > 0)
  if (typeof v === 'string' && v.length > 0) return [v]
  return []
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 把用户手写的条目补全成引擎内部形状。**永不抛错**：
 * 一份写坏的 rules.json 应当降级成"这条不生效"，而不是让插件崩掉。
 *
 * @param {object} raw 原始条目
 * @param {number} index 数组下标（用于生成兜底 id）
 * @param {boolean} [cacheSafe] 是否启用缓存安全改道（默认启用）
 * @returns {object|null} 归一化后的条目，或 null（连内容都没有，无意义）
 */
export function normalizeEntry(raw, index, cacheSafe) {
  if (!raw || typeof raw !== 'object') return null
  const content = typeof raw.content === 'string' ? raw.content : ''
  const replaces = Array.isArray(raw.replaces) ? raw.replaces.filter((r) => r && typeof r.pattern === 'string') : []
  if (!content && replaces.length === 0) return null

  const channel = raw.channel === 'message' ? 'message' : 'system'
  const layer = typeof raw.layer === 'string' && raw.layer in LAYER_ORDERS ? raw.layer : null

  const entry = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `entry-${index}`,
    comment: typeof raw.comment === 'string' ? raw.comment : '',
    enabled: raw.enabled !== false,
    channel,
    mode: raw.mode === 'selective' ? 'selective' : 'constant',
    keys: toStrArray(raw.keys),
    keySecondary: toStrArray(raw.keySecondary),
    keyLogic: ['any', 'all', 'notAny', 'notAll'].includes(raw.keyLogic) ? raw.keyLogic : 'any',
    keyIsRegex: raw.keyIsRegex === true,
    caseSensitive: raw.caseSensitive === true,
    matchWholeWords: raw.matchWholeWords === true,
    scanDepth: clampNumber(raw.scanDepth, 1, 50, 2),
    probability: clampNumber(raw.probability, 0, 100, 100),
    seedSalt: typeof raw.seedSalt === 'string' ? raw.seedSalt : '',
    order: clampNumber(raw.order, -99999, 99999, 0),
    layer: layer ?? (channel === 'system' ? 'default' : null),
    content,
    replaces,
  }

  // 最终排序键：层锚点 + 层内偏移。数字越大越靠后（对齐酒馆 order 语义）。
  const base = layer ? LAYER_ORDERS[layer] : DEFAULT_LAYER_ORDER
  entry.sortKey = base + entry.order

  // ---------------------------------------------------------------- 缓存安全
  //
  // 上下文缓存匹配的是请求的**前缀**，而系统提示在请求最前面——它一变，
  // 后面所有内容全部作废。
  //
  // 什么会变？只有 selective（绿灯）：它按关键词逐轮开关。constant 永远在；
  // 概率条目按「会话」抽取（见 passesProbability 的 scope 分支），一个会话内恒定。
  // 所以唯一的缓存杀手是：channel === 'system' 且 mode === 'selective'。
  //
  // 而 message 通道的注入被宿主追加在消息数组**末尾**（dsh-agent-loop 里是
  // `[...claimed, context]`），前面的一切原样保留 —— 这正是"注入在前文下面"。
  //
  // 所以默认把这类条目改道到 message 通道。想保留原语义的：设
  // defaults.cacheSafe = false（全局），或给单条加 "cacheUnsafe": true。
  const canToggle = entry.mode === 'selective'
  const routedForCache =
    cacheSafe !== false && raw.cacheUnsafe !== true && entry.channel === 'system' && canToggle

  entry.effectiveChannel = routedForCache ? 'message' : entry.channel
  entry.routedForCache = routedForCache

  return entry
}

/** 列出因缓存安全而被改道的条目（供加载期告警与状态文件使用）。 */
export function cacheRoutedEntries(entries) {
  return entries.filter((e) => e.routedForCache === true)
}

/**
 * 归一化整份规则文件。
 * @param {object} data 解析后的 rules.json
 * @returns {{entries: object[], defaults: object, errors: string[]}}
 */
export function normalizeRules(data) {
  const errors = []
  const entries = []

  // defaults 必须先算：cacheSafe 要参与条目归一化
  const d = (data && data.defaults) || {}
  const defaults = {
    scanDepth: clampNumber(d.scanDepth, 1, 50, 2),
    caseSensitive: d.caseSensitive === true,
    matchWholeWords: d.matchWholeWords === true,
    cacheSafe: d.cacheSafe !== false,
  }

  const source = data && Array.isArray(data.entries) ? data.entries : []
  source.forEach((raw, i) => {
    const entry = normalizeEntry(raw, i, defaults.cacheSafe)
    if (!entry) {
      errors.push(`entries[${i}] 既没有 content 也没有 replaces，已跳过`)
      return
    }
    entries.push(entry)
  })

  return { entries, defaults, errors }
}

/**
 * 把最近若干条消息拼成待扫描文本。
 * @param {string[]} texts 消息文本，**最新在前**
 * @param {number} depth 回看条数
 * @returns {string}
 */
export function buildScanText(texts, depth) {
  const n = clampNumber(depth, 1, 50, 2)
  return texts.slice(0, n).join('\n')
}

/**
 * 按通道筛出本轮激活的条目，并按 sortKey 升序排好。
 *
 * 用 effectiveChannel 而非 channel —— 前者可能因为缓存安全被改道过。
 *
 * @param {object[]} entries 全部条目
 * @param {{scanText: string, sessionKey?: string, turn?: number, channel: 'system'|'message'}} ctx
 * @returns {object[]}
 */
export function selectEntries(entries, ctx) {
  const out = []
  for (const e of entries) {
    if (e.enabled === false) continue
    if ((e.effectiveChannel ?? e.channel) !== ctx.channel) continue
    if (!evaluateKeys(e, ctx.scanText)) continue
    if (!passesProbability(e, { sessionKey: ctx.sessionKey, turn: ctx.turn })) continue
    out.push(e)
  }
  out.sort((a, b) => a.sortKey - b.sortKey || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}
