# pi-path-guard

**Path Guard — pi 扩展：防误删 / 防误覆盖 / 防误改**
**Path Guard — pi extension: prevents accidental deletes / overwrites / edits**

它会拦截 `bash`、`write`、`edit` 工具调用里的破坏性操作，然后根据当前防护模式决定**阻止、询问还是放行**。要拦的东西有四类：

It intercepts destructive operations in `bash` / `write` / `edit` tool calls and decides whether to **block, confirm, or pass** based on the active guard mode. It watches for four kinds of trouble:

- 受保护路径：`.env`、`.ssh`、密钥、凭据等
  Protected paths: `.env`, `.ssh`, keys, credentials, …
- 系统级破坏命令：`mkfs`、`reboot`、写块设备、批量删除等
  System-destructive commands: `mkfs` / `reboot` / block-device writes / bulk deletes, …
- 项目外的覆盖和删除
  Overwrites and deletes outside the project
- `>` 截断已有文件
  `>` truncation of existing files

## 它能做什么 / What it does

**5 种模式，23 条规则都能单独调 / 5 modes, every rule tunable**

有 `strict` / `normal`（默认）/ `loose` / `trusted` / `naked` 五档。切换模式就是整体收紧或放宽，当前模式会记住、跨会话有效（`/guard` 或 `/guard <mode>`）。不想切模式也可以只调某一条规则：`/guard → rules` 里把任意一条设为阻止 / 询问 / 放行，不用改代码，配置里只保存你改过的项。

`strict` / `normal` (default) / `loose` / `trusted` / `naked` — switching modes tightens or loosens everything at once, and the mode persists across sessions (`/guard` or `/guard <mode>`). Prefer a finer touch? In `/guard → rules` you can set any of the 23 rules to **block / confirm / pass** one by one, or reset it to the default. No code changes; only your overrides are stored.

**两类路径 / Protected & trusted paths**

受保护路径在任何模式下都会被拦截（包括 naked）。信任路径相反：落在里面的操作一律直接放行。`/guard → paths` 管理这两类。系统重要路径永远不能被设为信任（见下文）。

**Protected paths** are guarded in *every* mode, including `naked`. **Trusted paths** are the opposite: anything inside them just passes. Manage both under `/guard → paths`. System-important paths can never be trusted (see below).

**三种裁决 / Three-way verdict**

每次拦截的结果只有三种：**阻止**（直接拒绝）、**询问**（弹窗问你）、**放行**（直接执行）。严不严，完全由你的规则决定。

Every intercepted operation resolves to **block** (refused), **confirm** (you get asked), or **pass** (it just runs). How strict that feels is entirely up to your rules.

> ⚠️ **安全提示 / Security notice**: pi 扩展拥有完整系统权限、可以执行任意代码。本项目开源，安装前建议先读一遍源码（`extensions/path-guard/`）。
> pi extensions run with full system permissions and can execute arbitrary code. Review the source before installing (this project is open source — see `extensions/path-guard/`).

## 安装 / Install

```bash
# 从 npm 安装（推荐 / recommended）
pi install npm:@yaosu/pi-path-guard

# 从 git 安装
pi install git:github.com/yaodashanren/pi-path-guard

# 本地目录（开发用 / development）
pi install /path/to/pi-path-guard

# 不安装直接试用（不写入 settings / no settings change）
pi -e ./pi-path-guard
```

装完执行 `/reload` 或重启 pi 生效。
After installing, run `/reload` or restart pi.

## 使用 / Usage

### `/guard` 命令 / The `/guard` command

`/guard` 打开交互主菜单，有五个动作：切换防护模式、定制每模式的规则、管理自定义路径、选择配置保存位置（全局还是本项目）、查看诊断报告。支持自定义组件的宿主里，整个流程在一个浮动弹窗内完成：↑/↓ 移动、⏎ 选择、esc 返回、主菜单按 `q` 退出。子菜单选 back 逐级返回，只有顶层取消才退出。

`/guard` opens an interactive main menu with five actions: switch mode, customize per-mode rules, manage custom paths, choose where edits are saved (global vs this project), and show a diagnostics report. On hosts that support custom components the whole flow runs in one floating popup: ↑/↓ to move, ⏎ to select, esc to go back, `q` to quit at the main menu. **Back** in a sub-menu returns one level up; only cancelling at the top level exits.

**切换模式**的界面会先展示完整的判定矩阵。模式切换本身有门槛：`trusted` 需要警告确认，`naked` 需要两次确认。

