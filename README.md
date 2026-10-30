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

**WiFi 掉线再重连是这条的重点**，而且有两条独立的证据通路（之前只有一条，所以漏了一半情况）：

1. **错误本身的形状**：`TRANSPORT` / `TIMEOUT` / 5xx / `fetch failed` / `ECONNRESET` / `getaddrinfo` / 未预期的 EOF… 这些一望即知是链路问题。
2. **这台机器自己报离线**：WiFi 掉线时，浏览器会先报 `offline`。有些 WiFi 断流并不产生上面那些 errno 文案，而是被上游表现成「空回复」「上游过载」这种通用错误——单看错误无法与额度/账号问题区分。但只要**本机在那一刻确实报了离线**，这就是链路问题，自动续跑。

浏览器恢复 `online` 时，插件把它当作**「链路已回来」的证据**（而不是等探测跑完），立刻走同一套 2 秒冷却。⚠️ 这里修过一个真 bug：原来这个恢复信号被 `if (!networkDown) return` 丢掉了 —— 而 `networkDown` 只有在探测**失败过**之后才为真，探测又慢（重试+退避可达 137 秒），所以在 WiFi 重连那一刻它通常是 `false`，信号被丢掉，会话就永远不续。现在恢复信号无条件被采纳，发送前的所有检查照旧。

**手动停止仍然永不续跑。** 这是用宿主源码定死的判据：`abortedCancelCause` 的取值是闭集（`user` / `parent` / `disposed` / `hook`），其中 `user` 只由 `cancel({kind:'user'})` 产生——也就是你按停止按钮、侧栏或命令触发的那条路径。**WiFi 掉线产生不了它**，所以「点了停止就不自动续」这条规则不需要任何妥协，也不会有误伤。

| 触发 | 默认自动续跑 | 为什么 |
|---|---|---|
| 网络中断（`TRANSPORT` / `TIMEOUT` / 5xx / `fetch failed` …） | ✅ | 链路恢复后重试是安全的 |
| 本机报过离线时出现的通用错误 | ✅ | 本机确实断过网，这是链路问题而非账号问题 |
| 上游截断（`max-tokens`，输出超限） | ✅ | 请求本身是成功的，只是没写完 |
| 上下文超窗（`CONTEXT_WINDOW_EXCEEDED`） | ❌ | 该压缩，硬重试只会再撞墙 |
| 普通模型/代理错误 | ❌（可开） | AUTH、额度耗尽在本地与断网无法区分，乱重试等于白烧额度 |

**网络怎么判**：`navigator.onLine` 单独用不可信——网卡插着它照样是 `true`，哪怕背后是断掉的上联、captive portal 或没路由的 VPN。所以真正的判据是 Host 侧对几个探测目标发起的**带超时的真实请求**。探测失败不会把状态永久钉在“离线”：一个每 10 秒的巡检会自己重试，因为链路恢复这件事**不会给任何进程发事件**。反过来，浏览器报 `online` 是「链路已回来」的**第一手证据**，用它把等待缩短到 2 秒冷却，而不是傻等一轮探测跑完。

**发送前的三重护栏**：Agent 必须 `idle`（运行中投 followup 会烂在收件箱里）、收件箱必须空着、同一会话两次自动续跑之间还有最小间隔。连续自动续跑有次数上限；**人一说话就清零**——包括次数和间隔，因为人接手过之后，下一次失败是新的一轮。

### 4. 宿主重启后自动接上没跑完的会话

前三条都要求**会话还活着**（有 agent、有内存里的中断状态）。但如果 DSH 自己被关掉、崩掉、或被杀掉，那个「正在跑」的回合就**什么都没有了**：没有 agent，没有事件，内存状态也随进程一起消失。证据只剩会话日志，而它有两种形态，两种都要接：

- **回合没关**（`turn/start` 之后没有 `turn/end`）→ 进程被强杀/崩溃。宿主自己修日志时也用这个判据（`dsh-session` 的 `interruptedTurnClosers`）。
- **回合被 `disposed` 关掉**（`aborted/reason.disposed`）→ **正常关闭宿主、关机重启**。`AgentLoop.cancel({kind:'disposed'})` 会在退出时把正在跑的回合**补上结尾**，所以日志看起来是「已结束」——旧版扫描只找没关的回合，因此**这一类完全漏掉**，正是你说的「关机、宿主关闭后要接上」。判据的语义在两条路径上是相反的：**活着的时候** `disposed` 是「你主动结束」，绝不能续；**重启后看上一轮的日志**，它是「宿主半路走了」的指纹，必须续。

所以启动时会做一次扫描：

