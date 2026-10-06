/**
 * PayslipArchive.tsx — saved payslips, one record per person.
 *
 * A flat pile grows by a whole roster every month; finding one person's March
 * means scrolling past everyone else's. So each person is one row (name,
 * branch, how many payslips, the latest, anything unpaid), opening onto their
 * own payslips newest first, by year. Unpaid people sort to the top.
 */
import React, { useMemo, useState } from 'react';
import { ChevronDown, FileText, Search, Check } from 'lucide-react';
import { Employee, Payslip } from '../types';
import { normaliseMonthLabel } from '../utils/notifications';
import { parseMonthLabel } from '../utils/payroll';
import { EmptyState } from './ui/States';

const monthOrder = (p: Payslip): number => {
  const m = parseMonthLabel(normaliseMonthLabel(p.Month_Year));
  return m ? m.year * 12 + m.month : 0;
};

interface Person {
  id: string;
  employee?: Employee;
  name: string;
  slips: Payslip[];     // newest first
  unpaid: number;
}

export function PayslipArchive({
  payslips, employees, showBranch, canMarkPaid, onView, onMarkPaid,
}: {
  payslips: Payslip[];          // saved payslips in scope
  employees: Employee[];        // everyone, to name people across branches
  showBranch: boolean;
  canMarkPaid: boolean;
  onView: (slip: Payslip, employee?: Employee) => void;
  onMarkPaid: (slip: Payslip) => void;
}) {
  const [query, setQuery] = useState('');
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const people = useMemo<Person[]>(() => {
    const byId = new Map<string, Person>();
    payslips.forEach(p => {
      if (!byId.has(p.Employee_ID)) {
        const employee = employees.find(e => e.Employee_ID === p.Employee_ID);
        byId.set(p.Employee_ID, {
          id: p.Employee_ID, employee,
          name: employee?.Employee_Name || `Removed employee (${p.Employee_ID})`,
          slips: [], unpaid: 0,
        });
      }
      const person = byId.get(p.Employee_ID)!;
      person.slips.push(p);
      if (!p.Payment_Transferred) person.unpaid += 1;
    });
    const list = [...byId.values()];
    list.forEach(p => p.slips.sort((a, b) => monthOrder(b) - monthOrder(a)));
    // Unpaid first: that is the work. Then alphabetical, to be findable.
    return list.sort((a, b) => (b.unpaid > 0 ? 1 : 0) - (a.unpaid > 0 ? 1 : 0) || a.name.localeCompare(b.name));
  }, [payslips, employees]);

  const q = query.trim().toLowerCase();
  const shown = people.filter(p =>
    (!unpaidOnly || p.unpaid > 0) &&
    (!q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q) ||
      (p.employee?.IC_Passport || '').toLowerCase().includes(q)));
  const totalUnpaid = people.reduce((n, p) => n + p.unpaid, 0);

  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <section className="rounded-2xl border border-ink-200 dark:border-ink-800 bg-white dark:bg-ink-900 overflow-hidden">
      <header className="px-4 sm:px-5 py-4 border-b border-ink-100 dark:border-ink-800 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-ink-900 dark:text-white">Payslip records</h3>
            <p className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5">
              {people.length} {people.length === 1 ? 'person' : 'people'} · {payslips.length} saved payslip{payslips.length === 1 ? '' : 's'}
              {totalUnpaid > 0 && <span className="text-amber-800 dark:text-amber-300 font-bold"> · {totalUnpaid} unpaid</span>}
            </p>
          </div>
        </div>
        {people.length > 0 && (
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-500" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Find a person by name, staff ID or IC"
                aria-label="Find a person"
                className="w-full pl-9 pr-3 py-2.5 text-xs rounded-lg border border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-950 text-ink-900 dark:text-ink-100 placeholder-ink-500"
              />
            </div>
            <label className="tap inline-flex items-center gap-2 px-3 rounded-lg border border-ink-200 dark:border-ink-700 text-xs font-semibold text-ink-700 dark:text-ink-200 cursor-pointer select-none">
              <input type="checkbox" checked={unpaidOnly} onChange={e => setUnpaidOnly(e.target.checked)} className="w-4 h-4 accent-brand-600" />
              Unpaid only
            </label>
          </div>
        )}
      </header>

      {people.length === 0 ? (
        <EmptyState compact icon={<FileText />} title="No saved payslips yet"
          body="Payslips you generate and save are kept here, one record per person." />
      ) : shown.length === 0 ? (
        <EmptyState compact icon={<Search />} title="No one matches"
          body={unpaidOnly ? 'Everyone matching is fully paid.' : 'Try another name, staff ID or IC.'}
          action={{ label: 'Clear', onClick: () => { setQuery(''); setUnpaidOnly(false); } }} />
      ) : (
        <ul className="divide-y divide-ink-100 dark:divide-ink-800">
          {shown.map(person => {
            const isOpen = open.has(person.id) || (shown.length === 1);
            const latest = person.slips[0];
            const years = [...new Set(person.slips.map(s => Math.floor((monthOrder(s) || 0) / 12)))];
            return (
              <li key={person.id}>
                <button
                  type="button"
                  onClick={() => toggle(person.id)}
                  aria-expanded={isOpen}
                  className="w-full flex items-center gap-3 px-4 sm:px-5 py-3 text-left hover:bg-ink-50 dark:hover:bg-ink-800/40 cursor-pointer transition-colors"
                >
                  <span className="w-9 h-9 rounded-xl bg-brand-50 dark:bg-brand-950/50 text-brand-700 dark:text-brand-300 flex items-center justify-center text-sm font-black uppercase shrink-0">
                    {person.name.charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink-900 dark:text-white truncate">{person.name}</span>
                    <span className="block text-2xs text-ink-500 dark:text-ink-400 truncate">
                      {person.slips.length} payslip{person.slips.length === 1 ? '' : 's'} · latest {normaliseMonthLabel(latest.Month_Year)}
                      {showBranch && person.employee?.Branch_Location && ` · ${person.employee.Branch_Location}`}
                      {person.employee?.End_Date && ` · left ${person.employee.End_Date}`}
                    </span>
                  </span>
                  {person.unpaid > 0 && (
                    <span className="shrink-0 px-2 py-0.5 rounded-full text-2xs font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300">
                      {person.unpaid} unpaid
                    </span>
                  )}
                  <ChevronDown className={`w-4 h-4 text-ink-500 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>

                {isOpen && (
                  <div className="px-4 sm:px-5 pb-3 bg-ink-50/60 dark:bg-ink-950/30">
                    {years.map(year => (
                      <div key={year}>
                        {years.length > 1 && (
                          <p className="pt-3 pb-1 text-2xs font-bold uppercase tracking-wider text-ink-500 dark:text-ink-400">{year || 'Undated'}</p>
                        )}
                        <ul className="divide-y divide-ink-100 dark:divide-ink-800">
                          {person.slips.filter(s => Math.floor((monthOrder(s) || 0) / 12) === year).map(slip => (
                            <li key={slip.Payslip_ID} className="flex items-center gap-3 py-2.5">
                              <span className="min-w-0 flex-1">
                                <span className="block text-xs font-semibold text-ink-900 dark:text-white">{normaliseMonthLabel(slip.Month_Year)}</span>
                                <span className={`block text-2xs font-semibold ${slip.Payment_Transferred ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-300'}`}>
                                  {slip.Payment_Transferred ? `Paid${slip.Transfer_Date ? ` · ${slip.Transfer_Date}` : ''}` : 'Payment pending'}
                                  {showBranch && slip.Branch_Location && slip.Branch_Location !== person.employee?.Branch_Location && (
                                    <span className="text-ink-500 dark:text-ink-400 font-normal"> · {slip.Branch_Location}</span>
                                  )}
                                </span>
                              </span>
                              <span className="text-xs font-bold font-mono tabular-nums text-ink-900 dark:text-white shrink-0">
                                RM {slip.Final_Net_Pay.toFixed(2)}
                              </span>
                              <button type="button" onClick={() => onView(slip, person.employee)}
                                aria-label={`View ${normaliseMonthLabel(slip.Month_Year)} payslip`}
                                className="tap shrink-0 inline-flex items-center justify-center gap-1 px-2.5 rounded-lg text-2xs font-bold bg-brand-50 dark:bg-brand-950/40 text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-950/70 cursor-pointer">
                                <FileText className="w-3.5 h-3.5" /><span className="hidden sm:inline">View</span>
                              </button>
                              {canMarkPaid && !slip.Payment_Transferred && (
                                <button type="button" onClick={() => onMarkPaid(slip)}
                                  aria-label={`Mark ${normaliseMonthLabel(slip.Month_Year)} as paid`}
                                  className="tap shrink-0 inline-flex items-center justify-center gap-1 px-2.5 rounded-lg text-2xs font-bold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/70 cursor-pointer">
                                  <Check className="w-3.5 h-3.5" /><span className="hidden sm:inline">Mark paid</span>
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
