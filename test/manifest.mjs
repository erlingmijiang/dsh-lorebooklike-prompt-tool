/**
 * 清单契约测试：验证本插件的 `dsh.client` 声明会被 shell 正确发现。
 *
 * 为什么要单独测：设置页是客户端半边，shell 靠 package.json 的 `dsh.client`
 * 声明去发现它。声明写错，页面根本不会出现——而这件事原本只有重启应用才看得见。
 * 这里把它提前到现在。
 *
 * 两部分：
 *   ① 结构检查（总是跑）——导出路径、文件存在、bundle id 与包名一致等
 *   ② 官方校验器检查（能拿到就跑）——直接调 @deepseek-ai/dsh-client-modules 的 parseDshClient
 *
 * ② 不总是可用：那个文件是**浏览器安全面**，整体包在 wrapper 里，`exports` 是局部
 * 变量，从外部 import 拿到的是空命名空间。拿不到就跳过，不让它把整层判红。
 *
 * 需要能解析 @deepseek-ai/*：
 *   cmd /c mklink /J test\node_modules "<DSH_HOME>\profiles\node_modules"
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

// 借官方校验器要先把这个环境补齐，否则 import 阶段就 "window is not defined"
if (typeof globalThis.window === 'undefined') globalThis.window = { __ModuleLoader__: { load() {} } }
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (el) => el },
  }
}

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

const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))

// ================================================================ ① 结构检查

console.log('\n【① 结构检查（不依赖官方包）】')

const decl = pkg.dsh && pkg.dsh.client
ok('声明了 dsh.client', Boolean(decl))
eq('platform 是 web（浏览器半边）', decl && decl.platform, 'web')
ok('inject 是字符串数组', Array.isArray(decl && decl.inject) && decl.inject.every((s) => typeof s === 'string'))

const clientExport = pkg.exports && pkg.exports['./client']
ok('package.json 导出 ./client（发现路径）', typeof clientExport === 'string', JSON.stringify(clientExport))

let clientSrc = ''
if (typeof clientExport === 'string') {
  const clientPath = join(pluginRoot, clientExport.replace(/^\.\//, ''))
  ok('导出的客户端文件真实存在', existsSync(clientPath), clientPath)
  if (existsSync(clientPath)) {
    clientSrc = readFileSync(clientPath, 'utf8')
    ok('客户端半边走 __ModuleLoader__.load 协议', clientSrc.includes('__ModuleLoader__.load'))
    ok(
      'bundle id 与包名一致（清单按包名索引，不一致就挂不上）',
      clientSrc.includes(`id: '${pkg.name}'`) || clientSrc.includes(`id: "${pkg.name}"`),
    )
    // 只允许 require react：宿主实现不许进浏览器 bundle（仓库明文禁区）
    const required = [...clientSrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    const illegal = required.filter((n) => n !== 'react')
    ok('客户端半边只 require react', illegal.length === 0, illegal.join(','))
    ok(
      '注册到 settings.section 座位（设置页的稳定契约）',
      clientSrc.includes("slots.inject('settings.section'") || clientSrc.includes('slots.inject("settings.section"'),
    )
  }
}

ok('声明了 dsh.bundle.patch', typeof pkg.dsh.bundle.patch === 'string')
ok('bundle patch 文件存在', existsSync(join(pluginRoot, pkg.dsh.bundle.patch)))
eq('main 指向宿主半边入口', pkg.main, 'lib/index.js')
ok('宿主半边入口存在', existsSync(join(pluginRoot, pkg.main)))

// ================================================================ ② 官方校验器

console.log('【② 官方校验器（能拿到就跑）】')

let parseDshClient = null
try {
  const mod = await import('@deepseek-ai/dsh-client-modules/client')
  const cands = [mod && mod.parseDshClient, mod && mod.default && mod.default.parseDshClient]
  parseDshClient = cands.find((c) => typeof c === 'function') || null
} catch {
  /* 解析不到就算了，下面按"拿不到"处理 */
}

if (typeof parseDshClient !== 'function') {
  console.log('  ○ 拿不到 parseDshClient（该文件是浏览器安全面，整体包在 wrapper 里，')
  console.log('    外部 import 得到空命名空间）。本层跳过——上面 ① 的结果依然有效。')
} else {
  let parsed = null
  let err = null
  try {
    parsed = parseDshClient(pkg.name, pkg.dsh.client)
  } catch (e) {
    err = e.message
  }
  ok('官方校验器接受本插件的 dsh.client', err === null, err)
  eq('解析出的 platform', parsed && parsed.platform, 'web')

  // 反例：确认这个校验器真的会拒绝坏声明，而不是照单全收（防假阳性）
  let rejectedPlatform = false
  try {
    parseDshClient('fake-pkg', { platform: 123 })
  } catch {
    rejectedPlatform = true
  }
  ok('校验器会拒绝非字符串 platform', rejectedPlatform)

  let rejectedInject = false
  try {
    parseDshClient('fake-pkg', { platform: 'web', inject: [1] })
  } catch {
    rejectedInject = true
  }
  ok('校验器会拒绝非字符串 inject', rejectedInject)
}

console.log(`\n${'─'.repeat(46)}`)
console.log(failed === 0 ? `✓ 清单契约测试全部通过：${passed} 项` : `✗ ${failed} 项失败 / 共 ${passed + failed} 项`)
process.exit(failed === 0 ? 0 : 1)
