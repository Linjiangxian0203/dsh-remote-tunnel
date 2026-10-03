# dsh-remote-tunnel 技术路线:面向 dsh 0.1.7/0.2.0 的 web 与桌面端重构适配

> 本文件是「技术路线书」,不是实施记录。写于 2026-10-02,基于对**本机实机**的只读勘查 + **官方文档**
> (deepseek-harness.github.io)核对。所有结论都标了证据来源;推断项标 `INFERRED`,未能验证项标 `UNVERIFIED`。
>
> 勘查产物:`<workspace>\_recon\desktop-app-report.md`(桌面端 390 行)、
> `_recon\compat-report.md`(插件 API 兼容性 437 行)。两份报告均由只读子代理产出,插件源码未被改动。

---

## 一、结论摘要(TL;DR)

1. **插件主体没有坏**:入口契约、`cmdlineArgs`、`commands.register`、`ctx.effect`、`cordis.patch.yml`、
   `appExit` 六个关键集成点在 dsh 0.1.7-rc.1 上**逐字未变**(其中 `dsh-cmdline` 的 `lib/index.js` 与插件
   内置的 0.1.2-alpha.3 **字节相同**)。不需要重写。
2. **但有 1 个真 bug 级隐患**:`src/index.js:28` 用「`webStartup` 服务在不在」判断"我现在是 CLI 还是 web",
   而 `webStartup` 是**邻近行**提供的、行初始化是**并发**的;一旦判断失手,插件会走 CLI 分支 →
   `program.help()` → `appExit(0)` → **把整个 dsh web / 桌面端进程退出**。修法极小:`profileContext.name`。
3. **桌面端 = 同一个应用的另一个壳**。桌面 Electron 进程会起一个 Node 子进程跑
   `runProfile({profile:"desktop", args:["--no-open","--port","19387"]})`,即**桌面端内部就在 127.0.0.1:19387
   跑一个 dsh web**。所以"给桌面端适配"= 让插件能装进 `desktop` profile + 用对 profile 判定,而不是另写一套。
4. **版本矩阵已经错位**:桌面 asar 内置 `@deepseek-ai/*` = **0.2.0-rc.2**;本机 CLI profile 用的是
   **0.1.7-rc.1**;全局 npm dsh = **0.1.7-rc.1**;npm `latest` 已经是 **0.2.0-rc.2**(2026-09-29 发布)。
   **两套运行时并存**,插件必须同时活在这两个面上。
5. **桌面端有个官方能力可以直接用**:桌面 profile 里 `ui-sidebar-browser`(右侧栏「浏览器」标签)是
   desktop-only 行,有 `dshDesktop` carrier 时用**真 Electron `<webview>`**。远程会话可以做成应用内面板,
   而不是"跳系统浏览器"。
6. **官方 SSH 能力族已发布但未装**(`dsh-ssh` / `dsh-fs-ssh` / `dsh-sandbox-ssh` / `dsh-subprocess-ssh`)。
   它**不是**解决当前问题的方案(见路线 C),但是插件未来的正统演进方向。

---

## 二、勘查快照(实机事实)

### 2.1 用户环境

| 项 | 值 | 来源 |
|---|---|---|
| 桌面端 | `<DSH_APP>`,Electron 44,包 `@deepseek-ai/dsh-desktop` **0.2.0-rc.2** | asar `package.json` |
| 桌面宿主数据目录 | `<DSH_HOME>`(`DSH_HOME`) | 目录内容 + 进程路径 `INFERRED` |
| GUI 地址 | `http://127.0.0.1:19387`,**端口硬编码** | `desktop-host-index.js:216-245` |
| 渲染器 origin | `dsh-app://app/`,非 http | `preload-app.cjs:876` |
| 内置运行时 | asar 内 287 个 `@deepseek-ai/*` = **0.2.0-rc.2** | asar `dsh/package.json` |
| CLI profile 运行时 | `profiles/node_modules` 235 个包 = **0.1.7-rc.1** | 实读 package.json |
| 全局 npm dsh | 0.1.7-rc.1 | `dsh --version` |
| npm `latest` | **0.2.0-rc.2** | registry dist-tags |
| 远程服务器 | **`lab` = 192.0.2.10:6204,用户 zc**(旧 192.0.2.55:6104 租期已到) | 实测(密钥登录通过) |
| 服务器侧运行时 | `<server-host>`,node v22.23.2,dsh **0.1.5-rc.2** | 实测 |
| 服务器可达性 | ✅ 直连可用(需 `~/.ssh/config` 更新到新地址) | 实测 |

