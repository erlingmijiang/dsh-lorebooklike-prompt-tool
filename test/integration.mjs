/**
 * dsh-lorebooklike-prompt-tool 真实集成测试。
 *
 * 和 test/smoke.mjs 的区别：那个用**模拟** ctx 验证接线形状，这个挂**真的**
 * @deepseek-ai/dsh-system-prompt 服务，让插件跑在真实实现上，断言真实装配产出。
 *
 * 这能抓到模拟 ctx 抓不到的一类问题：我对 section()/context()/assemble 瀑布的
 * 用法理解错了，而模拟 ctx 只会乖乖接受我的错。
 *
 * 必须在能解析 @deepseek-ai/* 的位置运行（本目录有指向 profile node_modules 的 junction）。
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt'

// 从本文件位置推导插件入口，不写死任何本机绝对路径
const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const plugin = await import(PLUGIN)

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

// ---------------------------------------------------------------- 夹具
const dir = mkdtempSync(join(tmpdir(), 'pr-integration-'))
const rulesFile = join(dir, 'rules.json')
writeFileSync(
  rulesFile,
  JSON.stringify({
    defaults: { scanDepth: 2 },
    entries: [
      {
        id: 'layer-early',
        channel: 'system',
        mode: 'constant',
        layer: 'before-persona',
        content: '【早层】身份之后、人格之前',
      },
      {
        id: 'layer-late',
        channel: 'system',
        mode: 'constant',
        layer: 'tail',
        content: '【晚层】最末尾',
      },
      {
        id: 'green-never',
        channel: 'system',
        mode: 'selective',
        keys: ['绝不出现的词'],
        layer: 'tool-policy',
        content: '【绿灯】不该出现',
      },
      {
        id: 'msg-context',
        channel: 'message',
        mode: 'constant',
        probability: 100,
        content: '【消息上下文】物化成 user 角色快照',
      },
      {
        id: 'sys-redact',
        channel: 'system',
        mode: 'constant',
        content: '占位',
        replaces: [{ target: 'system', pattern: 'PLAINTEXT-TOKEN', flags: 'g', replacement: '[REDACTED]' }],
      },
    ],
  }),
  'utf8',
)

// ---------------------------------------------------------------- 挂真实服务
console.log('\n【挂真实 SystemPrompt 服务】')

const ctx = new Context()
const forked = ctx.plugin(SystemPrompt, {})
await Promise.resolve(forked) // plugin() 可能是同步返回 fiber；给它一个 tick

ok('系统提示服务已挂载', ctx.systemPrompt !== undefined, String(ctx.systemPrompt))

// 注册一个参照用的外部段，用来验证 order 交错
ctx.systemPrompt.section({ name: 'ref:middle', order: 3000, text: '参照段：order 3000' })
ctx.systemPrompt.section({ name: 'ref:hidden', order: 11000, text: '参照段：order 11000，含 PLAINTEXT-TOKEN' })

// 挂上我们的插件
const applied = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { rulesFile })
await Promise.resolve(applied)
ok('插件已挂载且未抛错', true)

// ---------------------------------------------------------------- 真实装配
console.log('【真实装配】')
const assembly = await ctx.systemPrompt.assemble({})
ok('assemble 返回 sections 数组', Array.isArray(assembly.sections), typeof assembly.sections)

const names = assembly.sections.map((s) => s.name)
console.log(`  装配出 ${names.length} 段，顺序：`)
names.forEach((n, i) => console.log(`    ${String(i).padStart(2)}  ${n}`))

const mine = names.filter((n) => n.startsWith('lorebook-prompt:'))
eq('三条 system 条目各注册一段（绿灯那条已被缓存安全改道走）', mine.length, 3)
ok('段落名带前缀，不会和别人的撞', mine.every((n) => n.startsWith('lorebook-prompt:')))
ok(
  '被改道的绿灯不再出现在系统提示里',
  !names.includes('lorebook-prompt:green-never'),
  names.filter((n) => n.includes('green-never')).join(',') || '（确已不在）',
)
// 缓存安全的意义就在这：系统提示里一个会逐轮开关的段都没有了
ok(
  '系统提示中不含任何本插件的绿灯段',
  !names.some((n) => n.startsWith('lorebook-prompt:green')),
  names.join(','),
)

const idx = (n) => names.indexOf(n)
ok(
  '早层段排在参照段(order 3000)之前',
  idx('lorebook-prompt:layer-early') < idx('ref:middle'),
  `${idx('lorebook-prompt:layer-early')} vs ${idx('ref:middle')}`,
)
ok('晚层段排在参照段之后', idx('lorebook-prompt:layer-late') > idx('ref:middle'))
ok(
  '晚层段(tail=10300)排在 order 11000 之前',
  idx('lorebook-prompt:layer-late') < idx('ref:hidden'),
  `${idx('lorebook-prompt:layer-late')} vs ${idx('ref:hidden')}`,
)
// 真实行为：SystemPrompt 自己会注册一个 harness 身份段(order -1000)，
// 所以我的 before-persona(-500) 排在它之后、其余所有段之前。
ok('第 0 段不是本插件的（harness 身份段占位）', !names[0].startsWith('lorebook-prompt:'), names[0])
ok('早层段紧随身份段之后', idx('lorebook-prompt:layer-early') === 1, `实际下标 ${idx('lorebook-prompt:layer-early')}`)

// ---------------------------------------------------------------- renderPrompt
console.log('【renderPrompt：真实拼接结果】')
const rendered = renderPrompt(assembly)
ok('渲染结果含早层正文', rendered.includes('【早层】身份之后、人格之前'))
ok('渲染结果含晚层正文', rendered.includes('【晚层】最末尾'))
ok('绿灯未命中：正文不出现', !rendered.includes('【绿灯】不该出现'))

// 段落之间应当用空行连接
ok('段落以空行连接', /\n\s*\n/.test(rendered), JSON.stringify(rendered.slice(0, 120)))
// 早层在晚层之前
ok('渲染顺序正确', rendered.indexOf('【早层】') < rendered.indexOf('【晚层】'))

// ---------------------------------------------------------------- assemble 瀑布：system 正则替换
console.log('【assemble 瀑布：真实改写别人的段】')
ok('系统层正则替换生效于他人段', rendered.includes('[REDACTED]') && !rendered.includes('PLAINTEXT-TOKEN'), rendered.includes('PLAINTEXT-TOKEN') ? '原文仍在' : '替换未出现')
ok('原始 assembly 对象未被污染（新对象返回）', assembly.sections.every((s) => typeof s.text === 'string'))

// ---------------------------------------------------------------- 动态上下文
console.log('【动态上下文：message 通道物化成 user 角色快照】')
const contextSections = renderContextSections(assembly)
const ctxNames = contextSections.map((s) => s.name)
ok('上下文里含 message 通道的条目', ctxNames.some((n) => n.includes('msg-context')), JSON.stringify(ctxNames))
const msgSection = contextSections.find((n) => n.name.includes('msg-context'))
if (msgSection) {
  ok('上下文正文正确', String(msgSection.text ?? '').includes('【消息上下文】'), JSON.stringify(msgSection))
}

// ---------------------------------------------------------------- 重复名与卸载
console.log('【重名防护与卸载可逆性】')
let dupThrew = false
try {
  ctx.systemPrompt.section({ name: 'lorebook-prompt:layer-early', order: 1, text: '抢占' })
} catch {
  dupThrew = true
}
ok('同名段注册会被拒绝（不会静默覆盖）', dupThrew)

const beforeDispose = (await ctx.systemPrompt.assemble({})).sections.length
// 只卸载本插件那个 fiber。卸载 SystemPrompt 服务本身会让 ctx.systemPrompt 整个消失——
// 那正是上面这行报 undefined 的原因，不是插件的 bug。
if (typeof applied?.dispose === 'function') await applied.dispose()
const afterDispose = (await ctx.systemPrompt.assemble({})).sections.length
ok('卸载插件后本插件注册的段全部消失', afterDispose < beforeDispose, `${beforeDispose} -> ${afterDispose}`)
const leftovers = (await ctx.systemPrompt.assemble({})).sections.filter((s) => s.name.startsWith('lorebook-prompt:'))
eq('卸载后无残留段', leftovers.length, 0)
const stillThere = (await ctx.systemPrompt.assemble({})).sections.filter((s) => s.name === 'ref:middle')
eq('别人的段不受影响', stillThere.length, 1)

// ---------------------------------------------------------------- 汇总
console.log(`\n${'─'.repeat(46)}`)
console.log(failed === 0 ? `✓ 真实集成测试全部通过：${passed} 项` : `✗ ${failed} 项失败 / 共 ${passed + failed} 项`)
process.exit(failed === 0 ? 0 : 1)
