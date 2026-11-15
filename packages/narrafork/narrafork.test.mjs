// Runs under both runners this package is checked with: `bun test` in
// magpie-community/plugins, and `node --test` from a checkout that has no Bun.
const { test } = process.versions.bun ? await import("bun:test") : await import("node:test");
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent, own } from "./narrafork.agent.js";
import { planSettings, providerOf, routedModel, settingsPath, stripJsonc, syncSettings, wanted } from "./settings.mjs";
import * as host from "./index.mjs";

const settings = {
  agent: { defaultModel: "openai:gpt-5.5" },
  customApiProviders: [
    { id: "openai01", name: "OpenAI", prefix: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "", defaultModel: "gpt-5.5", protocol: "completions-compatible" },
    { id: "anthropic01", name: "Claude", prefix: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "", defaultModel: "claude-opus-4-7" },
  ],
};

const home = async () => {
  const dir = await mkdtemp(join(tmpdir(), "narrafork-agent-"));
  await writeFile(settingsPath(dir), JSON.stringify(settings, null, 2) + "\n");
  return dir;
};

test("says where NarraFork keeps its model", () => {
  assert.deepEqual(
    { id: agent.id, config: agent.config, format: agent.format, model: agent.model, prefix: agent.prefix },
    { id: "narrafork", config: "~/.narrafork/settings.json", format: "json", model: "agent.defaultModel", prefix: "magpie:" },
  );
});

test("offers the way back to NarraFork's own providers", () => {
  assert.deepEqual(own({ config: settings }).map((m) => m.value), ["openai:gpt-5.5", "anthropic:claude-opus-4-7"]);
});

test("leaves out a disabled provider, a repeat, and the gateway's own", () => {
  const config = {
    customApiProviders: [
      { prefix: "openai", name: "OpenAI", defaultModel: "gpt-5.5" },
      { prefix: "openai", name: "OpenAI again", defaultModel: "gpt-5.5" },
      { prefix: "off", name: "Off", defaultModel: "x", disabled: true },
      { prefix: "magpie", name: "magpie", defaultModel: "group/daily" },
      { prefix: "", name: "No prefix", defaultModel: "x" },
    ],
  };
  assert.deepEqual(own({ config }).map((m) => m.value), ["openai:gpt-5.5"]);
});

test("reads the legacy arrays when the unified list is not written yet", () => {
  const config = { openaiProviders: [{ prefix: "openai", name: "OpenAI", defaultModel: "gpt-5.5" }] };
  assert.deepEqual(own({ config }).map((m) => m.value), ["openai:gpt-5.5"]);
});

test("keeps the model it is on when magpie has not written one yet", () => {
  assert.deepEqual(own({ config: {}, model: "openai:gpt-5.5" }).map((m) => m.value), ["openai:gpt-5.5"]);
  assert.deepEqual(own({}).map((m) => m.value), []);
  assert.deepEqual(own({ config: { agent: {} }, model: 42 }).map((m) => m.value), []);
});

test("names the model magpie serves without its prefix, and NarraFork's own as none", () => {
  assert.equal(routedModel({ agent: { defaultModel: "magpie:group/daily" } }), "group/daily");
  assert.equal(routedModel({ agent: { defaultModel: "magpie:deepseek/deepseek-v4.1-flash" } }), "deepseek/deepseek-v4.1-flash");
  // a provider NarraFork serves itself is no default of magpie's
  assert.equal(routedModel({ agent: { defaultModel: "openai:gpt-5.5" } }), "");
  assert.equal(routedModel({}), "");
});

test("adds the magpie provider to the array, leaving the others whole", () => {
  const bound = Object.assign({}, settings, { agent: { defaultModel: "magpie:group/daily" } });
  const planned = planSettings(bound, wanted("http://127.0.0.1:3425/v1", "magpie", bound));
  assert.equal(planned.added, true);
  assert.equal(planned.id, "magpie01");
  assert.deepEqual(planned.settings.customApiProviders.at(-1), {
    id: "magpie01",
    name: "magpie",
    prefix: "magpie",
    baseUrl: "http://127.0.0.1:3425/v1",
    apiKey: "magpie",
    defaultModel: "group/daily",
    protocol: "completions-compatible",
    disabled: false,
  });
  assert.deepEqual(planned.settings.customApiProviders.slice(0, -1), settings.customApiProviders);
  assert.equal(planned.settings.agent, bound.agent);
});

test("gives an entry with nothing picked yet an empty default, which is still text", () => {
  const planned = planSettings(settings, wanted("http://127.0.0.1:3425/v1", "magpie", settings));
  const entry = planned.settings.customApiProviders.at(-1);
  assert.equal(entry.defaultModel, "");
  assert.equal(entry.baseUrl, "http://127.0.0.1:3425/v1");
});

