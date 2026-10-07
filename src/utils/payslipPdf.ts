/**
 * payslipPdf.ts — the payslip as an A4 PDF, published for the Staff app.
 *
 * When a payslip is saved (and again when it is marked paid) the Hub renders
 * it here and uploads it to Storage at payslips/{company}/{employee}/{id}.pdf.
 * The Staff app only ever opens this file, so staff see exactly what payroll
 * issued. The layout follows the on-screen payslip in PayrollDashboard; the
 * figures come straight from the saved record, never recomputed.
 */
import type { Payslip, Employee, CompanyProfile, DatabaseState } from '../types';
import { activeOutlet } from './outlets';
import { deductionLabels } from './payroll';
import { normaliseMonthLabel } from './notifications';
import { supabase } from '../supabase';

export const payslipPath = (companyId: string, employeeId: string, payslipId: string) =>
  `${companyId}/${employeeId}/${payslipId}.pdf`;

const rm = (n: number) => `RM ${(Number(n) || 0).toFixed(2)}`;

/** Allowance or deduction lines saved as JSON; the advance bookkeeping rows are not printed. */
function lines(json: string | undefined, fallbackLabel: string, fallbackAmount: number): [string, number][] {
  let list: any[] = [];
  try { list = json ? JSON.parse(json) : []; } catch { list = []; }
  list = list.filter(i => !('_bm_paid' in i) && (i.description?.trim() || i.amount > 0));
  if (list.length) return list.map(i => [String(i.description || fallbackLabel), Number(i.amount) || 0]);
  return fallbackAmount > 0 ? [[fallbackLabel, fallbackAmount]] : [];
}

const dateLabel = (raw?: string) => {
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toLocaleDateString('en-MY', { day: '2-digit', month: 'long', year: 'numeric' });
  }
  return raw || '-';
};

