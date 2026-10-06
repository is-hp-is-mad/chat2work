/**
 * End-to-end smoke test: starts the server over stdio and exercises every
 * tool group against a throwaway COWORK_HOME.
 *
 * Run with:  node tests/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'src', 'index.mjs');
const CONFIG_FILE = path.resolve(HERE, '..', 'cowork.config.json');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-test-'));

let passed = 0;
let failed = 0;
const prevConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).split('\n').slice(0, 8).join('\n       ')}` : ''}`);
  }
}

const textOf = (res) => (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function main() {
  console.log(`Test home: ${HOME}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: { ...process.env, COWORK_HOME: HOME, COWORK_DEBUG: '0' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(transport);

  transport.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));

  /* ---------------------------------------------------------- discovery */
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`Discovery — ${tools.length} tools\n  ${names.join(', ')}\n`);

  const expected = [
    'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit',
    'Bash', 'BashOutput', 'KillShell', 'ListShells',
    'JavaScript', 'REPL',
    'WebFetch', 'WebSearch',
    'TodoWrite', 'TodoRead',
    'Space', 'Skill', 'SkillList', 'SkillSave', 'SkillDelete', 'SkillImport',
    'Memory', 'Artifact',
    'TaskCreate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskUpdate', 'TaskStop', 'TaskCleanup',
    'Status', 'Computer', 'ComputerBatch',
    'VMStatus', 'VMMount', 'VMRun',
    'TabsContext', 'TabsCreate', 'TabsClose', 'ReadPage', 'Navigate', 'FormInput', 'BrowserClick', 'BrowserBatch', 'BrowserScreenshot', 'PageScreenshot',
  ];
  for (const name of expected) check(`tool ${name} registered`, names.includes(name));
  check('no sub-agent Task tool', !names.includes('Task'));

  const { resources } = await client.listResources();
  check('4 resources', resources.length === 4, resources.map((r) => r.uri).join(', '));
  const { prompts } = await client.listPrompts();
  check('5 prompts', prompts.length === 5, prompts.map((p) => p.name).join(', '));

  const call = (name, args) => client.callTool({ name, arguments: args ?? {} });

  /* -------------------------------------------------------------- spaces */
  console.log('\nSpaces');
  let r = await call('Space', { action: 'create', name: 'demo', description: 'smoke test space' });
  check('create space', textOf(r).includes('demo') && !r.isError, textOf(r));
  r = await call('Space', { action: 'current' });
  check('active space reported', textOf(r).includes('demo'), textOf(r));
  r = await call('Space', { action: 'list' });
  check('space listed', textOf(r).includes('demo'), textOf(r));

  /* --------------------------------------------------------------- files */
  console.log('\nFiles');
  r = await call('Write', { file_path: 'notes.md', content: '# Notes\n\nalpha\nbeta\ngamma\n' });
  check('write file', !r.isError && textOf(r).includes('Created'), textOf(r));
  check('file on disk', fs.existsSync(path.join(HOME, 'Projects', 'demo', 'notes.md')));

  r = await call('Read', { file_path: 'notes.md' });
  check('read numbers lines', textOf(r).includes('1\t# Notes'), textOf(r));

  r = await call('Edit', { file_path: 'notes.md', old_string: 'beta', new_string: 'BETA' });
  check('edit applied', !r.isError && textOf(r).includes('1 replacement'), textOf(r));
  check('edit on disk', fs.readFileSync(path.join(HOME, 'Projects', 'demo', 'notes.md'), 'utf8').includes('BETA'));

  r = await call('MultiEdit', {
    file_path: 'notes.md',
    edits: [
      { old_string: 'alpha', new_string: 'ALPHA' },
      { old_string: 'gamma', new_string: 'GAMMA' },
    ],
  });
  check('multi-edit applied', !r.isError && textOf(r).includes('2 edit(s)'), textOf(r));
  const notesAfter = fs.readFileSync(path.join(HOME, 'Projects', 'demo', 'notes.md'), 'utf8');
  check('multi-edit on disk', notesAfter.includes('ALPHA') && notesAfter.includes('GAMMA'));

  r = await call('Edit', { file_path: 'notes.md', old_string: 'nope', new_string: 'x' });
  check('edit rejects missing text', r.isError === true, textOf(r));

  await call('Write', { file_path: 'src/a.js', content: 'export const a = 1;\n// TODO: refine\n' });
  await call('Write', { file_path: 'src/b.ts', content: 'export const b: number = 2;\n// TODO: refine\n' });

  r = await call('Glob', { pattern: '**/*.js' });
  check('glob finds js', textOf(r).includes('a.js') && !textOf(r).includes('b.ts'), textOf(r));
  r = await call('Glob', { pattern: '*.ts' });
  check('bare glob matches at depth', textOf(r).includes('b.ts'), textOf(r));

  r = await call('Grep', { pattern: 'TODO', output_mode: 'content', '-n': true });
  check('grep content', textOf(r).includes('TODO: refine'), textOf(r));
  r = await call('Grep', { pattern: 'TODO', type: 'ts' });
  check('grep type filter', textOf(r).includes('b.ts') && !textOf(r).includes('a.js'), textOf(r));
  r = await call('Grep', { pattern: 'nothing-matches-this' });
  check('grep empty result', textOf(r).includes('No matches'), textOf(r));
  r = await call('Grep', { pattern: 'export const a.*\\n.*TODO', output_mode: 'content', multiline: true });
  check('grep multiline', textOf(r).includes('a.js'), textOf(r));
  r = await call('Grep', { pattern: 'a.js', fixed_strings: true, output_mode: 'count', path: 'src' });
  check('grep fixed_strings does not crash', !r.isError, textOf(r));
  r = await call('Grep', { pattern: '[unclosed', output_mode: 'content' });
  check('grep reports a bad regex', r.isError === true, textOf(r));

  /* ----------------------------------------------------------- notebooks */
  console.log('\nNotebooks');
  const nb = { cells: [{ cell_type: 'code', id: 'c1', metadata: {}, source: ['print(1)\n'], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  fs.writeFileSync(path.join(HOME, 'Projects', 'demo', 'nb.ipynb'), JSON.stringify(nb), 'utf8');
  r = await call('Read', { file_path: 'nb.ipynb' });
  check('read notebook', textOf(r).includes('print(1)'), textOf(r));
  r = await call('NotebookEdit', { notebook_path: 'nb.ipynb', cell_id: 'c1', new_source: 'print(2)' });
  check('edit notebook cell', !r.isError, textOf(r));
  r = await call('NotebookEdit', { notebook_path: 'nb.ipynb', cell_type: 'markdown', new_source: '# hi', edit_mode: 'insert' });
  check('insert notebook cell', !r.isError, textOf(r));

  /* --------------------------------------------------------------- shell */
  console.log('\nShell');
  r = await call('Bash', { command: 'echo hello-cowork', description: 'echo test' });
  check('bash foreground', textOf(r).includes('hello-cowork'), textOf(r));
  r = await call('Bash', { command: 'exit 3' });
  check('bash exit code', textOf(r).includes('exit code 3'), textOf(r));

  r = await call('Bash', { command: process.platform === 'win32' ? 'Start-Sleep -Milliseconds 400; echo done-bg' : 'sleep 0.4; echo done-bg', run_in_background: true });
  const bashId = r.structuredContent?.bash_id;
  check('bash background started', Boolean(bashId), textOf(r));
  await new Promise((res) => setTimeout(res, 3000));
  r = await call('BashOutput', { bash_id: bashId });
  check('bash background output', textOf(r).includes('done-bg'), textOf(r));
  r = await call('ListShells', {});
  check('list shells', textOf(r).includes(bashId), textOf(r));

  r = await call('Bash', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', run_in_background: true });
  const victim = r.structuredContent?.bash_id;
  r = await call('KillShell', { shell_id: victim });
  check('kill shell', textOf(r).includes('Killed'), textOf(r));

  const { findPosixShell } = await import('../src/tools/shell.mjs');
  if (findPosixShell('bash')) {
    r = await call('Bash', { command: 'echo posix-ok && pwd', shell: 'bash' });
    check('bash shell works', textOf(r).includes('posix-ok'), textOf(r));
  } else {
    console.log('  skip bash shell — no usable POSIX shell on this machine');
  }

  /* ------------------------------------------------------------- images */
  console.log('\nImages');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  fs.writeFileSync(path.join(HOME, 'Projects', 'demo', 'dot.png'), png);
  r = await call('Read', { file_path: 'dot.png' });
  check('read image returns an image block', (r.content ?? []).some((c) => c.type === 'image'), JSON.stringify(r).slice(0, 200));

  /* --------------------------------------------------------------- repls */
  console.log('\nREPLs');
  r = await call('JavaScript', { code: 'globalThis.counter = 40; console.log("set"); counter + 2' });
  check('javascript runs', textOf(r).includes('=> 42'), textOf(r));
  r = await call('JavaScript', { code: 'counter * 2' });
  check('javascript state persists', textOf(r).includes('=> 80'), textOf(r));
  r = await call('JavaScript', { code: 'throw new Error("boom")' });
  check('javascript reports exceptions', textOf(r).includes('boom'), textOf(r));

  r = await call('REPL', { code: 'x = 7\nprint("py ok")' });
  const pythonWorks = !r.isError && textOf(r).includes('py ok');
  check('python runs', pythonWorks, textOf(r));
  if (pythonWorks) {
    r = await call('REPL', { code: 'x * 6' });
    check('python state persists', textOf(r).includes('42'), textOf(r));
  }

  /* ---------------------------------------------------------------- todo */
  console.log('\nTodo');
  r = await call('TodoWrite', { todos: [{ content: 'first', status: 'completed' }, { content: 'second', activeForm: 'Doing second', status: 'in_progress' }] });
  check('todo write', textOf(r).includes('1/2 complete'), textOf(r));
  r = await call('TodoRead', {});
  check('todo read', textOf(r).includes('Doing second'), textOf(r));

  /* -------------------------------------------------------------- skills */
  console.log('\nSkills');
  r = await call('SkillList', {});
  const skillText = textOf(r);
  for (const s of ['docx', 'xlsx', 'pptx', 'pdf', 'pdf-reading', 'frontend-design', 'research', 'data-analysis', 'html-report']) {
    check(`built-in skill ${s}`, skillText.includes(s), skillText);
  }
  r = await call('Skill', { skill: 'docx' });
  check('load docx skill via skill param', textOf(r).includes('DOCX creation') || textOf(r).includes('docx'), textOf(r).slice(0, 400));
  check('docx skill has no unresolved placeholders', !textOf(r).includes('${CLAUDE_SKILL_DIR}'));
  r = await call('Skill', { name: 'docx' });
  check('load docx skill via name param', textOf(r).includes('DOCX creation') || textOf(r).includes('docx'), textOf(r).slice(0, 400));
  r = await call('SkillSave', { name: 'My Test Skill', description: 'testing', content: '# Test\n\nDo the thing.' });
  check('save skill', !r.isError, textOf(r));
  r = await call('Skill', { name: 'my-test-skill' });
  check('load saved skill', textOf(r).includes('Do the thing'), textOf(r));
  r = await call('SkillDelete', { name: 'my-test-skill' });
  check('delete skill', !r.isError, textOf(r));
  r = await call('SkillDelete', { name: 'docx' });
  check('built-in skill protected', r.isError === true, textOf(r));

  /* -------------------------------------------------------------- memory */
  console.log('\nMemory');
  r = await call('Memory', { action: 'write', name: 'test-pref', description: 'a preference', content: 'The user prefers metric units.', type: 'user' });
  check('memory write', !r.isError, textOf(r));
  r = await call('Memory', { action: 'search', query: 'metric' });
  check('memory search', textOf(r).includes('metric units'), textOf(r));
  r = await call('Memory', { action: 'list' });
  check('memory list', textOf(r).includes('test-pref'), textOf(r));
  check('memory index written', fs.existsSync(path.join(HOME, 'Memory', 'MEMORY.md')));
  r = await call('Memory', { action: 'delete', name: 'test-pref' });
  check('memory delete', !r.isError, textOf(r));
  r = await call('Memory', { action: 'read', name: 'test-pref' });
  check('deleted memory is gone', r.isError === true, textOf(r));

  /* ----------------------------------------------------------- artifacts */
  console.log('\nArtifacts');
  r = await call('Artifact', { action: 'create', name: 'report.md', content: '# Report\n\nBody.\n' });
  check('artifact create', !r.isError, textOf(r));
  check('artifact on disk', fs.existsSync(path.join(HOME, 'Artifacts', 'report.md')));
  r = await call('Artifact', { action: 'create', name: 'report.md', content: 'second' });
  check('artifact does not clobber', fs.existsSync(path.join(HOME, 'Artifacts', 'report-2.md')), textOf(r));
  r = await call('Artifact', { action: 'list' });
  check('artifact list', textOf(r).includes('report.md'), textOf(r));

  /* --------------------------------------------------------------- tasks */
  console.log('\nTasks');
  r = await call('TaskCreate', { title: 'smoke task', command: 'echo task-output-here' });
  const taskId = r.structuredContent?.task_id;
  check('task created', Boolean(taskId), textOf(r));
  await new Promise((res) => setTimeout(res, 4000));
  r = await call('TaskGet', { task_id: taskId });
  check('task completed', textOf(r).includes('completed'), textOf(r));
  r = await call('TaskOutput', { task_id: taskId });
  check('task output captured', textOf(r).includes('task-output-here'), textOf(r));
  r = await call('TaskList', {});
  check('task listed', textOf(r).includes(taskId), textOf(r));

  /* ----------------------------------------------------------- file access */
  console.log('\nFile access');
  const outside = path.join(os.tmpdir(), `cowork-outside-${process.pid}.txt`);
  r = await call('Write', { file_path: outside, content: 'unrestricted by default' });
  check('writes outside the workspace are allowed', !r.isError, textOf(r));
  check('the file really landed there', fs.existsSync(outside));
  try {
    fs.rmSync(outside);
  } catch {
    /* ignore */
  }

  r = await call('Space', { action: 'root' });
  check('root reports the workspace', textOf(r).includes(HOME), textOf(r));

  const movedRoot = path.join(HOME, '..', `cowork-moved-${process.pid}`);
  r = await call('Space', { action: 'root', path: movedRoot });
  check('workspace root can be moved', !r.isError && textOf(r).includes('moved'), textOf(r));
  check('new root exists with a layout', fs.existsSync(path.join(path.resolve(movedRoot), 'Projects')));
  r = await call('Space', { action: 'root', path: HOME });
  check('workspace root can be moved back', !r.isError, textOf(r));
  try {
    fs.rmSync(path.resolve(movedRoot), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  /* ---------------------------------------------------------------- misc */
  console.log('\nComputer use (non-intrusive actions only — no clicking or typing)');
  if (process.platform === 'win32') {
    r = await call('Computer', { action: 'list_displays' });
    check('list displays', textOf(r).includes('display'), textOf(r));
    r = await call('Computer', { action: 'cursor_position' });
    check('cursor position', /cursor is at screen \(\d+, \d+\)/.test(textOf(r)), textOf(r));
    r = await call('Computer', { action: 'screenshot' });
    const isHeadless = r.isError && /句柄无效|invalid handle/i.test(textOf(r));
    if (isHeadless) {
      check('screenshot (headless environment detected)', true);
    } else {
      check('screenshot returns an image', (r.content ?? []).some((c) => c.type === 'image'), textOf(r));
      check('screenshot caption reports scale', /Screenshot: \d+x\d+/.test(textOf(r)), textOf(r));
    }
    r = await call('Computer', { action: 'write_clipboard', text: 'cowork-smoke' });
    check('write clipboard', !r.isError, textOf(r));
    r = await call('Computer', { action: 'read_clipboard' });
    check('read clipboard', textOf(r).includes('cowork-smoke'), textOf(r));
    r = await call('Computer', { action: 'list_windows' });
    check('list windows', textOf(r).includes('visible window'), textOf(r));
    r = await call('Computer', { action: 'left_click', coordinate: [99999, 99999] });
    check('out-of-range coordinate is refused', r.isError === true, textOf(r));
    r = await call('Computer', { action: 'key', text: 'not_a_key' });
    check('unknown key is refused', r.isError === true, textOf(r));
    r = await call('Computer', { action: 'list_granted_applications' });
    check('list granted applications', textOf(r).includes('allowlist') || textOf(r).includes('granted'), textOf(r));
    r = await call('Computer', { action: 'request_access' });
    check('request access', textOf(r).includes('granted'), textOf(r));
    r = await call('Computer', { action: 'wait', duration: 0.05 });
    check('wait in seconds', !r.isError, textOf(r));
    r = await call('ComputerBatch', { actions: [{ action: 'wait', duration: 0.02 }, { action: 'read_clipboard' }], screenshot_after: false });
    check('computer batch non-mutating', !r.isError && textOf(r).includes('Executed batch'), textOf(r));
    r = await call('computer', { action: 'list_displays' });
    check('call tool via lowercase computer alias', !r.isError, textOf(r));
    r = await call('computer_batch', { actions: [{ action: 'wait', duration: 0.02 }], screenshot_after: false });
    check('call tool via snake_case computer_batch alias', !r.isError, textOf(r));
  } else {
    r = await call('Computer', { action: 'screenshot' });
    check('unsupported platform explains itself', r.isError === true && /not implemented/.test(textOf(r)), textOf(r));
  }

  console.log('\nStatus & resources');
  r = await call('Status', {});
  check('status reports home', textOf(r).includes(HOME), textOf(r));
  check('status reports chrome native host', textOf(r).includes('epfodlfclfpfflchbjjlgljipcmnpccp'), textOf(r));
  const guide = await client.readResource({ uri: 'cowork://guide' });
  check('guide resource', guide.contents[0].text.includes('Cowork'), '');
  const ws = await client.readResource({ uri: 'cowork://workspace' });
  check('workspace resource', ws.contents[0].text.includes('demo'), '');
  const prompt = await client.getPrompt({ name: 'resume', arguments: {} });
  check('resume prompt', prompt.messages[0].content.text.includes('TodoRead'), '');

  /* --------------------------------------------------------------- vm ---- */
  console.log('\nOfficial Cowork VM');
  r = await call('VMStatus', {});
  check('vm status reports status', !r.isError && textOf(r).includes('Official Claude Cowork VM Status'), textOf(r));
  r = await call('VMRun', { command: 'python3 -c "import docx, openpyxl, pptx; print(\'official_vm_packages_ok\')"' });
  check('vm run executes in official environment', !r.isError && textOf(r).includes('official_vm_packages_ok'), textOf(r));

  /* -------------------------------------------------------------- web ---- */
  console.log('\nWeb (network — failures here may just mean no connectivity)');
  try {
    r = await call('WebFetch', { url: 'https://example.com' });
    check('webfetch example.com', textOf(r).includes('Example Domain'), textOf(r).slice(0, 300));
  } catch (e) {
    console.log(`  skip webfetch — ${e.message}`);
  }

  await client.close();

  /* ------------------------------- opt-in restriction, second server ----- */
  console.log('\nCOWORK_RESTRICT=1 (opt-in confinement)');
  {
    const t2 = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...process.env, COWORK_HOME: HOME, COWORK_RESTRICT: '1' },
      stderr: 'ignore',
    });
    const c2 = new Client({ name: 'smoke-restricted', version: '1.0.0' });
    await c2.connect(t2);
    const blocked = path.join(os.tmpdir(), `cowork-blocked-${process.pid}.txt`);
    const res = await c2.callTool({ name: 'Write', arguments: { file_path: blocked, content: 'nope' } });
    check('writes outside the workspace are refused', res.isError === true, textOf(res));
    check('nothing was written', !fs.existsSync(blocked));
    const st = await c2.callTool({ name: 'Status', arguments: {} });
    check('status reports confinement', textOf(st).includes('confined to'), textOf(st));
    await c2.close();
  }

  /* ----------------------------------------------- Claude in Chrome Native Host */
  console.log('\nClaude in Chrome Native Host');
  const { getChromeHostStatus } = await import('../src/lib/chrome-host.mjs');
  const hostStat = getChromeHostStatus();
  check('target extension ID hardcoded', hostStat.targetExtensionId === 'epfodlfclfpfflchbjjlgljipcmnpccp');
  check('host binary exists in AppData', hostStat.binaryExists === true);
  check('manifest contains target extension ID', hostStat.hasTargetId === true);
  check('registry registered for browsers', hostStat.registeredBrowsers.length > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
    if (prevConfig !== null) {
      fs.writeFileSync(CONFIG_FILE, prevConfig, 'utf8');
    }
  } catch {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
