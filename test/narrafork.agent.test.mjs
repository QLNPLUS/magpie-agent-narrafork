// Tests for narrafork.agent.js, with node --test: the module runs in magpie's
// own JS runtime (moejs), so this file only feeds it the inputs magpie's
// agentplug gives connect/own (internal/agentplug/agentplug.go).
//
import test from "node:test";
import assert from "node:assert/strict";

import { agent, own } from "../narrafork.agent.js";

// A settings.json as NarraFork writes it: the unified provider list, the
// legacy lists it mirrors them into, and the model a new narrator starts on.
const settings = () => ({
	agent: { defaultModel: "deepseek:deepseek-v4-pro", summaryModel: "deepseek:deepseek-v4-flash" },
	customApiProviders: [
		{
			id: "lbjWDz4t",
			name: "DeepSeek",
			prefix: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			defaultModel: "deepseek-v4-pro",
			protocol: "completions-compatible",
			apiKey: "",
		},
		{
			id: "magpie01",
			name: "magpie",
			prefix: "magpie",
			baseUrl: "http://127.0.0.1:3425/v1",
			defaultModel: "deepseek/deepseek-v4-pro",
			protocol: "completions-compatible",
			apiKey: "",
		},
		{
			id: "disabled1",
			name: "Old",
			prefix: "old",
			baseUrl: "https://old.example.com/v1",
			defaultModel: "old-model",
			protocol: "completions-compatible",
			disabled: true,
			apiKey: "",
		},
	],
	openaiProviders: [
		{ id: "lbjWDz4t", name: "DeepSeek", prefix: "deepseek", defaultModel: "deepseek-v4-pro" },
		{ id: "magpie01", name: "magpie", prefix: "magpie", defaultModel: "deepseek/deepseek-v4-pro" },
	],
});

test("the agent says where NarraFork keeps the model, and names it the way NarraFork does", () => {
	assert.match(agent.id, /^[a-z0-9._-]+$/);
	assert.equal(agent.config, "~/.narrafork/settings.json");
	assert.equal(agent.format, "json");
	// the model key path NarraFork's settings has (agent.defaultModel)
	assert.equal(agent.model, "agent.defaultModel");
	// NarraFork model ids are "<provider prefix>:<model id>"
	assert.equal(agent.prefix, "magpie:");
	// nothing of the plugin loads into magpie's JS host: this is connect-free,
	// so magpie writes no key but the model
	assert.equal(typeof own, "function");
});

test("own lists NarraFork's own providers, once, without the disabled or magpie ones", () => {
	const out = own({ config: settings(), model: "" });
	const values = out.map((o) => o.value);
	assert.deepEqual(values, ["deepseek:deepseek-v4-pro"]);
	assert.equal(out[0].model, "DeepSeek · deepseek-v4-pro");
	assert.equal(out[0].direct, "DeepSeek");
});

test("own keeps the model NarraFork is on while it isn't magpie's", () => {
	// the picker must offer the way back, even with no provider written yet
	const out = own({ config: {}, model: "deepseek:deepseek-v4-pro" });
	assert.deepEqual(out.map((o) => o.value), ["deepseek:deepseek-v4-pro"]);
	assert.equal(out[0].model, "NarraFork · deepseek:deepseek-v4-pro");
	assert.equal(out[0].direct, "");
});

test("own drops the model already listed, and magpie's own", () => {
	const config = settings();
	config.agent.defaultModel = "disconnected:none"; // not a provider's own
	const out = own({ config }).map((o) => o.value);
	assert.deepEqual(out, ["deepseek:deepseek-v4-pro", "disconnected:none"]);
	config.agent.defaultModel = "magpie:deepseek/deepseek-v4-pro";
	assert.deepEqual(own({ config }).map((o) => o.value), ["deepseek:deepseek-v4-pro"]);
});

test("own reads the legacy arrays when the unified list is absent", () => {
	const config = {
		agent: { defaultModel: "" },
		openaiProviders: [
			{ name: "Groq", prefix: "groq", defaultModel: "llama-3.3-70b" },
		],
	};
	assert.deepEqual(own({ config }).map((o) => o.value), ["groq:llama-3.3-70b"]);
});

test("own survives what magpie may hand it: no config, no file, junk members", () => {
	assert.deepEqual(own(), []);
	assert.deepEqual(own({ config: null, model: "" }), []);
	assert.deepEqual(own({ config: [], model: "" }), []);
	assert.deepEqual(
		own({
			config: {
				agent: "not an object",
				customApiProviders: [null, 7, "x", { prefix: "", defaultModel: "m" }, { prefix: "p" }],
			},
		}),
		[],
	);
});

test("own caps a picker at 100 entries", () => {
	const config = {
		customApiProviders: Array.from({ length: 150 }, (_, i) => ({
			name: "P" + i,
			prefix: "p" + i,
			defaultModel: "m" + i,
		})),
	};
	assert.equal(own({ config }).length, 100);
});