**Switch mode** shows the full decision matrix first. Switching is guarded too: `trusted` needs a warning confirm, `naked` needs a double confirm.

**定制规则**是两级导航：先选模式，再从 7 个分组（系统 / 写入 / 删除 / 覆盖 / Git 与管道 / 运行脚本 / 不可解析）里选一组，然后逐条规则设置。每条规则会显示当前生效级别和来源：无后缀 = 内置默认；`[global]` / `[project]` = 该层有覆盖；`(pass, session-pass)` = 仅本会话放行（只在内存里，不落盘）。同一组里可以连续改多条，返回时逐级退回。分组页的 reset 一键清空该模式的所有覆盖。另有只读的 overview 全矩阵，可滚动查看。规则存于 settings.json 的 `pathGuard.rules.{mode}.{rule}`。

**Customize rules** is a two-level menu: pick a mode, then pick one of 7 rule groups (System / Writes / Deletes / Overwrite / Git & Pipes / Scripts / Unknowable), then edit rules one by one. Each rule shows its effective level and where it comes from: no suffix = built-in default; `[global]` / `[project]` = an override stored in that layer; `(pass, session-pass)` = allowed for this session only (in memory, never persisted). You can edit several rules in one group before backing out. **Reset** on the group screen clears every override for that mode. There is also a read-only **overview** matrix you can scroll through. Overrides are stored as `pathGuard.rules.{mode}.{rule}` in settings.json.

**诊断报告**（`/guard doctor`）：一次性输出纯文本报告，无 UI 也能用。面板里的 doctor 屏就是同一份报告，可滚动：↑/↓ 逐行、PgUp/PgDn 翻页、⏎/esc 返回。详见下文 Doctor 小节。

**Diagnostics** (`/guard doctor`): a plain-text report that works with or without a UI. Inside the panel, the same report opens as a scrollable screen: ↑/↓ moves a line, PgUp/PgDn pages, ⏎/esc goes back. See the Doctor section below.

**判定诊断**（`/guard explain <command>`）：只读展示某条命令会怎么被判定，**不会真的执行它**，无 UI 也能用。详见下文 Explain 小节。

**Explain** (`/guard explain <command>`): shows how a command *would* be judged, **without running it**. Works without a UI. See the Explain section below.

参数不合法时回落到交互主菜单。
Invalid arguments fall back to the interactive main menu.

### 配置怎么存 / How config is stored

配置分两层：全局的 settings.json（`~/.pi/agent/settings.json`）和可选的项目条目文件。`/guard` 的每次修改只写你选定的那一层（默认全局，`--project` 写本项目），继承来的项目值不会被顺手固化进全局文件。

Config has two layers: the global settings.json (`~/.pi/agent/settings.json`) and an optional per-project entry file. Each `/guard` edit writes only the layer you picked (global by default, `--project` for this project). A value inherited from the project layer is never silently copied into the global file.

项目条目文件放在 pi agent 目录下（`<agent dir>/path-guard/projects/<slug>-<hash>.json`，`<agent dir>` 默认 `~/.pi/agent`），不在项目仓库里。这样 pi 不会把它当成需要"信任项目"的资源，无 UI 会话、`--no-approve`、`defaultProjectTrust: "never"` 都能正常读取。查找时先精确匹配项目目录，找不到再往上找最近的祖先目录——所以子目录里的会话会继承仓库根的配置，写的也是同一个文件。`PI_PATH_GUARD_PROJECTS_DIR` 可以覆盖整个目录（测试在用）。

The project entry file lives under the pi agent dir (`<agent dir>/path-guard/projects/<slug>-<hash>.json`; `<agent dir>` defaults to `~/.pi/agent`), *not* inside your repo. That way pi never treats it as a trust-requiring project resource, and headless sessions, `--no-approve`, and `defaultProjectTrust: "never"` all read it fine. Lookup tries the project directory first, then walks up to the nearest ancestor — a session in a subdirectory inherits the repo root's config and writes back to the same file. `PI_PATH_GUARD_PROJECTS_DIR` overrides the whole directory (the tests use this).

相关命令：
Related commands:

- `/guard --project <mode|paths …|rules>` — 把这次修改存到项目条目文件（首次使用会自动创建）
  save this edit to the project's entry file (created on first use)
- `/guard project` — 查看条目文件、命中方式、覆盖了哪些字段、有没有配置告警
  show the entry file, how it matched, which fields it overrides, any warnings
