/**
 * A pointer of the showcase's own (components/Showcase.tsx): an arrow that
 * glides to a control, presses it, types into a box, or shows a key being
 * pressed — the app's real controls, really clicked, with a cursor the
 * viewer can follow. Every wait can be cut short: the run it belongs to is
 * told to stop, and the next wait throws Stopped.
 */

export class Stopped extends Error {
  constructor() {
    super('stopped');
  }
}

/** One run of the showcase, or one of its scenes: a flag the waits check. */
export class Run {
  stopped = false;
  stop() {
    this.stopped = true;
  }
  check() {
    if (this.stopped) throw new Stopped();
  }
}

const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

const centre = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2 };
};

/** Sets a React-controlled input's value so React sees the change. */
function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

export class Cursor {
  private readonly element: HTMLDivElement;
  private readonly key: HTMLDivElement;
  private x = window.innerWidth / 2;
  private y = window.innerHeight / 2;
  private keyTimer = 0;

  constructor(private readonly run: Run) {
    this.element = document.createElement('div');
    this.element.className = 'sc-cursor';
    this.element.innerHTML =
      '<span class="sc-ring"></span><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 3l14 8.5-6.2 1.6L16 20l-2.4 1.1-3.2-6.9L5 18.5z" fill="#fff" stroke="#1a1a17" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    this.element.style.left = `${this.x}px`;
    this.element.style.top = `${this.y}px`;
    this.key = document.createElement('div');
    this.key.className = 'sc-key';
    document.body.append(this.element, this.key);
  }

  destroy() {
    window.clearTimeout(this.keyTimer);
    this.element.remove();
    this.key.remove();
  }

  /** A pause the run can cut short. */
  sleep(ms: number): Promise<void> {
    this.run.check();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (this.run.stopped) return reject(new Stopped());
        if (Date.now() - started >= ms) return resolve();
        window.setTimeout(tick, Math.min(80, ms));
      };
      tick();
    });
  }

  /** The first element the selector (or the finder) matches, once it is on the page — or null when the time runs out. */
  async waitFor<T extends Element = HTMLElement>(find: string | (() => T | null | undefined), timeoutMs = 15_000): Promise<T | null> {
    const started = Date.now();
    for (;;) {
      this.run.check();
      const found = typeof find === 'string' ? (document.querySelector(find) as T | null) : find();
      if (found) return found;
      if (Date.now() - started > timeoutMs) return null;
      await this.sleep(100);
    }
  }

  async moveTo(target: Element | { x: number; y: number }, ms = 560): Promise<void> {
    const to = target instanceof Element ? centre(target) : target;
    if (target instanceof Element) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const dx = to.x - this.x;
    const dy = to.y - this.y;
    const far = Math.hypot(dx, dy);
    const time = Math.max(220, Math.min(ms, far * 1.2));
    this.element.style.transition = `left ${time}ms ${EASE}, top ${time}ms ${EASE}`;
    this.element.style.left = `${to.x}px`;
    this.element.style.top = `${to.y}px`;
    this.x = to.x;
    this.y = to.y;
    await this.sleep(time + 60);
  }

  /** Glides to the control and presses it: the ring pulses, and the element gets a real click. */
  async click(target: Element, settleMs = 420): Promise<void> {
    await this.moveTo(target);
    this.element.classList.add('is-down');
    await this.sleep(140);
    this.element.classList.remove('is-down');
    if (target instanceof HTMLElement) target.click();
    else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await this.sleep(settleMs);
  }

  /** Clicks into a box and types into it, a character at a time. */
  async type(box: HTMLInputElement | HTMLTextAreaElement, text: string, perCharMs = 34): Promise<void> {
    await this.click(box, 120);
    box.focus();
    setNativeValue(box, '');
    for (let i = 1; i <= text.length; i++) {
      setNativeValue(box, text.slice(0, i));
      await this.sleep(perCharMs + (text[i - 1] === ' ' ? 40 : 0));
    }
    await this.sleep(360);
  }

  /** Shows a key being pressed, and presses it: a keydown the app's shortcuts hear. */
  async press(key: string, options: { ctrl?: boolean; shift?: boolean; code?: string; on?: Element } = {}, settleMs = 700): Promise<void> {
    const label = `${options.ctrl ? (/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ ' : 'Ctrl ') : ''}${options.shift ? '⇧ ' : ''}${key.length === 1 ? key.toUpperCase() : key}`;
    this.key.textContent = label;
    this.key.style.left = `${this.x + 18}px`;
    this.key.style.top = `${this.y + 22}px`;
    this.key.classList.add('is-shown');
    window.clearTimeout(this.keyTimer);
    this.keyTimer = window.setTimeout(() => this.key.classList.remove('is-shown'), 1100);
    await this.sleep(180);
    const target = options.on ?? document.body;
    const init: KeyboardEventInit = { key, code: options.code, bubbles: true, cancelable: true, ctrlKey: Boolean(options.ctrl), metaKey: false, shiftKey: Boolean(options.shift) };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    await this.sleep(settleMs);
  }
}
