#!/usr/bin/env node
/**
 * Re-apply the CCPP patch to a stock Claude in Chrome build.
 *
 *   node ccpp/patch.mjs <stock-dir> <output-dir>
 *
 * Every transform anchors on code *structure* rather than on minified
 * identifiers or byte offsets, so the same script rebases onto later releases.
 * Anything that cannot be located is reported rather than silently skipped —
 * a patch that half-applies is worse than one that fails loudly.
 *
 * See ccpp/PORT-NOTES.md for what each group does and which groups still need
 * hand-written payloads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/* ------------------------------------------------------------- utilities */

/**
 * Walk backwards from `idx` to the `{` that opens the enclosing *function*
 * body, skipping over nested blocks and non-function blocks (if/try/catch/…).
 * Returns the index just after that brace, or -1.
 */
function enclosingFunctionBodyStart(src, idx) {
  const BLOCK_KEYWORDS = /\b(if|for|while|switch|catch|else|try|do|finally|with)\s*$/;
  let depth = 0;

  for (let i = idx; i >= 0; i--) {
    const c = src[i];
    if (c === '}') {
      depth++;
      continue;
    }
    if (c !== '{') continue;

    if (depth > 0) {
      depth--;
      continue;
    }

    // Depth 0: this brace opens the block we are inside.
    const before = src.slice(Math.max(0, i - 2), i);
    if (before.endsWith('=>')) return i + 1;

    if (src[i - 1] === ')') {
      // Find the matching '(' and look at what precedes it.
      let paren = 1;
      let j = i - 2;
      for (; j >= 0 && paren > 0; j--) {
        if (src[j] === ')') paren++;
        else if (src[j] === '(') paren--;
      }
      const head = src.slice(Math.max(0, j - 40), j + 1);
      if (!BLOCK_KEYWORDS.test(head.slice(0, -1))) return i + 1;
    }
    // Not a function opening — keep walking outwards past this brace.
  }
  return -1;
}

/** Insert `text` at the start of the function body containing `needle`. */
function injectAtFunctionStart(src, needle, text) {
  const idx = typeof needle === 'string' ? src.indexOf(needle) : src.search(needle);
  if (idx === -1) return { ok: false, reason: `needle not found: ${needle}` };
  const at = enclosingFunctionBodyStart(src, idx);
  if (at === -1) return { ok: false, reason: `no enclosing function for: ${needle}` };
  return { ok: true, src: src.slice(0, at) + text + src.slice(at) };
}

function replaceOnce(src, find, replacement) {
  const m = src.match(find);
  if (!m) return { ok: false, reason: `pattern not found: ${find}` };
  const all = src.match(new RegExp(find.source, `${find.flags.replace('g', '')}g`));
  if (all && all.length > 1) return { ok: false, reason: `pattern is ambiguous (${all.length} matches): ${find}` };
  return { ok: true, src: src.replace(find, replacement) };
}

function appendModule(src, text) {
  return { ok: true, src: `${src}\n${text}\n` };
}

/* ------------------------------------------------------------ transforms */

/** Match a bundle by role rather than by content hash. */
const CHUNK = {
  mcp: /^mcpPermissions-.*\.js$/,
  shared: /^(SchedulingFields|useStorageState)-.*\.js$/,
  sidepanel: /^sidepanel-.*\.js$/,
  options: /^options-.*\.js$/,
};

