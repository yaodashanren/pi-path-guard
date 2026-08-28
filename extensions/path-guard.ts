/**
 * Path Guard Extension v3 — 防误删 / 防误覆盖 / 防误改
 *
 * 以 path-guard-p620.ts 为基底，合并 path-guard-ayydesk.ts 的优势点并修复已知缺陷：
 *
 * v2 相对 p620 的新增/改进:
 *   1. 前缀命令剥除（sudo/doas/pkexec/env/nohup/command/builtin/time/nice/xargs/
 *      timeout/setsid/stdbuf/ionice/chroot/watch）→ 分析真实命令。
 *      修复 p620 对 "timeout 5 rm -rf /etc"、"nohup rm -rf x" 等直接放行的漏洞。
 *   2. git 破坏性命令检查（clean -f / reset --hard / checkout -- . / restore . /
 *      branch -D / push --force / stash drop），支持 -C/-c 等全局选项前缀。
 *      修复 p620 只拦 git clean 的漏洞。
 *   3. 块设备重定向正则去掉 \b 边界，修复 "echo x > /dev/sda"（空格写法）漏检。
 *   4. realpath 解析升级为"逐段向上找最近存在祖先"（ayydesk 方案），修复深层
 *      不存在路径经软链写穿到项目外的漏洞。
 *   5. mv/cp/install/tee/ln -f/rsync 目标存在性覆盖检测（含 -t 目标形式、
 *      tee -a 追加豁免、rsync --delete 确认）——项目内覆盖 → 询问，项目外 → 阻止。
 *   6. "> 已存在文件" 截断检测（含 2> / &>，排除 >> 追加与 /dev/null 等设备）→ 询问。
 *   7. write/edit 先解析 cwd 真实路径再判内外，修复符号链接 cwd 下项目内写操作
 *      被误判为项目外的假阳性。
 *
 * 保留 p620 的全部能力:
 *   - 受保护路径拦截（.env / .ssh / 密钥 / 凭据，不区分项目内外）
 *   - shell 包装器递归（bash -c / eval，深度受限）；source / . 保守确认
 *   - dd / curl -o / wget -O / truncate / sed -i / perl -i / ruby -i / unzip -o 判定
 *   - 危险命令正则（sudo / chmod 777 / ssh / find -delete / mkfs 等）
 *   - 复合命令分段汇总，fail-safe：任一硬性阻止 → 整体阻止
 *   - 引号感知的分词（单引号/双引号正确处理）
 *
 * v3 新增（自 v2 升级）：防护模式（/guard 命令，会话内切换，新会话回到 normal）
 *   - strict   全防护：项目内写操作也询问；Confirm 组危险命令直接阻止
 *   - normal   默认：Block 组危险命令直接阻止，Confirm 组询问
 *   - loose    放宽：项目内/外新建与删除免问（覆盖已存在仍需确认）
 *   - trusted  最宽松：覆盖/删除普通文件也免问
 *   - 受保护路径（凭据/配置/密钥）与 Block 组（格式化/关机/批量删除/写块设备）
 *     在任何模式下都直接阻止，无确认机会
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	BashToolInput,
	EditToolInput,
	WriteToolInput,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	resolve,
	normalize,
	relative as relativePath,
	join,
	dirname,
	basename,
	sep,
} from "node:path";
import { homedir } from "node:os";
import { realpathSync, existsSync, statSync } from "node:fs";

// ─── 配置 ───────────────────────────────────────────────────────────

/** 受保护路径片段 — 命中则阻止写/编辑 */
const PROTECTED_PATH_PATTERNS = [
	".env",
	".git/",
	".ssh/", // SSH 配置与密钥
	// HOME 级凭据/配置（bash 重定向/覆盖、write 工具均拦截）
	".aws/", // AWS 凭据
	".kube/", // Kubernetes 管理配置
	".docker/", // Docker 登录凭据
	".gnupg/", // GPG 密钥
	".git-credentials", // 明文 git 凭据
	".npmrc", // npm 令牌
	".pypirc", // PyPI 令牌
	".netrc", // 通用登录凭据
	".bashrc", // shell 配置（持久化/后门向量）
	".zshrc",
	".profile",
	".bash_profile",
	"credentials", // 项目内凭据文件
	"*.pem", // 私钥（后缀匹配）
	"*.key", // 私钥（后缀匹配）
	"node_modules/",
	".next/",
	".nuxt/",
	".cache/",
	"dist/",
	"build/",
	"coverage/",
	"__pycache__/",
	".pytest_cache/",
	"target/",
	"vendor/", // Go vendor / PHP composer
];

/** Block 组危险命令 — 系统级破坏，任何模式直接阻止（无确认机会） */
const BLOCK_DANGEROUS_PATTERNS: RegExp[] = [
	/\bmkfs\./,
	/\bmkswap\b/,
	/\bpoweroff\b/,
	/\breboot\b/,
	/\bshutdown\b/,
	/\binit\s+0\b/,
	/\binit\s+6\b/,
	/\bdd\b[^;|&]*\bof=\s*\/dev\/(sda|sdb|sdc|nvme|mmcblk)/, // dd 直接写块设备（写普通文件由 judgeDd 拦）
	/(>|>>)\s*\/dev\/(sda|sdb|sdc|nvme|mmcblk)/, // 直接写入块设备（注意：不能用 \b，> 前常为空格）
	/\bfind\b[^;|&]*-delete\b/, // find ... -delete 批量删除
	/\bfind\b[^;|&]*-exec(dir)?\b[^;|&]*\brm\b/, // find ... -exec rm 批量删除
	/\bxargs\b[^;|&]*\brm\b/, // xargs rm 批量删除（judgeGit 之外的双保险）
];

