// path-guard — explain hint ladder: verdict-aware escape-hint copy.
// Leaf module (no internal behavior imports). hintFor picks the honest next
// step for a verdict: rule tweak before mode lowering, naked as last resort.
// English-only, phrasing reuses escape.ts ESCAPE_HINTS where it fits.
import { SESSION_PASS_EXCLUDED } from "./rules.ts";
import type { GuardMode, RuleId } from "./schema.ts";
import { RULE_IDS } from "./schema.ts";
import { getLayers, getMode, isHomeCwd, isSessionPassed } from "./rules.ts";
import { resolveReal } from "./paths.ts";
import { extractHeredocs, splitSegments } from "./shell-parse.ts";
import { classifySegment, scanPipeToShell } from "./judges.ts";
import { TraceCollector, type TraceEntry } from "./trace.ts";

export function hintFor(
	kind: "pass" | "confirm" | "block",
	rules: RuleId[],
	mode: GuardMode,
): string {
	if (kind === "pass") {
		return "allowed as-is — no guard rule fired for this operation";
	}
	if (mode === "naked") {
		// Last resort: no rule-tweak ladder makes sense in naked mode.
		return "naked mode is a last resort — most guard rules are off; expect a prompt only for the most dangerous operations";
	}
	if (kind === "block" && rules.length === 0) {
		// Built-in protected path: never suggest naked as the way out.
		return "built-in protected path — use a different target path, or copy the file out first";
	}
	if (kind === "confirm") {
		const eligible = rules.filter((r) => !SESSION_PASS_EXCLUDED.has(r));
		if (rules.length === 0) {
			// Conservative-confirm (e.g. depth limit): simplify the command instead.
			return "conservative confirm (command too complex to analyze) — simplify or unwrap the command so it can be checked statically";
		}
		if (eligible.length === 0) {
			// sudo/ssh-class: asked again every time, by design; no session pass.
			return "sudo/ssh-class rules ask again every time (by design) — no one-shot allow is offered for them";
		}
		// Ladder: rule tweak first, session pass second, mode lowering last.
		return `tune just this rule first (/guard rules ${eligible[0]} = pass|block), or allow it for the rest of this session with a session pass (Allow & set … = pass (session)); loosening the whole mode (/guard loose|trusted) is a bigger step`;
	}
	// block with rules: rule-level block copy, ladder order preserved.
	return `rule-level block — tune just this rule (/guard rules), or loosen the mode (/guard loose|trusted) as a bigger step`;
}

// ── explainView: pure, read-only walk of the checkBashCommand skeleton ──

export interface ExplainCtx {
	cwd: string;
	hasUI: boolean;
}

/** Where the effective mode came from, reduced to one word for the config line. */
function modeSourceWord(): string {
	const layers = getLayers();
	if (layers.project?.mode) return "project";
	if (layers.authored?.layer.mode) return "authored";
	if (layers.global.mode) return "global";
	return "default";
}

function renderTraceEntry(e: TraceEntry): string {
	const indent = " ".repeat(2 + e.depth * 2);
	let line = `${indent}${e.verdict} ${e.label}`;
	if (e.rules.length > 0) line += ` (rules: ${e.rules.join(", ")})`;
	if (e.reason) line += ` — ${e.reason}`;
	return line;
}

/**
 * Render the same classification walk checkBashCommand performs — heredocs →
 * pipe scan → per-segment — into a human-readable view. Pure: no UI, no
 * prompts, no askConfirm; aggregation mirrors the pipeline (any block → block,
 * else any confirm → confirm, else pass).
 */
export function explainView(command: string, ctx: ExplainCtx): string {
	const trace = new TraceCollector();
	const realCwd = resolveReal(ctx.cwd);
	const mode = getMode();
	let blockReason: string | undefined;
	let confirm = false;
	const confirmRules = new Set<RuleId>();

	// Heredoc bodies are executed as script text: judge line by line (depth 0).
	const { command: bareCommand, bodies: heredocBodies } = extractHeredocs(command);
	for (const body of heredocBodies) {
		for (const line of body.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			const v = classifySegment(t, realCwd, ctx.hasUI, 0, trace);
			trace.add({
				depth: 0,
				label: `heredoc: ${t}`,
				verdict: v.kind,
				rules: v.rules ?? [],
				reason: v.kind === "block" ? v.reason.split("\n")[0] : undefined,
			});
			if (v.kind === "block") blockReason ??= v.reason.split("\n")[0];
			else if (v.kind === "confirm") {
				confirm = true;
				for (const rule of v.rules ?? []) confirmRules.add(rule);
			}
		}
	}

	// Pipe-to-shell scan crosses segments; skip `pass` entries (pure noise).
	const pipeVerdict = scanPipeToShell(bareCommand, realCwd);
	if (pipeVerdict.kind !== "pass") {
		trace.add({
			depth: 0,
			label: command.trim(),
			verdict: pipeVerdict.kind,
			rules: pipeVerdict.rules ?? [],
			reason:
				pipeVerdict.kind === "block"
					? pipeVerdict.reason.split("\n")[0]
					: undefined,
		});
	}
	if (pipeVerdict.kind === "block") blockReason ??= pipeVerdict.reason.split("\n")[0];
	else if (pipeVerdict.kind === "confirm") {
		confirm = true;
		for (const rule of pipeVerdict.rules ?? []) confirmRules.add(rule);
	}

	// Per-segment scan (same split as the pipeline).
	for (const seg of splitSegments(bareCommand)) {
		const trimmed = seg.trim();
		if (!trimmed) continue;
		const verdict = classifySegment(trimmed, realCwd, ctx.hasUI, 0, trace);
		if (verdict.kind === "block") blockReason ??= verdict.reason.split("\n")[0];
		else if (verdict.kind === "confirm") {
			confirm = true;
			for (const rule of verdict.rules ?? []) confirmRules.add(rule);
		}
	}

	// Aggregate exactly like checkBashCommand: block > confirm > pass.
	const kind: "pass" | "confirm" | "block" = blockReason
		? "block"
		: confirm
			? "confirm"
			: "pass";
	const rules = [...confirmRules];

	// Config line
	const passes = RULE_IDS.filter((r) => isSessionPassed(mode, r));
	const homeSuffix = isHomeCwd(ctx.cwd) ? " · HOME" : "";
	const lines: string[] = [
		`Config:  mode: ${mode} (source: ${modeSourceWord()}) · session passes: ${passes.length > 0 ? passes.join(", ") : "none"} · cwd: ${realCwd}${homeSuffix}`,
	];
	lines.push("Trace:");
	for (const e of trace.entries()) lines.push(renderTraceEntry(e));
	if (kind === "block") {
		lines.push(
			blockReason
				? `Verdict: block — ${blockReason}`
				: "Verdict: block",
		);
	} else if (kind === "confirm") {
		const note = ctx.hasUI
			? "would prompt"
			: "would prompt (no UI → blocked)";
		lines.push(
			`Verdict: confirm (rules: ${rules.join(", ")}) — ${note}`,
		);
	} else {
		lines.push("Verdict: pass");
	}
	lines.push(`Hint:    ${hintFor(kind, rules, mode)}`);
	return lines.join("\n");
}
