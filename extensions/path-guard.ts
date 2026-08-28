/**
 * Path Guard Extension v3 — protects against accidental deletes / overwrites / edits
 *
 * Built on path-guard-p620.ts, merging strengths from path-guard-ayydesk.ts and fixing known gaps:
 *
 * v2 additions over p620:
 *   1. Prefix-command stripping (sudo/doas/pkexec/env/nohup/command/builtin/time/nice/xargs/
 *      timeout/setsid/stdbuf/ionice/chroot/watch) → analyze the real command.
 *      Fixes p620 letting "timeout 5 rm -rf /etc", "nohup rm -rf x" etc. through.
 *   2. Git destructive-command checks (clean -f / reset --hard / checkout -- . / restore . /
 *      branch -D / push --force / stash drop), honoring -C/-c global option prefixes.
 *      Fixes p620 only blocking git clean.
 *   3. Block-device redirect regex without the  boundary, fixing "echo x > /dev/sda" (spaced) misses.
 *   4. realpath resolution upgraded to "walk up to nearest existing ancestor" (ayydesk approach),
 *      fixing deep missing paths being written through symlinks to outside the project.
 *   5. mv/cp/install/tee/ln -f/rsync existing-target overwrite detection (incl. -t target form,
 *      tee -a append exemption, rsync --delete confirmation) — in-project overwrite → confirm,
 *      outside → block.
 *   6. "> existing file" truncate detection (incl. 2> / &>, excluding >> append and devices) → confirm.
 *   7. write/edit resolves the real cwd path before judging in/out, fixing false positives where
 *      an in-project write under a symlinked cwd was misjudged as outside.
 *
 * All p620 capabilities retained:
 *   - Protected-path interception (.env / .ssh / keys / credentials, regardless of project)
 *   - Shell wrapper recursion (bash -c / eval, depth-limited); source / . conservative confirm
 *   - dd / curl -o / wget -O / truncate / sed -i / perl -i / ruby -i / unzip -o judgment
 *   - Dangerous command regexes (sudo / chmod 777 / ssh / find -delete / mkfs etc.)
 *   - Compound-command segmentation aggregation, fail-safe: any hard block blocks everything
 *   - Quote-aware tokenization (single/double quotes handled correctly)
 *
 * v3 adds (upgrade from v2): guard modes (/guard command, switchable per session; new sessions
 * reset to normal)
 *   - strict   full protection: in-project writes also prompt; Confirm-group commands blocked
 *   - normal   default: Block-group commands blocked directly, Confirm group prompts
 *   - loose    relaxed: in/out-project creates and deletes pass without prompting (overwrites of
 *              existing targets still confirmed)
 *   - trusted  most permissive: overwrites and ordinary-file deletes pass too
 *   - Protected paths (credentials/config/keys) and the Block group (format/shutdown/bulk-delete/
 *     block-device writes) are blocked directly in every mode, with no confirmation opportunity
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

// ─── Configuration ──────────────────────────────────────────────────────

/** Protected path fragments — matching paths block writes/edits */
const PROTECTED_PATH_PATTERNS = [
	".env",
	".git/",
	".ssh/", // SSH config & keys
	// HOME-level credentials/config (intercepted for bash redirects, overwrites, and the write tool)
	".aws/", // AWS credentials
	".kube/", // Kubernetes admin config
	".docker/", // Docker login credentials
	".gnupg/", // GPG keys
	".git-credentials", // plaintext git credentials
	".npmrc", // npm tokens
	".pypirc", // PyPI tokens
	".netrc", // generic login credentials
	".bashrc", // shell config (persistence/backdoor vector)
	".zshrc",
	".profile",
	".bash_profile",
	"credentials", // in-project credential files
	"*.pem", // private keys (suffix match)
	"*.key", // private keys (suffix match)
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

/** Block group — system-destructive; blocked in every mode (no confirmation opportunity) */
const BLOCK_DANGEROUS_PATTERNS: RegExp[] = [
	/\bmkfs\./,
	/\bmkswap\b/,
	/\bpoweroff\b/,
	/\breboot\b/,
	/\bshutdown\b/,
	/\binit\s+0\b/,
	/\binit\s+6\b/,
	/\bdd\b[^;|&]*\bof=\s*\/dev\/(sda|sdb|sdc|nvme|mmcblk)/, // dd writing directly to a block device (ordinary files handled by judgeDd)
	/(>|>>)\s*\/dev\/(sda|sdb|sdc|nvme|mmcblk)/, // direct write to a block device (note: no \b — > is often preceded by a space)
	/\bfind\b[^;|&]*-delete\b/, // find ... -delete bulk delete
	/\bfind\b[^;|&]*-exec(dir)?\b[^;|&]*\brm\b/, // find ... -exec rm bulk delete
	/\bxargs\b[^;|&]*\brm\b/, // xargs rm bulk delete (backup beyond judgeGit)
];

/** Confirm group — privilege escalation / remote / risky permissions: blocked in strict, confirmed otherwise */
const CONFIRM_DANGEROUS_PATTERNS: RegExp[] = [
	/\bsudo\b/,
	/\b(doas|pkexec)\b/,
	/\b(chmod|chown)\b.*777/,
	/(?<!\.)\b(ssh|scp|sftp|rsh|telnet)\b/, // remote execution/operation (lookbehind avoids false hits on ~/.ssh/ etc.)
	/\bwget\s+-O\s+\/dev\/null\b/, // download discarded directly (harmless but conservative)
];

/** Delete commands requiring special handling */
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "wipe"]);

