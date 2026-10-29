// doctor.ts — /guard doctor: a one-screen status report of the layered config.
// Pure view: reads rules.ts accessors, returns a string, no UI, no side effects.

import {
	getConfigWarnings,
	getLayers,
	getMode,
	globalSettingsPath,
	isHomeCwd,
	pathEntries,
	sessionPassList,
} from "./rules.ts";
import { GUARD_MODES } from "./schema.ts";
import type { PathGuardLayer } from "./schema.ts";

/** Number of rule overrides stored in one layer (rules.<mode>.<rule> leaves). */
function ruleCount(layer: PathGuardLayer | undefined): number {
	let n = 0;
	for (const rules of Object.values(layer?.rules ?? {})) n += Object.keys(rules ?? {}).length;
	return n;
}

/** Where the effective mode came from: project layer > authored block > global > default. */
function modeSource(
	layers: ReturnType<typeof getLayers>,
): string {
	if (layers.project?.mode && layers.projectFile) {
		return `(from project layer: ${layers.projectFile})`;
	}
	if (layers.authored?.layer.mode) {
		return `(from authored project config, read-only: ${layers.authored.file})`;
	}
	if (layers.global.mode) return "(from global settings)";
	return "(default)";
}

/** One `raw → normalized [layer]` bullet per configured path, or "(none)". */
function pathSection(title: string, kind: "protected" | "trusted"): string {
	const entries = pathEntries(kind);
	if (entries.length === 0) return `${title}: (none)`;
	const lines = entries.map(
		(e) => `  · ${e.raw} → ${e.normalized} [${e.layer}]`,
	);
	return [`${title}:`, ...lines].join("\n");
}

/**
 * Human-readable diagnostic view for `/guard doctor`: active mode + source,
 * every config layer with provenance, config warnings, effective path lists
 * with layer tags, session-pass rules, and the current session's cwd/HOME state.
 */
export function doctorView(cwd: string | undefined): string {
	const layers = getLayers();
	const warnings = getConfigWarnings();
	const lines: string[] = ["Path Guard doctor"];

	// Mode + where it came from
	lines.push(`· mode: ${getMode()} ${modeSource(layers)}`);

	// Layers with provenance
	lines.push("· layers:");
	const g = layers.global;
	lines.push(
		`  · global: ${globalSettingsPath()}` +
			` (mode: ${g.mode ?? "-"}, protected: ${(g.extraProtected ?? []).length},` +
			` trusted: ${(g.trustedPaths ?? []).length}, rules: ${ruleCount(g)})`,
	);
	if (layers.project) {
		const p = layers.project;
		lines.push(
			`  · project: ${layers.projectFile}` +
				` (matched via ${layers.matchedVia ?? "exact"}),` +
				` mode: ${p.mode ?? "-"}, protected: ${(p.extraProtected ?? []).length},` +
				` trusted: ${(p.trustedPaths ?? []).length}, rules: ${ruleCount(p)}`,
		);
	} else if (layers.authored) {
		lines.push(
			`  · authored (read-only fallback): ${layers.authored.file}` +
				` (mode: ${layers.authored.layer.mode ?? "-"},` +
				` rules: ${ruleCount(layers.authored.layer)})`,
		);
	} else if (isHomeCwd(cwd)) {
		lines.push("  · project: (none — HOME is never treated as a project)");
	} else {
		lines.push("  · project: (none — using the global layer only)");
	}

	// Config warnings from the last read
	if (warnings.length === 0) {
		lines.push("· config warnings: (none)");
	} else {
		lines.push("· config warnings:");
		for (const w of warnings) {
			lines.push(` · ${w.path}: ${w.field ? `${w.field}: ` : ""}${w.message}`);
		}
	}

	// Effective path entries, tagged by layer (protection always outranks trust)
	lines.push(pathSection("· protected paths", "protected"));
	lines.push(pathSection("· trusted paths", "trusted"));

	// Session-only rule passes (never written to disk)
	const passLines: string[] = [];
	for (const mode of GUARD_MODES) {
		const rules = sessionPassList(mode);
		if (rules.length > 0) passLines.push(`  · ${mode}: ${rules.join(", ")}`);
	}
	if (passLines.length === 0) {
		lines.push("· session-pass rules: (none)");
	} else {
		lines.push("· session-pass rules:", ...passLines);
	}
	lines.push("  (session passes are cleared on new session, never persisted)");

	// Session context
	lines.push("· session:");
	lines.push(`  · cwd: ${cwd ?? "(none)"}`);
	lines.push(`  · home cwd: ${isHomeCwd(cwd) ? "yes" : "no"}`);

	return lines.join("\n");
}
