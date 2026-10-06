# Porting the CCPP patch from Claude in Chrome 1.0.77 → 1.0.85

## Status

| Step | State |
| --- | --- |
| Identify the extension and fetch the current release | **done** — `fcoeoabgfenejglbffodgkkbkcdhcgfn`, 1.0.85, unpacked to `ClaudeInChrome-latest/` |
| Reverse-engineer the patch | **done** — 30 marked sites, catalogued below and dumped verbatim to `ccpp/patch-sites.txt` |
| Re-anchor each site against 1.0.85 | **done** — every group |
| Produce `ClaudeInChrome-1.0.85-patch` | **done** — `node ccpp/patch.mjs ClaudeInChrome-latest ClaudeInChrome-1.0.85-patch` applies 19 transforms, 0 failed, all four modified chunks syntax-checked |

Still needs a real load-unpacked test in Chrome, and the captured feature-gate
payload is stale (see below).

Applied: telemetry kills (segment, honeycomb, datadog), managed-policy bypass,
URL-classification bypass, GrowthBook local bootstrap, haiku model remapping,
the five extra storage keys, system-prompt fallback, compat mode, live prompt
refresh, eligibility force, eligibility banner, "API Mode" button, account auth
state by mode, sidepanel credential by mode, custom base URL, custom model list,
and the settings-page link.

Notes on where this deliberately differs from the 1.0.77 patch:

- **The settings UI is a separate page, not injected JSX.** 1.0.77 inlined a
  whole settings form into the minified `ge()` options component, referencing
  its minified locals — the one part that had to be re-bound by hand on every
  release. Here `ccpp-settings.html` / `ccpp-settings.js` ship as plain files at
  the extension root and the only injection is a single nav link. Nothing about
  it needs re-binding when the extension is rebuilt. It is also bilingual
  (EN/中文) like the original, and CSP-safe: external script, no inline
  handlers.
- **`ip_bypass` turned out to be unnecessary.** Once the account provider
  reports `isAuthenticated: true` in non-OAuth modes, the page gate it fed
  passes on its own. One fewer site to maintain.
- **The credential hook is wrapped, not replaced.** 1.0.77 substituted the
  whole auth hook; here the stock one is kept and post-processed by mode, so
  OAuth refresh logic is still upstream's problem rather than ours.
- **Custom base URL needed almost nothing.** Stock 1.0.85 already constructs
  the SDK client with either `apiKey` or `authToken` — API-key auth is a
  built-in path. Only `baseURL: X.apiBaseUrl` had to become
  `__ccppBaseUrl()||X.apiBaseUrl`.
- **The eligibility banner is fixed, not just bypassed.** 1.0.77 replaced the
  component with `null`, which skipped its `onBlockingStateChange` callback and
  left the parent's blocking flag stale. The transform here still reports
  not-blocked before rendering nothing.
- **Sentry needed nothing.** 1.0.85 ships no `dsn:"https://…"` — either already
  blank or the integration was dropped. The transform reports this rather than
  failing.
- **Segment's early return lands one function inwards** compared to 1.0.77 —
  in the inner async IIFE rather than the outer wrapper. Same effect, more
  precise position.

## Before shipping

1. **Re-capture `__ccpp_bootstrap.json`.** The carried-over payload is from the
   1.0.77 era: it advertises Opus 4.8 / Sonnet 4.6 and `latest_version: 1.0.12`.
   Refresh it from a live 1.0.85 session, or at minimum update
   `chrome_ext_models`.
2. **Load unpacked and exercise it**: OAuth mode unchanged; API Mode button →
   settings page → key + model → send a message; custom base URL reloads the
   side panel; compat mode reaches the request.

## Bugs found after the first load test

**Entering with nothing configured** — `isAuthenticated` returned `true` for
any non-OAuth `authMode`, and the "API Mode" button set `authMode:"apiKey"` the
moment it was clicked. So one click unlocked a chat window with no credential
and no model. Fixed three ways: the button now only opens settings; the account
provider requires an actual credential for the selected mode; and the settings
page refuses to save a non-OAuth mode without a credential and at least one
model.

**Two crashes that `node --check` could not see** — both syntactically valid,
both fatal at load:

- `growthbook-bootstrap` captured its identifier from
  `const{growthbook:e}=useContext(…)`, a destructured local, and then referenced
  it at module scope. Now matched from the provider usage (`growthbook:X,children:`)
  and checked to be a module-scope `X=new class`.
- The React alias was taken from the first `(0,X.useState)` in the chunk. A
  chunk contains several inlined modules with different aliases, so this gave
  `(0, n.useState) is not a function`. Now resolved from the nearest hook call
  to the injection point (`reactAliasNear`).

Ruled out by static tracing, so they are *not* the cause of "still does not work
after entering":

- **Storage-area mismatch.** `Ae(key)` routes through
  `Ee=new Set(["accessToken","refreshToken","tokenExpiry","startupReauthState"])`
  → session; everything else → local. `anthropicApiKey` is local, which is where
  the settings page writes it.
