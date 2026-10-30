// path-guard — explain hint ladder: verdict-aware escape-hint copy.
// Leaf module (no internal behavior imports). hintFor picks the honest next
// step for a verdict: rule tweak before mode lowering, naked as last resort.
// English-only, phrasing reuses escape.ts ESCAPE_HINTS where it fits.
import { SESSION_PASS_EXCLUDED } from "./rules.ts";
import type { GuardMode, RuleId } from "./schema.ts";

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
