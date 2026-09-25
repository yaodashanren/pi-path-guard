// path-guard — verdict judges: per-command-class judge* functions, segment
// classification, pipe-to-shell scanning, and the judgeWriters pipeline.

import { join, normalize, resolve, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import {
	BLOCK_DANGEROUS_PATTERNS, CONFIRM_DANGEROUS_PATTERNS, DELETE_COMMANDS, DEVICE_TARGETS,
	HOME, INPLACE_EDITORS, OVERWRITE_COMMANDS, PIPE_TO_SHELL_SOURCES, SHELL_INTERPRETERS,
	SHELL_WRAPPERS,
} from "./constants.ts";
import { escapeCatOf, tagged, type EscapeCat } from "./escape.ts";
import { expandHome, isDirectory, isOutsideCwd, isUnresolvedTarget, isRemoteTarget,
	matchesProtectedPath, resolveReal } from "./paths.ts";
import { inNaked, isSessionPassed, isTrustedPath, isUserProtectedPath, pathList, rl, rlFor,
	ruleVerdict } from "./rules.ts";
import { extractCommandSubstitutions, extractHeredocs, extractPathArgs, extractRedirectTarget,
	hasForceFlag, hasShortFlag, hasLongFlag, isDeleteCommand,
	isTruncatingOp, lastDestArg, parseCommand, splitSegments, splitShellTokens,
	type CmdInfo } from "./shell-parse.ts";

export /** Verdict for a single segment */
type SegmentVerdict =
	| { kind: "block"; reason: string }
	| { kind: "confirm"; rule?: RuleId }
	| { kind: "pass" };

/**
 * The script-file target of a `source`/`.` or `<shell-interpreter> script` command,
 * or null if the command is neither. For interpreters, inline-code forms (`-c`) are
 * excluded and only an argument that resolves to an existing file counts.
 */
export function scriptTargetOf(cmdInfo: CmdInfo, realCwd: string): string | null {
	const cmd = cmdInfo.command;
	if (cmd === "source" || cmd === ".") {
		return cmdInfo.args.find((a) => !a.startsWith("-")) ?? null;
	}
	if (SHELL_INTERPRETERS.has(cmd)) {
		if (hasShortFlag(cmdInfo.args, "c") || hasLongFlag(cmdInfo.args, "command")) {
			return null; // inline code (bash -c '…') — handled by the shell-wrapper check
		}
		for (const a of cmdInfo.args) {
			if (a.startsWith("-")) continue;
			if (existsSync(resolveReal(resolve(realCwd, expandHome(a))))) return a;
		}
		return null;
	}
	return null;
}

/**
 * The literal remainder of an unresolvable `source`/`.`/interpreter target: the part
 * after a leading `$VAR` / `${VAR}` prefix, or the whole glob pattern. It is often
 * enough to recognise a protected target (`$D/id_rsa`, `$D/.ssh/config`) even though
 * the variable itself cannot be expanded.
 */
export function unresolvedScriptTail(target: string): string {
	const m = target.match(
		/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/,
	);
	return m ? target.slice(m[0].length) : target;
}

/**
 * A `$VAR`-prefixed path cannot be matched against a user-protected entry (those are
 * absolute prefixes), so the literal tail is compared segment-wise against the
 * entries' basenames. Conservative direction: a same-named directory blocks too.
 */
export function tailLooksUserProtected(tail: string): boolean {
	if (pathList("protected").length === 0) return false;
	const segs = normalize("/x" + tail)
		.toLowerCase()
		.split(sep)
		.filter(Boolean);
	if (segs.length === 0) return false;
	const names = new Set<string>();
	for (const entry of pathList("protected")) {
		const parts = normalize(resolveReal(entry))
			.toLowerCase()
			.split(sep)
			.filter(Boolean);
		if (parts.length > 0) names.add(parts[parts.length - 1]);
	}
	return segs.some((s) => names.has(s));
}

/**
 * Verdict for a `source`/`.`/interpreter target that cannot be resolved statically
 * (a `$VAR` prefix or a glob). The literal tail is still inspected:
 *   1. user-protected tail → hard block, every mode (the user said "never")
 *   2. built-in protected tail → runScriptProtected (same as a literal target)
 *   3. no literal information at all (bare `$VAR` / bare glob) → conservative confirm
 *   4. otherwise → scriptUnresolved (per-mode ladder: strict block, normal/loose
 *      confirm, trusted/naked pass)
 */
export function judgeUnresolvedScriptTarget(target: string): SegmentVerdict {
	const tail = unresolvedScriptTail(target);
	// Nothing but separators / glob metacharacters → no information to act on.
	if (!/[^/*?[\]]/.test(tail)) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}
	if (tailLooksUserProtected(tail)) {
		return {
			kind: "block",
			reason: tagged("userPath", `Script execution of user-protected path: ${target}`),
		};
	}
	if (matchesProtectedPath("/__var__" + tail)) {
		return ruleVerdict(
			"runScriptProtected",
			`Script execution blocked by rule (runScriptProtected): ${target}`,
		);
	}
	return ruleVerdict(
		"scriptUnresolved",
		`Script path cannot be resolved statically — confirm (scriptUnresolved): ${target}`,
	);
}

/**
 * Verdict for a redirect write target (`> "$VAR/..."`, `> *.log`) that cannot be
 * resolved statically. The literal tail is still inspected, mirroring the
 * run-script guard:
 *   1. user-protected tail → hard block, every mode (the user said "never")
 *   2. built-in protected tail → hard block (same as a literal redirect target;
 *      still passes in naked, matching the literal-target branch)
 *   3. no literal information at all (bare `$VAR` / bare glob) → conservative confirm
 *   4. otherwise → redirectUnresolved (per-mode ladder: strict block, normal/loose
 *      confirm, trusted/naked pass)
 */
export function judgeUnresolvedRedirectTarget(target: string): SegmentVerdict {
	const tail = unresolvedScriptTail(target);
	// Nothing but separators / glob metacharacters → no information to act on.
	if (!/[^/*?[\]]/.test(tail)) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}
	if (tailLooksUserProtected(tail)) {
		return {
			kind: "block",
			reason: tagged("userPath", `Redirect writes to user-protected path: ${target}`),
		};
	}
	if (!inNaked() && matchesProtectedPath("/__var__" + tail)) {
		return {
			kind: "block",
			reason: tagged("protectedPath", `Redirect writes to protected path: ${target}`),
		};
	}
	return ruleVerdict(
		"redirectUnresolved",
		`Redirect target cannot be resolved statically — confirm (redirectUnresolved): ${target}`,
	);
}

/**
 * `source`/`.` or shell-interpreter script execution verdict — path-aware + tunable:
 *   - user-protected target → hard block in EVERY mode (incl naked)
 *   - built-in protected target → runScriptProtected rule (strict block / normal,loose confirm / trusted,naked pass)
 *   - trusted target → always pass
 *   - otherwise in-project → runScriptInProject, outside/HOME → runScriptOutside
 */
export function judgeScript(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	const cmd = cmdInfo.command;
	const isSource = cmd === "source" || cmd === ".";
	if (!isSource && !SHELL_INTERPRETERS.has(cmd)) return { kind: "pass" };
	if (
		!isSource &&
		(hasShortFlag(cmdInfo.args, "c") || hasLongFlag(cmdInfo.args, "command"))
	) {
		return { kind: "pass" }; // interpreter inline code — not a script file
	}
	const target = scriptTargetOf(cmdInfo, realCwd);
	if (!target) {
		// `source` with no statically resolvable file → conservative; interpreter with
		// no existing script file → nothing to run → pass.
		return isSource && !inNaked() ? { kind: "confirm" } : { kind: "pass" };
	}
	if (target.startsWith("$") || target.includes("*") || target.includes("?")) {
		return judgeUnresolvedScriptTarget(target);
	}
	const real = resolveReal(resolve(realCwd, expandHome(target)));

	// User-configured protected paths stay a hard block in every mode (incl naked).
	if (isUserProtectedPath(real)) {
		return {
			kind: "block",
			reason: tagged("userPath", `Script execution of user-protected path: ${target}`),
		};
	}
	// Built-in protected paths → per-mode ladder (runScriptProtected).
	if (matchesProtectedPath(real)) {
		return ruleVerdict(
			"runScriptProtected",
			`Script execution blocked by rule (runScriptProtected): ${target}`,
		);
	}
	// Trusted path → always allowed.
	if (isTrustedPath(real)) return { kind: "pass" };

	return judgeScriptTargetPath(real, target, realCwd);
}

/**
 * Shared verdict ladder for executing the script file at `real` (used by
 * `judgeScript` for argument targets and `judgeInputRedirect` for `< file`):
 * user-protected → hard block, built-in protected → runScriptProtected,
 * trusted → pass, otherwise runScriptOutside / runScriptInProject.
 */
export function judgeScriptTargetPath(
	real: string,
	target: string,
	realCwd: string,
): SegmentVerdict {
	const rule =
		isOutsideCwd(real, realCwd) || realCwd === HOME
			? "runScriptOutside"
			: "runScriptInProject";
	return ruleVerdict(rule, `Script execution blocked by rule (${rule}): ${target}`);
}

/** Input-redirect operand of a command (`sh < file` → "file"), or null. */
export function inputRedirectTarget(args: string[]): string | null {
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "<" || args[i] === "0<") return args[i + 1];
	}
	return null;
}

/**
 * `sh < script.sh` executes the file as the interpreter's stdin script — same
 * protection ladder as an argument target. Unresolved (`$VAR`/glob) targets and
 * non-existing/directory targets are left to the other judges / pass.
 */
export function judgeInputRedirect(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (!SHELL_INTERPRETERS.has(cmdInfo.command)) return { kind: "pass" };
	const target = inputRedirectTarget(cmdInfo.args);
	if (!target || isUnresolvedTarget(target)) return { kind: "pass" };
	const real = resolveReal(resolve(realCwd, expandHome(target)));
	if (!existsSync(real) || isDirectory(real)) return { kind: "pass" };
	if (isUserProtectedPath(real)) {
		return {
			kind: "block",
			reason: tagged("userPath", `Script execution of user-protected path: ${target}`),
		};
	}
	if (matchesProtectedPath(real)) {
		return ruleVerdict(
			"runScriptProtected",
			`Script execution blocked by rule (runScriptProtected): ${target}`,
		);
	}
	if (isTrustedPath(real)) return { kind: "pass" };
	return judgeScriptTargetPath(real, target, realCwd);
}

/**
 * Judge the inner command(s) of command substitutions. Each body may itself be a
 * compound command, so split it and aggregate (block > confirm > pass).
 */
export function classifySubstitutions(
	substitutions: string[],
	realCwd: string,
	hasUI: boolean,
	depth: number,
): SegmentVerdict {
	const blockReasons: string[] = [];
	let confirm = false;
	for (const body of substitutions) {
		for (const seg of splitSegments(body)) {
			const s = seg.trim();
			if (!s) continue;
			const v = classifySegment(s, realCwd, hasUI, depth);
			if (v.kind === "block") blockReasons.push(v.reason);
			else if (v.kind === "confirm") confirm = true;
		}
	}
	if (blockReasons.length > 0) {
		return { kind: "block", reason: blockReasons.join("\n") };
	}
	if (confirm) return { kind: "confirm" };
	return { kind: "pass" };
}

/**
 * A command segment: recurse into any `$()` / backtick substitutions, then judge
 * the outer command. A hard block in a substitution wins; a confirm is deferred
 * until the outer verdict is known (block > confirm).
 */
export function classifySegment(
	trimmed: string,
	realCwd: string,
	hasUI: boolean,
	depth = 0,
): SegmentVerdict {
	// Recursion depth guard (nested bash -c / eval / $() too deep to statically check → conservative confirm)
	if (depth > 4) return { kind: "confirm" };

	// ⓪ Command substitutions run before the outer command, so judge their content
	//    too — `echo "$(rm -rf x)"` must not slip through.
	const substitutions = extractCommandSubstitutions(trimmed);
	let subConfirm = false;
	if (substitutions.length > 0) {
		const subVerdict = classifySubstitutions(
			substitutions,
			realCwd,
			hasUI,
			depth + 1,
		);
		if (subVerdict.kind === "block") {
			return {
				kind: "block",
				reason: `Command substitution blocked:\n${subVerdict.reason}`,
			};
		}
		if (subVerdict.kind === "confirm") subConfirm = true;
	}

	const outer = classifySegmentOuter(trimmed, realCwd, hasUI, depth);
	if (outer.kind === "block") return outer;
	if (outer.kind === "confirm" || subConfirm) {
		// Preserve the rule id when the outer verdict is rule-driven (enables the
		// confirm dialog's session-pass option); a substitution-only confirm has none.
		return {
			kind: "confirm",
			rule: outer.kind === "confirm" ? outer.rule : undefined,
		};
	}
	return { kind: "pass" };
}

/** Judge one command segment (redirect / danger / wrapper / script / writers). */
export function classifySegmentOuter(
	trimmed: string,
	realCwd: string,
	hasUI: boolean,
	depth = 0,
): SegmentVerdict {
	// ① Redirect check:
	//    - Write to a protected path (echo x > .env etc.) → block in every mode (user paths too)
	//    - "> existing file" (truncate, not >> append, not a device) → per truncate rule
	const redirect = extractRedirectTarget(trimmed);
	if (redirect) {
		// Variable/glob target can't be statically resolved (echo x > $F): inspect
		// the literal tail, then follow the redirectUnresolved rule (per-mode).
		if (isUnresolvedTarget(redirect.target)) {
			return judgeUnresolvedRedirectTarget(redirect.target);
		}
		// Direct write to a block device (/dev/sda, /dev/rdiskN, …) — system-
		// destructive, must outrank the writeOutside ladder below (which would
		// only confirm).
		if (
			/^\/dev\/(?!null\b|zero\b|tty\b|stdin\b|stdout\b|stderr\b|pts\b|ptmx\b|full\b|random\b|urandom\b|fuse\b|shm\b)[a-z0-9]+/.test(
				redirect.target,
			)
		) {
			return ruleVerdict(
				"blockGroup",
				`Direct write to a block device blocked: ${trimmed}`,
			);
		}
		const real = resolveReal(resolve(realCwd, expandHome(redirect.target)));
		if (isUserProtectedPath(real)) {
			return {
				kind: "block",
				reason: tagged("userPath", `Redirect writes to user-protected path: ${trimmed}`),
			};
		}
		if (!inNaked() && matchesProtectedPath(real)) {
			return {
				kind: "block",
				reason: tagged("protectedPath", `Redirect writes to protected path: ${trimmed}`),
			};
		}
		// Redirect into a trusted path (incl. truncating it) → pass in every mode.
		if (isTrustedPath(real)) return { kind: "pass" };
		if (
			isTruncatingOp(redirect.op) &&
			!DEVICE_TARGETS.has(redirect.target) &&
			existsSync(real)
		) {
			const rule =
				isOutsideCwd(real, realCwd) || realCwd === HOME
					? "truncateOutside"
					: "truncateInProject";
			return ruleVerdict(rule, `Truncate blocked by rule: ${trimmed}`);
		}
		// New/append target outside the project (or cwd is HOME) → per writeOutside / writeHome
		if (!DEVICE_TARGETS.has(redirect.target)) {
			const outside = isOutsideCwd(real, realCwd);
			if (outside || realCwd === HOME) {
				const rule = outside ? "writeOutside" : "writeHome";
				return ruleVerdict(
					rule,
					`Redirect writes outside the project blocked by rule: ${trimmed}`,
				);
			}
		}
	}

	// ② Dangerous commands → per blockGroup / confirmGroup rule
	const danger = dangerousLevel(trimmed);
	if (danger === "block") {
		return ruleVerdict(
			"blockGroup",
			`System-destructive command blocked: ${trimmed}`,
		);
	}
	if (danger === "confirm") {
		const lvl = rl("confirmGroup");
		if (lvl === "block") {
			return {
				kind: "block",
				reason: `Dangerous command blocked by rule: ${trimmed}`,
			};
		}
		if (lvl === "confirm") {
			return hasUI
				? { kind: "confirm" }
				: {
						kind: "block",
						reason: tagged("noUi", `Dangerous command blocked (no interactive UI): ${trimmed}`),
					};
		}
		return { kind: "pass" }; // confirmGroup = pass
	}

	const cmdInfo = parseCommand(trimmed);
	if (!cmdInfo) return { kind: "pass" };

	// ⓪b The command name itself is unresolved ($VAR left after prefix stripping):
	// statically unknowable → per commandNameUnresolved rule (strict block,
	// normal/loose confirm, trusted/naked pass).
	if (cmdInfo.command.includes("$")) {
		return ruleVerdict(
			"commandNameUnresolved",
			`Command name cannot be resolved statically — confirm (commandNameUnresolved): ${trimmed}`,
		);
	}

	// ③ Shell wrapper (bash -c 'code' / eval 'code') → recursively check the inner code
	const wrapperVerdict = judgeShellWrapper(
		trimmed,
		cmdInfo,
		realCwd,
		hasUI,
		depth,
	);
	if (wrapperVerdict.kind !== "pass") return wrapperVerdict;

	// ④ source / . / <shell> script.sh: runs a script file → path-aware + tunable
	const scriptVerdict = judgeScript(trimmed, cmdInfo, realCwd);
	if (scriptVerdict.kind !== "pass") return scriptVerdict;

	// ④b `sh < script.sh` — an input redirect feeds the file as the interpreter's
	// stdin script, which executes it just like `sh script.sh` → same ladder.
	const inputRedirectVerdict = judgeInputRedirect(trimmed, cmdInfo, realCwd);
	if (inputRedirectVerdict.kind !== "pass") return inputRedirectVerdict;

	// ⑤-⑪ Pipeline for target-writing commands (git / dd / download / truncate / in-place edit / delete / overwrite / unzip -o)
	return judgeWriters(trimmed, cmdInfo, realCwd);
}

/** Shell wrapper verdict: recursively run the same checks on bash -c / eval inner code */
export function judgeShellWrapper(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
	hasUI: boolean,
	depth: number,
): SegmentVerdict {
	const inner = unwrapShellWrapper(cmdInfo);
	if (!inner) return { kind: "pass" };

	// A pipe-to-shell inside the wrapper (bash -c 'curl … | bash') crosses the
	// inner split segments, so scan it before recursing.
	const pipeVerdict = scanPipeToShell(inner, realCwd);
	if (pipeVerdict.kind === "block") {
		return {
			kind: "block",
			reason: `Inner command blocked:\n${pipeVerdict.reason}`,
		};
	}
	if (pipeVerdict.kind === "confirm") return { kind: "confirm" };

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
export function judgeWriters(
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
	// Archive extraction (unzip / tar -x): archive contents are unknowable, so
	// anything it lands on may be overwritten → conservative confirm (pass in
	// naked). unzip without -o would prompt interactively and stall a
	// non-interactive run — same treatment.
	if (
		cmdInfo.command === "unzip" ||
		(cmdInfo.command === "tar" && tarIsExtraction(cmdInfo.args))
	) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}
	return { kind: "pass" };
}

/** Whether tar args express an extraction (that writes files), not a create/list */
export function tarIsExtraction(args: string[]): boolean {
	let extract = false;
	let create = false;
	let list = false;
	for (const a of args) {
		if (a === "--extract" || a === "--get") extract = true;
		if (a === "--create" || a === "--append" || a === "--update") create = true;
		if (a === "--list") list = true;
		if (a.startsWith("--")) continue;
		if (a.startsWith("-")) {
			const flags = a.slice(1);
			if (flags.includes("x")) extract = true;
			if (flags.includes("c") || flags.includes("r") || flags.includes("u"))
				create = true;
			if (flags.includes("t")) list = true;
		}
	}
	return extract && !create && !list;
}

/** git destructive commands: clean -f / reset --hard / checkout -- . / restore . / branch -D / push --force / stash drop */
export function judgeGit(
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

	// Destructive git ops → per gitDestructive rule (block / confirm / pass)
	if (sub === "clean" && hasForceFlag(args))
		return ruleVerdict("gitDestructive", "git clean --force blocked by rule");
	if (sub === "reset" && args.includes("--hard"))
		return ruleVerdict("gitDestructive", "git reset --hard blocked by rule");
	if (
		(sub === "checkout" || sub === "switch") &&
		(args.includes("--") || args.includes(".") || hasForceFlag(args))
	)
		return ruleVerdict(
			"gitDestructive",
			"git checkout destructive blocked by rule",
		);
	// `git restore` writes the working tree. Only a whole-tree restore (`.`) counts
	// as destructive; `--source=<ref> -- <path>` is a routine operation and must
	// not trigger on its own. `--staged`-only restores touch the index, not files.
	if (sub === "restore") {
		const stagedOnly =
			(args.includes("--staged") || args.includes("-S")) &&
			!args.includes("--worktree") &&
			!args.includes("-W");
		if (!stagedOnly && args.includes("."))
			return ruleVerdict(
				"gitDestructive",
				"git restore destructive blocked by rule",
			);
	}
	if (sub === "branch" && args.some((a) => a === "-D"))
		return ruleVerdict("gitDestructive", "git branch -D blocked by rule");
	if (sub === "worktree" && args.includes("remove") && hasForceFlag(args))
		return ruleVerdict(
			"gitDestructive",
			"git worktree remove --force blocked by rule",
		);
	if (sub === "tag" && (args.includes("-d") || args.includes("--delete")))
		return ruleVerdict("gitDestructive", "git tag -d blocked by rule");
	if (
		sub === "push" &&
		args.some((a) => a === "-f" || a === "--force" || a === "--force-with-lease")
	)
		return ruleVerdict("gitDestructive", "git push --force blocked by rule");
	if (sub === "stash" && (args.includes("drop") || args.includes("clear")))
		return ruleVerdict("gitDestructive", "git stash drop blocked by rule");
	if (sub === "filter-branch" || sub === "filter-repo")
		return ruleVerdict("gitDestructive", "git history rewrite blocked by rule");

	return { kind: "pass" };
}

/** Delete-command verdict (rm, rmdir, shred, ...); non-delete commands → pass */
export function judgeDelete(
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

	// Protected paths first: user paths block in EVERY mode (incl. naked); built-in paths block except in naked
	for (const p of pathArgs) {
		if (isUserProtectedPath(p.path)) {
			return {
				kind: "block",
				reason: tagged("userPath", `Delete command targets user-protected path: ${p.path}`),
			};
		}
		if (!inNaked() && matchesProtectedPath(p.path)) {
			return {
				kind: "block",
				reason: `Delete command targets protected path: ${p.path}`,
			};
		}
	}

	// No concrete path (rm "$HOME/.ssh", rm ./* — variable/wildcard, not statically resolvable) → conservative confirm (pass in naked)
	if (pathArgs.length === 0) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}

	// All concrete targets are trusted → pass in every mode (trusted-mode protection for those paths)
	if (pathArgs.every((p) => isTrustedPath(p.path))) {
		return { kind: "pass" };
	}

	const externalPaths = pathArgs.filter((p) => p.isOutside);
	if (externalPaths.length > 0) {
		const list = externalPaths.map((p) => p.path).join(", ");
		// per deleteOutside rule: strict/normal block, loose confirm, trusted/naked pass
		return ruleVerdict(
			"deleteOutside",
			`Delete command targets paths outside the project directory: ${list}`,
		);
	}

	// In-project delete → per deleteInProject rule (strict/normal confirm; loose/trusted/naked pass)
	return ruleVerdict("deleteInProject", "Delete command blocked by rule");
}

/**
 * Overwrite-command verdict (mv/cp/install/tee/ln -f/rsync):
 *   - Target hits a protected path → block
 *   - Target exists (file, or dir with a basename conflict) → confirm in-project / block outside
 *   - Target missing → confirm outside write / pass in-project (pure rename/create)
 *   - -n/--no-clobber (explicit no-overwrite), ln without -f, tee -a (append) → pass
 */
export function judgeOverwrite(
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
	// rsync --delete: removes extra files in the target dir → conservative confirm (pass in naked)
	if (cmdInfo.command === "rsync" && cmdInfo.args.includes("--delete")) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
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

	// Variable/wildcard not statically resolvable → conservative confirm (pass in naked)
	if (isUnresolvedTarget(target)) return unresolvedTargetVerdict();
	// rsync/scp remote target (user@host:/path) is not a local path — resolving it
	// would fake an in-project path. Writing to a remote host → conservative confirm.
	if (isRemoteTarget(target)) {
		return unresolvedTargetVerdict();
	}

	const real = resolveReal(resolve(realCwd, expandHome(target)));
	// ① Target hits a protected path → block (user paths in every mode; built-in except naked)
	const blocked = protectedVerdict(
		real,
		`Command may overwrite user-protected path: ${cmdInfo.command} ${target}`,
		`Command may overwrite protected path: ${cmdInfo.command} ${target}`,
	);
	if (blocked) return blocked;

	// Overwrite/rename target is inside a trusted path → pass (no prompt in any mode).
	if (isTrustedPath(real)) return { kind: "pass" };

	const outside = isOutsideCwd(real, realCwd);

	// Outside overwrite of an existing target → per overwriteOutsideExisting rule
	const outsideOverwriteVerdict = (): SegmentVerdict =>
		ruleVerdict(
			"overwriteOutsideExisting",
			`Command will overwrite a target outside the project directory: ${cmdInfo.command} ${target}`,
		);

	// ② Target is an existing directory: check each source basename for conflicts
	if (existsSync(real) && isDirectory(real)) {
		const conflict = sources.some((s) => {
			// Source not statically resolvable → treat as a conflict
			if (s.startsWith("$") || s.includes("*") || s.includes("?")) return true;
			const srcReal = resolveReal(resolve(realCwd, expandHome(s)));
			return existsSync(join(real, basename(srcReal)));
		});
		if (!conflict) return { kind: "pass" };
		// Overwriting an existing target: outside per overwriteOutsideExisting; in-project per overwriteInProject
		return outside
			? outsideOverwriteVerdict()
			: ruleVerdict("overwriteInProject", "Overwrite in project blocked by rule");
	}

	// ③ Target is an existing file: will be overwritten
	if (existsSync(real)) {
		return outside
			? outsideOverwriteVerdict()
			: ruleVerdict("overwriteInProject", "Overwrite in project blocked by rule");
	}

	// ④ Target missing: outside → per overwriteOutsideNew; in-project → per writeInProject (strict confirm, others pass)
	if (outside) {
		return ruleVerdict(
			"overwriteOutsideNew",
			`Write outside the project blocked by rule: ${cmdInfo.command} ${target}`,
		);
	}
	return ruleVerdict("writeInProject", "Write in project blocked by rule");
}

/** Unwrap a shell wrapper: bash/sh/zsh -c 'code', eval 'code' → inner code; else null */
export function unwrapShellWrapper(cmdInfo: CmdInfo): string | null {
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

/** dd verdict: of= pointing at a protected file → block (block-device writes covered by dangerous patterns) */
export function judgeDd(
	trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "dd") return { kind: "pass" };
	for (const a of cmdInfo.args) {
		if (!a.startsWith("of=")) continue;
		const target = a.slice(3);
		if (!target) continue;
		if (isUnresolvedTarget(target)) return unresolvedTargetVerdict();
		const real = resolveReal(resolve(realCwd, expandHome(target)));
		const blocked = protectedVerdict(
			real,
			`dd writes to user-protected path: ${trimmed}`,
			`dd writes to protected path: ${trimmed}`,
		);
		if (blocked) return blocked;
		if (isTrustedPath(real)) continue;
		const outside = outsideWriteVerdict(real, target, realCwd, `dd writes outside the project blocked by rule: ${trimmed}`);
		if (outside) return outside;
	}
	return { kind: "pass" };
}

/** curl/wget verdict: output target hits a protected path → block */
export function judgeDownload(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "curl" && cmdInfo.command !== "wget") {
		return { kind: "pass" };
	}
	const target = downloadTarget(cmdInfo.command, cmdInfo.args);
	if (!target) return { kind: "pass" };
	if (isUnresolvedTarget(target)) return unresolvedTargetVerdict();
	const real = resolveReal(resolve(realCwd, expandHome(target)));
	const blocked = protectedVerdict(
		real,
		`Download writes to user-protected path: ${cmdInfo.command} ${target}`,
		`Download writes to protected path: ${cmdInfo.command} ${target}`,
	);
	if (blocked) return blocked;
	if (isTrustedPath(real)) return { kind: "pass" };
	return (
		outsideWriteVerdict(
			real,
			target,
			realCwd,
			`Download writes outside the project blocked by rule: ${cmdInfo.command} ${target}`,
		) ?? { kind: "pass" }
	);
}

/** Shared: unresolved target → conservative confirm (pass in naked) */
export function unresolvedTargetVerdict(): SegmentVerdict {
	return inNaked() ? { kind: "pass" } : { kind: "confirm" };
}

/** Shared first legs of the per-target verdict chain: user-protected → block in
 *  every mode; built-in protected → block except naked. Returns the block
 *  verdict, or null when the caller should apply its own trusted/outside legs. */
export function protectedVerdict(
	real: string,
	userMsg: string,
	protectedMsg: string,
): SegmentVerdict | null {
	if (isUserProtectedPath(real)) {
		return { kind: "block", reason: tagged("userPath", userMsg) };
	}
	if (!inNaked() && matchesProtectedPath(real)) {
		return { kind: "block", reason: tagged("protectedPath", protectedMsg) };
	}
	return null;
}

/** Shared outside leg (dd / download): device targets skip; outside target →
 *  overwriteOutsideExisting / overwriteOutsideNew. Null when not applicable. */
export function outsideWriteVerdict(
	real: string,
	rawTarget: string,
	realCwd: string,
	describe: string,
): SegmentVerdict | null {
	if (DEVICE_TARGETS.has(rawTarget)) return null;
	if (!isOutsideCwd(real, realCwd)) return null;
	const rule = existsSync(real)
		? "overwriteOutsideExisting"
		: "overwriteOutsideNew";
	return ruleVerdict(rule, describe);
}

/** Extract the download output target; null if none explicit */
export function downloadTarget(command: string, args: string[]): string | null {
	return command === "wget"
		? wgetDownloadTarget(args)
		: curlDownloadTarget(args);
}

/** wget output target (-O / --output / --output-document all take an argument) */
export function wgetDownloadTarget(args: string[]): string | null {
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
export function curlDownloadTarget(args: string[]): string | null {
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
export function judgeTruncate(
	_trimmed: string,
	cmdInfo: CmdInfo,
	realCwd: string,
): SegmentVerdict {
	if (cmdInfo.command !== "truncate") return { kind: "pass" };
	// Any target not statically resolvable (variable/wildcard) → conservative confirm (pass in naked)
	if (
		cmdInfo.args.some(
			(a) =>
				!a.startsWith("-") &&
				(a.startsWith("$") || a.includes("*") || a.includes("?")),
		)
	) {
		return inNaked() ? { kind: "pass" } : { kind: "confirm" };
	}
	for (const t of extractPathArgs(cmdInfo.args, realCwd)) {
		const blocked = protectedVerdict(
			t.path,
			`truncate truncates user-protected path: ${t.raw}`,
			`truncate truncates protected path: ${t.raw}`,
		);
		if (blocked) return blocked;
		// Trusted target truncate → pass in every mode.
		if (isTrustedPath(t.path)) continue;
		// Existing ordinary file truncated → per truncateInProject / truncateOutside
		if (!DEVICE_TARGETS.has(t.path) && existsSync(t.path)) {
			const rule =
				isOutsideCwd(t.path, realCwd) || realCwd === HOME
					? "truncateOutside"
					: "truncateInProject";
			return ruleVerdict(rule, `Truncate blocked by rule: ${t.raw}`);
		}
	}
	return { kind: "pass" };
}

/** In-place edit verdict (sed -i / perl -i / ruby -i): target hits a protected path → block */
export function judgeInPlace(
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
	if (isUnresolvedTarget(dest)) return unresolvedTargetVerdict();
	const real = resolveReal(resolve(realCwd, expandHome(dest)));
	const blocked = protectedVerdict(
		real,
		`In-place edit of user-protected path: ${cmdInfo.command} ${dest}`,
		`In-place edit of protected path: ${cmdInfo.command} ${dest}`,
	);
	if (blocked) return blocked;
	// In-place edit of a trusted path → pass in every mode.
	if (isTrustedPath(real)) return { kind: "pass" };
	return { kind: "pass" };
}

// ─── Dangerous command classification ──────────────────────────────────
/** Dangerous command classification: "block" → system-destructive; "confirm" → privilege/remote/risky; null → not dangerous */
export function dangerousLevel(fullCommand: string): "block" | "confirm" | null {
	for (const pattern of BLOCK_DANGEROUS_PATTERNS) {
		if (pattern.test(fullCommand)) return "block";
	}
	for (const pattern of CONFIRM_DANGEROUS_PATTERNS) {
		if (pattern.test(fullCommand)) return "confirm";
	}
	return null;
}

/** Split on the pipe operator (|), but not the logical || ; quote-aware. */
export function pipeGroups(input: string): string[] {
	const groups: string[] = [];
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
		if (!inSingle && !inDouble && ch === "|") {
			if (input[i + 1] === "|") {
				// logical OR — keep the operator token together, not a pipe
				current += "||";
				i++;
				continue;
			}
			if (current.trim()) groups.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) groups.push(current.trim());
	return groups;
}

/**
 * Whether a pipe's source references an external / outside-workspace resource.
 * Network fetchers (curl/wget) are treated as remote; interpreters are judged by
 * whether any path arg resolves outside the project.
 */
export function pipeSourceIsExternal(sourceText: string, realCwd: string): boolean {
	const info = parseCommand(sourceText);
	if (!info) return false;
	if (info.command === "curl" || info.command === "wget") return true;
	for (const arg of info.args) {
		if (arg.startsWith("-")) continue;
		if (arg.includes("*") || arg.includes("?")) continue;
		if (arg.startsWith("$")) continue;
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return true; // URL scheme
		const expanded = expandHome(arg);
		const real = resolveReal(resolve(realCwd, expanded));
		if (isOutsideCwd(real, realCwd)) return true;
	}
	return false;
}

/**
 * Scan a command for a dangerous pipe into a shell (`curl … | bash`,
 * `python -c '…' | sh`, …). Per the pipeToShell* rules: strict confirms at all
 * positions, normal passes in-workspace / confirms outside, others pass.
 */
export function scanPipeToShell(text: string, realCwd: string): SegmentVerdict {
	const groups = pipeGroups(text);
	const anyBlock: string[] = [];
	let confirmRule: RuleId | undefined;
	for (let i = 1; i < groups.length; i++) {
		const right = parseCommand(groups[i]);
		if (!right || !SHELL_WRAPPERS.has(right.command)) continue;
		const left = parseCommand(groups[i - 1]);
		if (!left || !PIPE_TO_SHELL_SOURCES.has(left.command)) continue;

		const external = pipeSourceIsExternal(groups[i - 1], realCwd);
		const rule: RuleId = external ? "pipeToShellOutside" : "pipeToShellInProject";
		const reason = `Piping ${left.command} output into ${right.command} (potentially untrusted code): ${groups[i - 1]} | ${groups[i]}`;
		const lvl = rl(rule);
		if (lvl === "block") anyBlock.push(reason);
		else if (lvl === "confirm") confirmRule = rule;
	}
	if (anyBlock.length > 0) {
		return { kind: "block", reason: anyBlock.join("\n") };
	}
	if (confirmRule) return { kind: "confirm", rule: confirmRule };
	return { kind: "pass" };
}