export async function payslipPdf(ps: Payslip, emp: Employee | undefined, letterhead: CompanyProfile | undefined, byBranch: boolean): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const L = 16, R = 194, W = R - L;
  const ink: [number, number, number] = [17, 24, 39];
  const muted: [number, number, number] = [107, 114, 128];
  const text = (s: string, x: number, y: number, o: { size?: number; bold?: boolean; color?: [number, number, number]; align?: 'left' | 'right' | 'center'; maxWidth?: number } = {}) => {
    doc.setFont('helvetica', o.bold ? 'bold' : 'normal');
    doc.setFontSize(o.size ?? 9);
    doc.setTextColor(...(o.color ?? ink));
    doc.text(s, x, y, { align: o.align ?? 'left', maxWidth: o.maxWidth });
  };

  // Letterhead
  let y = 20;
  text((letterhead?.company_name || letterhead?.name || '').toUpperCase(), L, y, { size: 14, bold: true });
  if (byBranch && letterhead) { y += 5; text((letterhead.store_name || letterhead.name || '').toUpperCase(), L, y, { size: 7, bold: true, color: muted }); }
  const addr = doc.splitTextToSize(letterhead?.address || '', 105);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...muted);
  doc.text(addr, L, y + 5);
  y += 5 + addr.length * 3.6;
  text(`Phone: ${letterhead?.phone || '-'} | Email: ${letterhead?.email || '-'}`, L, y, { size: 8, color: muted });

  doc.setFillColor(20, 83, 45);
  doc.roundedRect(R - 38, 14, 38, 7, 1.5, 1.5, 'F');
  text('PAYSLIP RECORD', R - 19, 18.8, { size: 7.5, bold: true, color: [255, 255, 255], align: 'center' });
  text(`ID: ${ps.Payslip_ID}`, R, 27, { size: 8, bold: true, align: 'right' });
  text(`Issue Date: ${dateLabel(ps.Issue_Date)}`, R, 31.5, { size: 8, color: muted, align: 'right' });

  y = Math.max(y, 32) + 5;
  doc.setDrawColor(17, 24, 39); doc.setLineWidth(0.4); doc.line(L, y, R, y);

  // Who and when
  y += 8;
  const C2 = L + W / 2 + 4;
  text('EMPLOYEE DETAILS', L, y, { size: 7, bold: true, color: muted });
  text('PAYMENT DETAILS', C2, y, { size: 7, bold: true, color: muted });
  y += 5;
  text(emp?.Employee_Name || ps.Employee_ID, L, y, { size: 10, bold: true });
  text(`Month / Year: ${normaliseMonthLabel(ps.Month_Year)}`, C2, y, { size: 8.5 });
  const left = [
    `IC Number/Passport: ${emp?.IC_Passport || '-'}`,
    `Position: ${emp?.Position || '-'}`,
    `Outlet: ${emp?.Branch_Location || ps.Branch_Location || '-'}`,
  ];
  const right = [
    `Bank Account Details: ${emp?.Bank_Details || '-'}`,
    ps.Transfer_Date ? `Wage Transfer Date: ${ps.Transfer_Date}` : 'Transfer Date: ____________________',
  ];
  left.forEach((s, i) => text(s, L, y + 4.5 * (i + 1), { size: 8.5 }));
  right.forEach((s, i) => text(s, C2, y + 4.5 * (i + 1), { size: 8.5, bold: i === 1 && !!ps.Transfer_Date }));
  y += 4.5 * 3 + 9;

  // Earnings and deductions, side by side
  const colW = W / 2 - 4;
  const column = (x: number, title: string, color: [number, number, number], rows: [string, number][], totalLabel: string, total: number, fill: [number, number, number]) => {
    let cy = y;
    text(title, x, cy, { size: 8, bold: true, color });
    text('AMOUNT', x + colW, cy, { size: 8, bold: true, color, align: 'right' });
    cy += 2; doc.setDrawColor(...color); doc.setLineWidth(0.3); doc.line(x, cy, x + colW, cy);
    cy += 5;
    for (const [label, amount] of rows) {
      const wrapped = doc.splitTextToSize(label, colW - 26);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...ink);
      doc.text(wrapped, x, cy);
      text(rm(amount), x + colW, cy, { size: 8.5, bold: true, align: 'right' });
      cy += 4.5 * wrapped.length + 0.5;
    }
    cy += 1;
    doc.setFillColor(...fill); doc.roundedRect(x, cy, colW, 7.5, 1.5, 1.5, 'F');
    text(totalLabel, x + 2.5, cy + 5, { size: 8.5, bold: true, color });
    text(rm(total), x + colW - 2.5, cy + 5, { size: 8.5, bold: true, color, align: 'right' });
    return cy + 7.5;
  };
  const labels = emp ? deductionLabels(emp) : { epf: '', socso: '', eis: '' };
  const tag = (s: string) => (s ? ` (${s})` : '');
  const earnings: [string, number][] = [
    [`Basic Pay${ps.Pay_Period ? ` · ${ps.Pay_Period}` : ''}`, ps.Basic_Pay],
    ...lines(ps.Allowances_JSON, 'Custom Allowances', ps.Custom_Allowances),
  ];
  const deductions: [string, number][] = [
    [`Employee EPF${tag(labels.epf)}`, ps.Employee_EPF],
    [`Employee SOCSO${tag(labels.socso)}`, ps.Employee_SOCSO],
    ...((ps.Employee_SKBBK ?? 0) > 0 ? [['SKBBK / Lindung 24 Jam (0.75%)', ps.Employee_SKBBK] as [string, number]] : []),
    [`Employee EIS / SIP${tag(labels.eis)}`, ps.Employee_EIS],
    ...lines(ps.Deductions_JSON, 'Custom Deductions', ps.Custom_Deductions),
  ];
  const endL = column(L, 'EARNINGS ITEMIZED', [6, 95, 70], earnings, 'Total Earnings / Gross Pay',
    ps.Basic_Pay + ps.Custom_Allowances, [236, 253, 245]);
  const endR = column(C2 - 4 + 4, 'DEDUCTIONS ITEMIZED', [159, 18, 57], deductions, 'Total Sum of Deductions',
    ps.Total_Statutory_Deductions + ps.Custom_Deductions, [255, 241, 242]);
  y = Math.max(endL, endR) + 8;

  if (ps.Employer_Statutory_Offset > 0) {
    doc.setFillColor(239, 246, 255); doc.roundedRect(L, y, W, 9, 1.5, 1.5, 'F');
    text('Employer-Borne Statutory Contribution (EPF + SOCSO + EIS)', L + 3, y + 5.8, { size: 8.5, bold: true, color: [29, 78, 216] });
    text(rm(ps.Employer_Statutory_Offset), R - 3, y + 5.8, { size: 8.5, bold: true, color: [29, 78, 216], align: 'right' });
    y += 13;
  }

  // Net pay
  doc.setFillColor(240, 253, 244); doc.setDrawColor(16, 185, 129); doc.setLineWidth(0.6);
  doc.roundedRect(L, y, W, 16, 2.5, 2.5, 'FD');
  text('EMPLOYEE FINAL NET PAY', L + 4, y + 6.5, { size: 7.5, bold: true, color: [5, 150, 105] });
  text('Total Net RM transferred directly via Bank Accounts.', L + 4, y + 11, { size: 7.5, color: muted });
  text(rm(ps.Final_Net_Pay), R - 4, y + 10.5, { size: 16, bold: true, color: [5, 150, 105], align: 'right' });
  y += 22;

  // Employer contributions
  doc.setDrawColor(209, 213, 219); doc.setLineWidth(0.2); doc.setLineDashPattern([1, 1], 0);
  doc.roundedRect(L, y, W, 14, 1.5, 1.5, 'S');
  doc.setLineDashPattern([], 0);
  text('EMPLOYER STATUTORY AUDITS (EMPLOYER CONTRIBUTIONS IN RM)', L + 3, y + 5, { size: 7, bold: true, color: [55, 65, 81] });
  [['Employer EPF', ps.Employer_EPF], ['Employer SOCSO', ps.Employer_SOCSO], ['Employer EIS (SIP)', ps.Employer_EIS]]
    .forEach(([label, amount], i) => text(`${label}: ${rm(amount as number)}`, L + 3 + i * (W / 3), y + 10.5, { size: 7.5, color: muted }));
  y += 30;

  // Signature
  const sx = R - 64;
  doc.setDrawColor(209, 213, 219); doc.line(sx, y, R, y);
  text('Received By: Employee Signature', sx + 32, y + 5, { size: 7.5, bold: true, color: [55, 65, 81], align: 'center' });
  doc.line(sx, y + 11, R, y + 11);
  text('Date', sx + 32, y + 15.5, { size: 7.5, color: muted, align: 'center' });

  return doc.output('blob');
}

