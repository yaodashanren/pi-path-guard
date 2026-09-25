// path-guard — shell command parsing: tokenizer, segment splitting, command
// parsing (prefix stripping, leading-substitution rewrite), redirect/heredoc
// extraction. Pure functions, no judging logic.

import { resolve } from "node:path";
import { PREFIX_COMMANDS, DELETE_COMMANDS } from "./constants.ts";
import { expandHome, isOutsideCwd, resolveReal } from "./paths.ts";

/**
 * Extract command substitutions (`$(...)` and backticks) from a command segment.
 * Substitutions inside single quotes are literal, so they are skipped. Nested
 * `$()` bodies are returned whole and handled by the recursive call.
 */
export function extractCommandSubstitutions(input: string): string[] {
	const results: string[] = [];
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	while (i < input.length) {
		const ch = input[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			i++;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			i++;
			continue;
		}
		if (inSingle) {
			i++;
			continue;
		}
		// Backtick substitution
		if (ch === "`") {
			const end = input.indexOf("`", i + 1);
			if (end < 0) {
				results.push(input.slice(i + 1));
				break;
			}
			results.push(input.slice(i + 1, end));
			i = end + 1;
			continue;
		}
		// Process substitution <(cmd) / >(cmd) — the inner command runs
		// immediately, so judge its body like a command substitution
		if ((ch === "<" || ch === ">") && input[i + 1] === "(") {
			const close = findMatchingParen(input, i + 1);
			if (close < 0) {
				results.push(input.slice(i + 2));
				break;
			}
			results.push(input.slice(i + 2, close));
			i = close;
			continue;
		}
		// $( ... ) — balanced, quote-aware; `$((` arithmetic is left to the parser
		if (ch === "$" && input[i + 1] === "(" && input[i + 2] !== "(") {
			const j = findMatchingParen(input, i + 1);
			if (j < 0) {
				results.push(input.slice(i + 2));
				break;
			}
			results.push(input.slice(i + 2, j));
			i = j + 1;
			continue;
		}
		i++;
	}
	return results;
}

/**
 * Index of the ")" matching the "(" at openIdx (quote- and escape-aware), or -1.
 */
export function findMatchingParen(input: string, openIdx: number): number {
	let depth = 0;
	let sq = false;
	let dq = false;
	for (let j = openIdx; j < input.length; j++) {
		const c = input[j];
		if (c === "\\") {
			j++;
			continue;
		}
		if (c === "'" && !dq) {
			sq = !sq;
			continue;
		}
		if (c === '"' && !sq) {
			dq = !dq;
			continue;
		}
		if (sq) continue;
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return j;
		}
	}
	return -1;
}

/** Whether args contain a short flag (supports -i.bak / -pi combos; single-dash only) */
export function hasShortFlag(args: string[], ch: string): boolean {
	return args.some(
		(a) => a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes(ch),
	);
}

