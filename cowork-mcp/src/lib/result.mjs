/** Helpers for building MCP CallToolResult payloads. */

export function text(...parts) {
  return { content: [{ type: 'text', text: parts.filter((p) => p !== undefined && p !== null && p !== '').join('\n') }] };
}

export function ok(body, structured) {
  const res = text(body);
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}

export function fail(message, hint) {
  return {
    isError: true,
    content: [{ type: 'text', text: hint ? `${message}\n\nHint: ${hint}` : String(message) }],
  };
}

export function image(base64, mimeType) {
  return { content: [{ type: 'image', data: base64, mimeType }] };
}

export function mixed(blocks, structured) {
  const res = { content: blocks };
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}

/**
 * Wrap a tool handler so thrown errors become clean, actionable tool errors
 * instead of protocol-level failures.
 */
export function guard(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      const msg = e?.message ?? String(e);
      const code = e?.code;
      if (code === 'ENOENT') return fail(msg, 'Check the path — the file or directory does not exist.');
      if (code === 'EACCES' || code === 'EPERM') return fail(msg, 'Permission denied by the operating system.');
      if (code === 'EISDIR') return fail(msg, 'That path is a directory, not a file.');
      if (code === 'ENOTDIR') return fail(msg, 'A component of the path is a file, not a directory.');
      return fail(msg);
    }
  };
}
