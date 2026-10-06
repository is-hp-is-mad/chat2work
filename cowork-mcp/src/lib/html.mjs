/**
 * Dependency-free HTML → Markdown conversion, tuned for "read this page"
 * rather than perfect round-tripping.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', euro: '€', pound: '£', yen: '¥',
  sect: '§', para: '¶', dagger: '†', permil: '‰', larr: '←', rarr: '→', harr: '↔', hArr: '⇔',
};

export function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function safeCodePoint(cp) {
  try {
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  } catch {
    return '';
  }
}

/** Remove elements whose content is never worth reading. */
function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|link|meta)\b[^>]*\/?>/gi, '');
}

/** Pick the densest plausible content container. */
function extractMain(html) {
  const candidates = [];
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<div\b[^>]*(?:id|class)=["'][^"']*(?:content|article|post|entry|markdown|documentation)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) candidates.push(m[1]);
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  candidates.push(body);

  const score = (frag) => frag.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  const bodyScore = score(body);
  // Prefer a semantic container only when it holds most of the page's text.
  const best = candidates
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)[0];
  if (!best) return body;
  const semantic = candidates.slice(0, -1).map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0];
  if (semantic && semantic.s >= bodyScore * 0.25) return semantic.c;
  return best.c;
}

function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

function convertTables(html) {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner) => {
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) =>
        decodeEntities(c[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'),
      ),
    );
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    if (width === 0) return '';
    const pad = (r) => [...r, ...Array(width - r.length).fill('')];
    const out = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
    for (const r of rows.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
    return `\n\n${out.join('\n')}\n\n`;
  });
}

function convertLists(html) {
  // Innermost-first so nesting collapses cleanly.
  let prev;
  let out = html;
  do {
    prev = out;
    out = out.replace(/<(ul|ol)\b[^>]*>((?:(?!<(?:ul|ol)\b)[\s\S])*?)<\/\1>/gi, (_m, tag, inner) => {
      let n = 0;
      const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => {
        n += 1;
        const bullet = tag.toLowerCase() === 'ol' ? `${n}.` : '-';
        const body = li[1].replace(/\s*\n\s*/g, ' ').trim();
        return `${bullet} ${body}`;
      });
      return `\n\n${items.join('\n')}\n\n`;
    });
  } while (out !== prev);
  return out;
}

/**
 * @param {string} html
 * @param {{baseUrl?: string, includeLinks?: boolean}} [opts]
 */
export function htmlToMarkdown(html, opts = {}) {
  const { baseUrl, includeLinks = true } = opts;

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  const descMatch = /<meta\b[^>]*name=["']description["'][^>]*>/i.exec(html);
  const description = descMatch ? attr(descMatch[0], 'content') : '';

  let out = extractMain(stripNoise(html));

  out = out
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    return `\n\n\`\`\`\n${code.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`;
  });

  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    return code ? `\`${code}\`` : '';
  });

  out = convertTables(out);
  out = convertLists(out);

  out = out
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
      const t = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      return t ? `\n\n${'#'.repeat(Number(level))} ${t}\n\n` : '';
    })
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
      const t = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      return t ? `\n\n> ${t}\n\n` : '';
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => {
      const t = inner.replace(/<[^>]+>/g, '').trim();
      return t ? `**${t}**` : '';
    })
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => {
      const t = inner.replace(/<[^>]+>/g, '').trim();
      return t ? `*${t}*` : '';
    });

  out = out.replace(/<img\b([^>]*)>/gi, (_m, tag) => {
    const alt = attr(tag, 'alt');
    const src = attr(tag, 'src');
    if (!src) return '';
    return alt ? `![${alt}](${absolutize(src, baseUrl)})` : '';
  });

  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, tag, inner) => {
    const label = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!label) return '';
    if (!includeLinks) return label;
    const href = attr(tag, 'href');
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) return label;
    return `[${label}](${absolutize(href, baseUrl)})`;
  });

  out = out
    .replace(/<\/(p|div|section|tr|li|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');

  out = decodeEntities(out)
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const header = [];
  if (title) header.push(`# ${title}`);
  if (description) header.push(`_${description}_`);
  return { title, description, markdown: header.length ? `${header.join('\n\n')}\n\n${out}` : out };
}

export function absolutize(href, baseUrl) {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}
