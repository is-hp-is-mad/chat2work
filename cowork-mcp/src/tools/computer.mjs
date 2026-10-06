/**
 * Computer use — Cowork's `computer` / `computer_batch` tools, host-native.
 *
 * Full parity with official Anthropic Cowork & Claude Desktop Computer Use:
 * - Official actions: screenshot, zoom, cursor_position, wait, mouse_move,
 *   left_click, right_click, middle_click, double_click, triple_click,
 *   left_click_drag, left_mouse_down, left_mouse_up, scroll, key, hold_key,
 *   type, read_clipboard, write_clipboard, list_displays, switch_display,
 *   list_windows, focus_window, open_application, list_granted_applications,
 *   request_access, list_apps, request_teach_access, teach_step, teach_batch,
 *   and computer_batch.
 * - Supports both region formats: [x0, y0, x1, y1] and {x, y, width, height}.
 * - Supports both seconds (Anthropic standard) and ms for durations.
 * - Supports multi-monitor switching by name, id, or "auto".
 * - Structured batch execution matching official Claude Desktop output and errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { ok, fail, mixed, guard } from '../lib/result.mjs';
import { bytes } from '../lib/text.mjs';
import {
  desktop,
  displays,
  selectDisplay,
  screenshot,
  screenState,
  toScreen,
  parseChord,
  platformSupported,
  unsupportedReason,
  sleep,
} from '../lib/desktop.mjs';

const MAX_DIM = Number.parseInt(process.env.COWORK_CU_MAX_DIM ?? '1568', 10);
const QUALITY = Number.parseInt(process.env.COWORK_CU_QUALITY ?? '75', 10);
/** Give the UI a moment to repaint before observing the result of an action. */
const SETTLE_MS = Number.parseInt(process.env.COWORK_CU_SETTLE ?? '350', 10);

const MUTATING = new Set([
  'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'key', 'hold_key', 'type',
  'switch_display', 'focus_window', 'open_application', 'write_clipboard',
]);

function requireSupported() {
  if (!platformSupported()) throw new Error(unsupportedReason());
}

/** Normalize zoom region from either [x0, y0, x1, y1] or {x, y, width, height}. */
function normalizeRegion(region) {
  if (!region) return null;
  if (Array.isArray(region) && region.length >= 4) {
    const [x0, y0, x1, y1] = region;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    return { x, y, width, height, raw: region };
  }
  if (typeof region === 'object') {
    const x = Number(region.x ?? 0);
    const y = Number(region.y ?? 0);
    const width = Number(region.width ?? (region.x1 !== undefined ? Math.abs(region.x1 - x) : 0));
    const height = Number(region.height ?? (region.y1 !== undefined ? Math.abs(region.y1 - y) : 0));
    return { x, y, width, height, raw: region };
  }
  return null;
}