- `/guard project import` — 把项目里手写的 `.pi/settings.json` `pathGuard` 块复制进条目文件；原文件保留，pathGuard 块请自行删除
  copy a hand-authored `pathGuard` block into the entry file; the source file is kept — remove the block yourself
- `/guard project remove` — 确认后删除条目文件
  delete the entry file after a confirmation that names it

**相对路径按所属层解析 / Relative paths are anchored to their own layer.** 项目条目里的相对路径以项目根为基准。全局配置只接受绝对路径和 `~/…`——因为同一个全局相对路径在不同项目里含义不一样，与其猜，不如拒绝并告警。

In a project entry, relative paths resolve against that project's root. Global settings only accept absolute paths and `~/…`: the same relative global path would mean something different in every project, so it is refused with a warning instead of guessed.

**配置问题看得见 / Config problems are visible.** JSON 损坏、未知规则、`project` 字段不匹配、被丢弃的相对路径，都会在会话启动时汇总成一条 warning（注明文件和字段），`/guard project` 里也能逐条查看。损坏的层被跳过，其他层照常生效。

Corrupt JSON, unknown rule ids or levels, mismatched `project` fields, dropped relative paths — each surfaces as one warning at session start, naming the file and field, and `/guard project` lists them. A broken layer is skipped; the others keep working.

**写入是原子的 / Writes are atomic.** 先写临时文件再 rename，settings.json 里的其他键原样保留。写失败会保留原文件并明确告诉你，不会假装存好了。

Writes go through a temp file + rename, and other keys in settings.json are preserved. A failed write keeps the previous file and says so, instead of pretending it persisted.

**路径命令 / Path commands**

- `/guard paths protected add|rm|list|clear <path>`（可省略 `protected`）— 管理自定义**受保护路径**，任何模式下都拦截
  manage custom **protected paths**, enforced in every mode
- `/guard paths trusted add|rm|list|clear <path>` — 管理**信任路径**（始终放行）；添加需要警告确认；系统路径和已受保护的路径会被拒绝
  manage **trusted paths** (always allowed); adding one needs a warning confirm; protected/system paths are refused
- 当前模式显示在底部状态栏：`🛡 <mode>`，naked 用警示色显示 `🛡 NAKED`
  the active mode shows in the footer status bar: `🛡 <mode>`, `🛡 NAKED` in warning color when naked

### 受保护路径与信任路径 / Protected & trusted paths

`/guard → paths`（或 `/guard paths`）分两类：

`/guard → paths` (or `/guard paths`) has two categories:

```text
# 受保护路径（默认分类）——任何模式下都拦截，含 naked
/guard paths protected list | add <path> | rm <path> | clear
/guard paths list | add <path> | rm <path> | clear   # 同上，分类默认 protected

# 信任路径——始终放行
/guard paths trusted list | add <path> | rm <path> | clear
```

**受保护路径**按解析后的真实路径匹配，任何模式下都生效——包括 `naked`（内置的受保护路径在 naked 下不拦，你自己加的始终拦）。也可以直接写在配置里：

**Protected paths** match against the resolved real path and are guarded in every mode — including `naked` (built-in protected paths are *not* enforced in naked; yours are). You can also set them statically:

```jsonc
"pathGuard": { "extraProtected": ["~/secrets", "/path/to/important.txt"] }
```

**信任路径**反过来：目标落在信任路径里的操作，一律当作 trusted 模式处理——写入、编辑、删除、覆盖、截断、就地修改都不弹窗，任何模式下都放行（包括 strict）。但保护永远优先于信任：

**Trusted paths** flip that: anything whose target lies inside one is treated as if the mode were `trusted`, just for that path — writes, edits, deletes, overwrites, truncation, in-place edits all pass without a prompt, *in every mode* (even `strict`). Protection always outranks trust:

- 信任路径永远不能同时是受保护路径。添加 `.env`、`.ssh`、密钥、`node_modules` 等内置系统路径，或已被你设为受保护的路径，会被拒绝。
  A trusted path can never be a protected path — adding `.env` / `.ssh` / keys / `node_modules` / … or an existing user-protected path is refused.
- 信任目录里如果藏着受保护文件，照样拦。比如信任目录下的 `.env` 依旧受保护。
  A protected file *inside* a trusted subtree stays protected — a `.env` under a trusted dir is still blocked.
- 添加信任路径需要警告确认（无 UI 时直接拒绝）。
  Adding a trusted path requires a warning confirm (refused without a UI).

