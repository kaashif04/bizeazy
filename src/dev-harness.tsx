// TEMPORARY verification harness — not part of the app. Mounts PayrollDashboard
// standalone with mock data reproducing the reported scenario, bypassing the
// real Google OAuth sign-in wall so the fix and the new feature can be checked
// visually in a real browser. Delete harness.html and this file when done.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import './index.css';
import { PayrollDashboard } from './components/PayrollDashboard';
import { Sheet, sheetBtn } from './components/ui/Sheet';
import { BottomNav } from './components/ui/BottomNav';
import { ModuleSkeleton } from './components/ui/States';
import { ReportsView } from './components/ReportsView';
import type { CompanyProfile, DatabaseState, Employee, Payslip } from './types';

const employees: Employee[] = [
  {
    Employee_ID: 'EMP-74868', Employee_Name: 'Jagabar Ali Bin S Awliya Mohamed',
    IC_Passport: '700909715153', Position: 'Director', Assigned_Outlet: 'Bistro',
    Basic_Salary: 1700, Bank_Details: 'Maybank: 564258616415', Branch_Location: 'A1 Bistro',
    Citizenship: 'Malaysian/PR', Age: 55, Joining_Date: '2024-01-01',
    Employer_Bears_Statutory: true, // <-- the new toggle, ON, to verify the offset
  },
  {
    Employee_ID: 'EMP-89690', Employee_Name: 'SHAMEEM FATHIMA',
    IC_Passport: 'W8949439', Position: 'Director', Assigned_Outlet: 'Bistro',
    Basic_Salary: 6000, Bank_Details: 'Public Bank :4800321000', Branch_Location: 'A1 Bistro',
    Citizenship: 'Foreigner', Age: 40, Joining_Date: '2024-01-01',
    Employer_Bears_Statutory: false,
  },
  {
    Employee_ID: 'EMP-12278', Employee_Name: 'ABDUL RASHID BIN ABDULLAH',
    IC_Passport: '651002106757', Position: 'CHEF', Assigned_Outlet: 'Bistro',
    Basic_Salary: 1700, Bank_Details: 'Maybank: 111222333', Branch_Location: 'A1 Bistro',
    Citizenship: 'Malaysian/PR', Age: 45, Joining_Date: '2024-01-01',
  },
];

const slipFor = (emp: Employee, month: string, paid: boolean, net: number): Payslip => ({
  Payslip_ID: `PAY-${emp.Employee_ID}-${month.replace(' ', '-')}`, Employee_ID: emp.Employee_ID, Issue_Date: '2026-10-01',
  Month_Year: month, Basic_Pay: emp.Basic_Salary, Custom_Allowances: 0, Total_Allowances: 0, Employee_EPF: 0, Employer_EPF: 0,
  Employee_SOCSO: 0, Employer_SOCSO: 0, Employee_EIS: 0, Employer_EIS: 0, Employee_SKBBK: 0, Total_Statutory_Deductions: 0,
  Custom_Deductions: 0, Employer_Statutory_Offset: 0, Final_Net_Pay: net, Branch_Location: emp.Branch_Location, Is_Saved: true,
  Payment_Transferred: paid, Transfer_Date: paid ? '5 October 2026' : '',
});
employees.push({
  Employee_ID: 'EMP-55501', Employee_Name: 'Siti Nurhaliza', IC_Passport: '010203141234', Position: 'Cashier',
  Assigned_Outlet: 'NK', Basic_Salary: 1900, Bank_Details: 'CIMB 7001', Branch_Location: "Kiya's Restaurant",
  Citizenship: 'Malaysian', Age: 24, Joining_Date: '2025-11-01',
});
const payslips: Payslip[] = [
  ...['December 2025', 'January 2026', 'June 2026', 'July 2026', 'August 2026'].map(m => slipFor(employees[1], m, true, 5850)),
  slipFor(employees[1], 'September 2026', false, 5850),
  ...['August 2026', 'September 2026'].map(m => slipFor(employees[0], m, true, 1700)),
  slipFor(employees[3], 'September 2026', false, 1900),
];

const initialDb: DatabaseState = {
  invoices: [], invoice_items: [], payments: [], customers: [],
  employees, payslips,
  quotations: [], quotation_days: [], quotation_items: [],
};

// A real profile: with an empty list the payslip preview dereferences
// undefined, which is a pre-existing trap rather than anything to verify.
const profiles: CompanyProfile[] = [{
  id: 'Bistro', name: 'A1 Bistro', store_name: 'A1 Bistro',
  company_name: 'Ya Barr Solutions', address: '16g, Jalan PJU 5/20D, Kota Damansara',
  email: 'accounts@example.com', phone: '012-3456789', currency_symbol: 'RM',
  series_format: 'BIS-26-',
}, {
  id: 'NK', name: "Kiya's Restaurant", store_name: "Kiya's Restaurant",
  company_name: 'Ya Barr Solutions', address: 'Jalan Tun Razak, KL',
  email: 'kiya@example.com', phone: '03-1234567', currency_symbol: 'RM', series_format: 'NK-26-',
}];

