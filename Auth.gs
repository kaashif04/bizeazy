/**
 * Auth.gs — BizEazy multi-tenant auth, user directory and per-company config.
 * ─────────────────────────────────────────────────────────────
 * Paste this as a SECOND script file (File ▸ New ▸ Script, name it "Auth")
 * alongside Code.gs. Both share one global scope, so Code.gs calls into here.
 *
 * Model:
 *   Directory spreadsheet (auto-created, id in ScriptProperties)
 *     ├─ Companies : one row per tenant  → its own data spreadsheet id
 *     ├─ Users     : unique User_ID, salted+iterated password hash, modules
 *     └─ Sessions  : opaque token → user, with expiry
 *   Company spreadsheet (one per tenant, created on registration)
 *     └─ everything initializeDatabase() builds, plus a Config tab
 *
 * The web app is deployed "Anyone", so every non-public action is gated on a
 * session token here — and the session, not the client, decides which
 * spreadsheet gets read or written. A client-supplied spreadsheetId is ignored.
 *
 * ONE-TIME SETUP: edit and run bootstrapExistingCompany() to register your
 * current spreadsheet as company #1 and create its admin login.
 * ─────────────────────────────────────────────────────────────
 */

// ─── Constants ────────────────────────────────────────────────
var DIRECTORY_PROP     = 'DIRECTORY_SHEET_ID';
var REGISTRATION_PROP  = 'REGISTRATION_CODE';   // optional: set to close public sign-ups
var PW_ITERATIONS      = 5000;
var SESSION_HOURS      = 12;
var SESSION_HOURS_LONG = 24 * 30;               // "remember me"
var MAX_SESSION_ROWS   = 500;
var ALL_MODULES        = ['invoicing', 'quotations', 'payroll', 'settings'];

var COMPANIES_HEADERS = ['Company_ID','Company_Name','Spreadsheet_ID','Owner_Email','Created_At'];
var USERS_HEADERS     = ['User_ID','Company_ID','Password_Hash','Salt','Full_Name','Email','Role','Modules','Active','Created_At'];
var SESSIONS_HEADERS  = ['Token','User_ID','Company_ID','Expires_At'];

// Callable with no session.
var PUBLIC_ACTIONS = { login: true, registerCompany: true, checkUserId: true, ping: true };
// Callable only by a company admin.
var ADMIN_ACTIONS  = { listUsers: true, createUser: true, updateUser: true, resetUserPassword: true, deleteUser: true };

// Which data tabs / payload keys each module owns. Anything listed here is
// withheld from reads and dropped from writes when the user lacks the module —
// hiding payroll in the UI while still shipping salaries over the wire is not
// access control.
var MODULE_KEYS = {
  invoicing:  ['invoices', 'invoice_items', 'payments'],
  quotations: ['quotations', 'quotation_days', 'quotation_items'],
  payroll:    ['employees', 'payslips']
};
// Customers are addressed by both invoicing and quotations, so they are never
// stripped — any module that can create one needs to read the list.
var SHARED_KEYS = ['customers'];

// ─── Directory spreadsheet ────────────────────────────────────
var _directoryCache = null;

function getDirectorySheet() {
  if (_directoryCache) return _directoryCache;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(DIRECTORY_PROP);
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (_) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('BizEazy Directory');
    props.setProperty(DIRECTORY_PROP, ss.getId());
  }
  _directoryCache = ss;
  return ss;
}

// One lookup per tab per execution. resolveSession alone would otherwise open
// the same three tabs several times for a single request.
var _tabCache = {};

function dirTab(name, headers, textColumns) {
  if (_tabCache[name]) return _tabCache[name];
  var ss = getDirectorySheet();
  var existed = !!ss.getSheetByName(name);
  var tab = sheetFor(ss, name, headers);
  // Only on creation: setNumberFormat is a write, and doing it on every lookup
  // would mean every sign-in wrote to the sheet before reading anything.
  if (!existed && textColumns) {
    textColumns.forEach(function(c) { forceTextColumn(tab, c); });
  }
  _tabCache[name] = tab;
  return tab;
}

function companiesTab() { return dirTab('Companies', COMPANIES_HEADERS); }

