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

# npm (after publishing / 发布后): scope package
# pi install npm:@yaosu/pi-path-guard
```

After installing, run `/reload` or restart pi. 安装后 `/reload` 或重启 pi 生效。

## Usage / 使用

### `/guard` command

- `/guard` — interactive mode picker (title shows the full decision matrix; choices are bilingual) 交互式选择防护模式（标题展示完整判定矩阵，选项中英双语）
- `/guard <strict|normal|loose|trusted>` — quick switch (trusted requires a warning confirmation) 快捷切换（trusted 需警告确认）
- Invalid argument → falls back to the interactive picker 非法参数 → 兜底弹出交互选择
- Every new session resets to `normal` 每次新会话自动回到 `normal`

### Guard mode matrix / 防护模式矩阵

| Checkpoint / 判定点 | strict | normal | loose | trusted |
| --- | --- | --- | --- | --- |
| Protected paths (.env/.ssh/keys/credentials) / 受保护路径 | block | block | block | block |
| Block group (mkfs/reboot/block-device writes/bulk delete) / Block 组危险命令 | block | block | block | block |
| Confirm group (sudo/ssh/chmod 777 …) / Confirm 组 | block | confirm | confirm | confirm |
| git destructive (reset --hard/clean -f …) / git 破坏性 | confirm | confirm | confirm | confirm |
| In-project write/edit/new / 项目内写/改/新建 | confirm | pass | pass | pass |
| In-project delete / 项目内删除 | confirm | confirm | pass | pass |
| Outside write (new file) / 项目外写新文件 | confirm | confirm | pass | pass |
| Outside overwrite existing / 项目外覆盖已存在 | block | block | confirm | pass |
| Outside delete ordinary / 项目外删除普通文件 | block | block | confirm | pass |
| `>` truncate existing file / 截断已有文件 | confirm | confirm | confirm | confirm |
| cwd=HOME write / HOME 目录写 | confirm | confirm | pass | pass |
| No UI (headless) / 无交互界面 | block* | block* | block* | block* |

*block = denied directly, no confirmation opportunity / 直接阻止，无确认机会；confirm = prompt / 弹窗询问；pass = allow / 放行；\*headless: items that would be confirmed are blocked instead / 无 UI 时需确认项一律阻止

### Core capabilities / 核心能力

- **Protected-path interception / 受保护路径拦截**: `.env` / `.ssh` / `.aws` / `.kube` / private keys (`*.pem`/`*.key`) / credentials / shell configs (`.bashrc` …) / `node_modules` / `dist` / `build` … blocked hard in every mode — 任何模式下硬性阻止
- **Block group / Block 组危险命令**: `mkfs.*` / `mkswap` / `poweroff` / `reboot` / `shutdown` / `dd` to block devices / `> /dev/sdX` / `find -delete` / `find -exec rm` / `xargs rm`
- **Confirm group / Confirm 组**: `sudo` / `doas` / `pkexec` / `chmod 777` / `ssh` / `scp` / `sftp` / `rsh` / `telnet` / `wget -O /dev/null`
- **Overwrite detection / 覆盖检测**: `mv` / `cp` / `install` / `tee` / `ln -f` / `rsync --delete` on existing targets, classified by in/out project — 目标已存在时按内外策略处理
- **Redirect truncation / 重定向截断**: `> existing file` (incl. `2>` / `&>`, excluding `>>` and devices) → confirm
- **Shell wrapper recursion / shell 包装器递归**: strips `sudo`/`nohup`/`timeout`/`env` … prefixes, recurses into `bash -c` / `eval`; quote-aware tokenization — 前缀剥除后分析真实命令；引号感知分词
- **git destructive commands / git 破坏性命令**: `clean -f` / `reset --hard` / `checkout -- .` / `branch -D` / `push --force` / `stash drop`
- **Bypass resistance / 防绕过**: variable/wildcard paths that can't be statically resolved always confirm; any hard block in a compound command blocks the whole thing — 变量/通配符路径一律 confirm；复合命令任一段硬性阻止则整体阻止

## Development / 开发与测试

Automated tests (83 assertions) load the real extension with a mocked pi API, covering the 4 modes × protected paths / dangerous commands / truncation / git destructive matrix, plus `/guard` command interaction and trusted-mode confirmation flow:

```bash
cd tests && node --experimental-strip-types test-pathguard.ts
```

自动化测试（83 断言）模拟 pi API 加载真实扩展，覆盖 4 种模式 × 受保护路径 / 危险命令 / 截断 / git 破坏性等判定矩阵，以及 `/guard` 命令交互与 trusted 确认流程：

```bash
cd tests && node --experimental-strip-types test-pathguard.ts
```

## License

MIT © yaosu
