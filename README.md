# pi-path-guard

**Path Guard — pi extension: prevents accidental deletes / overwrites / edits**
**Path Guard — pi 扩展：防误删 / 防误覆盖 / 防误改**

Intercepts destructive operations in tool calls (`bash`, `write`, `edit`): protected paths (`.env`, `.ssh`, keys, credentials, …), system-destructive commands (`mkfs`/`reboot`/block-device writes/bulk deletes, …), overwrites/deletes outside the project, and `>` truncation of existing files — deciding **block / confirm / pass** per guard mode.

拦截 `bash` / `write` / `edit` 等工具调用中的破坏性操作：受保护路径（`.env`、`.ssh`、密钥、凭据等）、系统级破坏命令（mkfs/reboot/写块设备/批量删除等）、项目外覆盖/删除、`>` 截断已有文件等，按防护模式决定 **阻止 / 询问 / 放行**。

> ⚠️ **Security notice / 安全提示**: pi extensions run with full system permissions and can execute arbitrary code. Review the source before installing (this project is open source — see `extensions/path-guard.ts`).
> pi 扩展拥有完整系统权限，可执行任意代码。安装前请审阅源码（本项目源码开源，见 `extensions/path-guard.ts`）。

## Install / 安装

```bash
# From git (recommended / 推荐)
pi install git:github.com/yaodashanren/pi-path-guard@v1

# Local directory (development / 本地目录，开发用)
pi install /path/to/pi-path-guard

# Try without installing (no settings change / 临时试用，不写入 settings)
pi -e ./pi-path-guard

# npm: scope package
# pi install npm:@yaosu/pi-path-guard
```

After installing, run `/reload` or restart pi. 安装后 `/reload` 或重启 pi 生效。

## Usage / 使用

### `/guard` command