/** Overwrite commands — overwrite existing targets by default (ln needs -f/--force; handled separately) */
const OVERWRITE_COMMANDS = new Set([
	"mv",
	"cp",
	"install",
	"tee",
	"ln",
	"rsync",
]);

/** In-place edit commands (-i rewrites in place) */
const INPLACE_EDITORS = new Set(["sed", "perl", "ruby"]);

/** Shell wrappers: the -c argument is inline code that needs recursive checking */
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

/** Prefix commands: strip before checking the real command */
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

/** Prefix flags that take a value (skip one extra token when stripping) */
const FLAGS_WITH_ARG = new Set(["-u", "--user", "-g", "--group"]);

/** Redirecting to these devices is not a destructive truncate */
const DEVICE_TARGETS = new Set([
	"/dev/null",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/tty",
	"/dev/zero",
]);

const HOME = homedir();

// ─── Guard Modes ─────────────────────────────────────────────────────

/** Guard mode: strict (full) / normal (default) / loose (relaxed) / trusted (most permissive) */
type GuardMode = "strict" | "normal" | "loose" | "trusted";

/** Current session guard mode (switched via /guard; reset to normal on session_start) */
let currentMode: GuardMode = "normal";

/** Valid guard modes */
const GUARD_MODES: readonly GuardMode[] = [
	"strict",
	"normal",
	"loose",
	"trusted",
];

/** Whether a string is a valid guard mode (for /guard argument validation) */
function isGuardMode(m: string): m is GuardMode {
	return (GUARD_MODES as readonly string[]).includes(m);
}

/** Mode descriptions (shown in the /guard interactive picker; English first, Chinese brief after) */
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

/** Full decision matrix (shown as the /guard picker title, English only) */
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

/** Guard verdict: { block, reason } to block / undefined to allow (askConfirm returns a Promise) */
type GuardVerdict =
	| ToolCallEventResult
	| undefined
	| Promise<ToolCallEventResult | undefined>;

