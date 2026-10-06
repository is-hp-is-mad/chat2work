/* test_shim.js — gateway/shim.js 逻辑冒烟测试（Node 环境，无需 Chrome）
 * 运行:  node tools/test_shim.js
 */
"use strict";

/* ---------- chrome.storage 桩（local / session 分区） ---------- */
const store = { local: {}, session: {} };
function areaStub(area) {
  return {
    get(key, cb) {
      const out = {};
      if (typeof key === "string") out[key] = store[area][key];
      else if (Array.isArray(key)) key.forEach((k) => (out[k] = store[area][k]));
      setTimeout(() => cb(out), 0);
    },
    set(obj, cb) {
      Object.assign(store[area], JSON.parse(JSON.stringify(obj)));
      if (cb) setTimeout(cb, 0);
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[area][k]);
      if (cb) setTimeout(cb, 0);
    }
  };
}
globalThis.chrome = {
  storage: {
    local: areaStub("local"),
    session: areaStub("session"),
    onChanged: { addListener() {} }
  }
};

/* ---------- 出站 fetch 桩（捕获 shim 之后真正发出的请求） ---------- */
const sent = [];
globalThis.fetch = async function (url, init) {
  sent.push({ url: String(url), init });
  return new Response(
    JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "x",
      content: [{ type: "text", text: "pong" }],
      stop_reason: "end_turn", usage: { output_tokens: 3 }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

/* ---------- WebSocket 桩（验证中继桥屏蔽） ---------- */
class OrigWSStub {
  constructor(url) { this.url = String(url); this.readyState = 1; OrigWSStub.instances.push(this); }
  send() {} close() {}
}
OrigWSStub.instances = [];
globalThis.WebSocket = OrigWSStub;

/* ---------- 配置 ---------- */
store.local.gatewayConfig = {
  baseUrl: "https://gw.test",
  apiKey: "sk-gateway-123",
  authType: "x-api-key",
  anthropicVersion: "2023-06-01",
  extraHeaders: { "X-Tenant": "t1" },
  betas: ["pdfs-2024-09-25"],
  gatewayNoStream: false,
  unknownModelPolicy: "map-default",
  defaultModel: "my-model",
  fastModel: "my-fast",
  models: [
    {
      id: "my-model",
      apiModel: "upstream-claude",
      name: "我的模型",
      inference: {
        temperature: 0.4, top_p: 0.9, top_k: null,
        max_output_tokens: 4096,
        stop_sequences: ["END"],
        thinking: "budget", thinking_budget: 1024,
        systemAppend: "附加系统指令",
        extra: {}
      },
      modalities: { vision: false, documents: true, tools: true, thinking: true, caching: false }
    },
    {
      id: "my-fast",
      apiModel: "upstream-haiku",
      name: "快速模型",
      inference: { temperature: 0.2, top_p: 0.8, max_output_tokens: 256 },
      modalities: {}
    }
  ]
};

/* ---------- 加载垫片 ---------- */
require("./gateway-src/shim.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function assert(cond, name) {
  console.log((cond ? "  ✔ " : "  ✘ ") + name);
  if (!cond) failed++;
}

(async function main() {
  await sleep(20);

  /* 1) /v1/messages → 网关改写 */
  const body = {
    model: "claude-sonnet-4-5",           // 未知模型 → 映射为默认 my-model → upstream-claude
    max_tokens: 100000,                    // 超过上限 → 被截到 4096
    betas: ["oauth-2025-04-20", "files-2025"],
    messages: [
      { role: "user", content: [
        { type: "image", source: { type: "base64", data: "xxx" } },  // vision=false → 移除
        { type: "text", text: "hi" },
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: {} }] }
      ] }
    ],
    system: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]  // caching=false → 去掉
  };
  const res = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer gateway-session",
      "anthropic-beta": "oauth-2025-04-20, another-1",
      "anthropic-client-platform": "claude_browser_extension",
      traceparent: "00-abc-def-01"
    },
    body: JSON.stringify(body)
  });
  const call = sent[sent.length - 1];
  const rewritten = JSON.parse(call.init.body);

  console.log("\n[1] /v1/messages 改写");
  assert(call.url === "https://gw.test/v1/messages", "URL → " + call.url);
  assert(call.init.headers.get("x-api-key") === "sk-gateway-123", "认证为 x-api-key");
  assert(!call.init.headers.get("authorization"), "原 Authorization 被剥离");
  assert(!call.init.headers.get("anthropic-client-platform"), "遥测头 anthropic-client-platform 被剥离");
  assert(!call.init.headers.get("traceparent"), "追踪头 traceparent 被剥离");
  assert(call.init.headers.get("X-Tenant") === "t1", "自定义请求头已合并");
  const beta = call.init.headers.get("anthropic-beta") || "";
  assert(beta.indexOf("oauth-2025-04-20") < 0 && beta.indexOf("another-1") >= 0 && beta.indexOf("pdfs-2024-09-25") >= 0,
    "anthropic-beta 重建: " + beta);
  assert(rewritten.model === "upstream-claude", "模型映射: " + rewritten.model);
  assert(rewritten.max_tokens === 4096, "max_tokens 截断: " + rewritten.max_tokens);
  assert(rewritten.temperature === undefined && rewritten.top_p === undefined, "thinking 开启时 temperature/top_p 被移除（API 约束）");
  assert(rewritten.thinking && rewritten.thinking.budget_tokens === 1024, "thinking(budget) 注入");
  assert(JSON.stringify(rewritten.betas).indexOf("oauth-2025-04-20") < 0, "body.betas 去掉 oauth beta");
  const userBlocks = rewritten.messages[0].content;
  assert(userBlocks[0].type === "text" && /图片/.test(userBlocks[0].text), "图片块按模态被替换为占位文本");
  const tr = userBlocks[2];
  assert(tr.type === "tool_result" && tr.content[0].type === "text", "tool_result 内图片同样被替换");
  assert(!rewritten.system[0].cache_control, "cache_control 按模态被剥离");
  assert(/附加系统指令/.test(rewritten.system[rewritten.system.length - 1].text), "系统提示词附加内容");
  assert(res.status === 200, "网关响应透传");

  /* 2) 遥测屏蔽 */
  console.log("\n[2] 遥测屏蔽");
  const before = sent.length;
  const r1 = await fetch("https://o1158394.ingest.us.sentry.io/api/450987/envelope/", { method: "POST", body: "x" });
  const r2 = await fetch("https://browser-intake-us5-datadoghq.com/api/v2/replay", { method: "POST", body: "x" });
  const r3 = await fetch("https://cdn.growthbook.io/api/features/abc123", { method: "GET" });
  const r4 = await fetch("https://api.anthropic.com/api/event_logging/v2/batch", { method: "POST", body: "x" });
  assert(r1.status === 204 && r2.status === 204 && r3.status === 204 && r4.status === 204, "遥测请求返回 204");
  assert(sent.length === before, "遥测请求未发出任何网络流量");

  /* 3) 控制面合成 */
  console.log("\n[3] 控制面合成");
  const prof = await (await fetch("https://api.anthropic.com/api/oauth/profile")).json();
  assert(prof.account && prof.account.uuid === "gateway-account", "profile 合成: account.uuid");
  assert(prof.account.has_claude_pro === true && prof.account.has_claude_max === true, "profile 合成: 订阅资格字段（跳过付费墙）");
  assert(prof.organization && prof.organization.organization_type === "claude_team", "profile 合成: organization_type（跳过付费墙）");
  const feats = await (await fetch("https://api.anthropic.com/api/bootstrap/features/client-key")).json();
  const mm = feats.features && feats.features.chrome_ext_models;
  assert(mm && mm.value.default === "my-model" && mm.value.options.length === 2,
    "chrome_ext_models 特性注入: " + JSON.stringify(mm && mm.value.default));
  assert(feats.features.chrome_ext_backend_model_selector.on === false, "后端模型选择器已关闭");
  const sp = feats.features.chrome_ext_system_prompt;
  assert(sp && typeof sp.value.systemPrompt === "string" && sp.value.systemPrompt.length > 50,
    "chrome_ext_system_prompt 已注入（会话初始化必需）");
  assert(feats.features.chrome_ext_skip_perms_system_prompt.value.skipPermissionsSystemPrompt,
    "skip_perms 系统提示词已注入");
  const sel = await (await fetch("https://api.anthropic.com/api/organizations/gateway-org/model_selector/chrome")).json();
  assert(sel.model_selector_config[0].models.length === 2, "model_selector 合成");
  const hash = await (await fetch("https://api.anthropic.com/api/web/url_hash_check/browser_extension", { method: "POST", body: "{}" })).json();
  assert(hash.category === "category0", "URL 安全检查合成: " + hash.category);

  /* 4) fast 模型映射 + 非 thinking 模型的推理参数注入 */
  console.log("\n[4] 快速辅助模型映射 + 推理参数注入");
  sent.length = 0;
  await fetch("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST", body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 64, messages: [{ role: "user", content: "hi" }] })
  });
  assert(JSON.parse(sent[0].init.body).model === "upstream-haiku", "haiku 请求 → 快速模型");
  assert(sent[0].url === "https://gw.test/v1/messages", "?beta=true 已剥离: " + sent[0].url);
  sent.length = 0;
  await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "my-fast", messages: [{ role: "user", content: "hi" }] })
  });
  const b2 = JSON.parse(sent[0].init.body);
  assert(b2.temperature === 0.2 && b2.top_p === 0.8 && b2.max_tokens === 256, "非 thinking 时推理参数注入: " + b2.temperature + "/" + b2.top_p + "/" + b2.max_tokens);

  /* 5) 登录态写入分区（accessToken 必须在 session！） */
  console.log("\n[5] 登录态存储分区");
  assert(store.session.accessToken === "gateway-session", "accessToken 写入 chrome.storage.session");
  assert(store.session.tokenExpiry === Date.UTC(2099, 11, 31), "tokenExpiry 为固定值（不触发 onChanged 风暴）");
  assert(store.local.anthropicApiKey === "sk-gateway-123", "anthropicApiKey 写入 chrome.storage.local");
  assert(store.local.accountUuid === "gateway-account", "accountUuid 写入 chrome.storage.local");
  assert(store.local.features && store.local.features.payload.features.chrome_ext_models, "features 缓存写入 local");
  assert(store.session.posture && store.session.posture.gen === 1 && store.session.posture.source === null && store.session.posture.managed === false,
    "posture 短路写入 session（阻断 get_posture 消息挂起风险）");

  /* 6) 中继桥 WebSocket 屏蔽（避免 403 重连风暴） */
  console.log("\n[6] WebSocket 屏蔽");
  const ws1 = new WebSocket("wss://bridge.claudeusercontent.com/chrome/gateway-account");
  assert(ws1.readyState === 0 && !(ws1 instanceof OrigWSStub), "中继桥 WS 被假对象永久挂起（不发任何事件）");
  const ws2 = new WebSocket("wss://example.com/normal");
  assert(ws2 instanceof OrigWSStub, "普通 WebSocket 正常透传");

  /* 7) MCP bootstrap SSE 与 claude.ai 合成 */
  console.log("\n[7] SSE / claude.ai 合成");
  const sse = await fetch("https://api.anthropic.com/api/oauth/organizations/gateway-org/mcp/v2/bootstrap");
  const sseText = await sse.text();
  assert(/text\/event-stream/.test(sse.headers.get("content-type")) && /server_list/.test(sseText), "MCP bootstrap SSE 合成");
  const c = await (await fetch("https://claude.ai/api/oauth/account/settings")).json();
  assert(typeof c === "object", "claude.ai 请求同样被合成拦截");

  console.log("\n" + (failed ? "FAIL: " + failed + " 项未通过" : "ALL TESTS PASSED"));
  process.exit(failed ? 1 : 0);
})();
