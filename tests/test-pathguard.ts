/**
 * Path Guard v3 mode-matrix tests
 * Loads the real extension with a mocked pi API and verifies judgment per mode.
 * Verdict recognition: returns {block:true} → block; calls ui.select → confirm; otherwise → pass
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const EXT = new URL("../extensions/path-guard.ts", import.meta.url).href;

// ── mocked pi API ───────────────────────────────────────────
const handlers: Record<string, (e: any, ctx: any) => any> = {};
const commands: Record<string, { handler: (args: string, ctx: any) => any }> =
	{};
const fakePi = {
	on(event: string, cb: (e: any, ctx: any) => any) {
		handlers[event] = cb;
	},
	registerCommand(
		name: string,
		def: { handler: (args: string, ctx: any) => any },
	) {
		commands[name] = def;
	},
};

const mod = await import(EXT);
mod.default(fakePi);

// ── test helpers ────────────────────────────────────────────
let selectCalls = 0;
async function runTool(
	toolName: string,
	input: any,
	opts: { cwd: string; hasUI?: boolean },
): Promise<{
	verdict: "block" | "confirm" | "pass";
	reason?: string;
	selectCalls: number;
}> {
	selectCalls = 0;
	const ctx = {
		cwd: opts.cwd,
		hasUI: opts.hasUI ?? true,
		ui: {
			select: async (_msg: string, choices: string[]) => {
				selectCalls++;
				return choices[0]; // user picks "Allow"
			},
		},
	};
	const result = await handlers["tool_call"]({ toolName, input }, ctx);
	if (result && result.block)
		return { verdict: "block", reason: result.reason, selectCalls };
	if (selectCalls > 0) return { verdict: "confirm", selectCalls };
	return { verdict: "pass", selectCalls };
}

async function runCmd(command: string, cwd: string) {
	return runTool("bash", { command }, { cwd });
}

async function setMode(mode: string) {
	// switch with argument (hasUI + confirm default allows)
	const notify: string[] = [];
	await commands["guard"].handler(mode, {
		hasUI: true,
		ui: {
			notify: (m: string) => notify.push(m),
			confirm: async () => true,
		},
	});
	return notify.join(" | ");
}

async function currentModeShown() {
	// no-UI, no-arg → shows current mode
	const notify: string[] = [];
	await commands["guard"].handler("", {
		ui: { notify: (m: string) => notify.push(m) },
	});
	return notify.join(" | ");
}

function newSession() {
	handlers["session_start"]({ reason: "startup" }, {});
}

// ── prepare test dirs ───────────────────────────────────────
const PROJ = "/tmp/pgtest/proj";
const OUT = "/tmp/pgtest/out";
mkdirSync(PROJ, { recursive: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(PROJ, "inside.txt"), "x");
writeFileSync(join(OUT, "outside_exist.txt"), "x");
writeFileSync(join(PROJ, ".env"), "SECRET=1");

let pass = 0,
	fail = 0;
const failures: string[] = [];
function check(name: string, actual: string, expected: string) {
	if (actual === expected) {
		pass++;
	} else {
		fail++;
		failures.push(`${name}: expected ${expected}, got ${actual}`);
	}
}

// ── cases ───────────────────────────────────────────────────
newSession(); // simulate new session → normal

// ── /guard command ──────────────────────────────────────────
// interactive: no arg + hasUI → select pops, picking loose switches
let selectResult: string | undefined = "";
let selectTitle = "";
await commands["guard"].handler("", {
	hasUI: true,
	ui: {
		notify: () => {},
		select: async (title: string, options: string[]) => {
			selectTitle = title;
			selectResult = options.find((o) => o.startsWith("loose")) ?? undefined;
			return selectResult;
		},
	},
});
check(
	"/guard no-arg pops interactive select",
	selectResult?.startsWith("loose") ? "select" : "?",
	"select",
);
check(
	"/guard title marks current mode",
	selectTitle.includes("normal") ? "marked" : "?",
	"marked",
);
check(
	"/guard picking loose applies",
	(await currentModeShown()).includes("loose") ? "loose" : "?",
	"loose",
);

// cancel (select returns undefined) → mode unchanged
let cancelMsg = "";
await commands["guard"].handler("", {
	hasUI: true,
	ui: {
		notify: (m: string) => (cancelMsg = m),
		select: async () => undefined,
	},
});
check(
	"/guard cancel notice",
	cancelMsg.includes("Cancelled") ? "cancelled" : "?",
	"cancelled",
);
check(
	"mode stays loose after cancel",
	(await currentModeShown()).includes("loose") ? "loose" : "?",
	"loose",
);

// invalid arg → fallback select
let bogusOptions: string[] = [];
await commands["guard"].handler("bogus", {
	hasUI: true,
	ui: {
		notify: () => {},
		select: async (_t: string, options: string[]) => {
			bogusOptions = options;
			return undefined;
		},
	},
});
check(
	"/guard invalid arg falls back to select",
	bogusOptions.length === 4 ? "select" : "?",
	"select",
);

// no-UI no-arg → shows current mode
let noUIMsg = "";
await commands["guard"].handler("", {
	ui: { notify: (m: string) => (noUIMsg = m) },
});
check(
	"/guard no-UI shows mode",
	noUIMsg.includes("loose") ? "shown" : "?",
	"shown",
);

// ── trusted switch warning confirmation ─────────────────────
// shortcut: confirm rejects → no switch
let trustedConfirmCalled = false;
await commands["guard"].handler("trusted", {
	hasUI: true,
	ui: {
		notify: () => {},
		confirm: async () => {
			trustedConfirmCalled = true;
			return false;
		},
	},
});
check(
	"trusted shortcut pops warning confirm",
	trustedConfirmCalled ? "confirm" : "?",
	"confirm",
);
check(
	"trusted rejected → no switch",
	(await currentModeShown()).includes("loose") ? "loose" : "?",
	"loose",
);

// shortcut: confirm allows → switch succeeds
await setMode("trusted");
check(
	"trusted confirmed → switches",
	(await currentModeShown()).includes("trusted") ? "trusted" : "?",
	"trusted",
);

// interactive trusted selection also requires confirm
let interactiveTrustedConfirm = false;
await commands["guard"].handler("", {
	hasUI: true,
	ui: {
		notify: () => {},
		select: async (_t: string, options: string[]) =>
			options.find((o) => o.startsWith("trusted"))!,
		confirm: async () => {
			interactiveTrustedConfirm = true;
			return true;
		},
	},
});
check(
	"interactive trusted pops warning",
	interactiveTrustedConfirm ? "confirm" : "?",
	"confirm",
);

// new session resets to normal
newSession();
check(
	"new session resets to normal",
	(await currentModeShown()).includes("normal") ? "normal" : "?",
	"normal",
);

// ── protected paths (block in every mode) ───────────────────
for (const mode of ["strict", "normal", "loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} write .env → block`,
		(await runTool("write", { path: join(PROJ, ".env") }, { cwd: PROJ })).verdict,
		"block",
	);
	check(
		`${mode} bash echo > .env → block`,
		(await runCmd(`echo x > ${PROJ}/.env`, PROJ)).verdict,
		"block",
	);
	check(
		`${mode} rm .ssh file → block`,
		(await runCmd(`rm ${homedir()}/.ssh/config`, PROJ)).verdict,
		"block",
	);
}

// ── system-destructive (block in every mode) ────────────────
for (const mode of ["strict", "normal", "loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} mkfs → block`,
		(await runCmd("mkfs.ext4 /dev/sdb1", PROJ)).verdict,
		"block",
	);
	check(
		`${mode} find -delete → block`,
		(await runCmd("find . -name '*.tmp' -delete", PROJ)).verdict,
		"block",
	);
	check(
		`${mode} shutdown → block`,
		(await runCmd("shutdown now", PROJ)).verdict,
		"block",
	);
}

// ── Confirm-group dangerous: strict block, others confirm ───
await setMode("strict");
check(
	"strict sudo → block",
	(await runCmd("sudo ls /root", PROJ)).verdict,
	"block",
);
check(
	"strict ssh → block",
	(await runCmd("ssh user@host", PROJ)).verdict,
	"block",
);
for (const mode of ["normal", "loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} sudo → confirm`,
		(await runCmd("sudo ls /root", PROJ)).verdict,
		"confirm",
	);
	check(
		`${mode} chmod 777 → confirm`,
		(await runCmd("chmod 777 somefile", PROJ)).verdict,
		"confirm",
	);
}

// ── in-project write/edit: strict confirm, others pass ──────
await setMode("strict");
check(
	"strict in-project write → confirm",
	(await runTool("write", { path: join(PROJ, "new.txt") }, { cwd: PROJ }))
		.verdict,
	"confirm",
);
for (const mode of ["normal", "loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} in-project write → pass`,
		(await runTool("write", { path: join(PROJ, "new.txt") }, { cwd: PROJ }))
			.verdict,
		"pass",
	);
}

// ── outside write (new file): normal/strict confirm, loose/trusted pass ──
for (const mode of ["strict", "normal"]) {
	await setMode(mode);
	check(
		`${mode} outside new-file write → confirm`,
		(await runTool("write", { path: join(OUT, "fresh.txt") }, { cwd: PROJ }))
			.verdict,
		"confirm",
	);
}
for (const mode of ["loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} outside new-file write → pass`,
		(await runTool("write", { path: join(OUT, "fresh.txt") }, { cwd: PROJ }))
			.verdict,
		"pass",
	);
}

// ── outside overwrite existing: normal/strict block, loose confirm, trusted pass ──
for (const mode of ["strict", "normal"]) {
	await setMode(mode);
	check(
		`${mode} mv overwrite outside → block`,
		(await runCmd(`mv ${PROJ}/inside.txt ${OUT}/outside_exist.txt`, PROJ))
			.verdict,
		"block",
	);
}
await setMode("loose");
check(
	"loose mv overwrite outside → confirm",
	(await runCmd(`mv ${PROJ}/inside.txt ${OUT}/outside_exist.txt`, PROJ)).verdict,
	"confirm",
);
await setMode("trusted");
check(
	"trusted mv overwrite outside → pass",
	(await runCmd(`mv ${PROJ}/inside.txt ${OUT}/outside_exist.txt`, PROJ)).verdict,
	"pass",
);

// ── outside delete: normal/strict block, loose confirm, trusted pass ──
writeFileSync(join(OUT, "del.txt"), "x");
for (const mode of ["strict", "normal"]) {
	await setMode(mode);
	check(
		`${mode} rm outside → block`,
		(await runCmd(`rm ${OUT}/del.txt`, PROJ)).verdict,
		"block",
	);
}
await setMode("loose");
check(
	"loose rm outside → confirm",
	(await runCmd(`rm ${OUT}/del.txt`, PROJ)).verdict,
	"confirm",
);
await setMode("trusted");
check(
	"trusted rm outside → pass",
	(await runCmd(`rm ${OUT}/del.txt`, PROJ)).verdict,
	"pass",
);

// ── in-project delete: strict/normal confirm, loose/trusted pass ──
writeFileSync(join(PROJ, "d1.txt"), "x");
for (const mode of ["strict", "normal"]) {
	await setMode(mode);
	check(
		`${mode} rm in-project → confirm`,
		(await runCmd(`rm ${PROJ}/d1.txt`, PROJ)).verdict,
		"confirm",
	);
}
writeFileSync(join(PROJ, "d2.txt"), "x");
await setMode("loose");
check(
	"loose rm in-project → pass",
	(await runCmd(`rm ${PROJ}/d2.txt`, PROJ)).verdict,
	"pass",
);
writeFileSync(join(PROJ, "d3.txt"), "x");
await setMode("trusted");
check(
	"trusted rm in-project → pass",
	(await runCmd(`rm ${PROJ}/d3.txt`, PROJ)).verdict,
	"pass",
);

// ── variable/wildcard paths (not statically resolvable): confirm in any mode (bypass-proof) ──
for (const mode of ["loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} rm variable path → confirm`,
		(await runCmd(`rm "$HOME/.ssh/config"`, PROJ)).verdict,
		"confirm",
	);
	check(
		`${mode} rm wildcard → confirm`,
		(await runCmd(`rm ./*.tmp`, PROJ)).verdict,
		"confirm",
	);
}

// ── truncate existing: confirm in every mode ────────────────
writeFileSync(join(PROJ, "trunc.txt"), "data");
for (const mode of ["strict", "normal", "loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} truncate existing → confirm`,
		(await runCmd(`echo x > ${PROJ}/trunc.txt`, PROJ)).verdict,
		"confirm",
	);
}

// ── git destructive: confirm in every mode ──────────────────
for (const mode of ["strict", "normal", "loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} git reset --hard → confirm`,
		(await runCmd("git reset --hard HEAD", PROJ)).verdict,
		"confirm",
	);
}

// ── cwd=HOME write: normal/strict confirm, loose/trusted pass ──
const HOME = homedir();
for (const mode of ["strict", "normal"]) {
	await setMode(mode);
	check(
		`${mode} HOME write → confirm`,
		(
			await runTool(
				"write",
				{ path: join(HOME, "test-home-write.txt") },
				{ cwd: HOME },
			)
		).verdict,
		"confirm",
	);
}
for (const mode of ["loose", "trusted"]) {
	await setMode(mode);
	check(
		`${mode} HOME write → pass`,
		(
			await runTool(
				"write",
				{ path: join(HOME, "test-home-write.txt") },
				{ cwd: HOME },
			)
		).verdict,
		"pass",
	);
}

// ── no UI: items needing confirmation are blocked (in-project write stays pass) ─
await setMode("normal");
check(
	"no-UI rm in-project → block",
	(
		await runTool(
			"bash",
			{ command: `rm ${PROJ}/inside.txt` },
			{ cwd: PROJ, hasUI: false },
		)
	).verdict,
	"block",
);
check(
	"no-UI in-project write → pass (existing behavior)",
	(
		await runTool(
			"write",
			{ path: join(PROJ, "n.txt") },
			{ cwd: PROJ, hasUI: false },
		)
	).verdict,
	"pass",
);
check(
	"no-UI outside write → block",
	(
		await runTool(
			"write",
			{ path: join(OUT, "fresh2.txt") },
			{ cwd: PROJ, hasUI: false },
		)
	).verdict,
	"block",
);

console.log(`\n✅ ${pass} passed, ❌ ${fail} failed`);
if (failures.length) {
	console.log("Failures:");
	for (const f of failures) console.log("  - " + f);
	process.exit(1);
}
