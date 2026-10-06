/**
 * CCPP settings page — bring-your-own-credentials for Claude in Chrome.
 *
 * Everything here writes plain keys into chrome.storage.local; the patched
 * bundles read them. Deliberately dependency-free and unminified, so it never
 * needs re-binding when the extension is rebuilt.
 */

const KEYS = [
  'authMode',
  'anthropicApiKey',
  'customAuthToken',
  'customBaseUrl',
  'customModels',
  'haikuMapping',
  'compatMode',
  'systemPrompt',
  'preferred_locale',
];

const STRINGS = {
  title: ['API & Models', 'API 与模型'],
  subtitle: ['Use your own credentials with Claude in Chrome.', '在 Claude in Chrome 中使用你自己的凭据。'],
  authSource: ['Authentication source', '认证来源'],
  oauthTitle: ['OAuth (subscription)', 'OAuth（订阅账户）'],
  oauthDesc: ['Sign in with your Claude account. The default.', '使用 Claude 订阅账户登录，默认方式。'],
  apiKeyTitle: ['API key', 'API 密钥'],
  apiKeyDesc: ['Bill usage to an Anthropic API key.', '用量计入 Anthropic API 密钥。'],
  authTokenTitle: ['Custom bearer token', '自定义 Bearer 令牌'],
  authTokenDesc: ['For a proxy or gateway that speaks the Anthropic API.', '用于兼容 Anthropic API 的代理或网关。'],
  credentials: ['Credentials', '凭据'],
  apiKeyLabel: ['Anthropic API key', 'Anthropic API 密钥'],
  apiKeyHint: ["Starts with sk-ant-. Stored in this browser's extension storage.", '以 sk-ant- 开头，保存在本浏览器的扩展存储中。'],
  authTokenLabel: ['Bearer token', 'Bearer 令牌'],
  authTokenHint: ['Sent as Authorization: Bearer.', '以 Authorization: Bearer 头发送。'],
  baseUrlLabel: ['Base URL', '接口地址'],
  baseUrlHint: ['Leave empty for api.anthropic.com. Changing this reloads the side panel.', '留空则使用 api.anthropic.com。修改后侧边栏会重新加载。'],
  models: ['Models', '模型'],
  modelsHint: ['Replaces the model picker while you are not using OAuth.', '非 OAuth 模式下将替换模型选择器中的列表。'],
  modelsEmpty: ['No models yet — add one, or fetch the list from your endpoint.', '还没有模型 —— 手动添加，或从你的接口拉取列表。'],
  add: ['Add', '添加'],
  fetch: ['Fetch', '拉取'],
  haikuLabel: ['Remap Haiku requests to', '将 Haiku 请求重映射为'],
  haikuHint: ['The extension asks for Haiku for background work. If your endpoint has no Haiku, name a substitute.', '扩展会用 Haiku 处理后台任务。若你的接口没有 Haiku，请指定替代模型。'],
  prompt: ['System prompt', '系统提示'],
  compatLabel: ['Compatibility mode', '兼容模式'],
  compatHint: ['Prepend the Claude Code identity. Some proxies require it.', '在提示前加入 Claude Code 身份标识，部分代理需要。'],
  promptLabel: ['Additional system prompt', '附加系统提示'],
  promptHint: ['Appended to the built-in prompt. Also used as a fallback if none is provided.', '追加在内置提示之后；当没有可用提示时也作为兜底。'],
  save: ['Save', '保存'],
  reset: ['Reset to OAuth', '恢复 OAuth'],
  saved: ['Saved.', '已保存。'],
  removed: ['Removed.', '已删除。'],
  needEndpoint: ['Set a base URL and a credential first.', '请先填写接口地址和凭据。'],
  fetching: ['Fetching…', '拉取中…'],
  fetched: (n) => [`Found ${n} model(s).`, `找到 ${n} 个模型。`],
  fetchFailed: (m) => [`Could not fetch models: ${m}`, `拉取模型失败：${m}`],
  duplicate: ['That model is already in the list.', '该模型已在列表中。'],
  needId: ['Enter a model id.', '请输入模型 ID。'],
  needKey: ['Enter an API key before saving this mode.', '保存该模式前请先填写 API 密钥。'],
  needToken: ['Enter a bearer token before saving this mode.', '保存该模式前请先填写 Bearer 令牌。'],
  needModel: ['Add at least one model before saving this mode.', '保存该模式前请至少添加一个模型。'],
};

let lang = 'en';
let models = [];

const $ = (id) => document.getElementById(id);
const t = (key, ...args) => {
  const entry = STRINGS[key];
  if (!entry) return key;
  const pair = typeof entry === 'function' ? entry(...args) : entry;
  return lang === 'zh' ? pair[1] : pair[0];
};

function applyLanguage() {
  document.documentElement.lang = lang === 'zh' ? 'zh' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  $('lang').textContent = lang === 'zh' ? 'English' : '中文';
  document.title = t('title');
  renderModels();
}

function status(message, kind = '') {
  const el = $('status');
  el.textContent = message;
  el.className = kind;
  if (message) {
    clearTimeout(status._timer);
    status._timer = setTimeout(() => {
      el.textContent = '';
      el.className = '';
    }, 4000);
  }
}