/** Confirm 组危险命令 — 提权/远程/危险权限：strict 阻止，normal/loose/trusted 询问 */
const CONFIRM_DANGEROUS_PATTERNS: RegExp[] = [
	/\bsudo\b/,
	/\b(doas|pkexec)\b/,
	/\b(chmod|chown)\b.*777/,
	/(?<!\.)\b(ssh|scp|sftp|rsh|telnet)\b/, // 远程执行/远程操作（lookbehind 避免误伤 ~/.ssh/ 等路径）
	/\bwget\s+-O\s+\/dev\/null\b/, // 下载直接丢弃（无害但保守）
];

/** 需要特殊处理的删除命令 */
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "wipe"]);

/** 覆盖类命令 — 默认会覆盖已存在的目标文件（ln 需 -f/--force，单独特判） */
const OVERWRITE_COMMANDS = new Set([
	"mv",
	"cp",
	"install",
	"tee",
	"ln",
	"rsync",
]);

/** 就地编辑命令（-i 原地改写） */
const INPLACE_EDITORS = new Set(["sed", "perl", "ruby"]);

/** shell 包装器：-c 参数是内联代码，需递归检查 */
const SHELL_WRAPPERS = new Set([
	"bash",
	"sh",
	"zsh",
	"ksh",
	"dash",
	"fish",
	"csh",
	"tcsh",
]);

/** 前缀命令：剥除后检查真实命令 */
const PREFIX_COMMANDS = new Set([
	"sudo",
	"doas",
	"pkexec",
	"env",
	"nohup",
	"command",
	"builtin",
	"time",
	"nice",
	"xargs",
	"timeout",
	"setsid",
	"stdbuf",
	"ionice",
	"chroot",
	"watch",
]);

/** 前缀命令中带参数值的 flag（剥除时需多跳一个 token） */
const FLAGS_WITH_ARG = new Set(["-u", "--user", "-g", "--group"]);

/** 输出重定向到这些设备不算破坏性截断 */
const DEVICE_TARGETS = new Set([
	"/dev/null",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/tty",
	"/dev/zero",
]);

const HOME = homedir();

// ─── 防护模式 ─────────────────────────────────────────────────────

/** 防护模式：strict 全防护 / normal 默认 / loose 放宽 / trusted 最宽松 */
type GuardMode = "strict" | "normal" | "loose" | "trusted";

/** 当前会话的防护模式（/guard 命令切换，session_start 重置为 normal） */
let currentMode: GuardMode = "normal";

/** 合法模式集合 */
const GUARD_MODES: readonly GuardMode[] = [
	"strict",
	"normal",
	"loose",
	"trusted",
];

/** 是否为合法模式（供 /guard 命令参数校验） */
function isGuardMode(m: string): m is GuardMode {
	return (GUARD_MODES as readonly string[]).includes(m);
}

/** 模式描述（/guard 交互式选项展示，英文在前） */
const MODE_DESCRIPTIONS: Record<GuardMode, string> = {
	strict:
		"Strict: confirm in-project writes, block dangerous commands / 全防护：项目内写也询问，危险命令直接阻止",
	normal:
		"Normal: block system-destructive commands, confirm sudo/ssh / 默认：系统级破坏直接阻止，提权/远程询问",
	loose:
		"Loose: pass new-file writes & deletes, confirm overwrites / 放宽：新建/删除免问，覆盖需确认",
	trusted:
		"Trusted: pass overwrites & ordinary-file deletes / 最宽松：覆盖/删除普通文件也免问",
};

/** 详细判定矩阵（/guard 交互式选择标题展示，全英文） */
const MODE_MATRIX = [
	"Path Guard Mode Matrix (B=block / ?=confirm / .=pass)",
	"  Checkpoint                          strict  normal  loose  trusted",
	"  Protected paths .env/.ssh/keys         B       B       B       B",
	"  System-destructive mkfs/reboot         B       B       B       B",
	"  Privilege/remote sudo/ssh/chmod777     B       ?       ?       ?",
	"  Git destructive reset --hard           ?       ?       ?       ?",
	"  In-project write/edit/new              ?       .       .       .",
	"  In-project delete                      ?       ?       .       .",
	"  Outside write (new file)               ?       ?       .       .",
	"  Outside overwrite existing             B       B       ?       .",
	"  Outside delete ordinary                B       B       ?       .",
	"  Truncate existing > file               ?       ?       ?       ?",
	"  HOME dir write                         ?       ?       .       .",
	"  No UI (headless)                       B       B       B       B",
].join("\n");

/** 守卫判定结果：{ block, reason } 阻止 / undefined 放行（askConfirm 返回 Promise） */
type GuardVerdict =
	| ToolCallEventResult
	| undefined
	| Promise<ToolCallEventResult | undefined>;

