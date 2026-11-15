# magpie × NarraFork

把 [NarraFork](https://github.com/NarraFork/NarraFork) 接到 **[magpie](https://github.com/yetone/magpie)**：NarraFork 的模型请求走本机 magpie 网关（`127.0.0.1:3425`），用哪个模型由 magpie 的 Agents 页统一决定——包括路由组、故障转移和隐私脱敏。

## 它做什么

* 在 magpie 的 **Agents** 页出现 **NarraFork** 一行，可以给它选一个模型，或选一个路由组（`group/…`）。
* 每次选择，magpie 把 `agent.defaultModel` 写成 `magpie:<provider>/<model>`，写到 `~/.narrafork/settings.json`。
* NarraFork 自己监听这份文件（`server/lib/settings-file-watcher.ts`），外部改动会被当作等价于面板里的修改重载，**不需要重启**。
* 打开选择器时还会列出 NarraFork 自己已配置供应商的默认模型（`<prefix>:<model>`），可以一键切回原生、不经 magpie。
* 停用插件时 magpie 把它写过的键还原成写之前的值。

## 三步接入

```sh
# 1. 装插件：本机文件夹（magpie 面板里填这个路径也行）
magpie plugin add /path/to/magpie-agent-narrafork
#    或直接指到 agent 文件：magpie plugin add /path/to/magpie-agent-narrafork/narrafork.agent.js

# 2. 一次性给 NarraFork 建 magpie 供应商（见下）
node /path/to/magpie-agent-narrafork/setup.mjs --dry-run
node /path/to/magpie-agent-narrafork/setup.mjs
```

3. magpie → **Agents** → **NarraFork** → 选模型（例如 `group/daily-coding`，或某个具体模型）。之后 NarraFork 里新建的叙述者就用它，模型请求经 magpie 路由。

> 这个包还没发布到 npm。`@magpie-community/agent-narrafork` 只是准备用的仓库名，所以 `bun add` / `npx` 现在会 404；发布之后（或推到 GitHub 后 `magpie plugin add github:<owner>/<repo>`）才能那样装。

这个包只有 `magpie.agent` 一个入口（没有 `main` / `exports`），所以 magpie 不会把它装进插件宿主进程，只在 magpie 自己进程里跑它的 `own`；`setup.mjs` 是给人跑的，magpie 不碰它。

## 它不做什么（请先看这一段）

NarraFork 的供应商是一个**数组**（`settings.customApiProviders`），而 magpie 的插件写配置只改**对象键**（`internal/edit/json.go` 的 `insertKey` 不含数组插入）。所以 magpie 自己没法**创建** `magpie` 这个供应商——它由本包的 `setup.mjs` 在 Node 里做（数组在 Node 里不是问题），只做一次。

### 一次性准备：加上 `magpie` 供应商

```sh
node setup.mjs --dry-run   # 先看要写什么
node setup.mjs
```

它会：

* 在 `~/.narrafork/settings.json`（或 `NARRAFORK_HOME` 指向的家目录）的 `customApiProviders` 里 upsert 一个 `magpie` 供应商：`baseUrl` = `http://127.0.0.1:3425/v1`、`prefix` = `magpie`、`apiKey` = `magpie`、`protocol` = `completions-compatible`；
* 默认模型先问一下网关的 `/v1/models`，问不到才用 `deepseek/deepseek-v4-pro`——`--model` 可以指定；
* **其它供应商一律不动**，只改这一个；改之前备份成 `settings.json.magpie.bak`；
* 先看要写什么可以用 `--dry-run`；`--gateway`、`--key` 可改网关地址和键。

它不会替 NarraFork 做数组格式迁移：如果 `settings.json` 还没有 `customApiProviders`（旧格式只有 `openaiProviders` 等），它会让你先打开一次 NarraFork 的供应商设置（NarraFork 保存时会写成当前格式），再运行。

不想跑这个脚本也可以手填。在 NarraFork 的「设置 → 供应商 → 添加」里选**自定义 API / OpenAI 兼容**：

| 字段 | 值 |
| --- | --- |
| 名称 | `magpie` |
| 提供商前缀 | `magpie` |
| 基础 URL | `http://127.0.0.1:3425/v1` |
| API Key | `magpie`（magpie 文档里的占位键） |
| 协议 | Chat Completions（`completions-compatible`） |
| 默认模型 | 任意，之后会被 magpie 接管，例如 `deepseek/deepseek-v4-pro` |

或直接写进 `~/.narrafork/settings.json`（NarraFork 按 JSONC 读，允许注释）：

```jsonc
{
  "customApiProviders": [
    // …你自己的供应商…
    {
      "id": "magpie01",
      "name": "magpie",
      "prefix": "magpie",
      "baseUrl": "http://127.0.0.1:3425/v1",
      "apiKey": "magpie",
      "defaultModel": "deepseek/deepseek-v4-pro",
      "protocol": "completions-compatible"
    }
  ]
}
```

`apiKey` 写到 `settings.json` 之后，NarraFork 下一次加载会把它搬进 `provider-keys.json`（`server/lib/settings/provider-keys-projection.ts`），`settings.json` 里就只留空串——这是正常现象。

## 它是怎么被 magpie 认出来的

magpie 读 `package.json` 的 `magpie.agent`，把 `narrafork.agent.js` 当成一个 agent 描述符跑。这个包没有 `main` / `exports`，所以 magpie 不会把它装进插件宿主进程（Bun），只在 magpie 自己进程的 JS 运行时里调它的 `own`。

## 用起来

magpie → **Agents** → **NarraFork** → 选模型（例如 `group/daily-coding`，或某个具体模型）。之后在 NarraFork 里新建的叙述者就用这个模型，它的每一次模型请求都经 magpie 路由。

### 让 magpie 决定用哪个模型：选路由组，而不是选某个模型

NarraFork 每个叙述者绑一个模型 id，它不会每次请求再去问 magpie「现在该用谁」。所以想「在 magpie 里灵活切换」时，**不要给叙述者绑具体模型，绑一个路由组**：

```sh
magpie group add "daily" models=commandcode/deepseek/deepseek-v4.1-flash,opendesign/deepseek-v4.1-flash routing=smart
```

magpie 的 `/v1/models` 会把路由组一起列出来，所以在 NarraFork 的 magpie 供应商里点一次**获取模型列表**，就会出现 `magpie:group/daily`，选它即可。之后在 magpie 里换组成员、换模式（`smart` / `order` / `rotate` / `usage` / `pace`）、加新的供应商，NarraFork 这边**一个字都不用改**，也不用再刷新列表。

这也是 magpie 的故障转移真正生效的地方：组里某个账号额度用完，网关自己换下一个成员，NarraFork 不会看到错误。

## 用的是哪些 NarraFork 字段

| NarraFork（`server/lib/settings/types.ts`） | 这里的用法 |
| --- | --- |
| `settings.agent.defaultModel` | 插件写的唯一键；magpie 写 `<prefix><gateway model>`，即 `magpie:deepseek/deepseek-v4-pro` |
| `settings.customApiProviders[]` | `setup.mjs` upsert 那个 `magpie` 供应商；插件自己只读（给选择器列原生模型） |
| `settings.openaiProviders[]` 等旧数组 | 旧格式的 `settings.json` 里读，NarraFork 把它们当 `customApiProviders` 的来源 |

### 模型 id 为什么长这样

NarraFork 的模型 id 是 `<供应商前缀>:<模型 id>`；magpie 网关的模型 id 是 `<provider>/<model>`。两者拼起来正好是 `magpie:deepseek/deepseek-v4-pro`：NarraFork 认出前缀 `magpie` 的供应商，把 `deepseek/deepseek-v4-pro` 发给网关，magpie 再按 `provider/model` 路由。

## 故障排查

* **NarraFork 报说未知前缀 / unknown provider**：`magpie` 供应商还没配好，回到上面的「一次性准备」。
* **已经存在的叙述者没换模型**：`agent.defaultModel` 只决定**新建**叙述者用的默认模型；在跑的会话保留它启动时的模型，需要在会话里自己切一次。
* **供应商拉不到模型列表**：填好 `baseUrl` 后点刷新，magpie 网关的 `/v1/models` 会给出它当前可用的模型；拉不到就直接手填 `defaultModel`，不影响路由。
* **想彻底还原**：在 magpie 里停用这个插件，magpie 会把 `agent.defaultModel` 写回它介入前的值。

## English (short)

NarraFork as a magpie agent: pick a model — or a routing group — on magpie's Agents page and magpie writes `agent.defaultModel = "magpie:<provider>/<model>"` into `~/.narrafork/settings.json`, which NarraFork hot-reloads. The picker also lists NarraFork's own providers' default models, so you can switch back to a native provider.

Add the `magpie` provider in NarraFork once. `magpie` cannot create it — NarraFork keeps providers in an array (`settings.customApiProviders`) and magpie's plugin config writer only edits object keys (`internal/edit/json.go`) — so `setup.mjs` does it in Node, where arrays are ordinary: it upserts one `magpie` provider (`http://127.0.0.1:3425/v1`, prefix `magpie`, key `magpie`, Chat Completions), leaves every other provider alone, and backs the file up first.

```sh
magpie plugin add /path/to/magpie-agent-narrafork          # not on npm yet
node /path/to/magpie-agent-narrafork/setup.mjs --dry-run   # then without --dry-run
```
