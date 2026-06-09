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
function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    var result = { success: false, error: "Invalid action" };
    if (e.parameter.action === 'getConfig') {
      result = getAppConfig();
    } else if (e.parameter.action === 'fetchDataAll') {
      result = fetchDataAll(e.parameter.spreadsheetId);
    }
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('BizEazy Invoicing')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

function doPost(e) {
  try {
    var postData = {};
    if (e && e.postData && e.postData.contents) {
      try {
        postData = JSON.parse(e.postData.contents);
      } catch (_) {
        // fallback: form-encoded
        e.postData.contents.split('&').forEach(function(part) {
          var kv = part.split('=');
          if (kv.length === 2) postData[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
        });
      }
    }

    var action       = (postData && postData.action)       || (e && e.parameter && e.parameter.action);
    var spreadsheetId = (postData && postData.spreadsheetId) || (e && e.parameter && e.parameter.spreadsheetId);
    var result = { success: false, error: "Invalid action" };

    if (!action) throw new Error("No action specified");

    if      (action === 'saveConfig')           { result = saveAppConfig(postData.config); }
    else if (action === 'getConfig')             { result = getAppConfig(); }
    else if (action === 'saveInvoice')           { result = saveInvoice(postData.payload || postData, spreadsheetId); }
    else if (action === 'updateInvoiceStatus')   { result = updateInvoiceStatus(postData.invoiceId, postData.status, spreadsheetId); }
    else if (action === 'fetchDataAll')          { result = fetchDataAll(spreadsheetId); }
    else if (action === 'syncData')              { result = syncData(postData.db || postData, spreadsheetId); }
    else if (action === 'initializeDatabase')    { result = initializeDatabase(spreadsheetId); }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
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
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values  = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  return values.map(function(row) {
    var obj = {};
    headers.forEach(function(h, idx) { obj[h] = row[idx] !== undefined ? row[idx] : ''; });
    return obj;
  });
}

// ─── App config ───────────────────────────────────────────────
/**
 * Stores config as a JSON string in ScriptProperties.
 * Accepts either an object or a JSON string from the frontend.
 */
function saveAppConfig(config) {
  try {
    var str = (typeof config === 'string') ? config : JSON.stringify(config);
    PropertiesService.getScriptProperties().setProperty('GLOBAL_CONFIG', str);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

/**
 * Returns config as a PARSED OBJECT so the frontend can do gasConfig['Bistro'].
 * Previous version returned a raw string — that broke App.tsx profile mapping.
 */
function getAppConfig() {
  try {
    var stored = PropertiesService.getScriptProperties().getProperty('GLOBAL_CONFIG');
    if (!stored) {
      var defaultCfg = {
        bistro: { prefix: "BIS-26-", name: "A1 Bistro",          address: "16g, Jalan PJU 5/20D, Kota Damansara", contact: "012-3456789" },
        nk:     { prefix: "NK-26-",  name: "Kiya's Restaurant",  address: "14A, Jalan Datuk Sulaiman",            contact: "012-9876543" }
      };
      PropertiesService.getScriptProperties().setProperty('GLOBAL_CONFIG', JSON.stringify(defaultCfg));
      return { success: true, data: defaultCfg };   // ← parsed object
    }
    try {
      return { success: true, data: JSON.parse(stored) };  // ← parsed object
    } catch (_) {
      return { success: true, data: stored };  // last resort: return raw string
    }
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── fetchDataAll ─────────────────────────────────────────────
/**
 * FIX: now returns invoice_items[] from the Invoice_Items tab.
 * sheetsService.ts reads json.data.invoice_items — was always [] before.
 */
function fetchDataAll(spreadsheetId) {
  try {
    var ss = getDatabase(spreadsheetId);

    // Always migrate schema first — adds any missing columns/sheets without
    // destroying existing data. This ensures new columns (Age, Joining_Date,
    // Payment_Transferred, Transfer_Date) exist before we read row headers.
    initializeDatabase(spreadsheetId);

    var invoicesTab     = ss.getSheetByName("Invoices");
    var customersTab    = ss.getSheetByName("Patrons") || ss.getSheetByName("Customers");
    var employeesTab    = ss.getSheetByName("Employees");
    var payslipsTab     = ss.getSheetByName("Payslips");
    var invoiceItemsTab = ss.getSheetByName("Invoice_Items");

    return {
      success: true,
      data: {
        invoices:      invoicesTab     ? getSheetRowsAsObjects(invoicesTab)     : [],
        customers:     customersTab    ? getSheetRowsAsObjects(customersTab)    : [],
        employees:     employeesTab    ? getSheetRowsAsObjects(employeesTab)    : [],
        payslips:      payslipsTab     ? getSheetRowsAsObjects(payslipsTab)     : [],
        invoice_items: invoiceItemsTab ? getSheetRowsAsObjects(invoiceItemsTab) : []
      }
    };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// ─── syncData ─────────────────────────────────────────────────
function syncData(payload, spreadsheetId) {
  if (!payload) return { success: false, error: "Empty payload" };
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    // Migrate schema before writing — ensures column headers exist so values
    // written to columns 21-22 (Payment_Transferred, Transfer_Date, etc.)
    // are correctly labelled and readable on the next fetchDataAll.
    initializeDatabase(spreadsheetId);
    var ss = getDatabase(spreadsheetId);

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
          emp.Joining_Date || ''
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
          p.Payment_Transferred ? true : false, p.Transfer_Date || ''
        ];
      });
      payslipsSheet.getRange(2, 1, psRows.length, psRows[0].length).setValues(psRows);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ─── initializeDatabase ───────────────────────────────────────
function initializeDatabase(spreadsheetId) {
  try {
    var ss = getDatabase(spreadsheetId);

    // Invoices
    var invoicesTab = ss.getSheetByName("Invoices");
    if (!invoicesTab) {
      invoicesTab = ss.insertSheet("Invoices");
      invoicesTab.appendRow([
        'Invoice_ID','Date','Company','Customer_Name','Status','Total_Amount',
        'Discount_Value','Subtotal_Amount','Notes','Customer_Contact',
        'Customer_Address','Branch_Location','Invoice_Items_JSON'
      ]);
    } else {
      var invHeaders = invoicesTab.getRange(1,1,1,invoicesTab.getLastColumn()).getValues()[0];
      if (invHeaders.indexOf('Branch_Location') === -1) {
        invoicesTab.getRange(1, invHeaders.length + 1).setValue('Branch_Location');
        invoicesTab.getRange(1, invHeaders.length + 2).setValue('Invoice_Items_JSON');
      }
    }

    // Invoice_Items (standalone tab — NEW)
    var itemsTab = ss.getSheetByName("Invoice_Items");
    if (!itemsTab) {
      itemsTab = ss.insertSheet("Invoice_Items");
      itemsTab.appendRow(['Item_ID','Invoice_ID','Item_Name','Quantity','Price','Subtotal']);
    }

    // Patrons / Customers
    var patronsTab = ss.getSheetByName("Patrons");
    if (!patronsTab) {
      var oldCustomers = ss.getSheetByName("Customers");
      if (oldCustomers) {
        oldCustomers.setName("Patrons");
        patronsTab = oldCustomers;
        var custHeaders = patronsTab.getRange(1,1,1,patronsTab.getLastColumn()).getValues()[0];
        if (custHeaders.indexOf('Branch_Location') === -1)
          patronsTab.getRange(1, custHeaders.length + 1).setValue('Branch_Location');
      } else {
        patronsTab = ss.insertSheet("Patrons");
        patronsTab.appendRow(['Customer_Name','Contact','Customer_Type','Address','Branch_Location']);
      }
    }

    // Employees
    var employeesTab = ss.getSheetByName("Employees");
    if (!employeesTab) {
      employeesTab = ss.insertSheet("Employees");
      employeesTab.appendRow([
        'Employee_ID','Employee_Name','IC_Passport','Position','Assigned_Outlet',
        'Basic_Salary','Bank_Details','Branch_Location','Citizenship','Age','Joining_Date'
      ]);
    } else {
      var empHeaders = employeesTab.getRange(1,1,1,employeesTab.getLastColumn()).getValues()[0];
      ['Citizenship','Age','Joining_Date'].forEach(function(col) {
        if (empHeaders.indexOf(col) === -1) {
          employeesTab.getRange(1, empHeaders.length + 1).setValue(col);
          empHeaders.push(col);
        }
      });
    }

    // Payslips
    var payslipsTab = ss.getSheetByName("Payslips");
    if (!payslipsTab) {
      payslipsTab = ss.insertSheet("Payslips");
      payslipsTab.appendRow([
        'Payslip_ID','Employee_ID','Issue_Date','Month_Year',
        'Basic_Pay','Custom_Allowances','Total_Allowances',
        'Employee_EPF','Employer_EPF','Employee_SOCSO','Employer_SOCSO',
        'Employee_EIS','Employer_EIS','Total_Statutory_Deductions',
        'Custom_Deductions','Final_Net_Pay','Branch_Location','Is_Saved',
        'Allowances_JSON','Deductions_JSON','Payment_Transferred','Transfer_Date'
      ]);
    } else {
      var psHeaders = payslipsTab.getRange(1,1,1,payslipsTab.getLastColumn()).getValues()[0];
      ['Allowances_JSON','Deductions_JSON','Payment_Transferred','Transfer_Date'].forEach(function(col) {
        if (psHeaders.indexOf(col) === -1) {
          payslipsTab.getRange(1, psHeaders.length + 1).setValue(col);
          psHeaders.push(col);
        }
      });
    }

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
