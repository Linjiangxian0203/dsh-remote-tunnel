# 0.2.1 计划 —— 侧栏「远程主机」面板 + 多主机管理

> 面向新会话的执行计划。历史与全部踩坑记录见 [desktop-panel-progress.md](./desktop-panel-progress.md);
> 本文件只讲 **0.2.1 要做什么、契约是什么、怎么验、怎么发**。
> 0.2.0 已于 2026-10-02 发布(npm latest = 0.2.0,GitHub Release 有中英说明)。

## 0. 为什么做这个

0.2.0 的三个入口里,有两个受外壳渲染规则限制:

1. **纯新会话(hero 布局)里看不到命令卡片** —— 会话视图在没有模型历史时渲染欢迎页,命令生命周期不属于模型历史;
2. **状态条只在「会话已有内容」时渲染** —— 它挂在 `conversation.composer.dock`,而 hero 布局不渲染该座位(源码证据见 progress 文档 §14)。

用户拍板:**0.2.1 用侧栏「远程主机」面板根治** —— 面板挂在右侧栏标签条/指南里,任何会话状态都能点到。

## 0.1 安全边界与回滚(先读这一节,回答「会不会把 app 改崩」)

**这个插件不改造 app,也改造不了。** 事实:

| 区域 | 我们是否写入 | 证据 |
|---|---|---|
| `<DSH_APP>\**`(app 本体、app.asar、main.js、前端 dist) | **从不** | 实测:12 小时内该目录下改动文件数 = 0;`app.asar` 时间戳仍是安装日 |
| `<DSH_HOME>\profiles\desktop\{package.json,node_modules,pnpm-lock.yaml}` | 会(等于「插件」页点一次『添加插件』) | 这是 app 的**配置数据**,不是 app 代码 |
| `<workspace>\dsh-remote-tunnel`(插件仓库) | 会 | 全部源码/文档/测试都在这里 |
| 插件在 profile 里的形态 | Junction(开发期)或 npm 副本 | 两种情况都只是 `node_modules` 里的一个包 |

**为什么用到的接口是合法的**:客户端插件、侧栏 tab 类型、`slot`、命令、HTTP 路由、Config schema 都是运行时**公开给第三方插件**的扩展点 ——
你机器上已有的 `dsh-context`(注册侧栏与命令)与 `dsh-plugin-whale-pet`(注册 `shell.overlay`)用的就是同一类接口。
我们是`客人`,不是`装修队`。

**最坏情况的爆炸半径**:

1. **宿主半**抛错 → cordis 把这一行标记失败/跳过,**app 照常运行**(你机器上现在就有 4 个被 deny 的插件是这个状态);
2. **客户端半**抛错 → 客户端模块系统记录`这一行`的加载/渲染失败(插件页/设置页可见),其余 UI 不受影响;最坏症状是`入口不出现/面板空白`;
3. 唯一能碰到 app 进程的历史风险是 0.1.x 的模式判定竞态(可能 `appExit(0)` 退掉宿主),**0.2.0 已修并有单测**(`resolveMode`);
4. 0.2.0 开发期间实测重启 8 次以上(含已知有 bug 的中间版本),app 每次都正常启动。

**回滚(不需要 GUI 能用)**:

```powershell
& '<DSH_APP>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-remote-tunnel
# 或还原安装前备份:
Copy-Item '<workspace>\_run\backup-desktop-profile-20261002-160611\package.json' '<DSH_HOME>\profiles\desktop\package.json' -Force
```

**0.2.1 会碰的文件(就这些)**:

- `src/client.js`(客户端半:新增 tab 注册 + 面板组件);
- 可能 `src/web.js` / `src/index.js`(若做主机增删路由);
- `test/unit.test.js`、README、CHANGELOG、`.github/releases/v0.2.1.md`;
- **不碰**:app 本体、app.asar、Electron 主进程、前端 dist。

## 1. 交付物

| 编号 | 内容 | 备注 |
|---|---|---|
| 3c-1 | 注册新 tab kind(`ctx.sidebarRightTabs.register`)并在右侧栏**指南页**加入口(与「浏览器 / 工作区文件 / 新建终端」并列) | 客户端半 `src/client.js` |
| 3c-2 | 面板本体(`ctx.slots.register({ name: 'sidebar.right.pane.tab', key })`):主机列表 / 隧道状态 /「启动隧道」「断开连接」「在侧栏打开」「在浏览器打开」「刷新」 | 复用现有 `/remote-tunnel/*` 路由 |
| 3c-3 | 多主机:主机下拉(已有)、主机增删(需新增路由,或先只读 + 指引用 CLI) | 可视工作量分两步 |
| 3c-4 | (可选)贡献命令 + 快捷键(如 `remote.panel`)一键开面板 | sidebar-right 文档提到 files/browser/terminal 各自贡献命令 |
| 3c-5 | 自动化测试:在 `test/unit.test.js` 的客户端 bundle 桩里断言 tab 注册与面板渲染 | 桩已存在,见 §4 |
| 3d+ | 文档:README 补面板章节 + **截图**(用户提供),替换 `docs/images/desktop-*.png` 的占位注释 | 见 §5 |

## 2. 技术契约(已从运行时源码确认,别猜)

### 2.1 注册 tab 类型(`@deepseek-ai/dsh-client-ui-sidebar-right`)

