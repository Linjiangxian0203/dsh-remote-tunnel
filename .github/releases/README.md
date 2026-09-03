# Release notes 格式 / Format

> 每个发布版本一个文件 `vX.Y.Z.md`,publish workflow 自动把它贴到 GitHub Release。
> One file per release (`vX.Y.Z.md`), attached to the GitHub Release automatically.

## 模板 / Template

```
[中文](#cn) | [English](#en)

中文

体验优化
- ...

问题修复
- ...

其他变更
- ...

---

English

Improvements
- ...

Bug Fixes
- ...

Chores
- ...
```

## 规则 / Rules

- 标题由 workflow 生成:`dsh vX.Y.Z`
- **首行一行**:`[中文](#cn) | [English](#en)`——「中文」「English」**不单独成行**
- 中文组在前(`体验优化 / 问题修复 / 其他变更`),`---` 分隔,英文组在后(`Improvements / Bug Fixes / Chores`)
- 分组可省略,但顺序保持 优化 → 修复 → 变更
- **不写日期**、**不署名**(单人项目)
- 参考样例:https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1
