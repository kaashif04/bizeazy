import React, { useState, useMemo } from 'react';
import { 
  Users, UserPlus, Trash2, Edit, Printer, Download, CheckCircle, 
  Calendar, Coins, CreditCard, Plus, Search, ShieldAlert, X, 
  Briefcase, FileText, Check, DollarSign, HelpCircle, Save 
} from 'lucide-react';
import { DatabaseState, Employee, Payslip, CompanyProfile } from '../types';
import { saveEmployeeExtras, savePayslipExtras } from '../sheetsService';

interface PayrollDashboardProps {
  db: DatabaseState;
  setDb: React.Dispatch<React.SetStateAction<DatabaseState>>;
  activeBranchLocation: string; // The selected outlet display name (e.g., 'A1 Bistro' or "Kiya's Restaurant")
  isStaff: boolean;
  isDarkMode: boolean;
  triggerToast: (msg: string, type: 'success' | 'error' | 'warning' | 'info') => void;
  syncStateToSheets: (
    spreadsheetId: string, 
    token: string, 
    db: DatabaseState, 
    profiles: CompanyProfile[], 
    activeBranch: string
  ) => Promise<void>;
  spreadsheetId: string;
  accessToken: string;
  profiles: CompanyProfile[];
  isSyncing: boolean;
  setIsSyncing: (val: boolean) => void;
}