// ─── 主入口 ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// 每次新会话回到 normal（启动 / /new / /resume 均触发 session_start）
	pi.on("session_start", () => {
		currentMode = "normal";
	});

	// /guard 斜杠命令：查看 / 切换防护模式
	pi.registerCommand("guard", {
		description:
			"Path Guard 模式: /guard 查看当前, /guard <strict|normal|loose|trusted> 切换",
		handler: async (args, ctx) => {
			const m = args?.trim().toLowerCase() ?? "";

			// 带合法参数 → 直接切换（快捷方式，不弹窗）；trusted 需警告确认
			if (isGuardMode(m)) {
				if (m === "trusted" && !(await confirmTrustedSwitch(ctx))) {
					ctx.ui.notify("已取消：trusted 模式需确认后切换", "info");
					return;
				}
				currentMode = m;
				ctx.ui.notify(
					`Path Guard 已切换: ${m}（本会话生效，新会话回到 normal）`,
					"info",
				);
				return;
			}

			// 无 UI → 无法交互，仅显示当前模式
			if (!ctx.hasUI) {
				ctx.ui.notify(`Path Guard 当前模式: ${currentMode}`, "info");
				return;
			}

			// 交互式选择（无参或参数不合法时兜底）：标题展示详细矩阵，选项选择模式
			const choices = GUARD_MODES.map(
				(mo) =>
					`${mo} — ${MODE_DESCRIPTIONS[mo]}${mo === currentMode ? "（当前）" : ""}`,
			);
			const chosen = await ctx.ui.select(
				`${MODE_MATRIX}\n\nCurrent mode: ${currentMode} — choose one:`,
				choices,
			);
			if (!chosen) {
				ctx.ui.notify("已取消，模式保持不变", "info");
				return;
			}
			const picked = chosen.split(/\s+/)[0] as GuardMode;
			if (isGuardMode(picked)) {
				if (picked === "trusted" && !(await confirmTrustedSwitch(ctx))) {
					ctx.ui.notify("已取消：trusted 模式需确认后切换", "info");
					return;
				}
				currentMode = picked;
				ctx.ui.notify(
					`Path Guard 已切换: ${picked}（本会话生效，新会话回到 normal）`,
					"info",
				);
			}
		},
	});

	pi.on("tool_call", (event, ctx) => {
		// ── write / edit ──────────────────────────────────────────
		if (event.toolName === "write" || event.toolName === "edit") {
			return checkWriteEdit(event.input as WriteToolInput | EditToolInput, ctx);
		}

		// ── bash ────────────────────────────────────────────────
		if (event.toolName === "bash") {
			return checkBashCommand(event.input as BashToolInput, ctx);
		}
	});
}

/** write/edit 守卫：受保护 → 阻止；项目外 / cwd 即 HOME → 弹窗 */
function checkWriteEdit(
	input: WriteToolInput | EditToolInput,
	ctx: ExtensionContext,
): GuardVerdict {
	const path = input.path;
	if (!path) return;

	// 先解析 cwd 真实路径（cwd 本身可能是软链），再解析目标真实路径，
	// 防止经项目内软链接写穿到外部受保护位置，也避免软链 cwd 假阳性
	const realCwd = resolveReal(ctx.cwd);
	const real = resolveReal(resolve(realCwd, expandHome(path)));

	// ① 受保护路径（含 HOME 级凭据/配置，不区分项目内外）→ 直接阻止
	if (matchesProtectedPath(real)) {
		return {
			block: true,
			reason: `路径 "${real}" 受保护，已阻止写入。`,
		};
	}

	// ② 项目目录外 → strict/normal 弹窗；loose/trusted 放行（对真实路径判定，软链接指向外部也会命中）
	if (isOutsideCwd(real, realCwd)) {
		if (currentMode === "loose" || currentMode === "trusted") return;
		return askConfirm(
			ctx,
			`⚠️ 文件路径在项目目录之外\n\n路径: ${real}\n项目: ${realCwd}`,
		);
	}

	// ③ cwd 即 HOME（写入落在 HOME 下）→ strict/normal 弹窗；loose/trusted 放行
	if (realCwd === HOME) {
		if (currentMode === "loose" || currentMode === "trusted") return;
		return askConfirm(
			ctx,
			`⚠️ HOME 目录下的写操作\n\n路径: ${real}\nHOME: ${HOME}\n\n确认写入？`,
		);
	}

	// ④ 项目内 → strict 全量询问；其余模式放行
	if (currentMode === "strict") {
		return askConfirm(
			ctx,
			`⚠️ strict 模式：项目内写操作\n\n路径: ${real}\n\n确认写入？`,
		);
	}

	return; // 项目内且安全，放行
}

/** bash 守卫：分段扫描汇总后统一判定（防止 "rm -rf safe && sudo reboot" 分段绕过） */
function checkBashCommand(
	input: BashToolInput,
	ctx: ExtensionContext,
): GuardVerdict {
	const command = input.command ?? "";
	if (!command.trim()) return;

	const realCwd = resolveReal(ctx.cwd);

	// 先按 &&、||、;、|、换行 分段，逐段检查并汇总结果，
	// 全部扫描完再统一判定 —— 避免首个守卫分段就 return 导致后续分段绕过
	const blockReasons: string[] = [];
	const confirmNeeded: string[] = [];

	for (const seg of splitSegments(command)) {
		const trimmed = seg.trim();
		if (!trimmed) continue;

		const verdict = classifySegment(trimmed, realCwd, ctx.hasUI);
		if (verdict.kind === "block") {
			blockReasons.push(verdict.reason);
		} else if (verdict.kind === "confirm") {
			confirmNeeded.push(trimmed);
		}
	}

	// 汇总判定：任一硬性阻止 → 整体阻止（fail-safe）
	if (blockReasons.length > 0) {
		return {
			block: true,
			reason: `命令被阻止:\n${blockReasons.join("\n")}`,
		};
	}
	// 有需确认的分段 → 弹窗一次，统一确认
	if (confirmNeeded.length > 0) {
		return askConfirm(
			ctx,
			`⚠️ 需要确认的命令\n\n${confirmNeeded
				.map((s) => `· ${s}`)
				.join("\n")}\n\n确认执行？`,
		);
	}
	return; // 安全命令，放行
}

/** 单个分段的判定结果 */
type SegmentVerdict =
	| { kind: "block"; reason: string }
	| { kind: "confirm" }
	| { kind: "pass" };

