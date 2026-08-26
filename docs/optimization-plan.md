# dsh-remote-tunnel 优化方案

> 本文件仅为方案,基于对全部源码(`src/` 13 个文件)、测试(`test/` 单测 + 集成测 + mock-ssh 框架)、`scripts/bootstrap-remote.sh`、`cordis.patch.yml`、`.github/workflows/publish.yml`、两份 README 与 `docs/registry-format.md`、以及 git 历史的通读。

> **实施状态**:🔴 P0 四条 + 顺带的 CI 门禁(第 12 条)已在 2026 年(当前迭代)实施完毕,`node --test` 19/19 通过(含新增的 shared-direct 权限回归测试)。P1-P4 尚未实施。

## 概览

| 档 | 条目数 | 说明 |
|---|---|---|
| 🔴 P0 | 4 | 真实 Bug,影响核心场景(多人共享 / macOS / web 斜杠命令 / 心跳),建议优先修 |
| 🟠 P1 | 6 | 健壮性 / 正确性,边缘场景或输入下出错 |
| 🟡 P2 | 6 | 工程化 / CI / 依赖一致性 |
| 🟢 P3 | 4 | 代码质量 / 一致性 / 可维护性 |
| ⚪ P4 | 3 | 文档 |

建议实施顺序:**P0 → P2(lockfile/CI 门禁) → P1 → P3 → P4**。P0 改动小、风险低、收益最高;P2 的 lockfile/CI 能在后续改动中持续兜底。

---

## 🔴 P0 — 真实 Bug

### 1. shared-direct 模式下 registry update 的 `mv` 破坏登记表文件权限

**位置**:`src/remote/registry.js` — `UPDATE_SHELL` 常量

**现状**:
```sh
const UPDATE_SHELL = `set -eu
REG=$1; PORT=$2; USER_=$3; COL=$4; VAL=$5
TMP="$REG.tmp.$$"
awk -F '\\t' -v OFS='\\t' -v port="$PORT" -v user="$USER_" -v col="$COL" -v val="$VAL" '
  { if ($1 == port && $2 == user) { if (col == "7") $7 = val; else $6 = val; } print }
' "$REG" > "$TMP"
mv "$TMP" "$REG"`;
```

**问题**:README 的多人共享方案 B(dshports 组 0664,成员用 `usermod -aG` 加入,主组不变)正是 `shared-direct` 模式。`mv` 会**替换 inode**:新文件属主=当前用户、组=当前用户主组(通常不是 dshports)、权限按 umask(常 0644)。后果是其他 dshports 成员后续对 `/etc/dsh-ports.tsv` 的 `>>` 追加与 awk 写入**全部失败(EACCES)**。而 `ALLOCATE_SHELL` 用 `printf >> "$REG"`(追加,保留 inode)不破坏权限——两条写入路径不一致。心跳每 120s 跑一次 update,会**反复破坏权限**,表现为多人共用时某人 `up` 后其他人的心跳/`down` 报 `registry update failed`。

**修复方案**:保留原 inode,只改内容(`cat` 重写已存在文件不换 inode、保留属主/组/权限):
```sh
' "$REG" > "$TMP"
cat "$TMP" > "$REG" && rm -f "$TMP"
```

**测试建议(重要)**:`test/mock-remote/ssh-shim.js` 的 `runUpdate` 用 `writeFileSync(reg, ...)` 直接覆盖内容,**不模拟真实 `mv` 的 inode/属主/组变化**,所以现有集成测覆盖不到本 bug。修复后建议补一个 shared-direct 权限回归测试:在 mock 里给 registry 文件附加"虚拟属主/组"(用一个 sidecar JSON 记录),`runUpdate` 改为模拟 `cat` 保留权限、并断言 update 后组不变。或在真实 Linux 多用户环境手动验证(最快)。

**风险**:极低。`cat tmp > reg` 是标准做法,行为等价于 `mv` 但保留 inode。

---

### 2. macOS 上 `open` / `up --open` 不工作

**位置**:`src/manager.js` — `open()` 方法(约 575-584 行)

**现状**:
```js
open(alias) {
  const state = readState(this.home, alias);
  if (state === undefined) throw new TunnelError(`no tunnel state for "${alias}"`, { code: "E_NOT_UP" });
  const url = state.url;
  const child = process.platform === "win32"
    ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true })
    : spawn("xdg-open", [url], { stdio: "ignore" });
  child.on("error", () => {});
  return url;
}
```