// Hashes, salts and tokens are hex. One that came out all digits would be read
// back as a number in scientific notation and never match again.
function usersTab()    { return dirTab('Users', USERS_HEADERS, [3, 4]); }
function sessionsTab() { return dirTab('Sessions', SESSIONS_HEADERS, [1]); }

// ponytail: linear column scan per lookup — fine to a few hundred users and
// sessions. Move the directory to Supabase (indexed) before that stops being true.
function findRowIndex(tab, colIndex, value) {
  var last = tab.getLastRow();
  if (last < 2 || !value) return -1;
  var col = tab.getRange(2, colIndex, last - 1, 1).getValues();
  var needle = String(value).toLowerCase();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]).toLowerCase() === needle) return i + 2;
  }
  return -1;
}

function readRow(tab, row, headers) {
  var vals = tab.getRange(row, 1, 1, headers.length).getValues()[0];
  var obj = { _row: row };
  headers.forEach(function(h, i) { obj[h] = vals[i]; });
  return obj;
}

// ─── Passwords ────────────────────────────────────────────────
function randomHex(nBytes) {
  var s = '';
  while (s.length < nBytes * 2) s += Utilities.getUuid().replace(/-/g, '');
  return s.substring(0, nBytes * 2);
}

// ponytail: salted SHA-256 run PW_ITERATIONS times — Apps Script has no bcrypt
// or scrypt, and this is what Utilities gives us. Raise PW_ITERATIONS as login
// latency allows; switch to Supabase Auth (bcrypt) when the backend moves.
function hashPassword(password, salt) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(salt) + String(password), Utilities.Charset.UTF_8
  );
  for (var i = 1; i < PW_ITERATIONS; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  }
  var hex = '';
  for (var j = 0; j < bytes.length; j++) {
    var v = (bytes[j] + 256) % 256;
    hex += (v < 16 ? '0' : '') + v.toString(16);
  }
  return hex;
}

