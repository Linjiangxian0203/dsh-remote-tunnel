# dsh-remote-tunnel

中文 | [English](README.md)

**Remote Host Tunnel Manager**:把「本地浏览器 → 远程 Linux 服务器上的 dsh web」这条链路自动化——远程端口分配与登记、systemd 守护、SSH 隧道保活、本地 URL 输出、全生命周期管理,并面向多人共用同一台服务器的场景。

- 会话与文件都在**服务器**上(远程 dsh web 的工作区 = 服务器目录),本地只开一条隧道
- 每个使用者自动分到**独立的远程端口**,分配前在服务器上双重检查(真实占用 + 登记表),并发也安全
- 每次分配都在**服务器上的登记表**留档(`/etc/dsh-ports.tsv` 或按权限自动降级),可随时 `audit` 对照审查
- 隧道断线**自动重连**(进程退出后按退避重新拉起),心跳定期刷新登记表
- 本地端口被占自动顺延,并报告占用者进程

## 如果你只是使用者(不开发)

```powershell
# 1. 安装(npm 发布版)
dsh plugin --profile remote add dsh-remote-tunnel

# 2. 确认你的服务器能被识别(~/.ssh/config 里的 Host 别名自动发现)
dsh --profile remote hosts
#    没有?手动定义一台:
dsh --profile remote hosts add lab --host 10.0.0.5 --user zc --workspace /home/zc/exp

# 3. 第一次先体检,缺什么它逐项告诉你(密钥/Node/dsh/登记表/systemd)
dsh --profile remote check lab

# 4. 起隧道,浏览器自动打开服务器上的 dsh web
dsh --profile remote up lab --open

# 日常:status 看状态 / down 收尾 / logs 看远端日志 / audit 审查端口登记
dsh --profile remote down lab
```

远程服务器需要:Node ≥ 22.19、dsh、systemd、免密钥 ssh 登录;一条命令初始化:
`ssh <host> 'sh -s' < scripts/bootstrap-remote.sh`。其余参数在 `$DSH_HOME/remote-tunnel/config.yaml`,不改就能用。

## 要求

- 本地:Windows/macOS/Linux,自带 OpenSSH 客户端(Windows 10+ 已内置),**Node ≥ 22.19**
- 远程:Linux,Node ≥ 22.19 + dsh(可用 `scripts/bootstrap-remote.sh` 安装),systemd(用户级即可,无需 root)
- 推荐:远程已配置 SSH 免密钥登录(`ssh <别名>` 直接能进,不弹密码)

## 安装

```powershell
# 1. 安装到专用 CLI profile(推荐;首次会自动初始化 remote profile)
cd <插件源码目录>          # 或 npm 包名 dsh-remote-tunnel
dsh plugin --profile remote add .

# 2. 可选:装到 web profile,获得 /remote 斜杠命令
dsh plugin --profile web add .
```

## 快速上手

```powershell
# 看看有哪些主机(~/.ssh/config 里的 Host 别名会被自动发现)
dsh --profile remote hosts

# 也可以手动定义一台主机(不含 ~/.ssh/config 时)
dsh --profile remote hosts add lab --host 10.0.0.5 --user zc --workspace /home/zc/exp

# 就绪诊断:密钥/Node/dsh/登记表/systemd 逐项检查
dsh --profile remote check lab

# 一键:分配远程端口 → 登记 → 写 systemd 单元并启动远程 dsh web → 本地起隧道
dsh --profile remote up lab --open

# 输出示例:
#   allocated remote port 3081 (range 3080-3119, registered for zc)
#   ✓ tunnel up — http://127.0.0.1:3083 (remote lab:3081)
#   stop: dsh --profile remote down lab   (or Ctrl+C)

# 查询/停止/审查
dsh --profile remote status lab
dsh --profile remote logs lab            # 远程 dsh web 日志(journalctl)
dsh --profile remote audit lab           # 登记表 vs 真实占用
dsh --profile remote down lab            # 停隧道 + 登记表 released + 停服务 + 核实端口已释放
```

打开本地 URL 后,登录到的是**服务器上的 dsh web**:能对话、能读写服务器文件。API key 在远程 web 的「设置 → 模型」里配置(写入服务器 `~/.dsh/.credentials.yaml`,本插件与隧道不触碰凭据)。

## 命令一览