静态配置示例 / Static config:

```jsonc
"pathGuard": {
  "extraProtected": ["~/secrets"],
  "trustedPaths":   ["/path/to/scratch-or-build-dir"]
}
```

### 可调规则 / Tunable rules

每个模式的判定由 23 条规则组成，可以在 settings.json 里按模式覆盖（`rule` 取 `"block" | "confirm" | "pass"`，非法值忽略）：

Each mode's judgement is a set of 23 rules; override any of them per mode in settings.json (`rule` = `"block" | "confirm" | "pass"`; invalid values are ignored):

```jsonc
"pathGuard": {
  "mode": "normal",
  "rules": {
    "normal":  { "deleteOutside": "confirm", "confirmGroup": "pass" },
    "naked":   { "blockGroup": "block" }
  }
}
```

规则 ID / Rule IDs: `blockGroup`, `confirmGroup`, `writeOutside`, `writeHome`, `writeInProject`, `deleteOutside`, `deleteInProject`, `overwriteOutsideExisting`, `overwriteOutsideNew`, `overwriteInProject`, `truncateInProject`, `truncateOutside`, `gitDestructive`, `pipeToShellInProject`, `pipeToShellOutside`, `runScriptInProject`, `runScriptOutside`, `runScriptProtected`, `scriptUnresolved`, `redirectUnresolved`, `archiveExtract`, `targetUnresolved`, `commandNameUnresolved`. 默认值与下面的矩阵完全一致 / Defaults reproduce the matrix below exactly.

### 防护模式矩阵 / Guard mode matrix

| 判定点 / Checkpoint | strict | normal | loose | trusted | naked |
| --- | --- | --- | --- | --- | --- |
| 受保护路径 / Protected paths (.env/.ssh/keys/credentials) | block | block | block | block | pass |
| Block 组危险命令 / Block group (mkfs/reboot/block-device writes/bulk delete) | block | block | block | block | confirm |
| Confirm 组 / Confirm group (sudo/ssh/chmod 777 …) | block | confirm | confirm | confirm | pass |
| git 破坏性 / git destructive (reset --hard/clean -f …) | confirm | confirm | confirm | confirm | pass |
| 项目内写/改/新建 / In-project write/edit/new | confirm | pass | pass | pass | pass |
| 项目内删除 / In-project delete | confirm | confirm | pass | pass | pass |
| 项目外写新文件 / Outside write (new file) | confirm | confirm | pass | pass | pass |
| 项目外覆盖已有文件 / Outside overwrite existing | block | block | confirm | pass | pass |
| 项目外删除普通文件 / Outside delete ordinary | block | block | confirm | pass | pass |
| `>` 截断项目内已有文件 / `>` truncate existing in-project | confirm | confirm | pass | pass | pass |
| `>` 截断项目外已有文件 / `>` truncate existing outside | block | confirm | confirm | pass | pass |
| 管道到 shell·项目内 / Pipe to shell (in-workspace, curl…\|bash) | confirm | pass | pass | pass | pass |
| 管道到 shell·远程或项目外 / Pipe to shell (remote/outside) | confirm | confirm | pass | pass | pass |
| 运行脚本·项目内 / Run script in-project (source/. / bash x.sh) | confirm | confirm | pass | pass | pass |
| 运行脚本·项目外或 HOME / Run script outside/HOME | block | confirm | confirm | pass | pass |
| 运行脚本·内置保护路径 / Run script of built-in protected path | block | confirm | confirm | pass | pass |
| 运行脚本·目标不可解析 / Run script with an unresolvable `$VAR`/glob target | block | confirm | confirm | pass | pass |
| 重定向·目标不可解析 / `>` redirect with an unresolvable `$VAR`/glob target | block | confirm | confirm | pass | pass |
| 解压归档·内容不可知 / Archive extraction (unzip / tar -x) | confirm | confirm | confirm | pass | pass |
| 写目标不可解析 / Write target is an unresolvable `$VAR`/glob (mv/cp/dd/curl…) | confirm | confirm | confirm | pass | pass |
| 命令名不可解析 / Command name is an unresolvable `$VAR`/`$(…)` | block | confirm | confirm | pass | pass |
| HOME 目录写 / cwd=HOME write | confirm | confirm | pass | pass | pass |
| 无交互界面 / No UI (headless) | block* | block* | block* | block* | pass |

block = 直接阻止 / denied directly; confirm = 弹窗询问 / prompt; pass = 放行 / allow.
\* 无 UI 时，本该确认的操作一律改为阻止 / headless: anything that would be confirmed is blocked instead.

