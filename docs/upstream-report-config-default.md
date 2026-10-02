# Upstream report draft — `Config` schema `.default(...)` breaks merged row config

Target: https://github.com/deepseek-ai/deepseek-harness/discussions (category **General**)
Status: not posted yet (no `gh` CLI / token on this machine — paste it by hand).

---

## 中文版

**标题**

`[Bug][配置] Config schema 里用 .default(...) 会让合并后的 row 配置变成未解析的 schema 对象(dsh 0.2.0-rc.2)`

**正文**

```
环境:dsh 0.2.0-rc.2(Windows 桌面版,asar 内置运行时;Electron 44 壳)
插件:自研第三方插件,导出 schemastery Config 并在 cordis.patch.yml 里设了 row 的 config
```

**现象**

插件导出的 `Config` 里,只要字段带 `.default(...)`,那么 profile 补丁层(或插件自带 patch)写给该 row 的
`config` 值**全部丢失**,`apply(ctx, config)` 收到的是**未解析的 schema 对象**(JSON 序列化后是 `{}`)。

**最小复现**

1. 插件入口:

```js
import Schema from "@deepseek-ai/schemastery";
export const Config = Schema.object({
  openIn: Schema.string().default("ask"),
  dock: Schema.boolean().default(true),
});
```

2. 该插件 bundle 的 `cordis.patch.yml`:

```yaml
- insert:
    - id: my-plugin
      name: 'my-plugin'
      config:
        openIn: ask
        dock: true
```

3. profile 的 `cordis.patch.yml`(覆盖):

```yaml
- id: my-plugin
  config:
    openIn: panel
    dock: false
```

4. 在 `apply` 里打印收到的 config:

```js
export function apply(ctx, config) { console.log(JSON.stringify(config)); }
```

**实测结果(同一套 patch,只改 schema 写法)**

| Config schema 写法 | `apply` 收到的 config |
|---|---|
| 每个字段带 `.default(...)` | `{"openIn":{},"dock":{}}` ← 配置值变成未解析的 schema 对象 |
| 纯类型(无 `.default()`) | `{"openIn":"panel","dock":false}` ✅ |

对照实验还排除了其它变量:同一个隔离 DSH_HOME、同一份 profile patch、同一个运行时,只改 schema,
"带 default" 必坏、"纯类型" 必好,可稳定复现。

**期望**

`Config` 的默认值只应补齐缺失字段;显式写进 row `config`(以及被 profile 补丁层覆盖)的值应当原样传给 `apply`。
如果这是有意行为,麻烦在文档里写明"Config schema 不能带 default"或给出正确用法。

**影响**

任何"导出 Config 且用 `.default()`"的第三方插件,row 配置都会静默失效(不报错,只是拿到默认值以外的空对象),
用户会以为"我配了但没生效"。

**临时规避**

schema 里只写纯类型,默认值在代码里兜底(本插件就是这么改的),并把每个键显式写进 row 的 `config`,这样 profile 层才能覆盖。

---

## English version

**Title**

`[Bug][Config] A Config schema with .default(...) makes the merged row config arrive as unresolved schema objects (dsh 0.2.0-rc.2)`

**Body**

```
Environment: dsh 0.2.0-rc.2 (Windows desktop app, bundled asar runtime, Electron 44 shell)
Plugin: a third-party plugin that exports a schemastery Config and sets row config in cordis.patch.yml
```

**What happens**

If a plugin's exported `Config` declares fields with `.default(...)`, then the values a
profile patch (or the plugin's own patch) writes into that row's `config` are **lost**:
`apply(ctx, config)` receives **unresolved schema objects** instead (JSON-serialized as `{}`).

**Minimal reproduction**

1. Plugin entry:

```js
import Schema from "@deepseek-ai/schemastery";
export const Config = Schema.object({
  openIn: Schema.string().default("ask"),
  dock: Schema.boolean().default(true),
});
```

2. The plugin bundle's `cordis.patch.yml`:

```yaml
- insert:
    - id: my-plugin
      name: 'my-plugin'
      config:
        openIn: ask
        dock: true
```

3. The profile's `cordis.patch.yml` (override layer):

```yaml
- id: my-plugin
  config:
    openIn: panel
    dock: false
```

4. Print the config inside `apply`:

```js
export function apply(ctx, config) { console.log(JSON.stringify(config)); }
```

**Observed (identical patches, only the schema differs)**

| Config schema | config received by `apply` |
|---|---|
| every field with `.default(...)` | `{"openIn":{},"dock":{}}` — configured values replaced by unresolved schema objects |
| plain types (no `.default()`) | `{"openIn":"panel","dock":false}` ✅ |

Everything else was held constant (same isolated DSH_HOME, same profile patch, same runtime); switching only the
schema flips the result, reproducibly.

**Expected**

`Config` defaults should just fill in missing fields; values written into the row's `config` — including values
overridden by a later profile patch — should reach `apply` unchanged. If this is intended, please document that a
Config schema must not carry defaults, or show the supported spelling.

**Impact**

Any third-party plugin that exports a Config with `.default()` silently loses its row configuration — no error,
just empty objects — and users report "I set it but nothing changed".

**Workaround**

Declare plain types in the schema, keep the defaults in code, and spell every key explicitly in the row's `config`
so that profile patches can override them.
