// The Worker's sealing of people's secrets (worker/secrets.js): bound to one
// person and one purpose, opened by nothing else, filed under no one's name.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openSecret, sealSecret, secretsKey, secretsReady, staleUse, unusedTooLong } from '../worker/secrets.js';

const env = { SECRETS_KEY: 'x'.repeat(44) };

describe('sealed secrets', () => {
  it('opens for the same person and purpose only', async () => {
    const sealed = await sealSecret(env, 'a@b.c', 'github-token', 'ghp_secret');
    assert.ok(!sealed.includes('ghp_secret'));
    assert.equal(await openSecret(env, 'a@b.c', 'github-token', sealed), 'ghp_secret');
    assert.equal(await openSecret(env, 'x@y.z', 'github-token', sealed), null, 'another person’s record');
    assert.equal(await openSecret(env, 'a@b.c', 'overleaf-token', sealed), null, 'another kind of secret');
    assert.equal(await openSecret({ SECRETS_KEY: 'y'.repeat(44) }, 'a@b.c', 'github-token', sealed), null, 'another key');
  });

  it('seals the same value differently each time', async () => {
    assert.notEqual(await sealSecret(env, 'a@b.c', 'p', 'v'), await sealSecret(env, 'a@b.c', 'p', 'v'));
  });

  it('refuses to seal without a key long enough to be one', async () => {
    assert.equal(secretsReady({}), false);
    assert.equal(secretsReady({ SECRETS_KEY: 'short' }), false);
    await assert.rejects(sealSecret({ SECRETS_KEY: 'short' }, 'a@b.c', 'p', 'v'), /SECRETS_KEY/);
  });

  it('files records under a keyed hash, never the email', async () => {
    const key = await secretsKey(env, 'github', 'A@B.c');
    assert.match(key, /^github:[0-9a-f]{64}$/);
    assert.ok(!key.includes('a@b.c'));
    assert.equal(key, await secretsKey(env, 'github', 'a@b.c'), 'case of the email does not matter');
    assert.notEqual(key, await secretsKey({ SECRETS_KEY: 'y'.repeat(44) }, 'github', 'a@b.c'), 'not guessable without the key');
  });

  it('tells a secret unused for half a year, and a use worth writing', () => {
    const now = Date.parse('2026-10-12T00:00:00Z');
    assert.equal(unusedTooLong('2026-01-01T00:00:00Z', now), true);
    assert.equal(unusedTooLong('2026-09-01T00:00:00Z', now), false);
    assert.equal(staleUse('2026-10-11T23:00:00Z', now), false);
    assert.equal(staleUse('2026-10-10T00:00:00Z', now), true);
  });
});
