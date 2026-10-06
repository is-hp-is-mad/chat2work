/**
 * Browser tools — Direct integration with Claude in Chrome extension.
 *
 * Implements full parity with official Cowork browser automation tools:
 * - `TabsContext` / `tabs_context_mcp`
 * - `TabsCreate` / `tabs_create_mcp`
 * - `TabsClose` / `tabs_close_mcp`
 * - `ReadPage` / `read_page`
 * - `Navigate` / `navigate`
 * - `FormInput` / `form_input`
 * - `BrowserClick` / `click`
 * - `BrowserBatch` / `browser_batch`
 */
import { z } from 'zod';
import { getBrowserClient } from '../lib/browser-pipe.mjs';
import { ok, fail, guard } from '../lib/result.mjs';

function formatExtensionResult(res) {
  if (!res) return ok('No response from extension.');
  if (res.error) {
    const msg = typeof res.error === 'string' ? res.error : res.error.message || JSON.stringify(res.error);
    return fail(`Browser tool failed: ${msg}`);
  }
  const result = res.result || {};
  if (result.content) {
    if (typeof result.content === 'string') {
      return ok(result.content);
    }
    if (Array.isArray(result.content)) {
      const hasImage = result.content.some((c) => c && (c.type === 'image' || c.source?.type === 'base64'));
      if (hasImage) {
        // Preserve and normalize standard MCP image blocks
        const blocks = result.content.map((c) => {
          if (c?.type === 'image') {
            if (c.data && c.mimeType) return c;
            if (c.source?.data) {
              return {
                type: 'image',
                data: c.source.data,
                mimeType: c.source.media_type || 'image/png',
              };
            }
          }
          if (typeof c === 'string') return { type: 'text', text: c };
          if (c && c.text) return { type: 'text', text: c.text };
          return { type: 'text', text: JSON.stringify(c) };
        });
        return { content: blocks };
      }

      const parts = result.content
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c && c.text) return c.text;
          return JSON.stringify(c);
        })
        .join('\n');
      return ok(parts);
    }
  }
  return ok(JSON.stringify(result, null, 2));
}

async function tabsContextTool({ createIfEmpty = true } = {}) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('tabs_context_mcp', { createIfEmpty });
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

async function tabsCreateTool(args = {}) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('tabs_create_mcp', args);
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

async function tabsCloseTool({ tabId }) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('tabs_close_mcp', { tabId });
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

async function readPageTool(args = {}) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('read_page', args);
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

async function navigateTool({ url, tabId }) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('navigate', { url, ...(tabId ? { tabId } : {}) });
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

async function formInputTool({ ref, value, tabId }) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('form_input', { ref, value, ...(tabId ? { tabId } : {}) });
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

async function browserClickTool({ ref, coordinate, tabId }) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('computer', {
      action: 'left_click',
      ...(ref ? { ref } : {}),
      ...(coordinate ? { coordinate } : {}),
      ...(tabId ? { tabId } : {}),
    });
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

async function browserBatchTool({ actions }) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('browser_batch', { actions });
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

async function browserScreenshotTool({ tabId } = {}) {
  const client = getBrowserClient();
  try {
    const res = await client.callTool('computer', {
      action: 'screenshot',
      ...(tabId ? { tabId } : {}),
    });
    return formatExtensionResult(res);
  } catch (err) {
    return fail(err.message);
  }
}

/* -------------------------------------------------------------- register */

