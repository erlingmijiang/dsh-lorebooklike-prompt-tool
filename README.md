# dsh-lorebooklike-prompt-tool

**DSH的声明式提示词注入层。** 把什么时候、往提示词的哪个位置、以多大把握、注入或改写哪段文本变成一份可编辑、可热重载、可复现的 JSON 规则文件，搭配一个类酒馆世界书的图形编辑器。

> **注：这不是酒馆的dsh插件或替代前端、不是酒馆模拟器、不和角色卡交互、不适用于角色扮演和小说创作场景——它是提示词工程工具。**

## 灵感来源与致谢

这个插件的四项核心机制 **全部源自 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的世界书机制**。

| 从酒馆借鉴的机制                                           | 本插件的对应物                                         |
| -------------------------------------------------- | ----------------------------------------------- |
| 🔵 Constant（蓝灯）／🟢 Selective（绿灯）                   | `mode: "constant"` ／ `mode: "selective"`        |
| Primary Keys ＋ Secondary Keys                      | `keys` ＋ `keySecondary`                         |
| Secondary 逻辑：AND Any / AND All / NOT Any / NOT All | `keyLogic: "any" / "all" / "notAny" / "notAll"` |
| Scan Depth（回看最近 N 条消息）                             | `scanDepth`                                     |
| Probability（概率触发）                                  | `probability`                                   |
| Content 上的 Find/Replace 正则（含捕获组）                   | `replaces`                                      |
| `/pattern/flags` 字面量写法，且**正则优先于大小写与全词设置**          | 同样的优先级规则                                        |
| 「绿灯没给主键就永不触发」这种安全默认                                | 同样是默认                                           |

> **版权声明**：本仓库**不含任何一行酒馆代码**，只参考其被开源社区验证过的**行为逻辑**和**设计哲学**。


---
# （以下全部内容均由蓝色大肥鱼书写）

## 设计边界

- **不新增会话事件类型**——所以旧版本 harness 仍能加载本插件产生的日志。
- **不改 `agent-loop`**，不动任何框架源码。
- **所有注册走 `ctx.effect()` / 注册表 API**，卸载时 section 会整批注销（冒烟测试里有专门一项断言）。
- **不注册任何工具**。规则完全由人工编排——一个能自助改写注入规则的 Agent 不再可审计。
- **零 `@deepseek-ai/*` 运行时依赖**，只需要 `node:*`。
- 不做角色卡、不做 RP 前端、不做记忆——那些是别的插件的事。

## 和酒馆的区别

拿掉角色扮演这个使用背景之后，酒馆的很多设计**在 DSH 里直接照搬是行不通的**，这是宿主的注入面不同导致的必然结果。

| 能力        | 含义                                                       |
| --------- | -------------------------------------------------------- |
| **分层提示词** | 每个条目声明一个语义化层锚点，精确插进系统提示的指定位置，**与 DSH 自己的段落交错**，而不是一律堆在末尾 |
| **蓝绿灯**   | 蓝灯（constant）无条件常驻；绿灯（selective）按关键词/正则命中才激活              |
| **概率激活**  | 条目可按概率抽取，**且结果可复现**——同一会话同一轮次永远得到同一个判定                   |
| **正则替换**  | 按作用面（条目正文 / 整段系统提示 / 用户消息）做正则改写，支持捕获组                    |

### 1. 「位置」的含义完全不同

酒馆的位置是**相对角色卡**的：before/after char definition、AN top/bottom、at depth。它有一套聊天消息数组，投喂点就是其中几个插槽。

DSH 没有角色卡，但它有一个**分段装配、有官方锚点序号的系统提示**。所以本插件的 `layer` 直接对齐 `@deepseek-ai/dsh-system-prompt` 导出的 `SECTION_ORDERS` 常量——「插到工具指引之后、文件交付引用之前」这种意图可以精确表达，不用猜魔数：

```text
 0  harness:identity              (-1000)
 1  lorebook-prompt:layer-early      (-500)   before-persona
 2  deployment:persona-prefix     (0)
 3  lorebook-prompt:sys-redact       (700)
 4  ref:middle                    (3000)
 5  lorebook-prompt:green-never      (3150)   tool-policy
 6  deployment:persona-suffix     (10200)
 7  lorebook-prompt:layer-late       (10300)  tail
 8  ref:hidden                    (11000)
```