function currentMode() {
  return document.querySelector('input[name=authMode]:checked')?.value ?? 'oauth';
}

/** Only show the fields the selected mode actually uses. */
function syncVisibility() {
  const mode = currentMode();
  $('credentials').classList.toggle('hidden', mode === 'oauth');
  $('modelsSection').classList.toggle('hidden', mode === 'oauth');
  $('f-apikey').classList.toggle('hidden', mode !== 'apiKey');
  $('f-token').classList.toggle('hidden', mode !== 'authToken');
}

function renderModels() {
  const list = $('modelList');
  list.textContent = '';
  $('modelsEmpty').classList.toggle('hidden', models.length > 0);

  models.forEach((model, index) => {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = model.name || model.id;

    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = model.id;

    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = '✕';
    remove.title = lang === 'zh' ? '删除' : 'Remove';
    remove.addEventListener('click', () => {
      models.splice(index, 1);
      renderModels();
      status(t('removed'), 'ok');
    });

    li.append(name, id, remove);
    list.append(li);
  });
}

function load() {
  chrome.storage.local.get(KEYS, (data) => {
    const d = data || {};
    lang = String(d.preferred_locale || navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';

    const mode = d.authMode || 'oauth';
    const radio = document.querySelector(`input[name=authMode][value="${mode}"]`);
    if (radio) radio.checked = true;

    $('apiKey').value = d.anthropicApiKey || '';
    $('authToken').value = d.customAuthToken || '';
    $('baseUrl').value = d.customBaseUrl || '';
    $('haikuMapping').value = d.haikuMapping || '';
    $('systemPrompt').value = d.systemPrompt || '';
    $('compatMode').checked = Boolean(d.compatMode);
    models = Array.isArray(d.customModels) ? d.customModels.slice() : [];

    applyLanguage();
    syncVisibility();
  });
}

function save() {
  const mode = currentMode();
  const key = $('apiKey').value.trim();
  const token = $('authToken').value.trim();

  // Saving a mode with no credential would unlock a chat window that cannot
  // send anything, so refuse it here rather than fail later.
  if (mode === 'apiKey' && !key) {
    status(t('needKey'), 'err');
    $('apiKey').focus();
    return;
  }
  if (mode === 'authToken' && !token) {
    status(t('needToken'), 'err');
    $('authToken').focus();
    return;
  }
  if (mode !== 'oauth' && models.length === 0) {
    status(t('needModel'), 'err');
    $('newModelId').focus();
    return;
  }

  const payload = {
    authMode: mode,
    anthropicApiKey: key,
    customAuthToken: token,
    customBaseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    customModels: models,
    haikuMapping: $('haikuMapping').value.trim(),
    systemPrompt: $('systemPrompt').value,
    compatMode: $('compatMode').checked,
    preferred_locale: lang,
  };
  chrome.storage.local.set(payload, () => status(t('saved'), 'ok'));
}

/** Ask the configured endpoint what models it offers. */
async function fetchModels() {
  const mode = currentMode();
  const base = $('baseUrl').value.trim().replace(/\/+$/, '') || 'https://api.anthropic.com';
  const key = $('apiKey').value.trim();
  const token = $('authToken').value.trim();
  if ((mode === 'apiKey' && !key) || (mode === 'authToken' && !token)) {
    status(t('needEndpoint'), 'err');
    return;
  }

  const headers = { 'anthropic-version': '2023-06-01' };
  if (mode === 'apiKey') headers['x-api-key'] = key;
  else headers.authorization = `Bearer ${token}`;

  status(t('fetching'));
  try {
    const res = await fetch(`${base}/v1/models?limit=100`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    const list = Array.isArray(json.data) ? json.data : [];
    let added = 0;
    for (const item of list) {
      const id = item.id || item.name;
      if (!id || models.some((m) => m.id === id)) continue;
      models.push({ id, name: item.display_name || item.name || id });
      added++;
    }
    renderModels();
    status(t('fetched', added), 'ok');
  } catch (e) {
    status(t('fetchFailed', e.message), 'err');
  }
}

function addModel() {
  const id = $('newModelId').value.trim();
  const name = $('newModelName').value.trim();
  if (!id) {
    status(t('needId'), 'err');
    return;
  }
  if (models.some((m) => m.id === id)) {
    status(t('duplicate'), 'err');
    return;
  }
  models.push({ id, name: name || id });
  $('newModelId').value = '';
  $('newModelName').value = '';
  renderModels();
}

document.addEventListener('DOMContentLoaded', () => {
  load();

  for (const radio of document.querySelectorAll('input[name=authMode]')) {
    radio.addEventListener('change', syncVisibility);
  }
  $('save').addEventListener('click', save);
  $('addModel').addEventListener('click', addModel);
  $('fetchModels').addEventListener('click', fetchModels);
  $('newModelId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addModel();
  });
  $('lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    applyLanguage();
    chrome.storage.local.set({ preferred_locale: lang });
  });
  $('reset').addEventListener('click', () => {
    document.querySelector('input[name=authMode][value=oauth]').checked = true;
    syncVisibility();
    chrome.storage.local.set({ authMode: 'oauth' }, () => status(t('saved'), 'ok'));
  });
});
