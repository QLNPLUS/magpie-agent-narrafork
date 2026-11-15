#!/usr/bin/env node
// One-time NarraFork setup for the magpie agent plugin.
//
// NarraFork keeps its providers in an array (settings.customApiProviders), and
// magpie's plugin config writer only edits object keys (internal/edit/json.go),
// so magpie cannot add the "magpie" provider itself. This helper does it here,
// in Node, where arrays are nothing special: it upserts one "magpie" provider
// pointing at the gateway and leaves every other provider as it was.
//
//   npx @magpie-community/agent-narrafork setup
//   node setup.mjs --gateway http://127.0.0.1:3425/v1 --key magpie --model deepseek/deepseek-v4-pro
//   node setup.mjs --dry-run           # say what would change, write nothing
//
// NARRAFORK_HOME, when set, is NarraFork's home folder instead of ~/.narrafork.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDER = "magpie";
const PROVIDER_ID = "magpie01";
const GATEWAY = "http://127.0.0.1:3425/v1";
const FALLBACK_MODEL = "deepseek/deepseek-v4-pro";

// stripJsonc is the text as JSON: NarraFork reads settings.json with
// Bun.JSONC.parse (server/lib/settings/index.ts), so comments and a trailing
// comma are legal in it and JSON.parse would refuse them.
export function stripJsonc(text) {
	let out = "";
	let i = 0;
	const quote = (c) => c === '"';
	while (i < text.length) {
		const c = text[i];
		if (quote(c)) {
			// a string is copied whole, escapes and all
			let j = i + 1;
			while (j < text.length) {
				if (text[j] === "\\") j += 2;
				else if (text[j] === '"') {
					j++;
					break;
				} else j++;
			}
			out += text.slice(i, j);
			i = j;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			i += 2;
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			if (i < 0) return out;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	// a comma left before ] or } is legal in JSONC and refused by JSON.parse
	return out.replace(/,(\s*[\]}])/g, "$1");
}