// ─── Entry ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Reset to normal on every new session (startup, /new, /resume all fire session_start)
	pi.on("session_start", () => {
		currentMode = "normal";
	});

	// /guard slash command: view / switch guard mode
	pi.registerCommand("guard", {
		description:
			"Path Guard modes: /guard shows the current mode, /guard <strict|normal|loose|trusted> switches",
		handler: async (args, ctx) => {
			const m = args?.trim().toLowerCase() ?? "";

			// Valid argument → switch directly (shortcut, no picker); trusted requires a warning confirmation
			if (isGuardMode(m)) {
				if (m === "trusted" && !(await confirmTrustedSwitch(ctx))) {
					ctx.ui.notify(
						"Cancelled: switching to trusted requires confirmation",
						"info",
					);
					return;
				}
				currentMode = m;
				ctx.ui.notify(
					`Path Guard switched to: ${m} (session-only; new sessions reset to normal)`,
					"info",
				);
				return;
			}

			// No UI → cannot interact; just show the current mode
			if (!ctx.hasUI) {
				ctx.ui.notify(`Path Guard current mode: ${currentMode}`, "info");
				return;
			}

			// Interactive picker (fallback for no/invalid arg): matrix as title, mode choices
			const choices = GUARD_MODES.map(
				(mo) =>
					`${mo} — ${MODE_DESCRIPTIONS[mo]}${mo === currentMode ? " (current)" : ""}`,
			);
			const chosen = await ctx.ui.select(
				`${MODE_MATRIX}\n\nCurrent mode: ${currentMode} — choose one:`,
				choices,
			);
			if (!chosen) {
				ctx.ui.notify("Cancelled, mode unchanged", "info");
				return;
			}
			const picked = chosen.split(/\s+/)[0] as GuardMode;
			if (isGuardMode(picked)) {
				if (picked === "trusted" && !(await confirmTrustedSwitch(ctx))) {
					ctx.ui.notify(
						"Cancelled: switching to trusted requires confirmation",
						"info",
					);
					return;
				}
				currentMode = picked;
				ctx.ui.notify(
					`Path Guard switched to: ${picked} (session-only; new sessions reset to normal)`,
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

/** write/edit guard: protected → block; outside project / cwd is HOME → confirm */
function checkWriteEdit(
	input: WriteToolInput | EditToolInput,
	ctx: ExtensionContext,
): GuardVerdict {
	const path = input.path;
	if (!path) return;

	// Resolve the real cwd first (cwd may itself be a symlink), then the real target path,
	// preventing symlink escape to protected locations and symlink-cwd false positives
	const realCwd = resolveReal(ctx.cwd);
	const real = resolveReal(resolve(realCwd, expandHome(path)));

	// ① Protected path (incl. HOME-level credentials/config, inside or outside project) → block
	if (matchesProtectedPath(real)) {
		return {
			block: true,
			reason: `Path "${real}" is protected; write blocked.`,
		};
	}

	// ② Outside the project dir → strict/normal confirm; loose/trusted pass (judged on the real path, so symlink escape also matches)
	if (isOutsideCwd(real, realCwd)) {
		if (currentMode === "loose" || currentMode === "trusted") return;
		return askConfirm(
			ctx,
			`⚠️ File path is outside the project directory\n\nPath: ${real}\nProject: ${realCwd}`,
		);
	}

	// ③ cwd is HOME (write lands under HOME) → strict/normal confirm; loose/trusted pass
	if (realCwd === HOME) {
		if (currentMode === "loose" || currentMode === "trusted") return;
		return askConfirm(
			ctx,
			`⚠️ Write operation in HOME directory\n\nPath: ${real}\nHOME: ${HOME}\n\nConfirm write?`,
		);
	}

	// ④ In-project → strict prompts for everything; other modes pass
	if (currentMode === "strict") {
		return askConfirm(
			ctx,
			`⚠️ strict mode: in-project write operation\n\nPath: ${real}\n\nConfirm write?`,
		);
	}

	return; // In-project and safe: allow
}

/** bash guard: scan segments then decide once (prevents "rm -rf safe && sudo reboot" segment bypass) */
function checkBashCommand(
	input: BashToolInput,
	ctx: ExtensionContext,
): GuardVerdict {
	const command = input.command ?? "";
	if (!command.trim()) return;

	const realCwd = resolveReal(ctx.cwd);

	// Split by &&, ||, ;, |, newline; check each segment and aggregate results,
	// then decide once — so an early return from the first guarded segment can't skip later ones
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

	// Aggregate: any hard block → block everything (fail-safe)
	if (blockReasons.length > 0) {
		return {
			block: true,
			reason: `Command blocked:\n${blockReasons.join("\n")}`,
		};
	}
	// Segments needing confirmation → one prompt, confirm together
	if (confirmNeeded.length > 0) {
		return askConfirm(
			ctx,
			`⚠️ Commands requiring confirmation\n\n${confirmNeeded
				.map((s) => `· ${s}`)
				.join("\n")}\n\nConfirm execution?`,
		);
	}
	return; // Safe command: allow
}

/** Verdict for a single segment */
type SegmentVerdict =
	| { kind: "block"; reason: string }
	| { kind: "confirm" }
	| { kind: "pass" };

/** Per-segment check: protected redirect → block; dangerous commands → confirm/block; the rest to sub-judges / wrapper recursion */
function classifySegment(
	trimmed: string,
	realCwd: string,
	hasUI: boolean,
	depth = 0,
): SegmentVerdict {
	// Recursion depth guard (bash -c / eval nested too deep to statically check → conservative confirm)
	if (depth > 4) return { kind: "confirm" };

	// ① Redirect check:
	//    - Write to a protected path (echo x > .env etc.) → block
	//    - "> existing file" (truncate, not >> append, not a device) → confirm
	const redirect = extractRedirectTarget(trimmed);
	if (redirect) {
		const real = resolveReal(resolve(realCwd, expandHome(redirect.target)));
		if (matchesProtectedPath(real)) {
			return {
				kind: "block",
				reason: `Redirect writes to protected path: ${trimmed}`,
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

	// ② Dangerous commands:
	//    - Block group (format/shutdown/bulk-delete/block-device writes) → blocked in every mode
	//    - Confirm group (sudo/ssh/chmod 777) → blocked in strict, confirmed otherwise
	const danger = dangerousLevel(trimmed);
	if (danger === "block") {
		return {
			kind: "block",
			reason: `System-destructive command blocked: ${trimmed}`,
		};
	}
	if (danger === "confirm") {
		if (currentMode === "strict") {
			return {
				kind: "block",
				reason: `Dangerous command blocked (strict mode): ${trimmed}`,
			};
		}
		return hasUI
			? { kind: "confirm" }
			: {
					kind: "block",
					reason: `Dangerous command blocked (no interactive UI): ${trimmed}`,
				};
	}

	const cmdInfo = parseCommand(trimmed);
	if (!cmdInfo) return { kind: "pass" };

	// ③ Shell wrapper (bash -c 'code' / eval 'code') → recursively check the inner code
	const wrapperVerdict = judgeShellWrapper(
		trimmed,
		cmdInfo,
		realCwd,
		hasUI,
		depth,
	);
	if (wrapperVerdict.kind !== "pass") return wrapperVerdict;

	// ④ source / .: runs a script file whose contents can't be statically analyzed → conservative confirm
	if (cmdInfo.command === "source" || cmdInfo.command === ".") {
		return { kind: "confirm" };
	}

	// ⑤-⑪ Pipeline for target-writing commands (git / dd / download / truncate / in-place edit / delete / overwrite / unzip -o)
	return judgeWriters(trimmed, cmdInfo, realCwd);
}

/** Shell wrapper verdict: recursively run the same checks on bash -c / eval inner code */
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
			reason: `Inner command blocked:\n${blockReasons.join("\n")}`,
		};
	}
	if (confirmNeeded.length > 0) return { kind: "confirm" };
	return { kind: "pass" };
}

/** Target-writing pipeline: judge each; return on the first non-pass; allow only when all pass */
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
	// Forced extraction overwrite (unzip -o): archive contents unknowable → conservative confirm
	if (cmdInfo.command === "unzip" && hasShortFlag(cmdInfo.args, "o")) {
		return { kind: "confirm" };
	}
	return { kind: "pass" };
}

/** git destructive commands: clean -f / reset --hard / checkout -- . / restore . / branch -D / push --force / stash drop */
function judgeGit(
	_trimmed: string,
	cmdInfo: CmdInfo,
	_realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "git") return { kind: "pass" };

	const args = cmdInfo.args;
	// Skip git global options (-C dir / -c key=val / --git-dir= etc.), find the subcommand
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

/** Delete-command verdict (rm, rmdir, shred, ...); non-delete commands → pass */
function judgeDelete(
	trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!isDeleteCommand(cmdInfo.command)) return { kind: "pass" };

	// Query forms (command -v rm / rm --version etc., no path args) → pass
	if (
		cmdInfo.args.every((a) => a.startsWith("-")) &&
		/(-v|-V|--version|-h|--help)\b/.test(trimmed)
	) {
		return { kind: "pass" };
	}

	const pathArgs = extractPathArgs(cmdInfo.args, realCwd);

	// Protected paths first: blocked in every mode (trusted filters protected before passing outside deletes)
	for (const p of pathArgs) {
		if (matchesProtectedPath(p.path)) {
			return {
				kind: "block",
				reason: `Delete command targets protected path: ${p.path}`,
			};
		}
	}

	// No concrete path (rm "$HOME/.ssh", rm ./* — variable/wildcard, not statically resolvable) → conservative confirm (all modes)
	if (pathArgs.length === 0) {
		return { kind: "confirm" };
	}

	const externalPaths = pathArgs.filter((p) => p.isOutside);
	if (externalPaths.length > 0) {
		const list = externalPaths.map((p) => p.path).join(", ");
		// trusted → pass (ordinary files, protected already filtered); loose → confirm; strict/normal → block
		if (currentMode === "trusted") return { kind: "pass" };
		if (currentMode === "loose") return { kind: "confirm" };
		return {
			kind: "block",
			reason: `Delete command targets paths outside the project directory: ${list}`,
		};
	}

	// In-project delete: strict/normal → confirm; loose/trusted → pass
	if (currentMode === "loose" || currentMode === "trusted") {
		return { kind: "pass" };
	}
	return { kind: "confirm" };
}

/**
 * Overwrite-command verdict (mv/cp/install/tee/ln -f/rsync):
 *   - Target hits a protected path → block
 *   - Target exists (file, or dir with a basename conflict) → confirm in-project / block outside
 *   - Target missing → confirm outside write / pass in-project (pure rename/create)
 *   - -n/--no-clobber (explicit no-overwrite), ln without -f, tee -a (append) → pass
 */
function judgeOverwrite(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!OVERWRITE_COMMANDS.has(cmdInfo.command)) return { kind: "pass" };

	// ln only overwrites existing targets with -f/--force
	if (cmdInfo.command === "ln" && !hasForceFlag(cmdInfo.args)) {
		return { kind: "pass" };
	}
	// -n/--no-clobber: explicit no-overwrite, safe to pass
	if (cmdInfo.args.includes("-n") || cmdInfo.args.includes("--no-clobber")) {
		return { kind: "pass" };
	}
	// tee -a / --append: append, no overwrite
	if (
		cmdInfo.command === "tee" &&
		(cmdInfo.args.includes("-a") || cmdInfo.args.includes("--append"))
	) {
		return { kind: "pass" };
	}
	// rsync --delete: removes extra files in the target dir → conservative confirm
	if (cmdInfo.command === "rsync" && cmdInfo.args.includes("--delete")) {
		return { kind: "confirm" };
	}

	// Resolve target: -t dir src... form vs the regular form (last operand is the target)
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

	// Variable/wildcard not statically resolvable → conservative confirm
	if (target.startsWith("$") || target.includes("*") || target.includes("?")) {
		return { kind: "confirm" };
	}

	const real = resolveReal(resolve(realCwd, expandHome(target)));
	// ① Target hits a protected path → block
	if (matchesProtectedPath(real)) {
		return {
			kind: "block",
			reason: `Command may overwrite protected path: ${cmdInfo.command} ${target}`,
		};
	}

	const outside = isOutsideCwd(real, realCwd);

	// Outside overwrite of an existing target: normal/strict → block; loose → confirm; trusted → pass
	const outsideOverwriteVerdict = (): SegmentVerdict => {
		if (currentMode === "trusted") return { kind: "pass" };
		if (currentMode === "loose") return { kind: "confirm" };
		return {
			kind: "block",
			reason: `Command will overwrite a target outside the project directory: ${cmdInfo.command} ${target}`,
		};
	};

	// ② Target is an existing directory: check each source basename for conflicts
	if (existsSync(real) && isDirectory(real)) {
		const conflict = sources.some((s) => {
			// Source not statically resolvable → treat as a conflict
			if (s.startsWith("$") || s.includes("*") || s.includes("?")) return true;
			const srcReal = resolveReal(resolve(realCwd, expandHome(s)));
			return existsSync(join(real, basename(srcReal)));
		});
		if (!conflict) return { kind: "pass" };
		// Overwriting an existing target: outside per mode, in-project confirm (overwrites are never silently passed)
		return outside ? outsideOverwriteVerdict() : { kind: "confirm" };
	}

	// ③ Target is an existing file: will be overwritten
	if (existsSync(real)) {
		return outside ? outsideOverwriteVerdict() : { kind: "confirm" };
	}

	// ④ Target missing: outside → normal/strict confirm, loose/trusted pass;
	//    in-project → strict confirm, others pass (pure rename/create)
	if (outside) {
		return currentMode === "loose" || currentMode === "trusted"
			? { kind: "pass" }
			: { kind: "confirm" };
	}
	return currentMode === "strict" ? { kind: "confirm" } : { kind: "pass" };
}

/** Unwrap a shell wrapper: bash/sh/zsh -c 'code', eval 'code' → inner code; else null */
function unwrapShellWrapper(cmdInfo: CmdInfo): string | null {
	if (SHELL_WRAPPERS.has(cmdInfo.command)) {
		for (let i = 0; i < cmdInfo.args.length; i++) {
			const a = cmdInfo.args[i];
			if (a === "--") break; // everything after is not a flag
			// short flag contains c (-c, -ec combos); long flags don't count
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

/** Whether args contain a short flag (supports -i.bak / -pi combos; single-dash only) */
function hasShortFlag(args: string[], ch: string): boolean {
	return args.some(
		(a) => a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes(ch),
	);
}

/** Whether args contain a long flag (--name or --name=value) */
function hasLongFlag(args: string[], name: string): boolean {
	return args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

/** dd verdict: of= pointing at a protected file → block (block-device writes covered by dangerous patterns) */
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
			return { kind: "block", reason: `dd writes to protected path: ${trimmed}` };
		}
	}
	return { kind: "pass" };
}

/** curl/wget verdict: output target hits a protected path → block */
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
			reason: `Download writes to protected path: ${cmdInfo.command} ${target}`,
		};
	}
	return { kind: "pass" };
}

