/**
 * a4scale.ts — WYSIWYG A4 preview scaling.
 *
 * Used as a React ref callback on the scroll "stage" that wraps an A4 page.
 * The page is rendered at true A4 width (794px = 210mm @ 96dpi); this scales it
 * down to fit the stage so mobile shows a real, proportional page instead of a
 * squished/reflowed one. A `.a4-spacer` wrapper reserves the scaled footprint
 * (CSS transforms don't affect layout size). Print CSS resets both so the
 * exported PDF is still full A4.
 *
 * Expected DOM: stage > .a4-spacer > .a4-page
 * React 19 calls the returned cleanup on unmount.
 */
const A4_WIDTH = 794;

export function attachA4Scale(stage: HTMLElement | null): (() => void) | void {
  if (!stage) return;

  const apply = () => {
    if (window.matchMedia('print').matches) return;
    const page = stage.querySelector('.a4-page') as HTMLElement | null;
    const spacer = stage.querySelector('.a4-spacer') as HTMLElement | null;
    if (!page || !spacer) return;
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
    const avail = stage.clientWidth - padX;
    const scale = Math.min(1, avail / A4_WIDTH);
    page.style.transformOrigin = 'top left';
    page.style.transform = `scale(${scale})`;
    spacer.style.width = `${A4_WIDTH * scale}px`;
    spacer.style.height = `${page.offsetHeight * scale}px`;
  };

  requestAnimationFrame(apply);
  const ro = new ResizeObserver(apply);
  ro.observe(stage);
  const mo = new MutationObserver(() => requestAnimationFrame(apply));
  mo.observe(stage, { childList: true, subtree: true, characterData: true });
  return () => { ro.disconnect(); mo.disconnect(); };
}
