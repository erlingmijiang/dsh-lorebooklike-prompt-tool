/**
 * dsh-lorebooklike-prompt-tool —— DSH 通用提示词分层注入规则
 *
 * 设计原则：**只挂 DSH 已有的、已文档化的扩展点，不新增会话事件类型。**
 * 这样做的代价与收益都是明确的——日志格式完全不变，旧版本 harness 仍能加载本插件产生的会话；
 * 换来的约束是「概率」必须是确定性的（见 engine.js 的 stableUnit）。
 *
 * 三个挂点及各自负责的能力：
 *
 *   ┌ agent/pre-step ────────────── 绿灯关键词注入 + 消息层正则替换 + 记录扫描文本
 *   │   ↑ 每轮 step 提案时触发，拿得到本轮的 messages / turn / agent
 *   ├ ctx.systemPrompt.section ──── 蓝灯常驻段（分层，每条目一段，order 精确对齐官方锚点）
 *   │   ↑ text 传函数，每次装配求值；读 pre-step 记下的扫描文本，所以绿灯也能进系统提示
 *   └ system-prompt/assemble ────── 系统提示层正则替换（拿到整个 assembly.sections）
 *
 * 「模型可见 ⟺ 已记录」这条铁律在本插件里是成立的：
 *   - section 的产出就是被记录下来的系统提示（surface node 0）
 *   - pre-step 返回的 messages 就是本轮获准并写入日志的消息
 * 所以模型看到的内容与日志可重放出的内容一致，不存在"偷偷改了什么"。
 */

import { readFileSync, writeFileSync, watchFile, unwatchFile, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// 只 import node:* —— 这是 DSH 插件开发的硬约定：能力全部从 ctx 拿，
// 避免 dev-link 与 registry 两种安装方式下的模块解析差异。
//
// 这里曾经 import @deepseek-ai/dsh-llm 的 createUserMessage 来构造合成消息。
// 在 link: 安装下 Node 会按 symlink 的**真实路径**解析依赖，于是它从插件工作区
// 往上找 @deepseek-ai/* 而找不到，插件直接加载失败。改成用 systemPrompt.context()
// 之后既去掉了这个依赖，语义也更贴切（见下方 message 通道的说明）。
import { normalizeRules, normalizeEntry, selectEntries, buildScanText, applyReplaces, LAYER_ORDERS } from './engine.js'

export const name = 'dsh-lorebooklike-prompt-tool'

// 硬依赖只有 systemPrompt：注册提示词段是唯一不可缺的能力。
// 设置页用的 webServer **刻意不写进 inject**——写成硬依赖的话，headless / tui
// 这类没有 web 服务器的 profile 会把插件拖成 PENDING，核心的提示词注入会整个失效。
//
// 可选依赖的正确写法是 ctx.inject(['webServer'], scope => ...)，**不是 ctx.get**。
// ctx.get 对未在 inject 里声明的服务返回 undefined——即使服务活着也查不到。
// 这条曾经写错，代价是设置页路由永远 404。详见下面设置页那段的注释。
export const inject = ['systemPrompt']

/** 本插件注册的 section 名前缀，用于把"自己的段"和"别人的段"区分开。 */
const SECTION_PREFIX = 'lorebook-prompt:'

/** 本插件注册的动态上下文名前缀。 */
const CONTEXT_PREFIX = 'lorebook-prompt-ctx:'

/**
 * message 通道条目的上下文 order 基准。
 * 官方 CONTEXT_ORDERS 占用 110–120（沙箱策略 / 审批策略 / 子代理委派），
 * 本插件排在它们之后，所以从 200 起算，条目自身的 order 再叠加。
 */
const CONTEXT_BASE = 200

/**
 * 设置页 API 的前缀。
 *
 * **必须放在模块级，不能放进 apply 内部。** writeStatus 会在 apply 开头就被调用，
 * 而它的载荷里带着这个字段；如果它是在函数后面声明的 `const`，第一次写状态文件
 * 就会撞上暂时性死区（TDZ）抛 "Cannot access 'API_PREFIX' before initialization"，
 * 被 writeStatus 的 catch 吞掉——于是状态文件一个字都写不出来，而整套诊断恰恰
 * 建立在"没有状态文件 = 插件没加载"之上，会把排查带向完全错误的方向。
 */
const API_PREFIX = '/lorebook-prompt'

/** 会话级状态上限，防止长命进程里无限堆积。 */
const MAX_SESSIONS = 200

// ================================================================ 工具函数

/** 从 agent 上取一个稳定的会话标识。取不到就退回 global（概率退化为按进程稳定）。 */
function sessionKeyOf(agent) {
  try {
    const id = agent?.session?.id ?? agent?.id
    return id == null ? 'global' : String(id)
  } catch {
    return 'global'
  }
}

/** 从一个 content block 里抠出文本。不依赖判别字段名，只看有没有 text。 */
function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  return typeof block.text === 'string' ? block.text : ''
}