/** Render and upload, replacing any earlier copy. Saved payslips only. */
export async function publishPayslipPdf(companyId: string, ps: Payslip, emp: Employee | undefined, letterhead: CompanyProfile | undefined, byBranch: boolean): Promise<void> {
  if (!ps.Is_Saved) return;
  const blob = await payslipPdf(ps, emp, letterhead, byBranch);
  const { error } = await supabase.storage.from('payslips')
    .upload(payslipPath(companyId, ps.Employee_ID, ps.Payslip_ID), blob, { upsert: true, contentType: 'application/pdf' });
  if (error) throw new Error(/bucket not found|not found/i.test(error.message)
    ? 'Payslip storage is not set up yet (run the staff & attendance SQL in Supabase).'
    : error.message);
}

/** The letterhead a payslip prints under: the branch it was filed at, else its employee's. */
export const letterheadFor = (profiles: CompanyProfile[], ps: Payslip, emp?: Employee) =>
  activeOutlet(profiles, ps.Branch_Location || emp?.Branch_Location || '') || profiles[0];

/** Publish every saved payslip, for ones saved before PDFs existed. Returns how many failed. */
export async function publishAllPayslips(companyId: string, db: DatabaseState, profiles: CompanyProfile[],
  byBranch: boolean, onProgress: (done: number, total: number) => void): Promise<number> {
  const saved = db.payslips.filter(p => p.Is_Saved);
  let failed = 0;
  for (const [i, ps] of saved.entries()) {
    const emp = db.employees.find(e => e.Employee_ID === ps.Employee_ID);
    try { await publishPayslipPdf(companyId, ps, emp, letterheadFor(profiles, ps, emp), byBranch); }
    catch { failed++; }
    onProgress(i + 1, saved.length);
  }
  return failed;
}