function constantTimeEquals(a, b) {
  a = String(a); b = String(b);
  if (!a || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

// ─── Validation ───────────────────────────────────────────────
function validateUserId(userId) {
  var id = String(userId || '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(id)) {
    return 'User ID must be 3-32 characters, letters/numbers/dot/dash/underscore only.';
  }
  return null;
}

function validatePassword(password) {
  if (String(password || '').length < 8) return 'Password must be at least 8 characters.';
  return null;
}

function cleanModules(modules) {
  if (!modules) return [];
  var list = Array.isArray(modules) ? modules : String(modules).split(',');
  var out = [];
  list.forEach(function(m) {
    var v = String(m).trim().toLowerCase();
    if (ALL_MODULES.indexOf(v) !== -1 && out.indexOf(v) === -1) out.push(v);
  });
  return out;
}

// ─── Users ────────────────────────────────────────────────────
function findUser(userId) {
  var tab = usersTab();
  var row = findRowIndex(tab, 1, userId);
  return row === -1 ? null : readRow(tab, row, USERS_HEADERS);
}

function userModules(user) {
  // An admin always has every module — no way to lock yourself out of Settings.
  if (String(user.Role).toLowerCase() === 'admin') return ALL_MODULES.slice();
  return cleanModules(user.Modules);
}

function publicUser(user) {
  return {
    user_id:   String(user.User_ID),
    full_name: String(user.Full_Name || ''),
    email:     String(user.Email || ''),
    role:      String(user.Role || 'member').toLowerCase(),
    modules:   userModules(user),
    active:    String(user.Active).toLowerCase() !== 'false'
  };
}

function getCompany(companyId) {
  var tab = companiesTab();
  var row = findRowIndex(tab, 1, companyId);
  return row === -1 ? null : readRow(tab, row, COMPANIES_HEADERS);
}

function checkUserId(userId) {
  var invalid = validateUserId(userId);
  if (invalid) return { success: true, data: { available: false, reason: invalid } };
  return { success: true, data: { available: !findUser(userId) } };
}

// ─── Sessions ─────────────────────────────────────────────────
function pruneSessions(tab) {
  var last = tab.getLastRow();
  if (last < 2) return;
  var vals = tab.getRange(2, 1, last - 1, SESSIONS_HEADERS.length).getValues();
  var now = Date.now();
  // Walk backwards so deleting a row never shifts one we have not checked yet.
  for (var i = vals.length - 1; i >= 0; i--) {
    var raw = vals[i][3];
    var exp = (raw instanceof Date) ? raw.getTime() : Date.parse(String(raw));
    var tooMany = (vals.length - i) > MAX_SESSION_ROWS;
    if (!exp || exp < now || tooMany) tab.deleteRow(i + 2);
  }
}

/** What the client gets to know about who it is signed in as. */
function sessionPayload(session, token, expiresAt) {
  var company = session.company;
  return {
    token: token || session.token,
    expires_at: expiresAt || '',
    user: publicUser(session.user),
    company: {
      company_id:     String(company ? company.Company_ID : ''),
      company_name:   String(company ? company.Company_Name : ''),
      spreadsheet_id: String(company ? company.Spreadsheet_ID : '')
    }
  };
}

function createSession(user, remember) {
  var tab = sessionsTab();
  pruneSessions(tab);
  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var hours = remember ? SESSION_HOURS_LONG : SESSION_HOURS;
  var expires = new Date(Date.now() + hours * 3600 * 1000);
  tab.appendRow([token, String(user.User_ID), String(user.Company_ID), expires.toISOString()]);
  return sessionPayload(
    { user: user, company: getCompany(user.Company_ID) }, token, expires.toISOString()
  );
}

function resolveSession(token) {
  if (!token) return null;
  var tab = sessionsTab();
  var row = findRowIndex(tab, 1, token);
  if (row === -1) return null;
  var s = readRow(tab, row, SESSIONS_HEADERS);
  var exp = (s.Expires_At instanceof Date) ? s.Expires_At.getTime() : Date.parse(String(s.Expires_At));
  if (!exp || exp < Date.now()) { tab.deleteRow(row); return null; }

  var user = findUser(s.User_ID);
  if (!user || String(user.Active).toLowerCase() === 'false') return null;
  var company = getCompany(user.Company_ID);
  if (!company) return null;

  return {
    token: token,
    user: user,
    company: company,
    modules: userModules(user),
    isAdmin: String(user.Role).toLowerCase() === 'admin',
    spreadsheetId: String(company.Spreadsheet_ID)
  };
}

function destroySession(token) {
  var tab = sessionsTab();
  var row = findRowIndex(tab, 1, token);
  if (row !== -1) tab.deleteRow(row);
  return { success: true };
}

// ─── Permissions ──────────────────────────────────────────────
function hasModule(session, mod) { return session.modules.indexOf(mod) !== -1; }

/** Blank out data tabs the session's user is not allowed to see. */
function filterDataByModules(data, session) {
  Object.keys(MODULE_KEYS).forEach(function(mod) {
    if (hasModule(session, mod)) return;
    MODULE_KEYS[mod].forEach(function(k) { data[k] = []; });
  });
  return data;
}

/**
 * Drop payload keys the user may not write. syncData only clears a tab when its
 * key is present, so dropping a key leaves that tab untouched rather than wiped.
 */
function filterPayloadByModules(payload, session) {
  Object.keys(MODULE_KEYS).forEach(function(mod) {
    if (hasModule(session, mod)) return;
    MODULE_KEYS[mod].forEach(function(k) { delete payload[k]; });
  });
  return payload;
}

// ─── Login / registration ─────────────────────────────────────
function login(p) {
  var userId   = String((p && p.userId) || '').trim();
  var password = String((p && p.password) || '');
  var remember = !!(p && p.remember);

  var user = findUser(userId);
  // Same message either way — a different error for "no such user" would hand
  // out a list of valid user IDs to anyone who asks.
  var generic = { success: false, error: 'Incorrect user ID or password.' };
  if (!user || !password) return generic;
  if (String(user.Active).toLowerCase() === 'false') {
    return { success: false, error: 'This account has been deactivated. Contact your administrator.' };
  }
  if (!constantTimeEquals(hashPassword(password, user.Salt), user.Password_Hash)) return generic;

  return { success: true, data: createSession(user, remember) };
}

function registerCompany(p) {
  var companyName = String((p && p.companyName) || '').trim();
  var fullName    = String((p && p.fullName) || '').trim();
  var userId      = String((p && p.userId) || '').trim();
  var password    = String((p && p.password) || '');
  var email       = String((p && p.email) || '').trim();

  if (!companyName) return { success: false, error: 'Company name is required.' };
  var badId = validateUserId(userId);     if (badId) return { success: false, error: badId };
  var badPw = validatePassword(password); if (badPw) return { success: false, error: badPw };

  // Registration is reachable by anyone who has the /exec URL, and each sign-up
  // creates a spreadsheet in the script owner's Drive. Set a REGISTRATION_CODE
  // script property to require an invite code; leave it unset to stay open.
  var required = PropertiesService.getScriptProperties().getProperty(REGISTRATION_PROP);
  if (required && String((p && p.registrationCode) || '') !== required) {
    return { success: false, error: 'A valid registration code is required to create a company.' };
  }

  var lock = LockService.getScriptLock();
  try {
    // Held across the uniqueness check AND the write, so two simultaneous
    // registrations cannot both pass the check and create the same User_ID.
    lock.waitLock(30000);
    if (findUser(userId)) return { success: false, error: 'That user ID is already taken.' };

    var ss = SpreadsheetApp.create('BizEazy — ' + companyName);
    var sheetId = ss.getId();
    initializeDatabase(sheetId);

    // ponytail: a new company starts with ONE outlet parked in the legacy
    // 'Bistro' config slot, because Invoice.Company is still the two-value
    // union type in types.ts. Phase 2 widens that to a real outlet id and adds
    // add/remove-branch UI; nothing user-visible reads this key, only the id.
    saveAppConfig({
      Bistro: {
        store_name: companyName,
        company_name: companyName,
        address: '', email: email, phone: '',
        currency_symbol: 'RM',
        series_format: 'INV-' + String(new Date().getFullYear()).slice(2) + '-',
        logo_url: '', footer_text: '', payment_info: ''
      }
    }, sheetId);

    var companyId = 'C' + String(Date.now()).slice(-9);
    companiesTab().appendRow([
      companyId, companyName, sheetId, email, new Date().toISOString()
    ]);

    var salt = randomHex(16);
    usersTab().appendRow([
      userId, companyId, hashPassword(password, salt), salt,
      fullName || userId, email, 'admin', ALL_MODULES.join(','), true,
      new Date().toISOString()
    ]);

    return { success: true, data: createSession(findUser(userId), !!(p && p.remember)) };
  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

// ─── User management (admin) ──────────────────────────────────
function listUsers(session) {
  var tab = usersTab();
  var rows = getSheetRowsAsObjects(tab);
  var mine = rows.filter(function(r) {
    return String(r.Company_ID) === String(session.company.Company_ID) && String(r.User_ID);
  });
  return { success: true, data: mine.map(publicUser) };
}

function createUser(session, p) {
  var userId   = String((p && p.userId) || '').trim();
  var password = String((p && p.password) || '');
  var badId = validateUserId(userId);     if (badId) return { success: false, error: badId };
  var badPw = validatePassword(password); if (badPw) return { success: false, error: badPw };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    if (findUser(userId)) return { success: false, error: 'That user ID is already taken.' };
    var role = String((p && p.role) || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';
    var salt = randomHex(16);
    usersTab().appendRow([
      userId, String(session.company.Company_ID), hashPassword(password, salt), salt,
      String((p && p.fullName) || userId), String((p && p.email) || ''),
      role, cleanModules(p && p.modules).join(','), true, new Date().toISOString()
    ]);
    return { success: true, data: publicUser(findUser(userId)) };
  } catch (err) {
    return { success: false, error: err.toString() };
  } finally {
    lock.releaseLock();
  }
}

/** Guard every admin write: a user from another company is simply not found. */
function ownUser(session, userId) {
  var user = findUser(userId);
  if (!user || String(user.Company_ID) !== String(session.company.Company_ID)) return null;
  return user;
}

function countAdmins(companyId) {
  return getSheetRowsAsObjects(usersTab()).filter(function(r) {
    return String(r.Company_ID) === String(companyId)
      && String(r.Role).toLowerCase() === 'admin'
      && String(r.Active).toLowerCase() !== 'false';
  }).length;
}

function updateUser(session, p) {
  var user = ownUser(session, p && p.userId);
  if (!user) return { success: false, error: 'User not found.' };
  var tab = usersTab();

  var role   = String((p && p.role) || user.Role).toLowerCase() === 'admin' ? 'admin' : 'member';
  var active = (p && p.active !== undefined) ? !!p.active : String(user.Active).toLowerCase() !== 'false';

  // Demoting or disabling the last active admin would lock the whole company
  // out of user management with no way back in through the app.
  var wasActiveAdmin = String(user.Role).toLowerCase() === 'admin' && String(user.Active).toLowerCase() !== 'false';
  if (wasActiveAdmin && (role !== 'admin' || !active) && countAdmins(session.company.Company_ID) <= 1) {
    return { success: false, error: 'This is the only active admin — promote another user first.' };
  }

  if (p.fullName !== undefined) tab.getRange(user._row, 5).setValue(String(p.fullName));
  if (p.email    !== undefined) tab.getRange(user._row, 6).setValue(String(p.email));
  tab.getRange(user._row, 7).setValue(role);
  if (p.modules  !== undefined) tab.getRange(user._row, 8).setValue(cleanModules(p.modules).join(','));
  tab.getRange(user._row, 9).setValue(active);

  return { success: true, data: publicUser(findUser(user.User_ID)) };
}

function resetUserPassword(session, p) {
  var user = ownUser(session, p && p.userId);
  if (!user) return { success: false, error: 'User not found.' };
  var badPw = validatePassword(p && p.password); if (badPw) return { success: false, error: badPw };
  var salt = randomHex(16);
  var tab = usersTab();
  tab.getRange(user._row, 3).setValue(hashPassword(String(p.password), salt));
  tab.getRange(user._row, 4).setValue(salt);
  return { success: true };
}

function deleteUser(session, p) {
  var user = ownUser(session, p && p.userId);
  if (!user) return { success: false, error: 'User not found.' };
  if (String(user.User_ID).toLowerCase() === String(session.user.User_ID).toLowerCase()) {
    return { success: false, error: 'You cannot delete your own account.' };
  }
  if (String(user.Role).toLowerCase() === 'admin' && countAdmins(session.company.Company_ID) <= 1) {
    return { success: false, error: 'This is the only active admin — promote another user first.' };
  }
  usersTab().deleteRow(user._row);
  return { success: true };
}

/** Any signed-in user changing their own password — old password required. */
function changeOwnPassword(session, p) {
  var user = findUser(session.user.User_ID);
  if (!user) return { success: false, error: 'User not found.' };
  if (!constantTimeEquals(hashPassword(String((p && p.oldPassword) || ''), user.Salt), user.Password_Hash)) {
    return { success: false, error: 'Current password is incorrect.' };
  }
  var badPw = validatePassword(p && p.newPassword); if (badPw) return { success: false, error: badPw };
  var salt = randomHex(16);
  var tab = usersTab();
  tab.getRange(user._row, 3).setValue(hashPassword(String(p.newPassword), salt));
  tab.getRange(user._row, 4).setValue(salt);
  return { success: true };
}

// ─── One-time bootstrap ───────────────────────────────────────
/**
 * Registers your EXISTING spreadsheet as company #1 and creates its admin
 * login. Edit the four values, then Run this function once from the editor.
 * Safe to re-run: it will refuse rather than duplicate.
 */
function bootstrapExistingCompany() {
  var SPREADSHEET_ID = '';                  // ← paste the whole Sheets URL, or just the id
  var COMPANY_NAME   = 'My Company';        // ← shown in the app header
  var ADMIN_USER_ID  = 'admin';             // ← the login you will type
  var ADMIN_PASSWORD = '';                  // ← at least 8 characters

  if (!SPREADSHEET_ID) throw new Error('Set SPREADSHEET_ID first (paste the Sheets URL).');
  // Accept a pasted URL as well as a bare id. Double-clicking an id in the URL
  // bar selects only the run between '_' and '-', so a hand-picked id is easy
  // to truncate in a way that still looks plausible.
  var urlMatch = String(SPREADSHEET_ID).match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) SPREADSHEET_ID = urlMatch[1];
  if (!/^[a-zA-Z0-9_-]{30,}$/.test(SPREADSHEET_ID)) {
    throw new Error('That does not look like a full spreadsheet id ("' + SPREADSHEET_ID +
      '", ' + SPREADSHEET_ID.length + ' chars). Paste the entire URL between /d/ and /edit.');
  }
  var badPw = validatePassword(ADMIN_PASSWORD); if (badPw) throw new Error(badPw);
  var badId = validateUserId(ADMIN_USER_ID);    if (badId) throw new Error(badId);
  if (findUser(ADMIN_USER_ID)) throw new Error('User "' + ADMIN_USER_ID + '" already exists — nothing to do.');

  SpreadsheetApp.openById(SPREADSHEET_ID); // fails loudly if the id is wrong
  initializeDatabase(SPREADSHEET_ID);

  var companyId = 'C' + String(Date.now()).slice(-9);
  companiesTab().appendRow([companyId, COMPANY_NAME, SPREADSHEET_ID, '', new Date().toISOString()]);

  var salt = randomHex(16);
  usersTab().appendRow([
    ADMIN_USER_ID, companyId, hashPassword(ADMIN_PASSWORD, salt), salt,
    'Administrator', '', 'admin', ALL_MODULES.join(','), true, new Date().toISOString()
  ]);

  Logger.log('Company "%s" registered as %s.', COMPANY_NAME, companyId);
  Logger.log('Directory spreadsheet: %s', getDirectorySheet().getUrl());
  Logger.log('Log in as "%s". Delete the password from this function now.', ADMIN_USER_ID);
}

// ─── Self-check ───────────────────────────────────────────────
/**
 * Run from the editor after pasting. Throws on the first broken assumption.
 * Touches no sheets — pure logic only.
 */
function runAuthSelfCheck() {
  function ok(cond, msg) { if (!cond) throw new Error('SELF-CHECK FAILED: ' + msg); }

  var salt = randomHex(16);
  ok(salt.length === 32, 'salt should be 32 hex chars, got ' + salt.length);
  ok(randomHex(16) !== salt, 'two salts must differ');

  var h = hashPassword('correct horse battery', salt);
  ok(h.length === 64, 'hash should be 64 hex chars, got ' + h.length);
  ok(hashPassword('correct horse battery', salt) === h, 'same password+salt must rehash identically');
  ok(hashPassword('correct horse batterx', salt) !== h, 'different password must hash differently');
  ok(hashPassword('correct horse battery', randomHex(16)) !== h, 'different salt must hash differently');

  ok(constantTimeEquals(h, h), 'equal hashes must compare equal');
  // Flip the last nibble to something it is definitely not. Appending a fixed
  // '0' looked like a different hash but was the same string 1 run in 16.
  var flipped = h.slice(0, 63) + (h.charAt(63) === '0' ? '1' : '0');
  ok(!constantTimeEquals(h, flipped), 'differing hashes must not compare equal');
  ok(!constantTimeEquals(h, h.slice(0, 63)), 'different lengths must not compare equal');
  ok(!constantTimeEquals('', ''), 'empty must never pass');

  ok(validateUserId('ab') !== null, 'too-short user id must be rejected');
  ok(validateUserId('has space') !== null, 'spaces must be rejected');
  ok(validateUserId('kaashif.04') === null, 'valid user id must be accepted');
  ok(validatePassword('short') !== null, 'short password must be rejected');
  ok(validatePassword('longenough') === null, '8+ char password must be accepted');

  ok(cleanModules('invoicing, PAYROLL, nonsense,invoicing').join(',') === 'invoicing,payroll',
     'cleanModules must lowercase, drop unknowns and dedupe');
  ok(userModules({ Role: 'admin', Modules: '' }).length === ALL_MODULES.length, 'admin gets every module');
  ok(userModules({ Role: 'member', Modules: 'payroll' }).join(',') === 'payroll', 'member gets only listed modules');

  var session = { modules: ['payroll'] };
  var data = { invoices: [1], invoice_items: [1], payments: [1], customers: [1], employees: [1], payslips: [1],
               quotations: [1], quotation_days: [1], quotation_items: [1] };
  filterDataByModules(data, session);
  ok(data.invoices.length === 0 && data.quotations.length === 0, 'reads must withhold modules the user lacks');
  ok(data.employees.length === 1, 'reads must keep the module the user has');
  ok(data.customers.length === 1, 'customers are shared and must survive');

  var payload = { invoices: [1], payslips: [1], quotations: [1] };
  filterPayloadByModules(payload, session);
  ok(payload.invoices === undefined && payload.quotations === undefined, 'writes must drop forbidden keys');
  ok(payload.payslips !== undefined, 'writes must keep permitted keys');

  Logger.log('All auth self-checks passed.');
  return 'All auth self-checks passed.';
}