/** 逐段判定：受保护重定向 → block；危险命令 → confirm/block；其余交子判定/包装器递归 */
function classifySegment(
	trimmed: string,
	realCwd: string,
	hasUI: boolean,
	depth = 0,
): SegmentVerdict {
	// 递归深度保护（bash -c / eval 嵌套过深 → 无法静态检查，保守确认）
	if (depth > 4) return { kind: "confirm" };

	// ① 重定向检查：
	//    - 写入受保护路径（echo x > .env 之类）→ 直接阻止
	//    - "> 已存在文件"（截断，非 >> 追加、非设备）→ 弹窗确认
	const redirect = extractRedirectTarget(trimmed);
	if (redirect) {
		const real = resolveReal(resolve(realCwd, expandHome(redirect.target)));
		if (matchesProtectedPath(real)) {
			return {
				kind: "block",
				reason: `重定向写入受保护路径: ${trimmed}`,
			};
		}
		if (
			isTruncatingOp(redirect.op) &&
			!DEVICE_TARGETS.has(redirect.target) &&
			existsSync(real)
		) {
			return { kind: "confirm" };
		}
	}

	// ② 危险命令：
	//    - Block 组（格式化/关机/批量删除/写块设备）→ 任何模式直接阻止
	//    - Confirm 组（sudo/ssh/chmod 777）→ strict 阻止，其余模式询问
	const danger = dangerousLevel(trimmed);
	if (danger === "block") {
		return {
			kind: "block",
			reason: `系统级破坏命令已阻止: ${trimmed}`,
		};
	}
	if (danger === "confirm") {
		if (currentMode === "strict") {
			return {
				kind: "block",
				reason: `危险命令已阻止（strict 模式）: ${trimmed}`,
			};
		}
		return hasUI
			? { kind: "confirm" }
			: { kind: "block", reason: `危险命令已阻止（无交互界面）: ${trimmed}` };
	}

	const cmdInfo = parseCommand(trimmed);
	if (!cmdInfo) return { kind: "pass" };

	// ③ shell 包装器（bash -c 'code' / eval 'code'）→ 递归检查内层代码
	const wrapperVerdict = judgeShellWrapper(
		trimmed,
		cmdInfo,
		realCwd,
		hasUI,
		depth,
	);
	if (wrapperVerdict.kind !== "pass") return wrapperVerdict;

	// ④ source / .：执行脚本文件，内容不可静态解析 → 保守确认
	if (cmdInfo.command === "source" || cmdInfo.command === ".") {
		return { kind: "confirm" };
	}

	// ⑤-⑪ 目标型写命令流水线（git / dd / 下载 / truncate / 就地编辑 / 删除 / 覆盖 / unzip -o）
	return judgeWriters(trimmed, cmdInfo, realCwd);
}

/** shell 包装器判定：bash -c / eval 内层代码递归执行同一套检查，汇总后返回 */
function judgeShellWrapper(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
	hasUI: boolean,
	depth: number,
): SegmentVerdict {
	const inner = unwrapShellWrapper(cmdInfo);
	if (!inner) return { kind: "pass" };

	const blockReasons: string[] = [];
	const confirmNeeded: string[] = [];
	for (const seg of splitSegments(inner)) {
		const s = seg.trim();
		if (!s) continue;
		const v = classifySegment(s, realCwd, hasUI, depth + 1);
		if (v.kind === "block") blockReasons.push(v.reason);
		else if (v.kind === "confirm") confirmNeeded.push(s);
	}
	if (blockReasons.length > 0) {
		return {
			kind: "block",
			reason: `内层命令被阻止:\n${blockReasons.join("\n")}`,
		};
	}
	if (confirmNeeded.length > 0) return { kind: "confirm" };
	return { kind: "pass" };
}

/** 目标型写命令流水线：逐个判定，任一非 pass 立即返回；全部通过才放行 */
function judgeWriters(
	trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	const pipeline: Array<(t: string, c: CmdInfo, r: string) => SegmentVerdict> = [
		judgeGit,
		judgeDd,
		judgeDownload,
		judgeTruncate,
		judgeInPlace,
		judgeDelete,
		judgeOverwrite,
	];
	for (const judge of pipeline) {
		const v = judge(trimmed, cmdInfo, realCwd);
		if (v.kind !== "pass") return v;
	}
	// 解压强制覆盖（unzip -o）：归档内容不可预知 → 保守确认
	if (cmdInfo.command === "unzip" && hasShortFlag(cmdInfo.args, "o")) {
		return { kind: "confirm" };
	}
	return { kind: "pass" };
}

/** git 破坏性命令判定：clean -f / reset --hard / checkout -- . / restore . / branch -D / push --force / stash drop */
function judgeGit(
	_trimmed: string,
	cmdInfo: CmdInfo,
	_realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "git") return { kind: "pass" };

	const args = cmdInfo.args;
	// 跳过 git 全局选项（-C dir / -c key=val / --git-dir= 等），取子命令
	let i = 0;
	while (i < args.length) {
		const a = args[i];
		if (a === "-C" || a === "-c") {
			i += 2;
			continue;
		}
		if (
			a.startsWith("--git-dir=") ||
			a.startsWith("--work-tree=") ||
			a === "--bare" ||
			a === "--no-pager" ||
			a === "--paginate"
		) {
			i++;
			continue;
		}
		break;
	}
	const sub = args[i];

	if (sub === "clean" && hasForceFlag(args)) return { kind: "confirm" }; // -f/-fd/-fdx/--force
	if (sub === "reset" && args.includes("--hard")) return { kind: "confirm" };
	if (sub === "checkout" && (args.includes("--") || args.includes(".")))
		return { kind: "confirm" };
	if (sub === "restore" && (args.includes(".") || args.includes("--source")))
		return { kind: "confirm" };
	if (sub === "branch" && args.some((a) => a === "-D"))
		return { kind: "confirm" };
	if (
		sub === "push" &&
		args.some((a) => a === "-f" || a === "--force" || a === "--force-with-lease")
	)
		return { kind: "confirm" };
	if (sub === "stash" && args.includes("drop")) return { kind: "confirm" };

	return { kind: "pass" };
}