```
hosts / hosts add <别名> --host H [--port 22] [--user U] [--workspace DIR] / hosts rm <别名>
check <host>                     就绪诊断(可作 CI 探针,非零退出码 = 有问题)
provision <host> [--port N]      只做远程侧:分配端口 + systemd 单元 + 启动 + 登记(不起隧道)
up <host> [--port N] [--local-port N] [--open] [--heartbeat 秒]
down [host] [--keep-service]     停隧道 + released + 停单元 + 核实端口释放
status [host] [--json]
list
logs <host> [--lines N] [--follow] [--local]
audit <host> [--json] [--release <port>] [--clean-stale]
open [host]
config show / config path
```

## 工作原理

1. **远程端口分配(原子)**:一条远程脚本在 `flock` 锁内完成——读登记表的 in-use 集合 + 对区间内每个端口做真实 bind 探测 → 取第一个「两者都空闲」的端口 → 追加 TSV 行 → 回显端口。多账号并发分配互不冲突。
2. **远程守护**:写入 systemd 单元并 `enable --now`。有密码 sudo 时用**系统级**单元(`/etc/systemd/system/dsh-web-<user>.service`,与任务书模板一致);没有 sudo 时自动改用**用户级**单元(`~/.config/systemd/user/dsh-web.service`)+ `loginctl enable-linger`,完全不需要 root。服务器重启自动拉起,崩溃自动重启。
3. **TOCTOU 兜底**:若 dsh 启动时端口被抢(`EADDRINUSE` 出现在单元日志),自动把该端口加入排除集,顺延下一个空闲端口重试(默认最多 5 轮)。
4. **本地隧道**:`ssh -N -L 127.0.0.1:<本地>:127.0.0.1:<远程> <别名>`,本地端口先检查占用(被占自动顺延,并用 `netstat`+`tasklist` 报出占用者);ssh 进程退出后按退避序列(1s→2s→4s→8s→15s→30s 封顶)自动重连,永不断线(可配 `maxAttempts`)。
5. **心跳**:隧道存活期间每 `heartbeatSeconds`(默认 120 秒)在锁内原位刷新登记表 `last_heartbeat`。
6. **释放**:`down`(或 `up` 的 Ctrl+C)按序:停隧道 → 删除本地状态 → 登记表 `released` → 停远端单元 → 核实端口真的释放。另一个进程里的 `up` 监督器检测到状态文件被删除后自动停止重连,不会「诈尸」。

## 配置

`$DSH_HOME/remote-tunnel/config.yaml`(`dsh --profile remote config path` 查看路径):

```yaml
hosts:
  lab:                      # 手动定义的主机(与 ~/.ssh/config 的别名合并,二者同名时这里优先)
    host: 10.0.0.5
    port: 22
    user: zc
    workspace: /home/zc/exp
    remotePortRange: [3080, 3119]   # 可选,按主机覆盖
defaults:
  remotePortRange: [3080, 3119]     # 远程 dsh 端口区间(先查占用再分配)
  localPortRange: [3081, 3140]      # 本地隧道端口区间
  registry:
    path: /etc/dsh-ports.tsv
    lockPath: /etc/dsh-ports.lock
    sudo: auto                      # auto | always | never
    fallbackPath: .dsh-ports.tsv    # 共享登记表不可写时,降级到远程家目录(相对路径)
  unit:
    prefix: dsh-web-
    restartSec: 5
    type: auto                      # auto | system | user
  heartbeatSeconds: 120             # 0 = 关闭心跳
  remoteWaitSeconds: 60             # 等远程端口就绪
  localWaitSeconds: 15              # 等本地 URL 可访问
  reconnect:
    delaysMs: [1000, 2000, 4000, 8000, 15000, 30000]
    maxAttempts: 0                  # 0 = 永不放弃
  allocateRetries: 5
  ssh:
    connectTimeout: 0               # 0 = 不传 -o ConnectTimeout(见排错表)
    extraArgs: []
```

## 多用户共享服务器

| 服务器环境 | 登记表 | 服务守护 |
|---|---|---|
| 成员有密码 sudo | `/etc/dsh-ports.tsv`(sudo 写入) | 系统级单元,一人一个端口 |
| 成员无 sudo,管理员建了 dshports 组 | `/etc/dsh-ports.tsv`(组 0664,免 sudo) | 用户级单元 + linger |
| 什么都没配(现状) | 自动降级 `~/.dsh-ports.tsv`(只含本人记录;`check` 会提示找管理员) | 用户级单元 + linger |