### 2.2 三个 profile 与插件的安装现状

| profile | 目录 | 插件依赖 | 在 bundles 里 | 运行时来源 |
|---|---|---|---|---|
| `remote`(CLI 主界面) | `profiles/remote` | `link:<workspace>/dsh-remote-tunnel`(0.1.12 本仓库) | ✅ | profiles/node_modules (0.1.7-rc.1) |
| `web`(浏览器 UI) | `profiles/web` | `^0.1.9`(npm 发布版,**落后 3 个 patch**) | ✅ | profiles/node_modules (0.1.7-rc.1) |
| `desktop`(桌面端) | `profiles/desktop` | **没有** | ❌ | **asar 内 0.2.0-rc.2**(installAnchor) |

> `desktop` profile 是一个普通 dsh profile(`package.json` + `cordis.patch.yml` + pnpm),所以
> `dsh plugin --profile desktop add dsh-remote-tunnel` 这条**官方路径是通的**,不需要改桌面端本体。

### 2.3 鉴权模型(0.1.7-rc.1 与 0.2.0-rc.2 都还在)

- 进程级一次性 token:`launchToken = base64url(randomBytes(32))`,只在 **`GET /` + 恰好一个 `?token=`**
  时接受 → **303** + `set-cookie: dsh-auth-<sha256(authority)>=v1.<payload>.<hmac>`;否则 **401**
  `dsh web authentication required`。→ 插件 v0.1.7 起"从 journal 抓 token URL"的做法**仍然必要**。
- cookie:`Path=/; HttpOnly; SameSite=Strict`,**无 `Secure`**,默认 30 天。
- **HMAC 签名密钥是持久凭据**:`$DSH_HOME/.credentials.yaml` 里的 `client-connection/browser-session` 记录。
  → 能读该文件的一方可**自行签发合法 cookie**,不需要 launch token。
- 前置信任栅栏:Host 必须是 loopback 或 `trustedHosts` 成员;Origin(若存在)必须等于 Host;
  `sec-fetch-site: cross-site` 直接 403。**任何前置代理必须重写 Host、丢弃 Origin。**
- 没有 `--no-auth`,没有 logout。`dsh web --host 0.0.0.0` 被有意拒绝。

### 2.4 桌面端的产品接口(官方 + 实机一致)

`dsh-app://app/` origin 下 preload 暴露(`preload-app.cjs:789-877`):

```
dshDesktop = {
  protocolVersion: 1,
  browser:    { acquire, release, onOpenRequested },   // 侧栏内嵌浏览器租约
  deviceInfo, keyboard:{ closeWindow, subscribe },
  shortcuts:  { get, edit, recording, subscribe },
  updates:    { status, open, subscribe },
}
dshDesktopBoot = { ready, failed }
dshPlatform     = { open, setBounds, close }
__DSH_DIRECTORY_PICKER__.pick / __DSH_HOST_PATHS__.pathFor / __DSH_LOCALE__ / dshOnboarding
```

**没有 `openExternal`**(系统浏览器/tray 只在主进程)。→ 插件现在的 `cmd /c start` 打开系统浏览器
**在桌面端依然可用但不符合桌面体验**;要进应用内面板必须走 `dsh.client` 客户端插件 + `ui-sidebar-browser`。

### 2.5 官方文档确认的平台机制

- **插件 = bundle**:`dsh.bundle.patch` 声明补丁层;`dsh plugin --profile <name> add <pkg>` 装进 profile 并
  自动把 bundle 追加到 `dsh.profile.bundles`。→ 与插件现状**完全一致**,无需改造打包方式。