const HAIKU_INTERCEPTOR = `
/* __ccpp_fetch_request — remap haiku requests to a user-chosen model when not
   using an OAuth subscription. Installed before any module code runs. */
(function(){
  var __hm = "";
  var __sync = function(){
    chrome.storage.local.get(["haikuMapping","authMode"], function(d){
      __hm = (d && d.authMode && d.authMode !== "oauth") ? (d.haikuMapping || "") : "";
    });
  };
  __sync();
  chrome.storage.onChanged.addListener(function(changes, area){
    if (area === "local" && ("haikuMapping" in changes || "authMode" in changes)) __sync();
  });
  var __orig = window.fetch;
  window.fetch = function(input, init){
    if (!__hm) return __orig.call(this, input, init);
    var url = (typeof input === "string") ? input : (input && input.url) || "";
    if (url.indexOf("/v1/messages") < 0) return __orig.call(this, input, init);
    var remap = function(body){
      try {
        var parsed = JSON.parse(body);
        if (parsed.model && parsed.model.indexOf("haiku") >= 0) {
          parsed.model = __hm;
          return JSON.stringify(parsed);
        }
      } catch (e) {}
      return null;
    };
    var opts = init || {};
    if (opts.body) {
      var next = remap(opts.body);
      if (next) opts = Object.assign({}, opts, { body: next });
      return __orig.call(this, input, opts);
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      var self = this;
      return input.clone().text().then(function(text){
        var next = remap(text);
        return __orig.call(self, next ? new Request(input, { body: next }) : input, init);
      });
    }
    return __orig.call(this, input, opts);
  };
})();
`.trim();

const GB_BOOTSTRAP = (gb) =>
  `
/* __ccpp_gb_bootstrap — load feature gates from a bundled payload instead of
   waiting on the server to grant them. */
(async () => {
  try {
    const res = await fetch(chrome.runtime.getURL("assets/__ccpp_bootstrap.json"));
    ${gb}.setFeatures(await res.json());
    ${gb}.ready = true;
  } catch (e) {}
})();
`.trim();

/** Storage keys the patch introduces on top of the stock enum. */
const EXTRA_KEYS = {
  AUTH_MODE: 'authMode',
  COMPAT_MODE: 'compatMode',
  CUSTOM_AUTH_TOKEN: 'customAuthToken',
  CUSTOM_BASE_URL: 'customBaseUrl',
  CUSTOM_MODELS: 'customModels',
};

const SP_FALLBACK =
  '"You are Claude, an AI assistant in the Claude for Chrome browser extension. ' +
  'Help users with browsing, research, and tasks using available tools. Be helpful, accurate, and concise."';

const COMPAT_LINE = '"You are Claude Code, Anthropic\'s official CLI for Claude."';

/**
 * Find the React namespace alias in scope at a given offset.
 *
 * A chunk can contain several inlined modules, each with its own alias, so the
 * first `(0,X.useState)` in the file is not necessarily the right one — using
 * it yields "(0 , n.useState) is not a function" at render time. Take the
 * nearest hook call instead, which is in the same scope.
 */
function reactAliasNear(src, index, window = 6000) {
  const before = src.slice(Math.max(0, index - window), index);
  const behind = [...before.matchAll(/\(0,(\w+)\.use[A-Z]\w*\)/g)];
  if (behind.length) return behind[behind.length - 1][1];
  const ahead = src.slice(index, index + window).match(/\(0,(\w+)\.use[A-Z]\w*\)/);
  return ahead?.[1] ?? null;
}

/**
 * A hook that mirrors the auth-mode settings into component state, plus a
 * module-scope copy for code that cannot take a dependency on React.
 * `null` means "not read yet", which callers must treat as still loading.
 */
function authModeHook(react, stateVar, setter, keys) {
  const list = keys.map((k) => `"${k}"`).join(',');
  const assigns = keys.map((k) => `__ccppCfg.${k}=__d&&__d.${k}`).join(';');
  return (
    `const[${stateVar},${setter}]=(0,${react}.useState)(__ccppCfg.authMode);` +
    `(0,${react}.useEffect)(()=>{` +
    `const __load=()=>chrome.storage.local.get([${list}],__d=>{${assigns};` +
    `${setter}((__d&&__d.authMode)||"oauth")});__load();` +
    `const __h=(__c,__a)=>{"local"===__a&&[${list}].some(__k=>__k in __c)&&__load()};` +
    `chrome.storage.onChanged.addListener(__h);` +
    `return()=>chrome.storage.onChanged.removeListener(__h)},[]);`
  );
}

