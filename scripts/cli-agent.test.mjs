// Claude Code and Codex on the machine, without a machine: the command lines
// the page starts them with, how it reads what they stream, and how it finds
// the sign-in page in what their login prints.
//
//   node --test scripts/cli-agent.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const cli = await load('src/lib/cliAgent.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });
after(cleanup);

const line = (value) => JSON.stringify(value);

describe('the command lines', () => {
  it('runs Claude Code headless, streaming, carrying the session on', () => {
    const argv = cli.runArgv('claude', { prompt: 'fix it', session: 's-1', model: 'opus', commands: true, context: 'ctx' });
    assert.deepEqual(argv.slice(0, 3), ['claude', '-p', 'fix it']);
    for (const flag of ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash', '--model', 'opus', '--resume', 's-1', '--append-system-prompt', 'ctx']) assert.ok(argv.includes(flag), flag);
    assert.ok(!cli.runArgv('claude', { prompt: 'x', commands: false, context: '' }).includes('Bash'));
  });
  it('runs Codex with exec --json, resuming a thread', () => {
    const argv = cli.runArgv('codex', { prompt: 'go', session: 't-9', commands: false, context: 'ctx' });
    assert.deepEqual(argv.slice(0, 7), ['codex', 'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', 'resume']);
    assert.equal(argv[7], 't-9');
    assert.match(argv[8], /ctx[\s\S]*go/);
  });
  it('signs in with the account, or the Console', () => {
    assert.deepEqual(cli.loginArgv('claude'), ['claude', 'auth', 'login', '--claudeai']);
    assert.deepEqual(cli.loginArgv('claude', true), ['claude', 'auth', 'login', '--console']);
    assert.deepEqual(cli.loginArgv('codex'), ['codex', 'login', '--device-auth']);
  });
});

describe('the sign-in page', () => {
  it('is found in what claude auth login prints, with or without a terminal’s link codes', () => {
    const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz';
    assert.equal(cli.loginPrompt(`Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `).url, url);
    assert.equal(cli.loginPrompt(`If the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`).url, url);
  });
  it('and in Codex’s device sign-in, with its code', () => {
    const found = cli.loginPrompt('Follow these steps to sign in with ChatGPT:\n1. Open this link: https://auth.openai.com/codex/device\n2. Enter this one-time code: ABCD-12345\n');
    assert.equal(found.url, 'https://auth.openai.com/codex/device');
    assert.equal(found.code, 'ABCD-12345');
  });
});

describe('what Claude Code streams', () => {
  it('is its session, words, tools with their results, and the result', () => {
    const lines = [
      line({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Writing it.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/content/p/train.py', content: 'x' } }] }, session_id: 'sess-1' }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File created' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'python train.py' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'Traceback' }], is_error: true }] } }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.0123, duration_ms: 4200, num_turns: 3, session_id: 'sess-1' }),
    ];
    const { events, session, model } = cli.parseClaude(lines);
    assert.equal(session, 'sess-1');
    assert.equal(model, 'claude-opus-5');
    assert.deepEqual(events.map((e) => e.kind), ['text', 'tool', 'output', 'tool', 'output', 'done']);
    assert.equal(events[1].path, '/content/p/train.py');
    assert.equal(events[3].detail, 'python train.py');
    assert.equal(events[4].error, true);
    assert.equal(events[4].text, 'Traceback');
    assert.deepEqual([events[5].ok, events[5].cost, events[5].turns], [true, 0.0123, 3]);
  });
  it('says when the API refuses and it tries again, and keeps stray lines', () => {
    const { events } = cli.parseClaude([line({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, error_status: 401, error: 'authentication_failed' }), 'bash: claude: command not found']);
    assert.match(events[0].text, /401 authentication failed .*2\/10.*Sign out/);
    assert.equal(events[1].kind, 'note');
  });
});

describe('what Codex streams', () => {
  it('is its thread, messages, commands with output, and file changes', () => {
    const lines = [
      line({ type: 'thread.started', thread_id: 'th-1' }),
      line({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } }),
      line({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'main.py\n', exit_code: 0 } }),
      line({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'train.py', kind: 'add' }] } }),
      line({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Added train.py.' } }),
      line({ type: 'turn.completed', usage: {} }),
    ];
    const { events, session } = cli.parseCodex(lines);
    assert.equal(session, 'th-1');
    assert.deepEqual(events.map((e) => [e.kind, e.name ?? '']), [['tool', 'Bash'], ['output', ''], ['tool', 'Write'], ['text', ''], ['done', '']]);
  });
});
