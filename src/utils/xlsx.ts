/**
 * xlsx.ts — a minimal .xlsx writer: one worksheet per table, plain values.
 *
 * An .xlsx file is a zip of a few XML parts; this writes exactly those, using
 * fflate (already shipped for PDF export) to zip. Opens in Excel, Google Sheets
 * and Numbers. No styling, formulas or dates-as-dates — it is a data export.
 */
import { zipSync, strToU8 } from 'fflate';

export interface SheetData { name: string; rows: Record<string, unknown>[] }

const CELL_LIMIT = 32767;   // Excel's maximum characters in one cell

// XML 1.0 allows only these characters; anything else makes the file unreadable.
const xmlSafe = (text: string) => text
  .replace(/[^\x09\x0A\x0D\x20-퟿-�]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const column = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function cell(ref: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlSafe(text.slice(0, CELL_LIMIT))}</t></is></c>`;
}

function worksheet(rows: Record<string, unknown>[]): string {
  const headers: string[] = [];
  rows.forEach(r => Object.keys(r).forEach(k => { if (!headers.includes(k)) headers.push(k); }));
  const lines = [headers, ...rows.map(r => headers.map(h => r[h]))].map((values, y) =>
    `<row r="${y + 1}">${values.map((v, x) => cell(column(x) + (y + 1), v)).join('')}</row>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${headers.length ? lines.join('') : ''}</sheetData></worksheet>`;
}

/** Sheet names: at most 31 characters, none of []:*?/\, unique. */
function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map(raw => {
    const base = raw.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 28)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function buildXlsx(sheets: SheetData[]): Uint8Array {
  const names = sheetNames(sheets.map(s => s.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + `</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
      + names.map((n, i) => `<sheet name="${xmlSafe(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + `</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `</Relationships>`),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(worksheet(s.rows)); });
  return zipSync(files, { level: 6 });
}

/** Hand the browser a file to save. */
export function download(name: string, data: Uint8Array | string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