/** Extract the download output target; null if none explicit */
function downloadTarget(command: string, args: string[]): string | null {
	return command === "wget"
		? wgetDownloadTarget(args)
		: curlDownloadTarget(args);
}

/** wget output target (-O / --output / --output-document all take an argument) */
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

/** curl output target (-o / --output take an argument; -O has none, uses the URL basename) */
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

/** truncate verdict: target hits a protected path → block; existing non-device target → confirm */
function judgeTruncate(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "truncate") return { kind: "pass" };
	// Any target not statically resolvable (variable/wildcard) → conservative confirm
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
			return {
				kind: "block",
				reason: `truncate truncates protected path: ${t.raw}`,
			};
		}
		// Existing ordinary file truncated → confirm (prevent accidental overwrite)
		if (!DEVICE_TARGETS.has(t.path) && existsSync(t.path)) {
			return { kind: "confirm" };
		}
	}
	return { kind: "pass" };
}

/** In-place edit verdict (sed -i / perl -i / ruby -i): target hits a protected path → block */
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
	// sed syntax: sed -i 'script' file — target file is last (multi-file: only the last is checked; conservative enough)
	const dest = lastDestArg(cmdInfo.args);
	if (!dest) return { kind: "pass" };
	if (dest.startsWith("$") || dest.includes("*") || dest.includes("?")) {
		return { kind: "confirm" };
	}
	const real = resolveReal(resolve(realCwd, expandHome(dest)));
	if (matchesProtectedPath(real)) {
		return {
			kind: "block",
			reason: `In-place edit of protected path: ${cmdInfo.command} ${dest}`,
		};
	}
	return { kind: "pass" };
}

