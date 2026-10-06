/** Text helpers shared by the file and shell tools. */
import { config } from '../config.mjs';

/** Truncate long output with an explicit marker so Claude knows it is partial. */
export function clamp(text, max = config.limits.maxOutputChars, label = 'output') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const keepHead = Math.floor(max * 0.7);
  const keepTail = max - keepHead;
  const omitted = s.length - max;
  return (
    s.slice(0, keepHead) +
    `\n\n… [${omitted.toLocaleString()} characters of ${label} omitted — ` +
    `narrow the request or write the full result to a file] …\n\n` +
    s.slice(s.length - keepTail)
  );
}

/** `cat -n` style numbering, 1-indexed from `start`. */
export function numberLines(lines, start = 1) {
  const width = String(start + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(start + i).padStart(width, ' ')}\t${line}`)
    .join('\n');
}

/** Heuristic binary sniff on the first chunk of a file. */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / n > 0.3;
}

/** Split preserving the caller's ability to rejoin exactly. */
export function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** Compile a user pattern into a RegExp, mapping ripgrep-ish flags. */
export function compilePattern(pattern, { caseInsensitive = false, multiline = false, fixed = false } = {}) {
  const source = fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  let flags = 'g';
  if (caseInsensitive) flags += 'i';
  if (multiline) flags += 's';
  return new RegExp(source, flags);
}

export function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\[[0-?]*[ -/]*[@-~]/g, '');
}
