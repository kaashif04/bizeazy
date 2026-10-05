import React, { useState, useMemo } from 'react';
import { 
  Users, UserPlus, Trash2, Edit, Printer, Download, CheckCircle, 
  Calendar, Coins, CreditCard, Plus, Search, ShieldAlert, X, 
  Briefcase, FileText, Check, DollarSign, HelpCircle, Save, HandCoins
} from 'lucide-react';
import { DatabaseState, Employee, Payslip, CompanyProfile, SalaryAdvance } from '../types';
import { activeOutlet as resolveActiveOutlet, outletLabel } from '../utils/outlets';
import { salaryDeadline, salaryDue, normaliseMonthLabel } from '../utils/notifications';
import {
  payPeriodForLabel, periodLabelFor, isRemindable, describePeriod, round2, isoDate,
  parseLocalDate, monthLabel, epfEmployee, epfEmployer, residencyOf, residencyLabel, Residency, PayBasis,
} from '../utils/payroll';
import { Sheet, sheetBtn } from './ui/Sheet';
import { EmptyState } from './ui/States';

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
  const [empCitizenship, setEmpCitizenship] = useState<Residency>('Malaysian');
  const [empAge, setEmpAge] = useState<number>(30);
  const [empJoiningDate, setEmpJoiningDate] = useState<string>('');
  const [empBearsStatutory, setEmpBearsStatutory] = useState<boolean>(false);
  const [empPayBasis, setEmpPayBasis] = useState<PayBasis>('calendar');
  const [empEndDate, setEmpEndDate] = useState<string>('');

  // Salary advances sheet
  const [advancesFor, setAdvancesFor] = useState<Employee | null>(null);
  const [advDate, setAdvDate] = useState('');
  const [advAmount, setAdvAmount] = useState<number>(0);
  const [advNote, setAdvNote] = useState('');

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
    /** Set on a deduction that recovers a salary advance, so it is never added twice. */
    advance_id?: string;
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
    return resolveActiveOutlet(profiles, activeBranchLocation) || profiles[0];
  }, [profiles, activeBranchLocation]);

  // --- PAYROLL COMPLIANCE REMINDERS (Malaysian Employment Act: 7-day rule) ---
  // Same rule as the bell (utils/notifications.ts salaryDue): the latest ended
  // wage period, from the period each employee was registered in.
  const getPayrollReminders = () => {
    const today = new Date();
    return activeBranchEmployees.flatMap(emp => {
      const period = salaryDue(emp, today);
      if (!period) return [];
      const { daysLeft, overdue } = salaryDeadline(period.end, today);
      const slip = activeBranchPayslips.find(p =>
        p.Employee_ID === emp.Employee_ID && normaliseMonthLabel(p.Month_Year) === period.label);
      return [{
        employee: emp,
        monthLabel: period.label,
        daysUntilDeadline: daysLeft,
        isOverdue: overdue,
        payslipExists: !!slip,
        payslipSaved: slip?.Is_Saved || false,
        paymentDone: slip?.Payment_Transferred || false,
      }];
    }).sort((a, b) => a.daysUntilDeadline - b.daysUntilDeadline);
  };

  // --- STATUTORY MALAYSIAN CALCULATOR FUNCTIONS (2026 update) ---
  // EPF lives in utils/payroll.ts: it is the one rate that differs between a
  // citizen and a permanent resident (at 60+), so it carries a self-check.
  const calculateEmployeeEPF = epfEmployee;
  const calculateEmployerEPF = epfEmployer;

  /**
   * Employee SOCSO contribution (wage ceiling RM6,000 since Oct 2024)
   * Malaysian/PR below 60: 0.5% (Category 1 — both schemes)
   * Malaysian/PR 60+:      0%   (Category 2 — Employment Injury only, employer-only)
   * Foreigner below 60:    0.5% (Category 1 — mandatory invalidity from Jul 2024)
   * Foreigner 60+:         0%   (Category 2 — Employment Injury only)
   */
  const calculateEmployeeSOCSO = (
    grossPay: number,
    citizenship?: string,
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
    citizenship?: string,
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
    citizenship?: string,
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
    citizenship?: string,
    age = 30
  ): number => {
    if (citizenship === 'Foreigner') return 0;
    if (age >= 60) return 0;
    const capped = Math.min(grossPay, 6000);
    return Number((capped * 0.002).toFixed(2)); // 0.2%
  };

  /**
   * SKBBK — Skim Keselamatan Bencana Bukan Kerja ("Lindung 24 Jam")
   * Effective 1 June 2026. Employee-only PERKESO non-employment injury scheme.
   * Phase 1 rate: 0.75% of wages, wage ceiling RM6,000 (max RM45/month).
   *   Phase 2 (from 1 Jun 2028): 1.00%  |  Phase 3 (from 1 Jun 2030): 1.25%
   * Mandatory for foreign workers; Cabinet ruled voluntary for Malaysians 8 Jul 2026.
   * Not applicable to age 60+ (Category 2 — employment injury only, no SKBBK).
   */
  const calculateSKBBK = (
    grossPay: number,
    citizenship?: string,
    age = 30
  ): number => {
    if (citizenship !== 'Foreigner') return 0; // voluntary for Malaysians and PRs — not auto-deducted
    if (age >= 60) return 0; // Category 2 employees: employment injury only, no SKBBK
    const capped = Math.min(grossPay, 6000);
    return Number((capped * 0.0075).toFixed(2)); // Phase 1: 0.75%
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
      setEmpCitizenship(residencyOf(employee.Citizenship));
      setEmpAge(Number((employee as any).Age) || 30);
      setEmpJoiningDate(employee.Joining_Date || '');
      setEmpBearsStatutory(employee.Employer_Bears_Statutory === true);
      setEmpPayBasis(employee.Pay_Basis === 'anniversary' ? 'anniversary' : 'calendar');
      setEmpEndDate(employee.End_Date || '');
    } else {
      setEditingEmployee(null);
      setEmpName('');
      setEmpIC('');
      setEmpPosition('');
      setEmpBank('');
      setEmpSalary(1700);
      setEmpCitizenship('Malaysian');
      setEmpAge(30);
      setEmpJoiningDate('');
      setEmpBearsStatutory(false);
      setEmpPayBasis('calendar');
      setEmpEndDate('');
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

    if (empEndDate && empJoiningDate && empEndDate < empJoiningDate) {
      triggerToast("The last working day cannot be before the joining date.", "error");
      return;
    }

    let updatedEmployees = [...db.employees];
    // Rows are keyed by Employee_ID end to end (dedupe on read and on write), so
    // a repeated ID would silently fold two people into one. The ID is only the
    // clock's last five digits, so check it against everyone on file.
    let newId = '';
    if (!editingEmployee) {
      let n = Date.now();
      do { newId = `EMP-${String(n++).slice(-5)}`; } while (db.employees.some(e => e.Employee_ID === newId));
    }

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
              Employer_Bears_Statutory: empBearsStatutory,
              Pay_Basis: empPayBasis,
              End_Date: empEndDate || undefined,
            }
          : emp
      );
      triggerToast("Updating Employee settings internally...", "info");
    } else {
      // Creation Mode
      const newEmp: Employee = {
        Employee_ID: newId,
        Employee_Name: empName,
        IC_Passport: empIC,
        Position: empPosition,
        Assigned_Outlet: resolveActiveOutlet(profiles, activeBranchLocation)?.id || '',
        Basic_Salary: empSalary,
        Bank_Details: empBank,
        Branch_Location: activeBranchLocation,
        Citizenship: empCitizenship,
        Age: empAge,
        Joining_Date: empJoiningDate,
        Employer_Bears_Statutory: empBearsStatutory,
        Pay_Basis: empPayBasis,
        End_Date: empEndDate || undefined,
        // Reminders start from today's period; earlier months stay generatable.
        Registered_On: isoDate(new Date()),
      };
      updatedEmployees.push(newEmp);
      triggerToast("Adding new Employee to the roster...", "info");
    }

    const nextDb = { ...db, employees: updatedEmployees };
    setDb(nextDb);
    setIsEmployeeModalOpen(false);

    // Save to server
    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast("Employee saved.", "success");
    } catch (err: any) {
      triggerToast(`Not saved yet: ${err.message}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDeleteEmployee = async (empId: string) => {
    if (isStaff) {
      triggerToast("Access Denied: Restricted read-only view.", "error");
      return;
    }
    if (!window.confirm("Remove this employee permanently?\n\nIf they have resigned, Edit them and set a last working day instead: their records stay and no further salary falls due.")) return;

    const nextDb = {
      ...db,
      employees: db.employees.filter(e => e.Employee_ID !== empId)
    };
    setDb(nextDb);
    triggerToast("Removing employee details from local states...", "info");

    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast("Roster updated.", "success");
    } catch (err: any) {
      triggerToast(`Not saved yet: ${err.message}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  // --- SALARY ADVANCES ---
  // Stored on the employee; each is recovered as a deduction on the payslip of
  // the wage period it was taken in (see handleOpenGenerator).
  const openAdvances = (employee: Employee) => {
    setAdvancesFor(employee);
    setAdvDate(isoDate(new Date()));
    setAdvAmount(0);
    setAdvNote('');
  };

  /** Saved payslips already recovering this advance — it cannot be deleted under them. */
  const advanceOnPayslip = (advanceId: string) =>
    db.payslips.find(p => p.Is_Saved && (p.Deductions_JSON || '').includes(advanceId));

  const saveAdvances = async (employee: Employee, advances: SalaryAdvance[], message: string) => {
    const nextDb = {
      ...db,
      employees: db.employees.map(e => e.Employee_ID === employee.Employee_ID ? { ...e, Advances: advances } : e),
    };
    setDb(nextDb);
    setAdvancesFor({ ...employee, Advances: advances });
    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast(message, "success");
    } catch (err: any) {
      triggerToast(`Not saved yet: ${err.message}`, "error");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleAddAdvance = (e: React.FormEvent) => {
    e.preventDefault();
    if (!advancesFor) return;
    const taken = parseLocalDate(advDate);
    if (!taken || !(advAmount > 0)) {
      triggerToast("Enter the date and an amount above zero.", "warning");
      return;
    }
    if (!payPeriodForLabel(advancesFor, periodLabelFor(advancesFor, taken))) {
      triggerToast(`${advancesFor.Employee_Name} was not employed on ${advDate}.`, "warning");
      return;
    }
    const advance: SalaryAdvance = {
      id: `ADV-${Date.now().toString(36)}`,
      date: advDate,
      amount: round2(advAmount),
      note: advNote.trim() || undefined,
    };
    saveAdvances(advancesFor, [...(advancesFor.Advances || []), advance],
      `Advance recorded. It will be deducted from the ${periodLabelFor(advancesFor, taken)} payslip.`);
    setAdvAmount(0);
    setAdvNote('');
  };

  const handleRemoveAdvance = (advance: SalaryAdvance) => {
    if (!advancesFor) return;
    const slip = advanceOnPayslip(advance.id);
    if (slip) {
      triggerToast(`Already deducted on payslip ${slip.Payslip_ID}. Remove it from that payslip first.`, "error");
      return;
    }
    if (!window.confirm(`Delete the RM ${advance.amount.toFixed(2)} advance of ${advance.date}?`)) return;
    saveAdvances(advancesFor, (advancesFor.Advances || []).filter(a => a.id !== advance.id), "Advance deleted.");
  };

  // Open multi-step Payslip Generation workspace.
  // Accepts an optional targetMonth (e.g. from a compliance reminder, which
  // knows exactly which overdue month it means) so the workspace opens
  // pointed at the right month instead of whatever selectedMonthYear happened
  // to be. Passing it as a parameter rather than calling setSelectedMonthYear
  // first matters: React state updates are async, so a caller that did
  // setSelectedMonthYear(month) immediately followed by handleOpenGenerator()
  // would still have this function close over the *old* selectedMonthYear
  // value below, and silently load the wrong month's saved allowances/deductions.
  const handleOpenGenerator = (targetMonth?: string) => {
    if (isStaff) {
      triggerToast("Access Denied: Staff accounts cannot generate payslips.", "error");
      return;
    }
    if (activeBranchEmployees.length === 0) {
      triggerToast("No active employees listed on this outlet. Please add an employee first.", "warning");
      return;
    }
    const monthForLookup = targetMonth || selectedMonthYear;
    // Initialize black inputs or load saved values with description-amount pairs
    const freshAllowances: Record<string, ItemizedItem[]> = {};
    const freshDeductions: Record<string, ItemizedItem[]> = {};
    activeBranchEmployees.forEach(e => {
      const savedSlip = activeBranchPayslips.find(p => p.Employee_ID === e.Employee_ID && normaliseMonthLabel(p.Month_Year) === monthForLookup);
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
        freshDeductions[e.Employee_ID] = [];
      }

      // Recover any advance taken in this period that the list does not carry yet.
      const saved = freshDeductions[e.Employee_ID];
      const list = (Array.isArray(saved) ? saved : []).filter(d => d.description?.trim() || d.amount > 0);
      (e.Advances || []).forEach(a => {
        const taken = parseLocalDate(a.date);
        if (!taken || periodLabelFor(e, taken) !== monthForLookup) return;
        if (list.some(d => d.advance_id === a.id)) return;
        list.push({ description: `Salary advance ${a.date}${a.note ? ` (${a.note})` : ''}`, amount: a.amount, advance_id: a.id });
      });
      freshDeductions[e.Employee_ID] = list.length ? list : [{ description: '', amount: 0 }];
    });
    setAllowancesMap(freshAllowances);
    setDeductionsMap(freshDeductions);
    if (targetMonth) setSelectedMonthYear(targetMonth);
    setIsGeneratorOpen(true);
  };

  // Create payslips and generate previews inside local states
  const processCalculateSelectedPayslip = (emp: Employee) => {
    const period = payPeriodForLabel(emp, selectedMonthYear);
    if (!period) {
      triggerToast(`${emp.Employee_Name} was not employed in ${selectedMonthYear}.`, "warning");
      return;
    }
    const basicPay = round2(emp.Basic_Salary * period.fraction);
    const allowancesList = allowancesMap[emp.Employee_ID] || [];
    const deductionsList = deductionsMap[emp.Employee_ID] || [];
    const allowanceSum = allowancesList.reduce((acc, curr) => acc + (curr.amount || 0), 0);
    const customDeductionSum = deductionsList.reduce((acc, curr) => acc + (curr.amount || 0), 0);
    
    // Statutory contributions are on wages actually paid, so a part month's
    // prorated basic is what they are calculated on.
    const grossPay = basicPay + allowanceSum;
    const citizenship = emp.Citizenship;

    const empAge = Number(emp.Age) || 30;
    const epfEmployee = calculateEmployeeEPF(grossPay, citizenship, empAge);
    const epfEmployer = calculateEmployerEPF(grossPay, citizenship, empAge);
    
    const socsoEmployee = calculateEmployeeSOCSO(grossPay, citizenship, empAge);
    const socsoEmployer = calculateEmployerSOCSO(grossPay, citizenship, empAge);

    const eisEmployee = calculateEmployeeEIS(grossPay, citizenship, empAge);
    const eisEmployer = calculateEmployerEIS(grossPay, citizenship, empAge);
    const skbbk = calculateSKBBK(grossPay, citizenship, empAge);

    const totalStatutory = Number((epfEmployee + socsoEmployee + skbbk + eisEmployee).toFixed(2));

    // If the employer has opted to bear this employee's own EPF/SOCSO/EIS/SKBBK
    // share, the amount is still calculated and still shown as a deduction
    // above (it still goes to the employee's real statutory accounts) — this
    // offset just adds a matching earnings line so net pay works out to gross
    // pay minus only the non-statutory deductions. See Employee.Employer_Bears_Statutory.
    const statutoryOffset = emp.Employer_Bears_Statutory ? totalStatutory : 0;
    const finalNet = Number((grossPay - totalStatutory - customDeductionSum + statutoryOffset).toFixed(2));
    if (finalNet < 0) {
      // Usually an advance bigger than a part month's pay: recover the rest next month.
      triggerToast(`Deductions exceed ${emp.Employee_Name}'s pay by RM ${Math.abs(finalNet).toFixed(2)}. Reduce the deduction and carry the rest to next month.`, "warning");
    }

    const freshPayslip: Payslip = {
      Payslip_ID: `PAY-${emp.Employee_ID}-${selectedMonthYear.replace(' ', '-')}`,
      Employee_ID: emp.Employee_ID,
      Issue_Date: new Date().toISOString().substring(0, 10),
      Month_Year: selectedMonthYear,
      Basic_Pay: basicPay,
      Pay_Period: period.fraction < 1 || emp.Pay_Basis === 'anniversary' ? describePeriod(period) : '',
      Custom_Allowances: allowanceSum,
      Total_Allowances: allowanceSum,
      Employee_EPF: epfEmployee,
      Employer_EPF: epfEmployer,
      Employee_SOCSO: socsoEmployee,
      Employer_SOCSO: socsoEmployer,
      Employee_EIS: eisEmployee,
      Employer_EIS: eisEmployer,
      Employee_SKBBK: skbbk,
      Total_Statutory_Deductions: totalStatutory,
      Custom_Deductions: customDeductionSum,
      Employer_Statutory_Offset: statutoryOffset,
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
    triggerToast("Saving payslip…", "info");

    // Clear preview but show updated details in dashboard
    setPreviewPayslip(finalizedSlips); // Keep saved state visible

    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast(`Payslip ${finalizedSlips.Payslip_ID} stored successfully!`, "success");
    } catch (err: any) {
      triggerToast(`Not saved yet: ${err.message}`, "error");
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
            Limited Staff Privileges — Read Only Mode. Staff accounts are prevented from editing the employee roster or saving payslip records. You can browse, calculate, print, and download records freely.
          </div>
        </div>
      )}      {/* Roster Header and Trigger CTAs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 
            className="text-xl font-bold tracking-tight text-ink-900 dark:text-ink-100 flex items-center gap-2"
          >
            <Users 
              className="w-5 h-5 text-brand-500" 
            />
            Payroll & Employee Management
          </h2>
          <p className="text-xs text-ink-500 dark:text-ink-400 font-medium">
            Outlet Specific: <span className="text-ink-900 dark:text-white font-black">{activeBranchLocation}</span> | Total Registered Staff: {activeBranchEmployees.length}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Add Employee Button */}
          {!isStaff && (
            <button
              id="add-employee-btn"
              onClick={() => handleOpenEmployeeModal()}
              className="flex items-center gap-1 bg-brand-600 hover:bg-brand-700 text-white font-extrabold tracking-tight text-xs px-3.5 py-2.5 rounded-lg cursor-pointer transition-colors border border-transparent shadow-sm"
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
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold tracking-tight text-xs px-3.5 py-2.5 rounded-lg cursor-pointer transition-colors shadow-sm border border-transparent"
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
        <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-ink-500">
          <Search className="w-4 h-4" />
        </span>
        <input 
          type="text"
          placeholder="Search employees by name, passport or position..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className={`w-full pl-9 pr-4 py-2 text-xs rounded-lg border focus:ring-1 focus:ring-brand-500 transition-colors ${
            isDarkMode 
              ? 'bg-ink-900 border-ink-700 text-ink-100 focus:border-brand-500' 
              : 'bg-white border-ink-300 text-ink-950 focus:border-brand-500 font-semibold'
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
              ? 'bg-ink-900/50 border-ink-800'
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
                      ? 'bg-ink-800 border-ink-700'
                      : 'bg-white border-ink-200')
              }`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`text-xs font-black ${
                      isDarkMode ? 'text-white' : 'text-ink-900'
                    }`}>{r.employee.Employee_Name}</p>
                    <span className={`text-2xs font-bold px-2 py-0.5
                      rounded-full ${
                      isDarkMode
                        ? 'bg-ink-700 text-ink-300'
                        : 'bg-ink-100 text-ink-600'
                    }`}>{r.monthLabel}</span>
                    {r.paymentDone && (
                      <span className="text-2xs font-bold px-2 py-0.5
                        rounded-full bg-emerald-100 text-emerald-700
                        dark:bg-emerald-900/40 dark:text-emerald-400">
                        ✓ Payment Confirmed
                      </span>
                    )}
                  </div>
                  <p className={`text-2xs mt-0.5 ${
                    r.isOverdue
                      ? 'text-rose-500 font-bold'
                      : r.daysUntilDeadline <= 2
                      ? 'text-amber-600 dark:text-amber-400 font-bold'
                      : (isDarkMode ? 'text-ink-500' : 'text-ink-500')
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
                      onClick={() => handleOpenGenerator(r.monthLabel)}
                      className="px-3.5 py-2.5 text-2xs font-bold rounded-lg
                        cursor-pointer bg-brand-600 hover:bg-brand-700
                        active:bg-brand-800 text-white transition-colors"
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
                      className="px-3 py-1.5 text-2xs font-bold rounded-lg
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
        <div className="rounded-xl border border-ink-200 dark:border-ink-800 bg-white dark:bg-ink-900">
          {searchTerm.trim() ? (
            <EmptyState
              icon={<Search />}
              title={`No one matches "${searchTerm.trim()}"`}
              body="Search covers name, position and IC or passport number."
              action={{ label: 'Clear search', onClick: () => setSearchTerm('') }}
            />
          ) : (
            <EmptyState
              icon={<Users />}
              title={`No staff at ${activeBranchLocation} yet`}
              body="Add an employee to start running payroll. EPF, SOCSO and EIS are worked out for you, and salary reminders follow."
              action={isStaff ? undefined : { label: 'Add Employee', icon: <UserPlus />, onClick: () => handleOpenEmployeeModal() }}
            />
          )}
        </div>
      ) : (
        <div className={`rounded-xl border ${isDarkMode ? 'border-ink-800 bg-ink-900' : 'border-ink-200 bg-white shadow-sm'}`}>
          {/* Phone: one card per employee. Six columns of horizontal scroll is
              not a roster anyone can check during service. */}
          <ul className="md:hidden divide-y divide-ink-100 dark:divide-ink-800">
            {filteredEmployees.map((employee) => (
              <li key={employee.Employee_ID} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-brand-50 dark:bg-brand-950/50 flex items-center justify-center text-sm font-black text-brand-700 dark:text-brand-300 flex-shrink-0 uppercase">
                    {employee.Employee_Name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-ink-900 dark:text-white truncate">{employee.Employee_Name}</p>
                    <p className="text-2xs text-ink-500 dark:text-ink-400 font-mono mt-0.5 truncate">
                      {employee.Employee_ID} · {employee.IC_Passport}
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-2xs font-bold bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200">
                        <Briefcase className="w-3 h-3" />
                        {employee.Position}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded-full text-2xs font-bold ${employee.Citizenship === 'Foreigner' ? 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300' : 'bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-300'}`}>
                        {residencyLabel(employee.Citizenship)}
                      </span>
                      {employee.End_Date && (
                        <span className="px-1.5 py-0.5 rounded-full text-2xs font-bold bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300">
                          Left {employee.End_Date}
                        </span>
                      )}
                      {employee.Employer_Bears_Statutory && (
                        <span className="px-1.5 py-0.5 rounded-full text-2xs font-bold bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300">
                          Statutory borne
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm font-black font-mono text-ink-900 dark:text-white tabular flex-shrink-0">
                    RM {employee.Basic_Salary.toFixed(2)}
                  </p>
                </div>
                {employee.Bank_Details && (
                  <p className="text-2xs text-ink-500 dark:text-ink-400 font-mono mt-2 truncate" title={employee.Bank_Details}>
                    {employee.Bank_Details}
                  </p>
                )}
                <div className={`grid gap-2 mt-3 ${isStaff ? 'grid-cols-1' : 'grid-cols-4'}`}>
                  <button
                    onClick={() => processCalculateSelectedPayslip(employee)}
                    className="tap flex items-center justify-center gap-1.5 rounded-lg text-2xs font-bold cursor-pointer transition-colors bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/70"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Payslip
                  </button>
                  {!isStaff && (
                    <button
                      onClick={() => openAdvances(employee)}
                      className="tap flex items-center justify-center gap-1.5 rounded-lg text-2xs font-bold cursor-pointer transition-colors bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/70"
                    >
                      <HandCoins className="w-3.5 h-3.5" />
                      Advance
                    </button>
                  )}
                  {!isStaff && (
                    <button
                      onClick={() => handleOpenEmployeeModal(employee)}
                      className="tap flex items-center justify-center gap-1.5 rounded-lg text-2xs font-bold cursor-pointer transition-colors bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-200 hover:bg-ink-200 dark:hover:bg-ink-700"
                    >
                      <Edit className="w-3.5 h-3.5" />
                      Edit
                    </button>
                  )}
                  {!isStaff && (
                    <button
                      onClick={() => handleDeleteEmployee(employee.Employee_ID)}
                      className="tap flex items-center justify-center gap-1.5 rounded-lg text-2xs font-bold cursor-pointer transition-colors bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-950/70"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <div className="hidden md:block overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className={`border-b text-2xs font-bold uppercase tracking-wider ${isDarkMode ? 'bg-ink-950/40 border-ink-800 text-ink-500' : 'bg-ink-50 border-ink-200 text-ink-700'}`}>
              <tr>
                <th className="px-5 py-3">Employee Name</th>
                <th className="px-5 py-3">IC / Passport</th>
                <th className="px-5 py-3">Position</th>
                <th className="px-5 py-3">Basic Monthly Salary</th>
                <th className="px-5 py-3">Bank Details</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              {filteredEmployees.map((employee) => {
                const payslipIdPart = `${employee.Employee_ID}-${selectedMonthYear.replace(' ', '-')}`;
                const savedSlipInMonth = activeBranchPayslips.find(p => p.Employee_ID === employee.Employee_ID && p.Month_Year === selectedMonthYear);

                return (
                  <tr key={employee.Employee_ID} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40 transition-colors">
                    <td className="px-5 py-4 font-semibold text-ink-900 dark:text-ink-100 flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-brand-50 dark:bg-brand-950/50 flex items-center justify-center text-xs text-brand-700 dark:text-brand-500 font-black uppercase">
                        {employee.Employee_Name.charAt(0)}
                      </div>
                      <div>
                        <div className="font-bold text-ink-900 dark:text-white">{employee.Employee_Name}</div>
                        <div className="text-2xs text-ink-500 dark:text-ink-400 flex items-center gap-1.5 mt-0.5 font-medium">
                          <span>{employee.Employee_ID}</span>
                          <span>•</span>
                          <span className={`px-1 rounded text-2xs font-bold ${employee.Citizenship === 'Foreigner' ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400' : 'bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-300'}`}>
                            {residencyLabel(employee.Citizenship)}
                          </span>
                          {employee.End_Date && (
                            <span className="px-1 rounded text-2xs font-bold bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300">
                              Left {employee.End_Date}
                            </span>
                          )}
                          {employee.Employer_Bears_Statutory && (
                            <span
                              className="px-1 rounded text-2xs font-bold bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-400"
                              title="Employer bears this employee's EPF/SOCSO/EIS share — net pay equals gross pay minus non-statutory deductions"
                            >
                              EPF/SOCSO Borne
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-ink-500 dark:text-ink-400 font-medium font-mono">{employee.IC_Passport}</td>
                    <td className="px-5 py-4">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-bold bg-ink-50 border border-ink-300 dark:border-ink-800 dark:bg-ink-800 text-ink-900 dark:text-ink-300">
                        <Briefcase className="w-3 h-3 text-ink-500" />
                        {employee.Position}
                      </span>
                    </td>
                    <td className="px-5 py-4 font-black text-ink-900 dark:text-white">
                      RM {employee.Basic_Salary.toFixed(2)}
                    </td>
                    <td className="px-5 py-4 text-ink-500 dark:text-ink-400 font-medium max-w-xs truncate" title={employee.Bank_Details}>
                      {employee.Bank_Details || '-'}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Calculate Preview Shortcut */}
                        <button
                          onClick={() => processCalculateSelectedPayslip(employee)}
                          className="p-1 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 rounded-md cursor-pointer transition-colors text-2xs font-bold flex items-center gap-1"
                          title="Calculate and View Payslip Document Details."
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>View Slip</span>
                        </button>

                        {/* Salary advances */}
                        {!isStaff && (
                          <button
                            onClick={() => openAdvances(employee)}
                            className="p-1 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/20 rounded-md cursor-pointer transition-colors text-2xs font-bold flex items-center gap-1"
                            title="Record a salary advance or emergency payment."
                          >
                            <HandCoins className="w-3.5 h-3.5" />
                            <span>Advance</span>
                          </button>
                        )}

                        {/* Edit Roster */}
                        {!isStaff && (
                          <button
                            onClick={() => handleOpenEmployeeModal(employee)}
                            className="p-1 text-brand-500 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-950/20 rounded-md cursor-pointer transition-colors"
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
        </div>
      )}

      {/* Registry of History Month Payslips */}
      <div className={`p-5 rounded-2xl border ${isDarkMode ? 'bg-ink-900/30 border-ink-800' : 'bg-ink-50/50 border-ink-200'}`}>
        <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
          <div>
            <h3 className="text-xs font-bold text-ink-900 dark:text-ink-200 uppercase tracking-wider">
              Past Payslip Archive
            </h3>
            <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1 font-medium">
              View and re-print previously saved payslips.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-2xs font-bold text-ink-500 uppercase tracking-wider">Filter Month:</label>
            <select
              value={archiveFilterMonth}
              onChange={e => setArchiveFilterMonth(e.target.value)}
              className={`text-xs font-semibold rounded-lg border px-2.5 py-1.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                isDarkMode ? 'bg-ink-800 border-ink-700 text-ink-200' : 'bg-white border-ink-200 text-ink-800'
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
              <EmptyState
                compact
                icon={<FileText />}
                title={archiveFilterMonth !== '__all__' ? `No payslips for ${archiveFilterMonth}` : 'No saved payslips yet'}
                body={archiveFilterMonth !== '__all__'
                  ? 'Nothing was saved for that month at this branch.'
                  : 'Payslips you generate and save land here, ready to reprint.'}
                action={archiveFilterMonth !== '__all__'
                  ? { label: 'Show all months', onClick: () => setArchiveFilterMonth('__all__') }
                  : undefined}
              />
            );
          }
          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {filtered.map(slip => {
                const matchedEmp = db.employees.find(e => e.Employee_ID === slip.Employee_ID);
                return (
                  <div key={slip.Payslip_ID} className={`p-3 rounded-lg border flex items-center justify-between gap-4 transition-all duration-150 ${isDarkMode ? 'bg-ink-900 border-ink-800' : 'bg-white border-ink-200 shadow-sm'}`}>
                    <div className="min-w-0">
                      <h4 className="text-2xs font-bold text-ink-900 dark:text-ink-100 truncate max-w-[150px]">
                        {matchedEmp?.Employee_Name || "Unregistered Employee"}
                      </h4>
                      <p className="text-2xs font-semibold text-ink-500 mt-0.5">{(() => {
                        const raw = slip.Month_Year || slip.Issue_Date || '';
                        if (raw.includes('T') || /^\d{4}-\d{2}/.test(raw)) {
                          const d = new Date(raw);
                          if (!isNaN(d.getTime())) {
                            return d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
                          }
                        }
                        return raw || '-';
                      })()}</p>
                      <div className="text-2xs font-bold text-brand-500 mt-0.5">RM {slip.Final_Net_Pay.toFixed(2)}</div>
                      {slip.Payment_Transferred ? (
                        <span className="text-2xs font-bold text-emerald-600
                          dark:text-emerald-400 flex items-center gap-1">
                          ✓ Wages Transferred {slip.Transfer_Date ? `· ${slip.Transfer_Date}` : ''}
                        </span>
                      ) : (
                        <span className="text-2xs font-bold text-amber-500
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
                        className="flex p-1 bg-brand-50 hover:bg-brand-100 text-brand-700 dark:bg-brand-950/40 dark:text-brand-400 rounded-md text-2xs font-bold items-center gap-1 transition-colors cursor-pointer"
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
                          className="flex p-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 rounded-md text-2xs font-bold items-center gap-1 transition-colors cursor-pointer"
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
          <div className={`w-full max-w-md p-6 rounded-2xl shadow-xl transition-all ${isDarkMode ? 'bg-ink-900 border border-ink-800 text-ink-100' : 'bg-white border border-ink-200 text-ink-900'}`}>
            <div className="flex items-center justify-between mb-4 border-b pb-3 dark:border-ink-800 border-ink-100">
              <h3 className="text-sm font-bold uppercase tracking-wider text-brand-500">
                {editingEmployee ? "Edit Employee Details" : "Register New Employee"}
              </h3>
              <button 
                onClick={() => setIsEmployeeModalOpen(false)}
                className="p-1.5 hover:bg-ink-100 dark:hover:bg-ink-800 rounded-lg cursor-pointer text-ink-500 hover:text-ink-700 dark:text-ink-400 dark:hover:text-ink-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEmployee} className="space-y-4">
              <div>
                <label className="block text-2xs font-bold uppercase text-ink-700 dark:text-ink-300 mb-1">Employee Full Name *</label>
                <input 
                  type="text"
                  required
                  placeholder="e.g. Mohd Kaiser"
                  value={empName}
                  onChange={(e) => setEmpName(e.target.value)}
                  className={`w-full p-2.5 text-xs rounded-lg border ${
                    isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100 focus:border-brand-500' : 'bg-white border-ink-300 text-ink-900 font-semibold focus:border-brand-500'
                  }`}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-2xs font-bold uppercase text-ink-700 dark:text-ink-300 mb-1">IC / Passport Number *</label>
                  <input 
                    type="text"
                    required
                    placeholder="e.g. 960218-14-1234"
                    value={empIC}
                    onChange={(e) => setEmpIC(e.target.value)}
                    className={`w-full p-2.5 text-xs rounded-lg border ${
                      isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100 focus:border-brand-500' : 'bg-white border-ink-300 text-ink-900 font-semibold focus:border-brand-500'
                    }`}
                  />
                </div>
                <div>
                  <label className="block text-2xs font-bold uppercase text-ink-700 dark:text-ink-300 mb-1">Position *</label>
                  <input 
                    type="text"
                    required
                    placeholder="e.g. Head Chef"
                    value={empPosition}
                    onChange={(e) => setEmpPosition(e.target.value)}
                    className={`w-full p-2.5 text-xs rounded-lg border ${
                      isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100 focus:border-brand-500' : 'bg-white border-ink-300 text-ink-900 font-semibold focus:border-brand-500'
                    }`}
                  />
                </div>
              </div>

              <div>
                <label className="block text-2xs font-bold uppercase text-ink-700 dark:text-ink-300 mb-2">Citizenship Status *</label>
                <div className="grid grid-cols-3 gap-2" role="radiogroup">
                  {([['Malaysian', 'Malaysian'], ['PR', 'Permanent Resident'], ['Foreigner', 'Foreigner']] as [Residency, string][]).map(([value, label]) => (
                    <label
                      key={value}
                      className={`tap flex items-center justify-center text-center px-2 rounded-lg border text-xs font-bold cursor-pointer transition-colors ${
                        empCitizenship === value
                          ? 'bg-brand-600 border-brand-600 text-white'
                          : 'border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800'
                      }`}
                    >
                      <input
                        type="radio"
                        name="citizenship"
                        value={value}
                        checked={empCitizenship === value}
                        onChange={() => setEmpCitizenship(value)}
                        className="sr-only"
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1.5 leading-relaxed">
                  {empCitizenship === 'PR'
                    ? 'Charged as a local for EPF, SOCSO and EIS. From age 60, EPF continues at 5.5% employee and 6.5% employer (citizens stop at 0% and 4%).'
                    : empCitizenship === 'Foreigner'
                    ? 'EPF 2% each side, SOCSO, and SKBBK. No EIS.'
                    : 'EPF, SOCSO and EIS at local rates.'}
                </p>
              </div>

              <div className={`p-3 rounded-xl border ${
                isDarkMode ? 'bg-ink-950/50 border-ink-800' : 'bg-brand-50/50 border-brand-200'
              }`}>
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={empBearsStatutory}
                    onChange={(e) => setEmpBearsStatutory(e.target.checked)}
                    className="mt-0.5 cursor-pointer accent-brand-600 w-3.5 h-3.5 shrink-0"
                  />
                  <span className="text-xs font-bold text-ink-900 dark:text-white leading-snug">
                    Employer bears this employee's EPF, SOCSO &amp; EIS share
                  </span>
                </label>
                <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1.5 leading-relaxed">
                  Statutory deductions are still calculated &amp; remitted normally. The payslip adds an offsetting earnings line so the employee receives their full stated salary. Confirm with your payroll agent before use.
                </p>
              </div>

              <div>
                <label className="block text-2xs font-bold text-ink-500 uppercase mb-1">Age (for statutory rates)</label>
                <input
                  type="number"
                  min={18}
                  max={80}
                  value={empAge}
                  onChange={(e) => setEmpAge(Number(e.target.value))}
                  placeholder="e.g. 35"
                  className={`w-full border rounded-xl px-3 py-2 text-xs focus:outline-none ${
                    isDarkMode
                      ? 'bg-ink-950 border-ink-800 text-ink-100'
                      : 'bg-ink-50 border-ink-200 text-ink-900'
                  }`}
                />
                <p className="text-2xs text-ink-500 mt-0.5">
                  Affects EPF bracket (60+), SOCSO category, and EIS eligibility (18–60 locals only)
                </p>
              </div>

              <div>
                <label className="block text-2xs font-bold uppercase text-ink-700 dark:text-ink-300 mb-1">Basic Monthly Salary (RM) *</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-ink-500 text-xs font-bold font-mono">RM</span>
                  <input 
                    type="number"
                    required
                    min="1700"
                    step="50"
                    placeholder="2500"
                    value={empSalary}
                    onChange={(e) => setEmpSalary(Number(e.target.value))}
                    className={`w-full pl-9 pr-3 py-2.5 text-xs rounded-lg border ${
                      isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100 focus:border-brand-500 font-mono' : 'bg-white border-ink-300 text-ink-900 font-semibold focus:border-brand-500 font-mono'
                    }`}
                  />
                </div>
                <p className="text-2xs text-ink-500 dark:text-ink-400 font-semibold mt-1">Malaysian national minimum wage requirement is RM 1,700.</p>
              </div>

              <div>
                <label className="block text-2xs font-bold text-ink-500
                  uppercase mb-1">Joining Date *</label>
                <input
                  type="date"
                  value={empJoiningDate}
                  onChange={e => setEmpJoiningDate(e.target.value)}
                  max={new Date().toISOString().split('T')[0]}
                  className={`w-full px-2.5 py-2 text-xs rounded-lg border
                    focus:outline-none focus:ring-1 focus:ring-brand-500
                    ${isDarkMode
                      ? 'bg-ink-900 border-ink-700 text-ink-100 [color-scheme:dark]'
                      : 'bg-white border-ink-200 text-ink-800 [color-scheme:light]'}`}
                />
                <p className="text-2xs text-ink-500 mt-0.5">
                  An earlier date is fine: past months can still be generated, but reminders start from this month.
                </p>
              </div>

              <div>
                <label className="block text-2xs font-bold uppercase text-ink-700 dark:text-ink-300 mb-2">Salary basis</label>
                <div className="space-y-2" role="radiogroup">
                  {([
                    ['calendar', 'Calendar month', 'Paid per calendar month. A part month (joining or leaving mid-month) is paid for the days worked.'],
                    ['anniversary', 'Full month from start date', 'Each month runs from the joining day, e.g. 15th to 14th, paid in full. Due 7 days after each period ends.'],
                  ] as [PayBasis, string, string][]).map(([value, label, hint]) => (
                    <label
                      key={value}
                      className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                        empPayBasis === value
                          ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40'
                          : 'border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800'
                      }`}
                    >
                      <input
                        type="radio"
                        name="pay-basis"
                        value={value}
                        checked={empPayBasis === value}
                        onChange={() => setEmpPayBasis(value)}
                        className="mt-0.5 accent-brand-600 shrink-0"
                      />
                      <span>
                        <span className="block text-xs font-bold text-ink-900 dark:text-white">{label}</span>
                        <span className="block text-2xs text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {editingEmployee && (
                <div>
                  <label className="block text-2xs font-bold uppercase text-ink-700 dark:text-ink-300 mb-1">Last working day</label>
                  <div className="flex gap-2">
                    <input
                      type="date"
                      value={empEndDate}
                      min={empJoiningDate || undefined}
                      onChange={e => setEmpEndDate(e.target.value)}
                      className={`flex-1 min-w-0 px-2.5 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                        isDarkMode ? 'bg-ink-900 border-ink-700 text-ink-100 [color-scheme:dark]' : 'bg-white border-ink-200 text-ink-800 [color-scheme:light]'
                      }`}
                    />
                    {empEndDate && (
                      <button
                        type="button"
                        onClick={() => setEmpEndDate('')}
                        className="tap px-3 text-2xs font-bold rounded-lg border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800 cursor-pointer"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <p className="text-2xs text-ink-500 mt-0.5">
                    For a resignation. Their records stay; the final month is paid to this day and nothing falls due after it.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-2xs font-bold uppercase text-ink-700 dark:text-ink-300 mb-1">Bank Name & Details *</label>
                <textarea 
                  placeholder="e.g. Maybank SAVINGS: 1640-1234-5678"
                  value={empBank}
                  onChange={(e) => setEmpBank(e.target.value)}
                  className={`w-full p-2.5 text-xs rounded-lg border h-16 ${
                    isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100 focus:border-brand-500' : 'bg-white border-ink-300 text-ink-900 font-semibold focus:border-brand-500'
                  }`}
                />
              </div>

              <div className="pt-3 border-t dark:border-ink-800 border-ink-100 flex justify-end gap-2">
                <button 
                  type="button"
                  onClick={() => setIsEmployeeModalOpen(false)}
                  className="px-4 py-2 text-xs font-black rounded-lg bg-white text-ink-700 hover:bg-ink-100 dark:bg-transparent dark:text-white dark:hover:bg-ink-800 border border-ink-300 dark:border-ink-600 cursor-pointer shadow-xs transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  disabled={isSyncing}
                  className="px-4 py-2 text-xs font-bold text-white rounded-lg bg-brand-600 hover:bg-brand-700 cursor-pointer flex items-center gap-1.5 shadow-sm transition-colors"
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
          <div className={`w-full max-w-4xl p-6 rounded-2xl shadow-xl transition-all ${isDarkMode ? 'bg-ink-900 border border-ink-800 text-ink-100' : 'bg-white border border-ink-200 text-ink-900'}`}>
            <div className="flex items-center justify-between mb-4 border-b pb-3 dark:border-ink-800 border-ink-100">
              <div className="flex items-center gap-2">
                <Coins className="w-5 h-5 text-emerald-500" />
                <h3 className="text-sm font-bold uppercase tracking-wider text-emerald-500">
                  Generate Monthly Slips Workspace
                </h3>
              </div>
              <button 
                onClick={() => setIsGeneratorOpen(false)}
                className="p-1.5 hover:bg-ink-100 dark:hover:bg-ink-800 rounded-lg cursor-pointer text-ink-500 hover:text-ink-700 dark:text-ink-400 dark:hover:text-ink-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Select Current Month Option */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-dashed border-ink-300 dark:border-ink-800 bg-ink-50 dark:bg-ink-950/20">
                <div className="text-xs text-ink-800 dark:text-ink-400 font-semibold">Select target register month:</div>
                <select
                  value={selectedMonthYear}
                  // Reopen for the new month: each month carries its own saved
                  // lines and advances, which a bare setState would leave stale.
                  onChange={(e) => handleOpenGenerator(e.target.value)}
                  className={`p-2 rounded-lg border text-xs font-bold focus:ring-1 focus:ring-emerald-500 text-ink-900 dark:text-white ${
                    isDarkMode ? 'bg-ink-950 border-ink-800' : 'bg-white border-ink-300'
                  }`}
                >
                  {(() => {
                    // This month (for a leaver's final pay) back to the earliest
                    // joining date, so back pay can be generated for anyone.
                    const now = new Date();
                    const earliest = activeBranchEmployees
                      .map(e => parseLocalDate(e.Joining_Date))
                      .reduce<Date>((min, d) => (d && d < min ? d : min), new Date(now.getFullYear() - 2, now.getMonth(), 1));
                    const opts: React.ReactElement[] = [];
                    for (let i = 0; i < 120; i++) {
                      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                      if (d < new Date(earliest.getFullYear(), earliest.getMonth(), 1)) break;
                      const lbl = monthLabel(d);
                      opts.push(<option key={lbl} value={lbl}>{lbl}{i === 0 ? ' (current)' : ''}</option>);
                    }
                    return opts;
                  })()}
                </select>
              </div>

              {/* Grid Inputs Table for RM values */}
              <div className="overflow-x-auto max-h-[350px] border border-ink-100 dark:border-ink-800 rounded-xl">
                <table className="min-w-full text-left text-xs">
                  <thead className={`border-b text-2xs font-bold uppercase tracking-wider ${isDarkMode ? 'bg-ink-950/40 border-ink-800 text-ink-500' : 'bg-ink-100 border-ink-200 text-ink-700'}`}>
                    <tr>
                      <th className="px-4 py-2">Employee</th>
                      <th className="px-4 py-2">Basic Salary (A)</th>
                      <th className="px-4 py-2">Custom Allowances * (B)</th>
                      <th className="px-4 py-2">Custom Deductions * (C)</th>
                      <th className="px-4 py-2 text-right">Estimated Net Pay (RM)</th>
                      <th className="px-4 py-2 text-right">Generate Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                    {(() => {
                      const _today = new Date();
                      // Anyone employed for any of this month's wage period, whose
                      // payslip is not saved yet. The period rules live in
                      // utils/payroll.ts, shared with the bell and the email.
                      const eligible = activeBranchEmployees.filter(emp =>
                        payPeriodForLabel(emp, selectedMonthYear) &&
                        !activeBranchPayslips.some(p =>
                          p.Is_Saved && p.Employee_ID === emp.Employee_ID &&
                          normaliseMonthLabel(p.Month_Year) === selectedMonthYear));

                      if (eligible.length === 0) return (
                        <tr><td colSpan={6} className="px-4 py-8 text-center text-2xs text-ink-500 font-medium">
                          Nobody is left to pay for {selectedMonthYear}: every payslip is saved, or no one was employed that month.
                        </td></tr>
                      );

                      return eligible.map((emp) => {
                      const period = payPeriodForLabel(emp, selectedMonthYear)!;
                      const basicPay = round2(emp.Basic_Salary * period.fraction);
                      // Countdown only once the period has ended, and only where a
                      // reminder would chase it: years of back pay are not "overdue".
                      const _dl = salaryDeadline(period.end, _today);
                      const _daysLeft = _dl.ended && isRemindable(emp, period) ? _dl.daysLeft : null;
                      const _overdue = _daysLeft !== null && _dl.overdue;
                      const allowancesList = allowancesMap[emp.Employee_ID] || [];
                      const deductionsList = deductionsMap[emp.Employee_ID] || [];
                      
                      const allowanceSum = allowancesList.reduce((acc, curr) => acc + (curr.amount || 0), 0);
                      const customDeductionSum = deductionsList.reduce((acc, curr) => acc + (curr.amount || 0), 0);
                      
                      const grossPayBase = basicPay + allowanceSum;
                      const citizenship = emp.Citizenship;

                      const empAge = Number(emp.Age) || 30;
                      const epf = calculateEmployeeEPF(grossPayBase, citizenship, empAge);
                      const socso = calculateEmployeeSOCSO(grossPayBase, citizenship, empAge);
                      const eis = calculateEmployeeEIS(grossPayBase, citizenship, empAge);
                      const skbbkRow = calculateSKBBK(grossPayBase, citizenship, empAge);

                      const totalStatDeduc = epf + socso + skbbkRow + eis;
                      const rowStatutoryOffset = emp.Employer_Bears_Statutory ? totalStatDeduc : 0;
                      const netPay = Math.max(0, grossPayBase - totalStatDeduc - customDeductionSum + rowStatutoryOffset);

                      return (
                        <tr key={emp.Employee_ID} className={isDarkMode ? 'hover:bg-ink-800/30' : 'hover:bg-ink-50'}>
                          <td className="px-4 py-3 font-semibold text-ink-900 dark:text-white">
                            <div className="text-ink-900 dark:text-white font-bold">{emp.Employee_Name}</div>
                            <div className="text-2xs text-ink-500 dark:text-ink-400 font-medium flex items-center gap-1 mt-0.5">
                              <span>{emp.Position}</span>
                              <span>•</span>
                              <span className="font-bold text-ink-500 dark:text-ink-400 text-2xs uppercase">{residencyLabel(citizenship)}</span>
                              {emp.Employer_Bears_Statutory && (
                                <span className="font-bold text-brand-600 dark:text-brand-400 text-2xs uppercase" title="Employer bears this employee's EPF/SOCSO/EIS share">
                                  • Statutory Borne by Employer
                                </span>
                              )}
                            </div>
                            {_daysLeft !== null && (
                              <div className={`text-2xs font-bold mt-1 ${
                                _overdue ? 'text-rose-500' : _daysLeft <= 2 ? 'text-amber-500' : 'text-ink-500 dark:text-ink-400'
                              }`}>
                                {_overdue
                                  ? `⚠ Payment overdue by ${Math.abs(_daysLeft)} day${Math.abs(_daysLeft) !== 1 ? 's' : ''}`
                                  : `⏱ Pay within ${_daysLeft} day${_daysLeft !== 1 ? 's' : ''} (7-day rule)`}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-ink-900 dark:text-white font-bold">
                            RM {basicPay.toFixed(2)}
                            {(period.fraction < 1 || emp.Pay_Basis === 'anniversary') && (
                              <div className="text-2xs font-sans font-semibold text-amber-700 dark:text-amber-400 mt-0.5 whitespace-nowrap">
                                {describePeriod(period)}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 min-w-[280px]">
                            <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                              {allowancesList.map((item, idx) => (
                                <div key={idx} className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    placeholder="e.g. Overtime"
                                    value={item.description}
                                    onChange={(e) => updateAllowanceDescription(emp.Employee_ID, idx, e.target.value)}
                                    className={`w-28 p-1 text-2xs rounded border ${
                                      isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100' : 'bg-white border-ink-300 text-ink-900 font-bold'
                                    }`}
                                  />
                                  <div className="relative">
                                    <span className="absolute inset-y-0 left-1 flex items-center text-2xs text-ink-500 dark:text-ink-400 font-bold">RM</span>
                                    <input
                                      type="number"
                                      min="0"
                                      placeholder="0"
                                      value={item.amount || ''}
                                      onChange={(e) => updateAllowanceAmount(emp.Employee_ID, idx, Number(e.target.value))}
                                      className={`w-20 pl-6 pr-1 py-1 text-2xs font-mono rounded border ${
                                        isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100' : 'bg-white border-ink-300 text-ink-900 font-bold'
                                      }`}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <button 
                              type="button"
                              onClick={() => addAllowanceItem(emp.Employee_ID)}
                              className="mt-1 flex items-center gap-0.5 text-2xs text-brand-600 font-bold hover:underline cursor-pointer"
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
                                    className={`w-28 p-1 text-2xs rounded border ${
                                      isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100' : 'bg-white border-ink-300 text-ink-900 font-bold'
                                    }`}
                                  />
                                  <div className="relative">
                                    <span className="absolute inset-y-0 left-1 flex items-center text-2xs text-ink-500 dark:text-ink-400 font-bold">RM</span>
                                    <input 
                                      type="number"
                                      min="0"
                                      placeholder="0"
                                      value={item.amount || ''}
                                      onChange={(e) => updateDeductionAmount(emp.Employee_ID, idx, Number(e.target.value))}
                                      className={`w-20 pl-6 pr-1 py-1 text-2xs font-mono rounded border ${
                                        isDarkMode ? 'bg-ink-950 border-ink-800 text-ink-100' : 'bg-white border-ink-300 text-ink-900 font-bold'
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
                              className="mt-1 flex items-center gap-0.5 text-2xs text-brand-600 font-bold hover:underline cursor-pointer"
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
                              className="px-2.5 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 dark:bg-transparent dark:text-emerald-400 dark:border-emerald-700 dark:hover:bg-ink-800 font-black rounded-lg cursor-pointer transition-colors shadow-xs"
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

              <div className="pt-3 border-t border-ink-100 dark:border-ink-800 flex justify-end gap-2">
                <button 
                  onClick={() => setIsGeneratorOpen(false)}
                  className="px-4 py-2 text-xs font-black rounded-lg bg-white text-ink-700 border border-ink-300 hover:bg-ink-100 dark:bg-transparent dark:text-white dark:border-ink-600 dark:hover:bg-ink-800 cursor-pointer transition-colors shadow-xs"
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
        <div data-document className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm overflow-y-auto flex items-start justify-center py-4 px-2 sm:py-8 sm:px-6">
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
                /* Pin the print viewport to true A4 width so mobile Chrome/Safari
                   prints the 210mm payslip 1:1 instead of shrinking it into a
                   corner and spilling onto a second page. */
                width: 210mm !important; min-width: 210mm !important; max-width: 210mm !important;
                -webkit-text-size-adjust: 100% !important; text-size-adjust: 100% !important;
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
              #printable-payslip .bg-ink-9,
              #printable-payslip [class*="bg-ink-9"] {
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
              <div className={`flex items-center justify-between px-6 py-4 no-print ${isDarkMode ? 'bg-ink-900 border-b border-ink-800' : 'bg-white border-b border-ink-100'}`}>
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-brand-500" />
                <h3 className="text-sm font-bold uppercase tracking-wider text-brand-500">
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
                className="p-1.5 hover:bg-ink-100 dark:hover:bg-ink-800 rounded-lg cursor-pointer text-ink-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Document Printable Frame */}
            <div id="printable-payslip" className={`p-8 space-y-6 w-full ${isDarkMode ? 'bg-ink-950' : 'bg-white'}`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-lg font-black tracking-tight text-ink-900 dark:text-white uppercase">
                    {activeOutletProfile.company_name || activeOutletProfile.name}
                  </h1>
                  <p className="text-2xs text-ink-500 font-bold uppercase">{activeOutletProfile.store_name || activeOutletProfile.name}</p>
                  <p className="text-xs text-ink-500 dark:text-ink-400 max-w-sm mt-1 leading-relaxed">
                    {activeOutletProfile.address}
                  </p>
                  <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">
                    Phone: {activeOutletProfile.phone} | Email: {activeOutletProfile.email}
                  </p>
                </div>

                <div className="text-right">
                  <span className="payslip-badge inline-block px-3 py-1 bg-brand-600 font-black tracking-widest text-2xs rounded-md border border-brand-600" style={{ color: 'white' }}>
                    PAYSLIP RECORD
                  </span>
                  <div className="text-xs font-bold text-ink-900 dark:text-ink-100 mt-2">
                    ID: <span className="font-mono">{previewPayslip.Payslip_ID}</span>
                  </div>
                  <div className="text-xs text-ink-500 mt-0.5">
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

              <div className="border-b dark:border-ink-800" />

              {/* Detail Blocks */}
<div className="grid grid-cols-2 gap-4">
  <div>
    <h4 className="text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-widest mb-1.5 font-mono">
      Employee Details
    </h4>
    <p className="text-sm font-black text-ink-950 dark:text-white">
      {previewEmployee.Employee_Name}
    </p>
    <p className="text-xs text-ink-700 dark:text-ink-400 font-medium">
      IC Number/Passport:{" "}
      <span className="font-mono text-ink-950 dark:text-white font-bold">
        {previewEmployee.IC_Passport}
      </span>
    </p>
    <p className="text-xs text-ink-700 dark:text-ink-400 font-medium">
      Position:{" "}
      <span className="font-bold text-ink-950 dark:text-white">
        {previewEmployee.Position}
      </span>
    </p>
    <p className="text-xs text-ink-700 dark:text-ink-400 font-medium">
      Outlet:{" "}
      <span className="font-bold text-ink-950 dark:text-white">
        {previewEmployee.Branch_Location || previewEmployee.Assigned_Outlet}
      </span>
    </p>
  </div>
  <div>
    <h4 className="text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-widest mb-1.5 font-mono">
      Payment details
    </h4>
    <p className="text-xs text-ink-700 dark:text-ink-400 font-medium">
      Month / Year:{" "}
      <strong className="text-ink-950 dark:text-white font-black">
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
    <p className="text-xs text-ink-700 dark:text-ink-400 font-medium">
      Bank Account Details:{" "}
      <span className="font-bold text-ink-950 dark:text-white">
        {previewEmployee.Bank_Details || "Maybank Account"}
      </span>
    </p>
    {previewPayslip.Transfer_Date && (
      <p className="text-xs text-ink-700 dark:text-ink-400 font-medium">
        Wage Transfer Date:{' '}
        <strong className="text-emerald-700 dark:text-emerald-400 font-black">
          {previewPayslip.Transfer_Date}
        </strong>
      </p>
    )}
    {!previewPayslip.Transfer_Date && (
      <p className="text-xs text-ink-700 dark:text-ink-300 font-bold mt-1">
        Transfer Date: _______________________
      </p>
    )}
  </div>
</div>

              {/* Two balanced columns: Earnings vs Deductions */}
              <div className="grid grid-cols-2 gap-6 pt-2">
                <div className="space-y-3">
                  <div className="text-xs font-black text-emerald-800 dark:text-emerald-400 border-b pb-1 dark:border-ink-800 flex justify-between">
                    <span>EARNINGS ITEMIZED</span>
                    <span>AMOUNT</span>
                  </div>
                  <div className="space-y-1.5 text-xs font-semibold">
                    <div className="flex justify-between text-ink-900 dark:text-ink-300">
                      <span>
                        Basic Pay
                        {previewPayslip.Pay_Period && (
                          <span className="block text-2xs font-medium text-ink-500">{previewPayslip.Pay_Period}</span>
                        )}
                      </span>
                      <span className="font-black text-ink-950 dark:text-white">RM {previewPayslip.Basic_Pay.toFixed(2)}</span>
                    </div>
                    {(() => {
                      let list: any[] = [];
                      if (previewPayslip.Allowances_JSON) {
                        try { list = JSON.parse(previewPayslip.Allowances_JSON); } catch {}
                      }
                      list = list.filter((item: any) => !('_bm_paid' in item) && (item.description?.trim() || item.amount > 0));
                      if (list.length > 0) {
                        return list.map((item: any, idx: number) => (
                          <div key={idx} className="flex justify-between text-ink-900 dark:text-ink-200">
                            <span>{item.description || 'Custom Allowance'}</span>
                            <span className="font-bold text-ink-950 dark:text-white">RM {item.amount.toFixed(2)}</span>
                          </div>
                        ));
                      }
                      if (previewPayslip.Custom_Allowances > 0) {
                        return (
                          <div className="flex justify-between text-ink-900 dark:text-ink-300">
                            <span>Custom Allowances</span>
                            <span className="font-bold text-ink-950 dark:text-white">
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
                  <div className="text-xs font-black text-rose-700 dark:text-rose-400 border-b pb-1 dark:border-ink-800 flex justify-between">
                    <span>DEDUCTIONS ITEMIZED</span>
                    <span>AMOUNT</span>
                  </div>
                  <div className="space-y-1.5 text-xs font-semibold">
                    <div className="flex justify-between text-ink-900 dark:text-ink-300">
                      <span>Employee EPF ({
                        (previewEmployee.Citizenship || 'Malaysian/PR') === 'Foreigner'
                          ? '2%'
                          : (Number(previewEmployee.Age) || 30) >= 60 ? '0% (age 60+)' : '11%'
                      })</span>
                      <span className="font-extrabold text-ink-950 dark:text-white">RM {previewPayslip.Employee_EPF.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-ink-900 dark:text-ink-300">
                      <span>Employee SOCSO (0.5%)</span>
                      <span className="font-extrabold text-ink-950 dark:text-white">RM {previewPayslip.Employee_SOCSO.toFixed(2)}</span>
                    </div>
                    {(previewPayslip.Employee_SKBBK ?? 0) > 0 && (
                      <div className="flex justify-between text-ink-900 dark:text-ink-300">
                        <span>SKBBK / Lindung 24 Jam (0.75%)</span>
                        <span className="font-extrabold text-ink-950 dark:text-white">RM {previewPayslip.Employee_SKBBK.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-ink-900 dark:text-ink-300">
                      <span>Employee EIS / SIP (0.2%)</span>
                      <span className="font-extrabold text-ink-950 dark:text-white">RM {previewPayslip.Employee_EIS.toFixed(2)}</span>
                    </div>
                    {(() => {
                      let list: any[] = [];
                      if (previewPayslip.Deductions_JSON) {
                        try { list = JSON.parse(previewPayslip.Deductions_JSON); } catch {}
                      }
                      list = list.filter((item: any) => !('_bm_paid' in item) && (item.description?.trim() || item.amount > 0));
                      if (list.length > 0) {
                        return list.map((item: any, idx: number) => (
                          <div key={idx} className="flex justify-between text-ink-900 dark:text-ink-200">
                            <span>{item.description || 'Custom Deduction'}</span>
                            <span className="font-bold text-ink-950 dark:text-white">RM {item.amount.toFixed(2)}</span>
                          </div>
                        ));
                      }
                      if (previewPayslip.Custom_Deductions > 0) {
                        return (
                          <div className="flex justify-between text-ink-900 dark:text-ink-400">
                            <span>Custom Deductions</span>
                            <span className="font-bold text-ink-950 dark:text-white font-mono">
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

              {/* Employer-Borne Statutory Contribution — only when the employer has
                  opted (per-employee) to cover the employee's own EPF/SOCSO/EIS share.
                  This is NOT a bonus: it is a distinct, itemized offset of the exact
                  statutory deduction shown above, not extra discretionary pay — a
                  bonus would itself be subject to EPF/SOCSO in the month paid, which
                  this specifically is not intended to be. */}
              {previewPayslip.Employer_Statutory_Offset > 0 && (
                <div className="p-3 rounded-xl bg-brand-500/10 border border-brand-300 dark:border-brand-800">
                  <div className="flex justify-between text-xs font-black text-brand-700 dark:text-brand-400">
                    <span>Employer-Borne Statutory Contribution (EPF + SOCSO + EIS)</span>
                    <span>RM {previewPayslip.Employer_Statutory_Offset.toFixed(2)}</span>
                  </div>
                  <p className="text-2xs text-brand-600/80 dark:text-brand-400/70 mt-1">
                    Employer pays this employee's own statutory share on their behalf, in addition
                    to the employer's own EPF/SOCSO/EIS contribution shown below. The deductions
                    above are still the real amounts contributed to this employee's EPF/SOCSO/EIS
                    accounts — this line offsets them in net pay, it does not remove them.
                  </p>
                </div>
              )}

              {/* Bold Outstanding Sum Net balance */}
              <div className="p-4 rounded-xl bg-[#f0fdf4] border-2 border-emerald-500 text-ink-900 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h5 className="text-2xs font-bold text-emerald-600 uppercase tracking-widest">Employee Final Net Pay</h5>
                  <p className="text-2xs text-ink-600">
                    {previewPayslip.Employer_Statutory_Offset > 0
                      ? "Gross pay minus non-statutory deductions — EPF/SOCSO/EIS borne by employer. Transferred directly via Bank Accounts."
                      : "Total Net RM transferred directly via Bank Accounts."}
                  </p>
                </div>
                <div className="text-2xl font-black text-emerald-600 tracking-tight">
                  RM {previewPayslip.Final_Net_Pay.toFixed(2)}
                </div>
              </div>

              {/* Employer Statutory Metrics */}
              <div className={`p-3.5 rounded-lg border border-dashed text-xs mt-3 ${
                isDarkMode 
                  ? 'border-ink-700 bg-ink-900/40 text-ink-500' 
                  : 'border-ink-200 bg-ink-50/50 text-ink-500'
              }`}>
                <div className={`font-bold uppercase tracking-wider text-2xs mb-2 ${
                  isDarkMode ? 'text-ink-300' : 'text-ink-700'
                }`}>
                  Employer Statutory Audits (Employer Contributions in RM)
                </div>
                <div className="grid grid-cols-3 gap-2 text-2xs">
                  <div>Employer EPF: <strong className={isDarkMode ? 'text-ink-200' : 'text-ink-700'}>RM {previewPayslip.Employer_EPF.toFixed(2)}</strong></div>
                  <div>Employer SOCSO: <strong className={isDarkMode ? 'text-ink-200' : 'text-ink-700'}>RM {previewPayslip.Employer_SOCSO.toFixed(2)}</strong></div>
                  <div>Employer EIS (SIP): <strong className={isDarkMode ? 'text-ink-200' : 'text-ink-700'}>RM {previewPayslip.Employer_EIS.toFixed(2)}</strong></div>
                </div>
              </div>

              {/* Signature line */}
              <div className="flex justify-end mt-10">
                <div className="text-center w-64">
                  <div className={`border-t pt-3 ${isDarkMode ? 'border-ink-600' : 'border-ink-300'}`}>
                    <p className={`text-2xs font-bold ${isDarkMode ? 'text-ink-300' : 'text-ink-700'}`}>
                      Received By: Employee Signature
                    </p>
                    <div className={`mt-4 border-b ${isDarkMode ? 'border-ink-500' : 'border-ink-400'}`} />
                    <p className={`text-2xs mt-2 ${isDarkMode ? 'text-ink-500' : 'text-ink-500'}`}>
                      Date
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Action buttons footer */}
            <div className={`px-6 py-4 border-t flex flex-wrap items-center justify-between gap-3 no-print ${isDarkMode ? 'bg-ink-900 border-ink-800' : 'bg-white border-ink-100'}`}>
              <div>
                {/* Saved Indicator Badge */}
                {db.payslips.some(p => p.Payslip_ID === previewPayslip.Payslip_ID && p.Is_Saved) ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle className="w-4 h-4" /> Locked & Finalized in Database
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-brand-500/10 text-brand-500">
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
                    className="flex items-center gap-1 px-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs rounded-xl transition-all duration-150 cursor-pointer shadow-sm"
                    title="Write this payroll slip permanently to the database ledger."
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{isSyncing ? "Saving Record..." : "Save Payslip"}</span>
                  </button>
                )}

                {/* Print button */}
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs rounded-xl cursor-pointer transition-colors"
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
                  className="px-4 py-2 text-xs font-bold rounded-xl bg-ink-100 border border-ink-300 hover:bg-ink-200 text-ink-900 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700 cursor-pointer"
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
              ? 'bg-ink-900 border border-ink-800 text-ink-100'
              : 'bg-white border border-ink-200 text-ink-900'
          }`}>
            <h3 className="text-sm font-bold text-emerald-600 mb-1">
              Confirm Wage Transfer
            </h3>
            <p className={`text-xs mb-4 ${
              isDarkMode ? 'text-ink-500' : 'text-ink-500'
            }`}>
              Payslip ID: {markPaymentPayslip.Payslip_ID}<br/>
              This action records that wages have been physically transferred
              to the employee. This cannot be undone.
            </p>

            <div className="mb-4">
              <label className="block text-2xs font-bold text-ink-500
                uppercase mb-1.5">Date of Payment</label>
              <input
                type="date"
                value={transferDateInput}
                onChange={e => setTransferDateInput(e.target.value)}
                className={`w-full px-3 py-2 text-sm rounded-lg border
                  focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                  isDarkMode
                    ? 'bg-ink-800 border-ink-700 text-ink-100 [color-scheme:dark]'
                    : 'bg-ink-50 border-ink-200 text-ink-900 [color-scheme:light]'
                }`}
              />
              <p className="text-2xs text-ink-500 mt-1">
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
                    ? 'border-ink-700 text-ink-300 hover:bg-ink-800'
                    : 'border-ink-200 text-ink-600 hover:bg-ink-50'
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
                  triggerToast('Payment confirmed and recorded.', 'success');
                  setMarkPaymentPayslip(null);
                  setTransferDateInput('');
                  syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation)
                    .catch((err: any) => triggerToast(`Not saved yet: ${err.message}`, 'error'));
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

      {/* --- SALARY ADVANCES --- */}
      {advancesFor && (
        <Sheet
          title="Salary advances"
          subtitle={advancesFor.Employee_Name}
          icon={<HandCoins className="w-4 h-4" />}
          onClose={() => setAdvancesFor(null)}
          maxWidth="md"
          footer={
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setAdvancesFor(null)} className={sheetBtn.ghost}>Done</button>
              <button type="submit" form="advance-form" disabled={isSyncing} className={sheetBtn.primary}>
                {isSyncing ? 'Saving…' : 'Record advance'}
              </button>
            </div>
          }
        >
          <form id="advance-form" onSubmit={handleAddAdvance} className="space-y-3">
            <p className="text-xs text-ink-600 dark:text-ink-300 leading-relaxed">
              Money paid ahead of payday: an advance, or emergency funds. It is deducted
              automatically from the payslip for the period it was taken in.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="adv-date" className="block text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300 mb-1">Date paid</label>
                <input
                  id="adv-date"
                  type="date"
                  required
                  value={advDate}
                  min={advancesFor.Joining_Date || undefined}
                  max={advancesFor.End_Date || undefined}
                  onChange={e => setAdvDate(e.target.value)}
                  className="w-full px-3 py-2.5 text-xs rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-950 text-ink-900 dark:text-ink-100 dark:[color-scheme:dark]"
                />
              </div>
              <div>
                <label htmlFor="adv-amount" className="block text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300 mb-1">Amount (RM)</label>
                <input
                  id="adv-amount"
                  type="number"
                  required
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  value={advAmount || ''}
                  onChange={e => setAdvAmount(Number(e.target.value))}
                  className="w-full px-3 py-2.5 text-xs font-mono rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-950 text-ink-900 dark:text-ink-100"
                />
              </div>
            </div>
            <div>
              <label htmlFor="adv-note" className="block text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300 mb-1">Reason (optional)</label>
              <input
                id="adv-note"
                type="text"
                placeholder="e.g. Medical emergency"
                value={advNote}
                onChange={e => setAdvNote(e.target.value)}
                className="w-full px-3 py-2.5 text-xs rounded-lg border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-950 text-ink-900 dark:text-ink-100"
              />
            </div>
            {parseLocalDate(advDate) && (
              <p className="text-2xs font-semibold text-amber-800 dark:text-amber-300">
                Deducted from the {periodLabelFor(advancesFor, parseLocalDate(advDate)!)} payslip.
              </p>
            )}
          </form>

          <div className="mt-5">
            <h4 className="text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300 mb-2">History</h4>
            {(advancesFor.Advances || []).length === 0 ? (
              <p className="text-xs text-ink-500 dark:text-ink-400 py-3">No advances recorded.</p>
            ) : (
              <ul className="divide-y divide-ink-100 dark:divide-ink-800 border border-ink-100 dark:border-ink-800 rounded-lg">
                {[...(advancesFor.Advances || [])].sort((a, b) => b.date.localeCompare(a.date)).map(a => {
                  const slip = advanceOnPayslip(a.id);
                  const taken = parseLocalDate(a.date);
                  return (
                    <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold font-mono text-ink-900 dark:text-white tabular">RM {a.amount.toFixed(2)}</p>
                        <p className="text-2xs text-ink-500 dark:text-ink-400 truncate">
                          {a.date}{a.note ? ` · ${a.note}` : ''}
                        </p>
                        <p className={`text-2xs font-semibold ${slip ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-300'}`}>
                          {slip ? `Deducted · ${normaliseMonthLabel(slip.Month_Year)}` : `Pending · ${taken ? periodLabelFor(advancesFor, taken) : ''} payslip`}
                        </p>
                      </div>
                      {!slip && (
                        <button
                          type="button"
                          onClick={() => handleRemoveAdvance(a)}
                          aria-label={`Delete advance of ${a.date}`}
                          className="tap flex items-center justify-center rounded-lg text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
};
