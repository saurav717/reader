/**
 * The light the glass catches. Real glass brightens where light falls on it;
 * here the light is the pointer, and every pane's sheen is a gradient centred
 * on it. The gradients are fixed to the viewport, so one pair of coordinates
 * on the root serves every pane — nothing is measured, and nothing behind the
 * glass is redrawn, only the sheen on top of it.
 *
 * Returns the function that takes the listener off again. A touch screen has
 * no pointer resting anywhere, so there it does nothing and the sheen stays
 * where the stylesheet puts it: the top of the window.
 */
export function followLight(): () => void {
  if (!window.matchMedia('(hover: hover)').matches) return () => {};
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const root = document.documentElement;
  let frame = 0;
  let x = 0;
  let y = 0;
  const paint = () => {
    frame = 0;
    root.style.setProperty('--light-x', `${x}px`);
    root.style.setProperty('--light-y', `${y}px`);
  };
  const move = (event: PointerEvent) => {
    x = event.clientX;
    y = event.clientY;
    if (!frame) frame = requestAnimationFrame(paint);
  };
  window.addEventListener('pointermove', move, { passive: true });
  return () => {
    window.removeEventListener('pointermove', move);
    if (frame) cancelAnimationFrame(frame);
    root.style.removeProperty('--light-x');
    root.style.removeProperty('--light-y');
  };
}