/** 删除类命令判定（rm, rmdir, shred 等）；非删除命令 → pass */
function judgeDelete(
	trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!isDeleteCommand(cmdInfo.command)) return { kind: "pass" };

	// 查询类（command -v rm / rm --version 等，无路径参数）→ 放行
	if (
		cmdInfo.args.every((a) => a.startsWith("-")) &&
		/(-v|-V|--version|-h|--help)\b/.test(trimmed)
	) {
		return { kind: "pass" };
	}

	const pathArgs = extractPathArgs(cmdInfo.args, realCwd);

	// 受保护路径优先：任何模式都阻止（trusted 下删除外部普通文件前先过滤受保护）
	for (const p of pathArgs) {
		if (matchesProtectedPath(p.path)) {
			return {
				kind: "block",
				reason: `删除命令涉及受保护路径: ${p.path}`,
			};
		}
	}

	// 找不到具体路径（rm "$HOME/.ssh"、rm ./* 等变量/通配符，无法静态解析）→ 保守确认（所有模式）
	if (pathArgs.length === 0) {
		return { kind: "confirm" };
	}

	const externalPaths = pathArgs.filter((p) => p.isOutside);
	if (externalPaths.length > 0) {
		const list = externalPaths.map((p) => p.path).join(", ");
		// trusted → 放行（普通文件，受保护已过滤）；loose → 询问；strict/normal → 阻止
		if (currentMode === "trusted") return { kind: "pass" };
		if (currentMode === "loose") return { kind: "confirm" };
		return {
			kind: "block",
			reason: `删除命令涉及项目目录外的路径: ${list}`,
		};
	}

	// 项目内删除：strict/normal → 确认；loose/trusted → 放行
	if (currentMode === "loose" || currentMode === "trusted") {
		return { kind: "pass" };
	}
	return { kind: "confirm" };
}

/**
 * 覆盖类命令判定（mv/cp/install/tee/ln -f/rsync）：
 *   - 目标命中受保护路径 → 阻止
 *   - 目标已存在（文件，或目录且有 basename 冲突）→ 项目内确认 / 项目外阻止
 *   - 目标不存在 → 项目外写入确认 / 项目内放行（纯重命名/新建）
 *   - -n/--no-clobber（明确不覆盖）、ln 无 -f、tee -a（追加）→ 放行
 */
function judgeOverwrite(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!OVERWRITE_COMMANDS.has(cmdInfo.command)) return { kind: "pass" };

	// ln 只有在带 -f/--force 时才会覆盖已存在目标
	if (cmdInfo.command === "ln" && !hasForceFlag(cmdInfo.args)) {
		return { kind: "pass" };
	}
	// -n/--no-clobber：明确不覆盖，安全放行
	if (cmdInfo.args.includes("-n") || cmdInfo.args.includes("--no-clobber")) {
		return { kind: "pass" };
	}
	// tee -a / --append：追加不覆盖
	if (
		cmdInfo.command === "tee" &&
		(cmdInfo.args.includes("-a") || cmdInfo.args.includes("--append"))
	) {
		return { kind: "pass" };
	}
	// rsync --delete：删除目标目录中多余文件 → 保守确认
	if (cmdInfo.command === "rsync" && cmdInfo.args.includes("--delete")) {
		return { kind: "confirm" };
	}

	// 解析目标：-t dir src... 形式 vs 常规形式（最后一个 operand 为目标）
	let target: string | null = null;
	let sources: string[] = [];
	const tIdx = cmdInfo.args.indexOf("-t");
	if (tIdx >= 0 && cmdInfo.args[tIdx + 1]) {
		target = cmdInfo.args[tIdx + 1];
		sources = cmdInfo.args.filter((a) => !a.startsWith("-") && a !== target);
	} else {
		const operands = cmdInfo.args.filter((a) => !a.startsWith("-"));
		if (operands.length >= 2) {
			target = operands[operands.length - 1];
			sources = operands.slice(0, -1);
		}
	}
	if (!target || sources.length === 0) return { kind: "pass" };

	// 变量/通配符无法静态解析 → 保守确认
	if (target.startsWith("$") || target.includes("*") || target.includes("?")) {
		return { kind: "confirm" };
	}

	const real = resolveReal(resolve(realCwd, expandHome(target)));
	// ① 目标命中受保护路径 → 直接阻止
	if (matchesProtectedPath(real)) {
		return {
			kind: "block",
			reason: `命令可能覆盖受保护路径: ${cmdInfo.command} ${target}`,
		};
	}

	const outside = isOutsideCwd(real, realCwd);

	// 项目外覆盖已存在目标：normal/strict → block；loose → confirm；trusted → pass
	const outsideOverwriteVerdict = (): SegmentVerdict => {
		if (currentMode === "trusted") return { kind: "pass" };
		if (currentMode === "loose") return { kind: "confirm" };
		return {
			kind: "block",
			reason: `命令将覆盖项目目录外的目标: ${cmdInfo.command} ${target}`,
		};
	};

	// ② 目标是已存在目录：检查每个源 basename 是否有冲突
	if (existsSync(real) && isDirectory(real)) {
		const conflict = sources.some((s) => {
			// 源无法静态解析 → 保守视为冲突
			if (s.startsWith("$") || s.includes("*") || s.includes("?")) return true;
			const srcReal = resolveReal(resolve(realCwd, expandHome(s)));
			return existsSync(join(real, basename(srcReal)));
		});
		if (!conflict) return { kind: "pass" };
		// 覆盖已存在目标：项目外按模式，项目内确认（覆盖类最差也是 confirm）
		return outside ? outsideOverwriteVerdict() : { kind: "confirm" };
	}

	// ③ 目标是已存在文件：会被覆盖
	if (existsSync(real)) {
		return outside ? outsideOverwriteVerdict() : { kind: "confirm" };
	}

	// ④ 目标不存在：项目外 → normal/strict 确认、loose/trusted 放行；
	//    项目内 → strict 确认、其余放行（纯重命名/新建）
	if (outside) {
		return currentMode === "loose" || currentMode === "trusted"
			? { kind: "pass" }
			: { kind: "confirm" };
	}
	return currentMode === "strict" ? { kind: "confirm" } : { kind: "pass" };
}