- **Chat-hook wiring.** `RY({apiKey:V,authToken:H,refreshTokenIfNeeded:G,…})`
  receives both credentials, and the send guard is `(H||V)`.
- **Missing organization uuid.** `organizationUuid` is only threaded into
  analytics-shaped hooks; no request header is built from it.

Most likely remaining explanation: the side panel was in exactly the state bug 1
created — `authMode: "apiKey"` with no key — so `V` and `H` were both undefined,
the SDK client was never constructed, and the effect took its else branch and
set the error *"Sign in to start a conversation."* If that is the text that was
on screen, bug 1's fix covers it. If the text was something else, that is the
string to chase next.


## How the patch is built

Every modification is tagged with a sentinel comment, which is what makes this
port tractable at all:

```js
/*__ccpp_<name>*/          // marks an edited expression or statement
$ccpp$eo                   // patch-introduced identifier
__ccppLang, __apiKey, …    // patch-introduced locals, all `__`-prefixed
assets/__ccpp_bootstrap.json   // patch-introduced file
```

Regenerate the catalogue at any time:

```bash
node ccpp/extract-sites.mjs ClaudeInChrome-1.0.77-patch 700
```

## What the patch does

Six independent groups. They can be ported separately, and three of them are
purely mechanical.

### 1. Telemetry removal — 4 sites, mechanical

`return/*__ccpp_telemetry_off:<vendor>*/;` inserted as the first statement of
each initialiser, so the SDK is never constructed.

| Marker | Function initialises |
| --- | --- |
| `…:segment` | Segment analytics (`segmentWriteKey`) |
| `…:sentry` | Sentry (`dsn` was also blanked to `""`) |
| `…:honeycomb` | Honeycomb OTLP (`hcaik_…` API key) |
| `…:datadog` | Datadog RUM (`applicationId:"b33c4cea…"`) |

1.0.85 locations: segment/honeycomb in `mcpPermissions-192xiXNg.js`;
sentry/datadog in `SchedulingFields-BP7NdejY.js`.

### 2. Policy and classification bypass — 2 sites, mechanical

| Marker | Change |
| --- | --- |
| `__ccpp_policy_bypass` | `static async isUrlBlockedByManagedPolicy(e){` → `…{return!1;` — managed-policy URL blocklists never match |
| `__ccpp_classify_bypass` | `static async getCategory(e){` → `…{return void 0;` — no `POST /api/web/url_hash_check/browser_extension` call, so no per-URL reporting and no category-based blocking |

Both in `mcpPermissions-192xiXNg.js` in 1.0.85, unchanged in shape.

### 3. Local feature-flag bootstrap — 2 sites + 1 file

`__ccpp_bootstrap.json` (52 KB) is a captured GrowthBook payload: model list,
system prompts, tool prompts, and every `chrome_ext_*` / `crochet_*` gate with
the values a paid account would receive.

`__ccpp_gb_bootstrap` appends an IIFE that fetches it and calls
`growthbookInstance.setFeatures(payload); growthbookInstance.ready = true`,
so the extension never needs the server to tell it what it is allowed to do.

In 1.0.85 the GrowthBook instance lives in `SchedulingFields-BP7NdejY.js`
(`growthbook:e` / `growthbook:t` in the provider JSX). Appending the IIFE at the
end of that module is in scope and is more robust than the original mid-file
injection.

**The captured payload is from 1.0.77-era and is stale** — it advertises
Opus 4.8 / Sonnet 4.6 and `latest_version: 1.0.12`. Re-capture it from a live
1.0.85 session, or at minimum refresh `chrome_ext_models`, before shipping.

### 4. Bring-your-own-credentials — the largest group

Adds an auth mode selector (`oauth` | `apiKey` | `authToken`) stored in
`chrome.storage.local`, and makes the whole UI work when not signed in to a
paid plan.

| Marker | File (1.0.77) | Change |
| --- | --- | --- |
| `__ccpp_api_mode` | `useStorageState` | "API Mode" button on the logged-out screen, sets `authMode:"apiKey"` and opens options |
| `__ccpp_stableauth` | `useStorageState` | `isAuthenticated` / `isLoading` derived from `authMode` instead of purely from the OAuth token |
| `__ccpp:ip_bypass` | `useStorageState` | The page provider renders children directly in non-OAuth modes instead of gating on the profile fetch |
| `__ccpp_sp:authHook` | `sidepanel` | Whole auth hook replaced: resolves token from `ANTHROPIC_API_KEY` / `CUSTOM_AUTH_TOKEN` / OAuth by mode, and exposes `__baseUrl` / `__authMode` |
| `__ccpp_sp:elig`, `__ccpp_sp:gate` | `sidepanel` | Eligibility check forced to `true`; the blocking-warning component returns `null` |
| `__ccpp_badge_vis` | `options` | Mode badge + Login button always rendered |