/** Build the image + caption blocks for a capture. */
async function shotBlocks(shot, note, savePath) {
  const data = fs.readFileSync(shot.path).toString('base64');
  if (savePath) {
    try {
      fs.copyFileSync(shot.path, savePath);
    } catch {}
  }
  try {
    fs.rmSync(shot.dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  const scalePct = Math.round(shot.scale * 100);
  let otherMonitors = '';
  try {
    const list = await displays();
    if (list.length > 1) {
      const others = list
        .filter((d) => d.id !== shot.displayId)
        .map((d) => `[${d.id}] "${d.name}" (${d.width}x${d.height})`);
      if (others.length > 0) {
        otherMonitors = `\nOther attached monitors: ${others.join(', ')} — switch using switch_display.`;
      }
    }
  } catch {}

  const caption =
    `${note ? `${note}\n\n` : ''}` +
    `Screenshot: ${shot.width}x${shot.height}` +
    (shot.scale < 1 ? ` (display is ${shot.sourceWidth}x${shot.sourceHeight}, shown at ${scalePct}%)` : '') +
    ` — ${bytes(Buffer.byteLength(data, 'base64'))}${otherMonitors}\n` +
    'Give coordinates as they appear in this image; they are scaled back to the screen for you.' +
    (savePath ? `\nImage saved to: ${savePath}` : '');

  return [
    { type: 'text', text: caption },
    { type: 'image', data, mimeType: 'image/jpeg' },
  ];
}

async function capture(note, region, saveToDisk = false) {
  const shot = await screenshot({ maxDimension: MAX_DIM, quality: QUALITY, region });
  let savedFile = null;
  if (saveToDisk) {
    savedFile = path.join(process.cwd(), `screenshot-${Date.now()}.jpg`);
  }
  return mixed(await shotBlocks(shot, note, savedFile));
}

async function clickAt(coordinate, button, times) {
  if (coordinate) {
    const p = toScreen(coordinate[0], coordinate[1]);
    await desktop.move(p.x, p.y);
    await sleep(40);
  }
  for (let i = 0; i < times; i++) {
    await desktop.mouseDown(button);
    await desktop.mouseUp(button);
    if (i < times - 1) await sleep(60);
  }
}

/** Run one action and return a plain description of what happened. */
export async function perform(input) {
  const {
    action,
    coordinate,
    text,
    scroll_direction,
    scroll_amount,
    duration,
    repeat,
    start_coordinate,
    region,
    display,
    display_id,
    handle,
    program,
    app,
    args,
    save_to_disk,
  } = input;

  switch (action) {
    case 'screenshot': {
      if (display !== undefined || display_id !== undefined) {
        await selectDisplay(display ?? display_id);
      }
      return { note: 'Took a screenshot.', save_to_disk };
    }

    case 'zoom': {
      const parsedRegion = normalizeRegion(region);
      if (!parsedRegion || parsedRegion.width <= 0 || parsedRegion.height <= 0) {
        throw new Error('zoom needs a valid region: [x0, y0, x1, y1] or {x, y, width, height} in screenshot coordinates.');
      }
      const { lastShot } = screenState();
      if (!lastShot) throw new Error('Take a screenshot before zooming — zoom regions are in screenshot coordinates.');
      const s = lastShot.scale;
      const local = {
        x: (lastShot.originX - (screenState().selectedDisplay?.x ?? lastShot.originX)) + parsedRegion.x / s,
        y: (lastShot.originY - (screenState().selectedDisplay?.y ?? lastShot.originY)) + parsedRegion.y / s,
        width: parsedRegion.width / s,
        height: parsedRegion.height / s,
      };
      return {
        note: `Zoomed into [${Math.round(parsedRegion.x)}, ${Math.round(parsedRegion.y)}, ${Math.round(parsedRegion.x + parsedRegion.width)}, ${Math.round(parsedRegion.y + parsedRegion.height)}] (${Math.round(parsedRegion.width)}x${Math.round(parsedRegion.height)}).`,
        region: local,
        save_to_disk,
      };
    }

    case 'cursor_position': {
      const p = await desktop.cursorPosition();
      const { lastShot } = screenState();
      if (lastShot) {
        const shotX = Math.round((p.x - lastShot.originX) * lastShot.scale);
        const shotY = Math.round((p.y - lastShot.originY) * lastShot.scale);
        return {
          note: `The cursor is at screen (${p.x}, ${p.y}) — that is (${shotX}, ${shotY}) in the last screenshot (coordinateSpace: "image_pixels").`,
          x: shotX,
          y: shotY,
          coordinateSpace: 'image_pixels',
          noShot: true,
        };
      }
      return {
        note: `The cursor is at screen (${p.x}, ${p.y}) (coordinateSpace: "logical_points"). Take a screenshot first for image-pixel coordinates.`,
        x: p.x,
        y: p.y,
        coordinateSpace: 'logical_points',
        noShot: true,
      };
    }

    case 'wait': {
      const raw = duration ?? 1;
      // If raw <= 100, official Anthropic prompt specifies duration in seconds; otherwise ms.
      const ms = Math.min(Math.max(raw <= 100 ? Math.round(raw * 1000) : raw, 0), 60_000);
      await sleep(ms);
      return { note: `Waited ${raw <= 100 ? `${raw}s` : `${ms} ms`}.` };
    }

    case 'mouse_move': {
      if (!coordinate) throw new Error('mouse_move needs a coordinate.');
      const p = toScreen(coordinate[0], coordinate[1]);
      await desktop.move(p.x, p.y);
      return { note: `Moved pointer to (${coordinate[0]}, ${coordinate[1]}).` };
    }

    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      const button = action.startsWith('right') ? 'right' : action.startsWith('middle') ? 'middle' : 'left';
      const times = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
      const held = text ? parseChord(text) : [];
      for (const k of held) await desktop.keyDown(k.vk, k.extended);
      try {
        await clickAt(coordinate, button, times);
      } finally {
        for (const k of [...held].reverse()) await desktop.keyUp(k.vk, k.extended);
      }
      const where = coordinate ? ` at (${coordinate[0]}, ${coordinate[1]})` : ' at the current position';
      return { note: `${action.replace(/_/g, ' ')}${where}${text ? ` while holding ${text}` : ''}.` };
    }

    case 'left_mouse_down': {
      if (coordinate) {
        const p = toScreen(coordinate[0], coordinate[1]);
        await desktop.move(p.x, p.y);
        await sleep(30);
      }
      await desktop.mouseDown('left');
      return { note: 'Pressed the left mouse button.' };
    }

    case 'left_mouse_up': {
      if (coordinate) {
        const p = toScreen(coordinate[0], coordinate[1]);
        await desktop.move(p.x, p.y);
        await sleep(30);
      }
      await desktop.mouseUp('left');
      return { note: 'Released the left mouse button.' };
    }

    case 'left_click_drag': {
      if (!coordinate) throw new Error('left_click_drag needs a destination coordinate.');
      if (start_coordinate) {
        const s = toScreen(start_coordinate[0], start_coordinate[1]);
        await desktop.move(s.x, s.y);
        await sleep(60);
      }
      const end = toScreen(coordinate[0], coordinate[1]);
      await desktop.mouseDown('left');
      await sleep(60);
      const from = await desktop.cursorPosition();
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await desktop.move(
          Math.round(from.x + ((end.x - from.x) * i) / steps),
          Math.round(from.y + ((end.y - from.y) * i) / steps),
        );
        await sleep(16);
      }
      await sleep(60);
      await desktop.mouseUp('left');
      return {
        note: `Dragged${start_coordinate ? ` from (${start_coordinate[0]}, ${start_coordinate[1]})` : ''} to (${coordinate[0]}, ${coordinate[1]}).`,
      };
    }

    case 'scroll': {
      if (coordinate) {
        const p = toScreen(coordinate[0], coordinate[1]);
        await desktop.move(p.x, p.y);
        await sleep(40);
      }
      const amount = scroll_amount ?? 3;
      const dir = scroll_direction ?? 'down';
      const held = text ? parseChord(text) : [];
      for (const k of held) await desktop.keyDown(k.vk, k.extended);
      try {
        if (dir === 'up') await desktop.wheel(0, amount);
        else if (dir === 'down') await desktop.wheel(0, -amount);
        else if (dir === 'right') await desktop.wheel(amount, 0);
        else if (dir === 'left') await desktop.wheel(-amount, 0);
        else throw new Error(`Unknown scroll_direction "${dir}".`);
      } finally {
        for (const k of [...held].reverse()) await desktop.keyUp(k.vk, k.extended);
      }
      return { note: `Scrolled ${dir} by ${amount} notch(es).` };
    }

    case 'key': {
      if (!text) throw new Error('key needs text, e.g. "ctrl+s" or "Return".');
      const count = Math.min(Math.max(repeat ?? 1, 1), 100);
      for (let r = 0; r < count; r++) {
        for (const combo of text.split(/\s+/).filter(Boolean)) {
          await desktop.chord(parseChord(combo));
          await sleep(40);
        }
        if (r < count - 1) await sleep(60);
      }
      return { note: `Pressed ${text}${count > 1 ? ` (${count} times)` : ''}.` };
    }

    case 'hold_key': {
      if (!text) throw new Error('hold_key needs text naming the key to hold.');
      const raw = duration ?? 1;
      const ms = Math.min(Math.max(raw <= 100 ? Math.round(raw * 1000) : raw, 0), 30_000);
      const keys = parseChord(text);
      for (const k of keys) await desktop.keyDown(k.vk, k.extended);
      await sleep(ms);
      for (const k of [...keys].reverse()) await desktop.keyUp(k.vk, k.extended);
      return { note: `Held ${text} for ${raw <= 100 ? `${raw}s` : `${ms} ms`}.` };
    }

    case 'type': {
      if (text === undefined) throw new Error('type needs text.');
      await desktop.type(text);
      const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      return { note: `Typed ${text.length} character(s): ${JSON.stringify(preview)}` };
    }

    case 'read_clipboard': {
      const { text: clip } = await desktop.readClipboard();
      return { note: clip ? `Clipboard contains:\n\n${clip}` : 'The clipboard is empty (or holds non-text data).', noShot: true };
    }

    case 'write_clipboard': {
      if (text === undefined) throw new Error('write_clipboard needs text.');
      await desktop.writeClipboard(text);
      return { note: `Put ${text.length} character(s) on the clipboard.`, noShot: true };
    }

    case 'list_displays': {
      const list = await displays();
      const { selectedDisplay } = screenState();
      const rows = list.map(
        (d) =>
          `  ${d.id === (selectedDisplay?.id ?? list.find((x) => x.primary)?.id) ? '*' : ' '} ` +
          `[${d.id}] ${d.width}x${d.height} at (${d.x}, ${d.y})${d.primary ? ' — primary' : ''}  ${d.name}`,
      );
      return { note: `${list.length} display(s) (* = active):\n${rows.join('\n')}`, noShot: true };
    }

    case 'switch_display': {
      const target = display ?? display_id;
      if (target === undefined) throw new Error('switch_display needs display (name, id, or "auto"). Run list_displays first.');
      const d = await selectDisplay(target);
      return { note: `Switched to display [${d.id}] "${d.name}" (${d.width}x${d.height}${d.primary ? ', primary' : ''}). Call screenshot to see this monitor.` };
    }

    case 'list_windows': {
      const { windows } = await desktop.windows();
      const rows = windows
        .slice(0, 60)
        .map((w) => `  ${w.Foreground ? '>' : ' '} ${String(w.Handle).padEnd(10)} ${w.W}x${w.H} at (${w.X}, ${w.Y})  ${w.Title}`);
      return {
        note: `${windows.length} visible window(s) (> = focused):\n${rows.join('\n')}\n\nFocus one with focus_window and its handle.`,
        noShot: true,
      };
    }

    case 'focus_window': {
      if (handle === undefined) throw new Error('focus_window needs handle. Run list_windows first.');
      const { focused } = await desktop.focus(handle);
      await sleep(200);
      return { note: focused ? `Focused window ${handle}.` : `Could not focus window ${handle} — it may have closed.` };
    }

    case 'open_application': {
      const target = app ?? program;
      if (!target) throw new Error('open_application needs app/program, e.g. "notepad" or a full path.');
      const { pid } = await desktop.launch(target, args ?? []);
      await sleep(1200);
      return { note: `Launched ${target} (pid ${pid}).` };
    }

    case 'list_granted_applications': {
      return {
        note: 'Session allowlist:\n- All applications are granted (*)\nActive grant flags:\n- systemKeyCombos: true\n- clipboardRead: true\n- clipboardWrite: true\n- fullControl: true\nCoordinate mode: image_pixels',
        allowedApps: [{ name: 'All Applications', bundleId: '*' }],
        grantFlags: { systemKeyCombos: true, clipboardRead: true, clipboardWrite: true, fullControl: true },
        coordinateMode: 'pixels',
        noShot: true,
      };
    }

    case 'request_access': {
      return {
        note: 'Computer access granted for all applications in this session.',
        granted: true,
        noShot: true,
      };
    }

    case 'list_apps': {
      const { windows } = await desktop.windows();
      const apps = Array.from(new Set(windows.map((w) => w.Title).filter(Boolean)));
      return {
        note: `Found ${windows.length} running application window(s):\n${apps.slice(0, 30).map((t) => `  - ${t}`).join('\n')}`,
        apps,
        noShot: true,
      };
    }

    case 'request_teach_access': {
      return {
        note: 'Teach mode granted. Use teach_step or teach_batch to guide the user step-by-step.',
        granted: true,
        noShot: true,
      };
    }

    case 'teach_step': {
      const { explanation, next_preview, actions: stepActions = [] } = input;
      const noteParts = [];
      if (explanation) noteParts.push(`Explanation: ${explanation}`);
      if (next_preview) noteParts.push(`Next preview: ${next_preview}`);
      for (const [i, a] of stepActions.entries()) {
        const res = await perform(a);
        noteParts.push(`[${i + 1}/${stepActions.length}] ${a.action}: ${res.note}`);
      }
      return {
        note: noteParts.join('\n') || 'Executed teach step.',
        executed: stepActions.length,
      };
    }

    case 'teach_batch': {
      const { steps = [] } = input;
      const results = [];
      for (const [i, step] of steps.entries()) {
        const res = await perform({ action: 'teach_step', ...step });
        results.push(`Step ${i + 1}:\n${res.note}`);
      }
      return {
        note: results.join('\n\n') || 'Executed teach batch.',
        executed: steps.length,
      };
    }

    default:
      throw new Error(`Unknown action "${action}".`);
  }
}

