// TEMPORARY verification harness — not part of the app. Mounts PayrollDashboard
// standalone with mock data reproducing the reported scenario, bypassing the
// real Google OAuth sign-in wall so the fix and the new feature can be checked
// visually in a real browser. Delete harness.html and this file when done.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import './index.css';
import { PayrollDashboard } from './components/PayrollDashboard';
import type { DatabaseState, Employee, Payslip } from './types';

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

function Harness() {
  const [db, setDb] = useState<DatabaseState>(initialDb);
  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <PayrollDashboard
        db={db}
        setDb={setDb}
        activeBranchLocation="A1 Bistro"
        isStaff={false}
        isDarkMode={false}
        triggerToast={(msg, type) => console.log(`[toast:${type}]`, msg)}
        syncStateToSheets={async () => { console.log('(mock) sync skipped in harness'); }}
        spreadsheetId="mock"
        accessToken="mock"
        profiles={[]}
        isSyncing={false}
        setIsSyncing={() => {}}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