> ⚠️ **naked（裸奔模式）**：几乎全部放行——受保护路径、write/edit 检查、git 破坏性、截断、外部删除/覆盖，无 UI 下也放行。只有系统级破坏命令（mkfs / reboot / 批量删除 / 写块设备）仍会弹窗。切换需要两次确认。只在你确实想要最小干扰时用。
> **naked mode** passes almost everything — protected paths, the write/edit checks, git destructive, truncation, outside deletes/overwrites, even with no UI. Only system-destructive commands (mkfs / reboot / bulk-delete / block-device writes) are still confirmed. Switching in needs a double confirmation. Use it only when you really want the guard out of your way.

### 拦截了什么 / What gets intercepted

- **受保护路径**：`.env` / `.envrc` / `.ssh` / `.secrets` / `.aws` / `.kube` / 私钥（`*.pem`/`*.key`/`*.p12`/`*.pfx`、`id_rsa`/`id_ed25519`）/ 凭据 / shell 配置（`.bashrc` 等）/ `node_modules` / `dist` / `build`……任何模式下硬拦（naked 除外）。
  **Protected paths** — hard-blocked in every mode except naked.
- **Block 组**：`mkfs.*` / `mkswap` / `poweroff` / `reboot` / `shutdown` / `dd` 写块设备 / `> /dev/sdX` / `find -delete` / `find -exec rm` / `xargs rm`。
  **Block group** — system-destructive commands.
- **Confirm 组**：`sudo` / `doas` / `pkexec` / `chmod 777` / `ssh` / `scp` / `sftp` / `rsh` / `telnet` / `wget -O /dev/null`。
  **Confirm group** — commands that deserve a question every time.
- **覆盖检测**：`mv` / `cp` / `install` / `tee` / `ln -f` / `rsync --delete` 作用于已存在的目标时，按项目内外判定。rsync/scp 的远程目标（`user@host:/path`）不会被误当成绝对本地路径。
  **Overwrite detection** — `mv` / `cp` / `install` / `tee` / `ln -f` / `rsync --delete` on existing targets, judged by in/out of project. rsync/scp remote targets are never mistaken for local paths.
- **重定向截断**：`> 已有文件`（含 `2>` / `&>` / `>|`，`>>` 和设备除外）需要确认。
  **Redirect truncation** — `> existing file` (incl. `2>` / `&>` / `>|`; `>>` and devices excepted) confirms.
- **重定向目标不可解析**：目标里带 `$VAR` 或通配符时无法确定路径，走 **`redirectUnresolved`** 规则（strict 阻 / normal·loose 问 / trusted·naked 放）。但会先看"字面尾巴"：命中你自定义的保护路径，任何模式都硬拦；命中内置保护同样硬拦；连字面都没有的裸 `$VAR` 即使在 trusted 下也保持确认。
  **Unresolvable redirect target** — a `>` target containing `$VAR`/glob syntax follows the `redirectUnresolved` rule, but the literal tail is inspected first: a user-protected tail stays hard-blocked in every mode, a built-in protected tail too, and a bare `$VAR` with nothing literal still confirms even in trusted.
- **重定向 / 下载 / dd 的目标位置**：`>`、`dd of=`、`curl -o|-O`、`wget -O` 的目标在项目外（或写 HOME）时，按覆盖规则判定；`/dev/null` 之类设备和信任路径放行。
  **Redirect / download / dd target location** — targets outside the project (or HOME writes) are judged like overwrites; devices and trusted paths are exempt.
- **Shell 包装器递归**：剥掉 `sudo` / `nohup` / `timeout` / `env` 等前缀，再递归分析 `bash -c` / `eval` 内层的真实命令；分词时能正确处理引号。
  **Shell wrapper recursion** — strips `sudo` / `nohup` / `timeout` / `env` … prefixes and recurses into `bash -c` / `eval`; tokenization is quote-aware.
- **git 破坏性命令**：`clean -f` / `reset --hard` / `checkout -- .` / `checkout|switch -f|--force` / `restore .` / `worktree remove --force` / `tag -d` / `branch -D` / `push --force` / `stash drop`。带路径的 `restore --source=<ref> -- <path>` 是常规用法，不算破坏。
  **git destructive** — the usual suspects; a narrow `restore --source=<ref> -- <path>` is not treated as destructive.
