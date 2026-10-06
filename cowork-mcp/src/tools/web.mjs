/**
 * Web tools — Cowork's `WebFetch` and `WebSearch`.
 *
 * WebSearch works with no API key at all (DuckDuckGo's HTML endpoint) and
 * upgrades automatically to Brave or Tavily when a key is present.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { config } from '../config.mjs';
import { ok, fail, mixed, guard } from '../lib/result.mjs';
import { clamp, bytes } from '../lib/text.mjs';
import { htmlToMarkdown, decodeEntities, absolutize } from '../lib/html.mjs';

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|bmp)$/i;

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.web.timeout);
  try {
    return await fetch(url, {
      redirect: 'follow',
      ...init,
      headers: {
        'user-agent': config.web.userAgent,
        'accept-language': 'en-US,en;q=0.9',
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(input) {
  let url = String(input ?? '').trim();
  if (!url) throw new Error('URL is required');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported protocol "${parsed.protocol}" — only http and https are allowed.`);
  }
  return parsed.toString();
}

/* -------------------------------------------------------------- WebFetch */

async function webFetchTool({ url, prompt, format = 'markdown', max_length }) {
  const target = normalizeUrl(url);
  let res;
  try {
    res = await request(target);
  } catch (e) {
    if (e.name === 'AbortError') return fail(`Request to ${target} timed out after ${config.web.timeout} ms.`);
    return fail(`Could not reach ${target}: ${e.message}`, 'Check the URL and your network connection.');
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  const finalUrl = res.url || target;

  if (!res.ok && !contentType.includes('html') && !contentType.includes('json')) {
    return fail(`${target} returned HTTP ${res.status} ${res.statusText}.`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > config.web.maxBytes) {
    return fail(
      `${finalUrl} is ${bytes(buf.length)}, over the ${bytes(config.web.maxBytes)} limit.`,
      'Download it with Bash instead if you really need the whole file.',
    );
  }

  const cap = max_length ?? config.limits.maxOutputChars;
  const banner =
    `Fetched ${finalUrl}` +
    (finalUrl !== target ? ` (redirected from ${target})` : '') +
    ` — HTTP ${res.status}, ${contentType || 'unknown type'}, ${bytes(buf.length)}` +
    (prompt ? `\nYou were looking for: ${prompt}` : '');

  if (IMAGE_MIME.test(contentType.split(';')[0].trim())) {
    if (buf.length > 3_500_000) return fail(`Image is ${bytes(buf.length)} — too large to inline.`);
    return mixed([
      { type: 'text', text: banner },
      { type: 'image', data: buf.toString('base64'), mimeType: contentType.split(';')[0].trim() },
    ]);
  }

  if (contentType.includes('pdf')) {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-pdf-')), 'download.pdf');
    fs.writeFileSync(tmp, buf);
    return ok(
      `${banner}\n\nSaved to ${tmp}. Use Read on that path to extract its text.`,
      { path: tmp },
    );
  }

  const body = buf.toString('utf8');

  if (format === 'raw') return ok(`${banner}\n\n${clamp(body, cap, 'response body')}`);

  if (contentType.includes('json')) {
    let pretty = body;
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* leave as-is if it is not valid JSON */
    }
    return ok(`${banner}\n\n\`\`\`json\n${clamp(pretty, cap, 'JSON')}\n\`\`\``);
  }

  if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(body)) {
    const { markdown } = htmlToMarkdown(body, { baseUrl: finalUrl, includeLinks: format !== 'text' });
    return ok(`${banner}\n\n---\n\n${clamp(markdown, cap, 'page content')}`);
  }

  return ok(`${banner}\n\n${clamp(body, cap, 'response body')}`);
}

/* ------------------------------------------------------------- WebSearch */

function ddgUnwrap(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.toString();
  } catch {
    return href;
  }
}

async function searchDuckDuckGo(query, count) {
  const results = [];
  const endpoints = [
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
  ];

  for (const endpoint of endpoints) {
    let html;
    try {
      const res = await request(endpoint);
      if (!res.ok) continue;
      html = await res.text();
    } catch {
      continue;
    }

    const anchorRe = /<a\b[^>]*class=["'][^"']*result(?:__a|-link)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = anchorRe.exec(html)) !== null && results.length < count) {
      const url = ddgUnwrap(decodeEntities(m[1]));
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!title || !/^https?:/i.test(url)) continue;
      if (results.some((r) => r.url === url)) continue;
      results.push({ title, url, snippet: '' });
    }

    // The lite layout has no result classes — fall back to plain result links.
    if (results.length === 0) {
      const liteRe = /<a\b[^>]*href=["'](\/\/duckduckgo\.com\/l\/\?uddg=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = liteRe.exec(html)) !== null && results.length < count) {
        const url = ddgUnwrap(decodeEntities(m[1]));
        const title = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (!title || !/^https?:/i.test(url)) continue;
        if (results.some((r) => r.url === url)) continue;
        results.push({ title, url, snippet: '' });
      }
    }

    // Snippets, matched positionally against the results we found.
    const snippetRe = /<(?:a|td)\b[^>]*class=["'][^"']*result(?:__snippet|-snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td)>/gi;
    const snippets = [];
    while ((m = snippetRe.exec(html)) !== null) {
      snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
    }
    results.forEach((r, i) => {
      if (!r.snippet && snippets[i]) r.snippet = snippets[i];
    });

    if (results.length) return { results, backend: 'duckduckgo' };
  }

  return { results, backend: 'duckduckgo' };
}