- **层序**:各 bundle 补丁(按 bundles 顺序)→ profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`
  → 各 `--patch` 覆盖。后层按 row id 覆盖**整块 config**(不是深合并)。
- **`ctx.webServer.register(route)` / `registerUpgrade`**:插件可以自己注册 HTTP 路由/升级路由。
- **`ctx.connection.authenticatedUrl(baseUrl)`**:宿主侧可直接拿到"带本进程 token 的 URL",不必再抓 journal。
- **`ctx.settings`(SettingsForms)**:插件导出 `Config` schema 后,`home`、端口区间等可在
  「设置 → 插件」里编辑,而不是手改 YAML。
- **`profileContext`** = `{name, dir, patchPath, installAnchor, startedBundles, cwd, home, overlays, ...}`,
  在**任何 row 挂载之前**提供(profile-boot 里 `hostCtx.provide("profileContext", ...)`)。
  运行时自己就用它做 desktop-only 门控:`disabled: !!js ctx.get('profileContext')?.name !== 'desktop'`。

### 2.6 服务器基线(UPDATED 2026-10-02 — 已解除阻塞)

> **修正**:先前判定"目标静默丢包、疑为安全组或实例停止"**是错的**。用户随后说明:
> **6104 是租期已到的旧端口,新租的端口是 6204**。以"目标不可达"为结论的那一轮勘查作废,但其中
> 三条产品结论(A7 失败词汇表、A8 指纹校验、手工转发与插件路径不一致)仍然成立。

**新地址实测通过**(密钥登录,BatchMode,只读):

```
192.0.2.10:6204   user=zc    ✅ TCP 可达、SSH 密钥登录可用
hostname = <server-host>
node  v22.23.2            (/usr/bin/node)         ≥ 22.19 ✓
dsh   0.1.5-rc.2          (/home/<user>/.npm-global/bin/dsh)
```

| 项 | 值 | 状态 |
|---|---|---|
| ssh 连通 + 账号 | `zc` @ `<server-host>` | ✅ 实测 |
| Node | v22.23.2 | ✅ 实测 |
| dsh | 0.1.5-rc.2 | ✅ 实测 |
| `~/.dsh` / profile bundles | — | 待查 |
| systemd 单元 / linger | — | 待查 |
| launch URL 形态 / 真实端口 / `?token=` | — | 待查 |
| auth 状态码 / cookie 名 | — | 待查 |
| registry(`/etc/dsh-ports.tsv` vs `~/.dsh-ports.tsv`) | — | 待查 |
| passwordless sudo / 资源余量 | — | 待查 |

**关键提醒**:**远端 dsh = 0.1.5-rc.2,与本地两套运行时(桌面 0.2.0-rc.2 / CLI 0.1.7-rc.1)都不同版本。**
插件 v0.1.12 恰好是对着 0.1.5-rc.2 验证的,所以远端侧的 token 抓取大概率可用;
但"本地验证通过"**不等于**"远端可用",验收必须两端都过。

**同时修正一个我自己下过的错误判断**:本机 `~/.ssh/config` 里的
`LocalForward 3081 127.0.0.1:4380` 与本插件默认远端区间(3080–3119)不一致,我先前推断为"区间被改过"。
复核插件日志(2026-09-18 显示远端端口 3081/3082)后确认:那行是**手工转发遗留**,与插件无关。
→ 应注释掉,统一走插件,避免"手工 `ssh lab` 与插件 `up` 走的不是同一条路"。

---

## 三、问题清单(按严重度)

| # | 问题 | 证据 | 严重度 | 修法 |
|---|---|---|---|---|
| P0-1 | **`webStartup` 存在性判定是竞态**:邻近行提供 + 行并发初始化;判错会让插件走 CLI 分支,`program.help()` 经 `appExit(0)` **退出整个 dsh web / 桌面端** | `src/index.js:28`;`dsh-web-app/lib/startup.js:16,42-47`;`cordis-plugin-loader/src/config/group.ts:56`(`Promise.all`)、`entry.ts:153` | **高** | 改用 `ctx.get("profileContext")?.name`,并把 `webStartup` 退化为兜底 |
| P0-2 | peer 范围 `^0.1.2-alpha.3` **严格 semver 不接受** `0.1.7-rc.1`(prerelease 元组规则);dsh 自身用 `includePrerelease:true` 放行,但 npm/pnpm 会报 UNMET PEER | `package.json:48,51`;`dsh-app-boot/lib/index.js:295-300` | 中 | 改为 `^0.1.2-alpha.3 \|\| ^0.1.7-rc.1`(0.2.0 线再加一段) |
| P0-3 | **桌面端完全没装插件**,且 `web` profile 停在 0.1.9 | `profiles/{desktop,web}/package.json` | 中 | 桌面 profile 加 bundle;web profile 升到同版本 |
| P1-1 | 插件的 ssh 调用**不认代理**。当前新地址可直连,所以**不再是阻塞**;但如果以后换到被墙/受限的地址,没有代理通道就走不通 | 旧地址一轮实测(经 `127.0.0.1:7897` 代理才通);新地址直连可用 | 低(降级) | 可选:`ssh.proxyCommand` / `proxyJump` 配置项 + `check` 提示 |
| P1-4 | **`check` 的失败词汇表缺"网络不可达"这一档**:SYN 被丢弃会挂到超时,现在会被误报成 `dsh not found`,把基础设施故障指成软件缺失 | 子代理实测:3×`Connection timed out`(非 refused);`src/manager.js:676-678` 只判 `reach.code === 0` | 中(排障误导) | 区分 `unreachable (tcp timeout)` / `refused` / `auth failed` 三态,给不同 hint |
| P1-5 | 主机指纹无校验:`~/.ssh/config` 里该别名带 `StrictHostKeyChecking no`;若云主机 IP 被重新分配,插件会**静默连到别人的机器**并往上写 systemd 单元与 token | 用户 `~/.ssh/config`;`src/manager.js` 无指纹校验 | 中(安全) | 写单元/取 token 之前,比对 `known_hosts` 指纹(或至少 `ssh-keyscan` 一次并要求确认) |
| P1-2 | **集成测试在 DSH 沙箱下跑不了**:`node --test` 子进程 `spawn` 被拒(EPERM,32 处) | 本会话实测:unit 14/14 过,integration 0/17 过(2 条路径都试过) | 中(阻塞验收) | 验收需一次 `danger-full-access` 运行;或把 mock 子进程改成非管道 stdio |
| P1-3 | 远程 launch token 仍靠**抓 journal 正则** | `src/manager.js:374-399` | 低 | 宿主侧可用 `connection.authenticatedUrl()`;CLI 侧保留抓取,但建议服务端落一份 launch URL 到状态文件 |
| P2-1 | `dsh-ssh.json` 是**孤儿文件**,本机无任何代码读写它 | 全盘 grep(asar 121MB + 243 包 + bundles + 工作区) | 信息 | 不要基于它设计;但它形如 `~/.ssh/config`,可作为 `hosts` 的导入来源 |
| P2-2 | 两套运行时(0.2.0-rc.2 / 0.1.7-rc.1)并存 | asar vs profiles | 信息 | 插件须在两个面上都自检;peer 分线声明 |

---

## 四、三条技术路线

### 路线 A — 适配修复(必做,先做)

**目标**:插件在 `remote` / `web` / `desktop` 三个 profile、0.1.7-rc.1 与 0.2.0-rc.2 两个运行时上都稳定可跑。
**形态不变**:SSH 隧道 + 服务器上跑 dsh web + 本地 URL(系统浏览器或应用内面板另行决定)。

| 编号 | 动作 | 触及文件 | 规模 |
|---|---|---|---|
| A1 | 模式判定改 `profileContext.name`(whitelist `web`/`desktop` ⇒ service 模式),`webStartup` 仅作兜底 | `src/index.js` | ~15 行 |
| A2 | peer/dev 范围拓宽并分线:`^0.1.2-alpha.3 \|\| ^0.1.7-rc.1`(+ 0.2.0 线) | `package.json` | ~4 行 |
| A3 | 兼容 0.2.0-rc.2:对 `commands` / `profileContext` / `cmdlineArgs` 做一次**存在性 + 形状**自检,缺服务时给出可读错误而不是静默 | `src/index.js`、`src/service.js` | ~40 行 |
| A4 | 三 profile 版本收口:`web` profile 升到与仓库同版本(link 或发版),`desktop` profile 加 bundle | profile 的 `package.json`(仓库外) | 配置 |
| A5 | `ssh` 支持代理:新增 `ssh.proxyCommand` / `proxyJump` 配置,并把 `check` 的失败信息指向"需代理" | `src/config.js`、`src/ssh.js` | ~60 行 |
| A6 | 测试可在沙箱跑:mock 子进程改 `stdio` 传递方式,或在 `npm test` 里给出沙箱提示 | `test/mock-remote/ssh-shim.js` | ~40 行 |
| A7 | `check` 补"网络不可达"档:区分 timeout / refused / auth failed,不再把 SYN 丢弃误报成 `dsh not found` | `src/manager.js`、`src/ssh.js` | ~50 行 |
| A8 | 主机指纹前置校验:写 systemd 单元、取 launch token 之前确认连的是预期主机 | `src/manager.js`、`src/ssh-config.js` | ~60 行 |
| A9 | 文档:README 双语 + lab 指南补"桌面端怎么用"和"代理环境" | `README*.md`、`lab-usage-guide.md` | 文档 |

**产出**:v0.1.13(patch),真机在服务器上跑通 `bootstrap → check → up → status → down`。
**成本**:半天到一天。**风险**:低。

### 路线 B — 把远程会话做成桌面端一等公民(推荐主线)

**目标**:在 DSH 桌面应用里直接开远程会话面板,不再跳系统浏览器;配置可在「设置 → 插件」里改。

| 编号 | 动作 | 依赖的官方能力 | 规模 |
|---|---|---|---|
| B1 | 宿主插件注册路由(如 `/remote-tunnel/status`、`/remote-tunnel/open`),用 `ctx.connection.authenticatedUrl()` 现签本机 URL;`ctx.webServer.register` 实现 | `ctx.webServer`、`ctx.connection` | ~120 行 |
| B2 | 新增**客户端插件半**(`dsh.client`)向侧栏注册「远程主机」面板:列主机/状态、一键 `up`/`down`、一键用 **应用内 `<webview>` 浏览器**打开远程 URL | `dsh.client`、client modules、ui-slots、`ui-sidebar-browser`、`dshDesktop.browser` | ~400 行(新模块) |
| B3 | 导出 `Config` schema,让 `home`/端口区间/主机表在「设置 → 插件」可视化编辑 | `ctx.settings` + schemastery | ~80 行 |
| B4 | **cookie 注入**:桌面端里远程 URL 的鉴权不在同一 authority,需在 B2 的 webview 打开前先完成一次 token→cookie 交换(或由宿主侧代理一层) | `ctx.connection`、`dshDesktop.browser` | ~100 行 |
| B5 | 服务端降级方案:无 systemd/linger 的服务器上改用 `setsid` + 端口文件,去掉对 systemd 的硬依赖 | — | ~150 行 |

**产出**:桌面端 ↑ 侧栏出现「远程主机」;点一下,应用内面板就是服务器上的 dsh。
**成本**:3–6 天(其中 B2/B4 是主要工作量,且**必须先验证** `ui-sidebar-browser` 是否接受插件驱动的 URL 打开)。
**风险**:中。最大未知数是 B2/B4:sidelbar-browser 的接管协议是**客户端**插件面,宿主插件不能直接"打开一个标签页";
需要先做一个**最小验证**(写一个 20 行的客户端插件,试着把任意 URL 推进该面板)。

### 路线 C — 换用官方 SSH 能力族(暂缓,但要挂号)

官方已发布 `@deepseek-ai/dsh-ssh`(+ `dsh-fs-ssh` / `dsh-sandbox-ssh` / `dsh-subprocess-ssh`):
把远程 Linux 主机的**文件系统、子进程、沙箱**直接作为 dsh 的能力后端,理论上比"隧道 + 远程 dsh web"更正统。

**但官方文档明确写了现在的边界,恰好全部命中本场景**:
- "**No Windows endpoint**" —— 而用户的本地端就是 Windows;
- "No automatic provisioning, reconnect or replay" —— 恰好是本插件最花力气的部分(端口登记、TOCTOU、自动重连、心跳);
- "Web workspace UI paths still assume host filesystem access; use headless or a custom composition" ——
  即**用了它就没有现成的 Web UI**,而现在用户要的正是 Web/桌面端;
- 远端还要装匹配版本的 helper 并核对 sha256,且这些包目前只在 0.1.7-rc.1 线发布(桌面 0.2.0-rc.2 上 peer 会被拒)。

**结论**:路线 C 与当前问题**不重叠**,现在做等于换一个更难的目标。挂号条件:官方发布 Windows 端点支持 +
桌面端内置该能力 + 0.2.x 线齐备时,再评估"从隧道方案迁移到官方方案"。

---

## 五、建议的推进顺序

```
第一步(必做,低风险)  路线 A 的 A1 + A2 + A3 + A6  →  发一个 patch,三 profile 都能装
第二步(真机验收)      A5(代理) → 服务器上跑通 bootstrap/check/up/status/down
第三步(价值最大)      路线 B 的 B2 最小验证(20 行客户端插件能否驱动侧栏浏览器)
                      → 验证通过再做 B1 + B3 + B4