- 只看**最近 24 小时**内有活动的会话（`startupResumeWithinMs`），按最后活动时间**从新到旧**；
- 最多接上 `startupResumeLimit`（默认 3）个，不会一次唤醒一堆；
- 判定之后走**同一套** 2 秒冷却 + 探测 + 预算 + 间隔，不是另起一条发送路径；
- 结尾的判定**只认日志**，而且下面这些形状是在 **467 份真实日志**里数出来的，不是猜的：
  - 回合没关（`turn/start` 之后没有 `turn/end`）→ 进程中途退出 → 接；
  - `{"kind":"aborted","reason":{"kind":"disposed"}}` → 宿主正常关闭/关机 → **接**（`host.exit`）；
  - `{"kind":"error"}` 且错误是传输类（TRANSPORT / TIMEOUT / SERVER / fetch failed…）→ 当成断网 → **等网络探测通过**再接；
  - `{"kind":"max-tokens"}` → 输出被截断 → 按 `resumeOnTruncation` 接；
  - `{"kind":"aborted","reason":{"kind":"user"}}` → **人按过停止** → 永不接（这是明确要求）；
  - `{"kind":"aborted","reason":{"kind":"parent"}}` → 父会话结束，是有意的 → 不接；
  - `completed` → 没事，不接；
  - 上下文超窗（`CONTEXT_WINDOW_EXCEEDED`）→ 永不接（要先压缩，否则只是再溢出一次）。
- 判定为中断的会话会先**按老规矩种一个 episode**（复用同一套预算、探测、最小间隔、防连点），再在没有活 agent 时用 `agents.resume({ resumeSessionId })` 唤醒它——这也是宿主自己的崩溃恢复入口，它会顺手把那个没关上的回合补上结尾。
- **不抢别人的活**：会话已经有 agent 且在跑就跳过（界面可能已经先打开了它）。唤醒失败也不影响别的：episode 已经种下，手动打开那个会话照样会续。

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
| `probeUrls` | deepseek / baidu / github | 连通性探测目标；**并行**各试一次，谁先答上来算谁 |
| `probeTimeoutMs` | `4000` | 单次探测超时（并行，所以一轮最坏就这么多） |
| `netCheckIntervalMs` | `10000` | 常驻网络监测的心跳：不管有没有会话在等，都按这个节奏问一次「现在能不能上网」 |
| `probeRetries` | `5` | 发送前一次「确认链路」的重试次数（慢，但只在真要发之前跑一次） |
| `probeBackoffMs` / `probeBackoffMaxMs` | `3000` / `30000` | 上述确认的重试退避基数与上限 |
| `minResumeGapMs` | `4000` | 两次自动续跑的最小间隔 |
| `minResumeDelayMs` | `1200` | `resumeDelayMs` 的下限，防止配成 0 秒连打 |
| `startupResume` | `true` | 启动时是否扫描近期会话、接上被进程退出打断的回合 |
| `startupResumeWithinMs` | `86400000` | 只回看这么久以内的会话（默认 1 天） |
| `startupResumeLimit` | `3` | 一次启动最多自动接起几个会话 |
| `pill` / `showReason` | `true` / `true` | 按钮外观；是否把原因写进 hover 提示 |
| `verbose` | `false` | 排查「为什么没自动继续」时打开 |

`probeUrls` 值得按环境改：某些网络会拦这些域名，探测连不上就会被当成「还没联网」。为此监测有一条**旁证**通路：只要有一个回合**正常跑完**（`turn/end` 且 `kind: completed`），就说明链路是通的，探测的结论会被它推翻。这条不是补丁而是必需——本机走的是自带 CA 的 TLS 终结加速器，裸 `fetch` 去探 `api.deepseek.com` 可能因为证书校验失败而永远「不可达」，只看探测结果会永远不续跑。

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

四道门禁，全部离线可跑，`npm test` 一次跑完（146 项）：

```bash
node scripts/verify-host.mjs    # 64 项决策规则 + 启动恢复 + 网络监测（虚拟时钟 + 假 agent）
node scripts/verify-client.mjs  # 24 项按钮状态机（VM + React 桩 + 假宿主）
node scripts/verify-bundle.mjs  # 29 项静态接线检查
node scripts/verify-mount.mjs   # 29 项挂载与端到端投递（假 ctx + 真路由 + 假网络）
```

外带一道 meta 门禁（`node scripts/check-readme-counts.mjs`，也在 `npm test` 里）：它把上面四个脚本真跑一遍，解析各自实际执行的项数，和本节引用的数字逐个比对，**对不上就转红**。加它是因为这些数字原来是手写的，已经悄悄漂过一次（写着 89、实际 100）——需要人记得更新的数字迟早是错的，而错掉的数字会让整段验证说明看起来像套话，于是真门禁也会被一起忽略。