1.0.85 equivalents are all in `SchedulingFields-BP7NdejY.js` (auth/profile
providers, `"all paid plan subscribers"` string) and `sidepanel-BSS8ARkQ.js`.

### 5. Settings UI — 1 huge site

`__ccppLang` / `__ccpp_options` / `__ccpp_models` add two tabs (**API**,
**Models**) to the options page, bilingual EN/中文 via a `__t()` lookup table
keyed off `chrome.storage.local.preferred_locale`, with fields for:

api key · base URL · custom auth token · custom model list (manual and
fetched from `/v1/models`) · compat mode · custom system prompt ·
haiku mapping · show tool result details · show trace IDs · show system reminders

This is hand-written JSX inserted into the minified `ge()` component and is the
one part that cannot be ported by regex — it references minified locals
(`s.useState`, `n.jsx`, `t` = FormattedMessage, `me` = nav link, `ae`/`te` =
layout) whose names differ in 1.0.85's `options-C0QRRkur.js`. Porting means
re-binding those identifiers, which is mechanical but must be done by reading
1.0.85's `ge()` equivalent.

### 6. Request rewriting and prompt plumbing

| Marker | Change |
| --- | --- |
| `__ccpp_fetch_request` | `window.fetch` wrapper: when `authMode !== "oauth"` and a `haikuMapping` is set, rewrites `model` on `/v1/messages` bodies whose model contains `haiku`. Handles both `body` and `Request` forms |
| `__ccpp_sysprompt_fallback` | Falls back to `chrome.storage.local.systemPrompt`, then to a built-in string, when the gate supplies no system prompt |
| `__ccpp_compat_prompt` | `COMPAT_MODE` prepends *"You are Claude Code, Anthropic's official CLI for Claude."*, and appends a user-supplied `SYSTEM_PROMPT` block |
| `__ccpp_prompt_refresh` | Rebuilds the system prompt when `SYSTEM_PROMPT` / `COMPAT_MODE` change in storage |
| `__ccpp_sp:initDeps` | Narrows a `useEffect` dependency array to `[permissionMode]` |
| `__ccpp_yfix` | Memoises the announcement object by `.id` so a new object identity each render stops re-triggering effects |
| `__ccpp_models` | Replaces the model dropdown contents with `customModels` when not in OAuth mode |

### Inert markers

`__ccpp_unblock` ×3 and `__ccpp_featurefix` annotate positions without changing
behaviour in 1.0.77. Nothing to port.

## What 1.0.85 changed that matters

- **`$ccpp$eo` is obsolete.** The patch added an empty-object second argument to
  every `useFeatureValue("chrome_ext_…")` call to stop destructuring crashes
  when a gate returned nothing. 1.0.85 ships that default upstream —
  `m("chrome_ext_system_prompt",{})`. Drop the whole `$ccpp$eo` arg-rewriting
  group and keep only the `window.fetch` interceptor that was bundled with it.
- **Chunks were renamed and resplit.** `useStorageState-*.js` →
  `SchedulingFields-BP7NdejY.js`; `mcpPermissions`, `sidepanel` and `options`
  kept their roles under new hashes. Sentry and Datadog init moved out of
  `mcpPermissions` into the shared chunk. Every anchor must be re-located; none
  can be matched by offset.
- **New surface area**: `SchedulingFields` (scheduled tasks), `SparkAnimated`,
  `cicBridgeMessages` (Claude Desktop bridge), `animations`, plus a very large
  Shiki syntax-highlighting grammar set (`abap.js`, `apex.js`, … several hundred
  files). None of these are touched by the patch, so they come across for free —
  which is the point of rebasing onto 1.0.85 rather than back-porting.

## Recommended approach

Do **not** hand-edit 1.0.85. Write `ccpp/patch.mjs` as a declarative applier —
one entry per site, each with a structure-based regex anchor over the *stock*
bundle — so the same script rebases onto 1.0.86 and later. Groups 1–3 and 6 are
regex-able. Group 4 needs identifier re-binding. Group 5 needs its JSX payload
re-bound by hand once, then it too becomes a regex insertion.

Validate after applying: copy each modified bundle to a `.mjs` temp file and run
`node --check` on it. A mis-anchored insertion is otherwise invisible until the
extension fails to load.

## Reproducing the download

```bash
# derive the id from the manifest key
node -e "const c=require('crypto'),m=require('./ClaudeInChrome-1.0.77-patch/manifest.json');
const h=c.createHash('sha256').update(Buffer.from(m.key,'base64')).digest();
console.log([...h.subarray(0,16)].map(b=>String.fromCharCode(97+(b>>4))+String.fromCharCode(97+(b&15))).join(''))"

# fetch and unpack (CRX3 = 12-byte header + header block + zip)
# see the commands in this repo's history; the update URL is
# https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0.0.0&acceptformat=crx2,crx3&x=id%3D<ID>%26uc
```
