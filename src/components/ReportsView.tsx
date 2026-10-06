/**
 * ReportsView.tsx — sales, unpaid invoices and payroll cost, per branch.
 * The figures come from utils/reports.ts; this only lays them out. Each section
 * shows only to people whose modules cover it.
 */
import React, { useMemo, useState } from 'react';
import { Download, BarChart3, Clock, Wallet } from 'lucide-react';
import { DatabaseState, CompanyProfile } from '../types';
import { outletLabel } from '../utils/outlets';
import {
  lastMonths, monthTitle, salesByBranch, receivablesAging, payrollCost, AGE_BUCKETS,
} from '../utils/reports';
import { buildXlsx, download, XLSX_TYPE } from '../utils/xlsx';
import { EmptyState } from './ui/States';

const fmt = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** In a month-by-month table a quiet month is a dash, so the busy ones stand out. */
const cellFmt = (n: number) => (Math.abs(n) < 0.005 ? '–' : fmt(n));
const NARROW_HIDE = 'hidden sm:table-cell';

const TH = 'px-3 py-2.5 text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300 whitespace-nowrap';
const TD = 'px-3 py-2.5 text-xs tabular-nums whitespace-nowrap';

function Section({ icon, title, note, onDownload, children }: {
  icon: React.ReactNode; title: string; note: string; onDownload?: () => void; children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink-200 dark:border-ink-800 bg-white dark:bg-ink-900 overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-4 py-3.5 border-b border-ink-100 dark:border-ink-800">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-bold text-ink-900 dark:text-white [&_svg]:w-4 [&_svg]:h-4 [&_svg]:text-brand-600 dark:[&_svg]:text-brand-400">
            {icon}{title}
          </h3>
          <p className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5">{note}</p>
        </div>
        {onDownload && (
          <button type="button" onClick={onDownload} aria-label={`Download ${title} as Excel`}
            className="tap shrink-0 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg border border-ink-200 dark:border-ink-700 text-2xs font-bold text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800 cursor-pointer">
            <Download className="w-3.5 h-3.5" /><span className="hidden sm:inline">Excel</span>
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

export function ReportsView({
  db, profiles, canSales, canPayroll,
}: {
  db: DatabaseState;
  profiles: CompanyProfile[];
  canSales: boolean;
  canPayroll: boolean;
}) {
  const [branch, setBranch] = useState('');   // '' = all branches
  const currency = profiles[0]?.currency_symbol || 'RM';
  const today = useMemo(() => new Date(), []);
  const months = useMemo(() => lastMonths(today, 12), [today]);
  const newestFirst = useMemo(() => months.map((m, i) => [m, i] as const).reverse(), [months]);

  const sales = useMemo(() => salesByBranch(db, profiles, months), [db, profiles, months]);
  const salesRow = branch ? sales.rows.find(r => r.branch === branch) : sales.total;

  const aging = useMemo(() => receivablesAging(db, profiles, today), [db, profiles, today]);
  const agingRow = branch ? aging.rows.find(r => r.branch === branch) : aging.total;
  const agingList = aging.invoices.filter(i => !branch || i.branch === branch);

  const payroll = useMemo(() => payrollCost(db, months, branch || undefined), [db, months, branch]);
  const payrollTotal = payroll.reduce((a, m) => ({
    gross: a.gross + m.gross, employer: a.employer + m.employerStatutory + m.borne, cost: a.cost + m.cost, net: a.net + m.netPaid,
  }), { gross: 0, employer: 0, cost: 0, net: 0 });

  const scope = branch || 'All branches';
  const fileName = (what: string) =>
    `${what}-${scope.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${today.toISOString().slice(0, 10)}.xlsx`;

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink-900 dark:text-white">Reports</h2>
          <p className="text-xs text-ink-500 dark:text-ink-400">The last 12 months, in {currency}.</p>
        </div>
        {profiles.length > 1 && (
          <label className="flex items-center gap-2 text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300">
            Branch
            <select value={branch} onChange={e => setBranch(e.target.value)}
              className="tap px-3 rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-900 text-xs font-semibold normal-case tracking-normal text-ink-900 dark:text-white cursor-pointer">
              <option value="">All branches</option>
              {profiles.map(p => <option key={p.id} value={outletLabel(p)}>{outletLabel(p)}</option>)}
            </select>
          </label>
        )}
      </div>

      {canSales && (
        <Section
          icon={<BarChart3 />} title="Sales by month"
          note="Invoiced by invoice date; collected by the date the money arrived."
          onDownload={() => download(fileName('sales'), buildXlsx([{
            name: 'Sales', rows: newestFirst.map(([m, i]) => ({
              Month: monthTitle(m), Branch: scope,
              Invoiced: salesRow?.invoiced[i] ?? 0, Collected: salesRow?.collected[i] ?? 0,
            })),
          }, ...(branch ? [] : [{
            name: 'By branch', rows: sales.rows.flatMap(r => newestFirst.map(([m, i]) => ({
              Branch: r.branch, Month: monthTitle(m), Invoiced: r.invoiced[i], Collected: r.collected[i],
            }))),
          }])]), XLSX_TYPE)}
        >
          {!salesRow || salesRow.totalInvoiced + salesRow.totalCollected === 0 ? (
            <EmptyState compact icon={<BarChart3 />} title="No sales in the last 12 months" body="Invoices you raise will add up here month by month." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left">
                <thead className="bg-ink-50 dark:bg-ink-950/40">
                  <tr><th className={TH}>Month</th><th className={`${TH} text-right`}>Invoiced</th><th className={`${TH} text-right`}>Collected</th></tr>
                </thead>
                <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                  {newestFirst.map(([m, i]) => (
                    <tr key={m}>
                      <td className={`${TD} font-semibold text-ink-800 dark:text-ink-200`}>{monthTitle(m)}</td>
                      <td className={`${TD} text-right font-mono text-ink-900 dark:text-white`}>{cellFmt(salesRow.invoiced[i])}</td>
                      <td className={`${TD} text-right font-mono ${salesRow.collected[i] ? 'text-emerald-700 dark:text-emerald-400' : 'text-ink-500 dark:text-ink-400'}`}>{cellFmt(salesRow.collected[i])}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-ink-200 dark:border-ink-700">
                  <tr className="font-bold">
                    <td className={`${TD} text-ink-900 dark:text-white`}>12 months</td>
                    <td className={`${TD} text-right font-mono text-ink-900 dark:text-white`}>{fmt(salesRow.totalInvoiced)}</td>
                    <td className={`${TD} text-right font-mono text-emerald-700 dark:text-emerald-400`}>{fmt(salesRow.totalCollected)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {!branch && sales.rows.length > 1 && (salesRow?.totalInvoiced || 0) > 0 && (
            <div className="px-4 py-3 border-t border-ink-100 dark:border-ink-800 grid gap-1.5">
              {sales.rows.map(r => (
                <div key={r.branch} className="flex justify-between gap-3 text-xs">
                  <span className="truncate text-ink-700 dark:text-ink-300">{r.branch}</span>
                  <span className="font-mono tabular-nums text-ink-900 dark:text-white">{fmt(r.totalInvoiced)}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {canSales && (
        <Section
          icon={<Clock />} title="Unpaid invoices by age"
          note="What customers still owe, by how long since the invoice date."
          onDownload={() => download(fileName('unpaid'), buildXlsx([
            { name: 'Summary', rows: AGE_BUCKETS.map((b, i) => ({ Age: b, Outstanding: agingRow?.buckets[i] ?? 0 })) },
            { name: 'Invoices', rows: agingList.map(i => ({
              Invoice: i.id, Customer: i.customer, Branch: i.branch, Date: i.date, Days: i.days, Outstanding: i.balance,
            })) },
          ]), XLSX_TYPE)}
        >
          {!agingRow || agingRow.count === 0 ? (
            <EmptyState compact icon={<Clock />} title="Nothing outstanding" body="Every invoice is paid in full." />
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-ink-100 dark:bg-ink-800">
                {AGE_BUCKETS.map((b, i) => (
                  <div key={b} className="bg-white dark:bg-ink-900 px-4 py-3">
                    <p className="text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300">{b}</p>
                    <p className={`text-base font-bold font-mono tabular-nums mt-0.5 ${
                      i === 3 && agingRow.buckets[i] > 0 ? 'text-rose-700 dark:text-rose-400'
                      : i >= 1 && agingRow.buckets[i] > 0 ? 'text-amber-700 dark:text-amber-400'
                      : 'text-ink-900 dark:text-white'}`}>
                      {fmt(agingRow.buckets[i])}
                    </p>
                  </div>
                ))}
              </div>
              <div className="overflow-x-auto border-t border-ink-100 dark:border-ink-800">
                <table className="min-w-full text-left">
                  <thead className="bg-ink-50 dark:bg-ink-950/40">
                    <tr>
                      <th className={TH}>Invoice</th><th className={TH}>Customer</th>
                      {!branch && <th className={`${TH} ${NARROW_HIDE}`}>Branch</th>}
                      <th className={`${TH} text-right`}>Days</th><th className={`${TH} text-right`}>Owed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                    {agingList.slice(0, 15).map(i => (
                      <tr key={i.id}>
                        <td className={`${TD} font-mono font-semibold text-ink-900 dark:text-white`}>{i.id}</td>
                        <td className={`${TD} text-ink-700 dark:text-ink-300 max-w-[7rem] sm:max-w-[12rem] truncate`} title={i.customer}>{i.customer}</td>
                        {!branch && <td className={`${TD} ${NARROW_HIDE} text-ink-600 dark:text-ink-300`}>{i.branch}</td>}
                        <td className={`${TD} text-right ${i.days > 90 ? 'text-rose-700 dark:text-rose-400 font-bold' : 'text-ink-700 dark:text-ink-300'}`}>{i.days}</td>
                        <td className={`${TD} text-right font-mono text-ink-900 dark:text-white`}>{fmt(i.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {agingList.length > 15 && (
                  <p className="px-4 py-2.5 text-2xs text-ink-500 dark:text-ink-400 border-t border-ink-100 dark:border-ink-800">
                    The 15 oldest of {agingList.length}. The Excel download lists them all.
                  </p>
                )}
              </div>
            </>
          )}
        </Section>
      )}

      {canPayroll && (
        <Section
          icon={<Wallet />} title="Payroll cost by month"
          note="From saved payslips: gross pay plus the employer's EPF, SOCSO and EIS."
          onDownload={() => download(fileName('payroll-cost'), buildXlsx([{
            name: 'Payroll cost', rows: [...payroll].reverse().map(m => ({
              Month: monthTitle(m.month), Branch: scope, Staff: m.staff, Gross: m.gross,
              'Employer contributions': m.employerStatutory, 'Employee share borne': m.borne,
              'Total cost': m.cost, 'Net paid': m.netPaid,
            })),
          }]), XLSX_TYPE)}
        >
          {payrollTotal.cost === 0 ? (
            <EmptyState compact icon={<Wallet />} title="No saved payslips in the last 12 months" body="Saved payslips add up here month by month." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left">
                <thead className="bg-ink-50 dark:bg-ink-950/40">
                  <tr>
                    <th className={TH}>Month</th><th className={`${TH} ${NARROW_HIDE} text-right`}>Staff</th>
                    <th className={`${TH} text-right`}>Gross</th>
                    <th className={`${TH} ${NARROW_HIDE} text-right`} title="Employer EPF, SOCSO and EIS, plus any employee share the employer bears">Employer</th>
                    <th className={`${TH} text-right`}>Total cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                  {[...payroll].reverse().map(m => (
                    <tr key={m.month}>
                      <td className={`${TD} font-semibold text-ink-800 dark:text-ink-200`}>{monthTitle(m.month)}</td>
                      <td className={`${TD} ${NARROW_HIDE} text-right text-ink-700 dark:text-ink-300`}>{m.staff || '–'}</td>
                      <td className={`${TD} text-right font-mono text-ink-900 dark:text-white`}>{cellFmt(m.gross)}</td>
                      <td className={`${TD} ${NARROW_HIDE} text-right font-mono text-ink-700 dark:text-ink-300`}>{cellFmt(m.employerStatutory + m.borne)}</td>
                      <td className={`${TD} text-right font-mono font-bold text-ink-900 dark:text-white`}>{cellFmt(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-ink-200 dark:border-ink-700">
                  <tr className="font-bold">
                    <td className={`${TD} text-ink-900 dark:text-white`}>12 months</td>
                    <td className={`${TD} ${NARROW_HIDE}`} />
                    <td className={`${TD} text-right font-mono text-ink-900 dark:text-white`}>{fmt(payrollTotal.gross)}</td>
                    <td className={`${TD} ${NARROW_HIDE} text-right font-mono text-ink-900 dark:text-white`}>{fmt(payrollTotal.employer)}</td>
                    <td className={`${TD} text-right font-mono text-ink-900 dark:text-white`}>{fmt(payrollTotal.cost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