/**
 * A mode is only usable once it actually has a credential. Without this the
 * UI unlocks the moment `authMode` flips, letting you into a chat window that
 * cannot send anything.
 */
const HAS_CREDENTIAL =
  '("apiKey"===__ccppAm?!!__ccppCfg.anthropicApiKey:"authToken"===__ccppAm?!!__ccppCfg.customAuthToken:!1)';

/**
 * Module-scope config cache. `var` and `function` are hoisted, so the helpers
 * are usable from code that appears earlier in the bundle. Appended once per
 * chunk that needs it.
 */
const CFG_CACHE = `
/* __ccpp_cfg — auth settings mirrored outside React for non-component code. */
var __ccppCfg = (typeof __ccppCfg !== "undefined" && __ccppCfg) || { authMode: null };
`.trim();

const WATCHED = ['authMode', 'customBaseUrl', 'customAuthToken', 'anthropicApiKey', 'customModels'];

const BASE_URL_HELPER = `
${CFG_CACHE}
function __ccppBaseUrl(){
  return (__ccppCfg.authMode && __ccppCfg.authMode !== "oauth" && __ccppCfg.customBaseUrl) || undefined;
}
(function(){
  var WATCHED = ${JSON.stringify(WATCHED)};
  try {
    var read = function(cb){
      chrome.storage.local.get(WATCHED, function(d){
        d = d || {};
        var before = __ccppCfg.authMode === null ? null : JSON.stringify(WATCHED.map(function(k){ return __ccppCfg[k] }));
        __ccppCfg.authMode = d.authMode || "oauth";
        for (var i = 1; i < WATCHED.length; i++) __ccppCfg[WATCHED[i]] = d[WATCHED[i]];
        var after = JSON.stringify(WATCHED.map(function(k){ return __ccppCfg[k] }));
        if (cb) cb(before !== null && before !== after);
      });
    };
    read(null);
    chrome.storage.onChanged.addListener(function(c, a){
      if (a !== "local") return;
      if (!WATCHED.some(function(k){ return k in c })) return;
      // Reload so the SDK client is rebuilt against the new credential and
      // endpoint. The initial read passes before=null, so this never fires on
      // first load.
      read(function(changed){ if (changed) try { location.reload() } catch (e) {} });
    });
  } catch (e) {}
})();
`.trim();