export function registerBrowserTools(server) {
  server.registerTool(
    'TabsContext',
    {
      title: 'Get browser tabs context',
      description:
        'Get context information about tabs in Claude in Chrome. Returns all tab IDs and current active tab. ' +
        'CRITICAL: Call this before other browser automation tools if you do not know the active tab ID.',
      inputSchema: {
        createIfEmpty: z
          .boolean()
          .optional()
          .default(true)
          .describe('Whether to create a new tab if no MCP group exists.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(tabsContextTool),
  );

  server.registerTool(
    'TabsCreate',
    {
      title: 'Create new browser tab',
      description: 'Creates a new empty tab in the Claude in Chrome tab group.',
      inputSchema: {},
      annotations: { openWorldHint: true },
    },
    guard(tabsCreateTool),
  );

  server.registerTool(
    'TabsClose',
    {
      title: 'Close browser tab',
      description: 'Close a tab in Claude in Chrome by its tab ID.',
      inputSchema: {
        tabId: z.number().int().describe('The ID of the tab to close.'),
      },
      annotations: { openWorldHint: true },
    },
    guard(tabsCloseTool),
  );

  server.registerTool(
    'ReadPage',
    {
      title: 'Read browser page accessibility tree',
      description:
        'Read the current page in Google Chrome as a structured accessibility tree. ' +
        'Each interactive element is tagged with a reference like [ref_1], [ref_2] for use with Navigate, FormInput, or BrowserClick.',
      inputSchema: {
        tabId: z.number().int().optional().describe('Tab ID to inspect. If omitted, uses the active tab.'),
        depth: z.number().int().optional().describe('Maximum depth of accessibility tree to inspect.'),
        max_chars: z.number().int().optional().describe('Maximum characters of output before truncation.'),
        filter: z.string().optional().describe('Filter elements (e.g. "interactive").'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(readPageTool),
  );

  server.registerTool(
    'Navigate',
    {
      title: 'Navigate browser page',
      description:
        'Navigate the browser to a URL, or go "back" or "forward" in history. ' +
        'Works directly inside your running Google Chrome session without restarting.',
      inputSchema: {
        url: z.string().describe('URL to navigate to, or "back" / "forward".'),
        tabId: z.number().int().optional().describe('Tab ID. If omitted, uses the active tab.'),
      },
      annotations: { openWorldHint: true },
    },
    guard(navigateTool),
  );

  server.registerTool(
    'FormInput',
    {
      title: 'Set form input value',
      description:
        'Fill input fields, textareas, checkboxes, or dropdowns using element ref from ReadPage (e.g. "ref_1").',
      inputSchema: {
        ref: z.string().describe('Element reference ID (e.g. "ref_1") from ReadPage.'),
        value: z.string().describe('Value to set in the form input.'),
        tabId: z.number().int().optional().describe('Tab ID.'),
      },
      annotations: { openWorldHint: true },
    },
    guard(formInputTool),
  );

  server.registerTool(
    'BrowserClick',
    {
      title: 'Click browser element',
      description: 'Click an element in the browser page using element ref (e.g. "ref_1") or coordinate.',
      inputSchema: {
        ref: z.string().optional().describe('Element reference ID from ReadPage (e.g. "ref_1").'),
        coordinate: z.array(z.number()).length(2).optional().describe('[x, y] pixel coordinates to click.'),
        tabId: z.number().int().optional().describe('Tab ID.'),
      },
      annotations: { openWorldHint: true },
    },
    guard(browserClickTool),
  );

  server.registerTool(
    'BrowserBatch',
    {
      title: 'Batch browser actions',
      description: 'Execute a sequential list of browser actions in one round trip.',
      inputSchema: {
        actions: z
          .array(
            z.object({
              name: z.string(),
              input: z.record(z.any()),
            }),
          )
          .describe('List of actions to execute sequentially.'),
      },
      annotations: { openWorldHint: true },
    },
    guard(browserBatchTool),
  );

  server.registerTool(
    'BrowserScreenshot',
    {
      title: 'Capture browser tab screenshot (silent wake-up)',
      description:
        'Capture a high-resolution screenshot of a browser tab in Google Chrome. ' +
        'Silently activates and renders the target tab frame and returns the real image. ' +
        'Supports background tabs — automatically captures and returns base64 image data without requiring manual screen focus.',
      inputSchema: {
        tabId: z.number().int().optional().describe('Tab ID to capture. If omitted, captures the current/active MCP tab.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(browserScreenshotTool),
  );

  server.registerTool(
    'PageScreenshot',
    {
      title: 'Capture browser page screenshot (alias of BrowserScreenshot)',
      description: 'Alias of BrowserScreenshot for capturing high-resolution visual screenshots of Chrome tabs.',
      inputSchema: {
        tabId: z.number().int().optional().describe('Tab ID to capture. If omitted, captures current tab.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(browserScreenshotTool),
  );
}