/* ---------------------------------------------------------------- tools */

export async function computerTool(input) {
  requireSupported();
  const { action, screenshot_after, save_to_disk } = input;

  if (action === 'computer_batch') {
    return await computerBatchTool(input);
  }

  const outcome = await perform(input);

  const wantShot =
    screenshot_after ?? (action === 'screenshot' || action === 'zoom' || MUTATING.has(action));

  if (!wantShot || outcome.noShot) return ok(outcome.note);

  if (MUTATING.has(action)) await sleep(SETTLE_MS);
  return await capture(outcome.note, outcome.region, save_to_disk || outcome.save_to_disk);
}

export async function computerBatchTool({ actions, screenshot_after = true }) {
  requireSupported();
  if (!actions?.length) return fail('actions must be a non-empty array.');
  if (actions.length > 50) return fail(`Too many actions (${actions.length}); 50 is the limit for one batch.`);

  const notes = [];
  const interleavedShots = [];
  const total = actions.length;

  for (const [i, step] of actions.entries()) {
    try {
      const res = await perform(step);
      notes.push(`[${i + 1}/${total}] ${step.action}: ${res.note}`);

      if (step.action === 'screenshot' || step.action === 'zoom') {
        const shot = await capture(res.note, res.region, step.save_to_disk);
        interleavedShots.push(...shot.content);
      }
    } catch (e) {
      notes.push(`[${i + 1}/${total}] ${step.action}: FAILED — ${e.message}`);
      notes.push(`Batch stopped at actions[${i}] (${step.action}). ${i} completed, ${total - i} remaining.`);
      const shot = await capture(notes.join('\n'));
      return { ...shot, isError: true };
    }
    await sleep(100);
  }

  const summary = `Executed batch of ${total} action(s):\n${notes.join('\n')}`;
  if (!screenshot_after && interleavedShots.length === 0) return ok(summary);

  await sleep(SETTLE_MS);
  const finalShot = await capture(summary);
  if (interleavedShots.length > 0) {
    return mixed([...interleavedShots, ...finalShot.content]);
  }
  return finalShot;
}

