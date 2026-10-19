// What a move of a project's files is (src/lib/movePlan.ts): the new home for each place, which of the three ways
// the files go, which end goes first, when a change of machine would leave the files behind — and the lines that
// start the mover on a machine without the Companion, run here in a real Python to see the mover start on its own.
//
//   node --test scripts/move-plan.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanup, load } from './bundle.mjs';

const plan = await load('src/lib/movePlan.ts');
after(cleanup);

const project = { id: 'p1', title: 'Trying Automatic Generation of High' };
const folderName = (title, id) => `${title}-${id}`;
const drive = { kind: 'drive', folder: 'Trying Automatic Generation of High-p1' };
const laptop = { kind: 'server', serverId: 's1', root: 'playgrounds/trying-automatic-generation-of-high-p1', name: 'Laptop', deviceId: 'abcdef0123' };
const colabDisk = { kind: 'machine' };

describe('a move', () => {
  it('gives the project a folder of its own in each place', () => {
    assert.deepEqual(plan.homeFor(project, { kind: 'drive' }, folderName), drive);
    assert.deepEqual(plan.homeFor(project, { kind: 'server', serverId: 's1', name: 'Laptop', deviceId: 'abcdef0123' }, folderName), laptop);
    assert.deepEqual(plan.homeFor(project, { kind: 'machine' }, folderName), colabDisk);
  });

  it('goes the right way between every pair of places', () => {
    assert.deepEqual(plan.planOf(drive, laptop), { plan: 'drive-pull' });
    assert.deepEqual(plan.planOf(laptop, drive), { plan: 'drive-push' });
    assert.deepEqual(plan.planOf(colabDisk, laptop), { plan: 'archive' });
    assert.deepEqual(plan.planOf(laptop, { ...laptop, serverId: 's2', deviceId: 'fedcba9876' }), { plan: 'archive' });
    assert.match(plan.planOf(laptop, { ...laptop, root: 'elsewhere' }).refused, /already there/);
    assert.match(plan.planOf({ kind: 'browser' }, laptop).refused, /this browser/);
  });

  it('has the source go first, but the destination when the files come from Drive', () => {
    assert.deepEqual(plan.stepsOf('archive'), { first: 'source', firstMode: 'pack', second: 'unpack' });
    assert.deepEqual(plan.stepsOf('drive-pull'), { first: 'destination', firstMode: 'drive-pull' });
    assert.deepEqual(plan.stepsOf('drive-push'), { first: 'source', firstMode: 'drive-push' });
  });

  it('won’t change the machine away from files kept on its own disk', () => {
    const colab = { kind: 'colab', machine: { accelerator: 'T4' } };
    const server = { kind: 'server', serverId: 's1' };
    assert.match(plan.computeChangeRefused(colabDisk, colab, server), /move them/);
    assert.equal(plan.computeChangeRefused(colabDisk, colab, { kind: 'colab', machine: { accelerator: 'A100' } }), null);
    assert.equal(plan.computeChangeRefused(drive, colab, server), null);
  });

  it('says sizes and steps in words', () => {
    assert.equal(plan.sizeOf(4_200_000), '4.2 MB');
    assert.equal(plan.sizeOf(512), '512 B');
    assert.match(plan.stepWords('packing', 'archive', 'Colab', 'Laptop'), /Colab is packing/);
    assert.match(plan.stepWords('pulling', 'drive-pull', 'Google Drive', 'Laptop'), /Laptop is fetching/);
  });
});

