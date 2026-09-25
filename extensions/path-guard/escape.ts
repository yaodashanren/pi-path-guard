// path-guard — block escape hints: classify a block reason into an escape
// category ([cat:] structured tag) and append honest per-category hints.
// Leaf module (no internal imports).

// ─── Block escape hints ────────────────────────────────────────────────
// A block is opaque without guidance on how to actually run the thing. Each
// blocked line is classified into one escape category and a short, honest
// hint (English + brief Chinese) is appended for every category present, so
// the advice always matches why it was blocked.

export type EscapeCat =
	| "userPath" // user-configured protected path → blocked in EVERY mode (incl. naked)
	| "protectedPath" // built-in protected path → only naked bypasses
	| "systemDestructive" // mkfs/reboot/bulk-delete/block-device → naked still prompts
	| "noUi" // a confirm-grade op blocked because there is no interactive UI
	| "rule"; // some rule is set to block at the current level → loosen it

export const ESCAPE_HINTS: Record<EscapeCat, { en: string; zh: string }> = {
	userPath: {
		en: "user-configured protected path — blocked in every mode; remove it with /guard paths rm <path>",
		zh: "自定义保护路径，所有模式强制拦截；请先用 /guard paths rm 移除",
	},
	protectedPath: {
		en: "built-in protected path — only /guard naked bypasses it",
		zh: "内置保护路径，仅 /guard naked 会放行",
	},
	systemDestructive: {
		en: "system-destructive command — /guard naked still prompts once before running it",
		zh: "系统级破坏命令，/guard naked 后仍会再向你确认一次",
	},
	noUi: {
		en: "needs an interactive confirm — run it in the TUI, or loosen this rule to pass",
		zh: "需要交互确认，请在 TUI 里运行，或把该规则调为 pass",
	},
	rule: {
		en: "rule-level block — loosen the mode (/guard loose|trusted|naked) or tune just this rule (/guard rules)",
		zh: "规则级拦截，可切换 /guard loose 或 /guard rules 调整该条规则",
	},
};

/** Prefix a reason with its structural escape category (stripped on display). */
export function tagged(cat: EscapeCat, reason: string): string {
	return `[cat:${cat}] ${reason}`;
}

export const CAT_TAG_RE = /\[cat:([A-Za-z]+)\]/;

/** Pick the single most specific category for one blocked-reason line. */
export function escapeCatOf(line: string): EscapeCat {
	const m = line.match(CAT_TAG_RE);
	if (m && m[1] in ESCAPE_HINTS) return m[1] as EscapeCat;
	// legacy fallback for untagged lines
	if (/user-protected/i.test(line)) return "userPath";
	if (/system-destructive/i.test(line)) return "systemDestructive";
	if (/protected\b/i.test(line)) return "protectedPath";
	if (/no interactive ui/i.test(line)) return "noUi";
	return "rule";
}

/**
 * Append per-category "how to run this" hints to a block message.
 * Structural header lines (ending in ':') and blanks are skipped, so nested
 * multi-line reasons are still classified by their individual detail lines.
 */
export function withEscapeHints(reason: string): string {
	const cats = new Set<EscapeCat>();
	for (const line of reason.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		if (t.endsWith(":")) continue; // "Command blocked:" / "Inner command blocked:"
		cats.add(escapeCatOf(t));
	}
	if (cats.size === 0) return reason.replace(CAT_TAG_RE, "");
	const clean = reason.replace(/\[cat:[A-Za-z]+\] /g, "");
	const order: EscapeCat[] = [
		"systemDestructive",
		"protectedPath",
		"userPath",
		"noUi",
		"rule",
	];
	const hintLines: string[] = [];
	for (const cat of order) {
		if (cats.has(cat)) {
			// English and Chinese on separate lines so long hints stay readable.
			hintLines.push(`· ${ESCAPE_HINTS[cat].en}\n  ${ESCAPE_HINTS[cat].zh}`);
		}
	}
	return `${clean}\n\nTo run anyway / 如需执行:\n${hintLines.join("\n")}`;
}