export const PayrollDashboard: React.FC<PayrollDashboardProps> = ({
  db,
  setDb,
  activeBranchLocation,
  isStaff,
  isDarkMode,
  triggerToast,
  syncStateToSheets,
  spreadsheetId,
  accessToken,
  profiles,
  isSyncing,
  setIsSyncing
}) => {
  // --- STATE CONTROLS ---
  const [searchTerm, setSearchTerm] = useState('');
  
  // Employee Form State
  const [isEmployeeModalOpen, setIsEmployeeModalOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [empName, setEmpName] = useState('');
  const [empIC, setEmpIC] = useState('');
  const [empPosition, setEmpPosition] = useState('');
  const [empBank, setEmpBank] = useState('');
  const [empSalary, setEmpSalary] = useState<number>(1700);
  const [empCitizenship, setEmpCitizenship] = useState<'Malaysian/PR' | 'Foreigner'>('Malaysian/PR');
  const [empAge, setEmpAge] = useState<number>(30);
  const [empJoiningDate, setEmpJoiningDate] = useState<string>('');

  // Payslip Generator Workspace State
  const [isGeneratorOpen, setIsGeneratorOpen] = useState(false);
  const [selectedMonthYear, setSelectedMonthYear] = useState(() => {
    const d = new Date();
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    // Default to previous month — current month hasn't ended so payslips aren't due yet
    const prevMonth = d.getMonth() === 0 ? 11 : d.getMonth() - 1;
    const prevYear = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
    return `${months[prevMonth]} ${prevYear}`;
  });

  // Working inputs for payslips generation
  // Mapping employee ID to temporary numbers inside the generation modal
  interface ItemizedItem {
    description: string;
    amount: number;
  }
  const [allowancesMap, setAllowancesMap] = useState<Record<string, ItemizedItem[]>>({});
  const [deductionsMap, setDeductionsMap] = useState<Record<string, ItemizedItem[]>>({});

  // Active Payslip Preview Modal State
  const [previewPayslip, setPreviewPayslip] = useState<Payslip | null>(null);
  const [previewEmployee, setPreviewEmployee] = useState<Employee | null>(null);

  // Mark Payment modal state
  const [markPaymentPayslip, setMarkPaymentPayslip] = useState<Payslip | null>(null);
  const [transferDateInput, setTransferDateInput] = useState<string>('');

  // Archive filter — separate from the generator's selectedMonthYear so they don't interfere
  const [archiveFilterMonth, setArchiveFilterMonth] = useState('__all__');

  // --- DERIVED RENDER STATES ---
  // Only show employees whose Branch_Location matches our current active branch
  const activeBranchEmployees = useMemo(() => {
    return db.employees.filter(e => 
      (e.Branch_Location || '').toLowerCase() === activeBranchLocation.toLowerCase()
    );
  }, [db.employees, activeBranchLocation]);

  const filteredEmployees = useMemo(() => {
    return activeBranchEmployees.filter(e => 
      e.Employee_Name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.Position.toLowerCase().includes(searchTerm.toLowerCase()) ||
      e.IC_Passport.includes(searchTerm)
    );
  }, [activeBranchEmployees, searchTerm]);

  const activeBranchPayslips = useMemo(() => {
    return db.payslips.filter(p => 
      (p.Branch_Location || '').toLowerCase() === activeBranchLocation.toLowerCase()
    );
  }, [db.payslips, activeBranchLocation]);

  const activeOutletProfile = useMemo(() => {
    const isBistro = activeBranchLocation.toLowerCase().indexOf('bistro') !== -1;
    return profiles.find(p => isBistro ? p.id === 'Bistro' : p.id === 'Nasi Kandar') || profiles[0];
  }, [profiles, activeBranchLocation]);

  // --- PAYROLL COMPLIANCE REMINDERS (Malaysian Employment Act: 7-day rule) ---
  const getPayrollReminders = () => {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth(); // 0-indexed
    const reminders: {
      employee: Employee;
      monthLabel: string;
      daysUntilDeadline: number;
      isOverdue: boolean;
      payslipExists: boolean;
      payslipSaved: boolean;
      paymentDone: boolean;
    }[] = [];

    activeBranchEmployees.forEach(emp => {
      if (!emp.Joining_Date) return;
      const joining = new Date(emp.Joining_Date);

      // Check last 2 months (current and previous) for unpaid
      [-1, 0].forEach(offset => {
        const checkMonth = currentMonth + offset;
        const checkYear = checkMonth < 0 ? currentYear - 1 : currentYear;
        const normalizedMonth = checkMonth < 0 ? checkMonth + 12 : checkMonth;

        // Employee must have joined by the start of this month
        const monthStart = new Date(checkYear, normalizedMonth, 1);
        if (joining > monthStart) return; // not yet eligible

        // Month must have ended
        const monthEnd = new Date(checkYear, normalizedMonth + 1, 0); // last day
        if (today <= monthEnd) return; // month not over yet

        // 7-day payment deadline
        const deadline = new Date(monthEnd);
        deadline.setDate(deadline.getDate() + 7);
        const daysUntilDeadline = Math.ceil(
          (deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
        );

        const months = ["January","February","March","April","May",
          "June","July","August","September","October","November","December"];
        const monthLabel = `${months[normalizedMonth]} ${checkYear}`;

        // Check if payslip exists and is saved
        const existingPayslip = activeBranchPayslips.find(
          p => p.Employee_ID === emp.Employee_ID &&
          (() => {
            const raw = p.Month_Year || '';
            if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
              const d = new Date(raw);
              if (!isNaN(d.getTime())) {
                return d.getMonth() === normalizedMonth &&
                       d.getFullYear() === checkYear;
              }
            }
            return raw === monthLabel;
          })()
        );

        reminders.push({
          employee: emp,
          monthLabel,
          daysUntilDeadline,
          isOverdue: daysUntilDeadline < 0,
          payslipExists: !!existingPayslip,
          payslipSaved: existingPayslip?.Is_Saved || false,
          paymentDone: existingPayslip?.Payment_Transferred || false,
        });
      });
    });

    return reminders.sort((a, b) => a.daysUntilDeadline - b.daysUntilDeadline);
  };

  // --- STATUTORY MALAYSIAN CALCULATOR FUNCTIONS (2026 update) ---
  /**
   * Employee EPF contribution (2026 — mandatory Oct 2025 for foreigners)
   * Malaysian/PR below 60:  11%
   * Malaysian/PR 60+:       5.5%
   * Foreigner under 75:     2% (mandatory since Oct 2025)
   */
  const calculateEmployeeEPF = (
    grossPay: number,
    citizenship: 'Malaysian/PR' | 'Foreigner',
    age = 30
  ): number => {
    if (citizenship === 'Foreigner') {
      if (age >= 75) return 0;
      return Number((grossPay * 0.02).toFixed(2));
    }
    // Malaysian/PR
    if (age >= 60) {
      return Number((grossPay * 0.055).toFixed(2)); // 5.5%
    }
    return Number((grossPay * 0.11).toFixed(2)); // 11%
  };

  /**
   * Employer EPF contribution (2026)
   * Malaysian/PR below 60:  13% (≤RM5k) / 12% (>RM5k)
   * Malaysian/PR 60+:       6.5% (≤RM5k) / 6% (>RM5k)
   * Foreigner under 75:     2% flat
   */
  const calculateEmployerEPF = (
    grossPay: number,
    citizenship: 'Malaysian/PR' | 'Foreigner',
    age = 30
  ): number => {
    if (citizenship === 'Foreigner') {
      if (age >= 75) return 0;
      return Number((grossPay * 0.02).toFixed(2));
    }
    // Malaysian/PR
    if (age >= 60) {
      const rate = grossPay <= 5000 ? 0.065 : 0.06;
      return Number((grossPay * rate).toFixed(2));
    }
    const rate = grossPay <= 5000 ? 0.13 : 0.12;
    return Number((grossPay * rate).toFixed(2));
  };

  /**
   * Employee SOCSO contribution (wage ceiling RM6,000 since Oct 2024)
   * Malaysian/PR below 60: 0.5% (Category 1 — both schemes)
   * Malaysian/PR 60+:      0%   (Category 2 — Employment Injury only, employer-only)
   * Foreigner below 60:    0.5% (Category 1 — mandatory invalidity from Jul 2024)
   * Foreigner 60+:         0%   (Category 2 — Employment Injury only)
   */
  const calculateEmployeeSOCSO = (
    grossPay: number,
    citizenship: 'Malaysian/PR' | 'Foreigner',
    age = 30
  ): number => {
    if (age >= 60) return 0; // Cat 2: employer-only scheme
    const capped = Math.min(grossPay, 6000);
    return Number((capped * 0.005).toFixed(2)); // 0.5%
  };

  /**
   * Employer SOCSO contribution (wage ceiling RM6,000 since Oct 2024)
   * Below 60 (Cat 1):  1.75% — both Malaysian and Foreigner
   * Age 60+ (Cat 2):   1.25% — Employment Injury scheme only
   */
  const calculateEmployerSOCSO = (
    grossPay: number,
    citizenship: 'Malaysian/PR' | 'Foreigner',
    age = 30
  ): number => {
    const capped = Math.min(grossPay, 6000);
    if (age >= 60) {
      return Number((capped * 0.0125).toFixed(2)); // Category 2: 1.25%
    }
    return Number((capped * 0.0175).toFixed(2)); // Category 1: 1.75%
  };

  /**
   * Employee EIS contribution (wage ceiling RM6,000 since Oct 2024)
   * Applies to: Malaysian/PR aged 18–60 ONLY
   * Foreigners: NOT subject to EIS
   * Age 60+: NOT eligible
   */
  const calculateEmployeeEIS = (
    grossPay: number,
    citizenship: 'Malaysian/PR' | 'Foreigner' = 'Malaysian/PR',
    age = 30
  ): number => {
    if (citizenship === 'Foreigner') return 0;
    if (age >= 60) return 0;
    const capped = Math.min(grossPay, 6000);
    return Number((capped * 0.002).toFixed(2)); // 0.2%
  };

  /**
   * Employer EIS contribution (wage ceiling RM6,000 since Oct 2024)
   * Same rules as employee: Malaysian/PR aged 18–60 only
   */
  const calculateEmployerEIS = (
    grossPay: number,
    citizenship: 'Malaysian/PR' | 'Foreigner' = 'Malaysian/PR',
    age = 30
  ): number => {
    if (citizenship === 'Foreigner') return 0;
    if (age >= 60) return 0;
    const capped = Math.min(grossPay, 6000);
    return Number((capped * 0.002).toFixed(2)); // 0.2%
  };

  // --- WORKSPACE SAVES & EXPORTERS ---
  const handleOpenEmployeeModal = (employee?: Employee) => {
    if (isStaff) {
      triggerToast("Access Restricted: Staff members are on Read-Only view.", "error");
      return;
    }
    if (employee) {
      setEditingEmployee(employee);
      setEmpName(employee.Employee_Name);
      setEmpIC(employee.IC_Passport);
      setEmpPosition(employee.Position);
      setEmpBank(employee.Bank_Details);
      setEmpSalary(employee.Basic_Salary);
      setEmpCitizenship(employee.Citizenship || 'Malaysian/PR');
      setEmpAge(Number((employee as any).Age) || 30);
      setEmpJoiningDate(employee.Joining_Date || '');
    } else {
      setEditingEmployee(null);
      setEmpName('');
      setEmpIC('');
      setEmpPosition('');
      setEmpBank('');
      setEmpSalary(1700);
      setEmpCitizenship('Malaysian/PR');
      setEmpAge(30);
      setEmpJoiningDate('');
    }
    setIsEmployeeModalOpen(true);
  };

  const handleSaveEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isStaff) {
      triggerToast("Access Denied: Staff accounts cannot create or edit employees.", "error");
      return;
    }

    if (!empName.trim() || !empIC.trim() || !empPosition.trim()) {
      triggerToast("Please input valid Employee Name, IC/Passport, and Position.", "warning");
      return;
    }

    if (empSalary < 1700) {
      triggerToast("Basic Salary cannot be lower than the Malaysian national minimum wage of RM1,700.", "error");
      return;
    }

    let updatedEmployees = [...db.employees];

    if (editingEmployee) {
      // Editing Mode
      updatedEmployees = updatedEmployees.map(emp => 
        emp.Employee_ID === editingEmployee.Employee_ID 
          ? {
              ...emp,
              Employee_Name: empName,
              IC_Passport: empIC,
              Position: empPosition,
              Basic_Salary: empSalary,
              Bank_Details: empBank,
              Citizenship: empCitizenship,
              Age: empAge,
              Joining_Date: empJoiningDate,
            }
          : emp
      );
      triggerToast("Updating Employee settings internally...", "info");
    } else {
      // Creation Mode
      const newId = `EMP-${Date.now().toString().slice(-5)}`;
      const newEmp: Employee = {
        Employee_ID: newId,
        Employee_Name: empName,
        IC_Passport: empIC,
        Position: empPosition,
        Assigned_Outlet: activeBranchLocation.toLowerCase().indexOf('bistro') !== -1 ? 'Bistro' : 'Nasi Kandar',
        Basic_Salary: empSalary,
        Bank_Details: empBank,
        Branch_Location: activeBranchLocation,
        Citizenship: empCitizenship,
        Age: empAge,
        Joining_Date: empJoiningDate,
      };
      updatedEmployees.push(newEmp);
      triggerToast("Adding new Employee to the roster...", "info");
    }

    const nextDb = { ...db, employees: updatedEmployees };
    setDb(nextDb);
    setIsEmployeeModalOpen(false);

    // Persist fields the Apps Script schema doesn't have columns for
    const savedEmp = nextDb.employees.find(e =>
      editingEmployee ? e.Employee_ID === editingEmployee.Employee_ID : e.Employee_Name === empName
    );
    if (savedEmp) {
      saveEmployeeExtras(savedEmp.Employee_ID, {
        Citizenship: savedEmp.Citizenship,
        Age: savedEmp.Age,
        Joining_Date: savedEmp.Joining_Date,
      });
    }

    // Save to server
    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast("Employee Database updated successfully on Google Sheets!", "success");
    } catch (err: any) {
      triggerToast(`Saved locally but Sheets Sync failed: ${err.message}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDeleteEmployee = async (empId: string) => {
    if (isStaff) {
      triggerToast("Access Denied: Restricted read-only view.", "error");
      return;
    }
    if (!window.confirm("Are you sure you want to remove this employee?")) return;

    const nextDb = {
      ...db,
      employees: db.employees.filter(e => e.Employee_ID !== empId)
    };
    setDb(nextDb);
    triggerToast("Removing employee details from local states...", "info");

    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast("Roster updated successfully on Google Sheets!", "success");
    } catch (err: any) {
      triggerToast(`Sync failed: ${err.message}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  // Open multi-step Payslip Generation workspace 
  const handleOpenGenerator = () => {
    if (isStaff) {
      triggerToast("Access Denied: Staff accounts cannot generate payslips.", "error");
      return;
    }
    if (activeBranchEmployees.length === 0) {
      triggerToast("No active employees listed on this outlet. Please add an employee first.", "warning");
      return;
    }
    // Initialize black inputs or load saved values with description-amount pairs
    const freshAllowances: Record<string, ItemizedItem[]> = {};
    const freshDeductions: Record<string, ItemizedItem[]> = {};
    activeBranchEmployees.forEach(e => {
      const savedSlip = activeBranchPayslips.find(p => p.Employee_ID === e.Employee_ID && p.Month_Year === selectedMonthYear);
      if (savedSlip && savedSlip.Allowances_JSON) {
        try {
          freshAllowances[e.Employee_ID] = JSON.parse(savedSlip.Allowances_JSON);
        } catch {
          freshAllowances[e.Employee_ID] = [{ description: 'Custom Allowance', amount: savedSlip.Custom_Allowances }];
        }
      } else if (savedSlip && savedSlip.Custom_Allowances > 0) {
        freshAllowances[e.Employee_ID] = [{ description: 'Custom Allowance', amount: savedSlip.Custom_Allowances }];
      } else {
        freshAllowances[e.Employee_ID] = [{ description: '', amount: 0 }];
      }

      if (savedSlip && savedSlip.Deductions_JSON) {
        try {
          const parsed = JSON.parse(savedSlip.Deductions_JSON);
          freshDeductions[e.Employee_ID] = Array.isArray(parsed)
            ? parsed.filter((d: any) => !('_bm_paid' in d))
            : parsed;
        } catch {
          freshDeductions[e.Employee_ID] = [{ description: 'Custom Deduction', amount: savedSlip.Custom_Deductions }];
        }
      } else if (savedSlip && savedSlip.Custom_Deductions > 0) {
        freshDeductions[e.Employee_ID] = [{ description: 'Custom Deduction', amount: savedSlip.Custom_Deductions }];
      } else {
        freshDeductions[e.Employee_ID] = [{ description: '', amount: 0 }];
      }
    });
    setAllowancesMap(freshAllowances);
    setDeductionsMap(freshDeductions);
    setIsGeneratorOpen(true);
  };

  // Create payslips and generate previews inside local states
  const processCalculateSelectedPayslip = (emp: Employee) => {
    const allowancesList = allowancesMap[emp.Employee_ID] || [];
    const deductionsList = deductionsMap[emp.Employee_ID] || [];
    const allowanceSum = allowancesList.reduce((acc, curr) => acc + (curr.amount || 0), 0);
    const customDeductionSum = deductionsList.reduce((acc, curr) => acc + (curr.amount || 0), 0);
    
    const grossPay = emp.Basic_Salary + allowanceSum;
    const citizenship = emp.Citizenship || 'Malaysian/PR';

    const empAge = Number(emp.Age) || 30;
    const epfEmployee = calculateEmployeeEPF(grossPay, citizenship, empAge);
    const epfEmployer = calculateEmployerEPF(grossPay, citizenship, empAge);
    
    const socsoEmployee = calculateEmployeeSOCSO(grossPay, citizenship, empAge);
    const socsoEmployer = calculateEmployerSOCSO(grossPay, citizenship, empAge);

    const eisEmployee = calculateEmployeeEIS(grossPay, citizenship, empAge);
    const eisEmployer = calculateEmployerEIS(grossPay, citizenship, empAge);

    const totalStatutory = Number((epfEmployee + socsoEmployee + eisEmployee).toFixed(2));
    const finalNet = Number((grossPay - totalStatutory - customDeductionSum).toFixed(2));

    const freshPayslip: Payslip = {
      Payslip_ID: `PAY-${emp.Employee_ID}-${selectedMonthYear.replace(' ', '-')}`,
      Employee_ID: emp.Employee_ID,
      Issue_Date: new Date().toISOString().substring(0, 10),
      Month_Year: selectedMonthYear,
      Basic_Pay: emp.Basic_Salary,
      Custom_Allowances: allowanceSum,
      Total_Allowances: allowanceSum,
      Employee_EPF: epfEmployee,
      Employer_EPF: epfEmployer,
      Employee_SOCSO: socsoEmployee,
      Employer_SOCSO: socsoEmployer,
      Employee_EIS: eisEmployee,
      Employer_EIS: eisEmployer,
      Total_Statutory_Deductions: totalStatutory,
      Custom_Deductions: customDeductionSum,
      Final_Net_Pay: finalNet,
      Branch_Location: activeBranchLocation,
      Is_Saved: false,
      Allowances_JSON: JSON.stringify(allowancesList),
      Deductions_JSON: JSON.stringify(deductionsList)
    };

    setPreviewEmployee(emp);
    setPreviewPayslip(freshPayslip);
  };

  const addAllowanceItem = (empId: string) => {
    setAllowancesMap(prev => {
      const list = prev[empId] || [];
      return { ...prev, [empId]: [...list, { description: '', amount: 0 }] };
    });
  };

  const removeAllowanceItem = (empId: string, idx: number) => {
    setAllowancesMap(prev => {
      const list = prev[empId] || [];
      const nextList = list.filter((_, i) => i !== idx);
      return { ...prev, [empId]: nextList.length > 0 ? nextList : [{ description: '', amount: 0 }] };
    });
  };

  const updateAllowanceDescription = (empId: string, idx: number, desc: string) => {
    setAllowancesMap(prev => {
      const list = [...(prev[empId] || [])];
      if (list[idx]) {
        list[idx] = { ...list[idx], description: desc };
      }
      return { ...prev, [empId]: list };
    });
  };

  const updateAllowanceAmount = (empId: string, idx: number, amt: number) => {
    setAllowancesMap(prev => {
      const list = [...(prev[empId] || [])];
      if (list[idx]) {
        list[idx] = { ...list[idx], amount: amt };
      }
      return { ...prev, [empId]: list };
    });
  };

  const addDeductionItem = (empId: string) => {
    setDeductionsMap(prev => {
      const list = prev[empId] || [];
      return { ...prev, [empId]: [...list, { description: '', amount: 0 }] };
    });
  };

  const removeDeductionItem = (empId: string, idx: number) => {
    setDeductionsMap(prev => {
      const list = prev[empId] || [];
      const nextList = list.filter((_, i) => i !== idx);
      return { ...prev, [empId]: nextList.length > 0 ? nextList : [{ description: '', amount: 0 }] };
    });
  };

  const updateDeductionDescription = (empId: string, idx: number, desc: string) => {
    setDeductionsMap(prev => {
      const list = [...(prev[empId] || [])];
      if (list[idx]) {
        list[idx] = { ...list[idx], description: desc };
      }
      return { ...prev, [empId]: list };
    });
  };

  const updateDeductionAmount = (empId: string, idx: number, amt: number) => {
    setDeductionsMap(prev => {
      const list = [...(prev[empId] || [])];
      if (list[idx]) {
        list[idx] = { ...list[idx], amount: amt };
      }
      return { ...prev, [empId]: list };
    });
  };

  // Save localized slips directly into Google Sheets DB
  const handleSavePayslip = async (payslipToSave: Payslip) => {
    if (isStaff) {
      triggerToast("Access Denied: Read-only mode activated.", "error");
      return;
    }

    // Check if duplicate exists
    const exists = db.payslips.some(p => p.Payslip_ID === payslipToSave.Payslip_ID);
    let updatedPayslips = [...db.payslips];

    const finalizedSlips = {
      ...payslipToSave,
      Is_Saved: true,
      Issue_Date: new Date().toISOString().substring(0, 10)
    };

    if (exists) {
      updatedPayslips = updatedPayslips.map(p => 
        p.Payslip_ID === payslipToSave.Payslip_ID ? finalizedSlips : p
      );
    } else {
      updatedPayslips.push(finalizedSlips);
    }

    const nextDb = { ...db, payslips: updatedPayslips };
    setDb(nextDb);
    triggerToast("Writing payslip details to cloud registers...", "info");

    // Clear preview but show updated details in dashboard
    setPreviewPayslip(finalizedSlips); // Keep saved state visible

    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast(`Payslip ${finalizedSlips.Payslip_ID} stored successfully!`, "success");
    } catch (err: any) {
      triggerToast(`Sync failed: ${err.message}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Read-Only Mode Banner Warning */}
      {isStaff && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 p-3.5 rounded-xl flex items-center gap-3">
          <ShieldAlert className="w-5 h-5 flex-shrink-0" />
          <div className="text-xs font-semibold">
            Limited Staff Privileges — Read Only Mode. Staff accounts are prevented from editing the employee roster or writing any payslip records to Google Sheets. You can browse, calculate, print, and download records freely.
          </div>
        </div>
      )}      {/* Roster Header and Trigger CTAs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 
            className="text-xl font-bold tracking-tight text-slate-900 dark:text-gray-100 flex items-center gap-2"
          >
            <Users 
              className="w-5 h-5 text-indigo-500" 
            />
            Payroll & Employee Management
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
            Outlet Specific: <span className="text-slate-900 dark:text-white font-black">{activeBranchLocation}</span> | Total Registered Staff: {activeBranchEmployees.length}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Add Employee Button */}
          {!isStaff && (
            <button
              id="add-employee-btn"
              onClick={() => handleOpenEmployeeModal()}
              className="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold tracking-tight text-xs px-3.5 py-1.5 rounded-lg cursor-pointer transition-colors border border-transparent shadow-sm"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Add Employee</span>
            </button>
          )}

          {/* Generate Monthly Payslips Button */}
          {!isStaff && (
            <button
              id="generate-slips-btn"
              onClick={handleOpenGenerator}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold tracking-tight text-xs px-3.5 py-1.5 rounded-lg cursor-pointer transition-colors shadow-sm border border-transparent"
              title="Open the Malaysian Payslip compilation workspace."
            >
              <Coins className="w-3.5 h-3.5" />
              <span>Generate Monthly Payslips</span>
            </button>
          )}
        </div>
      </div>

      {/* Roster Search bar */}
      <div className="relative max-w-md">
        <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
          <Search className="w-4 h-4" />
        </span>
        <input 
          type="text"
          placeholder="Search employees by name, passport or position..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className={`w-full pl-9 pr-4 py-2 text-xs rounded-lg border focus:ring-1 focus:ring-indigo-500 transition-colors ${
            isDarkMode 
              ? 'bg-slate-900 border-slate-700 text-slate-100 focus:border-indigo-500' 
              : 'bg-white border-gray-300 text-gray-950 focus:border-indigo-500 font-semibold'
          }`}
        />
      </div>

      {/* ── Malaysian Payroll Compliance Reminders ── */}
      {(() => {
        const reminders = getPayrollReminders();
        if (reminders.length === 0) return null;
        return (
          <div className={`rounded-2xl border p-4 mb-4 space-y-2 ${
            isDarkMode
              ? 'bg-slate-900/50 border-slate-800'
              : 'bg-amber-50/60 border-amber-200'
          }`}>
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none"
                   stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667
                     1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34
                     16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
              <p className={`text-xs font-bold uppercase tracking-wider ${
                isDarkMode ? 'text-amber-400' : 'text-amber-700'
              }`}>
                Payroll Compliance Reminders (Malaysian Employment Act)
              </p>
            </div>
            {reminders.map((r, i) => (
              <div key={i} className={`flex items-center justify-between gap-3
                p-3 rounded-xl border ${
                r.isOverdue
                  ? (isDarkMode
                      ? 'bg-rose-950/30 border-rose-800'
                      : 'bg-rose-50 border-rose-200')
                  : r.daysUntilDeadline <= 2
                  ? (isDarkMode
                      ? 'bg-amber-950/30 border-amber-800'
                      : 'bg-amber-50 border-amber-200')
                  : (isDarkMode
                      ? 'bg-slate-800 border-slate-700'
                      : 'bg-white border-gray-200')
              }`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`text-xs font-black ${
                      isDarkMode ? 'text-white' : 'text-gray-900'
                    }`}>{r.employee.Employee_Name}</p>
                    <span className={`text-[9px] font-bold px-2 py-0.5
                      rounded-full ${
                      isDarkMode
                        ? 'bg-slate-700 text-slate-300'
                        : 'bg-gray-100 text-gray-600'
                    }`}>{r.monthLabel}</span>
                    {r.paymentDone && (
                      <span className="text-[9px] font-bold px-2 py-0.5
                        rounded-full bg-emerald-100 text-emerald-700
                        dark:bg-emerald-900/40 dark:text-emerald-400">
                        ✓ Payment Confirmed
                      </span>
                    )}
                  </div>
                  <p className={`text-[10px] mt-0.5 ${
                    r.isOverdue
                      ? 'text-rose-500 font-bold'
                      : r.daysUntilDeadline <= 2
                      ? 'text-amber-600 dark:text-amber-400 font-bold'
                      : (isDarkMode ? 'text-slate-400' : 'text-gray-500')
                  }`}>
                    {r.paymentDone
                      ? 'Wages transferred — payslip archived.'
                      : r.isOverdue
                      ? `⚠ OVERDUE by ${Math.abs(r.daysUntilDeadline)} day${Math.abs(r.daysUntilDeadline) !== 1 ? 's' : ''} — must pay immediately`
                      : `Payment due in ${r.daysUntilDeadline} day${r.daysUntilDeadline !== 1 ? 's' : ''} (7-day rule)`}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!r.payslipSaved && (
                    <button
                      onClick={() => {
                        triggerToast(`Generate payslip for ${r.employee.Employee_Name} first before marking payment.`, 'error');
                      }}
                      className="px-3 py-1.5 text-[10px] font-bold rounded-lg
                        cursor-pointer bg-indigo-600 hover:bg-indigo-700
                        text-white transition-colors"
                    >
                      Generate Payslip
                    </button>
                  )}
                  {r.payslipSaved && !r.paymentDone && (
                    <button
                      onClick={() => {
                        const ps = activeBranchPayslips.find(
                          p => p.Employee_ID === r.employee.Employee_ID &&
                          (() => {
                            const raw = p.Month_Year || '';
                            if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
                              const d = new Date(raw);
                              if (!isNaN(d.getTime())) {
                                const months = ["January","February","March",
                                  "April","May","June","July","August",
                                  "September","October","November","December"];
                                return `${months[d.getMonth()]} ${d.getFullYear()}` === r.monthLabel;
                              }
                            }
                            return raw === r.monthLabel;
                          })() && p.Is_Saved
                        );
                        if (ps) {
                          setMarkPaymentPayslip(ps);
                          setTransferDateInput(new Date().toISOString().slice(0, 10));
                        }
                      }}
                      className="px-3 py-1.5 text-[10px] font-bold rounded-lg
                        cursor-pointer bg-emerald-600 hover:bg-emerald-700
                        text-white transition-colors"
                    >
                      ✓ Mark Payment Made
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Roster Grid and Table */}
      {filteredEmployees.length === 0 ? (
        <div className={`p-10 text-center rounded-2xl border border-dashed ${isDarkMode ? 'border-slate-800 bg-slate-900/30' : 'border-slate-350 bg-white shadow-sm'}`}>
          <Users className="w-8 h-8 text-slate-900 dark:text-white mx-auto mb-3" />
          <h3 className="text-xs font-bold text-slate-900 dark:text-white">No Employees Found</h3>
          <p className="text-[11px] text-slate-600 dark:text-slate-400 mt-1 max-w-sm mx-auto">
            {searchTerm.trim() ? "Matches were not found. Try clearing your search parameters." : "Click the 'Add Employee' button to register staff on this branch."}
          </p>
        </div>
      ) : (
        <div className={`overflow-x-auto rounded-xl border ${isDarkMode ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white shadow-sm'}`}>
          <table className="min-w-full text-left text-xs">
            <thead className={`border-b text-[10px] font-bold uppercase tracking-wider ${isDarkMode ? 'bg-slate-950/40 border-slate-800 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
              <tr>
                <th className="px-5 py-3">Employee Name</th>
                <th className="px-5 py-3">IC / Passport</th>
                <th className="px-5 py-3">Position</th>
                <th className="px-5 py-3">Basic Monthly Salary</th>
                <th className="px-5 py-3">Bank Details</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
              {filteredEmployees.map((employee) => {
                const payslipIdPart = `${employee.Employee_ID}-${selectedMonthYear.replace(' ', '-')}`;
                const savedSlipInMonth = activeBranchPayslips.find(p => p.Employee_ID === employee.Employee_ID && p.Month_Year === selectedMonthYear);

                return (
                  <tr key={employee.Employee_ID} className="hover:bg-slate-50/50 dark:hover:bg-slate-850/40 transition-colors">
                    <td className="px-5 py-4 font-semibold text-slate-900 dark:text-gray-100 flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 flex items-center justify-center text-xs text-indigo-650 dark:text-indigo-450 font-black uppercase">
                        {employee.Employee_Name.charAt(0)}
                      </div>
                      <div>
                        <div className="font-bold text-slate-900 dark:text-white">{employee.Employee_Name}</div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mt-0.5 font-medium">
                          <span>{employee.Employee_ID}</span>
                          <span>•</span>
                          <span className={`px-1 rounded text-[9px] font-bold ${employee.Citizenship === 'Foreigner' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' : 'bg-blue-100 dark:bg-blue-900/40 text-blue-750 dark:text-blue-450'}`}>
                            {employee.Citizenship || 'Malaysian/PR'}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-slate-500 dark:text-slate-400 font-medium font-mono">{employee.IC_Passport}</td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-50 border border-slate-350 dark:border-slate-800 dark:bg-slate-800 text-slate-900 dark:text-slate-300">
                        <Briefcase className="w-3 h-3 text-slate-500" />
                        {employee.Position}
                      </span>
                    </td>
                    <td className="px-5 py-4 font-black text-slate-900 dark:text-white">
                      RM {employee.Basic_Salary.toFixed(2)}
                    </td>
                    <td className="px-5 py-4 text-slate-550 dark:text-slate-400 font-medium max-w-xs truncate" title={employee.Bank_Details}>
                      {employee.Bank_Details || '-'}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Calculate Preview Shortcut */}
                        <button
                          onClick={() => processCalculateSelectedPayslip(employee)}
                          className="p-1 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded-md cursor-pointer transition-colors text-[10px] font-bold flex items-center gap-1"
                          title="Calculate and View Payslip Document Details."
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>View Slip</span>
                        </button>

                        {/* Edit Roster */}
                        {!isStaff && (
                          <button
                            onClick={() => handleOpenEmployeeModal(employee)}
                            className="p-1 text-indigo-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 rounded-md cursor-pointer transition-colors"
                            title="Edit Employee Information Details."
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {/* Remove Employee */}
                        {!isStaff && (
                          <button
                            onClick={() => handleDeleteEmployee(employee.Employee_ID)}
                            className="p-1 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-md cursor-pointer transition-colors"
                            title="Delete Employee Registration."
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Registry of History Month Payslips */}
      <div className={`p-5 rounded-2xl border ${isDarkMode ? 'bg-slate-900/30 border-slate-800' : 'bg-gray-50/50 border-gray-200'}`}>
        <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
          <div>
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-200 uppercase tracking-wider">
              Past Payslip Archive
            </h3>
            <p className="text-[10px] text-gray-500 dark:text-slate-400 mt-1 font-medium">
              View and re-print previously saved payslips.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">Filter Month:</label>
            <select
              value={archiveFilterMonth}
              onChange={e => setArchiveFilterMonth(e.target.value)}
              className={`text-xs font-semibold rounded-lg border px-2.5 py-1.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                isDarkMode ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-white border-gray-200 text-gray-800'
              }`}
            >
              <option value="__all__">All Months</option>
              {Array.from(new Set(activeBranchPayslips.filter(p => p.Is_Saved).map(p => {
                const raw = p.Month_Year || '';
                if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
                  const d = new Date(raw);
                  if (!isNaN(d.getTime())) {
                    return d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
                  }
                }
                return raw;
              }).filter(Boolean)))
              .sort((a, b) => {
                const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
                const [aM, aY] = (a as string).split(' '); const [bM, bY] = (b as string).split(' ');
                return Number(bY) - Number(aY) || months.indexOf(bM) - months.indexOf(aM);
              })
              .map(m => <option key={m} value={m}>{m}</option>)
              }
            </select>
          </div>
        </div>
        {(() => {
          const savedPayslips = activeBranchPayslips.filter(p => p.Is_Saved);
          const filtered = archiveFilterMonth === '__all__'
            ? savedPayslips
            : savedPayslips.filter(p => {
                const raw = p.Month_Year || '';
                let label = raw;
                if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
                  const d = new Date(raw);
                  if (!isNaN(d.getTime())) {
                    label = d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
                  }
                }
                return label === archiveFilterMonth;
              });
          if (filtered.length === 0) {
            return (
              <div className="text-center py-6">
                <p className="text-[11px] text-slate-400 font-medium">
                  No saved payslips found{archiveFilterMonth !== '__all__' ? ` for ${archiveFilterMonth}` : ''} in this branch.
                </p>
              </div>
            );
          }
          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {filtered.map(slip => {
                const matchedEmp = db.employees.find(e => e.Employee_ID === slip.Employee_ID);
                return (
                  <div key={slip.Payslip_ID} className={`p-3 rounded-lg border flex items-center justify-between gap-4 transition-all duration-150 ${isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-gray-200 shadow-sm'}`}>
                    <div className="min-w-0">
                      <h4 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 truncate max-w-[150px]">
                        {matchedEmp?.Employee_Name || "Unregistered Employee"}
                      </h4>
                      <p className="text-[9px] font-semibold text-slate-400 mt-0.5">{(() => {
                        const raw = slip.Month_Year || slip.Issue_Date || '';
                        if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
                          const d = new Date(raw);
                          if (!isNaN(d.getTime())) {
                            return d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
                          }
                        }
                        return raw || '-';
                      })()}</p>
                      <div className="text-[11px] font-bold text-indigo-500 mt-0.5">RM {slip.Final_Net_Pay.toFixed(2)}</div>
                      {slip.Payment_Transferred ? (
                        <span className="text-[9px] font-bold text-emerald-600
                          dark:text-emerald-400 flex items-center gap-1">
                          ✓ Wages Transferred {slip.Transfer_Date ? `· ${slip.Transfer_Date}` : ''}
                        </span>
                      ) : (
                        <span className="text-[9px] font-bold text-amber-500
                          dark:text-amber-400">
                          ⏳ Payment Pending
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <button
                        onClick={() => {
                          if (matchedEmp) {
                            setPreviewEmployee(matchedEmp);
                            setPreviewPayslip(slip);
                          } else {
                            triggerToast("Cannot find related roster registration.", "error");
                          }
                        }}
                        className="flex p-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400 rounded-md text-[10px] font-bold items-center gap-1 transition-colors cursor-pointer"
                      >
                        <FileText className="w-3.5 h-3.5" />
                        <span>View</span>
                      </button>
                      {!slip.Payment_Transferred && (
                        <button
                          onClick={() => {
                            setMarkPaymentPayslip(slip);
                            setTransferDateInput(new Date().toISOString().slice(0, 10));
                          }}
                          className="flex p-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 rounded-md text-[10px] font-bold items-center gap-1 transition-colors cursor-pointer"
                        >
                          <span>✓ Mark Paid</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* --- MODAL 1: ADD / EDIT EMPLOYEE --- */}
      {isEmployeeModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className={`w-full max-w-md p-6 rounded-2xl shadow-xl transition-all ${isDarkMode ? 'bg-slate-900 border border-slate-800 text-slate-100' : 'bg-white border border-slate-200 text-slate-900'}`}>
            <div className="flex items-center justify-between mb-4 border-b pb-3 dark:border-slate-800 border-slate-100">
              <h3 className="text-sm font-bold uppercase tracking-wider text-indigo-500">
                {editingEmployee ? "Edit Employee Details" : "Register New Employee"}
              </h3>
              <button 
                onClick={() => setIsEmployeeModalOpen(false)}
                className="p-1.5 hover:bg-slate-105 dark:hover:bg-slate-800 rounded-lg cursor-pointer text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEmployee} className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold uppercase text-slate-705 dark:text-slate-300 mb-1">Employee Full Name *</label>
                <input 
                  type="text"
                  required
                  placeholder="e.g. Mohd Kaiser"
                  value={empName}
                  onChange={(e) => setEmpName(e.target.value)}
                  className={`w-full p-2.5 text-xs rounded-lg border ${
                    isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100 focus:border-indigo-500' : 'bg-white border-slate-300 text-slate-900 font-semibold focus:border-indigo-500'
                  }`}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-705 dark:text-slate-300 mb-1">IC / Passport Number *</label>
                  <input 
                    type="text"
                    required
                    placeholder="e.g. 960218-14-1234"
                    value={empIC}
                    onChange={(e) => setEmpIC(e.target.value)}
                    className={`w-full p-2.5 text-xs rounded-lg border ${
                      isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100 focus:border-indigo-500' : 'bg-white border-slate-300 text-slate-900 font-semibold focus:border-indigo-500'
                    }`}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase text-slate-705 dark:text-slate-300 mb-1">Position *</label>
                  <input 
                    type="text"
                    required
                    placeholder="e.g. Head Chef"
                    value={empPosition}
                    onChange={(e) => setEmpPosition(e.target.value)}
                    className={`w-full p-2.5 text-xs rounded-lg border ${
                      isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100 focus:border-indigo-500' : 'bg-white border-slate-300 text-slate-900 font-semibold focus:border-indigo-500'
                    }`}
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold uppercase text-slate-705 dark:text-slate-300 mb-2">Citizenship Status *</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-xs text-slate-900 dark:text-white font-medium cursor-pointer">
                    <input 
                      type="radio" 
                      name="citizenship" 
                      value="Malaysian/PR"
                      checked={empCitizenship === 'Malaysian/PR'}
                      onChange={() => setEmpCitizenship('Malaysian/PR')}
                      className="cursor-pointer accent-indigo-600 font-black"
                    />
                    <span>Malaysian / PR</span>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-slate-900 dark:text-white font-medium cursor-pointer">
                    <input 
                      type="radio" 
                      name="citizenship" 
                      value="Foreigner"
                      checked={empCitizenship === 'Foreigner'}
                      onChange={() => setEmpCitizenship('Foreigner')}
                      className="cursor-pointer accent-indigo-600 font-black"
                    />
                    <span>Foreigner</span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-[9px] font-bold text-gray-400 uppercase mb-1">Age (for statutory rates)</label>
                <input
                  type="number"
                  min={18}
                  max={80}
                  value={empAge}
                  onChange={(e) => setEmpAge(Number(e.target.value))}
                  placeholder="e.g. 35"
                  className={`w-full border rounded-xl px-3 py-2 text-xs focus:outline-none ${
                    isDarkMode
                      ? 'bg-slate-950 border-slate-800 text-slate-100'
                      : 'bg-gray-50 border-gray-200 text-gray-900'
                  }`}
                />
                <p className="text-[9px] text-slate-400 mt-0.5">
                  Affects EPF bracket (60+), SOCSO category, and EIS eligibility (18–60 locals only)
                </p>
              </div>

              <div>
                <label className="block text-[10px] font-bold uppercase text-slate-705 dark:text-slate-300 mb-1">Basic Monthly Salary (RM) *</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-slate-500 text-xs font-bold font-mono">RM</span>
                  <input 
                    type="number"
                    required
                    min="1700"
                    step="50"
                    placeholder="2500"
                    value={empSalary}
                    onChange={(e) => setEmpSalary(Number(e.target.value))}
                    className={`w-full pl-9 pr-3 py-2.5 text-xs rounded-lg border ${
                      isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100 focus:border-indigo-500 font-mono' : 'bg-white border-slate-300 text-slate-900 font-semibold focus:border-indigo-500 font-mono'
                    }`}
                  />
                </div>
                <p className="text-[9px] text-slate-500 dark:text-slate-400 font-semibold mt-1">Malaysian national minimum wage requirement is RM 1,700.</p>
              </div>

              <div>
                <label className="block text-[9px] font-bold text-gray-400
                  uppercase mb-1">Joining Date *</label>
                <input
                  type="date"
                  value={empJoiningDate}
                  onChange={e => setEmpJoiningDate(e.target.value)}
                  max={new Date().toISOString().split('T')[0]}
                  className={`w-full px-2.5 py-2 text-xs rounded-lg border
                    focus:outline-none focus:ring-1 focus:ring-indigo-500
                    ${isDarkMode
                      ? 'bg-slate-900 border-slate-700 text-slate-100 [color-scheme:dark]'
                      : 'bg-white border-gray-200 text-gray-800 [color-scheme:light]'}`}
                />
                <p className="text-[9px] text-slate-400 mt-0.5">
                  Used to calculate first payslip eligibility
                </p>
              </div>

              <div>
                <label className="block text-[10px] font-bold uppercase text-slate-750 dark:text-slate-300 mb-1">Bank Name & Details *</label>
                <textarea 
                  placeholder="e.g. Maybank SAVINGS: 1640-1234-5678"
                  value={empBank}
                  onChange={(e) => setEmpBank(e.target.value)}
                  className={`w-full p-2.5 text-xs rounded-lg border h-16 ${
                    isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100 focus:border-indigo-500' : 'bg-white border-slate-300 text-slate-900 font-semibold focus:border-indigo-500'
                  }`}
                />
              </div>

              <div className="pt-3 border-t dark:border-slate-800 border-slate-100 flex justify-end gap-2">
                <button 
                  type="button"
                  onClick={() => setIsEmployeeModalOpen(false)}
                  className="px-4 py-2 text-xs font-black rounded-lg bg-white text-slate-700 hover:bg-slate-100 dark:bg-transparent dark:text-white dark:hover:bg-slate-800 border border-slate-300 dark:border-slate-650 cursor-pointer shadow-xs transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  disabled={isSyncing}
                  className="px-4 py-2 text-xs font-bold text-white rounded-lg bg-indigo-600 hover:bg-indigo-700 cursor-pointer flex items-center gap-1.5 shadow-sm transition-colors"
                >
                  {isSyncing ? "Saving..." : (editingEmployee ? "Update Employee" : "Register Employee")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL 2: GENERATE MONTHLY PAYSLIPS (Admin Workspace) --- */}
      {isGeneratorOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className={`w-full max-w-4xl p-6 rounded-2xl shadow-xl transition-all ${isDarkMode ? 'bg-slate-900 border border-slate-800 text-slate-100' : 'bg-white border border-slate-200 text-slate-900'}`}>
            <div className="flex items-center justify-between mb-4 border-b pb-3 dark:border-slate-800 border-slate-100">
              <div className="flex items-center gap-2">
                <Coins className="w-5 h-5 text-emerald-500" />
                <h3 className="text-sm font-bold uppercase tracking-wider text-emerald-500">
                  Generate Monthly Slips Workspace
                </h3>
              </div>
              <button 
                onClick={() => setIsGeneratorOpen(false)}
                className="p-1.5 hover:bg-slate-105 dark:hover:bg-slate-800 rounded-lg cursor-pointer text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Select Current Month Option */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/20">
                <div className="text-xs text-slate-800 dark:text-slate-350 font-semibold">Select target register month:</div>
                <select
                  value={selectedMonthYear}
                  onChange={(e) => setSelectedMonthYear(e.target.value)}
                  className={`p-2 rounded-lg border text-xs font-bold focus:ring-1 focus:ring-emerald-500 text-slate-900 dark:text-white ${
                    isDarkMode ? 'bg-slate-950 border-slate-800' : 'bg-white border-slate-300'
                  }`}
                >
                  {(() => {
                    const _mths = ["January","February","March","April","May","June","July","August","September","October","November","December"];
                    const _now = new Date();
                    // Only show months that have fully ended (up to last month)
                    const _lastMonth = _now.getMonth() === 0 ? 11 : _now.getMonth() - 1;
                    const _lastYear = _now.getMonth() === 0 ? _now.getFullYear() - 1 : _now.getFullYear();
                    const opts: React.ReactElement[] = [];
                    // Go back up to 24 months from the last ended month
                    for (let i = 0; i < 24; i++) {
                      let m = _lastMonth - i;
                      let y = _lastYear;
                      if (m < 0) { m += 12; y -= 1; }
                      // Don't go before Jan 2026
                      if (y < 2026 || (y === 2026 && m < 0)) break;
                      const lbl = `${_mths[m]} ${y}`;
                      opts.push(<option key={lbl} value={lbl}>{lbl}</option>);
                    }
                    return opts;
                  })()}
                </select>
              </div>

              {/* Grid Inputs Table for RM values */}
              <div className="overflow-x-auto max-h-[350px] border border-slate-100 dark:border-slate-800 rounded-xl">
                <table className="min-w-full text-left text-xs">
                  <thead className={`border-b text-[10px] font-bold uppercase tracking-wider ${isDarkMode ? 'bg-slate-950/40 border-slate-800 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-700'}`}>
                    <tr>
                      <th className="px-4 py-2">Employee</th>
                      <th className="px-4 py-2">Basic Salary (A)</th>
                      <th className="px-4 py-2">Custom Allowances * (B)</th>
                      <th className="px-4 py-2">Custom Deductions * (C)</th>
                      <th className="px-4 py-2 text-right">Estimated Net Pay (RM)</th>
                      <th className="px-4 py-2 text-right">Generate Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {(() => {
                      const _mths = ["January","February","March","April","May","June","July","August","September","October","November","December"];
                      const [_ms, _ys] = selectedMonthYear.split(' ');
                      const _mi = _mths.indexOf(_ms);
                      const _yr = parseInt(_ys, 10);
                      const _today = new Date();
                      const _mEnd = new Date(_yr, _mi + 1, 0);
                      const _ended = _today > _mEnd;
                      const _ddlDate = _ended ? new Date(_mEnd.getTime()) : null;
                      if (_ddlDate) _ddlDate.setDate(_ddlDate.getDate() + 7);
                      const _daysLeft = _ddlDate
                        ? Math.ceil((_ddlDate.getTime() - _today.getTime()) / 86400000)
                        : null;
                      const _overdue = _daysLeft !== null && _daysLeft < 0;

                      const eligible = activeBranchEmployees.filter(emp => {
                        // Rule 1: Selected month must have fully ended — no current/future months
                        if (_today <= _mEnd) return false;

                        if (emp.Joining_Date) {
                          // Parse as local date to avoid UTC timezone shift
                          const parts = emp.Joining_Date.split('-');
                          const jy = parseInt(parts[0], 10);
                          const jm = parseInt(parts[1], 10) - 1; // 0-indexed
                          const jd = parseInt(parts[2], 10);
                          const j = new Date(jy, jm, jd);

                          // Rule 2: Employee must have joined on or before the last day of the month
                          // (allows partial-month payslips for employees who joined mid-month)
                          if (j > _mEnd) return false;

                          // Rule 3: 1-month working stage — today must be >= joining date + 1 calendar month
                          // e.g. joins May 15 → first payslip available June 15
                          const firstEligible = new Date(jy, jm + 1, jd);
                          if (_today < firstEligible) return false;
                        }

                        // Rule 4: No saved payslip already exists for this employee + month
                        return !activeBranchPayslips.some(p => {
                          if (!p.Is_Saved) return false;
                          const raw = p.Month_Year || '';
                          let lbl = raw;
                          if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
                            const d = new Date(raw);
                            if (!isNaN(d.getTime())) lbl = `${_mths[d.getMonth()]} ${d.getFullYear()}`;
                          }
                          return p.Employee_ID === emp.Employee_ID && lbl === selectedMonthYear;
                        });
                      });

                      if (eligible.length === 0) return (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-[11px] text-slate-400 font-medium">
                          No employees are due for payment this month — all payslips are saved, or no employees have completed their first month yet.
                        </td></tr>
                      );

                      return eligible.map((emp) => {
                      const allowancesList = allowancesMap[emp.Employee_ID] || [];
                      const deductionsList = deductionsMap[emp.Employee_ID] || [];
                      
                      const allowanceSum = allowancesList.reduce((acc, curr) => acc + (curr.amount || 0), 0);
                      const customDeductionSum = deductionsList.reduce((acc, curr) => acc + (curr.amount || 0), 0);
                      
                      const grossPayBase = emp.Basic_Salary + allowanceSum;
                      const citizenship = emp.Citizenship || 'Malaysian/PR';

                      const empAge = Number(emp.Age) || 30;
                      const epf = calculateEmployeeEPF(grossPayBase, citizenship, empAge);
                      const socso = calculateEmployeeSOCSO(grossPayBase, citizenship, empAge);
                      const eis = calculateEmployeeEIS(grossPayBase, citizenship, empAge);

                      const totalStatDeduc = epf + socso + eis;
                      const netPay = Math.max(0, grossPayBase - totalStatDeduc - customDeductionSum);

                      return (
                        <tr key={emp.Employee_ID} className={isDarkMode ? 'hover:bg-slate-800/30' : 'hover:bg-slate-50'}>
                          <td className="px-4 py-3 font-semibold text-slate-900 dark:text-white">
                            <div className="text-slate-900 dark:text-white font-bold">{emp.Employee_Name}</div>
                            <div className="text-[10px] text-slate-505 dark:text-slate-400 font-medium flex items-center gap-1 mt-0.5">
                              <span>{emp.Position}</span>
                              <span>•</span>
                              <span className="font-bold text-slate-505 dark:text-slate-400 text-[9px] uppercase">{citizenship === 'Foreigner' ? 'Foreigner' : 'Malaysian'}</span>
                            </div>
                            {_daysLeft !== null && (
                              <div className={`text-[9px] font-bold mt-1 ${
                                _overdue ? 'text-rose-500' : _daysLeft <= 2 ? 'text-amber-500' : 'text-slate-400 dark:text-slate-500'
                              }`}>
                                {_overdue
                                  ? `⚠ Payment overdue by ${Math.abs(_daysLeft)} day${Math.abs(_daysLeft) !== 1 ? 's' : ''}`
                                  : `⏱ Pay within ${_daysLeft} day${_daysLeft !== 1 ? 's' : ''} (7-day rule)`}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-slate-900 dark:text-white font-bold">RM {emp.Basic_Salary.toFixed(2)}</td>
                          <td className="px-4 py-3 min-w-[280px]">
                            <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                              {allowancesList.map((item, idx) => (
                                <div key={idx} className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    placeholder="e.g. Overtime"
                                    value={item.description}
                                    onChange={(e) => updateAllowanceDescription(emp.Employee_ID, idx, e.target.value)}
                                    className={`w-28 p-1 text-[11px] rounded border ${
                                      isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100' : 'bg-white border-slate-300 text-slate-900 font-bold'
                                    }`}
                                  />
                                  <div className="relative">
                                    <span className="absolute inset-y-0 left-1 flex items-center text-[10px] text-gray-500 dark:text-gray-450 font-bold">RM</span>
                                    <input
                                      type="number"
                                      min="0"
                                      placeholder="0"
                                      value={item.amount || ''}
                                      onChange={(e) => updateAllowanceAmount(emp.Employee_ID, idx, Number(e.target.value))}
                                      className={`w-20 pl-6 pr-1 py-1 text-[11px] font-mono rounded border ${
                                        isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100' : 'bg-white border-slate-300 text-slate-900 font-bold'
                                      }`}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <button 
                              type="button"
                              onClick={() => addAllowanceItem(emp.Employee_ID)}
                              className="mt-1 flex items-center gap-0.5 text-[10px] text-indigo-550 font-bold hover:underline cursor-pointer"
                            >
                              <Plus className="w-3 h-3" />
                              <span>Add Allowance</span>
                            </button>
                          </td>
                          <td className="px-4 py-3 min-w-[280px]">
                            <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                              {deductionsList.map((item, idx) => (
                                <div key={idx} className="flex items-center gap-1">
                                  <input 
                                    type="text"
                                    placeholder="e.g. Advance"
                                    value={item.description}
                                    onChange={(e) => updateDeductionDescription(emp.Employee_ID, idx, e.target.value)}
                                    className={`w-28 p-1 text-[11px] rounded border ${
                                      isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100' : 'bg-white border-slate-300 text-slate-900 font-bold'
                                    }`}
                                  />
                                  <div className="relative">
                                    <span className="absolute inset-y-0 left-1 flex items-center text-[10px] text-gray-500 dark:text-gray-450 font-bold">RM</span>
                                    <input 
                                      type="number"
                                      min="0"
                                      placeholder="0"
                                      value={item.amount || ''}
                                      onChange={(e) => updateDeductionAmount(emp.Employee_ID, idx, Number(e.target.value))}
                                      className={`w-20 pl-6 pr-1 py-1 text-[11px] font-mono rounded border ${
                                        isDarkMode ? 'bg-slate-950 border-slate-800 text-slate-100' : 'bg-white border-slate-300 text-slate-900 font-bold'
                                      }`}
                                    />
                                  </div>
                                  <button 
                                    type="button"
                                    onClick={() => removeDeductionItem(emp.Employee_ID, idx)}
                                    className="p-1 text-rose-500 hover:bg-rose-500/10 rounded cursor-pointer transition-colors"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                            <button 
                              type="button"
                              onClick={() => addDeductionItem(emp.Employee_ID)}
                              className="mt-1 flex items-center gap-0.5 text-[10px] text-indigo-550 font-bold hover:underline cursor-pointer"
                            >
                              <Plus className="w-3 h-3" />
                              <span>Add Deduction</span>
                            </button>
                          </td>
                          <td className="px-4 py-3 font-bold font-mono text-emerald-600 dark:text-emerald-400 text-right">
                            RM {netPay.toFixed(2)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => {
                                processCalculateSelectedPayslip(emp);
                                setIsGeneratorOpen(false);
                              }}
                              className="px-2.5 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 dark:bg-transparent dark:text-emerald-400 dark:border-emerald-700 dark:hover:bg-slate-800 font-black rounded-lg cursor-pointer transition-colors shadow-xs"
                            >
                              Open Preview
                            </button>
                          </td>
                        </tr>
                      );
                    });
                    })()}
                  </tbody>
                </table>
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
                <button 
                  onClick={() => setIsGeneratorOpen(false)}
                  className="px-4 py-2 text-xs font-black rounded-lg bg-white text-slate-700 border border-slate-300 hover:bg-slate-100 dark:bg-transparent dark:text-white dark:border-slate-600 dark:hover:bg-slate-800 cursor-pointer transition-colors shadow-xs"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL 3: PAYSLIP PREVIEW TEMPLATE --- */}
      {previewPayslip && previewEmployee && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm overflow-y-auto flex items-start justify-center py-4 px-2 sm:py-8 sm:px-6">
          <style dangerouslySetInnerHTML={{__html: `
            #printable-payslip {
              transform-origin: top left;
            }
            @media screen and (max-width: 479px) {
              #printable-payslip {
                transform: scale(0.72);
                transform-origin: top left;
                margin-bottom: -160px;
                width: 138.9% !important;
              }
            }
            @media screen and (min-width: 480px) and (max-width: 639px) {
              #printable-payslip {
                transform: scale(0.82);
                transform-origin: top left;
                margin-bottom: -100px;
                width: 121.9% !important;
              }
            }
            @media print {
              @page { size: A4 portrait; margin: 0mm; }
              html, body {
                margin: 0 !important; padding: 0 !important;
                background: white !important;
              }
              body * { visibility: hidden !important; }
              #printable-payslip, #printable-payslip * {
                visibility: visible !important;
                color: #111827 !important;
              }
              #printable-payslip {
                position: fixed !important;
                top: 0 !important; left: 0 !important;
                width: 210mm !important;
                max-width: 210mm !important;
                box-sizing: border-box !important;
                overflow: visible !important;
                height: auto !important;
                background: white !important;
                border: none !important; box-shadow: none !important;
                padding: 12mm 14mm !important;
                margin: 0 !important;
                z-index: 99999 !important;
                transform: none !important;
              }
              #printable-payslip * {
                box-sizing: border-box !important;
              }
              #printable-payslip [class*="grid-cols-2"] {
                display: grid !important;
                grid-template-columns: 1fr 1fr !important;
              }
              #printable-payslip [class*="grid-cols-3"] {
                display: grid !important;
                grid-template-columns: 1fr 1fr 1fr !important;
              }
              #printable-payslip .bg-gray-900,
              #printable-payslip [class*="bg-slate-9"] {
                background: #f0fdf4 !important;
              }
              #printable-payslip [class*="text-white"] { color: #111827 !important; }
              #printable-payslip [class*="text-emerald"] { color: #059669 !important; }
              #printable-payslip [class*="text-rose"] { color: #dc2626 !important; }
              #printable-payslip .payslip-badge { color: white !important; }
              .no-print { display: none !important; visibility: hidden !important; }
              * { -webkit-print-color-adjust: exact !important;
                  print-color-adjust: exact !important; }
            }
          `}} />
          <div className="w-full max-w-3xl rounded-2xl shadow-2xl overflow-hidden">
              <div className={`flex items-center justify-between px-6 py-4 no-print ${isDarkMode ? 'bg-slate-900 border-b border-slate-800' : 'bg-white border-b border-slate-100'}`}>
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-indigo-500" />
                <h3 className="text-sm font-bold uppercase tracking-wider text-indigo-500">
                  Payslip Preview: {(() => {
                    const raw = previewPayslip.Month_Year || '';
                    if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
                      const d = new Date(raw);
                      if (!isNaN(d.getTime())) return d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
                    }
                    return raw || '-';
                  })()}
                </h3>
              </div>
              <button 
                onClick={() => {
                  setPreviewPayslip(null);
                  setPreviewEmployee(null);
                }}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer text-gray-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Document Printable Frame */}
            <div id="printable-payslip" className={`p-8 space-y-6 w-full ${isDarkMode ? 'bg-slate-950' : 'bg-white'}`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-lg font-black tracking-tight text-gray-900 dark:text-white uppercase">
                    {activeOutletProfile.company_name || activeOutletProfile.name}
                  </h1>
                  <p className="text-[10px] text-gray-500 font-bold uppercase">{activeOutletProfile.store_name || activeOutletProfile.name}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-400 max-w-sm mt-1 leading-relaxed">
                    {activeOutletProfile.address}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-400 mt-1">
                    Phone: {activeOutletProfile.phone} | Email: {activeOutletProfile.email}
                  </p>
                </div>

                <div className="text-right">
                  <span className="payslip-badge inline-block px-3 py-1 bg-indigo-600 font-black tracking-widest text-[10px] rounded-md border border-indigo-600" style={{ color: 'white' }}>
                    PAYSLIP RECORD
                  </span>
                  <div className="text-xs font-bold text-gray-900 dark:text-slate-100 mt-2">
                    ID: <span className="font-mono">{previewPayslip.Payslip_ID}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Issue Date: {(() => {
                      const raw = previewPayslip.Issue_Date || '';
                      if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
                        const d = new Date(raw);
                        if (!isNaN(d.getTime())) return d.toLocaleDateString('en-MY', { day: '2-digit', month: 'long', year: 'numeric' });
                      }
                      return raw || '-';
                    })()}
                  </div>
                </div>
              </div>

              <div className="border-b dark:border-slate-800" />

              {/* Detail Blocks */}
<div className="grid grid-cols-2 gap-4">
  <div>
    <h4 className="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1.5 font-mono">
      Employee Details
    </h4>
    <p className="text-sm font-black text-gray-950 dark:text-white">
      {previewEmployee.Employee_Name}
    </p>
    <p className="text-xs text-gray-700 dark:text-slate-400 font-medium">
      IC Number/Passport:{" "}
      <span className="font-mono text-gray-950 dark:text-white font-bold">
        {previewEmployee.IC_Passport}
      </span>
    </p>
    <p className="text-xs text-gray-700 dark:text-slate-400 font-medium">
      Position:{" "}
      <span className="font-bold text-gray-950 dark:text-white">
        {previewEmployee.Position}
      </span>
    </p>
    <p className="text-xs text-gray-700 dark:text-slate-400 font-medium">
      Outlet:{" "}
      <span className="font-bold text-gray-950 dark:text-white">
        {previewEmployee.Branch_Location || previewEmployee.Assigned_Outlet}
      </span>
    </p>
  </div>
  <div>
    <h4 className="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1.5 font-mono">
      Payment details
    </h4>
    <p className="text-xs text-gray-700 dark:text-slate-400 font-medium">
      Month / Year:{" "}
      <strong className="text-gray-950 dark:text-white font-black">
        {(() => {
          const raw = previewPayslip.Month_Year || '';
          if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
            const d = new Date(raw);
            if (!isNaN(d.getTime())) return d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
          }
          return raw || '-';
        })()}
      </strong>
    </p>
    <p className="text-xs text-gray-700 dark:text-slate-400 font-medium">
      Bank Account Details:{" "}
      <span className="font-bold text-gray-950 dark:text-white">
        {previewEmployee.Bank_Details || "Maybank Account"}
      </span>
    </p>
    {previewPayslip.Transfer_Date && (
      <p className="text-xs text-gray-700 dark:text-slate-400 font-medium">
        Wage Transfer Date:{' '}
        <strong className="text-emerald-700 dark:text-emerald-400 font-black">
          {previewPayslip.Transfer_Date}
        </strong>
      </p>
    )}
    {!previewPayslip.Transfer_Date && (
      <p className="text-xs text-gray-700 dark:text-slate-300 font-bold mt-1">
        Transfer Date: _______________________
      </p>
    )}
  </div>
</div>

              {/* Two balanced columns: Earnings vs Deductions */}
              <div className="grid grid-cols-2 gap-6 pt-2">
                <div className="space-y-3">
                  <div className="text-xs font-black text-emerald-800 dark:text-emerald-400 border-b pb-1 dark:border-slate-800 flex justify-between">
                    <span>EARNINGS ITEMIZED</span>
                    <span>AMOUNT</span>
                  </div>
                  <div className="space-y-1.5 text-xs font-semibold">
                    <div className="flex justify-between text-gray-900 dark:text-gray-300">
                      <span>Basic Pay</span>
                      <span className="font-black text-gray-950 dark:text-white">RM {previewPayslip.Basic_Pay.toFixed(2)}</span>
                    </div>
                    {(() => {
                      let list: any[] = [];
                      if (previewPayslip.Allowances_JSON) {
                        try { list = JSON.parse(previewPayslip.Allowances_JSON); } catch {}
                      }
                      list = list.filter((item: any) => !('_bm_paid' in item) && (item.description?.trim() || item.amount > 0));
                      if (list.length > 0) {
                        return list.map((item: any, idx: number) => (
                          <div key={idx} className="flex justify-between text-gray-900 dark:text-gray-200">
                            <span>{item.description || 'Custom Allowance'}</span>
                            <span className="font-bold text-gray-950 dark:text-white">RM {item.amount.toFixed(2)}</span>
                          </div>
                        ));
                      }
                      if (previewPayslip.Custom_Allowances > 0) {
                        return (
                          <div className="flex justify-between text-gray-900 dark:text-gray-300">
                            <span>Custom Allowances</span>
                            <span className="font-bold text-gray-950 dark:text-white">
                              RM {previewPayslip.Custom_Allowances.toFixed(2)}
                            </span>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  <div className="flex justify-between text-xs font-black p-2 bg-emerald-500/10 text-emerald-800 dark:text-emerald-400 rounded-lg">
                    <span>Total Earnings / Gross Pay</span>
                    <span>RM {(previewPayslip.Basic_Pay + previewPayslip.Custom_Allowances).toFixed(2)}</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="text-xs font-black text-rose-700 dark:text-rose-400 border-b pb-1 dark:border-slate-800 flex justify-between">
                    <span>DEDUCTIONS ITEMIZED</span>
                    <span>AMOUNT</span>
                  </div>
                  <div className="space-y-1.5 text-xs font-semibold">
                    <div className="flex justify-between text-gray-900 dark:text-gray-300">
                      <span>Employee EPF ({(previewEmployee.Citizenship || 'Malaysian/PR') === 'Foreigner' ? '2%' : '11%'})</span>
                      <span className="font-extrabold text-gray-950 dark:text-white">RM {previewPayslip.Employee_EPF.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-gray-900 dark:text-gray-300">
                      <span>Employee SOCSO Bracket</span>
                      <span className="font-extrabold text-gray-950 dark:text-white">RM {previewPayslip.Employee_SOCSO.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-gray-900 dark:text-gray-300">
                      <span>Employee EIS Contribution (0.2%)</span>
                      <span className="font-extrabold text-gray-950 dark:text-white">RM {previewPayslip.Employee_EIS.toFixed(2)}</span>
                    </div>
                    {(() => {
                      let list: any[] = [];
                      if (previewPayslip.Deductions_JSON) {
                        try { list = JSON.parse(previewPayslip.Deductions_JSON); } catch {}
                      }
                      list = list.filter((item: any) => !('_bm_paid' in item) && (item.description?.trim() || item.amount > 0));
                      if (list.length > 0) {
                        return list.map((item: any, idx: number) => (
                          <div key={idx} className="flex justify-between text-gray-900 dark:text-gray-200">
                            <span>{item.description || 'Custom Deduction'}</span>
                            <span className="font-bold text-gray-950 dark:text-white">RM {item.amount.toFixed(2)}</span>
                          </div>
                        ));
                      }
                      if (previewPayslip.Custom_Deductions > 0) {
                        return (
                          <div className="flex justify-between text-gray-900 dark:text-gray-350">
                            <span>Custom Deductions</span>
                            <span className="font-bold text-gray-950 dark:text-white font-mono">
                              RM {previewPayslip.Custom_Deductions.toFixed(2)}
                            </span>
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  <div className="flex justify-between text-xs font-black p-2 bg-rose-500/10 text-rose-800 dark:text-rose-400 rounded-lg">
                    <span>Total Sum of Deductions</span>
                    <span>RM {(previewPayslip.Total_Statutory_Deductions + previewPayslip.Custom_Deductions).toFixed(2)}</span>
                  </div>
                </div>
              </div>

              {/* Bold Outstanding Sum Net balance */}
              <div className="p-4 rounded-xl bg-[#f0fdf4] border-2 border-emerald-500 text-gray-900 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h5 className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Employee Final Net Pay</h5>
                  <p className="text-[9px] text-gray-600">Total Net RM transferred directly via Bank Accounts.</p>
                </div>
                <div className="text-2xl font-black text-emerald-600 tracking-tight">
                  RM {previewPayslip.Final_Net_Pay.toFixed(2)}
                </div>
              </div>

              {/* Employer Statutory Metrics */}
              <div className={`p-3.5 rounded-lg border border-dashed text-xs mt-3 ${
                isDarkMode 
                  ? 'border-slate-700 bg-slate-900/40 text-slate-400' 
                  : 'border-gray-200 bg-gray-50/50 text-gray-500'
              }`}>
                <div className={`font-bold uppercase tracking-wider text-[9px] mb-2 ${
                  isDarkMode ? 'text-slate-300' : 'text-gray-700'
                }`}>
                  Employer Statutory Audits (Employer Contributions in RM)
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div>Employer EPF: <strong className={isDarkMode ? 'text-slate-200' : 'text-gray-700'}>RM {previewPayslip.Employer_EPF.toFixed(2)}</strong></div>
                  <div>Employer SOCSO: <strong className={isDarkMode ? 'text-slate-200' : 'text-gray-700'}>RM {previewPayslip.Employer_SOCSO.toFixed(2)}</strong></div>
                  <div>Employer EIS (SIP): <strong className={isDarkMode ? 'text-slate-200' : 'text-gray-700'}>RM {previewPayslip.Employer_EIS.toFixed(2)}</strong></div>
                </div>
              </div>

              {/* Signature line */}
              <div className="flex justify-end mt-10">
                <div className="text-center w-64">
                  <div className={`border-t pt-3 ${isDarkMode ? 'border-slate-600' : 'border-gray-300'}`}>
                    <p className={`text-[10px] font-bold ${isDarkMode ? 'text-slate-300' : 'text-gray-700'}`}>
                      Received By: Employee Signature
                    </p>
                    <div className={`mt-4 border-b ${isDarkMode ? 'border-slate-500' : 'border-gray-400'}`} />
                    <p className={`text-[9px] mt-2 ${isDarkMode ? 'text-slate-500' : 'text-gray-400'}`}>
                      Date
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Action buttons footer */}
            <div className={`px-6 py-4 border-t flex flex-wrap items-center justify-between gap-3 no-print ${isDarkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-100'}`}>
              <div>
                {/* Saved Indicator Badge */}
                {db.payslips.some(p => p.Payslip_ID === previewPayslip.Payslip_ID && p.Is_Saved) ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle className="w-4 h-4" /> Locked & Finalized in Database
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/10 text-indigo-500">
                    Unsaved Draft State Preview
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Save Payslip (writes to database and synchronizes sheets) */}
                {!isStaff && !db.payslips.some(p => p.Payslip_ID === previewPayslip.Payslip_ID && p.Is_Saved) && (
                  <button
                    onClick={() => handleSavePayslip(previewPayslip)}
                    disabled={isSyncing}
                    className="flex items-center gap-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl transition-all duration-150 cursor-pointer shadow-sm"
                    title="Write this payroll slip permanently to the database ledger."
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{isSyncing ? "Saving Record..." : "Save Payslip"}</span>
                  </button>
                )}

                {/* Print button */}
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl cursor-pointer transition-colors"
                  title="Print or save as A4 PDF."
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print / Save A4</span>
                </button>

                <button 
                  onClick={() => {
                    setPreviewPayslip(null);
                    setPreviewEmployee(null);
                  }}
                  className="px-4 py-2 text-xs font-bold rounded-xl bg-gray-150 border border-gray-300 hover:bg-gray-205 text-gray-905 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                >
                  Close Preview
                </button>
              </div>
            </div>
          </div>{/* end A4 card */}
        </div>
      )}

      {/* ── Mark Payment Made modal ── */}
      {markPaymentPayslip && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center
                        justify-center p-4">
          <div className={`w-full max-w-sm rounded-2xl shadow-xl p-6 ${
            isDarkMode
              ? 'bg-slate-900 border border-slate-800 text-slate-100'
              : 'bg-white border border-slate-200 text-slate-900'
          }`}>
            <h3 className="text-sm font-bold text-emerald-600 mb-1">
              Confirm Wage Transfer
            </h3>
            <p className={`text-xs mb-4 ${
              isDarkMode ? 'text-slate-400' : 'text-slate-500'
            }`}>
              Payslip ID: {markPaymentPayslip.Payslip_ID}<br/>
              This action records that wages have been physically transferred
              to the employee. This cannot be undone.
            </p>

            <div className="mb-4">
              <label className="block text-[9px] font-bold text-gray-400
                uppercase mb-1.5">Date of Payment</label>
              <input
                type="date"
                value={transferDateInput}
                onChange={e => setTransferDateInput(e.target.value)}
                className={`w-full px-3 py-2 text-sm rounded-lg border
                  focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                  isDarkMode
                    ? 'bg-slate-800 border-slate-700 text-slate-100 [color-scheme:dark]'
                    : 'bg-gray-50 border-gray-200 text-gray-900 [color-scheme:light]'
                }`}
              />
              <p className="text-[9px] text-slate-400 mt-1">
                This date will appear on the payslip as the wage transfer date.
              </p>
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setMarkPaymentPayslip(null);
                  setTransferDateInput('');
                }}
                className={`px-4 py-2 text-xs font-bold rounded-xl border
                  cursor-pointer ${
                  isDarkMode
                    ? 'border-slate-700 text-slate-300 hover:bg-slate-800'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >Cancel</button>
              <button
                onClick={() => {
                  if (!transferDateInput) {
                    triggerToast('Please select a payment date.', 'warning');
                    return;
                  }
                  const [y, m, d] = transferDateInput.split('-').map(Number);
                  const formatted = new Date(y, m - 1, d).toLocaleDateString('en-MY', {
                    day: '2-digit', month: 'long', year: 'numeric'
                  });
                  const nextDb = {
                    ...db,
                    payslips: db.payslips.map(p =>
                      p.Payslip_ID === markPaymentPayslip.Payslip_ID
                        ? { ...p, Payment_Transferred: true, Transfer_Date: formatted }
                        : p
                    )
                  };
                  setDb(nextDb);
                  savePayslipExtras(markPaymentPayslip.Payslip_ID, {
                    Payment_Transferred: true,
                    Transfer_Date: formatted,
                  });
                  triggerToast('Payment confirmed and recorded.', 'success');
                  setMarkPaymentPayslip(null);
                  setTransferDateInput('');
                  syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation)
                    .catch(() => triggerToast('Sync failed.', 'error'));
                }}
                className="px-4 py-2 text-xs font-bold rounded-xl cursor-pointer
                  bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                ✓ Confirm Payment Made
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