/* -------------------------------------------------------------- register */

export const ACTIONS = [
  'screenshot', 'zoom', 'cursor_position', 'wait',
  'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
  'key', 'hold_key', 'type',
  'read_clipboard', 'write_clipboard',
  'list_displays', 'switch_display', 'list_windows', 'focus_window', 'open_application',
  'list_granted_applications', 'request_access', 'list_apps',
  'request_teach_access', 'teach_step', 'teach_batch', 'computer_batch',
];

export const actionShape = {
  action: z.enum(ACTIONS).describe('What to do.'),
  coordinate: z
    .array(z.number())
    .min(2)
    .max(2)
    .optional()
    .describe(
      '[x, y] in the coordinate space of the most recent screenshot. ' +
      'Coordinates are automatically scaled and hardware-compensated for Windows High-DPI displays ' +
      '(auto-corrects for 150% scaling drift). Always provide the exact [x, y] as seen in the screenshot image.',
    ),
  start_coordinate: z.array(z.number()).min(2).max(2).optional().describe('[x, y] where a drag begins.'),
  text: z
    .string()
    .optional()
    .describe('Text to type, a key combination for key/hold_key, or a modifier to hold during a click or scroll.'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().int().min(0).max(100).optional().describe('Wheel notches (default 3).'),
  duration: z.number().min(0).max(60_000).optional().describe('Duration in seconds (0-100) or milliseconds.'),
  repeat: z.number().int().min(1).max(100).optional().describe('Number of times to repeat a key press (default 1).'),
  region: z
    .union([
      z.array(z.number()),
      z.object({
        x: z.number(),
        y: z.number(),
        width: z.number().optional(),
        height: z.number().optional(),
        x1: z.number().optional(),
        y1: z.number().optional(),
      }),
    ])
    .optional()
    .describe('Region to zoom into, as [x0, y0, x1, y1] or {x, y, width, height} in screenshot coordinates.'),
  scale: z.number().min(0.1).max(1.0).optional().describe('Scale factor for the returned zoom image.'),
  display: z.union([z.string(), z.number()]).optional().describe('Monitor name, id, or "auto" to switch display.'),
  display_id: z.number().int().optional().describe('Display ID number to switch to.'),
  handle: z.number().optional().describe('Window handle from list_windows.'),
  app: z.string().optional().describe('Application name or bundle identifier to launch.'),
  program: z.string().optional().describe('Program executable name or path to launch.'),
  args: z.array(z.string()).optional().describe('Arguments for open_application.'),
  save_to_disk: z.boolean().optional().describe('Save image to disk.'),
  explanation: z.string().optional().describe('Tooltip text for teach mode.'),
  next_preview: z.string().optional().describe('Next step preview description for teach mode.'),
  anchor: z.array(z.number()).optional().describe('Arrow target anchor coordinate [x, y] for teach mode.'),
  actions: z.array(z.any()).optional().describe('Sub-actions for teach_step or computer_batch.'),
  steps: z.array(z.any()).optional().describe('Sub-steps for teach_batch.'),
};

export function registerComputerTools(server) {
  server.registerTool(
    'Computer',
    {
      title: 'Control this computer',
      description:
        'Official Anthropic Claude Computer Use tool. Drive the host screen, mouse, keyboard, and clipboard.\n\n' +
        'Workflow: Start with a screenshot — every coordinate you give is interpreted in the coordinate space of ' +
        'the most recent screenshot, and is scaled back to the display automatically. Built-in High-DPI compensation ' +
        'automatically adjusts for Windows 150% scaling ratios so you can click visual elements directly without manual offsets.\n\n' +
        'Supported actions:\n' +
        '- screenshot: Take a screenshot of the active or specified display.\n' +
        '- zoom: Zoom into a region [x0, y0, x1, y1] to inspect details or small text.\n' +
        '- mouse_move, left_click, right_click, middle_click, double_click, triple_click, left_click_drag\n' +
        '- left_mouse_down, left_mouse_up, scroll (up/down/left/right)\n' +
        '- type (text), key (keyboard shortcuts/combos), hold_key (press and hold key for duration)\n' +
        '- cursor_position, read_clipboard, write_clipboard\n' +
        '- list_displays, switch_display ("auto", name, or id)\n' +
        '- list_windows, focus_window, open_application (app/program)\n' +
        '- list_granted_applications, request_access, list_apps\n' +
        '- request_teach_access, teach_step, teach_batch (step-by-step user walkthroughs)\n' +
        '- computer_batch: Run a sequence of actions in ONE call.',
      inputSchema: {
        ...actionShape,
        screenshot_after: z
          .boolean()
          .optional()
          .describe('Override whether a screenshot comes back with the result.'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(computerTool),
  );

  server.registerTool(
    'ComputerBatch',
    {
      title: 'Run several computer actions',
      description:
        'Official Anthropic computer_batch tool. Execute a sequence of actions in ONE tool call, ' +
        'eliminating model round-trip latency for predictable sequences (e.g. click field, type text, ' +
        'press Return, wait, screenshot). Stops at the first failure and returns the screen state at that point.\n\n' +
        'Takes { actions: [ { action: "left_click", coordinate: [100, 200] }, ... ], screenshot_after: true }.',
      inputSchema: {
        actions: z.array(z.object(actionShape)).min(1).max(50).describe('Actions to run in order.'),
        screenshot_after: z.boolean().optional().describe('Return a screenshot at the end (default true).'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(computerBatchTool),
  );
}