**问题**:非 win32 一律用 `xdg-open`,但 **macOS 没有 `xdg-open`**(命令是 `open`),且 `child.on("error", () => {})` 把 spawn 失败静默吞掉,macOS 用户 `up --open` 和 `open` 命令都不会开浏览器,也看不到任何报错。

**修复方案**:
```js
const child = process.platform === "win32"
  ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true })
  : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
child.on("error", (error) => this.err(`could not open browser: ${error.message}`));
```
顺带把 error 反馈给 `reporter.err`(原静默吞掉对用户不友好)。

**测试建议**:单测可 mock `process.platform` 与 `spawn`(需把 spawn 注入化或抽一个 `openUrl` 工具以便替换)。优先级低,可仅靠人工验证。

**风险**:低。仅 macOS 行为变化。

---

### 3. `/remote up <host> [--open]` 的 `--open` 没实现,且会误解析

**位置**:`src/service.js` — `case "up"`(约 45-49 行)

**现状**:
```js
case "up": {
  requireArg(tokens, 1, "up <host> [--open]");
  const result = await manager.up(tokens[1], {});
  return { kind: "success", text: [...] };
}
```
`tokens = invocation.rawInput.trim().split(/\s+/)`

**问题**:`USAGE` 常量写了 `up <host> [--open]`,但实现完全忽略 `--open`:
- `/remote up lab --open` → `tokens=["up","lab","--open"]`,`tokens[1]="lab"` 正确,但 `--open` 被丢弃,**不会开浏览器**。
- `/remote up --open`(不带 host)→ `tokens[1]="--open"`,被当成 host 名传给 `manager.up("--open")`,报 `E_UNKNOWN_HOST`,且 requireArg 因为 tokens[1] 存在而**不拦截**。

**修复方案**:解析出 flag 与真实 host:
```js
case "up": {
  const rest = tokens.slice(1).filter((t) => !t.startsWith("--"));
  const wantOpen = tokens.slice(1).includes("--open");
  if (rest.length === 0) throw new TunnelError("missing argument — up <host> [--open]", { code: "E_USAGE" });
  const result = await manager.up(rest[0], {});
  if (wantOpen) {
    try { manager.open(rest[0]); } catch (e) { /* 忽略:URL 已在返回文本里 */ }
  }
  return { kind: "success", text: [...] };
}
```
同理 `down` 的 `--keep-service`、`audit` 的 `--json`/`--release`/`--clean-stale`、`status`/`list` 的 `--json` 在 service.js 里也都没接(见 P3-2),可一并补齐或明确文档说明 web 斜杠命令是精简版。

**测试建议**:service.js 目前**无任何测试**(它依赖 web context 的 `commands` service,难以直接单测)。建议把 `registerSlashCommands` 的 handler 逻辑抽成一个纯函数 `dispatchRemote(manager, rawInput)`,对它做单测,service.js 只负责注册。

**风险**:低。

---

### 4. 心跳并发堆积

**位置**:`src/manager.js` — `startHeartbeat()`(约 225-244 行)

**现状**:
```js
const timer = setInterval(() => {
  const run = async () => {
    const targets = await this.resolveTargets(alias);
    await remoteUpdateRegistry(...);
    ...
  };
  run().catch((error) => { this.event({ kind: "heartbeat", alias, error: ... }); });
}, seconds * 1000);
```

**问题**:`setInterval` 不等上次 `run()` 完成。默认 120s 间隔,但 `remoteUpdateRegistry` 的 ssh 往返 + flock 最坏 60s。网络抖动/远端慢时,多个心跳 `run()` 会**并发堆积**(都打到同一行,虽 flock 串行但连接资源浪费,极端情况雪崩)。

**修复方案**:加 in-flight guard:
```js
let inflight = false;
const timer = setInterval(() => {
  if (inflight) return;            // 上次还没回,跳过本次
  inflight = true;
  const run = async () => { ... };
  run().catch((error) => { this.event({ kind: "heartbeat", alias, error: ... }); })
       .finally(() => { inflight = false; });
}, seconds * 1000);
```

**测试建议**:单测可用假 manager + 快进定时器验证不会并发。

