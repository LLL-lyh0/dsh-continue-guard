# 一键「继续」· dsh-continue-guard

输入框下方多一颗 **继续** 按钮。任务被意外打断时（网络掉线、上游把回复截断、代理掐了流），点一下就把那个会话重新跑起来；并且会自己盯着网络——**网络一回来自动按这一下**，等 1~3 秒再发，不让你手动补话。

> 插件跑在 DeepSeek Harness 的 profile 里，Host 半身负责判定与投递，Client 半身只负责画那颗按钮。

---

## 它解决的两件事

### 1. 一键续跑

按钮常驻在 composer 停靠区（`conversation.composer.dock`，就是宿主显示「轮次 / 步数 / token」那一行）。点一下 = **以正常用户输入的形式**发一句 `继续`。

**点击走的是输入框自己的那条路**：`sessions.binding(id).session.beginSubmission(...)` + `session.prompt([{type:'text',text}], 'queue', …)`——和你敲字按回车是同一对 API。所以这句话会作为一条**普通用户消息**出现在对话里。注意它**不伪造任何消息来源**：这正是调用真实提交链路的意义，署名由宿主在真实链路上完成。

Host 侧另有一条兜底通路（`POST /resume`，署名 `plugin:dsh-continue-guard`），只在客户端拿不到 `sessions` 服务时启用。而**真实拒绝**（上游报错）绝不被兜底重试——那会把同一句话发两遍。

### 2. 自动续跑是真的把循环叫醒

自动续跑走 Host 侧：`agent.followup()` 既排队下一轮的提示词，**又唤醒驱动器**。如果只是往日志里写一条 `user/message`，消息看得见、循环却不会醒——那正是这款插件要修的病。没有活跃 Agent 时宿主会明确回报 `no-agent`，不会假装成功。

### 3. 断网 / 截断后自动续跑

| 触发 | 默认自动续跑 | 为什么 |
|---|---|---|
| 网络中断（`TRANSPORT` / `TIMEOUT` / 5xx / `fetch failed` …） | ✅ | 链路恢复后重试是安全的 |
| 上游截断（`max-tokens`，输出超限） | ✅ | 请求本身是成功的，只是没写完 |
| 上下文超窗（`CONTEXT_WINDOW_EXCEEDED`） | ❌ | 该压缩，硬重试只会再撞墙 |
| 普通模型/代理错误 | ❌（可开） | AUTH、额度耗尽在本地与断网无法区分，乱重试等于白烧额度 |

**网络怎么判**：`navigator.onLine` 只当线索——网卡插着它照样是 `true`，哪怕背后是断掉的上联、captive portal 或没路由的 VPN。真正的判据是 Host 侧对几个探测目标发起的**带超时的真实请求**。探测失败不会把状态永久钉在“离线”：一个每 10 秒的巡检会自己重试，因为链路恢复这件事**不会给任何进程发事件**。

**发送前的三重护栏**：Agent 必须 `idle`（运行中投 followup 会烂在收件箱里）、收件箱必须空着、同一会话两次自动续跑之间还有最小间隔。连续自动续跑有次数上限；**人一说话就清零**——包括次数和间隔，因为人接手过之后，下一次失败是新的一轮。

---

## 安装

```bash
# 从 GitHub 装（推荐）
dsh plugin add github:LLL-lyh0/dsh-continue-guard

# 或者先 clone 再按本地路径装
git clone https://github.com/LLL-lyh0/dsh-continue-guard
dsh plugin add link:./dsh-continue-guard
```

装完**重启 Harness** 才生效（bundles 只在启动时读一次）。想改行为就改 `cordis.patch.yml` 里的 `config`（字段见下），不用动代码。

本插件懒加载宿主自带的 `@deepseek-ai/dsh-llm`（用于判定"这轮到底是被网络截断、还是真的结束了"），以 `peerDependencies` 声明、`optional: true`；加载不到时退化成只看状态机的保守判断，不会挂掉。