/** shell 包装器解包：bash/sh/zsh -c 'code'、eval 'code' → 返回内层代码；否则 null */
function unwrapShellWrapper(cmdInfo: CmdInfo): string | null {
	if (SHELL_WRAPPERS.has(cmdInfo.command)) {
		for (let i = 0; i < cmdInfo.args.length; i++) {
			const a = cmdInfo.args[i];
			if (a === "--") break; // 之后的都不是 flag
			// 短 flag 含 c（-c、-ec 等组合）；长 flag 不算
			if (a.startsWith("-") && !a.startsWith("--") && a.includes("c")) {
				const inner = cmdInfo.args.slice(i + 1).join(" ");
				return inner.trim() || null;
			}
		}
		return null;
	}
	if (cmdInfo.command === "eval") {
		const inner = cmdInfo.args.join(" ");
		return inner.trim() || null;
	}
	return null;
}

/** 是否带短 flag（支持 -i.bak / -pi 等组合；仅单横线形式） */
function hasShortFlag(args: string[], ch: string): boolean {
	return args.some(
		(a) => a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes(ch),
	);
}

/** 是否带长 flag（--name 或 --name=value） */
function hasLongFlag(args: string[], name: string): boolean {
	return args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

/** dd 判定：of= 指向受保护文件 → 阻止（写块设备由危险模式覆盖） */
function judgeDd(
	trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "dd") return { kind: "pass" };
	for (const a of cmdInfo.args) {
		if (!a.startsWith("of=")) continue;
		const target = a.slice(3);
		if (!target) continue;
		if (target.startsWith("$") || target.includes("*") || target.includes("?")) {
			return { kind: "confirm" };
		}
		const real = resolveReal(resolve(realCwd, expandHome(target)));
		if (matchesProtectedPath(real)) {
			return { kind: "block", reason: `dd 写入受保护路径: ${trimmed}` };
		}
	}
	return { kind: "pass" };
}

/** curl/wget 判定：输出目标命中受保护路径 → 阻止 */
function judgeDownload(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "curl" && cmdInfo.command !== "wget") {
		return { kind: "pass" };
	}
	const target = downloadTarget(cmdInfo.command, cmdInfo.args);
	if (!target) return { kind: "pass" };
	if (target.startsWith("$") || target.includes("*") || target.includes("?")) {
		return { kind: "confirm" };
	}
	const real = resolveReal(resolve(realCwd, expandHome(target)));
	if (matchesProtectedPath(real)) {
		return {
			kind: "block",
			reason: `下载写入受保护路径: ${cmdInfo.command} ${target}`,
		};
	}
	return { kind: "pass" };
}

/** 提取下载命令的输出目标；无显式目标则 null */
function downloadTarget(command: string, args: string[]): string | null {
	return command === "wget"
		? wgetDownloadTarget(args)
		: curlDownloadTarget(args);
}

/** wget 输出目标（-O / --output / --output-document 均带参数） */
function wgetDownloadTarget(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-O" || a === "--output" || a === "--output-document") {
			return args[i + 1] ?? null;
		}
		if (a.startsWith("--output=") || a.startsWith("--output-document=")) {
			return a.slice(a.indexOf("=") + 1);
		}
	}
	return null;
}

/** curl 输出目标（-o / --output 带参数；-O 无参数，取 URL basename） */
function curlDownloadTarget(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-o" || a === "--output" || a === "--output-document") {
			return args[i + 1] ?? null;
		}
		if (a.startsWith("--output=") || a.startsWith("--output-document=")) {
			return a.slice(a.indexOf("=") + 1);
		}
		if (a === "-O") {
			for (let j = i + 1; j < args.length; j++) {
				const u = args[j];
				if (u.startsWith("-")) continue;
				const base = u.split("/").pop();
				if (base) return base;
				break;
			}
		}
	}
	return null;
}

/** truncate 判定：目标命中受保护路径 → 阻止；目标已存在（非设备）→ 确认 */
function judgeTruncate(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "truncate") return { kind: "pass" };
	// 存在无法静态解析的目标（变量/通配符）→ 保守确认
	if (
		cmdInfo.args.some(
			(a) =>
				!a.startsWith("-") &&
				(a.startsWith("$") || a.includes("*") || a.includes("?")),
		)
	) {
		return { kind: "confirm" };
	}
	for (const t of extractPathArgs(cmdInfo.args, realCwd)) {
		if (matchesProtectedPath(t.path)) {
			return { kind: "block", reason: `truncate 截断受保护路径: ${t.raw}` };
		}
		// 已存在的普通文件被截断 → 确认（防误覆盖）
		if (!DEVICE_TARGETS.has(t.path) && existsSync(t.path)) {
			return { kind: "confirm" };
		}
	}
	return { kind: "pass" };
}

