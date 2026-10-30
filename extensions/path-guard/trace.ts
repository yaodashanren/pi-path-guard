// trace.ts — read-only trace collector for the classification pipeline.
// Standalone: later tasks thread TraceEntry records through segment/heredoc/pipe
// scanning so verdicts can carry an explainable trail. No behavior change here.
import type { RuleId } from "./schema.ts";

/** One classification step recorded while scanning a command. */
export interface TraceEntry {
	/** 0 = top-level segment/heredoc/pipe scan; grows with nesting. */
	depth: number;
	/** Segment text, or "heredoc:"/"substitution:"/"wrapper:" prefix + text. */
	label: string;
	verdict: "pass" | "confirm" | "block";
	/** Matching rule ids; may be [] (e.g. depth-limit or path-block reasons). */
	rules: RuleId[];
	/** Single-line reason phrase from the verdict. */
	reason?: string;
	pathResolution?: { raw: string; normalized: string };
}

/** Accumulates TraceEntry records; entries() returns a defensive copy. */
export class TraceCollector {
	private list: TraceEntry[] = [];

	add(entry: TraceEntry): void {
		this.list.push(entry);
	}

	entries(): readonly TraceEntry[] {
		return this.list.map((e) => ({ ...e }));
	}

	clear(): void {
		this.list = [];
	}
}