> ⚠️ **不要**在这个包里裸 `import '@deepseek-ai/...'`。插件可能以 `link:` 方式安装，Node 会从 **workspace 的真实路径**解析，而 workspace 没有 `node_modules/@deepseek-ai/*`，裸 import 会在加载阶段抛 `ERR_MODULE_NOT_FOUND`，整个插件直接不挂载（本仓库实测过）。需要 harness 模块时走 `createRequire(process.execPath)` + `import(fileURL)`，并且**必须留本地兜底**——`index.js` 里的 `loadHarnessModule()` 就是这么写的。

---

## 配置

全部在 `cordis.patch.yml`，键与 `Config` 一一对应（有静态门禁盯着，写错键 = 加载器直接拒绝该行）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `text` | `继续` | 手动点击与自动续跑发送的文本 |
| `autoResume` | `true` | 自动续跑总开关；关掉只剩手动按钮 |
| `resumeDelayMs` | `2000` | 网络恢复后到发出「继续」的等待（建议 1000–3000） |
| `maxAutoResumes` | `3` | 连续自动续跑上限；人一说话就清零 |
| `autoResumeOnError` | `false` | 普通错误是否也自动续跑 |
| `resumeOnTruncation` | `true` | 输出在 max-tokens 处截断时是否自动续跑 |
| `probeUrls` | deepseek / baidu / github | 连通性探测目标，按顺序试 |
| `probeTimeoutMs` | `4000` | 单次探测超时 |
| `probeRetries` | `5` | 一轮探测的重试次数 |
| `probeBackoffMs` / `probeBackoffMaxMs` | `3000` / `30000` | 探测退避基数与上限 |
| `minResumeGapMs` | `4000` | 两次自动续跑的最小间隔 |
| `pill` / `showReason` | `true` / `true` | 按钮外观；是否把原因写进 hover 提示 |
| `verbose` | `false` | 排查「为什么没自动继续」时打开 |

`probeUrls` 值得按环境改：某些网络会拦这些域名，探测连不上就会被当成「还没联网」。

---

## 按钮怎么读

| 状态 | 外观 | 含义 |
|---|---|---|
| 空闲 | 半透明 | 没检测到中断；点了照样补一句「继续」 |
| 蓝色高亮 | 实心 | 检测到中断，可一键续跑 |
| 转圈 + 倒计时 | 琥珀色 | 网络已恢复 / 已排定，N 秒后自动发 |
| 「正在检测网络…」 | 琥珀 + 红点 | 探测中 / 还没恢复 |
| 绿色「已发送」 | 绿色 | 会话真的重新跑起来了 |

---

## 验证

四道门禁，全部离线可跑，`npm test` 一次跑完（100 项）：

```bash
node scripts/verify-host.mjs    # 31 项决策规则（虚拟时钟 + 假 agent）
node scripts/verify-client.mjs  # 22 项按钮状态机（VM + React 桩 + 假宿主）
node scripts/verify-bundle.mjs  # 28 项静态接线检查
node scripts/verify-mount.mjs   # 19 项挂载与端到端投递（假 ctx + 真路由）
```

外带一道 meta 门禁（`node scripts/check-readme-counts.mjs`，也在 `npm test` 里）：它把上面四个脚本真跑一遍，解析各自实际执行的项数，和本节引用的数字逐个比对，**对不上就转红**。加它是因为这些数字原来是手写的，已经悄悄漂过一次（写着 89、实际 100）——需要人记得更新的数字迟早是错的，而错掉的数字会让整段验证说明看起来像套话，于是真门禁也会被一起忽略。

**`verify-host`——判定规则。**「该续的时候续了、不该续的时候没续」是看界面看不出来的，所以用可以手拨的虚拟时钟和假 agent 把每条决策钉住：正常结束/用户 stop 不算中断；上下文超窗永不自动续；截断会续；探测失败后靠 10 秒巡检重试而不是等一个永远不来的事件；运行中 / 收件箱非空时不投；预算封顶；人说话后预算与间隔一起清零；自己发的消息回声不算人类介入；`turn/start` 结算 episode；连点不双发；手动点击永远可用且不吃自动预算。