- `/guard` — interactive main menu with three actions: **Switch mode** (title shows the full decision matrix; choices are bilingual), **Customize per-mode guard rules**, and **Manage custom protected paths**. The main menu loops: a sub-menu's **back** returns to the previous menu, and eventually back to this main menu; only cancelling at the top level (no selection) exits the command. 交互式主菜单，三个动作：**切换防护模式**（标题展示完整判定矩阵，选项中英双语）、**定制每模式守护规则**、**管理自定义受保护路径**。主菜单为循环：子菜单的 **back** 逐级返回上一级，最终回到本主菜单；只有顶层取消（不选）才退出命令
- `/guard` → **rules** sub-menu: pick a **mode** → the rule editor lists all 14 rules with their current levels; pick one → set **block / confirm / pass** (or reset to the built-in default). Stays in the editor so you can set several rules per mode before choosing **back**. Also offers a read-only full **overview** matrix in a scrollable viewer (↑/↓/PgUp/PgDn scroll, q/⏎/esc to close) and **reset** (clear all overrides). `pathGuard.rules.{mode}.{rule}` in settings.json. `/guard rules` 子菜单：选**模式** → 规则编辑器列出全部 14 条规则及其当前级别；选一条 → 设为 **block / confirm / pass**（或恢复内置默认）。改完停留在编辑器可连续改多条，再选 **back**。另提供只读 **overview** 全矩阵（可滚动查看，↑/↓/PgUp/PgDn 滚动，q/⏎/esc 关闭）与 **reset**（清空全部覆盖），存于 settings.json 的 `pathGuard.rules.{mode}.{rule}`
- `/guard <strict|normal|loose|trusted|naked>` — quick switch (trusted requires a warning; naked requires a double warning) 快捷切换（trusted 需警告确认；naked 需两级确认）
- Invalid argument → falls back to the interactive main menu 非法参数 → 兜底弹出交互主菜单
- The active mode persists across sessions via settings.json (`pathGuard.mode`): project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`, falling back to `normal`. `/guard <mode>` writes it back (project settings in a trusted project, else global). 模式跨会话持久化到 settings.json（`pathGuard.mode`）：项目 `.pi/settings.json` 优先于全局 `~/.pi/agent/settings.json`，缺省回 `normal`；`/guard <mode>` 切换时回写（受信任项目写项目配置，否则写全局）
- `/guard paths add|rm|list|clear <path>` — manage custom protected paths, enforced in EVERY mode (incl. naked) 管理自定义受保护路径，任何模式（含 naked）都生效
- The active mode is shown in the footer status bar (`🛡 <mode>`, `🛡 NAKED` in warning color) 当前模式显示在底部状态栏（`🛡 <mode>`，naked 用警示色 `🛡 NAKED`）

### Custom protected paths / 自定义受保护路径

```text
/guard paths list            # show configured custom protected paths 列出
/guard paths add <path>      # add one (absolute or ~/…; symlink-resolved) 新增
/guard paths rm <path>       # remove 移除
/guard paths clear           # clear all 清空
```

Custom paths are checked against the resolved real path and protected in every mode — even `naked` (built-in protected paths are NOT enforced in `naked`; only yours are). They are also settable statically:
自定义路径按解析后的真实路径匹配，且在任何模式下都被守护——包括 `naked`（内置受保护路径在 `naked` 下不生效，但你自定义的始终生效）。也可在 settings.json 静态配置：

```jsonc
"pathGuard": { "extraProtected": ["~/secrets", "/path/to/important.txt"] }
```

### Tunable rules / 可调规则

Each mode's judgement is a set of 12 rules; override any per mode in settings.json (`rule = "block" | "confirm" | "pass"`; invalid values are ignored):
每个模式的判定由 14 条规则组成；可在 settings.json 里按模式覆盖（`rule` 取 `"block"|"confirm"|"pass"`，非法值忽略）：

```jsonc
"pathGuard": {
  "mode": "normal",
  "rules": {
    "normal":  { "deleteOutside": "confirm", "confirmGroup": "pass" },
    "naked":   { "blockGroup": "block" }
  }
}
```

Rule IDs: `blockGroup`, `confirmGroup`, `writeOutside`, `writeHome`, `writeInProject`, `deleteOutside`, `deleteInProject`, `overwriteOutsideExisting`, `overwriteOutsideNew`, `overwriteInProject`, `truncate`, `gitDestructive`, `pipeToShellInProject`, `pipeToShellOutside`. Defaults reproduce the matrix above exactly.

### Guard mode matrix / 防护模式矩阵

| Checkpoint / 判定点 | strict | normal | loose | trusted | naked |
| --- | --- | --- | --- | --- | --- |
| Protected paths (.env/.ssh/keys/credentials) / 受保护路径 | block | block | block | block | pass |
| Block group (mkfs/reboot/block-device writes/bulk delete) / Block 组危险命令 | block | block | block | block | confirm |
| Confirm group (sudo/ssh/chmod 777 …) / Confirm 组 | block | confirm | confirm | confirm | pass |
| git destructive (reset --hard/clean -f …) / git 破坏性 | confirm | confirm | confirm | confirm | pass |
| In-project write/edit/new / 项目内写/改/新建 | confirm | pass | pass | pass | pass |
| In-project delete / 项目内删除 | confirm | confirm | pass | pass | pass |
| Outside write (new file) / 项目外写新文件 | confirm | confirm | pass | pass | pass |
| Outside overwrite existing / 项目外覆盖已存在 | block | block | confirm | pass | pass |
| Outside delete ordinary / 项目外删除普通文件 | block | block | confirm | pass | pass |
| `>` truncate existing file / 截断已有文件 | confirm | confirm | confirm | confirm | pass |
| Pipe to shell (in-workspace, curl…\|bash) / 管道到 shell（项目内） | confirm | pass | pass | pass | pass |
| Pipe to shell (remote/outside, curl…\|bash) / 管道到 shell（远程/项目外） | confirm | confirm | pass | pass | pass |
| cwd=HOME write / HOME 目录写 | confirm | confirm | pass | pass | pass |
| No UI (headless) / 无交互界面 | block* | block* | block* | block* | pass |

*block = denied directly, no confirmation opportunity / 直接阻止，无确认机会；confirm = prompt / 弹窗询问；pass = allow / 放行；\*headless: items that would be confirmed are blocked instead / 无 UI 时需确认项一律阻止

> ⚠️ **naked mode / 裸奔模式**: passes almost everything — protected paths, the write/edit tool checks, git destructive, truncation, outside deletes/overwrites all pass even with no UI. Only system-destructive commands (mkfs/reboot/bulk-delete/block-device writes) are still **confirmed**. Switching requires a **double confirmation** (two prompts). Use only when you want minimal path-guard interference.
> ⚠️ **裸奔模式**：除系统级破坏命令外几乎全部放行——受保护路径、write/edit 工具检查、git 破坏性、截断、外部删除/覆盖均放行，无 UI 下也放行；但系统级破坏命令（mkfs/reboot/批量删除/写块设备）仍会**弹窗询问**。切换需要**两级确认**（两次弹窗）。仅当你需要最少的路径守护干扰时使用。

### Core capabilities / 核心能力

- **Protected-path interception / 受保护路径拦截**: `.env` / `.ssh` / `.aws` / `.kube` / private keys (`*.pem`/`*.key`) / credentials / shell configs (`.bashrc` …) / `node_modules` / `dist` / `build` … blocked hard in every mode (except naked) — 任何模式下硬性阻止（naked 除外）
- **Block group / Block 组危险命令**: `mkfs.*` / `mkswap` / `poweroff` / `reboot` / `shutdown` / `dd` to block devices / `> /dev/sdX` / `find -delete` / `find -exec rm` / `xargs rm`
- **Confirm group / Confirm 组**: `sudo` / `doas` / `pkexec` / `chmod 777` / `ssh` / `scp` / `sftp` / `rsh` / `telnet` / `wget -O /dev/null`
- **Overwrite detection / 覆盖检测**: `mv` / `cp` / `install` / `tee` / `ln -f` / `rsync --delete` on existing targets, classified by in/out project — 目标已存在时按内外策略处理
- **Redirect truncation / 重定向截断**: `> existing file` (incl. `2>` / `&>`, excluding `>>` and devices) → confirm
- **Shell wrapper recursion / shell 包装器递归**: strips `sudo`/`nohup`/`timeout`/`env` … prefixes, recurses into `bash -c` / `eval`; quote-aware tokenization — 前缀剥除后分析真实命令；引号感知分词
- **git destructive commands / git 破坏性命令**: `clean -f` / `reset --hard` / `checkout -- .` / `branch -D` / `push --force` / `stash drop`
- **Dangerous pipe-to-shell / 危险管道到 shell**: `curl … \| bash` / `wget -qO- … \| sh` / `python -c '…' \| sh` — strict confirms at all positions; normal passes in-workspace and confirms remote/outside sources; other modes pass (per `pipeToShell*` rules) — 判定 `curl/wget` 等下载或解释器内联代码的输出被管道进 shell 执行
- **Bypass resistance / 防绕过**: variable/wildcard paths that can't be statically resolved always confirm; any hard block in a compound command blocks the whole thing — 变量/通配符路径一律 confirm；复合命令任一段硬性阻止则整体阻止

## Development / 开发与测试

Automated tests (143 assertions) load the real extension with a mocked pi API, covering the 5 modes × protected paths / dangerous commands / truncation / git destructive / dangerous pipe-to-shell matrix, plus `/guard` command interaction, trusted-mode confirmation, naked-mode double confirmation, the footer status indicator, settings.json mode persistence, custom protected paths (incl. naked), and per-mode rule overrides:

```bash
cd tests && node --experimental-strip-types test-pathguard.ts
```

自动化测试（143 断言）模拟 pi API 加载真实扩展，覆盖 5 种模式 × 受保护路径 / 危险命令 / 截断 / git 破坏性 / 危险管道到 shell 等判定矩阵，以及 `/guard` 命令交互、trusted 确认与 naked 两级确认、底部状态栏指示、settings.json 模式持久化、自定义受保护路径（含 naked）、按模式规则覆盖等流程：

```bash
cd tests && node --experimental-strip-types test-pathguard.ts
```

## License

MIT © yaosu
