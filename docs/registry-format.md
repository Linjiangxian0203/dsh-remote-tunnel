# 远程端口登记表格式(registry format)

## 位置与权限

| 模式 | 路径 | 权限 | 写入方式 |
|---|---|---|---|
| shared(默认,需 sudo) | `/etc/dsh-ports.tsv` + `/etc/dsh-ports.lock` | root 所有,0644(全员可读,不可篡改) | `sudo -n` 下 flock + 追加/改写 |
| shared-direct | 同上 | root:dshports 组,0664 | 实验室成员加入 dshports 组后免 sudo,同样走 flock |
| fallback(无 sudo 时自动降级) | `~/.dsh-ports.tsv` + `.lock` | 0644,仅本人 | 直接写入,flock 保护 |

插件在 `check`/`provision` 时按「是否有密码 sudo → 共享文件是否可写 → 兜底路径」的顺序自动选择,并在 `up`/`check` 输出里明确显示当前用的是哪个文件。
在插件配置里可覆盖:`defaults.registry.path / lockPath / sudo(auto|always|never) / fallbackPath`。

## 文件格式

- **TSV**(Tab 分隔),UTF-8,一行一条记录;首行为表头,`#` 开头为注释。
- 字段值内不允许出现 Tab / 换行(插件写入前会清洗)。

```
port	user	workspace	source	created_at	last_heartbeat	status
3080	alice	/home/alice/project	win-pc-01	2026-01-10T09:30:00Z	2026-01-10T10:15:00Z	in-use
3081	bob	/home/bob	win-pc-02	2026-01-10T10:05:00Z	2026-01-10T10:05:00Z	released
```

| 列 | 含义 |
|---|---|
| `port` | 分配的远程端口(服务器上 127.0.0.1 监听) |
| `user` | 使用者标识(服务器登录账号) |
| `workspace` | 该实例的工作区目录(即 web 里看到的文件根) |
| `source` | 来源(发起分配的本机主机名) |
| `created_at` | 分配时间(ISO 8601 UTC) |
| `last_heartbeat` | 最后一次心跳时间(隧道存活期间定期刷新) |
| `status` | `in-use`(占用中)/ `released`(已释放) |

## 写入规则

- **分配(原子)**:`flock` 锁内一次性完成「读登记表 in-use 集合 + 对区间内每个端口做真实 bind 探测 → 取第一个两者都空闲的端口 → 追加 in-use 行 → 回显端口」。多个用户并发分配不会拿到同一个端口。
- **心跳**:`flock` 锁内用 `awk` 原位更新对应行的 `last_heartbeat`(仅 in-use 行)。
- **释放**:`flock` 锁内把对应行 `status` 改为 `released`。
- **清理**:`audit --clean-stale` 把「登记 in-use 但实际无进程监听」的行改为 `released`;历史行保留,便于事后审查。

## 审查(audit)

`dsh --profile remote audit <host>` 把登记表与真实占用对照输出:

- `ok` — in-use 且端口确实在监听(进程属主与登记 user 一致)
- `stale` — 登记 in-use 但端口已无人监听
- `conflict` — 端口在监听,但进程属主与登记的 user 不一致
- `orphan` — 登记 released 但端口仍有进程监听

`audit --release <port>` 手动释放某端口;`audit --clean-stale` 批量清理 stale 行。
