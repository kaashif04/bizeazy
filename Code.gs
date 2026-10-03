/**
 * BizEazy — Google Apps Script Backend  (Code.gs)
 * ─────────────────────────────────────────────────────────────
 * Fixes in this version vs previous:
 *  1. fetchDataAll now returns invoice_items[] from the Invoice_Items tab
 *  2. getAppConfig returns a PARSED object, not a raw JSON string
 *  3. syncData handles the Invoice_Items tab, Citizenship column on
 *     Employees, and Allowances_JSON / Deductions_JSON on Payslips
 *  4. initializeDatabase creates Invoice_Items tab with correct headers
 *     and adds Citizenship to Employees, Allowances_JSON/Deductions_JSON
 *     to Payslips
 * ─────────────────────────────────────────────────────────────
 */

// ─── Router ───────────────────────────────────────────────────
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action) return jsonOut(handleAction(p.action, p, p.token));
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('BizEazy Invoicing')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

function doPost(e) {
  try {
    var params = {};
    if (e && e.postData && e.postData.contents) {
      try {
        params = JSON.parse(e.postData.contents);
      } catch (_) {
        // fallback: form-encoded
        e.postData.contents.split('&').forEach(function(part) {
          var kv = part.split('=');
          if (kv.length === 2) params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
        });
      }
    }
    // Query-string values fill gaps in the body, never override it.
    if (e && e.parameter) {
      Object.keys(e.parameter).forEach(function(k) {
        if (params[k] === undefined) params[k] = e.parameter[k];
      });
    }
    if (!params.action) throw new Error("No action specified");
    return jsonOut(handleAction(params.action, params, params.token));
  } catch (err) {
    return jsonOut({ success: false, error: err.toString() });
  }
}

function denied() { return { success: false, error: 'You do not have access to that.' }; }

/**
 * Single gate for every action. This web app is deployed "Anyone", so the
 * token check here — not anything in the React app — is what keeps one
 * company's books away from another's.
 */