**风险**:低。

---

## 🟠 P1 — 健壮性 / 正确性

### 5. systemd unit 值未转义

**位置**:`src/remote/unit.js` — `renderSystemUnit` / `renderUserUnit`

**现状**:`WorkingDirectory=${workspace}`、`Environment=HOME=${home}`、`Environment=DSH_HOME=${home}/.dsh` 直接字符串插值。

**问题**:workspace/home 路径含空格或特殊字符会破坏 unit 文件解析。Linux 用户 home 通常无空格,但 **workspace 是用户 `hosts add` 时指定的**,可能含空格(如 `/home/alice/my project`)。

**修复方案**:`Environment=` 值加引号;`WorkingDirectory=` 不能加引号,需用 `systemd-escape --path` 预处理。在 `provisionUnit` 里对 workspace 远端执行 `systemd-escape --path "$workspace"` 取回转义后的值再渲染;或最低限度对含空格的 workspace 报错提示。
```ini
Environment="HOME=${home}"
Environment="DSH_HOME=${home}/.dsh"
```

**风险**:低。

---

### 6. Windows 端口耗尽时 N 次全量 netstat

**位置**:`src/local/ports.js` — `describeOccupant` + `findFreeLocalPort`

**现状**:`findFreeLocalPort` 扫不到空闲端口时,对区间内**每个**端口调一次 `describeOccupant`,每次内部 `netstat -ano -p tcp`(全量)+ `tasklist`,O(N) 次进程启动,20 个端口区间时很慢。

**修复方案**:`findFreeLocalPort` 失败分支改为**一次** `netstat -ano -p tcp` 解析出所有 LISTENING 端口→pid,再用**一次** `tasklist` 批量取进程名,一次性输出所有占用者。

**风险**:低,纯性能优化。

---

### 7. `parseSshConfig` 不展开 `Include`

**位置**:`src/ssh-config.js`(注释已承认)

**问题**:`~/.ssh/config` 用了 `Include ~/.ssh/conf.d/*` 时,`hosts` 列表会漏掉 include 进来的主机,用户会困惑"明明 ssh 能连却 `dsh hosts` 看不到"。

**修复方案(二选一)**:
- A(稳):保留当前解析,但在 `listHosts()` / `check` 输出里列出 `parsed.includes` 并提示"以下 Include 未展开,其中的主机不会自动出现,可用 `hosts add` 手动定义"。
- B(准):改用 `ssh -G <alias>` 让真 ssh 解析(单个 alias 精确,但不适合批量列举;可对 `hosts` 列表仍用本地解析,对 `resolveHost` 单个查询用 `ssh -G`)。

**风险**:B 会多一次 ssh 进程;A 无风险。

---

### 8. `remoteOccupancy` 用 `node -e '...'` 单引号拼接

**位置**:`src/remote/registry.js` — `remoteOccupancy`(`OCCUPANCY_NODE_PROBE` 通过 `node -e '...'` 传)