// ─── Path Utils ───────────────────────────────────────────────────────

/** Whether an absolute path is outside cwd */
function isOutsideCwd(absolutePath: string, cwd: string): boolean {
	const normCwd = normalize(cwd);
	const normPath = normalize(absolutePath);
	if (normPath === normCwd) return false;
	const rel = relativePath(normCwd, normPath);
	return rel.startsWith("..") || rel === normPath;
}

/** Protected-path match regardless of in/out project (used by bash redirect/overwrite checks and the write guard) */
function matchesProtectedPath(absolutePath: string): boolean {
	const segments = normalize(absolutePath).toLowerCase().split(sep);

	for (const pattern of PROTECTED_PATH_PATTERNS) {
		const pat = pattern.toLowerCase();
		const isDir = pat.endsWith("/");
		const core = isDir ? pat.slice(0, -1) : pat;

		// Suffix patterns (*.pem, *.key): match any path segment
		if (core.startsWith("*.")) {
			const suffix = core.slice(1);
			if (segments.some((seg) => seg.endsWith(suffix))) return true;
			continue;
		}

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			if (seg === core) {
				// Dir patterns (.git/, node_modules/, etc.) match any directory segment;
				// file patterns (.env) only match the last segment
				if (isDir || i === segments.length - 1) return true;
			}
			// File-pattern variants (.env.local / .env.production, last segment)
			if (!isDir && i === segments.length - 1 && seg.startsWith(core + ".")) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Dangerous command classification:
 *   - "block"   → system-destructive (format/shutdown/bulk-delete/block-device writes), blocked in every mode
 *   - "confirm" → privilege/remote/risky (sudo/ssh/chmod 777), blocked in strict, confirmed otherwise
 *   - null      → not dangerous
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

// ─── Command Parsing ──────────────────────────────────────────────────

interface CmdInfo {
	command: string; // base command name (rm, rmdir, etc.)
	args: string[]; // non-flag args (potential paths)
}

/** Parse a shell command into name and args (strips prefix commands first) */
function parseCommand(fullCommand: string): CmdInfo | null {
	// Strip command-substitution $(...), subshell (...), and group {...} wrappers
	let cleaned = fullCommand.trim();
	cleaned = cleaned.replace(/^\$\(\s*/, "").replace(/\s*\)$/, "");
	cleaned = cleaned.replace(/^\(\s*/, "").replace(/\s*\)$/, "");
	cleaned = cleaned.replace(/^\{\s*/, "").replace(/\s*;?\s*\}$/, "");

	const tokens = splitShellTokens(cleaned);
	if (tokens.length === 0) return null;

	// Strip prefix commands (sudo/nohup/timeout/env etc.) along with their flags / numbers / VAR= assignments
	const stripped = stripPrefixTokens(tokens);
	if (stripped.length === 0) return null;

	// Drop the backslash prefix (\rm) and path prefix (/bin/rm)
	const raw = stripped[0].split("/").pop() ?? stripped[0];
	const base = raw.replace(/^\\(?=[A-Za-z])/, "");
	return { command: base, args: stripped.slice(1) };
}

/** Strip prefix commands (sudo etc.), skipping their flags / numbers / VAR= assignments */
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
		// chroot's first argument is the NEWROOT path; skip it
		if (prefix === "chroot" && t.length > 0) t.shift();
	}
	return t;
}

