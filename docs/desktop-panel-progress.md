# dsh-remote-tunnel — 桌面端面板:进度与验收断点

> 本文件是**断点文档**,给"重启桌面端之后的新会话"用。配套路线书:
> [`desktop-web-refactor-route.md`](./desktop-web-refactor-route.md);勘查结论:
> `G:\remote_ssh_dsh\_recon\desktop-app-report.md`。
> 最后更新:2026-10-02(GUI 宿主 / 桌面 runtime = 0.2.0-rc.2;远端 = 0.2.0-rc.2)。

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