管理员一次性初始化共享登记表(二选一):

```bash
# A. 成员都有 passwordless sudo
sudo install -m 0644 -o root -g root /dev/null /etc/dsh-ports.tsv

# B. 成员无 sudo:共享组写入
sudo groupadd dshports && sudo usermod -aG dshports zc alice ...
sudo install -m 0664 -o root -g dshports /dev/null /etc/dsh-ports.tsv
# 每个成员的插件配置: registry.sudo: never
```

两个用户各自 `up` → 自动分到不同远程端口;`audit` 能看出谁占哪个端口、有无 stale/冲突。

## 远程初始化(可选)

`scripts/bootstrap-remote.sh` 在服务器上装 Node(缺失时)/ 装 dsh(到 `~/.npm-global`)/ 建 `~/.dsh` / 开 linger:

```bash
ssh <host> 'sh -s' < scripts/bootstrap-remote.sh
```

## 常见排错

| 症状 | 原因与处理 |
|---|---|
| `Error: listen EADDRINUSE ... 127.0.0.1:3080` | 有人(或你上一个实例)占了该端口。本插件分配前双重检查,`up` 时若仍发生(TOCTOU)会自动顺延;手工起 dsh 才会看到这个报错。 |
| `Could not resolve hostname <别名>` | 别名不在 `~/.ssh/config` 里,且没在插件配置里定义。`hosts add` 或写入 ssh config 后重试。 |
| `Connection refused` / `remote port forwarding failed` | 远端 dsh web 没起或端口不对。`check <host>` 看「web port listening」;`logs <host>` 看远端日志;`ss -tln \| grep <port>` 在服务器上核实。 |
| `channel_setup_fwd_listener_tcpip: cannot listen to port` | 本地端口已被占(常见:两个 dsh web 实例)。本插件会自动顺延,并输出占用者进程名;也可 `--local-port` 手动指定。 |
| `Permission denied (publickey)` / `sudo: a password is required` | 密钥没配好 / 没有 NOPASSWD sudo。前者 `ssh-copy-id`;后者见上表,无 sudo 也能用(用户级单元 + 兜底登记表)。 |
| `Could not create directory '/home/xxx/.ssh'` + host key 提示 | 首次连接需接受主机指纹,插件默认 `accept-new`(TOFU),已在自动处理。 |
| 断网后隧道没恢复 | 默认无限重连,`status` 看 ssh pid 是否 alive;`logs <host> --local` 看重连日志。若设了 `reconnect.maxAttempts`,达到上限会停止。 |
| 登记表读不到(`/etc/dsh-ports.tsv missing`) | 首次分配时自动创建(需写入权限);无权限时自动降级到 `~/.dsh-ports.tsv`,`check` 会给出管理员初始化命令。 |
| 每条 ssh 命令都慢 ~N 秒 | 部分服务器上给 ssh 传 `ConnectTimeout` 会让每条连接都等满超时(即使秒连)。默认已不传该参数(`ssh.connectTimeout: 0`);需要时再显式打开。 |

## 开发与测试

```bash
pnpm install            # 插件自身依赖
node --test test/       # 单元测试 + 假 ssh shim 集成测试(无需真实服务器)
```

集成测试用一个仿真的 `ssh`(把远程命令解释到临时「服务器」上,隧道真实转发 TCP),覆盖:分配/登记/释放、并发多人分配、TOCTOU 顺延、本地端口冲突顺延、断线自动重连、跨进程 down 取消、audit stale/orphan/clean。

## 安全说明

- 隧道与远程 dsh 一律只绑 `127.0.0.1`(dsh 本身禁止 `--host 0.0.0.0`)
- 插件不保存、不传输任何密码/密钥/API key;SSH 全走现有密钥(BatchMode,拒绝密码提示挂起)
- 登记表不记录任何敏感信息(见 `docs/registry-format.md`)
- 远程脚本仅在 `flock` 锁内追加/改写登记表与 systemd 单元,不执行其他写入

## 非目标

- 不实现 SSH/SFTP/远程挂载:方案本质是「在服务器上跑 dsh」,隧道只把 HTTP 引回本地
- 不做新 TUI:CLI 子命令 + web 的 `/remote` 斜杠命令
