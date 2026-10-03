# dsh-remote-tunnel — 桌面端面板:进度与验收断点

> 本文件是**断点文档**,给"重启桌面端之后的新会话"用。配套路线书:
> [`desktop-web-refactor-route.md`](./desktop-web-refactor-route.md);勘查结论:
> `G:\remote_ssh_dsh\_recon\desktop-app-report.md`。
> 最后更新:2026-10-03(0.2.1 开发分支 `feat/0.2.1-remote-hosts-panel`;GUI 宿主 / 桌面 runtime = 0.2.0-rc.2;远端 = 0.2.0-rc.2)。

## 0. 目标与验收

在 DSH 桌面应用里用上本插件,点一下就把**远端服务器上的 dsh web** 开进右侧栏「浏览器」面板。

| 编号 | 验收点 | 状态 |
|---|---|---|
| V1 | 桌面端「插件」页出现 `dsh-remote-tunnel`,可开关 | **待闸门 G1(重启桌面端)** |
| V2 | 侧栏「浏览器」显示服务器上的 dsh web(能看到服务器工作区/会话) | ✅ 2026-10-02 手工验收 |
| V3 | 自动过鉴权,不出现 "dsh web authentication required" | ✅ 同上(URL 已被 303 重定向为 `http://127.0.0.1:3081/`,刷新仍正常) |
| V4 | 面板里执行 `hostname` 返回 `being-Super-Server` | ✅ 同上 |

阶段 0 的物理可行性结论:侧栏「浏览器」接受 `http://127.0.0.1:<隧道口>/?token=…`,
桌面端 carrier(`globalThis.dshDesktop.browser`)存在 ⇒ 用真 Electron `<webview>`,不受 X-Frame-Options 限制。

## 1. 已完成(阶段 1a–1d,均已实测)

### 代码改动(仓库内,git 未提交)
| 文件 | 改动 |
|---|---|
| `src/index.js` | 新增 `resolveMode(ctx)`:优先读 `profileContext.name`(`web`/`desktop` ⇒ service 模式),`webStartup` 只作为**单向兜底**(只能升为 service,绝不降为 cli)。修掉 P0-1:判错会走 CLI 分支 → `program.help()` → `appExit(0)` → **把整个桌面/web 宿主进程退掉** |
| `src/service.js` | `commands` 服务缺失时记一条 warn,不再静默 |
| `cordis.patch.yml` | 注释同步为新的判定方式 |
| `package.json` + `package-lock.json` | peer 放宽:`^0.1.2-alpha.3 \|\| ^0.1.7-rc.1 \|\| ^0.2.0-rc.2` |
| `test/unit.test.js` | +3 条 `resolveMode` 测试(web/desktop ⇒ service;remote/headless ⇒ cli;webStartup 只升不降) |

### 安装(profile,仓库外)
| profile | 结果 |
|---|---|
| `profiles/desktop` | ✅ 已装 `dsh-remote-tunnel: link:G:/remote_ssh_dsh/dsh-remote-tunnel`,并已追加到 `dsh.profile.bundles`;投影是 **Junction**(仓库改动即时生效);**无 deny 警告** |
| `profiles/remote` | ✅ 旧投影(0.1.7 时代的**目录副本**,peer 还是旧值)已替换为 Junction;现在用新 PATH 默认的 `dsh`(asar 0.2.0-rc.2 锚点)也能正常跑 |