- **危险管道到 shell**：`curl … | bash` / `wget -qO- … | sh` / `python -c '…' | sh`。strict 一律确认；normal 放行项目内来源、确认远程或项目外来源；其余模式按 `pipeToShell*` 规则放行。
  **Dangerous pipe-to-shell** — strict confirms at all positions; normal passes in-workspace sources and confirms remote/outside ones; other modes pass per the `pipeToShell*` rules.
- **运行脚本守护**：`source file` / `. file` / `bash|sh|zsh|dash|ksh [flags] script` 按目标路径判定，各模式可调：项目内（`runScriptInProject`）、项目外或 HOME（`runScriptOutside`）、内置保护路径（`runScriptProtected`）。你自定义的保护路径任何模式下都硬拦（含 naked），信任路径始终放行。目标带 `$VAR` 或通配符、解析不了时走 `scriptUnresolved`（strict 阻 / normal·loose 问 / trusted·naked 放），但同样先看字面尾巴：命中你的保护路径仍全模式硬拦，命中内置保护走 `runScriptProtected`，裸 `$VAR` 即使 trusted 也保持确认。
  **Run-script guard** — `source` / `.` / interpreter scripts are judged by target path, one rule each for in-project / outside / built-in protected. User-protected targets stay hard-blocked in every mode; trusted targets always pass. An unresolvable `$VAR`/glob target follows `scriptUnresolved`, with the literal tail still inspected first.
- **防绕过**：解析不了的变量/通配符路径一律确认（脚本与重定向目标走各自的 unresolved 规则，trusted/naked 例外）；命令替换 `$(...)`、反引号递归判定；复合命令里任何一段硬拦，整条命令就拦。
  **Bypass resistance** — unresolvable variable/wildcard paths always confirm (script and redirect targets follow their own unresolved rules, exempt only in trusted/naked); command substitutions are judged recursively; one hard block in a compound command blocks the whole thing.
- **更深一层防绕过**：命令名本身解析不了（`$CMD`、开头的 `$(echo rm)`）走 `commandNameUnresolved`（trusted/naked 放行）；`exec` 与前缀命令一样剥除；进程替换 `<(…)`/`>(…)` 和 heredoc 体（引号感知）递归判定；`sh < script.sh` 走运行脚本阶梯；`tar` 解压与 `unzip` 一样保守确认（naked 放行）；写块设备拦任何 `/dev/<dev>`，`/dev/null`、`/dev/tty` 等无害伪设备除外。
  **Deeper bypass resistance** — unresolvable command *names* follow `commandNameUnresolved` (trusted/naked pass); `exec` is stripped like a prefix; process substitution and heredoc bodies are judged recursively; `sh < script.sh` follows the run-script ladder; `tar` extraction confirms like `unzip` (pass in naked); block-device writes block any `/dev/<dev>` except harmless pseudo-devices like `/dev/null`.
- **拦截提示 / Escape hints**：每次拦截都附一条"如需执行 / To run anyway"建议：先建议只调触发的那条规则（`/guard rules`），其次才是放宽整个模式；内置保护路径建议换目标或先把文件拷出来；自定义保护路径建议先 `/guard paths rm` 移除保护、事后再加回；`/guard naked` 只在实在没辙时才提。
  Every block message appends a short hint: tune just the fired rule first, then loosen the mode; built-in protected paths suggest a different target or copying the file out; user-protected paths suggest removing the protection and re-adding it after; naked is only ever the last resort.
- **弹窗内会话级放行 / Session pass from the confirm dialog**：确认弹窗有第三个选项 `🔓 Allow & set <rule> = pass (session)`（命中多条规则时显示 `N rules`）。同一类操作反复弹窗时，就地放行即可，不用再开 `/guard rules`。放行只在本会话有效：不落盘，新会话恢复。`confirmGroup`（sudo / ssh / chmod 777）、系统级破坏命令、naked 模式下不提供此选项。
  Every confirm prompt offers a third option, `🔓 Allow & set <rule> = pass (session)` (`N rules` when several fired), so a repeated prompt can be silenced in place without opening `/guard rules`. The pass is in-memory only — never persisted, cleared on a new session. Not offered for `confirmGroup`, system-destructive commands, or in naked mode.

### Doctor / 诊断报告

`/guard doctor` 输出一份分层状态报告（纯文本，无 UI 会话也能用）。面板里 `/guard` → doctor 打开的是同一份报告，只读、可滚动：↑/↓ 逐行，PgUp/PgDn 翻页，隐藏内容标 `↑/↓ N more`，⏎/esc 返回。