async function searchBrave(query, count) {
  const res = await request(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`,
    { headers: { accept: 'application/json', 'x-subscription-token': config.web.braveKey } },
  );
  if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const results = (json.web?.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: String(r.description ?? '').replace(/<[^>]+>/g, ''),
    age: r.age ?? '',
  }));
  return { results, backend: 'brave' };
}

async function searchTavily(query, count) {
  const res = await request('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.web.tavilyKey}` },
    body: JSON.stringify({ query, max_results: Math.min(count, 20), include_answer: true }),
  });
  if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const results = (json.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
  }));
  return { results, backend: 'tavily', answer: json.answer ?? '' };
}

function pickBackend() {
  const requested = config.web.searchBackend;
  if (requested !== 'auto') return requested;
  if (config.web.braveKey) return 'brave';
  if (config.web.tavilyKey) return 'tavily';
  return 'duckduckgo';
}

async function webSearchTool({ query, count, allowed_domains, blocked_domains }) {
  const want = count ?? 10;
  const backend = pickBackend();

  let payload;
  try {
    if (backend === 'brave') payload = await searchBrave(query, want * 2);
    else if (backend === 'tavily') payload = await searchTavily(query, want * 2);
    else payload = await searchDuckDuckGo(query, want * 3);
  } catch (e) {
    if (backend !== 'duckduckgo') {
      payload = await searchDuckDuckGo(query, want * 3);
      payload.note = `${backend} failed (${e.message}); fell back to DuckDuckGo.`;
    } else {
      return fail(`Search failed: ${e.message}`);
    }
  }

  let results = payload.results;
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return '';
    }
  };
  if (allowed_domains?.length) {
    const allow = allowed_domains.map((d) => d.replace(/^www\./, '').toLowerCase());
    results = results.filter((r) => allow.some((d) => host(r.url) === d || host(r.url).endsWith(`.${d}`)));
  }
  if (blocked_domains?.length) {
    const block = blocked_domains.map((d) => d.replace(/^www\./, '').toLowerCase());
    results = results.filter((r) => !block.some((d) => host(r.url) === d || host(r.url).endsWith(`.${d}`)));
  }
  results = results.slice(0, want);

  if (!results.length) {
    return ok(
      `No results for "${query}" (backend: ${payload.backend}).` +
        (payload.note ? `\n${payload.note}` : '') +
        `\n\nTry different wording, or set BRAVE_API_KEY / TAVILY_API_KEY in claude_desktop_config.json for a more reliable search backend.`,
    );
  }

  const lines = results.map((r, i) => {
    const bits = [`${i + 1}. ${r.title}`, `   ${r.url}`];
    if (r.snippet) bits.push(`   ${r.snippet.slice(0, 400)}`);
    if (r.age) bits.push(`   (${r.age})`);
    return bits.join('\n');
  });

  const header = `${results.length} result(s) for "${query}" via ${payload.backend}`;
  const answer = payload.answer ? `\n\nSummary from the search provider:\n${payload.answer}\n` : '';
  const note = payload.note ? `\n[${payload.note}]` : '';

  return ok(
    `${header}${note}${answer}\n\n${lines.join('\n\n')}\n\nUse WebFetch on any of these URLs to read the full page.`,
    { results },
  );
}

/* -------------------------------------------------------------- register */

export function registerWebTools(server) {
  server.registerTool(
    'WebFetch',
    {
      title: 'Fetch a web page',
      description:
        'Download a URL and return it as readable Markdown. HTML is converted, JSON is pretty-printed, ' +
        'images come back inline and PDFs are saved to disk for Read. Follows redirects.',
      inputSchema: {
        url: z.string().describe('The URL to fetch. A bare domain is assumed to be https.'),
        prompt: z.string().optional().describe('What you are looking for on the page — recorded in the output.'),
        format: z.enum(['markdown', 'text', 'raw']).optional().describe('markdown (default), text (no links), or raw.'),
        max_length: z.number().int().min(500).max(500_000).optional().describe('Character cap on the returned body.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(webFetchTool),
  );

  server.registerTool(
    'WebSearch',
    {
      title: 'Search the web',
      description:
        'Search the web and get titles, URLs and snippets. Works without an API key; set BRAVE_API_KEY or ' +
        'TAVILY_API_KEY for better results. Follow up with WebFetch to read a specific page.',
      inputSchema: {
        query: z.string().describe('The search query.'),
        count: z.number().int().min(1).max(20).optional().describe('How many results to return (default 10).'),
        allowed_domains: z.array(z.string()).optional().describe('Only keep results from these domains.'),
        blocked_domains: z.array(z.string()).optional().describe('Drop results from these domains.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(webSearchTool),
  );
}