const TRANSFORMS = [
  {
    id: 'telemetry:segment',
    chunk: CHUNK.mcp,
    apply: (src) => injectAtFunctionStart(src, 'flushInterval:1e4', 'return/*__ccpp_telemetry_off:segment*/;'),
  },
  {
    id: 'telemetry:honeycomb',
    chunk: CHUNK.mcp,
    apply: (src) => injectAtFunctionStart(src, 'hcaik_', 'return/*__ccpp_telemetry_off:honeycomb*/;'),
  },
  {
    id: 'telemetry:datadog',
    chunk: CHUNK.shared,
    apply: (src) => injectAtFunctionStart(src, 'applicationId:"b33c4cea', 'return/*__ccpp_telemetry_off:datadog*/;'),
  },
  {
    id: 'telemetry:sentry',
    chunk: CHUNK.shared,
    optional: true,
    apply: (src) => {
      // Blanking the DSN is enough to stop Sentry reporting and is far more
      // stable across releases than anchoring on the init wrapper.
      const re = /dsn:"https:\/\/[^"]*"/g;
      if (!re.test(src)) return { ok: false, reason: 'no Sentry DSN present (already blank upstream?)' };
      return { ok: true, src: src.replace(/dsn:"https:\/\/[^"]*"/g, 'dsn:""/*__ccpp_telemetry_off:sentry*/') };
    },
  },
  {
    id: 'policy-bypass',
    chunk: CHUNK.mcp,
    apply: (src) =>
      replaceOnce(
        src,
        /(static async isUrlBlockedByManagedPolicy\(\w+\)\{)/,
        '$1return!1/*__ccpp_policy_bypass*/;',
      ),
  },
  {
    id: 'classify-bypass',
    chunk: CHUNK.mcp,
    apply: (src) =>
      replaceOnce(src, /(static async getCategory\(\w+\)\{)/, '$1return void 0/*__ccpp_classify_bypass*/;'),
  },
  {
    id: 'growthbook-bootstrap',
    chunk: CHUNK.shared,
    apply: (src) => {
      // Match the provider usage, not `const{growthbook:e}=useContext(...)` —
      // that one is a destructured local and appending code that references it
      // at module scope is an instant ReferenceError.
      const m = src.match(/growthbook:(\w+),children:/);
      if (!m) return { ok: false, reason: 'could not find the GrowthBook provider' };
      const name = m[1];
      // The identifier must be a module-scope binding, or the append will not
      // see it. Every known build shape is `X=new class{…}`.
      if (!new RegExp(`\\b${name}\\s*=\\s*new class\\b`).test(src)) {
        return { ok: false, reason: `"${name}" is not a module-scope GrowthBook instance` };
      }
      return appendModule(src, GB_BOOTSTRAP(name));
    },
  },
  {
    id: 'haiku-fetch-interceptor',
    chunk: CHUNK.sidepanel,
    apply: (src) => ({ ok: true, src: `${HAIKU_INTERCEPTOR}\n${src}` }),
  },

  /* ---- storage keys: the foundation every settings-driven group needs ---- */
  {
    id: 'storage-keys',
    chunk: CHUNK.mcp,
    apply: (src) => {
      if (src.includes('COMPAT_MODE="compatMode"')) return { ok: false, reason: 'already present' };
      const added = Object.entries(EXTRA_KEYS)
        .map(([k, v]) => `e.${k}="${v}",`)
        .join('');
      return replaceOnce(src, /(e\.ACCESS_TOKEN="accessToken",)/, `$1${added}`);
    },
  },

  /* ------------------------- system-prompt plumbing ---------------------- */
  {
    // Re-run the prompt builder when the user changes the setting mid-session.
    // Inserted as a comma-expression inside the existing const chain, which
    // keeps hook order deterministic without needing to find the statement end.
    id: 'prompt-refresh',
    chunk: CHUNK.sidepanel,
    apply: (src) =>
      replaceOnce(
        src,
        /const (\w+)=\(0,(\w+)\.useCallback\)\(async\(\)=>\{if\(!\w+\)return;(?:const|let) \w+="skip_all_permission_checks"[\s\S]*?\.cache_control=\{type:"ephemeral"\},\w+\(\w+\)\},\[[^\]]*\]\),/,
        (match, builder, react) =>
          `${match}__ccppPromptRefresh=((0,${react}.useEffect)(()=>{` +
          `const __h=(__c,__a)=>{if("local"===__a&&("systemPrompt" in __c||"compatMode" in __c))${builder}()};` +
          `chrome.storage.onChanged.addListener(__h);` +
          `return()=>chrome.storage.onChanged.removeListener(__h)},[${builder}]),null)/*__ccpp_prompt_refresh*/,`,
      ),
  },
  {
    // Without a gated prompt, fall back to the user's own, then to a built-in
    // one — instead of throwing and killing the session.
    id: 'sysprompt-fallback',
    chunk: CHUNK.sidepanel,
    apply: (src) =>
      replaceOnce(
        src,
        /const (\w+)=("skip_all_permission_checks"!==\w+&&"follow_a_plan"!==\w+\|\|!\w+\.skipPermissionsSystemPrompt\?\w+\.systemPrompt:\w+\.skipPermissionsSystemPrompt);if\(!\1\)throw [^;]*?Error\("Unable to initialize the chat session[^"]*"\);/,
        (_m, name, expr) =>
          `let ${name}=${expr};` +
          `if(!${name}){try{const __sp=await new Promise(__r=>chrome.storage.local.get("systemPrompt",__d=>__r(__d&&__d.systemPrompt)));` +
          `${name}=__sp||${SP_FALLBACK}}catch(__e){${name}=${SP_FALLBACK}}}/*__ccpp_sysprompt_fallback*/`,
      ),
  },
  {
    // Compat mode prepends the Claude Code identity, which some proxy
    // providers require, and appends the user's own system prompt.
    id: 'compat-prompt',
    chunk: CHUNK.sidepanel,
    apply: (src) =>
      replaceOnce(
        src,
        /(\w+)=await (\w+)\((\w+)\.SYSTEM_PROMPT\);\1&&(\w+)\.push\(\{type:"text",text:\1\}\),/,
        (_m, custom, get, keys, arr) =>
          `${custom}=await ${get}(${keys}.SYSTEM_PROMPT);` +
          `(await ${get}(${keys}.COMPAT_MODE).then(__ccm=>{` +
          `if(__ccm)${arr}.push({type:"text",text:${COMPAT_LINE}});` +
          `if(${custom})${arr}.push({type:"text",text:${custom}})}))/*__ccpp_compat_prompt*/,`,
      ),
  },

  /* ------------------------------ auth modes ---------------------------- */
  {
    // The paid-plan eligibility check, forced true.
    id: 'eligibility',
    chunk: CHUNK.sidepanel,
    apply: (src) =>
      replaceOnce(
        src,
        /(\w+)=(\(\(\)=>\{const \w+=\w+\(\),\w+=\w+\(\),\w+=\w+\(\);return \w+\|\|\w+\|\|\w+\}\)\(\));(\w+\(\w+\?\.organization\?\.uuid\);)/,
        // Keep the original calls — they are hooks, and dropping them would
        // change hook order. Just ignore the answer.
        '$1=($2,!0)/*__ccpp_sp:elig*/;$3',
      ),
  },
  {
    // The "not eligible" banner. The original patch returned null without
    // telling the parent, which left a stale blocking flag; report not-blocked
    // as well so the composer does not stay disabled.
    id: 'eligibility-banner',
    chunk: CHUNK.sidepanel,
    apply: (src) =>
      replaceOnce(
        src,
        /\(0,(\w+)\.useEffect\)\(\(\)=>\{(\w+)\?\.\(!(\w+)\)\},\[\3,\2\]\),\3\?null:/,
        '(0,$1.useEffect)(()=>{$2?.(!1)},[$2]),!0/*__ccpp_sp:gate*/?null:',
      ),
  },
  {
    // "API Mode" next to "Log in" on the signed-out screen.
    id: 'api-mode-button',
    chunk: CHUNK.shared,
    apply: (src) =>
      replaceOnce(
        src,
        /(\(0,(\w+)\.jsx\)\(\w+,\{defaultMessage:"Log in",id:"odXlk858Gb"\}\)\}\))(\]\}\)\};)/,
        (_m, logIn, jsx, tail) =>
          // Only open the settings page. Flipping authMode here is what let you
          // into a chat window with nothing configured.
          `${logIn},(0,${jsx}.jsx)("button",{onClick:()=>{` +
          `window.open(chrome.runtime.getURL("ccpp-settings.html"),"_blank")},` +
          `className:"mt-3 px-6 py-3 rounded-xl font-base text-text-200 ` +
          `border border-border-300 hover:bg-bg-200 transition-colors cursor-pointer",children:"API Mode"})` +
          `/*__ccpp_api_mode*/${tail}`,
      ),
  },

  /* --------------------- auth modes: the atomic group -------------------- */
  {
    // The account provider decides whether the whole UI is usable. In apiKey
    // and authToken modes there is no profile to fetch, so report ready.
    id: 'auth:account-state',
    chunk: CHUNK.shared,
    apply: (src) => {
      const re =
        /const\{data:(\w+),isLoading:(\w+),error:(\w+)\}=(\w+)\((\w+)\),(\w+)=\{userProfile:\1\?\?null,isLoading:(\w+)\|\|\5&&\2,error:\3,isAuthenticated:\5&&!!\1\};/;
      const found = src.match(re);
      if (!found) return { ok: false, reason: 'account provider shape not found' };
      const react = reactAliasNear(src, found.index);
      if (!react) return { ok: false, reason: 'no React alias in scope at the account provider' };
      const res = replaceOnce(
        src,
        re,
        (_m, data, loading, error, query, hasToken, out, booting) =>
          `const{data:${data},isLoading:${loading},error:${error}}=${query}(${hasToken});` +
          authModeHook(react, '__ccppAm', '__ccppSetAm', ['authMode', 'anthropicApiKey', 'customAuthToken']) +
          `const ${out}=null===__ccppAm` +
          `?{userProfile:null,isLoading:!0,error:${error},isAuthenticated:!1}` +
          `:"oauth"===__ccppAm` +
          `?{userProfile:${data}??null,isLoading:${booting}||${hasToken}&&${loading},error:${error},isAuthenticated:${hasToken}&&!!${data}}` +
          `:{userProfile:${data}??null,isLoading:!1,error:void 0,isAuthenticated:${HAS_CREDENTIAL}};/*__ccpp_stableauth*/`,
      );
      if (!res.ok) return res;
      return { ok: true, src: `${res.src}\n${CFG_CACHE}\n` };
    },
  },
  {
    // Supply the request credential by mode. The stock hook is kept intact and
    // wrapped — it still owns OAuth refresh, which is not worth reimplementing.
    id: 'auth:sidepanel-credential',
    chunk: CHUNK.sidepanel,
    apply: (src) => {
      const re =
        /\{anthropicApiKey:(\w+),authToken:(\w+),needsOAuth:(\w+),needsOAuthReason:(\w+),isLoading:(\w+),refreshTokenIfNeeded:(\w+)\}=(\(\(\)=>\{[\s\S]*?,refreshTokenIfNeeded:\w+\}\}\)\(\)),/;
      const found = src.match(re);
      if (!found) return { ok: false, reason: 'auth hook shape not found' };
      const react = reactAliasNear(src, found.index);
      if (!react) return { ok: false, reason: 'no React alias in scope at the auth hook' };
      return replaceOnce(
        src,
        re,
        (_m, apiKey, token, needs, reason, loading, refresh, stockHook) =>
          `{anthropicApiKey:${apiKey},authToken:${token},needsOAuth:${needs},needsOAuthReason:${reason},` +
          `isLoading:${loading},refreshTokenIfNeeded:${refresh}}=(()=>{const __ccppStock=${stockHook};` +
          authModeHook(react, '__ccppAm', '__ccppSetAm', ['authMode', 'customAuthToken']) +
          `if(null===__ccppAm)return{...__ccppStock,isLoading:!0};` +
          `if("oauth"===__ccppAm)return __ccppStock;` +
          `if("authToken"===__ccppAm)return{authToken:__ccppCfg.customAuthToken,needsOAuth:!1,needsOAuthReason:void 0,` +
          `isLoading:!1,anthropicApiKey:void 0,refreshTokenIfNeeded:async()=>__ccppCfg.customAuthToken};` +
          `return{authToken:void 0,needsOAuth:!1,needsOAuthReason:void 0,isLoading:!1,` +
          `anthropicApiKey:__ccppStock.anthropicApiKey,refreshTokenIfNeeded:async()=>{}}})()/*__ccpp_sp:authHook*/,`,
      );
    },
  },
  {
    // Point the SDK client at a custom base URL when one is configured.
    id: 'auth:custom-base-url',
    chunk: CHUNK.sidepanel,
    apply: (src) => {
      if (!/baseURL:\w+\.apiBaseUrl/.test(src)) return { ok: false, reason: 'no client construction found' };
      const patched = src.replace(
        /baseURL:(\w+)\.apiBaseUrl/g,
        'baseURL:__ccppBaseUrl()||$1.apiBaseUrl/*__ccpp_base_url*/',
      );
      return { ok: true, src: `${patched}\n${BASE_URL_HELPER}\n` };
    },
  },

  /* ------------------------------ model list ---------------------------- */
  {
    // Replace the gated model list with the user's own when not on OAuth.
    // Appended as another effect in the existing comma chain, right after the
    // one that populates options from the gate config.
    id: 'model-list',
    chunk: CHUNK.sidepanel,
    apply: (src) =>
      replaceOnce(
        src,
        /\(0,(\w+)\.useEffect\)\(\(\)=>\{(\w+)\.current=\w+\},\[\w+\]\),\(0,\1\.useEffect\)\(\(\)=>\{\w+\.current\|\|(\w+)\.default&&!\3\.default_model_override_id&&(\w+)\(\3\.default\)\},\[\3\.default,\3\.default_model_override_id\]\),\(0,\1\.useEffect\)\(\(\)=>\{\3\.options&&(\w+)\(\3\.options\)\},\[\3\.options\]\)/,
        (match, react, ref, cfg, setSelected, setOptions) =>
          `${match},(0,${react}.useEffect)(()=>{` +
          `const __restore=()=>{if(${cfg}.options)${setOptions}(${cfg}.options)};` +
          `const __lm=()=>chrome.storage.local.get(["authMode","customModels"],__d=>{` +
          `const __m=__d&&__d.customModels;` +
          `if(!__d||"oauth"===(__d.authMode||"oauth")||!Array.isArray(__m)||!__m.length){__restore();return}` +
          `const __mapped=__m.map(__x=>({model:__x.id,name:__x.name||__x.id}));${setOptions}(__mapped);` +
          `if(!__mapped.some(__z=>__z.model===${ref}.current)){${ref}.current=__mapped[0].model;${setSelected}(__mapped[0].model)}});` +
          `__lm();` +
          `const __h=(__c,__a)=>{"local"===__a&&("customModels" in __c||"authMode" in __c)&&__lm()};` +
          `chrome.storage.onChanged.addListener(__h);` +
          `return()=>chrome.storage.onChanged.removeListener(__h)},[${cfg}.options])/*__ccpp_models*/`,
      ),
  },

  /* ------------------------------ settings UI --------------------------- */
  {
    // A link to the standalone settings page, as the first nav item.
    //
    // The original patch inlined a whole settings UI into the minified options
    // component, which is the one thing that has to be re-bound by hand on
    // every release. A separate page needs no re-binding at all — the only
    // injection is this one link.
    id: 'settings-link',
    chunk: CHUNK.options,
    apply: (src) =>
      replaceOnce(
        src,
        /(\(0,(\w+)\.jsxs\)\("ul",\{className:"flex gap-1 md:flex-col mb-0",children:\[)/,
        (_m, head, jsx) =>
          `${head}(0,${jsx}.jsx)("li",{children:(0,${jsx}.jsx)("a",{` +
          `href:chrome.runtime.getURL("ccpp-settings.html"),target:"_blank",rel:"noreferrer",` +
          `className:"flex items-center gap-2 px-3 py-2 rounded-lg font-base-sm text-text-200 hover:bg-bg-200 transition-colors",` +
          `children:"API & Models"})})/*__ccpp_options*/,`,
      ),
  },
];

/**
 * Groups that still need hand-written payloads bound to this release's
 * minified identifiers. Reported so a partial run is never mistaken for a
 * complete one. Anchors for all of these are recorded in ccpp/PORT-NOTES.md.
 *
 * The three auth-mode entries must land together: enabling the first two alone
 * would make the UI believe it is signed in while requests still demand an
 * OAuth token.
 */
const PENDING = [];

/* ----------------------------------------------------------------- runner */

function findChunk(assetsDir, pattern) {
  return fs.readdirSync(assetsDir).filter((f) => pattern.test(f));
}

/** A mis-anchored insertion is invisible until Chrome refuses to load it. */
function syntaxCheck(file, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpp-check-'));
  const tmp = path.join(dir, `${path.basename(file, '.js')}.mjs`);
  try {
    fs.writeFileSync(tmp, source, 'utf8');
    const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if (res.status !== 0) {
      return { ok: false, reason: String(res.stderr).split('\n').slice(0, 6).join('\n') };
    }
    return { ok: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const stock = process.argv[2];
  const out = process.argv[3];
  if (!stock || !out) {
    console.error('usage: node ccpp/patch.mjs <stock-dir> <output-dir>');
    process.exit(2);
  }
  if (!fs.existsSync(path.join(stock, 'manifest.json'))) {
    console.error(`${stock} does not look like an unpacked extension (no manifest.json).`);
    process.exit(2);
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(stock, out, { recursive: true });
  fs.rmSync(path.join(out, '_metadata'), { recursive: true, force: true });

  const version = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).version;
  console.log(`\nPatching Claude in Chrome ${version}\n  from ${stock}\n  into ${out}\n`);

  const assets = path.join(out, 'assets');
  const bootstrapSrc = path.join('ClaudeInChrome-1.0.77-patch', 'assets', '__ccpp_bootstrap.json');
  if (fs.existsSync(bootstrapSrc)) {
    fs.copyFileSync(bootstrapSrc, path.join(assets, '__ccpp_bootstrap.json'));
    console.log('  + assets/__ccpp_bootstrap.json  (carried over — see PORT-NOTES.md, the payload is stale)');
  } else {
    console.log('  ! assets/__ccpp_bootstrap.json not found in the 1.0.77 patch; feature gates will not be unlocked');
  }

  // The standalone settings page, at the extension root so its URL is stable.
  for (const file of ['ccpp-settings.html', 'ccpp-settings.js']) {
    const from = path.join('ccpp', 'assets', file);
    if (!fs.existsSync(from)) {
      console.log(`  ! ${file} missing from ccpp/assets — the settings page will 404`);
      continue;
    }
    fs.copyFileSync(from, path.join(out, file));
    console.log(`  + ${file}`);
  }

  const dirty = new Map();
  let applied = 0;
  let failed = 0;

  for (const t of TRANSFORMS) {
    const files = findChunk(assets, t.chunk);
    if (files.length === 0) {
      console.log(`  ✗ ${t.id.padEnd(26)} no chunk matching ${t.chunk}`);
      failed++;
      continue;
    }

    let done = false;
    const reasons = [];
    for (const file of files) {
      const full = path.join(assets, file);
      const src = dirty.get(full) ?? fs.readFileSync(full, 'utf8');
      const res = t.apply(src);
      if (res.ok) {
        dirty.set(full, res.src);
        console.log(`  ✓ ${t.id.padEnd(26)} ${file}`);
        applied++;
        done = true;
        break;
      }
      reasons.push(`${file}: ${res.reason}`);
    }
    if (!done) {
      const level = t.optional ? '~' : '✗';
      console.log(`  ${level} ${t.id.padEnd(26)} ${reasons.join(' | ')}`);
      if (!t.optional) failed++;
    }
  }

  console.log('\nSyntax check');
  let broken = 0;
  for (const [file, src] of dirty) {
    const check = syntaxCheck(file, src);
    if (check.ok) {
      console.log(`  ✓ ${path.basename(file)}`);
    } else {
      console.log(`  ✗ ${path.basename(file)}\n${check.reason}`);
      broken++;
    }
  }

  if (broken) {
    console.log(`\n${broken} file(s) failed the syntax check — nothing was written.`);
    fs.rmSync(out, { recursive: true, force: true });
    process.exit(1);
  }

  for (const [file, src] of dirty) fs.writeFileSync(file, src, 'utf8');

  console.log('\nStill to port by hand (see ccpp/PORT-NOTES.md):');
  if (PENDING.length === 0) console.log('  · nothing — every group is applied.');
  for (const [id, what] of PENDING) console.log(`  · ${id.padEnd(16)} ${what}`);

  console.log(
    `\n${applied} transform(s) applied, ${failed} failed, ${PENDING.length} group(s) outstanding.` +
      `\nLoad ${out} via chrome://extensions → Developer mode → Load unpacked.\n`,
  );
  process.exit(failed ? 1 : 0);
}

main();
