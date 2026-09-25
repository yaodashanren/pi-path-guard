// path-guard — static constants: protected-path patterns, command sets,
// device targets, and UI copy constants. Leaf module (no internal imports).

import { homedir } from "node:os";

// ─── Configuration ──────────────────────────────────────────────────────

/** Protected path fragments — matching paths block writes/edits */
export const PROTECTED_PATH_PATTERNS = [
	".env",
	".envrc", // direnv config (can load arbitrary commands / credentials)
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
	".secrets/", // secrets dir (also covers a bare `.secrets` file)
	"credentials", // in-project credential files
	"id_rsa", // private keys that may live outside .ssh/
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
	"*.pem", // private keys (suffix match)
	"*.key", // private keys (suffix match)
	"*.p12", // PKCS#12 keystores
	"*.pfx", // PKCS#12 keystores (Windows)
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

/**
 * File patterns that must match the last path segment exactly and never a
 * `<name>.<suffix>` variant — `id_rsa.pub` is the public key, not the private one.
 */
export const EXACT_ONLY_PATTERNS = new Set([
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
]);

/**
 * `credentials.<ext>` extensions that clearly mark a non-secret template/example.
 * The bare `credentials` pattern blocks the exact name and sensitive variants
 * (`credentials.json`), but must not fire on these (issue: false positives).
 */
export const SAFE_CREDENTIAL_SUFFIXES = new Set([
	".example",
	".sample",
	".template",
	".tmpl",
	".dist",
	".md",
	".txt",
]);

/** Block group — system-destructive; blocked in every mode (no confirmation opportunity) */
export const BLOCK_DANGEROUS_PATTERNS: RegExp[] = [
	/\bmkfs\./,
	/\bmkswap\b/,
	/\bpoweroff\b/,
	/\breboot\b/,
	/\bshutdown\b/,
	/\binit\s+0\b/,
	/\binit\s+6\b/,
	// dd writing directly to a block device (ordinary files handled by judgeDd);
	// generic /dev/<dev> with fixed exclusions for harmless pseudo-devices
	/\bdd\b[^;|&]*\bof=\s*\/dev\/(?!null\b|zero\b|tty\b|stdin\b|stdout\b|stderr\b|pts\b|ptmx\b|full\b|random\b|urandom\b|fuse\b|shm\b)[a-z0-9]+/,
	// direct write to a block device (note: no \b — > is often preceded by a space)
	/(>|>>)\s*\/dev\/(?!null\b|zero\b|tty\b|stdin\b|stdout\b|stderr\b|pts\b|ptmx\b|full\b|random\b|urandom\b|fuse\b|shm\b)[a-z0-9]+/,
	/\bfind\b[^;|&]*-delete\b/, // find ... -delete bulk delete
	/\bfind\b[^;|&]*-exec(dir)?\b[^;|&]*\brm\b/, // find ... -exec rm bulk delete
	/\bxargs\b[^;|&]*\brm\b/, // xargs rm bulk delete (backup beyond judgeGit)
];

/** Confirm group — privilege escalation / remote / risky permissions: blocked in strict, confirmed otherwise */
export const CONFIRM_DANGEROUS_PATTERNS: RegExp[] = [
	/\bsudo\b/,
	/\b(doas|pkexec)\b/,
	/\b(chmod|chown)\b.*777/,
	/(?<!\.)\b(ssh|scp|sftp|rsh|telnet)\b/, // remote execution/operation (lookbehind avoids false hits on ~/.ssh/ etc.)
	/\bwget\s+-O\s+\/dev\/null\b/, // download discarded directly (harmless but conservative)
];

/** Delete commands requiring special handling */
export const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "wipe"]);

/** Overwrite commands — overwrite existing targets by default (ln needs -f/--force; handled separately) */
export const OVERWRITE_COMMANDS = new Set([
	"mv",
	"cp",
	"install",
	"tee",
	"ln",
	"rsync",
]);

/** In-place edit commands (-i rewrites in place) */
export const INPLACE_EDITORS = new Set(["sed", "perl", "ruby"]);

/** Shell wrappers: the -c argument is inline code that needs recursive checking */
export const SHELL_WRAPPERS = new Set([
	"bash",
	"sh",
	"zsh",
	"ksh",
	"dash",
	"fish",
	"csh",
	"tcsh",
]);

/**
 * Sources whose output piped into a shell is risky (remote fetch / inline-generated
 * code): `curl … | bash`, `wget -qO- … | sh`, `python -c '…' | sh`, etc.
 */
export const PIPE_TO_SHELL_SOURCES = new Set([
	"curl",
	"wget",
	"python",
	"python3",
	"perl",
	"node",
	"ruby",
	"php",
]);

/** Prefix commands: strip before checking the real command */
export const PREFIX_COMMANDS = new Set([
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
	"exec",
]);

/** Prefix flags that take a value (skip one extra token when stripping) */
export const FLAGS_WITH_ARG = new Set(["-u", "--user", "-g", "--group"]);

/** Redirecting to these devices is not a destructive truncate */
export const DEVICE_TARGETS = new Set([
	"/dev/null",
	"/dev/stdout",
	"/dev/stderr",
	"/dev/tty",
	"/dev/zero",
]);

export const HOME = homedir();

/** Global settings.json path (default pi agent dir; PI_CODING_AGENT_DIR overrides, per pi docs). */

/** pi project config dir name — fixed by pi (no override mechanism), see docs/configuration.md. */
export const CONFIG_DIR = ".pi";

/** Per-segment check: protected redirect → block; dangerous commands → confirm/block; the rest to sub-judges / wrapper recursion */
/** Shell interpreters whose `<interp> [flags] script.sh` form executes a script file. */
export const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/** Body of the trusted-path warning (used by both confirm paths). */
export const TRUST_PATH_WARNING =
	"A trusted path is ALWAYS allowed: path-guard will not block or prompt for writes/edits/deletes/overwrites/truncates inside it, in ANY mode (like trusted mode for just that path).\n\nOnly protected paths (which can never be trusted) still apply. Confirm trusting it?";

/** Body of the single trusted-mode switch warning. */
export const TRUSTED_SWITCH_WARNING =
	"trusted is the most permissive mode: in-project deletes and outside overwrites/deletes of\nordinary files are no longer prompted. Only protected paths and system-destructive commands\nremain blocked.\n\npi's behavior boundary is very loose in this mode — please confirm the switch.";

/** First of the two naked-mode switch warnings. */
export const NAKED_SWITCH_WARNING_1 =
	"naked passes nearly everything: protected paths (.env/.ssh/keys), write/edit tool checks, git\ndestructive ops, truncation, and outside deletes/overwrites are no longer blocked or prompted.\nOnly system-destructive commands (mkfs/reboot/bulk-delete/block-device writes) are still\nconfirmed — everything else is allowed without a prompt.";

/** Second, final naked-mode switch warning. */
export const NAKED_SWITCH_WARNING_2 =
	"This is the final step. After this, path-guard passes nearly every operation with no blocking and\nno confirmation, including writes to protected paths and git destructive / truncate / outside\ndelete operations. Only system-destructive commands (mkfs/reboot/bulk-delete/block-device\nwrites) will still prompt for confirmation.\n\nOnly switch if you are certain you want minimal protection.";