/** 把一条消息的全部文本块拼起来。 */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.map(blockText).filter(Boolean).join('\n')
}

/**
 * 旧版规则文件名。
 *
 * 0.1.0 叫 `prompt-rules.json`，改名后是 `lorebook-prompt.json`。这个常量**只用于
 * 一次性迁移**，不作为读取路径——已经迁移过的人不该再被旧文件影响。
 */
const LEGACY_RULES_BASENAME = 'prompt-rules.json'

/** 把规则文件路径解析出来：显式配置 > DSH_LOREBOOK_PROMPT 环境变量 > $DSH_HOME/lorebook-prompt.json */
function resolveRulesPath(config) {
  if (config && typeof config.rulesFile === 'string' && config.rulesFile) return config.rulesFile
  // 旧环境变量 DSH_PROMPT_RULES 仍然认，但新名字优先。
  // 改名不该让已经配好环境变量的人突然失效——那是最容易伤到人的一种改动。
  if (process.env.DSH_LOREBOOK_PROMPT) return process.env.DSH_LOREBOOK_PROMPT
  if (process.env.DSH_PROMPT_RULES) return process.env.DSH_PROMPT_RULES
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'lorebook-prompt.json')
}

/** 用户是否显式指定了规则文件（配置或环境变量）。显式指定时我们绝不碰他的目录。 */
function hasExplicitRulesPath(config) {
  if (config && typeof config.rulesFile === 'string' && config.rulesFile) return true
  return Boolean(process.env.DSH_LOREBOOK_PROMPT || process.env.DSH_PROMPT_RULES)
}

/**
 * 旧文件一次性迁移。
 *
 * 只在**默认路径**上做：新文件还不存在、旧文件在，就把它复制过去。三条纪律：
 *   1. 用户显式配了规则路径就绝不插手——他可能在故意指向别处。
 *   2. 新文件已存在就不动——不覆盖任何可能是更新版本的内容。
 *   3. **不删旧文件**。万一回退到旧版本，规则还在原地。
 *
 * @returns 迁移来源路径，没迁移时为 null
 */
function migrateLegacyRules(rulesPath, explicit) {
  if (explicit || existsSync(rulesPath)) return null
  const legacy = join(dirname(rulesPath), LEGACY_RULES_BASENAME)
  if (!existsSync(legacy)) return null
  try {
    copyFileSync(legacy, rulesPath)
    return legacy
  } catch {
    return null
  }
}

/**
 * 读并解析规则文件。**永不抛错**——文件不存在或 JSON 写坏时返回空规则集，
 * 插件正常加载但不注入任何东西。这样一条写错的规则不会让整个 harness 起不来。
 */
function loadRulesFile(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const { entries, defaults, errors } = normalizeRules(JSON.parse(raw))
    return { path, entries, defaults, errors, missing: false }
  } catch (err) {
    return {
      path,
      entries: [],
      defaults: { scanDepth: 2, caseSensitive: false, matchWholeWords: false },
      errors: [],
      missing: true,
      reason: err.code === 'ENOENT' ? '文件不存在' : err.message,
    }
  }
}

/** 收集所有替换规则，按目标面分好，避免每轮重复遍历。 */
function collectReplaces(entries) {
  const byTarget = { injected: [], system: [], user: [] }
  for (const entry of entries) {
    if (entry.enabled === false) continue
    // 未指定规则归属时，注入面规则跟随该条目；system/user 面规则按自身 target 全局生效
    for (const rule of entry.replaces) {
      if (rule.target === 'system' || rule.target === 'user') {
        if (!byTarget[rule.target].includes(rule)) byTarget[rule.target].push(rule)
      }
      // 'injected' 面在生成正文时按条目就地应用，不收进全局表
    }
  }
  return byTarget
}

