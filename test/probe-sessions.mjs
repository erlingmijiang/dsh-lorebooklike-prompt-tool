/**
 * 只读探针：判定"系统提示在本会话中是否发生过变化"。
 *
 * 结论前提：会话日志不存系统提示正文，只在 request/context 里留一个身份标记
 * (data.systemPromptUpdate)，在 request/header 里留 config(模型/工具) 与 reason。
 * 所以"插件是否生效"可以退一步问：系统提示在我装上插件之后**变过没有**。
 *
 * 只打印短标识与时间戳，不倒任何正文。
 *
 * 用法：node test/probe-sessions.mjs [参照时刻 ISO8601]
 *   会话根目录取 $DSH_HOME/sessions（未设 DSH_HOME 时退化为 ~/.dsh/sessions）。
 *   传了参照时刻，就会给每条请求头标注它发生在该时刻之前还是之后。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

// 会话根目录：跟插件本身一样从 DSH_HOME 推导，不写死任何本机路径
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = join(DSH_HOME, 'sessions')
// 可选的参照时刻（ISO8601，如 2026-10-08T00:49:32+08:00）：用来标记"改动之前/之后"。
// 不传就只打印时间戳，不做前后判定。
const MARK_AT = process.argv[2] ? new Date(process.argv[2]).getTime() : NaN
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decompressFrames(buf) {
  const offsets = []
  let at = buf.indexOf(MAGIC)
  while (at >= 0) {
    offsets.push(at)
    at = buf.indexOf(MAGIC, at + 1)
  }
  const parts = []
  for (const off of offsets) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(off)).toString('utf8'))
    } catch {
      /* 不是 frame 起点 */
    }
  }
  return parts.join('')
}

function walk(dir, depth = 0, acc = []) {
  if (depth > 4) return acc
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, depth + 1, acc)
    else if (e.name.endsWith('.zstd')) acc.push(full)
  }
  return acc
}

const files = walk(root).sort((a, b) => statSync(b).mtime - statSync(a).mtime)
for (const f of files) {
  const events = []
  for (const line of decompressFrames(readFileSync(f)).split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 坏行跳过 */
    }
  }
  const rel = f.replace(root, '').replace(/^\\/, '')
  const ctxEvents = events.filter((e) => e.type === 'request/context')
  const hdrEvents = events.filter((e) => e.type === 'request/header')
  if (ctxEvents.length + hdrEvents.length === 0) continue

  console.log(`${rel}`)
  if (!Number.isNaN(MARK_AT)) console.log(`   参照时刻：${new Date(MARK_AT).toLocaleString('zh-CN')}`)
  console.log(`   request/context × ${ctxEvents.length}  request/header × ${hdrEvents.length}`)
  console.log('   -- request/context（系统提示身份标记） --')
  for (const ev of ctxEvents) {
    console.log(
      `      seq ${String(ev.seq).padStart(4)}  ${new Date(ev.time).toLocaleString('zh-CN')}  ` +
        `systemPromptUpdate="${ev.data?.systemPromptUpdate}"  模型=${ev.data?.model}`,
    )
  }
  console.log('   -- request/header（请求头快照） --')
  for (const ev of hdrEvents) {
    const mark = Number.isNaN(MARK_AT) ? '' : new Date(ev.time).getTime() > MARK_AT ? ' [之后]' : ' [之前]'
    console.log(
      `      seq ${String(ev.seq).padStart(4)}  ${new Date(ev.time).toLocaleString('zh-CN')}${mark}  ` +
        `reason="${ev.data?.reason}"  工具数=${ev.data?.header?.tools?.length}  ` +
        `模型=${ev.data?.header?.config?.model}`,
    )
  }
  console.log('')
}