// planSettings is settings as NarraFork should have it: the "magpie" provider
// in customApiProviders, every other provider untouched. wanted is the
// provider's own fields. It returns the new settings, whether anything changed,
// and what NarraFork would have to be told when it cannot be written here.
export function planSettings(settings, wanted) {
	if (!isObject(settings)) throw new Error("settings.json is not a JSON object");
	const providers = Array.isArray(settings.customApiProviders) ? settings.customApiProviders.slice() : null;
	if (!providers) {
		// NarraFork only writes customApiProviders when it has saved settings
		// before this shape existed; converting the legacy arrays is NarraFork's
		// own migration job (deriveCustomApiProvidersFromLegacy), not this one's
		throw new Error(
			"settings.json has no customApiProviders array: open NarraFork's provider settings once (it rewrites the list in the current shape), then run this again",
		);
	}
	const at = providers.findIndex((p) => isObject(p) && (p.prefix === PROVIDER || p.id === PROVIDER_ID));
	// only the provider being written is read: every other one keeps its own
	// fields, such as the proxy, headers and quota the UI set on it
	const was = at >= 0 && isObject(providers[at]) ? providers[at] : {};
	// the id stays as it was: NarraFork keeps each provider's keys under it
	// (server/lib/provider-keys.ts), and the keys outlive this entry
	const entry = Object.assign({}, was, wanted, { id: was.id || PROVIDER_ID });
	if (at >= 0) providers[at] = entry;
	else providers.push(entry);
	const next = Object.assign({}, settings, { customApiProviders: providers });
	const changed = JSON.stringify(providers) !== JSON.stringify(settings.customApiProviders);
	return { settings: next, changed: changed, added: at < 0, id: entry.id };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// diagnose says what NarraFork would make of settings.json as it is: whether the
// "magpie" provider is there, and whether the model NarraFork is on resolves to
// a configured provider. It is why `Provider "magpie" is not configured` shows
// up in NarraFork's log, told from this side. wanted is what setup would write.
export function diagnose(settings, wanted) {
	const lines = [];
	const problems = [];
	if (!isObject(settings)) throw new Error("settings.json is not a JSON object");
	const providers = Array.isArray(settings.customApiProviders) ? settings.customApiProviders : null;
	if (!providers) {
		problems.push("settings.json has no customApiProviders array: run without --check first");
		lines.push("customApiProviders: missing (older shape, only openaiProviders and friends)");
	} else {
		lines.push("customApiProviders: " + providers.length + " provider(s)");
	}
	const agent = isObject(settings.agent) ? settings.agent : {};
	const current = typeof agent.defaultModel === "string" ? agent.defaultModel.trim() : "";
	lines.push("agent.defaultModel: " + (current || "(empty)"));
	const ours = (providers || []).find((p) => isObject(p) && (p.prefix === PROVIDER || p.id === PROVIDER_ID));
	if (!ours) {
		problems.push("no provider with prefix " + PROVIDER + ": NarraFork has nothing to route that model to");
		lines.push("provider " + PROVIDER + ": MISSING");
	} else {
		const off = ours.disabled === true;
		lines.push(
			"provider " + PROVIDER + ": " + ours.id + " → " + (ours.baseUrl || "(no baseUrl)") + ", protocol " + (ours.protocol || "(unset)") + (off ? ", DISABLED" : ""),
		);
		if (off) problems.push("provider " + PROVIDER + " is disabled: NarraFork leaves it out");
		if (!ours.prefix) problems.push("provider " + ours.id + " has no prefix: its models cannot be named");
		if (ours.baseUrl !== wanted.baseUrl) {
			lines.push("  baseUrl is not " + wanted.baseUrl + ": another gateway, or one magpie no longer serves");
		}
	}
	// the prefix a model id carries must be a configured provider's, which is
	// the check NarraFork fails with `Provider "<x>" is not configured`
	const colon = current.indexOf(":");
	if (current && colon > 0) {
		const prefix = current.slice(0, colon);
		const known = (providers || []).some((p) => isObject(p) && p.disabled !== true && p.prefix === prefix);
		lines.push("model prefix \"" + prefix + "\": " + (known ? "configured" : "NOT configured"));
		if (!known) problems.push("NarraFork cannot resolve " + current + ": no enabled provider has prefix " + prefix);
	}
	for (const p of providers || []) {
		if (!isObject(p) || p.disabled === true || p.prefix !== PROVIDER) continue;
		if (Array.isArray(p.models) && p.models.length === 0) lines.push("  the provider lists no models yet: refresh its model list in NarraFork");
	}
	return { lines: lines, problems: problems };
}


// modelsOf asks the gateway what it serves, so a provider is never written with
// a default model the gateway doesn't have. Off, unreachable or an empty list is
// no answer, and the caller keeps its own.
async function modelsOf(baseUrl, key, fetchImpl) {
	const url = baseUrl.replace(/\/$/, "") + "/models";
	try {
		const res = await fetchImpl(url, {
			headers: { authorization: "Bearer " + key, accept: "application/json" },
			signal: AbortSignal.timeout(4000),
			redirect: "error",
		});
		if (!res.ok) {
			await res.body?.cancel();
			return "";
		}
		const body = await res.json();
		const first = (Array.isArray(body.data) ? body.data : []).find((m) => m && typeof m.id === "string" && m.id);
		return first ? first.id : "";
	} catch {
		return "";
	}
}

const flag = (args, name) => {
	const at = args.indexOf("--" + name);
	if (at < 0) return "";
	const next = args[at + 1];
	return next && next.slice(0, 2) !== "--" ? next : "";
};

async function main(argv = process.argv.slice(2)) {
	const home = process.env.NARRAFORK_HOME || join(homedir(), ".narrafork");
	const path = join(home, "settings.json");
	const gateway = (flag(argv, "gateway") || GATEWAY).replace(/\/$/, "");
	const key = flag(argv, "key") || PROVIDER;
	const asked = flag(argv, "model");
	if (!existsSync(path)) {
		throw new Error(path + " does not exist: start NarraFork once, then run this again");
	}
	const text = readFileSync(path, "utf8");
	let settings;
	try {
		settings = JSON.parse(stripJsonc(text));
	} catch (e) {
		throw new Error(path + " is not JSON NarraFork would read: " + e.message);
	}
	const model = asked || (await modelsOf(gateway, key, fetch)) || FALLBACK_MODEL;
	const wanted = {
		name: PROVIDER,
		prefix: PROVIDER,
		baseUrl: gateway,
		apiKey: key,
		defaultModel: model,
		protocol: "completions-compatible",
		disabled: false,
	};
	// --check says what NarraFork makes of the file as it is, and writes nothing
	if (argv.includes("--check")) {
		const said = diagnose(settings, wanted);
		console.log(path);
		for (const line of said.lines) console.log("  " + line);
		const reachable = await modelsOf(gateway, key, fetch);
		console.log("  gateway " + gateway + ": " + (reachable ? "serves " + reachable + " and more" : "no answer (is magpie running?)"));
		for (const problem of said.problems) console.log("! " + problem);
		if (said.problems.length === 0) console.log("ok: NarraFork can route the models magpie names");
		return said.problems.length === 0 ? 0 : 1;
	}
	if (asked || model !== FALLBACK_MODEL) console.log("model: " + model);
	const planned = planSettings(settings, wanted);
	if (!planned.changed) {
		console.log(path + ": the " + PROVIDER + " provider is already as this writes it (" + planned.id + ")");
		return 0;
	}
	if (argv.includes("--dry-run")) {
		console.log(JSON.stringify(planned.settings.customApiProviders.find((p) => p.id === planned.id), null, 2));
		console.log("(dry run: " + path + " not written)");
		return 0;
	}
	const backup = path + ".magpie.bak";
	copyFileSync(path, backup);
	const temp = join(dirname(path), ".settings.json.magpie." + process.pid);
	writeFileSync(temp, JSON.stringify(planned.settings, null, 2) + "\n", { mode: 0o600 });
	renameSync(temp, path);
	console.log(path + ": " + PROVIDER + " provider " + (planned.added ? "added" : "updated") + " (" + planned.id + "), backup at " + backup);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((e) => {
			console.error("setup: " + (e?.message || String(e)));
			process.exitCode = 1;
		});
}

export { main };
