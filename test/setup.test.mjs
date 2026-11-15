// Tests for setup.mjs, the one-time NarraFork provider setup, with node --test.
//
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnose, main, planSettings, stripJsonc } from "../setup.mjs";

const provider = (over = {}) =>
	Object.assign(
		{
			name: "magpie",
			prefix: "magpie",
			baseUrl: "http://127.0.0.1:3425/v1",
			apiKey: "magpie",
			defaultModel: "deepseek/deepseek-v4-pro",
			protocol: "completions-compatible",
			disabled: false,
		},
		over,
	);

test("stripJsonc gives JSON parse what NarraFork reads with Bun.JSONC.parse", () => {
	// comments, a trailing comma, and a key whose text looks like a comment
	const text = `{
		// the narrator's default model
		"agent": { "defaultModel": "magpie:deepseek/deepseek-v4-pro", },
		/* a block
		   comment spanning lines */
		"url": "http://127.0.0.1:3425/v1", "quote": "\\" // not a comment \\"",
	}`;
	const parsed = JSON.parse(stripJsonc(text));
	assert.equal(parsed.agent.defaultModel, "magpie:deepseek/deepseek-v4-pro");
	assert.equal(parsed.url, "http://127.0.0.1:3425/v1");
	assert.equal(parsed.quote, '" // not a comment "');
});

test("stripJsonc leaves a plain settings.json as it is", () => {
	const plain = JSON.stringify({ agent: { defaultModel: "deepseek:deepseek-v4-pro" } }, null, 2);
	assert.equal(JSON.parse(stripJsonc(plain)).agent.defaultModel, "deepseek:deepseek-v4-pro");
	// an unclosed block comment ends the text rather than eating a quote
	assert.equal(stripJsonc('{"a":1} /*').trim(), '{"a":1}');
});

test("planSettings adds the provider beside the user's own, untouched", () => {
	const settings = {
		agent: { defaultModel: "deepseek:deepseek-v4-pro" },
		customApiProviders: [
			{ id: "deepseek01", name: "DeepSeek", prefix: "deepseek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-pro" },
		],
		someOtherSetting: true,
	};
	const planned = planSettings(settings, provider());
	assert.equal(planned.changed, true);
	assert.equal(planned.added, true);
	assert.equal(planned.id, "magpie01");
	assert.deepEqual(planned.settings.customApiProviders[0], settings.customApiProviders[0]);
	assert.equal(planned.settings.customApiProviders.length, 2);
	assert.equal(planned.settings.customApiProviders[1].prefix, "magpie");
	// the settings it wasn't asked about are as they were
	assert.deepEqual(planned.settings.agent, settings.agent);
	assert.equal(planned.settings.someOtherSetting, true);
	// and the file it was given is not edited under the caller
	assert.equal(settings.customApiProviders.length, 1);
});

test("planSettings updates the one it wrote before, keeping its id and the fields it set", () => {
	const settings = {
		customApiProviders: [
			{
				id: "mg8x1k2p",
				name: "magpie",
				prefix: "magpie",
				baseUrl: "http://127.0.0.1:3999/v1",
				defaultModel: "old/model",
				proxy: "http://127.0.0.1:7890",
				extraHeaders: { "x-team": "a" },
			},
		],
	};
	const planned = planSettings(settings, provider({ defaultModel: "x/y" }));
	assert.equal(planned.added, false);
	assert.equal(planned.id, "mg8x1k2p");
	assert.equal(planned.settings.customApiProviders[0].baseUrl, "http://127.0.0.1:3425/v1");
	assert.equal(planned.settings.customApiProviders[0].defaultModel, "x/y");
	// a proxy or a header the user set in NarraFork's UI survives
	assert.equal(planned.settings.customApiProviders[0].proxy, "http://127.0.0.1:7890");
	assert.deepEqual(planned.settings.customApiProviders[0].extraHeaders, { "x-team": "a" });
});

test("planSettings says nothing changed when the provider is already as it writes it", () => {
	const settings = { customApiProviders: [provider({ id: "magpie01" })] };
	assert.equal(planSettings(settings, provider()).changed, false);
});

test("planSettings refuses a file NarraFork has not written in the current shape", () => {
	// only the legacy arrays: converting them is NarraFork's own migration
	assert.throws(() => planSettings({ openaiProviders: [] }, provider()), /customApiProviders array/);
	assert.throws(() => planSettings({}, provider()), /customApiProviders array/);
	assert.throws(() => planSettings([], provider()), /not a JSON object/);
});

test("main writes the file, backs the old one up, and says so", () => {
	const home = mkdtempSync(join(tmpdir(), "narrafork-magpie-"));
	const path = join(home, "settings.json");
	const text = `{
		// written by hand
		"agent": { "defaultModel": "deepseek:deepseek-v4-pro" },
		"customApiProviders": [
			{ "id": "deepseek01", "name": "DeepSeek", "prefix": "deepseek", "defaultModel": "deepseek-v4-pro" }
		]
	}`;
	writeFileSync(path, text);
	const argv = ["--model", "deepseek/deepseek-v4-pro", "--key", "magpie", "--gateway", "http://127.0.0.1:3425/v1"];
	const lines = [];
	const say = console.log;
	const env = process.env.NARRAFORK_HOME;
	console.log = (line) => lines.push(String(line));
	process.env.NARRAFORK_HOME = home;
	return main(argv)
		.then(() => {
			const written = JSON.parse(readFileSync(path, "utf8"));
			assert.equal(written.agent.defaultModel, "deepseek:deepseek-v4-pro");
			assert.equal(written.customApiProviders.length, 2);
			assert.equal(written.customApiProviders[1].prefix, "magpie");
			assert.equal(written.customApiProviders[1].defaultModel, "deepseek/deepseek-v4-pro");
			assert.equal(written.customApiProviders[1].id, "magpie01");
			assert.equal(written.customApiProviders[1].protocol, "completions-compatible");
			// the old file is kept, comments and all
			assert.equal(readFileSync(path + ".magpie.bak", "utf8"), text);
			assert.ok(lines.some((line) => line.includes("added (magpie01)")));
		})
		.finally(() => {
			console.log = say;
			if (env === undefined) delete process.env.NARRAFORK_HOME;
			else process.env.NARRAFORK_HOME = env;
			rmSync(home, { recursive: true, force: true });
		});
});