/** 就地编辑判定（sed -i / perl -i / ruby -i）：目标命中受保护路径 → 阻止 */
function judgeInPlace(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!INPLACE_EDITORS.has(cmdInfo.command)) return { kind: "pass" };
	if (
		!hasShortFlag(cmdInfo.args, "i") &&
		!hasLongFlag(cmdInfo.args, "in-place")
	) {
		return { kind: "pass" };
	}
	// sed 语法: sed -i 'script' file — 目标文件在最后（多文件场景只取最后一个，够保守）
	const dest = lastDestArg(cmdInfo.args);
	if (!dest) return { kind: "pass" };
	if (dest.startsWith("$") || dest.includes("*") || dest.includes("?")) {
		return { kind: "confirm" };
	}
	const real = resolveReal(resolve(realCwd, expandHome(dest)));
	if (matchesProtectedPath(real)) {
		return {
			kind: "block",
			reason: `就地编辑受保护路径: ${cmdInfo.command} ${dest}`,
		};
	}
	return { kind: "pass" };
}

// ─── 路径工具 ──────────────────────────────────────────────────────

/** 判断绝对路径是否在 cwd 之外 */
function isOutsideCwd(absolutePath: string, cwd: string): boolean {
	const normCwd = normalize(cwd);
	const normPath = normalize(absolutePath);
	if (normPath === normCwd) return false;
	const rel = relativePath(normCwd, normPath);
	return rel.startsWith("..") || rel === normPath;
}

/** 不区分项目内外的受保护判定（供 bash 重定向/覆盖检查与 write 守卫使用） */
function matchesProtectedPath(absolutePath: string): boolean {
	const segments = normalize(absolutePath).toLowerCase().split(sep);

	for (const pattern of PROTECTED_PATH_PATTERNS) {
		const pat = pattern.toLowerCase();
		const isDir = pat.endsWith("/");
		const core = isDir ? pat.slice(0, -1) : pat;

		// 后缀模式（*.pem、*.key）：匹配任意路径段
		if (core.startsWith("*.")) {
			const suffix = core.slice(1);
			if (segments.some((seg) => seg.endsWith(suffix))) return true;
			continue;
		}

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			if (seg === core) {
				// 目录模式（.git/、node_modules/ 等）命中任意目录段；
				// 文件模式（.env）只命中末段
				if (isDir || i === segments.length - 1) return true;
			}
			// 文件模式变体（.env.local / .env.production，末段）
			if (!isDir && i === segments.length - 1 && seg.startsWith(core + ".")) {
				return true;
			}
		}
	}
	return false;
}

/**
 * 危险命令分级：
 *   - "block"   → 系统级破坏（格式化/关机/批量删除/写块设备），任何模式直接阻止
 *   - "confirm" → 提权/远程/危险权限（sudo/ssh/chmod 777），strict 阻止、其余询问
 *   - null      → 非危险命令
 */
function dangerousLevel(fullCommand: string): "block" | "confirm" | null {
	for (const pattern of BLOCK_DANGEROUS_PATTERNS) {
		if (pattern.test(fullCommand)) return "block";
	}
	for (const pattern of CONFIRM_DANGEROUS_PATTERNS) {
		if (pattern.test(fullCommand)) return "confirm";
	}
	return null;
}

// ─── 命令解析 ─────────────────────────────────────────────────────

interface CmdInfo {
	command: string; // 基础命令名 (rm, rmdir 等)
	args: string[]; // 非 flag 参数（潜在路径）
}

/** 解析 shell 命令，拆出命令名和参数（剥除前缀命令后取真实命令） */
function parseCommand(fullCommand: string): CmdInfo | null {
	// 去掉命令替换 $(...)、子 shell (...)、分组 {...} 包裹
	let cleaned = fullCommand.trim();
	cleaned = cleaned.replace(/^\$\(\s*/, "").replace(/\s*\)$/, "");
	cleaned = cleaned.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
	cleaned = cleaned.replace(/^\{\s*/, "").replace(/\s*;?\s*\}$/, "");

	const tokens = splitShellTokens(cleaned);
	if (tokens.length === 0) return null;

	// 剥除前缀命令（sudo/nohup/timeout/env 等）及其 flag / 数字 / VAR= 赋值参数
	const stripped = stripPrefixTokens(tokens);
	if (stripped.length === 0) return null;

	// 去掉 \ 前缀（如 \rm）与路径前缀（/bin/rm）
	const raw = stripped[0].split("/").pop() ?? stripped[0];
	const base = raw.replace(/^\\(?=[A-Za-z])/, "");
	return { command: base, args: stripped.slice(1) };
}

/** 剥除前缀命令（sudo 等），跳过其 flag / 数字 / VAR= 赋值参数 */
function stripPrefixTokens(tokens: string[]): string[] {
	const t = [...tokens];
	while (t.length > 0 && PREFIX_COMMANDS.has(t[0])) {
		const prefix = t.shift()!;
		while (
			t.length > 0 &&
			(t[0].startsWith("-") ||
				/^\d+$/.test(t[0]) ||
				/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]))
		) {
			const flag = t.shift()!;
			if (FLAGS_WITH_ARG.has(flag)) t.shift();
		}
		// chroot 的第一个参数是 NEWROOT 路径，跳过
		if (prefix === "chroot" && t.length > 0) t.shift();
	}
	return t;
}

/** 判断是否为删除类命令 */
function isDeleteCommand(cmd: string): boolean {
	return DELETE_COMMANDS.has(cmd);
}

/** 是否带强制覆盖 flag（-f / --force，支持 -sf / -fdx 等组合） */
function hasForceFlag(args: string[]): boolean {
	return args.some((a) => {
		if (!a.startsWith("-")) return false;
		if (a.startsWith("--")) return a === "--force" || a.startsWith("--force=");
		return a.slice(1).includes("f");
	});
}