```js
ctx.sidebarRightTabs.register({
  id: 'dsh-remote-tunnel/hosts',      // 全局唯一;body/title 按它登记,重复注册同一 id 会抛错
  kind: 'remote-hosts',               // 一个 kind 最多一个 builtin + 一个 extension
  title: () => '远程主机',              // tab 标题,开 tab 时捕获
  guide: [{ id: 'hosts', kind: 'remote-hosts', title: '远程主机', description: '管理远程隧道,打开远端 dsh web' }],
  // patterns 只给资源类型用;页面型 tab 不给,靠 kind 打开
});
```

### 2.2 打开与渲染

- 打开:`ctx.sidebarRight.openTab('remote-hosts', { params: { … } })`(**params 会以 `navigation.params` 传给 body**);
- 渲染:`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: '<definition.id>' }, Body)`,body 通过框架注入的 `useTabInfo()` 读 `{ sidebar, panel, tab }`;
- 指南页入口:上面 `guide` 数组即可,用户点一下就开(右侧栏「+」或指南胶囊);
- **面板属于客户端面**:宿主插件不能直接开,必须由我们的客户端 bundle 做(0.2.0 的卡片与状态条已经这么做)。

### 2.3 现有宿主路由(0.2.0 已实现,可直接复用)

```
GET /remote-tunnel/status             → { config, hosts[], tunnels[], services, client }
GET /remote-tunnel/open?host=&mode=   → mode=panel 返回 authUrl;mode=browser 宿主直接开系统浏览器
GET /remote-tunnel/up?host=           → 起隧道(并发去重)
GET /remote-tunnel/down?host=         → 停隧道 + 停远端单元 + 释放端口
```
全部走 `ctx.connection.admit()` 准入(需要页面上下文的 cookie);**新增路由也要照做**。

## 3. 开发环(重要)

**先确认桌面 profile 里是 link 还是 npm 副本**(两种都出现过):

```powershell
& '<DSH_APP>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add <workspace>\dsh-remote-tunnel
# 验证:profiles/desktop/node_modules/dsh-remote-tunnel 应变成 Junction(Target = 仓库)
```

发布前再切回 npm 版验证一次(remove + `add dsh-remote-tunnel`)。

**本机环境坑(照做,否则浪费一小时)**:

- `node.exe` 只能写工作区 → dsh CLI 一律用桌面 shim;npm 加 `--cache <workspace>\_npmcache`;
- 跑集成测试前先 `$env:TEMP='<workspace>\_tmp'`(`$env:TMP` 同值),否则 `mkdtemp` EPERM 全红;
- 桌面端改代码后**必须彻底重启**(窗口关掉 + 托盘退出),当前会话会断 → 每步写进 progress 文档;
- 隔离自检:`DSH_HOME=<workspace>\_smoke\dsh-home` 起 `--profile web --no-open --port 19399`,
  该 profile 的 patch 已把 row 的 `home` 指到真实状态目录(可读到真实隧道状态);
- **不要**打印 `<DSH_HOME>\.credentials.yaml` 内容;不要动 npm-global 那份 dsh;不要基于 `dsh-ssh.json` 设计。

## 4. 测试与验收闸门

| 闸门 | 手段 |
|---|---|
| 单元 | `node test/unit.test.js`(现有 21 条:resolveMode、authRejection、客户端 bundle 的 module-loader + React 桩;新面板要加注册/渲染断言) |
| 集成 | `$env:TEMP=…; node test/integration.test.js`(17 条) |
| 宿主侧冒烟 | 隔离 web profile 起服务 → 请求路由(注意准入:先拿 `?token=` 换 cookie) |
| 真机 | 重启桌面端 → 右侧栏指南出现「远程主机」入口 → 打开面板 →「启动隧道」→「在侧栏打开」→ 面板里 `hostname` = `<server-host>` |
| **核心验收** | **新建空会话(不发消息)就能从侧栏打开面板** —— 这是 0.2.1 存在的理由 |

## 5. 文档与截图(用户提供截图后)

README 双语「桌面端面板 / Desktop app panel」章节里留了一处占位注释:

```
<!-- 截图(0.2.1 文档更新时补):docs/images/desktop-plugins.png 插件页 / desktop-card.png 命令卡片 / desktop-dock.png 状态条 / desktop-panel.png 侧栏面板 -->
```

图片放进 `docs/images/` 后,把注释替换为 `![…](docs/images/desktop-xxx.png)`(README.md 与 README.zh.md 各一处),
并在「桌面端面板」章节补一段「侧栏面板怎么用」。

## 6. 发版 0.2.1(流程已跑通一次,照抄)

1. `package.json` + `package-lock.json` 版本号 → `0.2.1`;
2. `CHANGELOG.md` 顶部加 `## [0.2.1]`(Added/Changed/Fixed);
3. `.github/releases/v0.2.1.md` 中英发布说明(模板见 `.github/releases/README.md`);
4. 全量测试:unit + integration;
5. `git push origin main` → `git tag -a v0.2.1 -m '…'` → `git push origin v0.2.1`;
6. GitHub Actions(`publish.yml`)自动 `npm publish` 并贴发布说明 —— **发布后约 1 分钟才在 registry 可见**
   (npm 会回 being processed 那句,别误判成失败);
7. 用 GUI「插件 → 添加插件 → `dsh-remote-tunnel`」装 npm 版做端到端验收。

## 7. 已知但不在 0.2.1 范围

- Windows 上 `node.exe` 写盘受限(环境问题,非插件问题);
- `Config` schema 的 `.default()` 坑(已规避;上游报告草稿在 `docs/upstream-report-config-default.md`,由用户自行发 Discussion);
- 桌面 profile 里 4 个 `0.1.7-rc.2` 插件被 0.2.0 运行时 deny(browser-use / computer-use ×2,既有问题,与本插件无关)。
