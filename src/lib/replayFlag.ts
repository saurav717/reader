/**
 * Whether the showcase (lib/showcase.ts) is replaying: the model and Colab
 * are stood in for, and the few checks that would otherwise stop at "needs a
 * key" or "needs Colab" let the replay through. A module of its own so the
 * libraries that ask (assistant, google, colab) need not import the showcase.
 */

let on = false;

export const replaying = () => on;

export function setReplaying(next: boolean): void {
  on = next;
}

/** The key and the token the replay stands in with; never sent anywhere real. */
export const SHOWCASE_KEY = 'sk-ant-showcase-replay';
export const SHOWCASE_TOKEN = 'ya29.showcase-replay';