/** Whether the command is a delete command */
function isDeleteCommand(cmd: string): boolean {
	return DELETE_COMMANDS.has(cmd);
}

/** Whether args carry a force flag (-f / --force, supports -sf / -fdx combos) */
function hasForceFlag(args: string[]): boolean {
	return args.some((a) => {
		if (!a.startsWith("-")) return false;
		if (a.startsWith("--")) return a === "--force" || a.startsWith("--force=");
		return a.slice(1).includes("f");
	});
}

/** Overwrite command "target" — last non-flag arg; null if none */
function lastDestArg(args: string[]): string | null {
	for (let i = args.length - 1; i >= 0; i--) {
		const a = args[i];
		if (a.startsWith("-")) continue;
		if (a === ">" || a === ">>" || a === "2>" || a === "2>>") continue;
		return a;
	}
	return null;
}

/** Extract path-like tokens from args, resolve to absolute, classify in/out */
function extractPathArgs(
	args: string[],
	cwd: string,
): Array<{ raw: string; path: string; isOutside: boolean }> {
	const results: Array<{ raw: string; path: string; isOutside: boolean }> = [];

	for (const arg of args) {
		// Skip flags
		if (arg.startsWith("-")) continue;
		// Skip wildcards/redirects
		if (
			arg.includes("*") ||
			arg.includes("?") ||
			arg === ">" ||
			arg === ">>" ||
			arg === "2>" ||
			arg === "2>>"
		)
			continue;
		// Variable refs ("$HOME/.ssh") not statically resolvable → skip; falls into the no-path→confirm branch
		if (arg.startsWith("$")) continue;

		// Expand ~ / ~/xxx to HOME, or it'd be treated as an in-project relative path
		const expanded = expandHome(arg);

		const resolved = resolve(cwd, expanded);
		// Resolve symlinks so a delete target can't actually live outside the project
		const real = resolveReal(resolved);
		const outside = isOutsideCwd(real, cwd);
		results.push({ raw: arg, path: real, isOutside: outside });
	}

	return results;
}