// ================================================================ 插件主体

export function apply(ctx, config) {
  const rulesPath = resolveRulesPath(config)
  const migratedFrom = migrateLegacyRules(rulesPath, hasExplicitRulesPath(config))
  let rules = loadRulesFile(rulesPath)

  /** 会话级扫描文本缓冲：sessionKey -> { texts: string[], turn: number } */
  const sessions = new Map()

  /** 当前已注册的 section disposer，rules 变化时整批重建。 */
  let sectionDisposers = []
  /** 当前已注册的动态上下文 disposer，同样随 rules 变化整批重建。 */
  let contextDisposers = []
  /**
   * 设置页 API 是否挂上了。写进状态文件里，用来把三种"设置页不出现"区分开：
   *   false              → 这个 profile 没有 webServer（headless/tui 的正常情况）
   *   true 但页面没出现   → host 半边没问题，问题在客户端半边没被 shell 加载
   *   没有状态文件        → 插件压根没加载
   */
  let settingsApiRegistered = false
  /**
   * 注册是否成功。用来决定最后写不写 loaded —— 注册失败时 safeRebuild 已经写过
   * error 了，这里绝不能再覆盖回去，否则"哪里出问题"这条线索就没了。
   * （这个坑我踩过一次又踩第二次：加了设置页 API 之后又多出一处 loaded 写入。）
   */
  let loadRegistered = false

  const warn = (msg) => ctx.logger.warn(`[lorebook-prompt] ${msg}`)
  const info = (msg) => ctx.logger.info(`[lorebook-prompt] ${msg}`)

  /**
   * 状态文件路径：紧挨规则文件。
   *
   * 存在的理由：本插件的全部工作都是**静默改写提示词**——不打日志到文件、不注册工具、
   * 界面上看不出任何变化。没有这个文件，你无法回答"它到底加载了没有、现在生效几条"。
   * 每轮装配都写文件太浪费，所以只在关键节点落盘。
   */
  const statusPath = join(dirname(rulesPath), 'lorebook-prompt.status.json')

  function writeStatus(event, detail) {
    try {
      writeFileSync(
        statusPath,
        JSON.stringify(
          {
            plugin: name,
            event,
            detail: detail ?? null,
            at: new Date().toISOString(),
            pid: process.pid,
            node: process.version,
            rulesPath,
            // 旧文件名迁移的来源。null = 没发生迁移。改名后这个字段是"我的规则去哪了"的第一线索。
            migratedFrom,
            entries: rules.entries.length,
            enabled: rules.entries.filter((e) => e.enabled !== false).length,
            systemSections: sectionDisposers.length,
            messageContexts: contextDisposers.length,
            // 实际生效的通道（可能因缓存安全被改道过）
            byChannel: {
              system: rules.entries.filter((e) => e.enabled !== false && e.effectiveChannel === 'system').length,
              message: rules.entries.filter((e) => e.enabled !== false && e.effectiveChannel === 'message').length,
            },
            // 声明的通道。与 byChannel 不同即说明有条目被改道了。
            declaredChannel: {
              system: rules.entries.filter((e) => e.enabled !== false && e.channel === 'system').length,
              message: rules.entries.filter((e) => e.enabled !== false && e.channel === 'message').length,
            },
            cacheSafe: rules.defaults.cacheSafe,
            cacheRouted: rules.entries.filter((e) => e.enabled !== false && e.routedForCache === true).length,
            // 设置页 API 挂上没有。false 且 profile 有 web 服务器，就说明出问题了。
            settingsApi: settingsApiRegistered,
            settingsApiPath: API_PREFIX,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      )
    } catch (err) {
      warn(`写状态文件失败（不影响功能）：${err.message}`)
    }
  }

  // 最早落一次盘，**在注册任何东西之前**。
  //
  // 没有这一步，"插件根本没被加载"和"插件加载了但初始化时抛错"会产生**完全一样**的
  // 现象——都是没有状态文件——而这两种情况的排查方向截然不同（一个是组合没生效，
  // 一个是我的代码有 bug）。先写 applied 就能把它们分开。
  writeStatus('applied')

  if (migratedFrom) {
    info(`已把旧规则文件迁移到新名字：${migratedFrom} → ${rulesPath}（旧文件保留未删）`)
  }

  // ---------------------------------------------------------------- 会话状态

  function remember(sessionKey, texts, turn) {
    if (sessions.size > MAX_SESSIONS && !sessions.has(sessionKey)) {
      // 简单的 LRU：删掉最早插入的一个
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
    sessions.set(sessionKey, { texts, turn })
  }

  function scanTextFor(sessionKey, depth) {
    const state = sessions.get(sessionKey)
    if (!state) return ''
    // 条目可以自带 scanDepth 覆盖全局默认；不传时用 defaults。
    const d = typeof depth === 'number' && Number.isFinite(depth) ? depth : rules.defaults.scanDepth
    return buildScanText(state.texts, d)
  }

  // ---------------------------------------------------------------- 蓝灯：系统提示段

  /**
   * 重建全部条目的注册。这是一次全量重建：先把上一次的注册整批注销，再按当前
   * rules 重新注册。规则文件变化时调用，所以条目增删改都会被正确反映。
   *
   * 两条通道落在两个不同的注册表上：
   *   system  → ctx.systemPrompt.section()，进系统提示，带 order 可与其他段交错
   *   message → ctx.systemPrompt.context()，物化成 user 角色快照
   *
   * 每条目一份注册（而不是聚合）是刻意的：只有这样才能让本插件的条目与 DSH
   * 自己的段按 order 真正交错排列——也就是"分层"这个需求的实质。
   */
  function rebuildRegistrations() {
    while (sectionDisposers.length > 0) {
      try {
        sectionDisposers.pop()()
      } catch {
        /* 已经释放过了 */
      }
    }
    while (contextDisposers.length > 0) {
      try {
        contextDisposers.pop()()
      } catch {
        /* 已经释放过了 */
      }
    }

    for (const entry of rules.entries) {
      // 停用条目根本不注册：不仅省一次求值，更重要的是避免它在装配时触发多余的
      // system-prompt/change 通知（那会让已经稳定的提示词缓存前缀失效）。
      if (entry.enabled === false) continue

      // 用 effectiveChannel：绿灯条目默认会被缓存安全改道到 message 通道。
      if (entry.effectiveChannel === 'system') {
        sectionDisposers.push(
          ctx.systemPrompt.section({
            name: `${SECTION_PREFIX}${entry.id}`,
            order: entry.sortKey,
            // interpolate:false 是必须的——提示词正文里出现 {{ 会被当模板变量插值，
            // 未定义的引用会直接抛错，把整次装配打掉。
            interpolate: false,
            text: (context) => renderEntry(entry.id, context, 'system'),
          }),
        )
      } else {
        // message 通道：用动态上下文，而不是伪造一条用户消息。
        // 理由有两条——一是官方对"给模型看额外上下文"的指名机制就是这个；
        // 二是伪造 UserMessage 需要 import @deepseek-ai/dsh-llm，那会让插件在
        // link: 安装下解析失败（见文件头注释）。
        contextDisposers.push(
          ctx.systemPrompt.context({
            name: `${CONTEXT_PREFIX}${entry.id}`,
            order: CONTEXT_BASE + entry.order,
            text: (context) => renderEntry(entry.id, context, 'message'),
          }),
        )
      }
    }

    const sysCount = rules.entries.filter((e) => e.effectiveChannel === 'system' && e.enabled !== false).length
    const msgCount = rules.entries.filter((e) => e.effectiveChannel === 'message' && e.enabled !== false).length
    const routed = rules.entries.filter((e) => e.routedForCache === true && e.enabled !== false)
    info(`已注册 ${sysCount} 个系统提示段 + ${msgCount} 个动态上下文`)
    if (routed.length > 0) {
      // 说清楚为什么，否则用户会以为自己的 channel 声明被无视了。
      warn(
        `缓存安全改道：${routed.length} 条「绿灯 + system 通道」条目已改注入到消息末尾 —— ` +
          `${routed.map((e) => e.id).join(', ')}。它们原本会在命中/失配时重写系统提示，` +
          `而系统提示是请求前缀，一变整段上下文缓存就作废。` +
          `要保留原语义：设 defaults.cacheSafe=false，或给该条目加 "cacheUnsafe": true。`,
      )
    }
  }

  /**
   * 求值一个条目在当前装配时刻应当贡献的文本。
   *
   * 两个通道共用这一段逻辑，差别只在 selectEntries 的 channel 参数——
   * 它决定了概率门的抽取粒度（system 按会话稳定，message 按轮次）。
   *
   * 注意每次都重新 find 条目而不是闭包捕获渲染时的对象：规则文件热重载后
   * rules.entries 是全新数组，闭包里那份就过期了。
   */
  function renderEntry(entryId, context, channel) {
    const live = rules.entries.find((e) => e.id === entryId)
    if (!live || live.enabled === false || live.effectiveChannel !== channel) return ''

    const sessionKey = sessionKeyOf(context?.agent)
    const scanText = scanTextFor(sessionKey, live.scanDepth)

    const passed = selectEntries([live], {
      scanText,
      sessionKey,
      turn: sessions.get(sessionKey)?.turn,
      channel,
    })
    if (passed.length === 0) return ''

    return applyReplaces(live.content, live.replaces, 'injected', live.id, warn)
  }

  // ---------------------------------------------------------------- 观察与消息层替换：pre-step

  // prepend: true 让我成为最外层的监听器：先 await next() 拿到所有下游监听器改完之后
  // 的消息数组，再在其上施加替换。若用默认注册顺序我会变成最里层，改动可能被外层覆盖。
  ctx.on('agent/pre-step', async (payload, next) => {
    // 必须调 next()——不调会静默吞掉整条下游链，且没有任何报错。
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision

    // 本轮已被取消就不要再改消息了。
    if (payload?.signal?.aborted) return decision

    const sessionKey = sessionKeyOf(payload?.agent)

    // 扫描文本只取**真正从 inbox 里认领的消息**（payload.messages），不用 decision.messages。
    //
    // 为什么这件事很关键：下游默认处理器返回的是 [...claimed, context] —— 它已经把运行时
    // 上下文追加进去了，而那份上下文里就含着本插件上一步注入的正文。如果拿 decision.messages
    // 去做关键词匹配，插件会扫到自己写的东西：一条绿灯命中过一次之后，它的正文里通常就含有
    // 自己的触发词（review-checklist 的正文里就有「审查」），于是此后每轮都命中、永远关不掉。
    // 实机上确实出现过这种自我续命。
    //
    // payload.messages 是宿主认领的原始批次，不含任何插件追加物——那才是"用户说了什么"。
    const claimed = payload?.messages ?? []
    // **反转**后再存：buildScanText 的契约是"最新在前"，而 claimed 是时间正序。
    // 不反转的话 scanDepth 取到的是**最旧**的几条而不是最近的几条——
    // 也就是说"回看最近 2 条消息"会变成"回看这批发来的头 2 条"，语义正好相反。
    const texts = claimed.map(messageText).filter(Boolean).reverse()

    // 记下本轮进入模型的消息文本：两个通道的关键词匹配与概率抽取都读它。
    remember(sessionKey, texts, payload?.turn)

    const original = decision.messages ?? []
    let messages = original

    // --- 消息层正则替换（target: 'user'）
    const userRules = collectReplaces(rules.entries).user
    if (userRules.length > 0) {
      messages = messages.map((message) => {
        if (message?.role !== 'user') return message
        let changed = false
        const content = (message.content ?? []).map((block) => {
          const text = blockText(block)
          if (!text) return block
          const replaced = applyReplaces(text, userRules, 'user', undefined, warn)
          if (replaced === text) return block
          changed = true
          return { ...block, text: replaced }
        })
        return changed ? { ...message, content } : message
      })
    }

    // 绿灯（message 通道）的注入不在这里做——它由 systemPrompt.context() 在每次
    // 装配时求值。本监听器只负责记下扫描文本、以及施加 target:'user' 的正则替换。
    if (messages !== original) info(`用户消息正则替换已生效（turn ${payload?.turn}）`)

    return messages === original ? decision : { ...decision, messages }
  })

  // ---------------------------------------------------------------- 系统提示层替换：assemble 瀑布

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    const systemRules = collectReplaces(rules.entries).system
    if (systemRules.length === 0) return result
    if (!result || !Array.isArray(result.sections)) return result

    // 返回新数组/新对象而不是原地改：默认的 next() 返回的就是同一个 assembly 引用，
    // 原地改虽然可行，但会污染上游注册方持有的对象。
    const sections = result.sections.map((section) => {
      if (typeof section?.text !== 'string' || section.text === '') return section
      const text = applyReplaces(section.text, systemRules, 'system', undefined, warn)
      return text === section.text ? section : { ...section, text }
    })

    return { ...result, sections }
  })

  // ---------------------------------------------------------------- 装配与热重载

  /**
   * 带错误捕获的重建。
   *
   * 注册失败不该留下一个"静默什么都没注册"的插件状态——那和"没加载"长得一模一样。
   * 把错误写进状态文件，让两种失败区分开。
   */
  function safeRebuild(phase) {
    try {
      rebuildRegistrations()
      return true
    } catch (err) {
      warn(`注册失败（${phase}）：${err.message}`)
      writeStatus('error', `rebuild(${phase}) 抛错：${err.message}`)
      return false
    }
  }

  ctx.effect(() => {
    loadRegistered = safeRebuild('load')

    if (rules.missing) {
      warn(`规则文件未找到：${rules.path}（${rules.reason}）。插件已加载但不会注入任何内容。`)
    } else {
      const active = rules.entries.filter((e) => e.enabled !== false).length
      info(`已从 ${rules.path} 载入 ${rules.entries.length} 条规则（启用 ${active} 条）`)
      for (const err of rules.errors) warn(err)
    }
    // 这里**不写** loaded：设置页 API 是在 effect 之后才挂的，那时才知道
    // settingsApi 是真是假。统一留到最后写一次，避免多处写入互相覆盖。

    // 每 1.5 秒轮询一次文件变更。用轮询而不是 watch() 是因为
    // watch() 在 Windows 上对"编辑器改名另存"这类写法的行为不一致。
    const onFileChange = (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return
      const next = loadRulesFile(rulesPath)
      if (next.missing) {
        warn(`规则文件消失，保留上一份有效规则：${rulesPath}`)
        return
      }
      rules = next
      safeRebuild('reload')
      const active = rules.entries.filter((e) => e.enabled !== false).length
      info(`规则已热重载：${rules.entries.length} 条（启用 ${active} 条）`)
      for (const err of rules.errors) warn(err)
      writeStatus('reloaded')
    }
    watchFile(rulesPath, { interval: 1500 }, onFileChange)

    return () => {
      unwatchFile(rulesPath, onFileChange)
      // 先落盘卸载状态再清理计数：卸载后 sectionDisposers 归零，信息就丢了
      writeStatus('unloaded')
      while (sectionDisposers.length > 0) {
        try {
          sectionDisposers.pop()()
        } catch {
          /* 已释放 */
        }
      }
      while (contextDisposers.length > 0) {
        try {
          contextDisposers.pop()()
        } catch {
          /* 已释放 */
        }
      }
      sessions.clear()
    }
  }, 'lorebook-prompt: rules, sections and contexts')

  // ---------------------------------------------------------------- 设置页 API
  //
  // 只读写**用户面的原始 JSON**，绝不回传引擎归一化后的对象——否则
  // effectiveChannel / sortKey / routedForCache 这些计算字段会被写回文件，
  // 下一轮加载时它们就变成了"用户声明的一部分"，越滚越脏。
  // 归一化结果只作为**只读摘要**随状态一起返回，供界面显示徽标。

  function readRawRules() {
    try {
      return JSON.parse(readFileSync(rulesPath, 'utf8'))
    } catch {
      return { version: 1, defaults: {}, entries: [] }
    }
  }

  function buildState() {
    const raw = readRawRules()
    const normalized = normalizeRules(raw)
    return {
      path: rulesPath,
      statusPath,
      exists: rules.missing !== true,
      raw,
      defaults: normalized.defaults,
      layers: LAYER_ORDERS,
      errors: normalized.errors,
      cacheRouted: normalized.entries.filter((e) => e.routedForCache).map((e) => e.id),
      // 按**原始下标**对齐而不是用归一化后的数组：normalizeRules 会丢弃没有
      // content 也没有 replaces 的条目，直接用它的结果会和原稿错位，界面上的
      // 徽标就会贴到别的行去。
      entries: (Array.isArray(raw.entries) ? raw.entries : []).map((_, i) => {
        const one = normalizeEntry(raw.entries[i], i, normalized.defaults.cacheSafe)
        if (!one) return { index: i, dropped: true, reason: '既没有 content 也没有 replaces，不会被注入' }
        return {
          index: i,
          id: one.id,
          comment: one.comment,
          enabled: one.enabled,
          mode: one.mode,
          probability: one.probability,
          keys: one.keys,
          layer: one.layer,
          order: one.order,
          declaredChannel: one.channel,
          effectiveChannel: one.effectiveChannel,
          routedForCache: one.routedForCache,
          hasContent: one.content.length > 0,
          replaceCount: one.replaces.length,
        }
      }),
    }
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  /** 只接受本机回环地址。设置页能改提示词注入，不该被局域网里的别人碰到。 */
  function isLoopback(req) {
    const addr = req.socket?.remoteAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) {
          reject(new Error('请求体超过 2 MiB'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch (err) {
          reject(new Error(`请求体不是合法 JSON：${err.message}`))
        }
      })
      req.on('error', reject)
    })
  }

  const apiHandler = async (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: 'lorebook-prompt 设置接口只允许本机访问' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(API_PREFIX.length)

    try {
      if (route === '/state' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, state: buildState() })
        return
      }

      if (route === '/save' && req.method === 'POST') {
        const body = await readBody(req)
        const incoming = body?.raw
        if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
          sendJson(res, 400, { error: 'body.raw 必须是一个对象' })
          return
        }
        if (!Array.isArray(incoming.entries)) {
          sendJson(res, 400, { error: 'body.raw.entries 必须是数组' })
          return
        }
        // 先归一化一遍拿到"哪些条目会被丢弃"的报告，再落盘——但落盘的是用户原稿，
        // 不是归一化结果。写坏的正则等由引擎在注入时静默降级，不阻塞保存。
        const preview = normalizeRules(incoming)
        writeFileSync(rulesPath, JSON.stringify(incoming, null, 2) + '\n', 'utf8')
        rules = loadRulesFile(rulesPath)
        safeRebuild('api-save')
        writeStatus('saved')
        sendJson(res, 200, { ok: true, dropped: preview.errors, state: buildState() })
        return
      }

      if (route === '/reload' && req.method === 'POST') {
        rules = loadRulesFile(rulesPath)
        safeRebuild('api-reload')
        writeStatus('reloaded')
        sendJson(res, 200, { ok: true, state: buildState() })
        return
      }

      sendJson(res, 404, { error: `未知路由 ${route}` })
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) })
    }
  }

  // webServer 既不能写进 inject，也不能用 ctx.get —— 两条路都错，各有各的失败方式：
  //
  //   写进 inject  → headless / tui 没有 web 服务器，整个插件停在 PENDING，
  //                  连提示词注入都失效（为了一个 UI 传输层赔上核心能力）。
  //   用 ctx.get   → **未在 inject 里声明的服务，即使活着也查不到**，返回 undefined。
  //                  于是路由永远不注册、设置页永远 404。这正是实测踩到的坑：
  //                  settingsApi=false，而同一台服务器上 mcp-manager 的路由返回 200。
  //
  // ctx.inject 才是正确姿势：它开一个作用域分支，webServer 出现时激活其中的注册；
  // 缺席时只是那个分支不激活，主插件照常工作。
  //
  // 这个坑我在 recon 时读到过——mcp-manager-plus 的注释里明写「用 ctx.get 查到的是
  // undefined，页面永远注册不上」，我甚至把它抄进了 client.js 关于 slots 的注释，
  // 却没往 webServer 身上套。
  info(`设置页 API 将挂到 ${API_PREFIX}（依赖 webServer 服务）`)
  ctx.inject(['webServer'], (scope) => {
    settingsApiRegistered = true
    scope.effect(
      () => scope.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }),
      'lorebook-prompt: settings API',
    )
    info(`设置页 API 已挂到 ${API_PREFIX}`)
    // 此刻才拿得准 settingsApi 的取值，补写一次；但不覆盖 safeRebuild 写下的 error。
    if (loadRegistered) writeStatus('loaded')
  })

  // 唯一的 loaded 写入点（webServer 缺席时也走这里）
  if (loadRegistered) writeStatus('loaded')

  info(`已加载（规则文件：${rulesPath}）`)
}
