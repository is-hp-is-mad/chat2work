/**
 * Todo list — Cowork's `TodoWrite`.
 *
 * The list is per-space and persisted, so a plan survives a Claude Desktop
 * restart the way a Cowork space does.
 */
import { z } from 'zod';
import { JsonStore } from '../lib/store.mjs';
import { todoFile, activeSpace } from '../session.mjs';
import { ok, guard } from '../lib/result.mjs';

const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

function store() {
  return new JsonStore(todoFile(), { todos: [], updatedAt: null });
}

function render(todos) {
  if (!todos.length) return 'The todo list is empty.';
  const order = { in_progress: 0, pending: 1, completed: 2 };
  const sorted = [...todos].sort((a, b) => order[a.status] - order[b.status]);
  const done = todos.filter((t) => t.status === 'completed').length;
  const lines = sorted.map((t) => {
    const label = t.status === 'in_progress' ? t.activeForm || t.content : t.content;
    return `${MARK[t.status] ?? '[ ]'} ${label}`;
  });
  return `${done}/${todos.length} complete\n\n${lines.join('\n')}`;
}

async function todoWriteTool({ todos }) {
  const cleaned = todos.map((t, i) => ({
    content: t.content,
    activeForm: t.activeForm ?? t.content,
    status: t.status ?? 'pending',
    id: t.id ?? `t${i + 1}`,
  }));

  const inProgress = cleaned.filter((t) => t.status === 'in_progress');
  const warning =
    inProgress.length > 1
      ? `\n\nNote: ${inProgress.length} items are marked in_progress. Work on one at a time.`
      : '';

  store().write({ todos: cleaned, updatedAt: new Date().toISOString() });
  const where = activeSpace() ? ` in space "${activeSpace().name}"` : '';
  return ok(`Todo list updated${where}.\n\n${render(cleaned)}${warning}`, { todos: cleaned });
}

async function todoReadTool() {
  const { todos, updatedAt } = store().read();
  const where = activeSpace() ? ` for space "${activeSpace().name}"` : '';
  return ok(
    `Todo list${where}${updatedAt ? ` (updated ${updatedAt})` : ''}:\n\n${render(todos)}`,
    { todos },
  );
}

export function registerTodoTools(server) {
  server.registerTool(
    'TodoWrite',
    {
      title: 'Track a plan',
      description:
        'Write the full todo list for the current piece of work. Send the entire list every time — it replaces ' +
        'the stored one. Mark exactly one item in_progress while you work on it, and complete it before starting ' +
        'the next. Use this for anything with three or more steps so the user can see where things stand.',
      inputSchema: {
        todos: z
          .array(
            z.object({
              content: z.string().describe('The task, in imperative form: "Add the export button".'),
              activeForm: z.string().optional().describe('Present continuous form shown while active: "Adding the export button".'),
              status: z.enum(['pending', 'in_progress', 'completed']).optional(),
              id: z.string().optional(),
            }),
          )
          .describe('The complete list, in the order the work should happen.'),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    guard(todoWriteTool),
  );

  server.registerTool(
    'TodoRead',
    {
      title: 'Read the plan',
      description: 'Show the current todo list for the active space. Useful after resuming a conversation.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(todoReadTool),
  );
}