/** Expand ~ / ~/xxx to HOME */
function expandHome(p: string): string {
	if (p === "~") return HOME;
	if (p.startsWith("~/")) return join(HOME, p.slice(2));
	return p;
}

/** Redirect target: { op, target }; null if none */
interface RedirectTarget {
	op: string; // redirect operator (>, 2>, &>, >>, 2>>, ...)
	target: string; // target path
}

/** Extract the redirect write target (> file, 2>>file, &> file, ...); null if none */
function extractRedirectTarget(fullCommand: string): RedirectTarget | null {
	const tokens = splitShellTokens(fullCommand);
	const REDIR = /^([0-9]*&?>+)(.*)$/;
	for (let i = 0; i < tokens.length; i++) {
		const m = REDIR.exec(tokens[i]);
		if (!m) continue;
		// Target glued to the same token (echo hi >.env)
		if (m[2]) {
			// fd duplication like 2>&1 → skip
			if (!m[2].startsWith("&")) return { op: m[1], target: m[2] };
			continue;
		}
		// Target in the next token (> /dev/sda)
		const next = tokens[i + 1];
		if (next && !next.startsWith("&")) return { op: m[1], target: next };
	}
	return null;
}

/** Whether the operator is truncating (single >, not >> append) */
function isTruncatingOp(op: string): boolean {
	return op.endsWith(">") && !op.endsWith(">>");
}