`/guard doctor` prints a layered status report — pure text, so it works in headless sessions. Inside the panel (`/guard` → **doctor**) the same report opens read-only and scrollable: ↑/↓ moves a line, PgUp/PgDn pages, hidden content is marked `↑/↓ N more`, ⏎/esc goes back.

```text
/guard doctor
```

报告分节（为空时显示 `(none)`）：
Sections (each shows `(none)` when empty):

- **Mode** — 当前模式及其来源，优先级：项目层 → 手写 `.pi/settings.json` 块（仅在没有项目条目时）→ 全局设置 → 内置默认。
  the active mode and its source: project layer → hand-authored `.pi/settings.json` block (only when no project entry matched) → global settings → built-in default.
- **Layers** — 全局配置路径与项目条目文件（含命中方式 `exact` / `ancestor`），以及各层的模式/路径/规则计数；手写块作为只读回退展示；cwd 在 HOME 时会注明。
  the global settings path and the project entry file (with `exact` / `ancestor` match), per-layer counts, the hand-authored block as a read-only fallback, and a note when cwd is HOME.
- **Config warnings** — 每个问题一行，格式 `file: field: message`（JSON 损坏、未知规则、字段不匹配、被丢弃的相对路径）。
  one line per problem, `file: field: message`.
- **Protected paths / Trusted paths** — 原始路径 → 归一化路径 [所属层]。
  `raw → normalized [layer]`.
- **Session-pass rules** — 从确认弹窗临时放行的规则，标注"新会话清除、不落盘"。
  rules temporarily set to `pass` from a confirm dialog; cleared on a new session, never persisted.
- **Session** — 当前 cwd，HOME 下有标记。
  the cwd, with a marker when it is HOME.

**确认弹窗的三种放行 / Confirm-dialog scopes**：弹窗提供 🔓 选项时，选普通 **Allow** 只放行这一次；选 **Allow & set … = pass (session)** 放行到本会话结束（仅内存，新会话清除）。想永久放行，请直接改规则（`/guard rules` 或配置里的 `pathGuard.rules.{mode}.{rule}`）。sudo / ssh 这类（`confirmGroup`）从不提供会话放行——弹窗上会解释这是有意设计，每次都会再问。

When a prompt offers the 🔓 option, plain **Allow** releases only that one operation; **Allow & set … = pass (session)** releases the rule until the session ends (in memory, cleared next session). For a permanent change, edit the rule itself (`/guard rules`, or `pathGuard.rules.{mode}.{rule}` in settings.json). `sudo`/`ssh`-class prompts never offer a session pass — the dialog explains that asking every time is by design.

### Explain / 判定诊断

`/guard explain <command>` 展示这条命令会怎么被逐步判定——与真实判定走的是同一条路径，纯文本输出，无 UI 也能用，**命令不会被执行**。报告反映实时会话状态：当前模式及来源、会话放行、当前 cwd。无 UI 会话里，confirm 结果会如实注明会被直接阻止。

`/guard explain <command>` renders how a command would be judged, step by step — the same walk the real judgement takes. Pure text, works headless, and the command is **never executed**. It reflects the live session: active mode and source, session passes, cwd. In a no-UI session a confirm verdict honestly notes it would be blocked:

```text
/guard explain echo ok && rm "$TARGET"
```

```text
Config:  mode: strict (source: project) · session passes: none · cwd: /x
Trace:
  pass echo ok
  confirm rm "$TARGET" (rules: targetUnresolved)
Verdict: confirm (rules: targetUnresolved) — would prompt (no UI → blocked)
Hint:    tune just this rule first (/guard rules targetUnresolved = pass|block), or allow it for the rest of this session with a session pass (Allow & set … = pass (session)); loosening the whole mode (/guard loose|trusted) is a bigger step
```

- **Config** — 实时生效模式及来源（`project` / `authored` / `global` / `default`）、会话放行规则、解析后的 cwd（HOME 有标记）。
  the live mode with its source layer, session-pass rules, and the resolved cwd.
- **Trace** — 按判定顺序逐段列出结果：heredoc 逐行、管道进 shell 的扫描、然后每个复合命令段；`bash -c`、命令替换的递归按深度缩进，与真实判定一致。
  per-segment verdicts in evaluation order: heredoc bodies line by line, the pipe-to-shell scan, then each compound segment; recursion is indented by depth.
