# P0 Judgement Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 trusted 非预期弹窗及四类已复现的 Shell 判定错误，并用回归测试锁定行为。

**Architecture:** 保留现有轻量 Shell 解析与 judge 管线，不引入依赖。规则型确认统一携带 RuleId 集合并经 `ruleVerdict()` 产生；解析层负责识别全部真实操作符和目标，judge 层负责逐目标判定与 fail-safe 聚合。

**Tech Stack:** TypeScript、Node.js 22 `--experimental-strip-types`、现有 mock pi API 测试。

**Spec:** `docs/superpowers/specs/2026-10-29-p0-judgement-fixes-design.md`

## Global Constraints

- 不安装或新增依赖，不把 trusted 改成 naked，不改变现有默认模式矩阵。
- 不执行示例中的危险命令；命令仅作为字符串交给 mock/判定函数。
- 保留现有 344 项测试；每任务先增加失败测试，再做最小实现。
- 测试命令：`cd tests && PI_PACKAGES_ROOT=/Users/Shared/share_config/pi/agent/install/releases/1.4.0/node_modules/@earendil-works node --experimental-strip-types test-pathguard.ts`。

## Review Focus

- `2>&1`、`&>` 与后台 `&` 必须区分；由 Task 3 的操作符测试覆盖。
- 单双引号及反斜杠转义中的 `>` 不得成为重定向；由 Task 4 覆盖。
- 多个 confirm 的规则必须去重且不可因递归丢失；由 Task 2 覆盖。
- 保护路径优先于 trusted/pass；由 Task 1 和 Task 5 的 protected-target 测试覆盖。
- sed/perl/ruby 的表达式参数不得误当文件，全部真实文件必须检查；由 Task 5 覆盖。

---

### Task 1: trusted 硬编码确认回归规则

**Files:**
- Modify: `extensions/path-guard/judges.ts`
- Test: `tests/test-pathguard.ts`

**Interfaces:**
- Consumes: 现有 `ruleVerdict(rule, reason)`、`targetUnresolved`、`scriptUnresolved`、`redirectUnresolved`、`deleteOutside`、`deleteInProject`。
- Produces: trusted 下普通 unresolved/delete 操作遵守规则表，不改变函数签名。

- [ ] **Step 1: 写失败测试**

切换到 trusted，断言以下命令 verdict 为 `pass` 且 `selectCalls === 0`：`rm "$TARGET"`、`echo x > "$TARGET"`、`source "$SCRIPT"`、`source`、`rsync --delete src/ dest/`。另断言内置保护路径仍优先于 trusted pass。

- [ ] **Step 2: 验证失败**

运行全局测试命令。预期：现有 344 项通过，新增 trusted 案例至少因实际 `confirm` 而失败。

- [ ] **Step 3: 最小实现**

在 `judges.ts` 将裸变量和不可解析删除目标接入对应 unresolved 规则；无操作数 `source` 放行；`rsync --delete` 按目标位置走 delete 规则、不可解析目标走 `targetUnresolved`，保留 protected/user-protected 优先级。

- [ ] **Step 4: 验证通过**

运行全局测试命令。预期：全部测试通过，trusted 目标案例无 UI 确认。

- [ ] **Step 5: 提交**

`git add extensions/path-guard/judges.ts tests/test-pathguard.ts && git commit -m "fix: honor trusted rules for unresolved operations"`

### Task 2: 递归判定保留规则集合

**Files:**
- Modify: `extensions/path-guard/judges.ts`
- Modify: `extensions/path-guard/pipeline.ts`
- Test: `tests/test-pathguard.ts`

**Interfaces:**
- Consumes: Task 1 的规则型判定。
- Produces: confirm verdict 使用 `rules?: RuleId[]` 代替 `rule?: RuleId`；所有递归/聚合路径保留并去重规则，pipeline 继续向 `askConfirm()` 传 `RuleId[]`。

- [ ] **Step 1: 写失败测试**

对 `bash -c "git reset --hard"`、`echo "$(git reset --hard)"` 和含 Git 操作的 heredoc 断言 confirm 选项包含 `gitDestructive` 会话级 pass；选择后再次执行同类操作不再 confirm。另用复合命令断言多个规则只出现一次。

- [ ] **Step 2: 验证失败**

运行全局测试命令。预期：直接 Git 命令可用会话 pass，包装形式缺少该选项。

- [ ] **Step 3: 最小实现**

把 `SegmentVerdict` confirm 改为携带 `rules?: RuleId[]`；更新 `classifySubstitutions()`、`classifySegment()`、`judgeShellWrapper()`、`scanPipeToShell()` 及所有构造/读取处，在聚合时合并去重，block 优先级不变。

- [ ] **Step 4: 验证通过**