/** 覆盖类命令的“目标”——最后一个非 flag 参数；无则 null */
function lastDestArg(args: string[]): string | null {
	for (let i = args.length - 1; i >= 0; i--) {
		const a = args[i];
		if (a.startsWith("-")) continue;
		if (a === ">" || a === ">>" || a === "2>" || a === "2>>") continue;
		return a;
	}
	return null;
}

/** 从参数中提取可能是路径的 token，解析为绝对路径并判断内外 */
function extractPathArgs(
	args: string[],
	cwd: string,
): Array<{ raw: string; path: string; isOutside: boolean }> {
	const results: Array<{ raw: string; path: string; isOutside: boolean }> = [];

	for (const arg of args) {
		// 跳过 flag
		if (arg.startsWith("-")) continue;
		// 跳过通配符/重定向
		if (
			arg.includes("*") ||
			arg.includes("?") ||
			arg === ">" ||
			arg === ">>" ||
			arg === "2>" ||
			arg === "2>>"
		)
			continue;
		// 变量引用（如 "$HOME/.ssh"）无法静态解析 → 跳过，最终会落入"无路径→弹窗"分支
		if (arg.startsWith("$")) continue;

		// 展开 ~ / ~/xxx 到 HOME，否则会被当作项目内相对路径
		const expanded = expandHome(arg);

		const resolved = resolve(cwd, expanded);
		// 解析符号链接，防止删除目标实际位于项目外
		const real = resolveReal(resolved);
		const outside = isOutsideCwd(real, cwd);
		results.push({ raw: arg, path: real, isOutside: outside });
	}

	return results;
}

/** 展开 ~ / ~/xxx 到 HOME */
function expandHome(p: string): string {
	if (p === "~") return HOME;
	if (p.startsWith("~/")) return join(HOME, p.slice(2));
	return p;
}

/** 重定向目标：{ op, target }；无则 null */
interface RedirectTarget {
	op: string; // 重定向操作符（>、2>、&>、>>、2>> 等）
	target: string; // 目标路径
}

/** 提取重定向写入目标（> file、2>>file、&> file 等）；无则 null */
function extractRedirectTarget(fullCommand: string): RedirectTarget | null {
	const tokens = splitShellTokens(fullCommand);
	const REDIR = /^([0-9]*&?>+)(.*)$/;
	for (let i = 0; i < tokens.length; i++) {
		const m = REDIR.exec(tokens[i]);
		if (!m) continue;
		// 同 token 内紧跟的目标（echo hi >.env）
		if (m[2]) {
			// 2>&1 之类 fd 复制 → 跳过
			if (!m[2].startsWith("&")) return { op: m[1], target: m[2] };
			continue;
		}
		// 目标在下一个 token（> /dev/sda）
		const next = tokens[i + 1];
		if (next && !next.startsWith("&")) return { op: m[1], target: next };
	}
	return null;
}

/** 是否为截断型重定向（单个 >，非 >> 追加） */
function isTruncatingOp(op: string): boolean {
	return op.endsWith(">") && !op.endsWith(">>");
}

/** 极简 shell token 拆分（支持单引号/双引号） */
function splitShellTokens(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (const ch of input) {
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (/\s/.test(ch) && !inSingle && !inDouble) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** 按 shell 操作符分段（&&、||、;、|、换行），引号内不分段 */
function splitSegments(input: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			continue;
		}
		if (!inSingle && !inDouble) {
			const isSep =
				ch === "|" ||
				ch === ";" ||
				ch === "\n" ||
				(ch === "&" && input[i + 1] === "&");
			if (isSep) {
				if (current.trim()) segments.push(current.trim());
				current = "";
				if (ch === "&") i++; // 跳过第二个 &
				continue;
			}
		}
		current += ch;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

/** 判断路径是否为目录 */
function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 解析符号链接，返回真实路径。
 * 路径不存在时，从最近父目录向上逐级解析，找到第一个能解析的祖先后拼接剩余部分。
 * 与“从根向下”的方案不同，从后往前能正确解析中段的软链（如 项目内 lnk -> 外部目录），
 * 防止深层不存在路径经软链写穿到项目外；也正确处理软链 cwd。
 */
function resolveReal(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		let cur = p;
		const tail: string[] = [];
		for (;;) {
			const parent = dirname(cur);
			if (parent === cur) break; // 已到根，路径全部不存在
			try {
				const real = realpathSync(parent);
				return join(real, basename(cur), ...tail);
			} catch {
				tail.unshift(basename(cur));
				cur = parent;
			}
		}
		return normalize(p);
	}
}

// ─── UI 交互 ─────────────────────────────────────────────────────

/** trusted 模式切换前的警告确认：提示行为边界非常宽松，需用户明确确认 */
async function confirmTrustedSwitch(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	// 无 UI（headless）无法确认 → 保守拒绝切换
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(
		"⚠️ 切换到 trusted 模式？",
		"trusted 是最宽松模式：项目内删除、项目外覆盖/删除普通文件均不再询问，\n仅受保护路径与系统级破坏命令仍被阻止。\n\n此模式下 pi 的行为边界非常宽松，请确认是否切换。",
	);
}

async function askConfirm(
	ctx: ExtensionContext,
	message: string,
): Promise<ToolCallEventResult | undefined> {
	if (!ctx.hasUI) {
		return { block: true, reason: "无交互界面，已阻止" };
	}

	const choice = await ctx.ui.select(message, [
		"✅ 允许 (Allow)",
		"❌ 拒绝 (Deny)",
	]);

	if (choice !== "✅ 允许 (Allow)") {
		return { block: true, reason: "用户拒绝了操作" };
	}
	return undefined; // 放行
}
