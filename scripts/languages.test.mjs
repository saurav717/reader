// Running a file as VS Code's ▶ does (src/lib/languages.ts): the command for
// each language with what the machine has, what to install when nothing runs
// it, quoting, Windows, and the highlighter's tokens.
//
//   node --test scripts/languages.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, load } from './bundle.mjs';

const { runPlan, languageOf, highlightCode } = await load('src/lib/languages.ts');
after(cleanup);

const mac = (tools) => ({ os: 'mac', tools: Object.fromEntries(tools.map((t) => [t, `/usr/bin/${t}`])), agents: [], vscode: false });

describe('run a file', () => {
  it('picks the command by the extension and what is installed', () => {
    assert.deepEqual(runPlan('main.py', '/Users/me/Reader/p', mac(['python'])), { command: 'cd /Users/me/Reader/p && python main.py' });
    assert.deepEqual(runPlan('src/app.ts', null, mac(['deno'])), { command: 'deno run src/app.ts' });
    assert.deepEqual(runPlan('main.go', null, mac(['go'])), { command: 'go run main.go' });
    assert.deepEqual(runPlan('a.cpp', null, mac(['clang++'])), { command: 'mkdir -p .reader/bin && clang++ -std=c++17 a.cpp -o .reader/bin/a && ./.reader/bin/a' });
    assert.deepEqual(runPlan('Hello.java', null, mac(['java'])), { command: 'java Hello.java' });
  });

  it('says what to install when nothing runs it, and nothing for a file no language runs', () => {
    assert.deepEqual(runPlan('main.rs', null, mac(['python'])), { missing: 'Rust (rustup.rs)', language: 'Rust' });
    assert.equal(runPlan('notes.txt', null, mac(['python'])), null);
  });

  it('quotes paths with spaces and quotes', () => {
    assert.deepEqual(runPlan("my dir/it's.py", "/Users/me/My Reader", mac(['python3'])), { command: `cd '/Users/me/My Reader' && python3 'my dir/it'\\''s.py'` });
    assert.deepEqual(runPlan('my prog.c', null, mac(['gcc'])), { command: "mkdir -p .reader/bin && gcc 'my prog.c' -o '.reader/bin/my prog' -lm && './.reader/bin/my prog'" });
  });

  it('writes PowerShell on Windows', () => {
    const windows = { os: 'windows', tools: { 'g++': 'g++' }, agents: [], vscode: false };
    assert.deepEqual(runPlan('src/a.cpp', 'C:\\Users\\me\\Reader\\p', windows), {
      command: 'cd "C:\\Users\\me\\Reader\\p"; New-Item -ItemType Directory -Force .reader\\bin | Out-Null; if ($?) { g++ -std=c++17 "src\\a.cpp" -o ".reader\\bin\\a.exe" }; if ($?) { & ".reader\\bin\\a.exe" }',
    });
  });

  it('knows languages by extension', () => {
    assert.equal(languageOf('x/y.MJS')?.id, 'javascript');
    assert.equal(languageOf('Makefile'), null);
  });
});

describe('highlighting', () => {
  it('marks comments, strings, keywords, numbers and calls, and escapes the rest', () => {
    const html = highlightCode('// hi <b>\nconst x = "a\\"b" + f(42); /* c */', 'a.js');
    assert.match(html, /<span class="tok-c">\/\/ hi &lt;b&gt;<\/span>/);
    assert.match(html, /<span class="tok-k">const<\/span>/);
    assert.match(html, /<span class="tok-s">"a\\"b"<\/span>/);
    assert.match(html, /<span class="tok-f">f<\/span>/);
    assert.match(html, /<span class="tok-n">42<\/span>/);
    assert.match(html, /<span class="tok-c">\/\* c \*\/<\/span>/);
    assert.equal(highlightCode('<x>', 'notes.txt'), '&lt;x&gt;');
  });
});
