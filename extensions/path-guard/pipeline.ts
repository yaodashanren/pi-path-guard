import { resolve } from "node:path";
import type {
	BashToolInput, EditToolInput, ExtensionContext, ToolCallEventResult, WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { HOME } from "./constants.ts";
import { tagged, withEscapeHints } from "./escape.ts";
import { expandHome, isOutsideCwd, matchesProtectedPath, resolveReal } from "./paths.ts";
import { SESSION_PASS_EXCLUDED, getMode, isTrustedPath, isUserProtectedPath, rl, sessionPassRule, type GuardVerdict, type RuleId } from "./rules.ts";
import { extractHeredocs, splitSegments } from "./shell-parse.ts";
import { classifySegment, scanPipeToShell } from "./judges.ts";

// path-guard — tool_call pipeline: write/edit check and bash command check.

export function checkWriteEdit(
	input: WriteToolInput | EditToolInput,
	ctx: ExtensionContext,
): GuardVerdict {
	const path = input.path;
	if (!path) return;

	// Resolve the real cwd first (cwd may itself be a symlink), then the real target path,
	// preventing symlink escape to protected locations and symlink-cwd false positives
	const realCwd = resolveReal(ctx.cwd);
	const real = resolveReal(resolve(realCwd, expandHome(path)));

	// ① User-configured protected paths are guarded in EVERY mode (incl. naked).
	if (isUserProtectedPath(real)) {
		return {
			block: true,
			reason: withEscapeHints(tagged("userPath", `Path "${real}" is user-protected; write blocked.`)),
		};
	}

	// ② naked passes everything else (built-in protected paths & the write/edit tools).
	if (getMode() === "naked") return;

	// ③ Built-in protected path (incl. HOME-level credentials/config, inside or outside project) → block
	if (matchesProtectedPath(real)) {
		return {
			block: true,
			reason: withEscapeHints(tagged("protectedPath", `Path "${real}" is protected; write blocked.`)),
		};
	}

	// ③b A trusted path is always allowed — protection outranks trust (a trusted
	// entry is never a protected path), so skip the outside/HOME/in-project rules.
	if (isTrustedPath(real)) return;

	const outside = isOutsideCwd(real, realCwd);

	// ④ Outside the project dir OR cwd is HOME → per writeOutside / writeHome rule
	if (outside || realCwd === HOME) {
		const rule = outside ? "writeOutside" : "writeHome";
		const lvl = rl(rule);
		if (lvl === "block") {
			return {
				block: true,
				reason: withEscapeHints(`Write blocked by rule (${rule}): ${real}`),
			};
		}
		if (lvl === "confirm") {
			return askConfirm(
				ctx,
				outside
					? `⚠️ File path is outside the project directory\n\nPath: ${real}\nProject: ${realCwd}`
					: `⚠️ Write operation in HOME directory\n\nPath: ${real}\nHOME: ${HOME}\n\nConfirm write?`,
				[rule],
			);
		}
		return; // pass
	}

	// ⑤ In-project → per writeInProject rule
	const lvl = rl("writeInProject");
	if (lvl === "block") {
		return {
			block: true,
			reason: withEscapeHints(`Write blocked by rule (writeInProject): ${real}`),
		};
	}
	if (lvl === "confirm") {
		return askConfirm(
			ctx,
			`⚠️ strict mode: in-project write operation\n\nPath: ${real}\n\nConfirm write?`,
			["writeInProject"],
		);
	}
	return; // In-project and safe: allow
}

/** bash guard: scan segments then decide once (prevents "rm -rf safe && sudo reboot" segment bypass) */
export function checkBashCommand(
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
	const confirmRules = new Set<RuleId>();

	// Dangerous pipe-to-shell (curl … | bash, python -c '…' | sh) — the pipe
	// crosses segments, so scan the raw command before the per-segment loop.
	// Heredoc bodies are executed as script text, so they are extracted first,
	// judged like segments, and removed from the command (otherwise they would
	// misparse as tokens of the intro command).
	const { command: bareCommand, bodies: heredocBodies } = extractHeredocs(
		command,
	);
	for (const body of heredocBodies) {
		for (const line of body.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			const v = classifySegment(t, realCwd, ctx.hasUI);
			if (v.kind === "block") blockReasons.push(`heredoc: ${v.reason}`);
			else if (v.kind === "confirm") {
				confirmNeeded.push(`(heredoc) ${t}`);
				if (v.rule) confirmRules.add(v.rule);
			}
		}
	}
	const pipeVerdict = scanPipeToShell(bareCommand, realCwd);
	if (pipeVerdict.kind === "block") {
		blockReasons.push(pipeVerdict.reason);
	} else if (pipeVerdict.kind === "confirm") {
		confirmNeeded.push(command.trim());
		if (pipeVerdict.rule) confirmRules.add(pipeVerdict.rule);
	}

	for (const seg of splitSegments(bareCommand)) {
		const trimmed = seg.trim();
		if (!trimmed) continue;

		const verdict = classifySegment(trimmed, realCwd, ctx.hasUI);
		if (verdict.kind === "block") {
			blockReasons.push(verdict.reason);
		} else if (verdict.kind === "confirm") {
			confirmNeeded.push(trimmed);
			if (verdict.rule) confirmRules.add(verdict.rule);
		}
	}

	// Aggregate: any hard block → block everything (fail-safe)
	if (blockReasons.length > 0) {
		return {
			block: true,
			reason: withEscapeHints(`Command blocked:\n${blockReasons.join("\n")}`),
		};
	}
	// Segments needing confirmation → one prompt, confirm together
	if (confirmNeeded.length > 0) {
		return askConfirm(
			ctx,
			`⚠️ Commands requiring confirmation\n\n${confirmNeeded
				.map((s) => `· ${s}`)
				.join("\n")}\n\nConfirm execution?`,
			[...confirmRules],
		);
	}
	return; // Safe command: allow
}

export async function askConfirm(
	ctx: ExtensionContext,
	message: string,
	confirmRules: RuleId[] = [],
): Promise<ToolCallEventResult | undefined> {
	if (!ctx.hasUI) {
		return {
			block: true,
			reason: withEscapeHints(tagged("noUi", "No interactive UI; blocked")),
		};
	}

	// Third option: allow this once and session-pass the triggering rule(s). Shown
	// only outside naked (where a confirm already means "very dangerous") and never
	// for an excluded rule.
	const eligible =
		getMode() === "naked"
			? []
			: [...new Set(confirmRules)].filter((r) => !SESSION_PASS_EXCLUDED.has(r));
	const options = ["✅ Allow", "❌ Deny"];
	let passChoice: string | null = null;
	if (eligible.length === 1) {
		passChoice = `🔓 Allow & set ${eligible[0]} = pass (session)`;
	} else if (eligible.length > 1) {
		passChoice = `🔓 Allow & set ${eligible.length} rules = pass (session)`;
	}
	if (passChoice) options.push(passChoice);

	const choice = await ctx.ui.select(message, options);

	if (passChoice && choice === passChoice) {
		for (const r of eligible) sessionPassRule(getMode(), r);
		ctx.ui.notify(
			`Path Guard: ${eligible.join(", ")} = pass for this session (not persisted)`,
			"info",
		);
		return undefined; // allow this operation
	}
	if (choice !== "✅ Allow") {
		return { block: true, reason: "User denied the operation" };
	}
	return undefined; // allow
}