test("main writes nothing with --dry-run", async () => {
	const home = mkdtempSync(join(tmpdir(), "narrafork-magpie-dry-"));
	const path = join(home, "settings.json");
	writeFileSync(path, JSON.stringify({ customApiProviders: [] }));
	const env = process.env.NARRAFORK_HOME;
	process.env.NARRAFORK_HOME = home;
	const say = console.log;
	console.log = () => {};
	try {
		await main(["--dry-run", "--model", "deepseek/deepseek-v4-pro"]);
	} finally {
		console.log = say;
	}
	try {
		assert.equal(JSON.parse(readFileSync(path, "utf8")).customApiProviders.length, 0);
		assert.equal(existsSync(path + ".magpie.bak"), false);
	} finally {
		if (env === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = env;
		rmSync(home, { recursive: true, force: true });
	}
});

test("diagnose passes a file NarraFork can route magpie's models from", () => {
	const settings = {
		agent: { defaultModel: "magpie:deepseek/deepseek-v4-pro" },
		customApiProviders: [provider({ id: "magpie01" })],
	};
	const said = diagnose(settings, provider());
	assert.deepEqual(said.problems, []);
	assert.ok(said.lines.some((line) => line.startsWith("provider magpie: magpie01 → http://127.0.0.1:3425/v1")));
	assert.ok(said.lines.includes('model prefix "magpie": configured'));
});

test("diagnose says what NarraFork's own error says: the prefix no provider has", () => {
	// the file magpie wrote before the provider was added
	const settings = {
		agent: { defaultModel: "magpie:deepseek/deepseek-v4-pro" },
		customApiProviders: [{ id: "deepseek01", name: "DeepSeek", prefix: "deepseek", baseUrl: "https://api.deepseek.com/v1" }],
	};
	const said = diagnose(settings, provider());
	assert.ok(said.lines.includes("provider magpie: MISSING"));
	assert.ok(said.lines.includes('model prefix "magpie": NOT configured'));
	assert.ok(said.problems.some((p) => p.includes("no provider with prefix magpie")));
	assert.ok(said.problems.some((p) => p.includes("cannot resolve magpie:deepseek/deepseek-v4-pro")));
});

test("diagnose catches a disabled provider and one still pointing somewhere else", () => {
	const settings = {
		agent: { defaultModel: "magpie:deepseek/deepseek-v4-pro" },
		customApiProviders: [provider({ id: "magpie01", disabled: true, baseUrl: "http://127.0.0.1:9999/v1" })],
	};
	const said = diagnose(settings, provider());
	// disabled: NarraFork leaves it out, so the model cannot resolve
	assert.ok(said.lines[2].includes("DISABLED"));
	assert.ok(said.problems.some((p) => p.includes("is disabled")));
	assert.ok(said.lines.some((line) => line.startsWith("  baseUrl is not http://127.0.0.1:3425/v1")));
});

test("diagnose reports a file NarraFork has not written in the current shape", () => {
	const said = diagnose({ agent: { defaultModel: "magpie:x/y" }, openaiProviders: [{}] }, provider());
	assert.ok(said.lines.includes("customApiProviders: missing (older shape, only openaiProviders and friends)"));
	assert.ok(said.problems.some((p) => p.includes("has no customApiProviders array")));
});

test("main leaves the file alone with --check", async () => {
	const home = mkdtempSync(join(tmpdir(), "narrafork-magpie-check-"));
	const path = join(home, "settings.json");
	const text = JSON.stringify({ agent: { defaultModel: "magpie:deepseek/deepseek-v4-pro" }, customApiProviders: [] });
	writeFileSync(path, text);
	const env = process.env.NARRAFORK_HOME;
	process.env.NARRAFORK_HOME = home;
	const say = console.log;
	const lines = [];
	console.log = (line) => lines.push(String(line));
	let code = -1;
	try {
		code = await main(["--check", "--model", "deepseek/deepseek-v4-pro"]);
	} finally {
		console.log = say;
	}
	try {
		assert.equal(code, 1);
		assert.equal(readFileSync(path, "utf8"), text);
		assert.ok(lines.some((line) => line.includes("provider magpie: MISSING")));
		assert.ok(lines.some((line) => line.includes("gateway")));
	} finally {
		if (env === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = env;
		rmSync(home, { recursive: true, force: true });
	}
});

test("main reports a missing settings.json instead of writing one", async () => {
	const home = mkdtempSync(join(tmpdir(), "narrafork-magpie-missing-"));
	const env = process.env.NARRAFORK_HOME;
	process.env.NARRAFORK_HOME = home;
	try {
		await assert.rejects(
			main(["--model", "deepseek/deepseek-v4-pro"]),
			/settings\.json does not exist/,
		);
		assert.equal(existsSync(join(home, "settings.json")), false);
	} finally {
		if (env === undefined) delete process.env.NARRAFORK_HOME;
		else process.env.NARRAFORK_HOME = env;
		rmSync(home, { recursive: true, force: true });
	}
});
