# CC-Fix

Claude Code 环境安全检测与修复 CLI 工具。详见 `README.md` 与 `SPEC.md`。

## 源码边界

真实源码仅限 `src/`（构建入口 `src/index.ts`）。`.wayfinder/temp/check-cc/` 是上游 [yacuo/check-cc](https://github.com/yacuo/check-cc) 的研究快照（只读参考），**不是本项目源码，禁止修改、禁止纳入构建/测试/静态扫描范围**；检测逻辑的移植实现位于 `src/detection/`。

## Agent skills

### Issue tracker

Issues 跟踪在 GitHub Issues（github.com/gongyijie85/cc-fix），通过 gh CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认五角色标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`（按需懒创建）。See `docs/agents/domain.md`.
