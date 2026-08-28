# pi-path-guard

Path Guard — pi 扩展：防误删 / 防误覆盖 / 防误改。

拦截 bash / write / edit 等工具调用中的破坏性操作：受保护路径（`.env`、`.ssh`、密钥、凭据等）、系统级破坏命令（mkfs/reboot/写块设备/批量删除等）、项目外覆盖/删除、`>` 截断已有文件等，按防护模式决定 **阻止 / 询问 / 放行**。

> ⚠️ **安全提示**：pi 扩展拥有完整系统权限，安装前请审阅源码（本项目源码开源，见 `extensions/path-guard.ts`）。

## 安装

```bash
# 方式一：本地目录
pi install /path/to/path-guard

# 方式二：临时试用（不写入 settings）
pi -e ./path-guard

# 方式三（发布后）：npm 或 git
pi install npm:pi-path-guard
pi install git:github.com/<user>/pi-path-guard@v1
```

安装后 `/reload` 或重启 pi 生效。

## 使用

### `/guard` 命令

- `/guard` — 交互式选择防护模式（标题展示完整判定矩阵，选项中英双语）
- `/guard <strict|normal|loose|trusted>` — 快捷切换（trusted 需警告确认）
- 非法参数 → 兜底弹出交互选择
- 每次新会话自动回到 `normal`

### 防护模式矩阵

| 判定点 | strict | normal | loose | trusted |
| --- | --- | --- | --- | --- |
| 受保护路径（.env/.ssh/密钥/凭据） | block | block | block | block |
| Block 组危险命令（mkfs/reboot/写块设备/批量删除） | block | block | block | block |
| Confirm 组（sudo/ssh/chmod 777 等） | block | confirm | confirm | confirm |
| git 破坏性（reset --hard/clean -f 等） | confirm | confirm | confirm | confirm |
| 项目内 write/edit/新建/重命名 | confirm | pass | pass | pass |
| 项目内删除 | confirm | confirm | pass | pass |
| 项目外写新文件 | confirm | confirm | pass | pass |
| 项目外覆盖已存在 | block | block | confirm | pass |
| 项目外删除普通文件 | block | block | confirm | pass |
| `>` 截断已有文件 | confirm | confirm | confirm | confirm |
| cwd=HOME 写 | confirm | confirm | pass | pass |
| 无 UI（headless） | 需确认项一律 block | 同左 | 同左 | 同左 |

block = 直接阻止（无确认机会）；confirm = 弹窗询问；pass = 放行。

### 核心能力

- **受保护路径拦截**：`.env` / `.ssh` / `.aws` / `.kube` / 密钥（`*.pem`/`*.key`）/ 凭据 / shell 配置（`.bashrc` 等）/ `node_modules` / `dist` / `build` 等，任何模式下硬性阻止
- **Block 组危险命令**：`mkfs.*` / `mkswap` / `poweroff` / `reboot` / `shutdown` / `dd` 写块设备 / `> /dev/sdX` / `find -delete` / `find -exec rm` / `xargs rm`
- **Confirm 组**：`sudo` / `doas` / `pkexec` / `chmod 777` / `ssh` / `scp` / `sftp` / `rsh` / `telnet` / `wget -O /dev/null`
- **覆盖检测**：`mv` / `cp` / `install` / `tee` / `ln -f` / `rsync --delete` 目标已存在时按内外策略处理
- **重定向截断**：`> 已有文件`（含 `2>` / `&>`，排除 `>>` 与设备）→ 询问
- **shell 包装器递归**：`bash -c` / `eval` / `sudo ...` 前缀剥除后分析真实命令；引号感知分词
- **git 破坏性命令**：`clean -f` / `reset --hard` / `checkout -- .` / `branch -D` / `push --force` / `stash drop`
- **防绕过**：变量/通配符路径无法静态解析时一律 confirm；复合命令任一段硬性阻止则整体阻止

## 开发与测试

自动化测试（83 断言）位于 `/home/yaosu/docs/plans/test-pathguard.ts`，模拟 pi API 加载真实扩展：

```bash
cd /home/yaosu/docs/plans && node --experimental-strip-types test-pathguard.ts
```

## License

MIT © yaosu