**`verify-host`——判定规则。**「该续的时候续了、不该续的时候没续」是看界面看不出来的，所以用可以手拨的虚拟时钟和假 agent 把每条决策钉住：正常结束/用户 stop 不算中断；上下文超窗永不自动续；截断会续；探测失败后靠 10 秒巡检重试而不是等一个永远不来的事件；运行中 / 收件箱非空时不投；预算封顶；人说话后预算与间隔一起清零；自己发的消息回声不算人类介入；`turn/start` 结算 episode；连点不双发；手动点击永远可用且不吃自动预算。

**`verify-client`——状态机。** 把真实的 `client.js` 塞进 Node VM，配上够用的 React 桩和不带 DOM 的假宿主，逐个状态渲染那颗按钮：每个宿主状态都有非空文案、倒计时不会显示负数、armed 是琥珀色、探测中与等待中必须文案不同、预算耗尽要说明原因、点击会 POST 且成功后要真的回显、同一 tick 连点只发一次、所有请求都是文档相对路径。点击那条路单独钉死：**先走 `beginSubmission` + `prompt`（不再碰 HTTP 路由）**、发出的字来自配置而不是硬编码、被上游**真实拒绝**时如实报告且**绝不**降级重发（否则同一句话发两遍）；只有拿不到 `sessions` 服务时才回落到 `POST /resume`。

**`verify-bundle`——静默失效。** patch 里的键 schema 不认（加载器拒绝该行、插件凭空消失）、`exports` 指向不存在的文件、图标不是合法 SVG、client 用了 root-absolute 路径（`<base href="./">` 下永远打不到路由）、硬编码颜色、host 顶层裸 import harness 包，以及**注入形状**：`webServer` 必须是静态硬依赖、路由必须注册在插件上下文而不是 `agents` 注入里、`sessions` 必须是**延迟注入**（写成静态依赖会让整块客户端插件永远 pending，连按钮都不渲染）。还有**服务调用形状**：`ctx.agents` 是 `AgentRegistry` 门面而不是 `AgentLoop`，它的 `resume(options)` 只收一个参数（`ownerCtx` 由门面自己补），写成 `resume(scope, {...})` 会把上下文当成 options、`options.resumeSessionId` 变成 `undefined`，启动恢复于是静默失效——静态扫描把这条钉在代码上，不依赖任何假件。这些检查扫描的是**剥掉注释后的代码**，避免被自己的说明文字误伤。

**`verify-mount`——挂载与真实投递。** 前三道测的是零件，这道测的是**接头**：用假 ctx 真正跑一次 `apply()`，再通过注册出来的真路由发 HTTP 请求，断言 followup 真的投递到 agent、消息署名是 `plugin:` 而非伪造的 `user`、连点只发一条、以及**没有循环驱动器时路由依然存在**（这条正是 404 的回归守卫）。启动恢复也在这道：搭一个临时 `DSH_HOME`，里面放一份真的 zstd 会话日志（有 `turn/start` 没有 `turn/end`，就是进程被杀掉留下的形状），跑完 `apply()` 后断言那个会话**真的被唤醒、而且真的收到了续跑消息**——只断言「调过 resume」是不够的，被唤醒的 agent 一开始就是 idle，不推它一把会话会被打开然后干坐着。这里的假 `agents` 服务必须**照真实门面长得一样**（一个参数的 `resume(options)`，并且像 `announce` 那样派发 `agent/created`），否则它比真货宽松、永远抓不到真货的报错。

