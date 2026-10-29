# P0 判定问题修复设计

日期：2026-10-29  
范围：trusted 重复弹窗、后台命令、多个重定向、多文件就地编辑、引号内伪重定向。

## 意图

让 Path Guard 的模式矩阵真正约束所有判定路径：trusted 中配置为 pass 的普通操作不再弹窗，同时修复已复现的 Shell 漏判与误报。优先保证判定正确，不扩展新的产品功能。

## 方案选择

考虑过三种范围：

1. 只修 trusted 弹窗：见效快，但 Shell 的漏判和误报仍存在。
2. 修复全部已验证 P0 问题：同时处理规则传递和 Shell 判定，并补回归测试。
3. 执行完整评审：还包括配置持久化、诊断命令和界面改造。

选择方案 2。配置持久化、`/guard explain`、规则界面和文档整理留到后续。

## 目标

- trusted 下对应规则为 pass 的操作不触发确认。
- 直接命令与 `bash -c`、命令替换等包装形式保留相同规则来源。
- 单个 `&` 后的命令独立参与判定。
- 检查命令中的全部输出重定向。
- 检查就地编辑的全部输入文件。
- 引号内的 `>` 不再被当成真实重定向。
- 保留现有 344 项测试，并为所有复现案例增加回归测试。

## 非目标与反目标

- 不把 trusted 改为 naked；`blockGroup`、`confirmGroup` 等有意确认或阻止仍按有效规则执行。
- 不引入完整 Shell 解释器，不展开变量、alias 或 Shell 函数。
- 不在本轮调整配置合并、原子写入、UI 布局或规则数量。
- 不用“trusted 一律 pass”掩盖规则丢失，也不通过零散正则只修单个示例。

## 具体设计

### 1. trusted 规则语义

修改 `extensions/path-guard/judges.ts` 中绕过规则表的硬编码 confirm：

- 删除命令的不可解析目标走 `targetUnresolved`。
- 裸变量脚本目标走 `scriptUnresolved`，裸变量重定向走 `redirectUnresolved`。
- `source` 没有脚本操作数时没有文件可执行，按 pass 处理；存在但不可解析的目标仍走 `scriptUnresolved`。
- `rsync --delete` 不再只有 naked 才放行。根据解析后的目标复用 `deleteOutside` / `deleteInProject`；目标不可解析时走 `targetUnresolved`，保护路径仍优先。
- 有意保留的 `confirmGroup`、`gitDestructive` 和其他规则仍由 `rl()` / `ruleVerdict()` 决定，不在本轮改变默认矩阵。

### 2. 保留递归判定中的规则来源

当前 `SegmentVerdict` 的 confirm 只携带单个可选 `rule?: RuleId`，聚合时容易丢失。

- 将 confirm 的规则来源改为可集合并保留所有触发规则。
- 在命令替换、Shell wrapper、heredoc 和复合命令聚合时合并规则，而不是只返回 `{ kind: "confirm" }`。
- block 继续优先于 confirm；block 原因保持完整。
- `pipeline.ts` 继续去重规则，并为有资格的操作提供会话级 pass。
- 递归深度等没有对应 RuleId 的保守确认允许无规则，但不得因此清除其他已识别规则。

### 3. 后台命令分隔

修改 `shell-parse.ts` 的 `splitSegments()`：

- 将真正的单个 `&` 识别为后台命令分隔符。
- 保留 `&&`，且不误拆 `&>`、`&>>`、`2>&1`、`>&2` 等重定向或文件描述符语法。
- 对前后复合命令分别判定并继续采用 fail-safe 聚合。

### 4. 全部重定向与引号识别

以逐字符、引号及转义感知的扫描替代“取第一个重定向 token”的方式：

- 新增提取全部真实重定向目标的接口，返回操作符和目标。
- 单双引号内或被转义的 `>` 只是普通文本。
- 支持操作符与目标相连或分写，保留 `>`、`>>`、`>&`、`2>`、`&>`、`|>` 等现有语义，并跳过文件描述符复制。
- `classifySegmentOuter()` 逐一判定所有重定向；保护路径和 block 优先，confirm 规则合并。
- 原有输入重定向脚本检查保持兼容。

### 5. 多文件就地编辑

修改 `judgeInPlace()`，不再只使用 `lastDestArg()`：

- 按 sed/perl/ruby 的选项及表达式参数提取全部文件操作数。
- 对每个文件执行用户保护、内置保护、信任路径和不可解析目标判定。
- 任一文件 block 则整体 block；需要确认时保留规则来源。
- 首轮覆盖当前支持的 `-i` / `--in-place` 形式及常见表达式参数，不扩展到执行 Perl/Ruby 代码的语义分析。

## 测试设计

在 `tests/test-pathguard.ts` 增加针对性回归测试：

1. trusted 下裸变量删除、重定向、脚本及 `rsync --delete` 不调用确认 UI。
2. `bash -c`、命令替换、heredoc 中的 `gitDestructive` 保留规则 ID，并可使用会话级 pass。
3. `true & rm -rf .env` 被阻止，且 `&&`、`&>`、`2>&1` 不被误拆。
4. `echo x > harmless.txt > .env` 被阻止。
5. `echo '>.env'` 放行，真实未引用重定向仍受保护。
6. `sed -i s/x/y/ .env README.md` 被阻止，并覆盖 perl/ruby 多文件形式。
7. 运行完整测试命令，确认原测试无回归。

## 涉及文件

- `extensions/path-guard/shell-parse.ts`
- `extensions/path-guard/judges.ts`
- `extensions/path-guard/pipeline.ts`（仅在聚合接口需要时）
- `tests/test-pathguard.ts`
- 必要时更新 `README.md` 的测试数量，不扩展本轮行为文档。

## 验收

- 所有新增复现案例得到预期结果。
- 现有及新增测试全部通过。
- trusted 的普通 pass 操作无弹窗，有意确认仍带正确规则来源。
- 不修改全局用户配置，不执行示例中的危险命令；测试只使用 mock 和临时目录。