**现状**:
```js
const result = await execRemote(hostDef, `node -e '${OCCUPANCY_NODE_PROBE.replace(/'/g, `'\\''`)}' ${ports.join(" ")}`, ...);
```

**问题**:靠 `.replace(/'/g, "'\\''")` 转义,脆弱;`ALLOCATE_NODE_PROBE` 已走 stdin(`ALLOCATE_SHELL` 用 `sh -s` + stdin 传脚本),occupancy 走命令行,两条路径不一致,将来 probe 脚本含复杂引号会破。

**修复方案**:统一走 stdin:写一个小 shell wrapper `node - "$@" <<'EOF' ... EOF`,或像 ALLOCATE 那样用 `sh -s` 接 stdin 传 node 脚本。去掉命令行单引号拼接。

**风险**:低。

---

### 9. 端口参数静默吞错

**位置**:`src/cli.js`(`hosts add`、`provision`、`up`、`logs`、`audit` 等)

**现状**:`Number.parseInt(options.port, 10) || 22`、`|| 100`、`|| 0` 等。`--port abc` → `NaN || 22` = 22,`--port 0` → `0 || 22` = 22,都静默吞成默认值而非报错。

**修复方案**:加 `parsePort(str, name)` helper:
```js
function parsePort(str, name) {
  const n = Number.parseInt(str, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new TunnelError(`invalid ${name}: "${str}" (expected 1-65535)`, { code: "E_USAGE" });
  }
  return n;
}
```
替换所有 `Number.parseInt(...) || ...`。

**风险**:低,行为更严格。

---

### 10. `audit --clean-stale` / `--release` 串行多次 ssh 往返

**位置**:`src/manager.js` `audit()` + `src/remote/registry.js` `remoteUpdateRegistry`

**问题**:cleanStale 对**每个** stale 行单独发一次 flock update(N 行 = N 次 ssh 往返 + N 次 flock)。

**修复方案**:加一个 `remoteUpdateRegistryBatch(hostDef, cfg, ctx, registry, rows[])`,一次 awk 批量改写多行;`audit --clean-stale` 收集所有 stale 行后一次调用。

**风险**:低。

---

## 🟡 P2 — 工程化 / CI

### 11. 依赖管理不一致(最值得收拾)

**现状**:
- 本地用 pnpm,但 `.gitignore` 忽略了 `pnpm-lock.yaml`(无 lockfile 提交)。
- `package.json` 无 `packageManager` 字段。
- CI(`publish.yml`)用 `npm install`(无 lockfile,每次解析不同依赖树)。

**修复方案(统一到一种工具)**:
- **方案 A(统一 npm,推荐,与 CI 现状一致)**:从 `.gitignore` 移除 lockfile;`pnpm install` 改用 npm 生成 `package-lock.json` 并提交;CI 改 `npm ci`;本地也用 npm。
- **方案 B(统一 pnpm)**:加 `"packageManager": "pnpm@9.x"`;`.gitignore` 去掉 `pnpm-lock.yaml`,提交 lockfile;CI 改 `pnpm install --frozen-lockfile`(需 `pnpm/action-setup`)。

**风险**:低。建议 A,因为 dsh 生态与 CI 已是 npm。

---

### 12. 常规提交没有测试门禁

**位置**:`.github/workflows/publish.yml`(只在 `v*` tag 时跑测试)

**问题**:非发版提交不跑测试,测试挂了要等下次发版才发现。

**修复方案**:新建 `.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm install
      - run: node --test test/unit.test.js test/integration.test.js
```

**风险**:无。

---

### 13. `publish.yml` 的 Node 版本与 `engines` 语义不符

**现状**:`setup-node node-version: 22`;`package.json` `engines: ">=22.19"`。

**修复方案**:`node-version: '22.19'`(setup-node 支持精确版本)或显式 `'22.x'` 并在注释说明对齐 engines。

**风险**:无。

---

### 14. 测试文件进了 npm 包

**现状**:`package.json` 的 `files` 含 `"test"`(约 900 行测试 + mock),会随 `npm publish` 发布。

**修复方案**:从 `files` 移除 `"test"`(测试不随包发布是惯例);保留 `src`/`cordis.patch.yml`/`scripts`/`docs`/`README*`。若希望使用者能在包内跑测试则保留——看偏好,倾向移除。

**风险**:无。

---

### 15. peer / dev 依赖还停在 `^0.1.0-rc.6`

**现状**:`package.json` `peerDependencies` / `devDependencies` 都是 `^0.1.0-rc.6`;dsh 已到 rc.8(前几轮 session 验证过兼容)。

**修复方案**:改 `^0.1.0-rc.8` 后 `pnpm install` 对齐(不必须,只是对齐版本号)。

**风险**:无。

---

### 16. 无 `CHANGELOG.md` / 无 lint

**修复方案**:
- 新增 `CHANGELOG.md`(Keep a Changelog 格式),回填 0.1.0 / 0.1.1 主要条目(从 git log 提炼)。
- 加 `.prettierrc`(`{ "semi": true, "singleQuote": false, "printWidth": 120 }`)与 `eslint.config.js`(flat config,ESM);`package.json` 加 `"lint": "eslint src"`、`"format": "prettier --write ."`。

**风险**:无,纯增量。

---

## 🟢 P3 — 代码质量 / 一致性

### 17. `cli.js` 风格不统一、重复模板

**现状**:`cmd()` helper 只用了 2 处(check/open),其余 8 个命令内联 `Promise.resolve().then(async()=>...).then(()=>exit?.(0), (error)=>{printError(error); exit?.(1);})`,大量重复。

**修复方案**:把所有命令统一改用 `cmd()`(扩展 `cmd` 支持选项透传与非 resident),或抽一个 `asyncAction(program, name, desc, handler)` wrapper 统一错误处理与 exit。文件可缩短约 80 行。

**风险**:中(重构面广,需测试兜底,建议 P2 的 CI 门禁先到位)。

---

### 18. `service.js` 与 `cli.js` 命令面重复且分叉

**现状**:两个文件各写一遍 hosts/check/up/down/status/audit/open,行为有差异(service 的 up 没 `--open`、down 没 `--keep-service`、audit 没 `--json`/`--release`/`--clean-stale`、status/list 没 `--json`)。

**修复方案**:抽一个共享的"子命令→参数解析 + 调用 manager"层(如 `src/dispatch.js`),cli 与 service 都调用;cli 负责 commander 选项解析与退出码,service 负责 `rawInput` 解析与返回 `{kind,text}`。减少分叉,新加命令只改一处。

**风险**:中。建议与 #17 一起做。

---

### 19. `TunnelConfigError` 体系外、无 code

**位置**:`src/config.js` 末尾(`class TunnelConfigError`),`src/errors.js` 未导出。

**问题**:`cli.js` 的 `printError` 只识别 `TunnelError`,`TunnelConfigError` 走 generic 分支,无 `hint` 支持;且无 `code` 字段。

**修复方案**:把 `TunnelConfigError` 移到 `errors.js`,加 `code: "E_CONFIG"`(默认),与 `TunnelError` 体系一致;或直接让 `loadConfig` 抛 `TunnelError({code:"E_CONFIG"})` 而非自定义类。

**风险**:低。

---

### 20. `invokedForWebProfile()` 嗅探 argv 脆弱

**位置**:`src/index.js`

**现状**:硬编码检查 `argv[2] === "web"` / `"--profile=web"` / `("--profile","web")`,再有 `ctx.get("webStartup") !== undefined` 兜底。

**修复方案**:argv 嗅探冗余且有误判风险(用户自定义 web profile 名、复制改名);直接只靠 `ctx.get("webStartup") !== undefined` 判断(注释里也说 service 检查是 best-effort guard)。去掉 `invokedForWebProfile()`,保留 service 兜底。

**风险**:中,需验证 remote profile(无 webStartup)仍走 CLI、web profile(有 webStartup)走 service。建议改后跑全套集成测 + 真实 `dsh --profile remote` / `dsh web` 各起一次确认。

---

## ⚪ P4 — 文档

### 21. `bootstrap-remote.sh` 注释引用了不存在的锚点

**位置**:`scripts/bootstrap-remote.sh` 第 13 行注释 `... see README.md "多用户共享登记表"`。

**问题**:英文 README 标题是 "Sharing one server (multi-user)",中文是"多用户共享一台服务器",没有"多用户共享登记表"这个锚点。

**修复方案**:改成 `see README.md "Sharing one server (multi-user)"` 或中文 README 的对应章节。

---

### 22. README Troubleshooting 含已修复的历史信息

**位置**:`README.md` / `README.zh.md` Troubleshooting 表中 "Upgrade to a build that includes 'fix: don't clear the tunnel's own -L forward on Windows'" 行。

**问题**:该 fix 已在本版本(`f3a6979`)合入,对已是最新版的用户是冗余历史信息。

**修复方案**:精简为一句"已在当前版本修复;旧版 Windows OpenSSH 8.1 见历史",或移到"已修复问题"小节。

---

### 23. `docs/registry-format.md` 只有中文版

**修复方案**:新增 `docs/registry-format.en.md`,README 双语版各链各的。

---

## 附:建议的最小首批改动(P0,约 1 个文件 + 3 处)

若只想先解掉真实 bug、风险最低,可只做:
1. `src/remote/registry.js`:`UPDATE_SHELL` 的 `mv` → `cat ... && rm -f ...`(P0-1)
2. `src/manager.js`:`open()` 加 darwin 分支 + error 反馈(P0-2)
3. `src/service.js`:`case "up"` 解析 `--open`(P0-3)
4. `src/manager.js`:`startHeartbeat` 加 in-flight guard(P0-4)

这 4 处改动小、互不依赖、无破坏性,且都能被现有/补充测试覆盖。其余档位可按节奏推进。