（这是 `test/integration.mjs` 在**真实** `SystemPrompt` 服务上装配出来的实际顺序，不是示意。）

### 2. 概率必须是确定性的

酒馆是直接获取随机数。**本插件不能。**

DSH 有一条硬规则：**模型可见 ⟺ 已记录**。会话日志必须能完整重放模型当时看到的内容。真随机会让重放得到与当初不同的结果，直接违反这条铁律；再叠加上下文缓存按**前缀**匹配，逐轮抖动的系统提示会把缓存全部打废。

所以概率门用的是 FNV-1a 稳定哈希而不是 `Math.random()`：同一 `(条目 id, seedSalt, 会话, 轮次)` 永远得到同一个判定。

> **「概率 30%」在本插件里的准确含义是「按轮次确定性抽取」，不是「每次掷骰子」。**
> 对提示词工程来说这反而更好用：你得到的是可复现、可调试的行为，而不是一个无法复现的噪声源。

### 3. 多出来的一层：通道（channel）

酒馆只有一个注入面（聊天消息数组）。DSH 有两个：

|      | `channel: "system"`  | `channel: "message"`                          |
| ---- | -------------------- | --------------------------------------------- |
| 落点   | 系统提示的有序段落            | 转换成 user 角色快照的动态上下文（`systemPrompt.context()`） |
| 作用域  | 每会话稳定                | 每轮独立                                          |
| 概率语义 | 按**会话**抽取（系统提示不逐轮抖动） | 按**轮次**抽取（可复现但会变）                             |
| 适合   | 风格约束、工具约定、分层规则       | 关键词触发的临时指令、概率性提醒                              |

**你要的是「每轮有一定概率追加一段提示」，就用 `message` 通道。** 详见下面的缓存安全一节。

### 4. 明确被移除的东西

| 酒馆有                       | 本插件  | 为什么                                                                                            |
| ------------------------- | ---- | ---------------------------------------------------------------------------------------------- |
| Token Budget / 预算裁剪       | ❌ 不要 | DSH 自己管系统提示的分段装配与预算。插件再插一层预算分配，会和宿主打架，而且它不知道自己排在第几段之前。                                         |
| Recursion（条目命中后触发更多条目）    | ❌ 不要 | 递归注入会让**扫描文本自己污染自己**——这是个大坑：用已注入后的消息做扫描源，一条正文里含自身触发词的绿灯条目会永远自我续命。已修，并且有了回归断言。递归会把同一类问题放大到不可审计。 |
| Sticky / Cooldown / Delay | ❌ 不要 | 这些是有状态的时序机制，与「日志可重放」冲突。                                                                        |
| Group Scoring / 权重抽签      | ❌ 不要 | 组内抽签本质是随机，同上。                                                                                  |
| 角色卡、Persona、RP 前端、聊天记忆    | ❌ 不要 | 那是别的插件的职责。见下一节。                                                                                |
| Vectorized / 向量检索条目       | ❌ 暂不 | 需要 embedding 服务依赖；不想为了一个可选项把插件从「零依赖纯数据变换」变成「需要外部服务」。                                           |

---

## 生态位空缺

这个生态位不是空的。检索依据：市场自己的目录（awesome-dsh-plugin，npm 包 `dsh-plugin-catalog`，构建号 `2026.1010.4974`），共 **4471 个插件**，按「世界书/lorebook」「系统提示注入」「关键词触发注入」「正则改写」等关键词做了三轮全量检索。所以下面是按公开描述划出的功能范围。