- **Verdict** — 与真实管线同样的聚合：有 block 则 block，否则有 confirm 则 confirm，否则 pass；列出命中的规则；无 UI 时注明 `would prompt (no UI → blocked)`。
  aggregated exactly like the pipeline, with the fired rule ids.
- **Hint** — 最窄的解除路径，按阶梯排序：先只调触发的规则（`/guard rules`），再考虑会话放行，最后才是放宽模式；内置保护路径建议换目标；naked 只作最后手段。
  the narrowest way through: tune the rule first, then a session pass, then mode loosening; built-in protected paths suggest a different target; naked is the last resort.

### 已知边界 / Known limitations

- **静态启发式，不是沙箱 / Static heuristics, not a sandbox。** 它只看 `bash` 命令文本和 `write`/`edit` 的目标路径，防的是**误操作**，不是恶意攻击或 prompt injection。跑不可信代码请用真正的沙箱 / 容器 / 虚拟机，并用最小权限账号。
  The guard inspects command text and target paths. It catches *accidental* destruction, not a determined adversary. Run untrusted code in a real sandbox under a least-privilege account.
- **面向 POSIX / POSIX-oriented。** 路径处理假设 POSIX 分隔符和 `/dev` 设备名，不支持 Windows。
  Path handling assumes POSIX separators and `/dev`-style device names. Windows is not a supported target.
- **不做静态展开 / What is not statically expanded。** 变量和通配符目标（`$F`、`*.log`）解析不了，一律保守确认，而不是去猜路径。例外：`source`/`.`/解释器脚本的脚本目标和重定向目标有各自的 unresolved 规则，但会先检查字面尾部（完全没有字面信息的裸 `$VAR` 仍然确认）。`~user` 不展开，但按项目外处理，不会被误当成项目内路径。别名、shell 函数、动态拼接后的 `eval`、超过 4 层的 `bash -c` / `$()` 嵌套，都不解析（过深 → 确认）。
  Variable/glob targets cannot be resolved, so they confirm instead of being followed — with the script-target and redirect-target exceptions noted above (a bare `$VAR` with no literal tail still confirms). `~user` is not expanded but is anchored outside the project. Aliases, shell functions, `eval` of dynamically built strings, and nesting beyond depth 4 are not resolved (too deep → confirm).
- **宁可误报 / Conservative by design。** 解析不了的目标会确认；无 UI 环境里，需要确认的操作直接阻止。偶尔误报难免，用 `/guard rules` 或信任路径调到你舒服为止。
  Unresolvable targets confirm; in a no-UI environment they are blocked instead. Expect the occasional false positive and tune it with `/guard rules` or trusted paths.
- **范围 / Scope。** 只守护 `bash` 与 `write`/`edit` 工具；网络、MCP、其他工具和扩展不在范围内。
  Only the `bash` and `write`/`edit` tools are guarded. Network access, MCP servers, other tools and extensions are out of scope.

## 开发与测试 / Development

测试加载真实扩展、用 mock 的 pi API 跑，共 727 条断言，覆盖：5 种模式 × 受保护路径 / 危险命令 / 截断 / git 破坏性 / 危险管道的判定矩阵，`/guard` 命令交互、trusted 确认、naked 两级确认、底部状态栏、settings.json 持久化、自定义保护路径（含 naked）、信任路径、运行脚本判定、重定向/下载/dd 目标判定、命令替换递归、按模式规则覆盖等。

The tests load the real extension with a mocked pi API — 727 assertions covering the mode × checkpoint matrix, `/guard` interactions, trusted/naked confirmations, the footer indicator, settings persistence, custom paths, script and redirect judging, command-substitution recursion, and per-mode rule overrides:

```bash
cd tests && PI_PACKAGES_ROOT=<pi 安装目录>/node_modules/@earendil-works \
  node --experimental-strip-types test-pathguard.ts
```

`PI_PACKAGES_ROOT` 指向本机 pi 安装里的 `@earendil-works` 包目录；不设的话测试找不到 `@earendil-works/pi-tui` 会报 `ERR_MODULE_NOT_FOUND`。

`PI_PACKAGES_ROOT` points at the `@earendil-works` package directory of your local pi install; without it the tests fail with `ERR_MODULE_NOT_FOUND` because they cannot find `@earendil-works/pi-tui`.

## 更新日志 / Changelog

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)（与 `package.json` 同步）；最新版本 **v1.11.1**。
See [CHANGELOG.md](CHANGELOG.md) for the full history (aligned with `package.json`); latest release **v1.11.1**.

## License

MIT © yaosu
