// The coding agents' command lines (src/lib/agents.ts): the options a person
// picks in the agent pane — model, permissions, carrying on — as flags.
//
//   node --test scripts/agents.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, load } from './bundle.mjs';

const { AGENTS, agentCommand, shellWord } = await load('src/lib/agents.ts');
after(cleanup);
const spec = (id) => AGENTS.find((agent) => agent.id === id);

describe('agent command lines', () => {
  it('is just the command with nothing picked', () => {
    assert.equal(agentCommand(spec('claude')), 'claude');
    assert.equal(agentCommand(spec('goose')), 'goose session');
  });
  it('writes the model, the permissions and carrying on as Claude Code’s flags', () => {
    assert.equal(agentCommand(spec('claude'), { model: 'opus', choices: { permission: 'plan' }, resume: true }), 'claude --model opus --permission-mode plan --continue');
  });
  it('writes Codex’s approvals, sandbox and reasoning, and resumes with its own command', () => {
    assert.equal(agentCommand(spec('codex'), { choices: { approval: 'never', sandbox: 'workspace-write', effort: 'high' } }), 'codex --ask-for-approval never --sandbox workspace-write -c model_reasoning_effort=high');
    assert.equal(agentCommand(spec('codex'), { resume: true, model: 'o4' }), 'codex resume --last --model o4');
  });
  it('adds toggles and extra flags, and leaves out what the agent does not take', () => {
    assert.equal(agentCommand(spec('aider'), { toggles: { yes: true }, extra: '--no-auto-commits' }), 'aider --yes-always --no-auto-commits');
    assert.equal(agentCommand(spec('amp'), { model: 'x', resume: true }), 'amp');
    assert.equal(agentCommand(spec('gemini'), { choices: { approval: 'not-a-mode' } }), 'gemini');
  });
  it('quotes a model name a shell would split', () => {
    assert.equal(shellWord('anthropic/claude-sonnet-5-5'), 'anthropic/claude-sonnet-5-5');
    assert.equal(shellWord("it's mine"), `'it'\\''s mine'`);
    assert.equal(agentCommand(spec('opencode'), { model: 'my model' }), "opencode --model 'my model'");
  });
  it('names every agent the Companion looks for, each with an installer', () => {
    assert.deepEqual(AGENTS.map((agent) => agent.id), ['claude', 'codex', 'gemini', 'copilot', 'cursor-agent', 'aider', 'opencode', 'goose', 'amp', 'qwen']);
    for (const agent of AGENTS) assert.ok(agent.install, agent.id);
  });
});
