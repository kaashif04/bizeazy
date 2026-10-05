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

const payslips: Payslip[] = [];

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
        {view === 'sheet' ? <SheetDemo /> : view === 'loading' ? <ModuleSkeleton label="Payroll" /> : (
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
          />
        )}
        <BottomNav activeView="payroll" onNavigate={() => {}} allowed={() => true} badgeCount={3} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