/** Whether args contain a long flag (--name or --name=value) */
export function hasLongFlag(args: string[], name: string): boolean {
	return args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

export interface CmdInfo {
	command: string; // base command name (rm, rmdir, etc.)
	args: string[]; // non-flag args (potential paths)
}

/** Parse a shell command into name and args (strips prefix commands first) */
export function parseCommand(fullCommand: string): CmdInfo | null {
	// Strip command-substitution $(...), subshell (...), and group {...} wrappers
	let cleaned = fullCommand.trim();
	// A LEADING command substitution supplies the command name itself:
	// `$(echo rm) -rf x` executes `rm -rf x` — replace it with the last word of
	// its body so the judges see the real command instead of the literal `$(echo`.
	cleaned = replaceLeadingSubstitutionCommand(cleaned);
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

/**
 * Replace a leading command substitution (`$(…) ` or backtick form) with the last
 * word of its body — when a substitution sits in command-name position, its value
 * IS the executed command. Returns the input unchanged when there is no leading
 * substitution or the parentheses cannot be balanced.
 */
export function replaceLeadingSubstitutionCommand(input: string): string {
	let body: string;
	let rest: string;
	if (input.startsWith("$(")) {
		let depth = 0;
		let i = 1;
		for (; i < input.length; i++) {
			if (input[i] === "(") depth++;
			else if (input[i] === ")") {
				depth--;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) return input;
		body = input.slice(2, i);
		rest = input.slice(i + 1);
	} else if (input.startsWith("`")) {
		const end = input.indexOf("`", 1);
		if (end < 0) return input;
		body = input.slice(1, end);
		rest = input.slice(end + 1);
	} else {
		return input;
	}
	const words = body.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return input;
	return words[words.length - 1] + rest;
}

/** Strip prefix commands (sudo etc.), skipping their flags / numbers / VAR= assignments */
export function stripPrefixTokens(tokens: string[]): string[] {
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
export function isDeleteCommand(cmd: string): boolean {
	return DELETE_COMMANDS.has(cmd);
}

/** Whether args carry a force flag (-f / --force, supports -sf / -fdx combos) */
export function hasForceFlag(args: string[]): boolean {
	return args.some((a) => {
		if (!a.startsWith("-")) return false;
		if (a.startsWith("--")) return a === "--force" || a.startsWith("--force=");
		return a.slice(1).includes("f");
	});
}

/** Overwrite command "target" — last non-flag arg; null if none */
export function lastDestArg(args: string[]): string | null {
	for (let i = args.length - 1; i >= 0; i--) {
		const a = args[i];
		if (a.startsWith("-")) continue;
		if (a === ">" || a === ">>" || a === "2>" || a === "2>>") continue;
		return a;
	}
	return null;
}

/** Extract path-like tokens from args, resolve to absolute, classify in/out */
export function extractPathArgs(
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

export interface RedirectTarget {
	op: string; // redirect operator (>, 2>, &>, >>, 2>>...)
	target: string; // target path
}

export function extractRedirectTarget(fullCommand: string): RedirectTarget | null {
	const tokens = splitShellTokens(fullCommand);
	const REDIR = /^([0-9]*&?>>?\|?)(.*)$/;
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

/** Whether the operator is truncating (single >, or the >| noclobber override — not >> append) */
export function isTruncatingOp(op: string): boolean {
	// `>|` / `2>|` explicitly clobber a file even under noclobber → truncating
	if (op.endsWith("|")) return true;
	return op.endsWith(">") && !op.endsWith(">>");
}

/** Minimal shell tokenizer (handles single/double quotes) */
export function splitShellTokens(input: string): string[] {
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

/**
 * Extract heredoc bodies (`<<TAG` / `<<-TAG`, terminated by a line equal to the
 * tag). The body is executed as script text by the shell, so it must be judged
 * like command segments; it is removed from the returned command so the
 * per-segment scanners don't misparse it. `<<<` herestrings are data, not
 * commands — left in place. The `<<TAG` marker must be unquoted; a quoted `<<'
 * literal in a string does not start a heredoc.
 */
export function extractHeredocs(input: string): {
	command: string;
	bodies: string[];
} {
	const bodies: string[] = [];
	const lines = input.split("\n");
	const out: string[] = [];
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li];
		const m = line.match(/<<(-?)([A-Za-z_][A-Za-z0-9_]*)/);
		if (m && m.index !== undefined && !isQuotedAt(line, m.index)) {
			const dash = m[1] === "-";
			const tag = m[2];
			const body: string[] = [];
			let closed = false;
			let lj = li + 1;
			for (; lj < lines.length; lj++) {
				const t = dash ? lines[lj].replace(/^\t+/, "").trim() : lines[lj].trim();
				if (t === tag) {
					closed = true;
					break;
				}
				body.push(lines[lj]);
			}
			bodies.push(body.join("\n"));
			// strip the <<TAG marker from the intro line, keep the rest of the command
			out.push(line.replace(m[0], "").trimEnd());
			if (closed) {
				li = lj; // skip past the terminator line
			} else {
				li = lines.length; // unterminated: the rest was body
			}
			continue;
		}
		out.push(line);
	}
	return { command: out.join("\n"), bodies };
}

/** Whether the character at idx sits inside a single/double-quoted span of line */
export function isQuotedAt(line: string, idx: number): boolean {
	let sq = false;
	let dq = false;
	for (let i = 0; i < idx; i++) {
		const c = line[i];
		if (c === "'" && !dq) sq = !sq;
		else if (c === '"' && !sq) dq = !dq;
	}
	return sq || dq;
}

/** Split by shell operators (&&, ||, ;, |, newline); never inside quotes */
export function splitSegments(input: string): string[] {
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
			// `>|` / `>>|` is the noclobber redirect override, not a pipe separator
			const noclobber = ch === "|" && input[i - 1] === ">";
			const isSep =
				(ch === "|" && !noclobber) ||
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