test("writes the provider it already has once, and then nothing", () => {
  const asked = wanted("http://127.0.0.1:3425/v1", "magpie", {});
  const first = planSettings(settings, asked);
  const second = planSettings(first.settings, asked);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.added, false);
});

test("keeps the id the entry had, since NarraFork keeps its keys under it", () => {
  const config = { customApiProviders: [{ id: "magpie07", prefix: "magpie", name: "magpie", baseUrl: "http://127.0.0.1:1/v1", apiKey: "" }] };
  const planned = planSettings(config, wanted("http://127.0.0.1:3425/v1", "magpie", {}));
  assert.equal(planned.id, "magpie07");
  assert.equal(planned.settings.customApiProviders[0].baseUrl, "http://127.0.0.1:3425/v1");
});

test("does not invent an array NarraFork derives itself", () => {
  const planned = planSettings({ openaiProviders: [] }, wanted());
  assert.equal(planned.missing, true);
  assert.equal(planned.changed, false);
});

test("refuses a settings.json that is not JSON, leaving it as it was", async () => {
  const dir = await mkdtemp(join(tmpdir(), "narrafork-agent-"));
  await writeFile(settingsPath(dir), "{ not json\n");
  await assert.rejects(syncSettings({ path: settingsPath(dir) }));
  assert.equal(await readFile(settingsPath(dir), "utf8"), "{ not json\n");
});

test("writes the file atomically, with one backup of what it was", async () => {
  const dir = await home();
  const path = settingsPath(dir);
  assert.equal((await syncSettings({ path: path, gateway: "http://127.0.0.1:3425/v1", key: "magpie" })).status, "added");
  assert.equal(existsSync(path + ".magpie.bak"), true);
  assert.deepEqual(JSON.parse(await readFile(path + ".magpie.bak", "utf8")), settings);
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(providerOf(written).baseUrl, "http://127.0.0.1:3425/v1");
  assert.deepEqual(written.customApiProviders.slice(0, 2), settings.customApiProviders);
  // a second pass finds nothing to do, and keeps the backup it made
  assert.equal((await syncSettings({ path: path })).status, "unchanged");
  assert.deepEqual(JSON.parse(await readFile(path + ".magpie.bak", "utf8")), settings);
});

test("puts the entry back after NarraFork rewrites the file without it", async () => {
  const dir = await home();
  const path = settingsPath(dir);
  await syncSettings({ path: path });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
  assert.equal(providerOf(JSON.parse(await readFile(path, "utf8"))), null);
  assert.equal((await syncSettings({ path: path })).status, "added");
  assert.notEqual(providerOf(JSON.parse(await readFile(path, "utf8"))), null);
});

test("follows the model NarraFork is on into the provider's own default", async () => {
  const dir = await home();
  const path = settingsPath(dir);
  await syncSettings({ path: path });
  // what magpie writes when a routing group is picked: the model changed,
  // the provider entry is still the one this wrote
  const picked = JSON.parse(await readFile(path, "utf8"));
  picked.agent.defaultModel = "magpie:group/daily";
  await writeFile(path, JSON.stringify(picked, null, 2) + "\n");
  assert.equal((await syncSettings({ path: path })).status, "updated");
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(providerOf(written).defaultModel, "group/daily");
  assert.equal(written.agent.defaultModel, "magpie:group/daily");
  assert.deepEqual(written.customApiProviders.slice(0, 2), settings.customApiProviders);
  assert.equal(written.customApiProviders.length, 3);
});

test("says what it cannot write instead of writing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "narrafork-agent-"));
  assert.equal((await syncSettings({ path: settingsPath(dir) })).status, "absent");
  await writeFile(settingsPath(dir), JSON.stringify({ agent: {} }, null, 2) + "\n");
  assert.equal((await syncSettings({ path: settingsPath(dir) })).status, "missing");
});

test("reads settings.json as NarraFork does, comments and a trailing comma included", () => {
  const text = '{\n  // a provider\n  "customApiProviders": [{ "prefix": "openai" },],\n}\n';
  assert.deepEqual(JSON.parse(stripJsonc(text)), { customApiProviders: [{ prefix: "openai" }] });
});

test("gives the host one function to run, since it takes each export as a plugin", () => {
  assert.deepEqual(Object.keys(host), ["default"]);
  assert.equal(typeof host.default, "function");
});

test("leads with the English README, the Chinese one below it", async () => {
  const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
  const [en, zh] = readme.split("\n## 中文\n");
  assert.ok(zh, "no ## 中文 section");
  assert.doesNotMatch(en.replace("(中文说明在下面。)", ""), /[\u4e00-\u9fff]/);
  assert.match(zh, /[\u4e00-\u9fff]/);
});