第四步(可选)          B5(去 systemd 依赖)
第五步(挂号观察)      路线 C
```

---

## 六、开工前需要拍板的决策

> **已拍板(2026-10-02)**:① 形态 = **路线 B(桌面端应用内面板 + 侧边栏浏览器显示远程 dsh web)**;
> ② 真机 = 新地址 `192.0.2.10:6204`(密钥登录可用)。
> 配套开工书:[`desktop-panel-kickoff-prompt.md`](./desktop-panel-kickoff-prompt.md)。

仍待定:

1. **版本目标**:本轮以 `0.1.7-rc.x`(本机 CLI profile 现状)为准,还是直接对齐 **0.2.0-rc.2**(npm latest、
   桌面 asar 内置)?注意远端仍是 `0.1.5-rc.2`。
2. **沙箱验收例外**:插件集成测试(17 条)在 DSH 沙箱下必然全红(`spawn EPERM`)。最终验收需要一次
   `danger-full-access` 运行 `node --test test/unit.test.js test/integration.test.js`。
   (本会话的文件策略已变为 `danger-full-access`。)

---

## 附:本次勘查中已修的环境问题(需要知会)

本会话开始时,**任何 shell 命令都无法启动**,原因是工作区根目录 `<workspace>` 的 Windows 文件权限
缺少当前用户的有效 `WRITE_OWNER`(DSH 沙箱无法完成工作区授权)。已用官方配套脚本修复(仅给当前用户补一条
完全控制项;备份与回滚命令在 `<用户目录>\len\dsh-acl-reports\`),修复后 shell 恢复正常。

回滚命令(如需要):
```
pwsh -NoProfile -File '<用户目录>\len\dsh-acl-reports\acl-backup-5b778222defc47129c2ef1fff1634b72.json.ps1' -Path '<workspace>' -AllowRoot '<workspace>' -Restore '<用户目录>\len\dsh-acl-reports\acl-backup-5b778222defc47129c2ef1fff1634b72.json'
```

### 安全提醒(高优先)

勘查桌面端数据目录时,`<DSH_HOME>\.credentials.yaml` 被读取,其中**明文密钥**出现在子代理的
工具输出里(DeepSeek API key、RADEON key、`client-connection/browser-session` 的 HMAC 密钥、账号平台 token)。
报告文件里**没有**写入这些值,但**本会话的转录已经包含**。如果这个会话会被分享、导出或长期留存,
建议轮换这四项凭据。