describe('a move’s progress', () => {
  const reading = (plan, status, progress) => ({ plan, status, step: status, progress: { files: 0, bytes: 0, totalFiles: 0, totalBytes: 0, ...progress } });

  it('has no share to show until there is something to count against', () => {
    assert.equal(plan.moveShare(reading('drive-pull', 'started')), null);
    assert.equal(plan.moveShare(reading('drive-pull', 'listing', { files: 30, bytes: 900 })), null);
    assert.equal(plan.moveShare(reading('archive', 'packed', { bytes: 10, totalBytes: 10 })), null);
    assert.equal(plan.moveShare(reading('drive-pull', 'pulling', { bytes: 25, totalBytes: 100 })), 0.25);
    assert.equal(plan.moveShare(reading('drive-push', 'done')), 1);
  });

  it('gives an archive two halves: packed, then unpacked', () => {
    assert.equal(plan.moveShare(reading('archive', 'packing', { bytes: 50, totalBytes: 100 })), 0.25);
    assert.equal(plan.moveShare(reading('archive', 'unpacking', { bytes: 50, totalBytes: 100 })), 0.75);
    // Files counted when there are no bytes to count: empty files.
    assert.equal(plan.moveShare(reading('drive-push', 'pushing', { files: 1, totalFiles: 4 })), 0.25);
  });

  it('names the steps and the one it is on', () => {
    assert.deepEqual(plan.moveStages(reading('drive-pull', 'listing')), { names: ['List the files', 'Fetch and check'], at: 0 });
    assert.equal(plan.moveStages(reading('drive-pull', 'pulling')).at, 1);
    assert.equal(plan.moveStages(reading('archive', 'packed')).at, 1);
    assert.equal(plan.moveStages(reading('archive', 'done')).at, 2);
    assert.deepEqual(plan.moveStages(reading('drive-push', 'pushing')), { names: ['Send and check'], at: 0 });
  });

  it('takes the speed over the readings of one step, and says the time left', () => {
    let samples = [];
    samples = plan.keepSample(samples, { at: 0, step: 'pulling', bytes: 0 });
    assert.equal(plan.moveRate(samples), null);
    samples = plan.keepSample(samples, { at: 10_000, step: 'pulling', bytes: 10_000_000 });
    samples = plan.keepSample(samples, { at: 10_000, step: 'pulling', bytes: 10_000_000 }); // the same reading twice
    assert.equal(samples.length, 2);
    assert.equal(plan.moveRate(samples), 1_000_000);
    assert.equal(plan.timeLeft(reading('drive-pull', 'pulling', { bytes: 10_000_000, totalBytes: 190_000_000 }), 1_000_000), 'about 3 min left');
    assert.equal(plan.timeLeft(reading('drive-pull', 'pulling', { bytes: 10, totalBytes: 20 }), 1_000_000), 'less than a minute left');
    assert.equal(plan.timeLeft(reading('drive-pull', 'pulling', { bytes: 0, totalBytes: 7_200_000_000 }), 1_000_000), 'about 2 h left');
    assert.equal(plan.timeLeft(reading('drive-pull', 'pulling', { bytes: 0, totalBytes: 100 }), null), null);
    // A new step starts the readings over; old readings drop out of the window.
    assert.equal(plan.keepSample(samples, { at: 11_000, step: 'unpacking', bytes: 0 }).length, 1);
    assert.equal(plan.keepSample(samples, { at: 45_000, step: 'pulling', bytes: 40_000_000 }).length, 1);
  });

  it('says what the listing is doing', () => {
    assert.equal(plan.stepWords('listing', 'drive-pull', 'Google Drive', 'the MacBook'), 'the MacBook is listing the files in Drive');
  });
});

const python = spawnSync('python3', ['--version']).status === 0;
describe('the mover started in a kernel', { skip: !python && 'no python3' }, () => {
  it('writes the mover, starts it on its own with its config, and the config is gone once read', () => {
    const home = mkdtempSync(join(tmpdir(), 'kernel-home-'));
    const script = readFileSync('companion/reader_companion/mover.py', 'utf8');
    const code = plan.launchCode({ mode: 'remove', api: '', id: 'm1', key: '', root: 'playgrounds/gone' }, script);
    spawnSync('mkdir', ['-p', join(home, 'playgrounds', 'gone', 'x')]);
    const ran = spawnSync('python3', ['-c', code], { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /"pid": \d+/);
    assert.equal(readFileSync(join(home, '.reader-agent', 'mover.py'), 'utf8'), script);
    // The mover, on its own: it removes the folder, and its config with it.
    for (let i = 0; i < 50 && existsSync(join(home, 'playgrounds', 'gone')); i++) spawnSync('sleep', ['0.1']);
    assert.equal(existsSync(join(home, 'playgrounds', 'gone')), false);
    assert.equal(existsSync(join(home, '.reader-agent', 'move-m1-remove.json')), false);
  });
});