运行全局测试命令并做 TypeScript 语法/诊断检查。预期：全部测试通过，无 `rule`/`rules` 类型混用错误。

- [ ] **Step 5: 提交**

`git add extensions/path-guard/judges.ts extensions/path-guard/pipeline.ts tests/test-pathguard.ts && git commit -m "fix: preserve confirm rules through recursion"`

### Task 3: 后台命令分隔

**Files:**
- Modify: `extensions/path-guard/shell-parse.ts`
- Test: `tests/test-pathguard.ts`

**Interfaces:**
- Consumes: 现有 `splitSegments(input: string): string[]` 调用方。
- Produces: 同一签名正确区分后台 `&` 与重定向/`&&`。

- [ ] **Step 1: 写失败测试**

断言 `true & rm -rf .env` 为 block；直接断言分段结果覆盖 `cmd1 & cmd2`、`cmd1 && cmd2`、`echo x &> out`、`printf x 2>&1`，后四类不得误拆重定向。

- [ ] **Step 2: 验证失败**

运行全局测试命令。预期：后台命令案例实际 pass。

- [ ] **Step 3: 最小实现**

仅调整 `splitSegments()` 的 `&` 分支：单个后台 `&` 分段，`&&` 消费两个字符，`&>`/`&>>` 和前置 `>` 的文件描述符复制保留在原片段。

- [ ] **Step 4: 验证通过**

运行全局测试命令。预期：后台删除被拦截，其余分隔行为无回归。

- [ ] **Step 5: 提交**

`git add extensions/path-guard/shell-parse.ts tests/test-pathguard.ts && git commit -m "fix: judge background shell commands"`

### Task 4: 全部真实重定向与引号识别

**Files:**
- Modify: `extensions/path-guard/shell-parse.ts`
- Modify: `extensions/path-guard/judges.ts`
- Test: `tests/test-pathguard.ts`

**Interfaces:**
- Consumes: Task 2 的 confirm `rules` 集合和 Task 3 的片段拆分。
- Produces: `extractRedirectTargets(fullCommand: string): RedirectTarget[]`；替代 `extractRedirectTarget()`，保持 `RedirectTarget { op: string; target: string }`。

- [ ] **Step 1: 写失败测试**

断言 `echo x > harmless.txt > .env` block、`echo '>.env'` pass、`echo ">.env"` pass、转义 `\>.env` 不作为重定向；覆盖相连/分写目标、append、noclobber 和 fd duplication，并确认多个 confirm 规则被聚合。

- [ ] **Step 2: 验证失败**

运行全局测试命令。预期：第二重定向漏判且引号文本误 block。

- [ ] **Step 3: 最小实现**

在 `shell-parse.ts` 用逐字符、引号和转义感知扫描实现 `extractRedirectTargets()`；在 `classifySegmentOuter()` 遍历所有目标，收集 block 与 confirm 后统一返回，保护路径/block 优先。保持输入重定向脚本判定兼容。

- [ ] **Step 4: 验证通过**

运行全局测试命令。预期：全部新旧重定向测试通过。

- [ ] **Step 5: 提交**

`git add extensions/path-guard/shell-parse.ts extensions/path-guard/judges.ts tests/test-pathguard.ts && git commit -m "fix: inspect every shell redirect"`

### Task 5: 多文件就地编辑与最终验证

**Files:**
- Modify: `extensions/path-guard/judges.ts`
- Test: `tests/test-pathguard.ts`

**Interfaces:**
- Consumes: 现有 `protectedVerdict()`、`isTrustedPath()`、`unresolvedTargetVerdict()`。
- Produces: `judgeInPlace()` 检查全部真实文件操作数；可新增私有 `inPlaceTargets(cmdInfo: CmdInfo): string[]`。

- [ ] **Step 1: 写失败测试**

断言 `sed -i s/x/y/ .env README.md`、对应 perl/ruby 多文件形式 block；普通表达式不是文件；含不可解析文件时走 `targetUnresolved`；trusted path 仍不覆盖保护路径。

- [ ] **Step 2: 验证失败**

运行全局测试命令。预期：前置 `.env` 未被检查，案例实际 pass。

- [ ] **Step 3: 最小实现**

按命令和现有 `-i`/`--in-place` 形式提取所有文件操作数，跳过选项及其参数和表达式；逐目标执行 protected/trusted/unresolved 判定，任一 block 整体 block。

- [ ] **Step 4: 完整验证**

运行全局测试命令、`check_syntax` 和变更文件 LSP diagnostics。预期：全部测试通过，无新增语法或类型错误。

- [ ] **Step 5: 提交**

`git add extensions/path-guard/judges.ts tests/test-pathguard.ts && git commit -m "fix: guard every in-place edit target"`
