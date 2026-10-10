// The playground's agent, without a browser: how its answers are read — files
// written, files to read first, commands — how much a write changed, and how
// the project is put to it.
//
//   node --test scripts/project-agent.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const agent = await load('src/lib/projectAgent.ts', { external: ['react', '@anthropic-ai/sdk'], imports: true });

after(cleanup);

describe('an answer', () => {
  it('reads files, commands and prose apart', () => {
    const reply = agent.parseAgentReply('I added a loop.\n\n```python file=train.py\nprint(1)\n```\n\n```sh run\n$ python train.py\n```\nDone.');
    assert.equal(reply.note, 'I added a loop.\n\nDone.');
    assert.deepEqual(reply.blocks, [
      { kind: 'file', path: 'train.py', lang: 'python', text: 'print(1)\n' },
      { kind: 'run', command: 'python train.py' },
    ]);
  });
  it('takes a list of files to read, and knows when that is all it says', () => {
    const reply = agent.parseAgentReply('```read\nmodel.py\n./data/prep.py\n```');
    assert.deepEqual(reply.blocks, [{ kind: 'read', paths: ['model.py', 'data/prep.py'] }]);
    assert.equal(agent.onlyReads(reply), true);
  });
  it('keeps a fence that is none of the three as prose, and the later of two writes to one path', () => {
    const reply = agent.parseAgentReply('Like this:\n```python\nx = 1\n```\n```text file=a.txt\none\n```\n```text file=a.txt\ntwo\n```');
    assert.match(reply.note, /x = 1/);
    assert.deepEqual(reply.blocks, [{ kind: 'file', path: 'a.txt', lang: 'text', text: 'two\n' }]);
  });
  it('never writes outside the folder', () => {
    assert.equal(agent.cleanPath('../secrets'), null);
    assert.equal(agent.cleanPath('/etc/passwd'), 'etc/passwd');
    assert.equal(agent.cleanPath('a//b'), null);
    assert.deepEqual(agent.parseAgentReply('```python file=../x.py\n1\n```').blocks, []);
  });
});

describe('a change', () => {
  it('counts lines added and removed', () => {
    assert.deepEqual(agent.lineDelta(null, 'a\nb\n'), { added: 3, removed: 0 });
    assert.deepEqual(agent.lineDelta('a\nb\nc', 'a\nB\nc'), { added: 1, removed: 1 });
    assert.deepEqual(agent.lineDelta('a\nb', 'a\nb'), { added: 0, removed: 0 });
  });
});

describe('the project, as the agent reads it', () => {
  it('lists the files, the open ones with the one in front marked, and the console', () => {
    const text = agent.projectBlock({
      where: 'Files kept in Google Drive; code runs on Colab.',
      listing: [{ path: 'main.py', size: 12 }],
      open: [{ path: 'main.py', text: 'print(1)', active: true, unsaved: false }],
      console: [{ command: 'python main.py', output: '1\n', state: 'ran' }],
    });
    assert.match(text, /<files>\nmain\.py \(12 B\)/);
    assert.match(text, /<file path="main\.py" in_front="yes">/);
    assert.match(text, /\$ python main\.py\n1/);
  });
  it('puts the paper first when the project cites one', () => {
    const text = agent.projectBlock({ where: 'Colab.', listing: [], open: [], console: [], paper: { title: 'LoRA', authors: ['Edward Hu'], published: '2021-06-17', abstract: 'Low-rank  adapters.' } });
    assert.match(text, /^<paper>\nLoRA by Edward Hu \(2021\)\n\nAbstract: Low-rank adapters\.\n<\/paper>/);
  });
  it('walks a host for every file, leaving caches out', async () => {
    const tree = { '': [['src', 'directory'], ['main.py', 'file'], ['__pycache__', 'directory']], src: [['a.py', 'file']], __pycache__: [['x.pyc', 'file']] };
    const host = { label: 't', list: async (path = '') => (tree[path] ?? []).map(([name, type]) => ({ name, path: path ? `${path}/${name}` : name, type, size: type === 'file' ? 1 : null, modified: null })), read: async () => '', write: async () => {} };
    assert.deepEqual((await agent.listAll(host)).map((f) => f.path), ['src/a.py', 'main.py']);
  });
});

describe('the conversations, kept in the project folder', () => {
  const change = (path) => ({ path, before: 'a', after: 'b', added: 1, removed: 1 });
  const answer = (at, changes) => ({ role: 'agent', text: 'done', at, changes });
  it('keeps the files’ text only for the newest answers, so the file stays small', () => {
    const turns = Array.from({ length: 9 }, (_, i) => answer(i + 1, [change(`f${i}.py`)]));
    const slim = agent.slimChat({ id: 'c', title: 't', started: 0, updated: 9, turns });
    assert.equal(slim.turns.filter(agent.canUndo).length, 6);
    assert.equal(agent.canUndo(slim.turns[0]), false);
    assert.deepEqual(slim.turns[0].changes[0], { path: 'f0.py', added: 1, removed: 1 });
    assert.equal(agent.canUndo(slim.turns[8]), true);
  });
  it('merges two browsers’ copies by chat, the later change winning, newest first', () => {
    const a = [{ id: 'x', title: 'x', started: 1, updated: 5, turns: [{ role: 'user', text: 'old', at: 5 }] }];
    const b = [
      { id: 'x', title: 'x', started: 1, updated: 9, turns: [{ role: 'user', text: 'new', at: 9 }] },
      { id: 'y', title: 'y', started: 2, updated: 7, turns: [{ role: 'user', text: 'y', at: 7 }] },
      { id: 'z', title: 'z', started: 3, updated: 8, turns: [] },
    ];
    const merged = agent.mergeChats(a, b);
    assert.deepEqual(merged.map((chat) => chat.id), ['x', 'y']);
    assert.equal(merged[0].turns[0].text, 'new');
  });
  it('reads back its own file, and nothing from a broken one', () => {
    const chats = [{ id: 'x', title: 'x', started: 1, updated: 2, turns: [{ role: 'user', text: 'hi', at: 2 }] }];
    assert.deepEqual(agent.parseAgentFile(JSON.stringify({ generator: 'reader', version: 1, chats })), chats);
    assert.deepEqual(agent.parseAgentFile('{oops'), []);
    assert.deepEqual(agent.parseAgentFile(null), []);
  });
  it('saves to the folder and opens again from it, in a new tab', async () => {
    const files = new Map();
    const host = { label: 'drive', list: async () => [], read: async (path) => files.get(path) ?? null, write: async (path, text) => void files.set(path, text) };
    globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
    agent.clearAgentChat('p1', host);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(files.has(agent.AGENT_FILE), true);
    // the file written by another browser: one conversation
    files.set(agent.AGENT_FILE, JSON.stringify({ generator: 'reader', version: 1, chats: [{ id: 'k', title: 'Write train.py', started: 1, updated: 2, turns: [{ role: 'user', text: 'Write train.py', at: 2 }] }] }));
    await agent.loadAgentChats('p2', host);
    assert.equal(agent.agentChatFor('p2').turns[0].text, 'Write train.py');
    assert.equal(agent.agentChatFor('p2').loaded, true);
  });
});
