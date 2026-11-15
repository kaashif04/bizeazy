/**
 * Cutting a document into A4 pages: `npx tsx src/utils/docPdf.selfcheck.ts`
 */
import { paginate, pdfName } from './docPdf';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };
const H = 1000, M = 50;

ok(JSON.stringify(paginate(1000, [], [], H, M)) === '[[0,1000]]', 'a one-page document is one page');
// Rows every 40px: the cut lands on the last row start that fits (≤ 950), not mid-row.
const rows = Array.from({ length: 60 }, (_, i) => 100 + i * 40);
const p = paginate(2500, rows, [], H, M);
ok(p[0][0] === 0 && p[0][1] === 940, `first cut at the last row that fits, got ${p[0][1]}`);
ok(p.every(([, b], i) => i === p.length - 1 || rows.includes(b)), 'every cut is between rows');
ok(p.every(([t, b], i) => b - t <= H - M - (i ? M : 0)), 'no page overflows its room');
ok(p[p.length - 1][1] === 2500 && p.every(([, b], i) => i === p.length - 1 || b === p[i + 1][0]), 'pages cover the document without gaps');
// A totals box at 900–1100 must not be cut: page 1 ends before it.
const k = paginate(1500, [300, 600, 900, 1100], [[900, 1100]], H, M);
ok(k[0][1] === 900, `keep-together block moves whole, got cut at ${k[0][1]}`);
// No usable break at all: hard cut at the page limit rather than an endless loop.
ok(JSON.stringify(paginate(2000, [], [], H, M)) === '[[0,950],[950,1850],[1850,2000]]', 'falls back to a hard cut');
ok(pdfName('INV 26/0019', 'Petronas Sdn. Bhd.') === 'INV-26-0019_Petronas-Sdn.-Bhd.pdf', 'safe file name');
console.log('docPdf self-check passed');