**`verify-client`——状态机。** 把真实的 `client.js` 塞进 Node VM，配上够用的 React 桩和不带 DOM 的假宿主，逐个状态渲染那颗按钮：每个宿主状态都有非空文案、倒计时不会显示负数、armed 是琥珀色、探测中与等待中必须文案不同、预算耗尽要说明原因、点击会 POST 且成功后要真的回显、同一 tick 连点只发一次、所有请求都是文档相对路径。点击那条路单独钉死：**先走 `beginSubmission` + `prompt`（不再碰 HTTP 路由）**、发出的字来自配置而不是硬编码、被上游**真实拒绝**时如实报告且**绝不**降级重发（否则同一句话发两遍）；只有拿不到 `sessions` 服务时才回落到 `POST /resume`。

**`verify-bundle`——静默失效。** patch 里的键 schema 不认（加载器拒绝该行、插件凭空消失）、`exports` 指向不存在的文件、图标不是合法 SVG、client 用了 root-absolute 路径（`<base href="./">` 下永远打不到路由）、硬编码颜色、host 顶层裸 import harness 包，以及**注入形状**：`webServer` 必须是静态硬依赖、路由必须注册在插件上下文而不是 `agents` 注入里、`sessions` 必须是**延迟注入**（写成静态依赖会让整块客户端插件永远 pending，连按钮都不渲染）。这些检查扫描的是**剥掉注释后的代码**，避免被自己的说明文字误伤。

**`verify-mount`——挂载与真实投递。** 前三道测的是零件，这道测的是**接头**：用假 ctx 真正跑一次 `apply()`，再通过注册出来的真路由发 HTTP 请求，断言 followup 真的投递到 agent、消息署名是 `plugin:` 而非伪造的 `user`、连点只发一条、以及**没有循环驱动器时路由依然存在**（这条正是 404 的回归守卫）。

> 这些门禁抓到过真 bug，不是装饰：HTTP 4xx 曾被误判成断网、人工介入后最小间隔仍拦住下一次续跑、`onClick` 里漏解构 `setState`（点击成功却抛 `ReferenceError`、成功提示永远不出现）、靠 React state 做连点防护（同一 tick 两下会真发两条）、点击走的是插件署名而不是用户输入（改走真实提交链路后，`beginSubmission` 漏掉会让回显凭空消失）、以及最严重的那个——**HTTP 路由被绑在 `agents` 服务对里**，导致 `agents` 缺席时全部点击返回 404。都在代码里修掉，并留下对应断言；关键几条另做了反向 mutation 验证（把 bug 放回去，确认门禁真的转红——本轮 4 个 mutation 全部被抓到，且还原后文件逐字节一致）。

## 结构

```
index.js            Host：中断判定、续跑预算、探测、HTTP 路由、plugin entry
client.js           Client：composer 停靠区的按钮（__ModuleLoader__ 懒工厂）
cordis.patch.yml    插入插件行 + 全部可调参数
locale/{zh,en}.json Plugin Manager 显示的标题与描述
icon.svg            原创图标（断开的环 + 播放楔形）
scripts/
  verify-host.mjs       31 项：中断判定与续跑预算（虚拟时钟 + 假 agent）
  verify-client.mjs     22 项：按钮状态机（VM + React 桩 + 假宿主）
  verify-bundle.mjs     28 项：静态接线 / 注入形状 / 署名红线
  verify-mount.mjs      19 项：挂载与端到端投递（假 ctx + 真路由）
  check-readme-counts.mjs  meta：本文件引用的项数必须与实测一致
  mutate-client.mjs     反向：把缺陷放回去，门禁必须转红
```

## 红线

**两种续跑，两种署名，不能混。**

- **手动点击 = 真人此刻的输入。** 它不伪造任何消息来源，而是走输入框自己的提交链路（`beginSubmission` + `prompt`），由宿主在真实链路上完成「这是用户输入」的判定。这正是它不该被降级成插件消息的原因——那会把一次真实点击写成一个宿主从未做出的证明。
- **自动续跑 = 插件行为。** 署名 `{ kind: 'plugin:dsh-continue-guard', plugin: 'dsh-continue-guard' }`，**绝不冒用** `{ kind: 'user' }`——后者是宿主对「真人直接输入」的证明，会放行 goal 创建/恢复这类带权限的动作，也会被渲染成用户发言。自动续跑不是人，就不能装成人。

判断标准只有一句话：**这一次，是人按的，还是插件自己决定的？**