const params = new URLSearchParams(location.search);
const view = params.get('view') || 'roster';
const dark = params.get('dark') === '1';
// On <html>, exactly as the app does it: sheets portal to <body>, so a `dark`
// class on an inner div would leave every dialog in light mode.
if (dark) document.documentElement.classList.add('dark');

function SheetDemo() {
  return (
    <Sheet
      title="Add Employee"
      subtitle="A1 Bistro"
      onClose={() => {}}
      maxWidth="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button className={sheetBtn.ghost}>Cancel</button>
          <button className={sheetBtn.primary}>Save Employee</button>
        </div>
      }
    >
      <div className="space-y-3">
        {[['Full name', 'Jagabar Ali Bin S Awliya Mohamed'], ['IC / Passport', '700909715153'],
          ['Position', 'Director'], ['Basic monthly salary', '1700.00'],
          ['Bank details', 'Maybank: 564258616415']].map(([label, value]) => (
          <div key={label}>
            <label className="block text-2xs font-bold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-1">{label}</label>
            <input defaultValue={value} className="w-full px-3 py-2.5 text-xs rounded-lg border border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-950 text-ink-900 dark:text-ink-100" />
          </div>
        ))}
        <p className="text-xs text-ink-500 dark:text-ink-400 pt-2">
          On a phone this is a bottom sheet with its actions pinned; from the small
          breakpoint up it is a centred dialog.
        </p>
      </div>
    </Sheet>
  );
}

function Harness() {
  const [db, setDb] = useState<DatabaseState>(view === 'empty' ? { ...initialDb, employees: [] } : initialDb);
  return (
    <div>
      <div className="min-h-screen bg-ink-50 dark:bg-ink-950 p-4 sm:p-6 pb-nav md:pb-6">
        {view === 'sheet' ? <SheetDemo /> : view === 'loading' ? <ModuleSkeleton label="Payroll" /> : view === 'reports' ? (
          <ReportsView canSales canPayroll profiles={[...profiles, { ...profiles[0], id: 'NK', name: "Kiya's Restaurant", store_name: "Kiya's Restaurant" }]} db={{
            ...db,
            invoices: [
              { Invoice_ID: 'BIS-26-0012', Date: '2026-09-20', Company: 'Bistro', Customer_Name: 'Acme Catering Sdn Bhd', Status: 'Pending', Total_Amount: 7700, Customer_Type: 'Regular' },
              { Invoice_ID: 'BIS-26-0009', Date: '2026-07-02', Company: 'Bistro', Customer_Name: 'Hotel Seri', Status: 'Pending', Total_Amount: 2450, Customer_Type: 'Regular' },
              { Invoice_ID: 'NK-26-0004', Date: '2026-08-15', Company: 'NK', Customer_Name: 'Wedding — Aminah', Status: 'Paid', Total_Amount: 12800, Customer_Type: 'New' },
            ] as any,
            payments: [{ Payment_ID: 'p1', Invoice_ID: 'BIS-26-0012', Amount: 5000, Date: '2026-10-02' }] as any,
            payslips: [
              { Payslip_ID: 'x1', Employee_ID: 'EMP-74868', Month_Year: 'September 2026', Basic_Pay: 1700, Custom_Allowances: 0, Total_Allowances: 0, Employer_EPF: 221, Employer_SOCSO: 29.75, Employer_EIS: 3.30, Employer_Statutory_Offset: 205, Final_Net_Pay: 1700, Is_Saved: true, Branch_Location: 'A1 Bistro' },
              { Payslip_ID: 'x2', Employee_ID: 'EMP-89690', Month_Year: 'September 2026', Basic_Pay: 6000, Custom_Allowances: 300, Total_Allowances: 300, Employer_EPF: 756, Employer_SOCSO: 104.15, Employer_EIS: 0, Employer_Statutory_Offset: 0, Final_Net_Pay: 6015, Is_Saved: true, Branch_Location: 'A1 Bistro' },
              { Payslip_ID: 'x3', Employee_ID: 'EMP-89690', Month_Year: 'August 2026', Basic_Pay: 6000, Custom_Allowances: 0, Total_Allowances: 0, Employer_EPF: 720, Employer_SOCSO: 104.15, Employer_EIS: 0, Employer_Statutory_Offset: 0, Final_Net_Pay: 5715, Is_Saved: true, Branch_Location: 'A1 Bistro' },
            ] as any,
          }} />
        ) : (
          <PayrollDashboard
            db={db}
            setDb={setDb}
            activeBranchLocation="A1 Bistro"
            isStaff={false}
            isDarkMode={dark}
            triggerToast={(msg, type) => console.log(`[toast:${type}]`, msg)}
            syncStateToSheets={async () => { console.log('(mock) sync skipped in harness'); }}
            spreadsheetId="mock"
            accessToken="mock"
            profiles={profiles}
            isSyncing={false}
            setIsSyncing={() => {}}
            payrollScope={params.get('scope') === 'branch' ? 'branch' : 'company'}
            onPayrollScopeChange={() => {}}
          />
        )}
        <BottomNav activeView="payroll" onNavigate={() => {}} allowed={() => true} badgeCount={3} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