/** Minimal shell tokenizer (handles single/double quotes) */
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

/** Split by shell operators (&&, ||, ;, |, newline); never inside quotes */
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
				if (ch === "&") i++; // skip the second &
				continue;
			}
		}
		current += ch;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

/** Whether the path is a directory */
function isDirectory(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Resolve symlinks to the real path.
 * For missing paths, walk upward from the nearest existing ancestor, resolve the first
 * resolvable parent, and append the remainder. Unlike top-down resolution, this correctly
 * handles mid-path symlinks (e.g. in-project lnk -> external dir), preventing deep missing
 * paths from being written through a symlink to outside the project; also handles symlink cwd.
 */
function resolveReal(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		let cur = p;
		const tail: string[] = [];
		for (;;) {
			const parent = dirname(cur);
			if (parent === cur) break; // reached root; path doesn't exist at all
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

// ─── UI Interaction ───────────────────────────────────────────────────

/** Warning confirmation before switching to trusted: behavior boundary is very loose; requires explicit user confirmation */
async function confirmTrustedSwitch(
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	// No UI (headless) cannot confirm → conservatively refuse the switch
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(
		"⚠️ Switch to trusted mode?",
		"trusted is the most permissive mode: in-project deletes and outside overwrites/deletes of\nordinary files are no longer prompted. Only protected paths and system-destructive commands\nremain blocked.\n\npi's behavior boundary is very loose in this mode — please confirm the switch.",
	);
}

async function askConfirm(
	ctx: ExtensionContext,
	message: string,
): Promise<ToolCallEventResult | undefined> {
	if (!ctx.hasUI) {
		return { block: true, reason: "No interactive UI; blocked" };
	}

	const choice = await ctx.ui.select(message, ["✅ Allow", "❌ Deny"]);

	if (choice !== "✅ Allow") {
		return { block: true, reason: "User denied the operation" };
	}
	return undefined; // allow
}