备份目录:`G:\remote_ssh_dsh\_run\backup-desktop-profile-20261002-160611\`、`…\backup-remote-profile-20261002-160721\`

### 测试
```powershell
cd G:\remote_ssh_dsh\dsh-remote-tunnel
node test/unit.test.js                 # 17/17 ✅
$env:TEMP='G:\remote_ssh_dsh\_tmp'; $env:TMP=$env:TEMP
node test/integration.test.js          # 17/17 ✅(见第 2 节,必须重定向 TEMP)
```

## 2. 这台机器的环境坑(踩过,别再踩)

1. **`node.exe` 只能写工作区**。实测 `D:\App\node.exe` 写 `E:\Applications\**`、`%TEMP%`、`%APPDATA%` 全部 EPERM;
   `cmd`/PowerShell/`DeepSeek Harness.exe`(Electron 当 node 用)不受限。对策:
   - dsh CLI → 用桌面 shim `E:\Applications\dsh\resources\runtime\cli\bin\dsh.cmd`(或 `$env:ELECTRON_RUN_AS_NODE=1` + Electron 跑 `bin.js`);
   - npm → 加 `--cache G:\remote_ssh_dsh\_npmcache`;
   - 集成测试 → `TEMP/TMP` 指向 `G:\remote_ssh_dsh\_tmp`(否则 `mkdtemp` 全红,看着像"沙箱 spawn EPERM",其实是 tmpdir 不可写)。
   - 这也是 PATH 上那份 npm-global `dsh`(C,0.1.7-rc.1)**彻底不能用**的根因,不只是版本错位。
2. **PATH 已默认桌面 shim**:`HKCU\Software\DeepSeekHarness\Command\Directory = E:\Applications\dsh\resources\runtime\cli\bin`,用户 PATH 第一项。新终端里 `dsh` = 0.2.0-rc.2 = GUI 同源。**已开着的终端仍是旧 PATH**。
3. **link: 投影可能是目录副本而不是链接**:老 profile 里是副本,改仓库不生效(表现为 `dsh: skipping profile bundle ... peerDependencies`)。刷新办法:重装,或把投影删掉换成 Junction(`cmd /c mklink /J`)。仓库改动**不会**自动同步到副本。
4. **`up` 常驻期间其他 CLI 子命令可能长时间无响应**(实测 `status`;原因待查)。`hosts`/`check` 正常。排障时优先用 `hosts`。

## 3. 闸门 G1(下一步,需要重启桌面端)

**重启会让当前会话中断** —— 这正是本文档存在的原因。

1. 完全退出 DSH 桌面应用(托盘也要退),再启动。
2. 打开左侧「插件」页 → 「已安装」里应出现 **`dsh-remote-tunnel`**(Remote Host Tunnel Manager),开关可切换。
3. 侧栏「浏览器」打开远端 dsh web 仍然正常(隧道若已断,先 `dsh --profile remote up XDU-zc`)。
4. 若插件页**没有**出现或显示 deny:看桌面端日志里有没有 `skipping profile bundle "dsh-remote-tunnel"`;
   有的话说明投影/peer 没同步(见第 2 节第 3 条)。
5. **点火(阶段 2b)**:启动后几秒内,右侧栏应**自动**弹出一个「浏览器」标签,里面是远端 dsh web。
   浏览器半会在加载后调 `GET /remote-tunnel/open` 拿 `authUrl`,再 `ctx.sidebarRight.openTab("browser", …)`;
   开机时侧栏 store 可能还没建立,所以它会每 2 秒重试,最多 10 次,最后在控制台留一条
   `[remote-tunnel] panel ignition gave up: …`。若没弹出,请把这条 console 警告告诉我(或看 Panel 是否已有 tab)。
6. 点火成功后,原来的验收 V2/V3/V4 就在"由插件自动完成"的路径上重跑一遍(hostname = `being-Super-Server`)。
7. 手动兜底:浏览器控制台里 `__dshRemoteTunnel.openPanel()` 可以直接开面板(调试用)。

### 回滚
```powershell
$dsh = 'E:\Applications\dsh\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop remove dsh-remote-tunnel
# 或还原备份:
Copy-Item 'G:\remote_ssh_dsh\_run\backup-desktop-profile-20261002-160611\package.json' 'E:\Applications\dsh-data\profiles\desktop\package.json' -Force
Copy-Item 'G:\remote_ssh_dsh\_run\backup-desktop-profile-20261002-160611\pnpm-lock.yaml' 'E:\Applications\dsh-data\profiles\desktop\pnpm-lock.yaml' -Force
```

## 4. 后续阶段(路线书 + 用户新增需求)

- **阶段 2**:宿主半注册 `/remote-tunnel/*` 路由;**客户端半**(`dsh.client`,`platform:"web"`)调
  `ctx.sidebarRight.openTab("browser", { params: { url: authUrl } })`。先用 20 行最小客户端插件点火契约。
  **用户新增**:打开时给两个选项 ——「在浏览器打开」(现有 `cmd /c start` 路径)与「在侧栏打开」;配置 `openIn: ask|browser|panel`。
- **阶段 3**:Config schema(home/端口区间/主机表/openIn)进「设置 → 插件」;侧栏「远程主机」面板(列表/状态/up·down/两个打开按钮);双语 README。
- **阶段 4(用户已拍板)**:发 **0.2.0**,走 GitHub Actions(打 `v0.2.0` tag → `publish.yml` → npm publish),
  目标是让任何人在「插件 → 添加插件」里输入 `dsh-remote-tunnel` 就能装上。打包要求:`exports["./client"]` + `files` 补客户端文件,
  客户端半**保持纯 ESM、无构建步骤**(这样包名 / GitHub 地址 / 本地目录三种输入都能装)。

## 5. 现状快照(2026-10-02 16:0x)

- 隧道:`http://127.0.0.1:3081` → 服务器 `127.0.0.1:3080`(unit `dsh-web`,`up` 常驻进程存活,ssh pid 12476)。
- auth URL(一次性 token,进程内有效;断了用 `dsh --profile remote logs XDU-zc` 重新取):
  `http://127.0.0.1:3081/?token=…`(见 `E:\Applications\dsh-data\remote-tunnel\state\XDU-zc.json`)。
- 桌面 profile 里另有 4 个 `0.1.7-rc.2` 插件被 0.2.0-rc.2 运行时 deny(browser-use / computer-use ×2),
  属既有问题,与本任务无关;要修就在「插件」页重装 0.2.0 线版本。


## 6. 阶段 2 进展(2026-10-02 下午,已完成 2a/2b 代码 + 服务端验证)

### 新增文件
| 文件 | 作用 |
|---|---|
| `src/web.js` | 宿主 HTTP 路由:`/remote-tunnel/{state,open,up,down}`。注册在 `ctx.webServer` 上,`kind:"prefix"`、`path:"/remote-tunnel"` |
| `src/client.js` | **浏览器半**,按客户端模块系统的 bundle 格式手写(`window.__ModuleLoader__.load({id,factory})`),**不需要构建步骤**;`inject:["sidebarRight"]` |

### 改动的文件
- `src/index.js`:service 模式只创建一个 `TunnelManager`,由 `/remote` 斜杠命令与 HTTP 路由共享;
  服务就绪改用 `ctx.inject(["commands"|"webServer"], …)`(**原来的 `ctx.get` 会和"提供服务的行"并发竞争**)。
- `src/service.js`:`registerSlashCommands(ctx, manager)` 改为接收共享 manager。
- `package.json`:`exports["./client"]` + `dsh.client = { platform: "web" }`。

### 已实测(隔离 DSH_HOME 起 web profile,与桌面端同一 0.2.0-rc.2 运行时)
- row 以 service 模式挂载,`commands` 与 `webServer` 都就绪;
- `GET /remote-tunnel/state` / `/open?host=XDU-zc` → 200,返回真实 `authUrl`;未知 action → 404;未知主机 → 409;
- index 的 boot graph 里已包含 `dsh-remote-tunnel/client.js`,`/plugins/??dsh-remote-tunnel/client.js&rev=…` 原样返回手写 bundle。

### 坑(重要)
webserver 的 prefix 匹配是 `path === P || path.startsWith(P + "/")`,
**注册的 prefix 不能带结尾斜杠** —— 一开始注册成 `/remote-tunnel/`,结果 `/remote-tunnel/state` 不匹配,全部 404。

### 还没做的(阶段 2c / 3)
- 点火目前是"加载即自动开一次";要改成**用户手势 + 双模式**(「在浏览器打开」/「在侧栏打开」,`openIn: ask|browser|panel`)。
- 侧栏「远程主机」面板(列表/状态/up·down)、Config schema、双语文档。

## 7. 新会话开工 prompt(复制粘贴给重启后的新会话)

```text
项目:G:\remote_ssh_dsh\dsh-remote-tunnel(dsh 插件,目标是让远端 dsh web 显示在桌面端右侧栏「浏览器」面板里)。

先读这两份文档,不要重新逆向 app.asar:
- docs/desktop-panel-progress.md(断点 / 验收矩阵 / 本机环境坑 / 回滚,最重要)
- docs/desktop-web-refactor-route.md(技术路线书)

已完成:
- 阶段 0:侧栏「浏览器」手工验收 V2/V3/V4 通过(远端 hostname = being-Super-Server)。
- 阶段 1 → 提交 43c1025:resolveMode 改用 profileContext 判模式(修 P0-1,避免误退宿主进程)、
  peer 放宽覆盖 0.1.7-rc/0.2.0-rc 两线、插件已装进 profiles/desktop(link junction + bundles)。
- 阶段 2a/2b → 提交 71c6212:宿主路由 /remote-tunnel/{state,open,up,down} 与
  手写浏览器半 bundle(src/client.js,window.__ModuleLoader__.load 格式,无构建步骤)。

待做:
- 阶段 2c:把"加载即自动开面板"改成用户手势 + 双模式(openIn: ask|browser|panel,
  「在浏览器打开」/「在侧栏打开」)。
- 阶段 3:导出 Config schema(home/端口区间/主机表/openIn)、侧栏「远程主机」面板
  (列表/状态/一键 up·down/两个打开按钮)、双语 README + lab 指南。
- 阶段 4:发 0.2.0 —— 打 v0.2.0 tag → GitHub Actions(publish.yml)自动 npm publish,
  目标是任何人在 GUI「插件 → 添加插件」里输入 dsh-remote-tunnel 就能装上。

本机环境(必须遵守):
- node.exe 只能写工作区 G:\remote_ssh_dsh:dsh CLI 一律用桌面 shim
  E:\Applications\dsh\resources\runtime\cli\bin\dsh.cmd(或 ELECTRON_RUN_AS_NODE=1 +
  "E:\Applications\dsh\DeepSeek Harness.exe" <bin.js>);npm 要 --cache G:\remote_ssh_dsh\_npmcache;
  跑集成测试前先 $env:TEMP='G:\remote_ssh_dsh\_tmp'、$env:TMP 同值(否则 mkdtemp EPERM)。
- 服务器 XDU-zc = 82.157.182.71:6204(user zc,密钥登录),远端 dsh 0.2.0-rc.2;
  插件 up 后隧道 127.0.0.1:3081 → 远端 127.0.0.1:3080。远端写操作必须 flock + mktemp + cat >(禁用 mv)。
- 桌面端是 Electron 壳,GUI 固定 127.0.0.1:19387,渲染器 origin 是 dsh-app://app/;
  改 profile 必须重启桌面端才生效,重启会中断会话 —— 所以每步都要写进 docs/desktop-panel-progress.md。
- 侧栏面板只能由客户端插件打开:ctx.sidebarRight.openTab("browser", { params: { url } })。
- webserver 的 prefix 路由不能带结尾斜杠(path === P || path.startsWith(P + "/"))。
- 不要动 npm-global 那份 dsh(0.1.7-rc.1,已弃用);不要基于 dsh-ssh.json 设计;
  不要打印 E:\Applications\dsh-data\.credentials.yaml 的内容。

我这轮 G1 + 点火验收的结果:(把结果贴在这里)

请从"验收结果 → 阶段 2c"继续。
```

### 7.1 新会话快速自检(不改动 GUI)

```powershell
# 1) 隧道是否在跑
Get-NetTCPConnection -State Listen -LocalPort 3081 -ErrorAction SilentlyContinue | Select LocalPort,OwningProcess
Get-Content 'E:\Applications\dsh-data\remote-tunnel\state\XDU-zc.json' -Raw

# 2) 插件是否已装进 desktop profile 且未被 deny
& 'E:\Applications\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop list

# 3) 隔离 DSH_HOME 起一个 web profile 复现宿主侧行为(不动用户正在用的 GUI)
#    它的 profiles/web/cordis.patch.yml 里已把 row 的 home 指到真实 remote-tunnel 目录
& 'E:\Applications\dsh\resources\runtime\cli\bin\dsh.cmd' --profile web --no-open --port 19399
#    (需要 DSH_HOME=G:\remote_ssh_dsh\_smoke\dsh-home;起来后用 index 里的 ?token= 换 cookie,
#     再 GET /remote-tunnel/state 与 /remote-tunnel/open?host=XDU-zc)

# 4) 测试
cd G:\remote_ssh_dsh\dsh-remote-tunnel
node test/unit.test.js
$env:TEMP='G:\remote_ssh_dsh\_tmp'; $env:TMP=$env:TEMP; node test/integration.test.js
```


## 8. 阶段 2c 完成(2026-10-02 傍晚,提交见 git log)

- **命令卡片**:客户端半注册 `conversation.chat.commandview`(key = `remote`),
  每个 `/remote ...` 的命令节点都渲染成我们的卡片:命令与参数 / 结果文本 /
  隧道状态 / 「在浏览器打开」「在侧栏打开」「启动隧道」「刷新」四个动作。
  通用卡片 `GenericCommandCard` 只会显示一行摘要,而且单行文本连展开体都没有 ——
  这就是此前"命令没有输出"的观感来源(结果其实早就写进 session log 了)。
- **双模式**:`open?mode=browser` 由宿主 `manager.open()` 打开系统浏览器(和 CLI 同一条路);
  `open?mode=panel` 返回 authUrl,客户端 `ctx.sidebarRight.openTab("browser", {params:{url}})`。
- **配置**:row 配置新增 `openIn`(ask|browser|panel,默认 ask)与 `autoOpen`(默认 false)。
  **默认不再开机自动弹面板**;想恢复就在 profile 的 cordis.patch.yml 里给 row 加 `autoOpen: true`
  (阶段 3 会做成「设置 → 插件」里的可视化开关)。
- **路由**:新增 `/remote-tunnel/status`(config + hosts + tunnels + 客户端黑匣子);
  `open` 支持 `mode`;`state` 保留为 status 的别名。
- 实测(隔离 DSH_HOME 的 web profile):status 返回 config/hosts/tunnels;
  `open?mode=panel` 返回 authUrl;boot graph 含 `dsh-remote-tunnel/client.js`,
  服务端返回的 bundle 里能看到 commandview 注册与中文按钮。

### 8.1 重启后的验收清单(2c)
1. 插件页:标题仍是「远程隧道 (dsh-remote-tunnel)」;
2. 启动后**不再自动弹面板**(默认 autoOpen=false);
3. 发 `/remote hosts` → 对话里出现**卡片**(命令 + 结果文本 + 隧道状态 + 四个按钮);
4. 点「在侧栏打开」→ 右侧栏出现远端 dsh web;点「在浏览器打开」→ 系统浏览器打开同一 URL;
5. 面板里发「执行 hostname 命令,把原始输出返回给我」→ `being-Super-Server`(V4)。


## 9. 验收通过(2026-10-02 17:25)

| 编号 | 验收点 | 结果 |
|---|---|---|
| V1 | 桌面端「插件」页出现插件、可开关、中文标题 | ✅「远程隧道 (dsh-remote-tunnel)」+ 中文描述(刷新即生效,无需重启) |
| V2 | 侧栏「浏览器」显示服务器上的 dsh web | ✅ 由卡片「在侧栏打开」打开;面板里能看到服务器工作区/会话 |
| V3 | 自动过鉴权,不出现 authentication required | ✅(token → 303 → cookie,面板刷新仍正常) |
| V4 | 面板里执行 hostname 返回 being-Super-Server | ✅ 17:25 实测 |

黑匣子(/remote-tunnel/status 的 client.events)同期记录:
```
loaded → service sidebarRight → view conversation.chat.commandview#remote
→ idle "autoOpen is off" → command "hosts" → command-ok "XDU-zc 82.157.182.71:6204 [ssh-config]"
```

已知的两个"看起来像 bug 其实不是"的点,记下来免得重复排查:
- **输入法预编辑文本是蓝色的**:那是 composer 对 IME 未上屏文本的着色,属于外壳行为,与本插件无关;
- **卡片右上角「完成 / done」不可点**:它是**状态标签**(running / 失败 / 完成),不是按钮。
  阶段 3a 会把它改成更明显的标签样式(圆点 + 淡色),避免误认为可点。

## 10. 阶段 3 / 4 计划(2026-10-02 更新)

### 阶段 3(体验收口)
| 编号 | 内容 | 备注 |
|---|---|---|
| 3a | 卡片打磨:状态改标签样式;新增「**断开连接 / down**」(两步确认);up/down 后状态即时刷新;多主机时可选择主机 | 宿主侧 `/remote-tunnel/down` 已存在,只差 UI |
| 3b | `Config` schema → 「设置 → 插件」:home、端口区间、主机表、`openIn`、`autoOpen` | |
| 3c | (可选,待定)侧栏「远程主机」独立面板:需要新注册一个 sidebar tab kind | 卡片已覆盖大部分需求,建议后置 |
| 3d | 双语 README:桌面面板 / 双模式 / GUI「添加插件」安装 / 排障;lab 指南更新;清理失效地址 | |
| 3e | 安全小项:`/remote-tunnel/*` 目前不校验来源(loopback 上任何进程都能读到含 token 的 URL),计划要求携带会话 cookie 或收紧字段 | |

### 阶段 4(发版 0.2.0)
1. 打包自检(`exports`/`files`/locale/client 半)→ `npm pack` 在临时目录验证;
2. 版本号 0.2.0 + CHANGELOG + `.github/releases/v0.2.0.md`(中英);
3. 打 `v0.2.0` tag → GitHub Actions(`publish.yml`)→ npm publish;
4. 端到端验收:卸载开发期的 link 安装 → GUI「添加插件」输入 `dsh-remote-tunnel` → 装上即中文、卡片可用、面板可开、`hostname` = being-Super-Server。


## 11. 阶段 3a 完成 —— 卡片打磨(2026-10-02 傍晚)

- **状态改成标签**:小圆点(绿=完成 / 红=失败 / 灰=执行中)+ 淡色文字 + title,
  不再是看起来可点的东西;
- **新增「断开连接 / down」**:两步确认 —— 第一次点变成「确认断开?」,再点才执行;
  5 秒不动自动取消,并有一行说明"会停止隧道、停掉服务器上的 dsh-web 并释放端口";
- **up/down 后即时刷新**:有隧道时显示「断开连接」、没有时显示「启动隧道 / up」,按钮随状态切换;
- **多主机**时出现主机下拉框,所有动作作用于所选主机;
- **新增客户端 bundle 自动化测试**(test/unit.test.js):用假的 module loader + React 桩,
  渲染卡片两次(状态接口返回前后),断言两种打开模式、断开按钮、状态标签都在。
  这样客户端逻辑**不用重启就能回归验证** —— 以前只能靠手工重启。

测试:unit **19/19**(含 2 条新的客户端 bundle 用例);integration **17/17**(TEMP 重定向)。

### 11.1 重启后的验收清单(3a)
1. `/remote hosts` → 卡片右上角变成「● 完成 / done」(圆点+淡色,不再是灰块);
2. 点「**断开连接 / down**」→ 变成「确认断开?」+ 一行警告 → 再点一次 → 隧道停止,
   卡片刷新成"当前没有隧道在跑"并出现「启动隧道 / up」;
3. 点「**启动隧道 / up**」→ 重新拉起(端口可能变化,旧的浏览器面板标签需要重新打开);
4. 「在侧栏打开」「在浏览器打开」照旧。


## 12. 阶段 3a.1 完成 —— composer 状态条(常驻入口,2026-10-02 傍晚)

**解决的坑**:空会话里"看不到 /remote 的结果"。
会话视图在**没有模型历史**时渲染欢迎页,命令生命周期(command/run|done)不属于模型历史,
所以那次 /remote 的卡片要等第一轮对话之后才出现 —— 命令其实早就成功执行了。

**做法**:在 **`conversation.composer.dock`**(输入框上方、第一方 StatsPills 同一个座位,
空会话也渲染)注册一条常驻状态条:

- 有隧道:`● 远程隧道 / remote tunnel  XDU-zc · http://127.0.0.1:3081` +
  「在侧栏打开」「在浏览器打开」「断开」;
- 没有隧道:`未连接 / not connected`(或没有主机时 `未配置主机 / no host`)+ 「启动隧道 / up」;
- 每 15 秒轮询一次 `/remote-tunnel/status`,动作完成后立即刷新;
- 配置 **`dock: true|false`(默认 true)** 可整条隐藏;
- 好处:新会话里**零命令**就能开面板;会话再多也不用去历史里翻卡片。

**同批改动**:`/remote-tunnel/status` 的 config 增加 `dock`;row 配置新增 `dock`(默认 true);
客户端卡片的取状态逻辑抽成 `useTunnelStatus()`,卡片与状态条共用。

**测试**:unit **20/20**(新增第 3 条客户端用例:状态条渲染 + `dock:false` 时整条消失;
并且修了测试 React 桩的一个真问题 —— 不执行 effect cleanup 会让 setInterval 把测试进程挂住);
冒烟:status 返回 `{"openIn":"ask","autoOpen":false,"dock":true}`,boot graph 含我们的 bundle,
服务端返回的 19,980 字节 bundle 内含 `conversation.composer.dock` 与状态条文案。

### 12.1 重启后的验收清单(3a.1)
1. **新建一个空会话**(不要发任何消息)→ 输入框上方应出现 `● 远程隧道 / remote tunnel  XDU-zc · http://127.0.0.1:3081` +
   三个按钮;点「在侧栏打开」应能打开远端 dsh web(**这一条就是本次修复的核心**);
2. 点「断开」→ 状态条变成 `未连接` + 「启动隧道 / up」;再点「启动隧道」→ 恢复;
3. 把 row 配置加 `dock: false` → 状态条整条消失(阶段 3b 会做成设置页开关);
4. 卡片(命令节点)行为不变:第一轮对话后出现,状态标签/断开两步确认照旧。


## 13. 阶段 3b 完成 —— 配置进「设置 → 插件」(2026-10-02 傍晚)

**交付**:插件导出 schemastery `Config`,四个字段成为 row 配置,可在「设置 → 插件」里编辑:

| 字段 | 默认 | 含义 |
|---|---|---|
| `home` | `$DSH_HOME/remote-tunnel` | 插件状态目录(隧道状态/日志/config.yaml) |
| `openIn` | `ask` | 打开方式偏好:ask / browser / panel |
| `autoOpen` | `false` | 启动时是否自动把远端 dsh web 开进侧栏 |
| `dock` | `true` | 是否显示输入框上方的「远程隧道」状态条 |

同时:插件自带的 row patch **显式写出全部四个键**(profile 层只能覆盖 row 里已有的键);
默认值改由 `readSettings()` 在代码里兜底。

### 13.1 ⚠️ 重要发现:schema 里用 `.default()` 会让 row 配置丢失

在 dsh 0.2.0-rc.2 上实测(隔离 profile,profile patch 写 `openIn: panel`、`dock: false`):

| Config schema 写法 | `apply` 实际收到的 row 配置 |
|---|---|
| 每个字段带 `.default(...)` | `{"home":"…","openIn":{},"autoOpen":{},"dock":{}}` ← **配置值变成未解析的 schema 对象** |
| 纯类型(无 default) | `{"home":"…","openIn":"panel","autoOpen":true,"dock":false}` ✅ |

所以本插件**刻意不用 `.default()`**,默认值放在代码里 —— 代码里有注释说明原因,免得以后有人"顺手补上默认值"又把它弄坏。
(诊断入口:`/remote-tunnel/status` 的 `client.events` 里有每次启动的 `row-config` 原文,排查"设置不生效"时直接读它。)

### 13.2 3b 验收清单(需要看 GUI)
1. **设置 → 插件** 里找到 `dsh-remote-tunnel`(远程隧道),展开看是否有这四个字段的表单;
2. 改 `dock` 为 false → 保存 → 输入框上方的状态条应消失(可能要重启,取决于该表单是"立即生效"还是"重挂载");
3. 改 `openIn` / `autoOpen` 同理;
4. 若表单**没有出现**:可能是该版本的设置页只为部分字段(如 `.volatile()` 标记的)生成表单,告诉我,我再按运行时的表单规则调整;
5. 命令行侧自查(不需要 GUI):
   ```powershell
   (Invoke-RestMethod http://127.0.0.1:19387/remote-tunnel/status).client.events | Where-Object event -eq 'row-config'
   ```
   应能看到当前生效的 row 配置原文。


## 14. 更正:状态条在"全新会话"里不会显示(2026-10-02 18:35)

3a.1 的验收清单写错了。读了输入栏实现之后确认:

```js
// @deepseek-ai/dsh-client-ui-conversation 的 InputBar
children: [ variant === "composer" && input !== void 0 && sessionId !== void 0
              ? renderSlot("conversation.composer.dock", {}) : null, … ]
```

`conversation.composer.dock` **只在会话已有内容(variant === "composer")且已有输入边界时渲染**;
全新会话走的是 `variant === "hero"`(居中输入框 + 探索未至之境),那一支不渲染这个座位。
输入栏里其它座位(`…input.activity/left/right/model`)同样要求 `input !== undefined`;
`conversation.input.overlay` 只要求 sessionId,但它的 CSS 是 `height:0; position:absolute`(弹层锚点),不适合放普通行。

**因此现状(0.2.0 接受)**:会话里只要有过内容 → 状态条出现;纯新会话里插件没有可见入口。
**根治留给 0.2.1 的侧栏「远程主机」面板(3c)** —— 侧栏标签条/指南在任何会话状态下都可点。
(用户 2026-10-02 拍板:采用方案 A。)

顺带记录:配置表单要去 **设置(左下角齿轮)→ 插件** 看,不是「插件」页的清单卡片;
我们的 Config 已通过运行时的原生 schema 检查(brand/type/meta 三项),应当会生成表单。


## 15. 阶段 3e 完成 —— 路由准入校验(2026-10-02 傍晚)

**问题**:之前 `/remote-tunnel/*` 不校验来源,loopback 上任何本地进程 `GET /remote-tunnel/status`
就能读到**带一次性 launch token 的 URL**(实测:无 cookie 也返回 200)。

**做法**:用运行时自己的准入入口 `ctx.connection.admit(request)` —— 与 `/api` 通道**同一套**检查:

```js
const admission = connection.admit(req);            // { rejection: 401|403 } | { peer }
if ("rejection" in admission) { res.writeHead(admission.rejection); res.end(); return; }
```

- `requestRejection()` = `isTrustedApiRequest()`(Host 必须 loopback/trusted、Origin 必须等于 Host、
  `sec-fetch-site: cross-site` 直接 403)+ `browserAuth.isAuthenticated()`(签名 cookie 校验)→ 403 / 401;
- Connection 服务可能晚于本行挂载,所以**按请求惰性解析**(注册时抓一次会永远拿不到);
- 新增配置 `auth`(默认 true):确实无法携带 cookie 的载体可以 `auth: false` 关闭(逃生门,README 标注不推荐);
- 被拒请求会记进黑匣子(`rejected 401 status`),排查「面板打不开」时直接看。

**实测**(隔离 web profile,两次启动对照):

| 配置 | 匿名 `/remote-tunnel/status` | 带 GUI cookie |
|---|---|---|
| 默认(`auth` 未设 → true) | **401** | **200**(config/tunnels 正常) |
| `auth: false` | 200(逃生门生效) | 200 |

**重启后要验的**:卡片、状态条、面板三条路径都必须照常工作(它们从页面上下文发起、由桌面壳转发并注入 cookie,
预期能通过 `admit`)。若某条路径报 401:把 row 配置里 `auth` 设成 `false` 可临时恢复,
并把现象告诉我(说明该载体的转发没带 cookie,我再改成「短时一次性句柄」方案)。

**附带**:3a 验收时点过「断开连接 / down」,本地隧道状态已清空、3081 已释放(预期行为);
下次要用面板时,在卡片或状态条上点「启动隧道 / up」即可(端口可能变化)。

## 16. 阶段 4c 完成 —— 0.2.0 已发布(2026-10-02 19:08 本地)

| 项 | 结果 |
|---|---|
| push | `main` `52036da..e3d25a0` ✓(15 个提交) |
| tag | `v0.2.0`(annotated)已推送,触发 `publish.yml` 与 `CI` |
| GitHub Actions | Publish to npm:所有步骤 success(checkout → setup-node → npm ci → test → publish → 贴发布说明) |
| GitHub Release | 已创建 `dsh v0.2.0`,正文为 `.github/releases/v0.2.0.md`(中英) |
| npm | `dsh-remote-tunnel@0.2.0` 上线,`dist-tags.latest = 0.2.0`,shasum `9951e004…`(与 CI 输出一致) |

**过程记录(下次别慌)**:publish 日志里 npm 会回一句
"Your package is being processed and may take a few minutes to become available."
所以发布后头 1 分钟查 registry 仍是旧版本(直查 /dsh-remote-tunnel/0.2.0 甚至 404),约 1 分钟后才可见。

**发布包自检**(直接拉 registry 上的 tarball 核对,33 个文件):
locale/{en,zh}.json ✓、src/client.js ✓、src/web.js ✓、src/probe.js ✓、cordis.patch.yml ✓、CHANGELOG.md ✓、README.zh.md ✓;
package.json:version 0.2.0、dsh.client.platform=web、exports["./client"]、exports["./locale/*.json"]、peer 两条线 + schemastery ✓。

## 17. 阶段 4d 验收步骤(用户操作:GUI 装 npm 版)

1. 「插件」页找到「远程隧道 (dsh-remote-tunnel)」→ **卸载**(清掉开发期的 link 安装);
   命令行等价:dsh plugin --profile desktop remove dsh-remote-tunnel(用桌面 shim);
2. **彻底退出并重启**桌面应用(让 profile 重新组合);
3. 「插件」页 →「添加插件」→ 输入 dsh-remote-tunnel → 安装;
4. **再重启一次**桌面应用;
5. 验收:插件页中文标题/描述(0.2.0);发 /remote hosts 出卡片;输入框上方状态条;「在侧栏打开」出远端 dsh web;
   面板里 hostname = being-Super-Server;
6. 回滚:卸载后再 dsh plugin --profile desktop add <本仓库目录> 即回到开发期 link 安装。

> 注意:一旦 GUI 从 npm 装的是**真实副本**(不是 junction),仓库里的改动**不再对桌面端生效**;
> 开始 0.2.1(侧栏「远程主机」面板)开发时,需要先把 link 安装加回来。


## 18. 0.2.1 阶段 0 —— 分支、基线、bundle 热更新预研(2026-10-03)

**分支**:`feat/0.2.1-remote-hosts-panel`(从 main@0958dc2 建;`.git` 就在工作区,分支不占 C 盘)。
用户拍板:分支上开发 → 真机验收 → 通过后 `merge --ff-only` 回 main → 打 tag 发版。

**基线双绿**:unit **21/21**;integration **17/17**(必须先 `$env:TEMP=G:\remote_ssh_dsh\_tmp`/`TMP` 同值)。

**安装形态复核**(计划 §3 要求"先确认 link 还是副本"):desktop 与 `_smoke\dsh-home\profiles\web` 两个 profile 都是
**Junction → 仓库**;桌面端进程启动于 10/3 11:32/11:41,**晚于** Junction 创建时间(10/2 16:06)⇒ 用户当前 GUI 跑的就是仓库代码,
不需要再跑 `plugin add`。旁证:`/remote-tunnel/not-an-action` → **401**(我们的 admit 先生效)、`/zzz-not-mounted-xyz` → 404
⇒ 插件此刻在 GUI 里是活的。

**⚠️ 关键坑(本轮最重要的发现):client bundle 的 rev 来自文件 stat,改了文件就必须重启宿主**

- 源码证据 `@deepseek-ai/dsh-client-modules/lib/index.js:192-199`:
  `artifactRevision = sha1(mtimeMs + ctimeMs + size)`(12 位 hex);`:158` 注释
  "Versioned code is immutable; mismatched revisions are rejected instead of serving newer bytes";
  bundle URL 形如 `/plugins/??dsh-remote-tunnel/client.js&rev=<12hex>`(`:203-209`)。
- 隔离 web profile(19399)实测四步:
  1. 原状 `rev=a8aaddac3e23` → **200**(len 19980);
  2. 只在 client.js 头部注释加一个 marker(内容变了)→ **同一个 rev 立即 404**;
  3. **把文件 byte 复原后(md5 与改动前一致),同一个 rev 仍 404** ⇒ 不是内容哈希,ctime 参与且不可复原;
  4. 杀掉宿主重启 → 发布新 rev `831d5e9044c9` → **200**,len 仍 19980。
- 结论:**任何一次 `src/client.js` 改动(包括 `git checkout` 切分支/回滚)都会让运行中宿主的旧 rev 永久 404,
  只能重启宿主重新发布。** 因此:
  - 真机验收**必须彻底重启桌面端**,不能只刷新页面 —— 计划里"改 profile 才需重启"要修正为"**改 client bundle 就需要重启**";
  - 开发期每改一次 client.js,隔离 profile 也要重启一次再冒烟(否则看到的是 404,容易误判成代码问题)。
- 副作用告知:阶段 0 的预研 marker 已改过一次 client.js 的 mtime/ctime(内容已 byte 复原,git diff 干净)。
  **用户当前 GUI 的插件客户端半在重启前加载不到**(已加载的页面不受影响,只是别刷新);下次重启自动恢复。

**冒烟环境备查**(隔离 home,patch 里 `auth:false` 便于匿名请求):

```powershell
$env:DSH_HOME='G:\remote_ssh_dsh\_smoke\dsh-home'
& 'E:\Applications\dsh\resources\runtime\cli\bin\dsh.cmd' --profile web --no-open --port 19399
# 取 bundle 路由(含 rev):GET / 的 index 里搜 'dsh-remote-tunnel/client.js&rev='
# 停:job_kill 只杀 pwsh 包装进程 —— 必须找到监听 19399 的 PID 再 Stop-Process
Get-NetTCPConnection -State Listen -LocalPort 19399 | Select-Object OwningProcess
```

**下一步**:阶段 1(3c-1)—— 注册 tab 类型 `remote-hosts` + 指南页入口 + 单测。


## 19. 0.2.1 阶段 1+2 完成 —— 侧栏 tab 类型 + 面板本体(2026-10-03)

**交付**(只动 `src/client.js`,409 → 584 行;仍是手写 bundle、无构建步骤):

- **tab 类型(3c-1)**:`hostsDefinition()` → `{ id: "dsh-remote-tunnel/hosts", kind: "remote-hosts", title, guide: [{ id: "hosts", order: 50, title, description }] }`。
  页面型 tab **不给 `patterns`**(按官方 README:页面型靠 kind 打开);`title`/`description` 用**函数**,与 shipped 的 files/browser 写法一致
  (指南页渲染时解析)。
- **注册生命周期(容易踩死的地方)**:照官方"活证据" `ui-sidebar-documentpreview` 的写法 ——
  `ctx.effect(() => ctx.sidebarRightTabs.register(def), "label")`。`register()` 内部把注册挂在自己的 ctx.effect 上并**返回 disposer**;
  源码注释明说 caller 必须把 disposer 放进**自己的** ctx.effect(`ui-sidebar-right/lib/client.js:8677-8712`),否则插件行卸载/重挂时
  第二次注册同一 id 会抛 `tab type id "…" is already registered`。服务缺失仍走既有 `whenService` 惰性解析(不抛)。
- **面板本体(3c-2)**:`slots.inject("sidebar.right.pane.tab", () => slots.register({ name, key: TAB_ID }, HostsPanel))`;
  `HostsPanel(props)` 用 `props.useTabInfo()` 读 `tab.navigation.params`(支持 `params.host`),复用 `useTunnelStatus()`/`callHost`/`openPanel`;
  内容 = 标题 + 连接状态标签、多主机下拉(>1 台才出现)、隧道行、五个动作(启动隧道 / 断开两步确认 / 在侧栏打开 / 在浏览器打开 / 刷新)、空态提示。
  **多主机口径**:面板展示的是"所选主机"的隧道(`tunnels.find(t => t.alias === alias)`),不是 0.2.0 卡片那种 `tunnels[0]`。

**测试**:unit **24/24**(新增 3 条:tab 类型 + 指南条目 + disposer 归属;面板"已连接"渲染两种打开方式与断开两步;面板"未连接"给 up 且尊重 `params.host`)。

**冒烟**(隔离 web profile 19399,重启宿主重新发布后):`rev=3be58b082986`,bundle **200 / 28809 字节**(0.2.0 时 19980);
内容含 `sidebar.right.pane.tab`、`"remote-hosts"`、`dsh-remote-tunnel/hosts` 与指南描述;`/remote-tunnel/status` → 200。
**纪律**:每改一次 client.js 都要重启宿主才能冒烟(§18 的 rev 机制)——本轮照做,否则看到的会是 404。

**还没做**:3c-3a(`known_hosts` 只读发现)、3c-3b(`hosts add/remove` 写路由 + 面板候选/增删 UI)、README/截图、发版。


## 20. 0.2.1 阶段 3+4 完成 —— ~/.ssh 主机发现 + 主机增删(2026-10-03)

**口径(用户拍板)**:侧栏自动列出"本地连接过的主机",并能在面板里增删;`~/.ssh` **只读**,写盘只写插件自己的 `config.yaml`。

**宿主半(5 个文件)**

| 文件 | 改动 |
|---|---|
| `src/ssh-config.js` | 新增 `knownHostsPath()` / `parseKnownHosts()` / `readKnownHosts()`:明文条目 → `{alias, host, port}`;`[v6]:port`、`host:port` 解析;逗号多主机拆分;**哈希条目 `\|1\|…` 只计数不猜**(`hashed`)、`@revoked` 跳过并计数、`@cert-authority` 保留、通配符丢弃;按 host:port 去重 |
| `src/config.js` | 新增纯函数 `validateHostInput()`(别名/主机/端口/用户/workspace 白名单校验)、`upsertHost()`(默认拒绝覆盖,`overwrite: true` 才替换)、`dropHost()` |
| `src/manager.js` | 新增 `discoverHosts()`(known_hosts 候选,按 host:port 过滤掉已管理主机)、`addHost()` / `removeHost()`(**先重读 config.yaml 再写**,避免并发覆盖;拒绝与 `~/.ssh/config` 同名的别名;拒绝删除 ssh-config 条目并给出提示) |
| `src/web.js` | `/status` 增加 `discovered[]` 与 `discovery{path,exists,hashed,revoked}`;新增**写路由** `hosts/add`、`hosts/remove`(要求 `confirm=1`);错误码映射 E_USAGE→400 / E_HOST_EXISTS→409 / E_UNKNOWN_HOST→404 / 其它→500 |
| `src/cli.js` | `hosts` 列表追加 "discovered in ~/.ssh/known_hosts" 区;`hosts add` / `hosts rm` 改走 manager 同一路径(校验与行为跟面板完全一致) |

**客户端半**:面板新增两个区块 —— 「已配置主机 / managed hosts」(plugin-config 的给两步「删除」,ssh-config 的标 `~/.ssh/config` 只读)、
「发现的主机 / discovered in ~/.ssh」(最多列 8 台 + "还有 N 台",每台一个「添加」);哈希条目数量单列一行提示。

**为什么写路由用 GET + `confirm=1` 而不是 POST**:0.2.0 的 `up`/`down` 已经是 GET(真机 GUI 里实测可用),而 POST 尚未在桌面 carrier 上验证过;
`admit()`(Host/Origin 围栏 + 浏览器会话 cookie)对两者一视同仁,`confirm=1` 只防 prefetch/链接扫描误触。等真机验证过 POST 再迁不迟。

**测试**:unit **28/28**(21 → +4 宿主端:known_hosts 解析、输入校验、upsert/drop + 3 条客户端;其中面板用例断言了两个写 URL 的精确形态);
integration **17/17**(TEMP 重定向)。

**冒烟(隔离 web profile 的宿主半写路由)**:为不碰真实配置,临时把 `_smoke` 的 `cordis.patch.yml` 里 `home` 指向 `G:\remote_ssh_dsh\_smoke\state-write`,重启 19399 后实测:

| 请求 | 结果 |
|---|---|
| `GET /remote-tunnel/status` | **200**,`hosts=1`(XDU-zc,ssh-config)、`discovered=3`(明文 known_hosts)、`discovery.exists=true`、`hashed=0` |
| `hosts/add` 不带 confirm | **400** `hosts/add writes the config — pass confirm=1` |
| `hosts/add?confirm=1` | **200**,写入隔离 config.yaml |
| 重复 add | **409** `E_HOST_EXISTS` |
| 端口 70000 | **400** `E_USAGE` |
| `hosts/remove` 不带 confirm | **400** |
| `hosts/remove?confirm=1` | **200**,隔离 config.yaml 回到 `hosts: {}` |
| 再次 remove | **404** `E_UNKNOWN_HOST` |
| remove `XDU-zc`(ssh-config 条目) | **404** `"XDU-zc" is defined in ~/.ssh/config — edit that file instead` |
| 未知 action | **404** |

**安全核对**:全程结束后,真实配置 `E:\Applications\dsh-data\remote-tunnel\config.yaml` 的 MD5 与动手前一致
(`15DFF8407C6B73762B667B02A2845FEC`);`~/.ssh` 全程只读。冒烟后 `_smoke` 的 patch 已改回真实 `home`,19399 重启后 `status` 200 / `discovered=3`。

**下一步**:阶段 5(README 双语「侧栏面板」章节 + CHANGELOG + `.github/releases/v0.2.1.md` + prompt 文档进 `.gitignore`),然后给用户重启验收包。


## 21. 0.2.1 阶段 5 完成 + 阶段 6 真机验收包(2026-10-03)

**阶段 5 交付**(提交 `ce0a59d`、`84cdb34`):README 双语入口表新增「远程主机面板」+ 使用小节(展开右栏 → 指南胶囊 → 五个动作、已配置/发现两类主机、
哈希 known_hosts 只报数、客户端改动需重启);`.gitignore` 忽略两份本地 prompt 笔记;版本号 `0.2.1`(package.json + package-lock);CHANGELOG `[0.2.1]`;
`.github/releases/v0.2.1.md` 中英发布说明。全量测试:unit **28/28**、integration **17/17**。

**分支状态**:5 个提交,工作树干净(被忽略的本地笔记除外),HEAD = `84cdb34`。

### 为什么要重启(而不是刷新页面)

client bundle 的 rev = `sha1(mtimeMs + ctimeMs + size)`,运行中的宿主**拒绝**过期 rev(404)且不重新发布;
宿主半(`index/web/manager`…)与客户端半都只在进程启动时加载。所以**只刷新页面不够,必须彻底重启桌面应用**(§18)。

### 重启步骤(用户操作)

1. 本会话就跑在桌面应用里 —— 重启会中断它,验收结果回来告诉我(或直接说"通过");
2. 完全退出:关窗口 **并且** 托盘退出(任务管理器里不应再有 `DeepSeek Harness.exe`);
3. 重新启动桌面应用(工作树仍在 `feat/0.2.1-remote-hosts-panel` 分支,junction 直接生效,**不用重装插件**)。

### 验收清单

| # | 操作 | 期望 |
|---|---|---|
| A1 | 左侧「插件」页 | 出现「远程隧道 (dsh-remote-tunnel)」,版本 **0.2.1** |
| A2 | **新建空会话**(不发消息)→ 展开右侧栏(会话头部右上角按钮) | 指南页出现「**远程主机**」胶囊(与 浏览器 / 工作区文件 / 新建终端 并列) |
| A3 | 点「远程主机」胶囊 | 面板打开:标题「远程主机」、连接状态标签、主机行、五个动作按钮 |
| A4 | 面板点「启动隧道 / up」 | 隧道起来(端口可能不是 3081),状态变「已连接 / connected」,显示 `隧道:XDU-zc · …` |
| A5 | 面板点「在侧栏打开」 | 右侧栏出现远端 dsh web;在远端面板里发「执行 hostname,把原始输出返回给我」→ `being-Super-Server`(V4) |
| A6 | 「已配置主机 / managed hosts」区 | 列出 `XDU-zc`,标注 `~/.ssh/config`(只读,无删除按钮) |
| A7 | 「发现的主机 / discovered in ~/.ssh」区 | 列出 `known_hosts` 里连过的主机(本机实测 3 台);点「添加」→ 变成已配置主机(`plugin-config`),可两步「删除」 |
| A8 | 点「断开连接 / down」(两步确认) | 隧道停止,状态变「未连接 / not connected」,动作变回「启动隧道 / up」 |
| A9 | 输入框上方状态条 + `/remote hosts` 卡片 | 与 0.2.0 行为一致(回归检查) |

某环节失败:把现象(以及面板里的红字错误)告诉我;宿主半还可看 `/remote-tunnel/status` 返回的 `client.events` 黑匣子。

### 回滚命令(不需要 GUI 能用)

```powershell
cd G:\remote_ssh_dsh\dsh-remote-tunnel
git checkout main                      # 工作树立即回到 0.2.0 内容
# 然后必须彻底重启桌面应用(§18:改文件会让运行中宿主的 bundle rev 失效)
# 要连插件一起摘掉:
& 'E:\Applications\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-remote-tunnel
# 想回到开发态(link 安装):
& 'E:\Applications\dsh\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add G:\remote_ssh_dsh\dsh-remote-tunnel
```

## 22. 0.2.1 发布前打包自检(2026-10-03)

`npm pack --dry-run --cache G:\remote_ssh_dsh\_npmcache`(先重定向 TEMP/TMP)结果:

- **0.2.1 tarball:34 个文件 / 116.2kB**,含 `src/client.js`(33.6kB,新面板)、`src/ssh-config.js`、`src/config.js`、`src/web.js`、
  `docs/desktop-panel-{0.2.1-plan,progress}.md`、双语 README、CHANGELOG、`locale/*`、`cordis.patch.yml`、`scripts/bootstrap-remote.sh`;
  `package.json` version = 0.2.1。
- **⚠️ 差点泄露**:`files: ["docs"]` 会把**工作树里**的 `docs/desktop-panel-kickoff-prompt.md`、`docs/desktop-panel-prompt-short.md`
  (用户自己的思路笔记)和 `docs/optimization-plan.md` 一起打进 npm 包 —— **`.gitignore` 对 `npm pack` 无效**(npm 从工作树取文件,不是从 git)。
- **踩坑**:把 `.npmignore` 放**包根目录不起作用**。npm 的规则是"根 `.npmignore` 不覆盖 `files` 字段,**子目录里的才会**"
  (实测:加了根 `.npmignore` 后仍是 37 个文件)。
- **修法**:新建 `docs/.npmignore` 列掉这三个文件 → 重新 `npm pack --dry-run`:**34 个文件 / 116.2kB**,三个文件消失,其余不变。
  根 `.npmignore` 已删除(留着只会误导,原因写在 `docs/.npmignore` 的注释里)。

## 23. 0.2.1 分支自查(发版前,2026-10-03)

三处修正:

1. **`/status` 里两个 try 分开**:原来 `listHosts()` 与 `discoverHosts()` 共用一个 try —— known_hosts 读不动(权限/同名目录)会把**主机列表一起清空**。
   现在 discovery 有自己的 try,失败只把 `discovered` 置空并在 `discovery.error` 带上原因。
2. **`hosts add` 的覆盖语义**:与 `~/.ssh/config` 同名不再是硬错误 —— CLI 加 `--force`(HTTP 侧 `overwrite=1`)才允许覆盖
   (`resolveHost` 优先插件配置,这是有意的 override);**面板永远不带 overwrite**,所以"点一下添加"不可能悄悄遮蔽用户手写的主机。
3. **删掉 `cli.js` 里已用不到的 `saveConfig` 导入**。

回归证据(隔离 home 冒烟,重启服务后):
`add XDU-zc`(不带 overwrite)→ **409**;`add XDU-zc&overwrite=1` → **200**;`remove` → **200**,隔离 config.yaml 回到 `hosts: {}`;
`status` → 200 / `discovered=3` / 无 discovery 错误。unit **28/28**、integration **17/17**。

## 24. 0.2.1 重启前加固(2026-10-03)

等用户重启期间,把**不依赖真机**的风险点补进单测(unit 28 → **30**):

- **多主机跟随**:两台主机 + 一条属于 `prod` 的隧道 → 面板显示 `隧道:prod`(而不是"第一条隧道");
  用主机下拉切到没有隧道的 `lab` 后 → 变「未连接 / not connected」+「启动隧道 / up」,且**不再出现**「断开连接 / down」。
- **冷启动**:`status === null` 且框架没注入 `useTabInfo` 时,面板渲染「读取状态中… / reading status」而不是抛错。
- **混合版本**:模拟"0.2.0 宿主半 + 0.2.1 客户端半"(`status` 不带 `discovered`/`discovery`)→ 面板照常渲染已配置主机区,
  不渲染发现区、也不显示哈希提示 ⇒ 升级过程中不会白屏。

顺带确认:桌面端 HTTP 面(`/`、`/index.html`)一律 **401**、`/plugins/…` 无 rev 一律 **404**
⇒ 重启后**无法**从命令行免鉴权读它的 bundle / boot graph,真机验收只能靠 GUI 现象(以及用户反馈);
这也反证 3e 的准入围栏在桌面端是生效的。

## 25. 0.2.1 首轮真机验收反馈与修正(2026-10-03)

**首轮验收结论(用户截图)**:核心闸门**通过** —— 空会话展开右栏即见胶囊、面板打开、隧道起来
(`隧道:XDU-zc · 82.157.182.71:3080 · http://127.0.0.1:3081 · /home/zc`)、「断开连接 / down」在位。用户报了 4 条,逐条定位:

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | 插件页没有版本号 | **我的验收清单写错**:桌面端「插件」页对任何插件都不渲染版本号 | 宿主半 `/status` 增加 `version`(读插件自己的 package.json),面板标题旁显示 `v0.2.1` |
| 2 | 想改名「远程主机」→「远程连接」,图标换电脑 | 指南胶囊图标契约是 `entry.icon`(**组件**),不传就落默认立方体(`sidebar-right/lib/client.js:461`) | 三处改名(tab 标题/指南胶囊/面板标题)+ 自带内联 SVG 显示器图标(不引入 primitives 依赖) |
| 3 | 已配置主机没有删除按钮 | `XDU-zc` 来自 `~/.ssh/config`,我们承诺只读 | 行尾文案改为「来自 ~/.ssh/config · 只读」;**「隐藏 / 接管」待用户拍板** |
| 4 | 发现的主机点「添加」无效 | **真 bug**:非 22 端口候选的别名是 `host:port`,而别名规则 `^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$` 拒绝冒号 → **400**(`config.js:84`) | 宿主计算 `suggestedAlias`(`101.43.145.128-6104`;IPv6 → `2001-db8--1-2222`),面板用提交;**规则不放宽**(别名会进 state 文件名,冒号在 Windows 文件名里非法) |

**验证**(隔离 home,重启宿主后):
- `status.version = 0.2.1`;候选带 `suggestedAlias`:`101.43.145.128:6104 => 101.43.145.128-6104`、`github.com => github.com`;
- 原样 `host:port` 仍 **400**(护栏在);用 `suggestedAlias` → **200**;添加后 `managed` 多一台、`discovered` 3→2;`remove` → **200**;
- bundle **200 / 34529 字节**,含 `远程连接`、内联 svg(`viewBox`)、版本渲染、`suggestedAlias`、「只读」文案;
- unit **30/30**(新增:suggestedAlias 必须是合法别名、面板显示版本、指南 glyph 是组件且渲染出 svg、非 22 端口候选的写 URL)、integration **17/17**。

**顺手修的文档 bug**:`README.zh.md` 里 `(或标签条上的 )` 丢了一个反引号包裹的 `+`(上次文档提交写丢的),已补。

**待办**:用户拍板图三的处理方式(只读文案 + 「隐藏」 / 「接管」);然后**再重启一次**验收;通过后才合并 main、打 tag、发 npm。

## 26. 隐藏 / 忽略 / 恢复(用户拍板 (a)+(b),2026-10-03)

**问题**:来自 ~/.ssh/config 的主机不能删(承诺只读),而「发现的主机」里也没有「挪开」的手段 —— 用户需要在面板里管理这两类。

**做法**
- 新增配置键 hiddenHosts: [](只写插件自己的 config.yaml;normalizeConfig 只收非空字符串);
- 纯函数 validateHideKey() / toggleHidden()(键 ≤ 200 字符、去重、可逆);
- manager.hiddenKeys() / listVisibleHosts() / hideHost();**隐藏一个不在列表里的键 → 404 E_UNKNOWN_HOST**(防陈旧 UI 塞垃圾);
- /status 增加 hidden[];新路由 GET /remote-tunnel/hosts/hide?confirm=1&key=<alias|host:port>&hidden=0|1;发现候选带 key(host:port);
- CLI hosts **仍列出全部主机**,末尾提示有多少条在面板里被隐藏(隐藏只是面板偏好);
- 客户端:ssh-config 行加「隐藏」、发现行加「忽略」、新增「已隐藏 / hidden in this pane」区(每条一个「恢复」)。

**验证**(隔离 home 冒烟):hide 无 confirm → **400**;隐藏 XDU-zc → **200**,hosts 为空、hidden=["XDU-zc"];恢复 → **200**,主机回来;
忽略候选 101.43.145.128:6104 → **200**,discovered 少一条;恢复 → 回来;隐藏不存在的键 → **404**;
bundle **200 / 36195 字节**含 隐藏/忽略/已隐藏;unit **32/32**、integration **17/17**。

**⚠️ 排查记录:真实 config.yaml 在 13:54:56 被重写过一次**(哈希 15DFF8… → 7A6D72…,内容仍是 hosts: {},用户的 localWaitSeconds: 60 保留)。
证据指向**用户在自己 GUI 里点了「添加」再「删除」**(0.2.1 面板支持的操作,写的就是插件自己的 config.yaml);
本轮我的冒烟全部跑在隔离 home —— 隔离文件带 hiddenHosts: [] 且是默认 localWaitSeconds: 15,与真实文件不同。已向用户求证。

**待办**:用户决定「首次使用引导 / 手动添加主机表单」是否进 0.2.1;然后重启验收。

### 验收通过后的发版顺序(阶段 7)

1. `git merge --ff-only feat/0.2.1-remote-hosts-panel`(保持线性历史;树内容 = 验收的那个 commit);
2. `git push origin main`;
3. `git tag -a v0.2.1 -m 'dsh-remote-tunnel 0.2.1'` → `git push origin v0.2.1`;
4. CI(`publish.yml`)跑全量测试 → `npm publish` → 贴发布说明;`fetch` **发布后约 1 分钟 registry 才可见**,别误判失败;
5. 复核 `npm view dsh-remote-tunnel version` 与 dist-tags;
6. (可选)GUI「插件 → 添加插件 → `dsh-remote-tunnel`」装 npm 版做端到端复验 —— 注意这会把 junction 换成真实副本,
   之后仓库改动不再对桌面端生效(要回到开发态就再 `plugin add <仓库目录>`)。