function handleAction(action, p, token) {
  try {
    // ── Public: no session required ──
    if (action === 'login')           return login(p);
    if (action === 'registerCompany') return registerCompany(p);
    if (action === 'checkUserId')     return checkUserId(p.userId);
    if (action === 'ping')            return { success: true };

    var session = resolveSession(token);
    if (!session) {
      return { success: false, code: 'AUTH', error: 'Your session has expired. Please sign in again.' };
    }
    if (ADMIN_ACTIONS[action] && !session.isAdmin) {
      return { success: false, error: 'Admin access required.' };
    }

    // The SESSION decides which spreadsheet is touched. Any spreadsheetId the
    // client sent is deliberately ignored — otherwise any signed-in user could
    // name another company's spreadsheet and read or overwrite it.
    var sheetId = session.spreadsheetId;

    if (action === 'logout')              return destroySession(token);
    if (action === 'session')             return { success: true, data: sessionPayload(session) };
    if (action === 'fetchDataAll')        return fetchDataAll(sheetId, session);
    if (action === 'syncData')            return syncData(p.db || p, sheetId, session);
    if (action === 'getConfig')           return getAppConfig(sheetId);
    if (action === 'initializeDatabase')  return initializeDatabase(sheetId);
    if (action === 'changePassword')      return changeOwnPassword(session, p);

    if (action === 'saveConfig')          return hasModule(session, 'settings')  ? saveAppConfig(p.config, sheetId) : denied();
    if (action === 'saveInvoice')         return hasModule(session, 'invoicing') ? saveInvoice(p.payload || p, sheetId) : denied();
    if (action === 'updateInvoiceStatus') return hasModule(session, 'invoicing') ? updateInvoiceStatus(p.invoiceId, p.status, sheetId) : denied();

    if (action === 'listUsers')           return listUsers(session);
    if (action === 'createUser')          return createUser(session, p);
    if (action === 'updateUser')          return updateUser(session, p);
    if (action === 'resetUserPassword')   return resetUserPassword(session, p);
    if (action === 'deleteUser')          return deleteUser(session, p);

    return { success: false, error: 'Invalid action: ' + action };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── Spreadsheet helper ───────────────────────────────────────
function getDatabase(spreadsheetId) {
  if (spreadsheetId && String(spreadsheetId).trim()) {
    try { return SpreadsheetApp.openById(String(spreadsheetId).trim()); } catch (_) {}
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

// ─── Row helper ───────────────────────────────────────────────
function getSheetRowsAsObjects(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var tz = sheet.getParent().getSpreadsheetTimeZone();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values  = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  return values.map(function(row) {
    var obj = {};
    headers.forEach(function(h, idx) {
      var v = row[idx];
      // Sheets silently auto-converts date-like strings (e.g. "2026-05-15") into
      // real Date objects on write. Reading those back as JS Dates then JSON-
      // serializes into a UTC timestamp that doesn't match the plain yyyy-MM-dd
      // string the frontend (and <input type="date">) expects — making the field
      // look empty/wrong every time, even though the value was saved correctly.
      if (v instanceof Date) {
        // Sheets auto-converts time strings (e.g. "7:30 AM") to Date objects
        // anchored at the Lotus/Sheets epoch (Dec 30 1899). Formatting those as
        // yyyy-MM-dd produces "1899-12-30" — useless garbage. Detect by year and
        // return a human-readable time string instead.
        if (v.getFullYear() <= 1899) {
          v = Utilities.formatDate(v, tz, 'h:mm a');
        } else {
          v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        }
      }
      obj[h] = v !== undefined ? v : '';
    });
    return obj;
  });
}

// ─── App config ───────────────────────────────────────────────
/**
 * Config now lives in a Config tab inside each COMPANY's own spreadsheet, one
 * row per outlet key. It used to be a single ScriptProperties blob, which is
 * per-script: every tenant would have shared one company profile. Rows also
 * beat ScriptProperties on size — a property caps at 9KB, which a base64 logo
 * blows straight past, while a cell holds 50,000 characters.
 */
function configTab(spreadsheetId) {
  return sheetFor(getDatabase(spreadsheetId), 'Config', ['Key', 'Value']);
}

function saveAppConfig(config, spreadsheetId) {
  try {
    var obj = (typeof config === 'string') ? JSON.parse(config) : config;
    if (!obj || typeof obj !== 'object') return { success: false, error: 'Config must be an object.' };

    var tab = configTab(spreadsheetId);
    if (tab.getLastRow() > 1) tab.getRange(2, 1, tab.getLastRow() - 1, 2).clearContent();

    var rows = Object.keys(obj).map(function(k) { return [k, JSON.stringify(obj[k])]; });
    if (rows.length) tab.getRange(2, 1, rows.length, 2).setValues(rows);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function getAppConfig(spreadsheetId) {
  try {
    var tab = configTab(spreadsheetId);
    var out = {};
    var last = tab.getLastRow();
    if (last > 1) {
      tab.getRange(2, 1, last - 1, 2).getValues().forEach(function(r) {
        if (!r[0]) return;
        try { out[String(r[0])] = JSON.parse(r[1]); } catch (_) { out[String(r[0])] = r[1]; }
      });
    }
    if (Object.keys(out).length) return { success: true, data: out };

    // One-time migration for the original single-tenant deployment: lift the
    // old script-level blob into this spreadsheet's Config tab, then forget it.
    var legacy = PropertiesService.getScriptProperties().getProperty('GLOBAL_CONFIG');
    if (legacy) {
      try {
        var parsed = JSON.parse(legacy);
        saveAppConfig(parsed, spreadsheetId);
        return { success: true, data: parsed };
      } catch (_) { /* unparseable legacy blob — fall through to defaults */ }
    }

    var defaultCfg = {
      Bistro: {
        store_name: 'My Outlet', company_name: '', address: '', email: '', phone: '',
        currency_symbol: 'RM', series_format: 'INV-26-',
        logo_url: '', footer_text: '', payment_info: ''
      }
    };
    saveAppConfig(defaultCfg, spreadsheetId);
    return { success: true, data: defaultCfg };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── fetchDataAll ─────────────────────────────────────────────
/**
 * FIX: now returns invoice_items[] from the Invoice_Items tab.
 * sheetsService.ts reads json.data.invoice_items — was always [] before.
 */
function fetchDataAll(spreadsheetId, session) {
  try {
    var ss = getDatabase(spreadsheetId);

    // Always migrate schema first — adds any missing columns/sheets without
    // destroying existing data. This ensures new columns (Age, Joining_Date,
    // Payment_Transferred, Transfer_Date) exist before we read row headers.
    initializeDatabase(spreadsheetId);

    var invoicesTab       = ss.getSheetByName("Invoices");
    var customersTab      = ss.getSheetByName("Patrons") || ss.getSheetByName("Customers");
    var employeesTab      = ss.getSheetByName("Employees");
    var payslipsTab       = ss.getSheetByName("Payslips");
    var invoiceItemsTab   = ss.getSheetByName("Invoice_Items");
    var paymentsTab       = ss.getSheetByName("Invoice_Payments");
    var quotationsTab     = ss.getSheetByName("Quotations");
    var quotationDaysTab  = ss.getSheetByName("Quotation_Days");
    var quotationItemsTab = ss.getSheetByName("Quotation_Items");

    var data = {
        invoices:        invoicesTab       ? getSheetRowsAsObjects(invoicesTab)       : [],
        customers:       customersTab      ? getSheetRowsAsObjects(customersTab)      : [],
        employees:       employeesTab      ? getSheetRowsAsObjects(employeesTab)      : [],
        payslips:        payslipsTab       ? getSheetRowsAsObjects(payslipsTab)       : [],
        invoice_items:   invoiceItemsTab   ? getSheetRowsAsObjects(invoiceItemsTab)   : [],
        payments:        paymentsTab       ? getSheetRowsAsObjects(paymentsTab)       : [],
        quotations:      quotationsTab     ? getSheetRowsAsObjects(quotationsTab)     : [],
        quotation_days:  quotationDaysTab  ? getSheetRowsAsObjects(quotationDaysTab)  : [],
        quotation_items: quotationItemsTab ? getSheetRowsAsObjects(quotationItemsTab) : []
    };

    // Withhold tabs this user's modules do not cover. Filtering only in the UI
    // would still send every salary down the wire to a cashier's browser.
    if (session) data = filterDataByModules(data, session);

    return { success: true, data: data };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── Dedupe helper ────────────────────────────────────────────
// Server-side guard: even if a client sends duplicate rows (old build, double
// submit, concurrent tab, etc.), the sheet never stores duplicates. First
// occurrence of a key wins. Keyless rows are kept as-is.
function dedupeRows(rows, keyFn) {
  if (!rows || !rows.length) return rows || [];
  var seen = {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var key = keyFn(rows[i]);
    if (!key) { out.push(rows[i]); continue; }
    if (seen[key]) continue;
    seen[key] = true;
    out.push(rows[i]);
  }
  return out;
}

// Content key for invoice line items — their IDs are regenerated on every edit,
// so we key by (invoice + name + qty + price + subtotal). Must match the
// frontend's invoiceItemKey in sheetsService.ts.
function invoiceItemKey(it) {
  return [
    String(it.Invoice_ID || ''), String(it.Item_Name || ''),
    Number(it.Quantity) || 0, Number(it.Price) || 0, Number(it.Subtotal) || 0
  ].join('|');
}

// ─── syncData ─────────────────────────────────────────────────
function syncData(payload, spreadsheetId, session) {
  if (!payload) return { success: false, error: "Empty payload" };
  // Drop anything this user may not write before a single cell is touched.
  if (session) payload = filterPayloadByModules(payload, session);
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // Migrate schema before writing — ensures column headers exist so values
    // written to columns 21-22 (Payment_Transferred, Transfer_Date, etc.)
    // are correctly labelled and readable on the next fetchDataAll.
    initializeDatabase(spreadsheetId);
    var ss = getDatabase(spreadsheetId);

    // ── Dedupe every payload array before writing ──
    // Guarantees the sheet is clean regardless of what the client sent.
    if (payload.invoices)        payload.invoices        = dedupeRows(payload.invoices,        function(r){ return String(r.Invoice_ID || ''); });
    if (payload.invoice_items)   payload.invoice_items   = dedupeRows(payload.invoice_items,   invoiceItemKey);
    if (payload.payments)        payload.payments        = dedupeRows(payload.payments,        function(r){ return String(r.Payment_ID || ''); });
    if (payload.customers)       payload.customers       = dedupeRows(payload.customers,       function(r){ return (String(r.Customer_Name || '') + '|' + String(r.Branch_Location || '')).toLowerCase(); });
    if (payload.employees)       payload.employees       = dedupeRows(payload.employees,       function(r){ return String(r.Employee_ID || ''); });
    if (payload.payslips)        payload.payslips        = dedupeRows(payload.payslips,        function(r){ return String(r.Payslip_ID || ''); });
    if (payload.quotations)      payload.quotations      = dedupeRows(payload.quotations,      function(r){ return String(r.Quotation_ID || ''); });
    if (payload.quotation_days)  payload.quotation_days  = dedupeRows(payload.quotation_days,  function(r){ return String(r.Day_ID || ''); });
    if (payload.quotation_items) payload.quotation_items = dedupeRows(payload.quotation_items, function(r){ return String(r.Item_ID || ''); });

    // ── Invoices ──
    var invoicesSheet = ss.getSheetByName("Invoices");
    if (invoicesSheet && payload.invoices && payload.invoices.length > 0) {
      if (invoicesSheet.getLastRow() > 1)
        invoicesSheet.getRange(2, 1, invoicesSheet.getLastRow() - 1, invoicesSheet.getLastColumn()).clearContent();
      var invRows = payload.invoices.map(function(i) {
        return [
          i.Invoice_ID || '', i.Date || '', i.Company || '', i.Customer_Name || '',
          i.Status || '', Number(i.Total_Amount) || 0, Number(i.Discount_Value) || 0,
          Number(i.Subtotal_Amount) || 0, i.Notes || '',
          i.Customer_Contact || '-', i.Customer_Address || '-',
          i.Branch_Location || '', i.Invoice_Items_JSON || ''
        ];
      });
      invoicesSheet.getRange(2, 1, invRows.length, invRows[0].length).setValues(invRows);
    }

    // ── Invoice_Items tab (flat rows) ─────────────────────────
    var itemsSheet = ss.getSheetByName("Invoice_Items");
    if (!itemsSheet) {
      itemsSheet = ss.insertSheet("Invoice_Items");
      itemsSheet.appendRow(['Item_ID', 'Invoice_ID', 'Item_Name', 'Quantity', 'Price', 'Subtotal']);
    }
    if (payload.invoice_items && payload.invoice_items.length > 0) {
      if (itemsSheet.getLastRow() > 1)
        itemsSheet.getRange(2, 1, itemsSheet.getLastRow() - 1, itemsSheet.getLastColumn()).clearContent();
      var itemRows = payload.invoice_items.map(function(it) {
        return [
          it.Item_ID || '', it.Invoice_ID || '', it.Item_Name || '',
          Number(it.Quantity) || 0, Number(it.Price) || 0, Number(it.Subtotal) || 0
        ];
      });
      itemsSheet.getRange(2, 1, itemRows.length, itemRows[0].length).setValues(itemRows);
    }

    // ── Invoice_Payments tab (partial payments) ───────────────
    var paymentsSheet = ss.getSheetByName("Invoice_Payments");
    if (!paymentsSheet) {
      paymentsSheet = ss.insertSheet("Invoice_Payments");
      paymentsSheet.appendRow(['Payment_ID', 'Invoice_ID', 'Amount', 'Date', 'Method', 'Reference']);
    }
    if (payload.payments) {
      if (paymentsSheet.getLastRow() > 1)
        paymentsSheet.getRange(2, 1, paymentsSheet.getLastRow() - 1, paymentsSheet.getLastColumn()).clearContent();
      if (payload.payments.length > 0) {
        var payRows = payload.payments.map(function(p) {
          return [
            p.Payment_ID || '', p.Invoice_ID || '', Number(p.Amount) || 0,
            p.Date || '', p.Method || '', p.Reference || ''
          ];
        });
        paymentsSheet.getRange(2, 1, payRows.length, payRows[0].length).setValues(payRows);
      }
    }

    // ── Customers / Patrons ──
    var patronsSheet = ss.getSheetByName("Patrons") || ss.getSheetByName("Customers");
    if (patronsSheet && payload.customers && payload.customers.length > 0) {
      if (patronsSheet.getLastRow() > 1)
        patronsSheet.getRange(2, 1, patronsSheet.getLastRow() - 1, patronsSheet.getLastColumn()).clearContent();
      var custRows = payload.customers.map(function(c) {
        return [c.Customer_Name || '', c.Contact || '-', c.Customer_Type || 'Regular', c.Address || '-', c.Branch_Location || ''];
      });
      patronsSheet.getRange(2, 1, custRows.length, custRows[0].length).setValues(custRows);
    }

    // ── Employees ──
    var employeesSheet = ss.getSheetByName("Employees");
    if (employeesSheet && payload.employees && payload.employees.length > 0) {
      if (employeesSheet.getLastRow() > 1)
        employeesSheet.getRange(2, 1, employeesSheet.getLastRow() - 1, employeesSheet.getLastColumn()).clearContent();
      var empRows = payload.employees.map(function(emp) {
        return [
          emp.Employee_ID || '', emp.Employee_Name || '', emp.IC_Passport || '',
          emp.Position || '', emp.Assigned_Outlet || 'Bistro',
          Number(emp.Basic_Salary) || 0, emp.Bank_Details || '',
          emp.Branch_Location || '', emp.Citizenship || 'Malaysian/PR',
          (emp.Age !== undefined && emp.Age !== null && emp.Age !== '') ? Number(emp.Age) : '',
          emp.Joining_Date || '',
          emp.Employer_Bears_Statutory === true ? true : false
        ];
      });
      employeesSheet.getRange(2, 1, empRows.length, empRows[0].length).setValues(empRows);
    }

    // ── Payslips ──
    var payslipsSheet = ss.getSheetByName("Payslips");
    if (payslipsSheet && payload.payslips && payload.payslips.length > 0) {
      if (payslipsSheet.getLastRow() > 1)
        payslipsSheet.getRange(2, 1, payslipsSheet.getLastRow() - 1, payslipsSheet.getLastColumn()).clearContent();
      var psRows = payload.payslips.map(function(p) {
        return [
          p.Payslip_ID || '', p.Employee_ID || '', p.Issue_Date || '', p.Month_Year || '',
          Number(p.Basic_Pay) || 0, Number(p.Custom_Allowances) || 0, Number(p.Total_Allowances) || 0,
          Number(p.Employee_EPF) || 0, Number(p.Employer_EPF) || 0,
          Number(p.Employee_SOCSO) || 0, Number(p.Employer_SOCSO) || 0,
          Number(p.Employee_EIS) || 0, Number(p.Employer_EIS) || 0,
          Number(p.Total_Statutory_Deductions) || 0, Number(p.Custom_Deductions) || 0,
          Number(p.Final_Net_Pay) || 0, p.Branch_Location || '',
          p.Is_Saved ? true : false,
          p.Allowances_JSON || '', p.Deductions_JSON || '',
          p.Payment_Transferred ? true : false, p.Transfer_Date || '',
          Number(p.Employer_Statutory_Offset) || 0,
          Number(p.Employee_SKBBK) || 0
        ];
      });
      payslipsSheet.getRange(2, 1, psRows.length, psRows[0].length).setValues(psRows);
    }

    // ── Quotations ──
    var quotationsSheet = ss.getSheetByName("Quotations");
    if (quotationsSheet && payload.quotations) {
      if (quotationsSheet.getLastRow() > 1)
        quotationsSheet.getRange(2, 1, quotationsSheet.getLastRow() - 1, quotationsSheet.getLastColumn()).clearContent();
      if (payload.quotations && payload.quotations.length > 0) {
        var qtnRows = payload.quotations.map(function(q) {
          return [
            q.Quotation_ID || '', q.Date || '', q.Valid_Until || '', q.Company || 'Bistro',
            q.Customer_Name || '', q.Customer_Contact || '-', q.Customer_Address || '-',
            q.Pricing_Mode || 'itemized', q.Package_Sub_Mode || '',
            Number(q.Flat_Package_Total) || 0, q.Extra_Charges_JSON || '',
            q.Discount_Type || 'none', Number(q.Discount_Value) || 0,
            Number(q.Subtotal_Amount) || 0, Number(q.Total_Amount) || 0,
            q.Catering_Terms || '', q.Notes || '', q.Branch_Location || '',
            q.Converted_Invoice_ID || ''
          ];
        });
        quotationsSheet.getRange(2, 1, qtnRows.length, qtnRows[0].length).setValues(qtnRows);
      }
    }

    // ── Quotation_Days ──
    var quotationDaysSheet = ss.getSheetByName("Quotation_Days");
    if (quotationDaysSheet && payload.quotation_days) {
      if (quotationDaysSheet.getLastRow() > 1)
        quotationDaysSheet.getRange(2, 1, quotationDaysSheet.getLastRow() - 1, quotationDaysSheet.getLastColumn()).clearContent();
      if (payload.quotation_days && payload.quotation_days.length > 0) {
        var dayRows = payload.quotation_days.map(function(d) {
          return [
            d.Day_ID || '', d.Quotation_ID || '', d.Event_Date || '',
            Number(d.Pax) || 0, d.Serving_Style || 'Buffet Setup',
            Number(d.Day_Package_Rate) || 0
          ];
        });
        quotationDaysSheet.getRange(2, 1, dayRows.length, dayRows[0].length).setValues(dayRows);
      }
    }

    // ── Quotation_Items ──
    var quotationItemsSheet = ss.getSheetByName("Quotation_Items");
    if (quotationItemsSheet && payload.quotation_items) {
      if (quotationItemsSheet.getLastRow() > 1)
        quotationItemsSheet.getRange(2, 1, quotationItemsSheet.getLastRow() - 1, quotationItemsSheet.getLastColumn()).clearContent();
      if (payload.quotation_items && payload.quotation_items.length > 0) {
        var qtnItemRows = payload.quotation_items.map(function(it) {
          return [
            it.Item_ID || '', it.Quotation_ID || '', it.Day_ID || '',
            it.Session_Label || '', it.Session_Time || '', it.Item_Name || '',
            Number(it.Quantity) || 0, Number(it.Price) || 0, Number(it.Subtotal) || 0
          ];
        });
        quotationItemsSheet.getRange(2, 1, qtnItemRows.length, qtnItemRows[0].length).setValues(qtnItemRows);
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ─── initializeDatabase ───────────────────────────────────────
// Always writes the FULL expected header row and clears any extra columns
// beyond it. This fixes misaligned sheets caused by incremental header
// appends landing in the wrong positions (e.g. Nationality vs Citizenship,
// empty-header columns shifting Payment_Transferred out of range).
function enforceHeaders(tab, expected) {
  var last = tab.getLastColumn();
  // Read before writing. initializeDatabase runs on every fetch and sync, and
  // this used to re-write ten header rows each time; headers are almost always
  // already correct, and a read is far cheaper than a setValues.
  if (last >= expected.length) {
    var current = tab.getRange(1, 1, 1, last).getValues()[0];
    var same = true;
    for (var i = 0; i < expected.length; i++) {
      if (String(current[i]) !== expected[i]) { same = false; break; }
    }
    for (var j = expected.length; same && j < last; j++) {
      if (String(current[j]) !== '') { same = false; }
    }
    if (same) return;
  }
  tab.getRange(1, 1, 1, expected.length).setValues([expected]);
  if (last > expected.length) {
    tab.getRange(1, expected.length + 1, 1, last - expected.length).clearContent();
  }
}

// Forces a column to Plain Text format so Sheets stops silently
// auto-converting date-like strings (e.g. "2026-05-15") into real Date
// cells, which previously caused fields like Joining_Date to round-trip
// as shifted/garbled timestamps instead of the plain string we wrote.
function forceTextColumn(tab, colIndex) {
  var maxRows = Math.max(tab.getMaxRows(), 2);
  tab.getRange(2, colIndex, maxRows - 1, 1).setNumberFormat('@');
}

// Get-or-create a tab and pin its header row. Used for the data tabs below and
// for the directory tabs in Auth.gs.
function sheetFor(ss, name, headers) {
  var tab = ss.getSheetByName(name) || ss.insertSheet(name);
  enforceHeaders(tab, headers);
  return tab;
}

function initializeDatabase(spreadsheetId) {
  try {
    var ss = getDatabase(spreadsheetId);

    // ── Invoices ──
    var invoicesTab = ss.getSheetByName("Invoices");
    if (!invoicesTab) invoicesTab = ss.insertSheet("Invoices");
    enforceHeaders(invoicesTab, [
      'Invoice_ID','Date','Company','Customer_Name','Status','Total_Amount',
      'Discount_Value','Subtotal_Amount','Notes','Customer_Contact',
      'Customer_Address','Branch_Location','Invoice_Items_JSON'
    ]);
    forceTextColumn(invoicesTab, 2); // Date

    // ── Invoice_Items ──
    var itemsTab = ss.getSheetByName("Invoice_Items");
    if (!itemsTab) itemsTab = ss.insertSheet("Invoice_Items");
    enforceHeaders(itemsTab, ['Item_ID','Invoice_ID','Item_Name','Quantity','Price','Subtotal']);

    // ── Invoice_Payments ──
    var paymentsTab = ss.getSheetByName("Invoice_Payments");
    if (!paymentsTab) paymentsTab = ss.insertSheet("Invoice_Payments");
    enforceHeaders(paymentsTab, ['Payment_ID','Invoice_ID','Amount','Date','Method','Reference']);
    forceTextColumn(paymentsTab, 4); // Date

    // ── Patrons / Customers ──
    var patronsTab = ss.getSheetByName("Patrons") || ss.getSheetByName("Customers");
    if (!patronsTab) {
      patronsTab = ss.insertSheet("Patrons");
    } else if (patronsTab.getName() === 'Customers') {
      patronsTab.setName("Patrons");
    }
    enforceHeaders(patronsTab, ['Customer_Name','Contact','Customer_Type','Address','Branch_Location']);

    // ── Employees ──
    // Enforcing exact order fixes the legacy "Nationality" column at pos 9
    // that shifted Citizenship/Age/Joining_Date one slot too far to the right.
    var employeesTab = ss.getSheetByName("Employees");
    if (!employeesTab) employeesTab = ss.insertSheet("Employees");
    // Employer_Bears_Statutory appended at the END, not inserted — inserting
    // mid-list would shift every column after it and corrupt existing rows,
    // exactly the class of bug the comment above this block already warns about.
    enforceHeaders(employeesTab, [
      'Employee_ID','Employee_Name','IC_Passport','Position','Assigned_Outlet',
      'Basic_Salary','Bank_Details','Branch_Location','Citizenship','Age','Joining_Date',
      'Employer_Bears_Statutory'
    ]);
    forceTextColumn(employeesTab, 11); // Joining_Date

    // ── Payslips ──
    // Enforcing exact order fixes the two empty-header columns (S, T) that
    // pushed Allowances_JSON and Deductions_JSON headers to the wrong positions,
    // causing Payment_Transferred to land under the wrong label and read as empty.
    var payslipsTab = ss.getSheetByName("Payslips");
    if (!payslipsTab) payslipsTab = ss.insertSheet("Payslips");
    // Employer_Statutory_Offset and Employee_SKBBK appended at the END — same
    // safe-append pattern used for Employees above. Inserting mid-list shifts
    // every column after the insertion point and corrupts existing row data.
    enforceHeaders(payslipsTab, [
      'Payslip_ID','Employee_ID','Issue_Date','Month_Year',
      'Basic_Pay','Custom_Allowances','Total_Allowances',
      'Employee_EPF','Employer_EPF','Employee_SOCSO','Employer_SOCSO',
      'Employee_EIS','Employer_EIS','Total_Statutory_Deductions',
      'Custom_Deductions','Final_Net_Pay','Branch_Location','Is_Saved',
      'Allowances_JSON','Deductions_JSON','Payment_Transferred','Transfer_Date',
      'Employer_Statutory_Offset','Employee_SKBBK'
    ]);
    forceTextColumn(payslipsTab, 3);  // Issue_Date
    forceTextColumn(payslipsTab, 22); // Transfer_Date (col 22 — SKBBK safely at end col 24)

    // ── Quotations ──
    var quotationsTab = ss.getSheetByName("Quotations");
    if (!quotationsTab) quotationsTab = ss.insertSheet("Quotations");
    enforceHeaders(quotationsTab, [
      'Quotation_ID','Date','Valid_Until','Company','Customer_Name',
      'Customer_Contact','Customer_Address','Pricing_Mode','Package_Sub_Mode',
      'Flat_Package_Total','Extra_Charges_JSON','Discount_Type','Discount_Value',
      'Subtotal_Amount','Total_Amount','Catering_Terms','Notes','Branch_Location',
      'Converted_Invoice_ID'
    ]);
    forceTextColumn(quotationsTab, 2); // Date
    forceTextColumn(quotationsTab, 3); // Valid_Until

    // ── Quotation_Days ──
    var quotationDaysTab = ss.getSheetByName("Quotation_Days");
    if (!quotationDaysTab) quotationDaysTab = ss.insertSheet("Quotation_Days");
    enforceHeaders(quotationDaysTab, [
      'Day_ID','Quotation_ID','Event_Date','Pax','Serving_Style','Day_Package_Rate'
    ]);
    forceTextColumn(quotationDaysTab, 3); // Event_Date

    // ── Config (per-company profiles/outlets) ──
    sheetFor(ss, 'Config', ['Key', 'Value']);

    // ── Quotation_Items ──
    // Session_Label/Session_Time let a single day have multiple separately-menu'd
    // sittings (e.g. Breakfast 7:30 AM, Lunch 12:30 PM, Dinner 7:00 PM) each with
    // its own item list, instead of one flat menu per day.
    var quotationItemsTab = ss.getSheetByName("Quotation_Items");
    if (!quotationItemsTab) quotationItemsTab = ss.insertSheet("Quotation_Items");
    enforceHeaders(quotationItemsTab, [
      'Item_ID','Quotation_ID','Day_ID','Session_Label','Session_Time',
      'Item_Name','Quantity','Price','Subtotal'
    ]);
    // Keep Session_Time as plain text so Sheets does not silently auto-convert
    // "7:30 AM" → a time serial (year-1899 Date), which previously forced Code.gs
    // to detect and re-format those serials. Text format means the round-trip is
    // always string → string with no date arithmetic in the middle.
    forceTextColumn(quotationItemsTab, 5); // Session_Time

    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── updateInvoiceStatus ──────────────────────────────────────
function updateInvoiceStatus(invoiceId, newStatus, spreadsheetId) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var ss    = getDatabase(spreadsheetId);
    var sheet = ss.getSheetByName("Invoices");
    var data  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][0] === invoiceId) {
        sheet.getRange(i + 2, 5).setValue(newStatus);
        return { success: true };
      }
    }
    return { success: false, error: "Invoice ID not found" };
  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ─── saveInvoice ──────────────────────────────────────────────
function saveInvoice(payload, spreadsheetId) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var ss            = getDatabase(spreadsheetId);
    var invoicesSheet = ss.getSheetByName("Invoices");
    var patronsSheet  = ss.getSheetByName("Patrons") || ss.getSheetByName("Customers");
    var itemsSheet    = ss.getSheetByName("Invoice_Items");
    if (!itemsSheet) {
      itemsSheet = ss.insertSheet("Invoice_Items");
      itemsSheet.appendRow(['Item_ID','Invoice_ID','Item_Name','Quantity','Price','Subtotal']);
    }

    var existingInvoices = getSheetRowsAsObjects(invoicesSheet);

    // Determine outlet from config
    var isBistro = true;
    try {
      var configStr = PropertiesService.getScriptProperties().getProperty('GLOBAL_CONFIG');
      if (configStr) {
        var cfg = JSON.parse(configStr);
        var nkName = ((cfg.nk && (cfg.nk.name || cfg.nk.store_name)) || 'kiya').toLowerCase();
        var inputCompany = String(payload.company || '').toLowerCase();
        if (inputCompany.indexOf('kiya') !== -1 || inputCompany.indexOf('kandar') !== -1 || inputCompany === nkName)
          isBistro = false;
      }
    } catch (_) {
      if (String(payload.company || '').toLowerCase().indexOf('nasi') !== -1) isBistro = false;
    }

    var prefix = payload.isLegacy
      ? (isBistro ? "LEG-BIS-" : "LEG-NK-")
      : (isBistro ? "BIS-26-"  : "NK-26-");

    var maxId = 0;
    existingInvoices.forEach(function(inv) {
      if (inv.Invoice_ID && inv.Invoice_ID.indexOf(prefix) === 0) {
        var val = parseInt(inv.Invoice_ID.substring(prefix.length), 10);
        if (!isNaN(val) && val > maxId) maxId = val;
      }
    });

    var finalId    = prefix + String(maxId + 1).padStart(4, '0');
    var branchLoc  = payload.branchLocation || (isBistro ? "A1 Bistro" : "Kiya's Restaurant");
    var itemsJson  = JSON.stringify(payload.items || []);

    invoicesSheet.appendRow([
      finalId, payload.date, payload.company, payload.customerName,
      payload.status, payload.totalAmount, payload.discountValue || 0,
      payload.subtotalAmount || payload.totalAmount, payload.notes || '',
      payload.customerContact || '-', payload.customerAddress || '-',
      branchLoc, itemsJson
    ]);

    // Write items to Invoice_Items tab too
    if (payload.items && payload.items.length > 0) {
      payload.items.forEach(function(item, idx) {
        itemsSheet.appendRow([
          item.Item_ID || (finalId + '-' + (idx + 1)),
          finalId,
          item.Item_Name || '',
          Number(item.Quantity) || 0,
          Number(item.Price) || 0,
          Number(item.Subtotal) || 0
        ]);
      });
    }

    // Save customer if requested
    if (payload.saveAsRegular && patronsSheet) {
      var existing = getSheetRowsAsObjects(patronsSheet);
      var alreadyExists = existing.some(function(c) {
        return (c.Customer_Name || '').toLowerCase() === (payload.customerName || '').toLowerCase();
      });
      if (!alreadyExists) {
        patronsSheet.appendRow([
          payload.customerName, payload.customerContact || '-',
          'Regular', payload.customerAddress || '-', branchLoc
        ]);
      }
    }

    return { success: true, invoiceId: finalId };
  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}
