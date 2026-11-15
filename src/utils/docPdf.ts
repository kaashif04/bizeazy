/**
 * docPdf.ts — the on-screen A4 document as a real PDF, the same on every device.
 *
 * Printing from a phone or tablet goes through the browser's print engine, which
 * differs per platform (iOS adds its own margins, Android shrinks to fit), and
 * "save as PDF" there is buried in the print dialog. Instead the page the user is
 * looking at is drawn to an image at true A4 width, cut into A4 pages at clean
 * break points (between table rows, never through a block marked
 * .print-keep-together) and wrapped in a PDF. On a phone or tablet the file goes
 * to the share sheet (Save to Files, WhatsApp, Mail, Print); on a desktop it
 * downloads.
 */
import { download } from './xlsx';

const A4_W = 794;                       // 210mm at 96dpi, the width .a4-page is laid out at
const A4_H = Math.floor(A4_W * 297 / 210);
const MARGIN = 38;                      // ≈10mm above and below the cut on continuation pages
// iOS Safari refuses canvases over ~16.7M pixels; long documents drop resolution instead.
const MAX_CANVAS_PX = 16_000_000;

/**
 * Where to cut a document `total` px tall into pages. `breaks` are y positions it
 * is fine to start a page at; `keeps` are [top, bottom] ranges that must not be
 * cut while they fit on one page. The first page uses its own top padding; a page
 * that continues onto another leaves MARGIN at the bottom, later pages also at the top.
 */
export function paginate(total: number, breaks: number[], keeps: [number, number][], pageH = A4_H, margin = MARGIN): [number, number][] {
  const pages: [number, number][] = [];
  const sorted = [...new Set(breaks.map(Math.round))].sort((a, b) => a - b);
  let start = 0;
  while (start < total - 1) {
    const top = pages.length ? margin : 0;
    // The last page may run to the bottom edge: the document's own padding is there.
    if (total - start <= pageH - top + 1) { pages.push([start, total]); break; }
    const room = pageH - top - margin;
    const limit = start + room;
    const ok = (y: number) => y > start + room * 0.4 && y <= limit
      && !keeps.some(([t, b]) => y > t && y < b && b - t <= room);
    const cut = [...sorted].reverse().find(ok) ?? limit;
    pages.push([start, cut]);
    start = cut;
  }
  return pages;
}

/** Break points and keep-together ranges inside an .a4-page, in unscaled px. */
function measure(page: HTMLElement) {
  const box = page.getBoundingClientRect();
  const k = box.width / A4_W || 1;      // the preview is scaled to fit the screen
  const y = (el: Element) => (el.getBoundingClientRect().top - box.top) / k;
  const breaks = Array.from(page.querySelectorAll('tbody tr:not(:first-child), .print-block, .print-keep-together'), y);
  const keeps = Array.from(page.querySelectorAll('.print-keep-together'), el => {
    const r = el.getBoundingClientRect();
    return [(r.top - box.top) / k, (r.bottom - box.top) / k] as [number, number];
  });
  return { breaks, keeps, total: page.offsetHeight };
}

export async function documentPdf(page: HTMLElement): Promise<Blob> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas-pro'), import('jspdf')]);
  await document.fonts?.ready;
  const { breaks, keeps, total } = measure(page);
  const scale = Math.max(1, Math.min(2, Math.sqrt(MAX_CANVAS_PX / (A4_W * total))));
  // Painted onto a canvas with the fonts this page already loaded, so every line
  // wraps exactly as on screen. The copy is laid out wide enough for the full A4
  // width, without the on-screen scale-to-fit or the preview's frame.
  const canvas = await html2canvas(page, {
    scale, backgroundColor: '#ffffff', useCORS: true, logging: false,
    windowWidth: Math.max(window.innerWidth, A4_W + 64),
    onclone: (_doc, el) => {
      Object.assign(el.style, { transform: 'none', margin: '0', boxShadow: 'none', border: 'none' });
    },
  });

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const mm = 210 / A4_W;
  const slice = document.createElement('canvas');
  const ctx = slice.getContext('2d')!;
  paginate(total, breaks, keeps).forEach(([top, bottom], i) => {
    const h = bottom - top;
    slice.width = Math.round(A4_W * scale);
    slice.height = Math.round(h * scale);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, 0, Math.round(top * scale), slice.width, slice.height, 0, 0, slice.width, slice.height);
    if (i) pdf.addPage();
    pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, i ? MARGIN * mm : 0, 210, h * mm, undefined, 'FAST');
  });
  return pdf.output('blob');
}

/** Phone or tablet: the share sheet. Desktop, or if sharing is refused: a download. */
export async function deliverPdf(blob: Blob, fileName: string): Promise<'shared' | 'saved' | 'cancelled'> {
  const file = new File([blob], fileName, { type: 'application/pdf' });
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName.replace(/\.pdf$/i, '') });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      // NotAllowedError (the tap went stale while the PDF was drawn): save it instead.
    }
  }
  download(fileName, blob, 'application/pdf');
  return 'saved';
}

/** "INV 26/0019 Petronas Sdn Bhd" → "INV-26-0019_Petronas-Sdn-Bhd.pdf" */
export const pdfName = (...parts: (string | undefined)[]) =>
  parts.filter(Boolean).join('_').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 120).replace(/^[-.]+|[-.]+$/g, '') + '.pdf';