> 这些门禁抓到过真 bug，不是装饰：HTTP 4xx 曾被误判成断网、人工介入后最小间隔仍拦住下一次续跑、`onClick` 里漏解构 `setState`（点击成功却抛 `ReferenceError`、成功提示永远不出现）、靠 React state 做连点防护（同一 tick 两下会真发两条）、点击走的是插件署名而不是用户输入（改走真实提交链路后，`beginSubmission` 漏掉会让回显凭空消失）、**HTTP 路由被绑在 `agents` 服务对里**（`agents` 缺席时全部点击返回 404），以及最隐蔽的那个——**启动恢复调服务用错了签名**：`ctx.agents` 是门面，`resume(options)` 只收一个参数，而代码写成 `resume(scope, {...})`，于是 `options` 成了上下文、`resumeSessionId` 变成 `undefined`，在 schema 校验那一层就死掉、连日志都没打开。它让 host / client / bundle 三道门禁**全绿**，因为它们谁都没执行到那一行；是 mount 门禁把假件补成真门面的形状之后才抓住的。
>
> 都在代码里修掉，并留下对应断言；每条另做了反向 mutation 验证（把 bug 放回去，确认门禁真的转红，且还原后文件逐字节一致——一个「还原了但没完全还原」的脚本会让下一轮测的是变异体）。当前 `npm run test:mutation` 共 **26 个 mutation 全部被抓到**：client 4 + monitor 9 + startup 10 + readme 3。
>
> 还有一条同样只在**真实数据**里才看得见：日志尾部是 `{"kind":"interrupted"}` 时，那是**宿主自己**补的收尾标记（`openTurnClosers(events, {kind:'interrupted'})`，`agents.resume` 修复孤儿回合时写的），语义就是「上一轮被打断、而且已经有人替它收了尾」。它原先会落到 `upstream.aborted`——那需要 `autoResumeOnError`（默认关），于是这种会话永远不被接续；更糟的是**它会被永久取消资格**：因为「尝试接续一次」这个动作本身就会写下那个标记，尝试失败之后，之后每一次启动扫描都会把它判成上游中止。现在它按 `host.exit` 处理（启动侧的崩溃指纹），并有一条端到端断言钉住：修好之后，同一个会话**确实被唤醒、而不是只被分类了一次**。
>
> 有一条 mutation 值得单独说：唤醒之后有**两条互相冗余的路径**都会去摆手（`observeIdle` 和网络监测第一次 null→true 的边），实测**只去掉任意一条门禁都是绿的，两条都去掉才转红**。所以 `observeIdle` 不是死代码；也正因为如此，针对「冗余安全网的一半」做单点 mutation 是**不可观测**的，报成 MISSED 是脚本选错了变异对象，而不是门禁的错——那条 mutation 因此改成同时去掉两条边。
>
> 还有一条**门禁自己的**缺陷，是 mutation 抓出来的：`verify-mount` 之前没有设置 `DSH_HOME`，于是 `apply()` 里的启动恢复扫描读的是**跑测试那个人的真实 `<home>/sessions`**。以前恰好没有可续跑的会话，所以看不出问题；上面那个 `interrupted` 修复一落地，真实会话里就多出一个可续跑的，它在挂载时被唤醒、顺手探测了一下网络——就这一次 `fetch`，让「挂载时必须先问一次网络」这条断言在**mount 检查被删掉**的情况下依然成立，门禁在变异体上变绿了。现在那道门禁用自己的一次性 `DSH_HOME`（只含它要用到的会话日志），并额外有一条断言把这件事钉死：`DSH_HOME` 必须是隔离目录、且挂载时**不许唤醒任何东西**。教训是通用的：门禁不能依赖运行者的机器状态，否则它会以「另一个原因」通过，而这正是 mutation 要抓的东西。

## 结构

```
index.js            Host：中断判定、续跑预算、探测、HTTP 路由、plugin entry
client.js           Client：composer 停靠区的按钮（__ModuleLoader__ 懒工厂）
cordis.patch.yml    插入插件行 + 全部可调参数
locale/{zh,en}.json Plugin Manager 显示的标题与描述
icon.svg            原创图标（断开的环 + 播放楔形）
scripts/
  verify-host.mjs       64 项：中断判定、续跑预算、启动恢复、常驻网络监测（虚拟时钟 + 假 session 日志）
  verify-client.mjs     24 项：按钮状态机（VM + React 桩 + 假宿主）
  verify-bundle.mjs     29 项：静态接线 / 注入形状 / 服务调用形状 / 署名红线
  verify-mount.mjs      29 项：挂载与端到端投递（假 ctx + 真路由 + 假网络 + 启动恢复）
  check-readme-counts.mjs  meta：本文件引用的项数 / 配置表必须与实测一致
  mutate-client.mjs     反向：把缺陷放回去，门禁必须转红
  mutate-monitor.mjs    反向：网络监测的每条判据都要能抓住对应的回归
  mutate-startup.mjs    反向：启动恢复（含那个用错服务签名的唤醒调用）必须能被抓住
  mutate-readme.mjs     反向：README 漂移（漏记配置键、写错项数）必须被抓到
```

## 红线

**两种续跑，两种署名，不能混。**

- **手动点击 = 真人此刻的输入。** 它不伪造任何消息来源，而是走输入框自己的提交链路（`beginSubmission` + `prompt`），由宿主在真实链路上完成「这是用户输入」的判定。这正是它不该被降级成插件消息的原因——那会把一次真实点击写成一个宿主从未做出的证明。
- **自动续跑 = 插件行为。** 署名 `{ kind: 'plugin:dsh-continue-guard', plugin: 'dsh-continue-guard' }`，**绝不冒用** `{ kind: 'user' }`——后者是宿主对「真人直接输入」的证明，会放行 goal 创建/恢复这类带权限的动作，也会被渲染成用户发言。自动续跑不是人，就不能装成人。

判断标准只有一句话：**这一次，是人按的，还是插件自己决定的？**