| 插件                                                                                                                                                                                                                                                                   | 它做的事                                                                    | 和本插件的差别                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **[dsh-universal-worldbook](https://github.com/TritiumWang/dsh-universal-worldbook)** ⭐3                                                                                                                                                                             | 酒馆风格的**通用**世界书：请求级一次性提示词注入，兼容酒馆世界书格式，关键词/正则/常驻触发，另带 `lore_lookup` 查询工具  | **最接近的先例，也是唯一一个把世界书从 RP 里剥出来的。** 但它固定走「给最新一条用户消息附加一次性注入」，也就是**放弃系统提示分层**——那恰好是本插件缓存安全改道的降级行为。它把这当成唯一模式，本插件把它当成兜底。另：无 npm 包，只能从 GitHub 装。 |
| **[Lume](https://github.com/cayan0x/Lume)** ⭐4 / 3905 dl                                                                                                                                                                                                             | 纪律层插件，「约束按需注入，闲聊轮不额外加 token；**注入分层（系统段只放恒定内容，易变内容随对话尾部快照下发），前缀缓存每步可用**」 | 分层思路和缓存处理**与本插件高度一致**——这是全部 4471 个插件里唯一在自述里明确提「前缀缓存」的。但它的规则是**插件内置的固定纪律**，用户不能编排；分层是它的实现细节，不暴露给用户。                                       |
| **[dsh-custom-mode](https://github.com/BOWLUNA/dsh-custom-mode)** ⭐9 / 11228 dl                                                                                                                                                                                      | 每个模式写一份自定义系统提示词，agent loop 每次调用前重读，改完立即生效                               | 系统提示注入 + 热重载都重叠。但颗粒度是**整份模式级**的替换，不支持逐条目开关、层锚点、概率。                                                                                       |
| **[dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)** ⭐169 / 9262 dl                                                                                                                                                                                  | 七层 SQLite 记忆，「首条消息缓存友好注入 + 每条消息关键词命中」                                   | 「缓存友好注入 + 关键词命中」两件事都做。但触发源是**自动积累的记忆库**，不是人手写的规则条目。                                                                                      |
| [dsh-tavern-v2](https://github.com/chen731215-dev/dsh-tavern-v2) ⭐43、[dsh-nexttavern](https://github.com/a86582751/dsh-nexttavern) ⭐156、[dsh-LorebookMD](https://github.com/609476965/dsh-LorebookMD) ⭐23、[InfiniteDSH](https://github.com/vdnight89/InfiniteDSH) ⭐7 | 世界书是角色扮演娱乐/小说工作台里的子功能模块                                                 | 世界书是工作台的一个零件，绑死角色卡、预设、会话视图、分支。拿不出来单独用。                                                                                                   |
| [dsh-plugin-masterprompt](https://github.com/lw-storm/dsh-plugin-masterprompt) ⭐10、[dsh-agent-persona](https://github.com/Awoodwhale/dsh-agent-persona) ⭐2                                                                                                           | 整体级人设/提示词注入                                                             | 换**一整份**人设或按会话分发；没有逐条目模型。                                                                                                                |
| [dsh-prompt](https://github.com/FeatherHunter/dsh-prompt) ⭐29、[dsh-composer-ux](https://github.com/fangwen9527/dsh-composer-ux) ⭐3、[dsh-prompt-enhance](https://github.com/zzy6-a/dsh-prompt-enhance) ⭐10                                                            | 输入框侧模板，提示词辅助润色                                                          | 帮你在**发送前**写提示词，不进注入层，不参与系统提示装配。                                                                                                          |
| [dsh-muv-engine](https://github.com/chen731215-dev/dsh-muv-engine) ⭐2                                                                                                                                                                                                | 对**模型输出**做正则改写                                                          | 正则替换发生在上游——改的是模型已经生成的文本。本插件的 `replaces` 改的是**送进模型之前**的提示词。方向相反。                                                                          |
| [dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory) ⭐105、[dsh-anchor](https://github.com/yeastcloud/dsh-anchor) ⭐2                                                                                                                                          | 长时记忆/知识库注入                                                              | 注入内容和时机由插件自己的算法决定。                                                                                                                       |

### 缺口到底在哪

把四项核心能力拆开看，**每一项在市场上都能找到邻居**：

| 能力 | 市场上有对应物吗 |
|---|---|
| 酒馆式蓝绿灯 + 关键词/正则触发 | ✅ 有，但都在 RP 工作台里，或由插件内置规则驱动 |
| 系统提示注入 | ✅ 有，但都是整份人设/模式级别 |
| 概率激活 | ❌ 检索范围内**没有**用户可编排的概率条目 |
| 层锚点（插进系统提示的指定位置） | ❌ 检索范围内**没有**对用户暴露的层锚点 |

真正的缺口是三条：

1. **没有人把「层锚点 + 蓝绿灯 + 概率 + 正则替换」四件事装进同一份用户可编辑的规则文件。** 邻居们各占一项，且都把这四项里的某一项写死在插件内部。
2. **没有人把「位置」当成一等公民。** `dsh-universal-worldbook` 干脆放弃分层，全部走尾部。本插件的 `layer` 对齐 DSH 官方 `SECTION_ORDERS`，让「插到工具指引之后、交付物引用之前」这种意图可以精确表达。
3. **缓存前缀几乎没人在乎。** 4471 个插件里只有 Lume 在自述中明确提到前缀缓存。而提示词注入是**唯一**会动到请求前缀的一类插件——这个风险被普遍忽略了。本插件把「`system` + `selective` 这类缓存敌意组合自动改道到消息末尾」做成默认行为，并且从不静默。

一句话：**这个位置不是没人碰，是没人把它当成一个独立的、用户可编排的提示词工程层来做。**

> 顺带说明本插件**刻意不做**的事，避免和市场里的邻居撞车：不注册任何工具（包括不做 `lore_lookup`），规则完全由人工编排——一个能自助改写注入规则的 Agent 不再可审计，而可审计正是这个东西存在的意义。

---

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-lorebooklike-prompt-tool
dsh --profile <你的 profile> --dump-config   # 应出现 "# == dsh-lorebooklike-prompt-tool" 层
```

`<你的 profile>` 换成你实际在用的 profile 名：Electron 桌面应用里是 `desktop`，Web 场景是 `web`，
纯命令行场景是 `headless`。不确定自己有哪些，看 `$DSH_HOME/profiles/` 下的目录名即可——
目录名就是 profile 名（`node_modules` 除外）。

想装**仓库里的最新开发版**（可能超前于 npm 上已发布的版本），用 pnpm 的 git 源简写直接指向仓库：

```sh
dsh plugin --profile <你的 profile> add github:erlingmijiang/dsh-lorebooklike-prompt-tool
```

本地开发时用目录链接：

```sh
dsh plugin --profile <你的 profile> add ./dsh-lorebooklike-prompt-tool
```

> ⚠ **`desktop`（Electron 托管）profile 是个例外，实测有两个坑：**
>
> - `dsh --profile desktop --dump-config` 会被直接拒绝：
>   `profile "desktop" is managed exclusively by the Electron application`
> - `dsh plugin --profile desktop add` 只会写 `dependencies`，**不会**把包追加进 `dsh.profile.bundles`
>   （其他 profile 没有这个限制，一条 `add` 就到位）
>
> 所以装完要手动把 `"dsh-lorebooklike-prompt-tool"` 追加到 `dsh.profile.bundles` 数组末尾，
> 或者在市场/插件页里把它的开关打开。验证层合成成功可以换个非托管 profile 做——
> 同一个包在那边 dump 会打印 `# == dsh-lorebooklike-prompt-tool`。

**热重载**：改**规则文件**即时生效，不需要重启。

### 它挂在哪些扩展点上

插件只挂在 DSH **已有的、已文档化的**扩展点上，**不新增任何会话事件类型**：

| 挂点 | 负责 |
|---|---|
| `ctx.systemPrompt.section()` | `system` 通道条目 —— 有序系统提示段，`order` 对齐官方锚点 |
| `ctx.systemPrompt.context()` | `message` 通道条目 —— 物化成 user 角色快照的动态上下文 |
| `agent/pre-step` 瀑布 | 记录本轮扫描文本；施加 `target: "user"` 的正则替换 |
| `system-prompt/assemble` 瀑布 | 施加 `target: "system"` 的正则替换 |
| `ctx.inject(['webServer'])` | 可选：设置页 HTTP API（作用域分支，不是硬依赖） |

这么选有一个具体好处：**会话日志格式完全没变**。不需要自定义 `SessionEventMap` 成员，也就不会出现「旧版本 harness 拒绝加载整份日志」的问题。

---

## 设置页

浏览器里 **设置 → 世界书提示词**，一个类酒馆世界书的编辑器：左侧条目列表（带 🔵蓝/🟢绿、概率、「改道」徽标），右侧编辑全部字段——通道、模式、分层锚点、关键词与副键、概率、正文、正则替换。支持新增/复制/删除条目，改完点保存即写回 `rules.json` 并**立即生效**，不用重启。

界面直接改你磁盘上那份文件，不引入第二个数据源。写入的是**用户面原始 JSON**——`effectiveChannel`、`sortKey`、`routedForCache` 这些引擎算出来的字段只在界面里显示，绝不写回文件，否则它们会固化成声明的一部分，越滚越脏。

> 设置页接口（`/lorebook-prompt/state`、`/save`、`/reload`）**只接受本机回环地址**——它能改提示词注入，不会被局域网里的其他人修改。
>
> 如果你的 profile 没有 web 服务器（`headless`、`tui`），接口会被跳过但**提示词注入照常工作**。

---

## 缓存安全：为什么绿灯默认不进系统提示

上下文缓存匹配的是请求的**前缀**。系统提示在请求最前面，所以它一变，后面所有内容都要重算——缓存全废，token 成本成倍上升。

**什么会变？只有绿灯（`selective`）。** 它按关键词逐轮开关。蓝灯永远在；概率条目按会话抽取，一个会话内恒定。所以唯一的缓存杀手是：

```
channel: "system"  +  mode: "selective"   ← 每次翻转都重写请求前缀
```

**默认行为**：这类条目会被自动改注入到 **message 通道**。宿主把 message 通道的内容追加在消息数组**末尾**（`dsh-agent-loop` 里是 `[...claimed, context]`），前面的一切原样保留——这正是「注入在前文下面，不动已有前缀」。

插件加载时会打一条告警列出被改道的条目，状态文件里有 `cacheRouted` 计数，界面上显示「改道」徽标。**从不静默。**

想保留原语义的两种方式：

| 方式 | 写法 |
|---|---|
| 全局关闭 | `"defaults": { "cacheSafe": false }` |
| 单条豁免 | 给该条目加 `"cacheUnsafe": true` |

> 实测：集成测试里真实 `SystemPrompt` 装配出的段落序列中，本插件的 `lorebook-prompt:green-*` 段**一个都不剩**——系统提示里不再有任何会逐轮翻转的内容。

---

## 怎么确认它在跑

这个插件的全部工作是**静默改写提示词**——不注册工具、界面上看不出任何变化。所以它在加载、热重载、卸载三个时刻会往规则文件旁边写一份状态：

```
$DSH_HOME/lorebook-prompt.status.json
```

```json
{
  "plugin": "dsh-lorebooklike-prompt-tool",
  "event": "loaded",
  "at": "2026-10-08T00:49:48.000Z",
  "pid": 1948,
  "node": "v24.18.1",
  "rulesPath": "<DSH_HOME>/lorebook-prompt.json",
  "entries": 8,
  "enabled": 6,
  "systemSections": 4,
  "messageContexts": 2,
  "declaredChannel": { "system": 4, "message": 2 },
  "byChannel": { "system": 2, "message": 4 },
  "cacheSafe": true,
  "cacheRouted": 2,
  "settingsApi": true,
  "settingsApiPath": "/lorebook-prompt",
  "migratedFrom": null
}
```

| 字段 | 含义 |
|---|---|
| `event` | `loaded` / `reloaded` / `saved` / `unloaded` / `error` |
| `detail` | 出错时的原因（`event: "error"` 时才有） |
| `pid` | 写它的进程——**能区分是主应用加载的还是别的进程**（排障时这一项价值极高） |
| `migratedFrom` | 从旧文件名迁移过来的来源路径；没迁移过是 `null` |
| `enabled` | 启用条目数 |
| `systemSections` / `messageContexts` | 实际注册出去的段与上下文数量 |
| `byChannel` | **实际生效**的通道分布 |
| `declaredChannel` | 规则文件里**声明**的通道分布（与上一项不同即说明有条目被改道） |
| `cacheSafe` / `cacheRouted` | 缓存安全开关，以及被改道的条目数 |
| `settingsApi` | 设置页 API 挂上没有 |

**`settingsApi` 是重启后排障的第一眼**，它把三种「设置页不出现」区分开：

| 现象 | 结论 |
|---|---|
| 没有状态文件 | 插件压根没加载（组合层问题） |
| `settingsApi: false` | 这个 profile 没有 webServer——`headless`/`tui` 的正常情况 |
| `settingsApi: true` 但页面没出现 | host 半边没问题，问题在客户端半边没被 shell 加载 |

**文件不存在 = 插件还没被加载。** 这是最直接的一声「我在跑」。

> **一个真实踩过的坑：**
>
> 设置页报 404、而 `settingsApi` 是 `false`。根因是 host 半边用 `ctx.get('webServer')` 拿服务——
> 而 **Cordis 里未写进 `inject` 的服务，即使活着，`ctx.get` 也返回 `undefined`**。于是路由从未注册。
> 正确写法是 `ctx.inject(['webServer'], scope => ...)`：服务出现时激活那个作用域分支，缺席时只是分支不激活。
> 也不能把它写进顶层 `inject`——那会让 `headless`/`tui` 这类没有 web 服务器的 profile 停在 PENDING，
> 核心的提示词注入整个失效。**两条路都错，各有各的失败方式。**
>
> 更值得记的是**为什么当时那 105 项测试没拦住它**：测试里的模拟 ctx 中 `get(name)` 返回了服务，
> 比真实 Cordis 宽容，于是「看起来能用」。**比现实宽容的测试替身价值是负的——它给你虚假的安全感。**
> 现在那个 mock 已被改成忠实的（`get()` 恒返回 `undefined`），并且验证过它确实能拦住这类 bug。

### 端到端复现：让它在真的 harness 进程里加载一次

三步，一次性 profile，不碰你的常用 profile：

```sh
# 1. 从 headless 模板建一个一次性 profile（--dump-config 让它建完就退，不启动）
dsh prcheck --from-default-profile headless --dump-config

# 2. 装插件。非托管 profile 一条 add 就到位 —— 会自动写进 dsh.profile.bundles
dsh plugin --profile prcheck add ./dsh-lorebooklike-prompt-tool

# 3. 真的启动一次插件树：--help 会组装全部插件然后退出，不调模型
dsh prcheck --help

# 看结果
cat "$DSH_HOME/lorebook-prompt.status.json"
```

`event` 若是 `unloaded` 而非 `loaded` 属正常：`--help` 立刻退出，卸载时的写入覆盖了加载时的。
**能写出 `unloaded` 本身就说明注册与注销都跑通了。**

用完删掉：

```sh
# 先摘掉插件链接，再删目录 —— 避免 rmdir 递归进你的插件工作区
cmd /c rmdir "<DSH_HOME>\profiles\prcheck\node_modules\dsh-lorebooklike-prompt-tool"
cmd /c rmdir /s /q "<DSH_HOME>\profiles\prcheck"
```

> 这里**故意没有**跑 `dsh prcheck "某个任务"` —— 那会真的调用模型、花你的额度。
> 注册成功已经证明插件在真实进程里活着。

---

## 规则文件

默认读取 `$DSH_HOME/lorebook-prompt.json`。覆盖顺序：

1. 插件配置里的 `rulesFile`
2. 环境变量 `DSH_LOREBOOK_PROMPT`（旧名 `DSH_PROMPT_RULES` 也仍然认，见上文迁移说明）
3. 默认 `$DSH_HOME/lorebook-prompt.json`

文件不存在或 JSON 写坏时，插件**照常加载但不注入任何内容**并打告警——一条写错的规则不该让整个 harness 起不来。把 [`rules.example.json`](./rules.example.json) 复制过去改即可。

### 条目字段

| 字段 | 类型 / 取值 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | `entry-<下标>` | 条目标识，参与概率哈希，改了会换一条随机序列 |
| `comment` | string | — | 给人看的说明 |
| `enabled` | boolean | `true` | 停用条目不会被注册为 section |
| `channel` | `system` \| `message` | `system` | 走系统提示段还是走消息注入 |
| `mode` | `constant` \| `selective` | `constant` | 蓝灯 / 绿灯 |
| `keys` | string[] | `[]` | 绿灯主键 |
| `keySecondary` | string[] | `[]` | 绿灯副键 |
| `keyLogic` | `any` \| `all` \| `notAny` \| `notAll` | `any` | 副键逻辑（主键已命中为前提） |
| `keyIsRegex` | boolean | `false` | 把 `keys` 当正则源码 |
| `caseSensitive` | boolean | `false` | |
| `matchWholeWords` | boolean | `false` | |
| `scanDepth` | number | `2` | 回看最近几条消息 |
| `probability` | number 0–100 | `100` | 概率门 |
| `seedSalt` | string | `''` | 换一条随机序列（且不改 `id`） |
| `layer` | 层名，见下表 | `default` | 分层锚点（仅 `system` 通道） |
| `order` | number | `0` | 层内偏移，数字越大越靠后 |
| `content` | string | `''` | 注入正文 |
| `replaces` | 规则数组 | `[]` | 正则替换 |
| `cacheUnsafe` | boolean | `false` | 单条豁免缓存安全改道 |

`defaults` 里可放 `scanDepth` / `caseSensitive` / `matchWholeWords` / `cacheSafe`，作为条目未指定时的回退。

### 分层锚点

`layer` 的数值直接对齐 `@deepseek-ai/dsh-system-prompt` 导出的 `SECTION_ORDERS` 常量，所以「插到工具指引之后、文件交付引用之前」这种意图可以精确表达，不用猜魔数。`order` 叠加在层锚点之上做层内微调。未指定 `layer` 时落在默认锚点 `700`。

| `layer` | order | 位置 |
|---|---|---|
| `identity` | -1000 | 与 harness 身份同层（谨慎） |
| `before-persona` | -500 | 身份之后、部署人格之前 |
| `persona-prefix` | 1 | 紧跟人格前缀 |
| `plan` | 500 | 计划策略层 |
| `team` | 600 | 团队策略层 |
| `ptc` | 800 | PTC 模式专属 |
| `file-reference` | 900 | 文件引用 |
| `tool` | 1000 | 工具说明起点 |
| `tool-policy` | 3150 | MCP(3100) 之后、TOOLS_SDK(5000) 之前 |
| `tool-sdk` | 5000 | 工具 SDK |
| `deliverable` | 9000 | 交付物引用 |
| `structured` | 9900 | 结构化输出 |
| `source` | 10000 | harness 源码说明 |
| `web` | 10100 | web 界面说明 |
| `persona-suffix` | 10200 | 部署人格后缀 |
| `tail` / `after-persona` | 10300 | 最末尾 |

> 这些数值取自 DSH rc.2 的内部常量。升级 DSH 大版本后请用 `--dump-config` 复核；插件在加载时会打印实际使用的锚点，便于比对。

### 关键词匹配语义

照酒馆的优先级实现，不是拍脑袋定的：

- `/pattern/flags` 字面量写法优先级最高，**正则会覆盖大小写与全词设置**（正则里自己写 flag 自己负责）
- `keyIsRegex: true` 时把 `keys` 当正则源码
- 其余走纯子串匹配，可选全词匹配与大小写敏感
- **绿灯没给主键时永不触发**，而不是退化成常驻——这是个安全默认值
- 副键四逻辑（主键必须已命中）：`any` 副键任一命中 / `all` 副键全命中 / `notAny` 副键全未命中 / `notAll` 非全命中
- 写坏的正则**静默跳过并打告警**，不会让整轮请求失败
- 扫描源是**本轮进入模型之前**的消息（`payload.messages`），不是注入后的结果——避免条目自己触发自己

### 正则替换的作用面

| `target` | 作用对象 | 何时生效 |
|---|---|---|
| `injected` | 该条目自己的注入正文 | 生成正文时 |
| `system` | 整个装配好的系统提示（所有段） | `system-prompt/assemble` 瀑布 |
| `user` | 本轮进入模型的用户消息 | `agent/pre-step` |

`injected` 先跑（窄），`system` 后跑（宽）。规则的 `entryIds` 可限定只对特定条目生效。

---

## 开发（写给其他编码 Agent 看的）

五层验证，从纯逻辑到真实实现逐级加码：

```sh
node test/run.mjs          # ① 纯引擎单测：84 项，零依赖
node test/smoke.mjs        # ② 接线冒烟：117 项，用模拟 ctx 把插件 apply 起来
node test/client.mjs       # ③ 客户端半边：41 项，自建迷你 React 真渲染
node test/integration.mjs  # ④ 真实集成：25 项，挂真的 SystemPrompt 服务
node test/manifest.mjs     # ⑤ 清单契约：13 项，验证 dsh.client 声明会被发现
```

合计 **280 项断言**。

| 层 | 验证什么 | 能抓到什么 |
|---|---|---|
| ① 引擎 | 匹配四逻辑、概率可复现性、层排序、缓存安全改道、正则替换与降级 | 逻辑写错 |
| ② 冒烟 | 注册了哪些段/上下文、pre-step 行为、热重载、卸载可逆、状态文件、设置页 API（含回环拒止）、改名后的旧规则文件迁移 | 接线写错 |
| ③ 客户端 | 槽位注册契约、组件挂载、列表徽标贴对行、新增条目、保存 payload 结构、失败降级与重试 | 设置页根本不出现 / 白屏 / 写回坏文件 |
| ④ 集成 | 插件跑在**真实** `@deepseek-ai/dsh-system-prompt` 上，断言真实装配顺序与渲染结果 | 我对官方 API 的理解写错（模拟 ctx 只会乖乖接受我的错） |
| ⑤ 清单 | `dsh.client` 声明形状、`exports["./client"]` 发现路径、bundle id 与包名一致、浏览器半边只 require react | 设置页在 shell 的清单里根本不会被列出（这个原本只有重启才看得见） |

③ 为什么要自建迷你 React：真实的 `react` 只存在于浏览器 shell 的冻结模块表里，profile 的 `node_modules` 中没有它，所以在 Node 里没法直接渲染客户端半边。于是 `test/client.mjs` 里实现了一个只够用的 hook 运行时——足以驱动状态流转、调用事件处理器、走完整重渲染。它已经抓到过真问题：首次加载失败时早退分支把错误提示吞了，用户只会看到一句「没有可用状态」而无从排查（现在是错误提示 + 重试按钮，并且有失败→重试→恢复的完整回合断言）。

> ①②③⑤ **不需要任何 `@deepseek-ai/*` 依赖**——插件本体只 import `node:*`，直接跑就行。
> 冒烟测试里有一条回归断言专门守着这件事：源码中出现任何 `from '@deepseek-ai/…'` 都会让它变红。
>
> ④ 需要能解析 `@deepseek-ai/*`。在 workspace 里跑时临时建一个 junction，跑完删掉：
> ```sh
> cmd /c mklink /J test\node_modules "<DSH_HOME>\profiles\node_modules"
> node test/integration.mjs
> cmd /c rmdir test\node_modules
> ```
> **跑完务必删掉**：插件若是 `link:` 装的，留着这个 junction 会让下次 `dsh plugin` 操作把 profile 的
> `node_modules` 当成插件的真实依赖目录来处理。

### 诊断工具

`test/probe-sessions.mjs` 是只读探针，用来判定「系统提示在本会话中是否变过」：

```sh
node test/probe-sessions.mjs [参照时刻 ISO8601]
```

会话根目录取 `$DSH_HOME/sessions`，不写死任何路径。它只打印短标识与时间戳，不倒任何正文。

> 两个坑值得知道：
> **会话日志看不到系统提示正文**——它只记录 `request/context.data.systemPromptUpdate` 这样的身份标记和 `request/header` 里的模型/工具集快照。所以别指望从日志里验证注入。
> 而且按整份文本做子串搜索会得到**假阳性**：日志里同时有你自己写文件的 `tool/call`，它的参数会被当成「注入生效」。
> 也别按 `.zstd` 整体解压——文件是每个事件追加一个 frame，Node 的 zstd 解压只吃第一个 frame，得手动扫 `28 B5 2F FD` magic 逐帧解。上面这个探针里是能跑的版本。

---

## License

MIT。见 [LICENSE](./LICENSE)。

灵感与机制参考自 [SillyTavern](https://github.com/SillyTavern/SillyTavern)（AGPL-3.0）的世界书引擎；
本仓库不含其代码，仅参考行为语义并针对 DSH 的注入面重新实现。