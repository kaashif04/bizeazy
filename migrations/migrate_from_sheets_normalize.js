/*
Migration script to import data from Google Sheets (CSV exports) into Supabase.
Usage:
  1. Export each sheet as CSV and save as: invoices.csv, patrons.csv, employees.csv, payslips.csv
  2. Set environment variable: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service_role key)
  3. Run: node migrations/migrate_from_sheets.js

This script will parse CSV files and insert rows into the Supabase tables created by schema.sql.
*/

import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import csvParse from 'csv-parse/lib/sync';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function parseCsv(filename) {
  const p = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  return csvParse(raw, { columns: true, skip_empty_lines: true });
}

function safeNumber(v) { if (v===undefined || v===null || v==='') return null; const n = Number(String(v).replace(/[^0-9.-]+/g, '')); return isNaN(n)?null:n; }
function safeDate(v) { if(!v) return null; const d = new Date(v); return isNaN(d.getTime())?null: d.toISOString().slice(0,10); }

async function migrateInvoices() {
  const rows = parseCsv('invoices.csv');
  if (!rows) { console.log('invoices.csv not found, skipping'); return; }
  for (const r of rows) {
    const invoiceId = r['Invoice ID'] || r['invoiceId'] || r['InvoiceId'] || r['id'] || null;
    const customerId = r['Customer ID'] || r['Customer'] || r['patronId'] || null;
    const items = (() => { try { return JSON.parse(r['items'] || r['Items'] || '[]'); } catch(e) { return [] } })();
    const invoiceDate = safeDate(r['Date'] || r['Invoice Date'] || r['date']);
    const subtotal = safeNumber(r['Subtotal'] || r['subTotal'] || r['Sub Total']);
    const tax = safeNumber(r['Tax'] || r['tax'] || 0);
    const total = safeNumber(r['Total'] || r['Amount'] || r['total']);
    const status = r['Status'] || null;
    const branch = r['Branch'] || r['Outlet'] || null;
    const payload = { ...r };

    const { error } = await supabase.from('invoices').insert([{ invoice_id: invoiceId, customer_id: customerId, items, invoice_date: invoiceDate, subtotal, tax, total, status, branch, payload }]);
    if (error) console.error('Error inserting invoice', invoiceId, error.message);
  }
  console.log('Invoices migrated');
}

async function migratePatrons() {
  const rows = parseCsv('patrons.csv') || parseCsv('customers.csv');
  if (!rows) { console.log('patrons.csv not found, skipping'); return; }
  for (const r of rows) {
    const patronId = r['Patron ID'] || r['patronId'] || r['id'] || null;
    const name = r['Name'] || r['Customer Name'] || r['Full Name'] || null;
    const phone = r['Phone'] || r['Mobile'] || null;
    const email = r['Email'] || null;
    const address = r['Address'] || null;
    const notes = r['Notes'] || null;
    const payload = { ...r };
    const { error } = await supabase.from('patrons').insert([{ patron_id: patronId, name, phone, email, address, notes, payload }]);
    if (error) console.error('Error inserting patron', patronId, error.message);
  }
  console.log('Patrons migrated');
}

async function migrateEmployees() {
  const rows = parseCsv('employees.csv');
  if (!rows) { console.log('employees.csv not found, skipping'); return; }
  for (const r of rows) {
    const employeeId = r['Employee ID'] || r['employeeId'] || r['id'] || null;
    const name = r['Name'] || null;
    const role = r['Role'] || r['Position'] || null;
    const phone = r['Phone'] || null;
    const email = r['Email'] || null;
    const salary = safeNumber(r['Salary'] || r['Basic'] || null);
    const payload = { ...r };
    const { error } = await supabase.from('employees').insert([{ employee_id: employeeId, name, role, phone, email, salary, payload }]);
    if (error) console.error('Error inserting employee', employeeId, error.message);
  }
  console.log('Employees migrated');
}

async function migratePayslips() {
  const rows = parseCsv('payslips.csv');
  if (!rows) { console.log('payslips.csv not found, skipping'); return; }
  for (const r of rows) {
    const payslipId = r['Payslip ID'] || r['payslipId'] || r['id'] || null;
    const employeeId = r['Employee ID'] || r['employeeId'] || r['Employee'] || null;
    const periodStart = safeDate(r['Period Start'] || r['From'] || null);
    const periodEnd = safeDate(r['Period End'] || r['To'] || null);
    const gross = safeNumber(r['Gross'] || r['Total Earnings'] || null);
    const deductions = safeNumber(r['Deductions'] || null);
    const net = safeNumber(r['Net'] || r['Net Pay'] || null);
    const payload = { ...r };
    const { error } = await supabase.from('payslips').insert([{ payslip_id: payslipId, employee_id: employeeId, period_start: periodStart, period_end: periodEnd, gross, deductions, net, payload }]);
    if (error) console.error('Error inserting payslip', payslipId, error.message);
  }
  console.log('Payslips migrated');
}

async function main(){
  await migrateInvoices();
  await migratePatrons();
  await migrateEmployees();
  await migratePayslips();
}

main().then(()=>{ console.log('Migration complete'); process.exit(0); }).catch(e=>{ console.error(e); process.exit(1); });
