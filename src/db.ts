/**
 * db.ts — the app's records in Supabase.
 *
 * Loading reads every record this user's modules allow (row-level security
 * filters the rest). Saving sends only what changed since the last load or
 * save — rows added or edited here, and rows deleted here — in one call and one
 * transaction. Rows nobody touched on this device are never written, so a stale
 * device cannot revert another's work, and nothing is ever rewritten wholesale.
 */
import { supabase } from './supabase';
import { DatabaseState } from './types';
import { parseSheetExport } from './sheetsImport';
import type { CompanyProfile } from './types';

export const KINDS = [
  'invoices', 'invoice_items', 'payments', 'customers',
  'employees', 'payslips', 'quotations', 'quotation_days', 'quotation_items',
] as const;
export type Kind = typeof KINDS[number];

export const EMPTY_DB: DatabaseState = {
  invoices: [], invoice_items: [], payments: [], customers: [],
  employees: [], payslips: [], quotations: [], quotation_days: [], quotation_items: [],
};

/**
 * Each record's identity within its company. Child rows are keyed under their
 * parent, so two invoices that both number their first line "1" stay apart.
 */
export const recordKey: Record<Kind, (r: any) => string> = {
  invoices:        r => String(r.Invoice_ID || ''),
  invoice_items:   r => r.Invoice_ID
    ? `${r.Invoice_ID}|${r.Item_ID || `${r.Item_Name}|${Number(r.Quantity) || 0}|${Number(r.Price) || 0}`}` : '',
  payments:        r => String(r.Payment_ID || ''),
  customers:       r => r.Customer_Name
    ? `${String(r.Customer_Name).toLowerCase()}|${String(r.Branch_Location || '').toLowerCase()}` : '',
  employees:       r => String(r.Employee_ID || ''),
  payslips:        r => String(r.Payslip_ID || ''),
  quotations:      r => String(r.Quotation_ID || ''),
  quotation_days:  r => r.Day_ID ? `${r.Quotation_ID || ''}|${r.Day_ID}` : '',
  quotation_items: r => r.Item_ID ? `${r.Quotation_ID || ''}|${r.Item_ID}` : '',
};

export interface Changes {
  upserts: { kind: Kind; id: string; data: unknown }[];
  deletes: { kind: Kind; id: string }[];
}

/** What turns `base` into `next`. Pure, for the self-check. */
export function diffRecords(base: DatabaseState | null, next: DatabaseState): Changes {
  const changes: Changes = { upserts: [], deletes: [] };
  KINDS.forEach(kind => {
    const key = recordKey[kind];
    const before = new Map((base?.[kind] as any[] || []).map(r => [key(r), JSON.stringify(r)]));
    const here = new Set<string>();
    (next[kind] as any[] || []).forEach(row => {
      const id = key(row);
      if (!id || here.has(id)) return;          // keyless or repeated: nothing safe to write
      here.add(id);
      if (before.get(id) !== JSON.stringify(row)) changes.upserts.push({ kind, id, data: row });
    });
    before.forEach((_, id) => { if (id && !here.has(id)) changes.deletes.push({ kind, id }); });
  });
  return changes;
}

const isEmpty = (db: DatabaseState) => KINDS.every(k => !(db[k] as any[] || []).length);

/** What this device last loaded or saved: the base every save is diffed against. */
let lastSeen: DatabaseState | null = null;
const clone = (db: DatabaseState): DatabaseState => JSON.parse(JSON.stringify(db));

/** Forget the base, e.g. on sign-out, so nothing is ever diffed across accounts. */
export const forgetLoaded = () => { lastSeen = null; };

function friendly(error: { message?: string; code?: string } | null): Error {
  const message = error?.message || 'Unknown error';
  if (error?.code === '42501' || /row-level security|permission/i.test(message)) {
    return new Error('Your account is not allowed to change that. Ask your administrator for access.');
  }
  if (/fetch|network|Failed to/i.test(message)) {
    return new Error('Could not reach the server. Your changes are still on screen — check the connection and try again.');
  }
  return new Error(message);
}

/** Every record this user may see. */
export async function loadAll(): Promise<DatabaseState> {
  const db: DatabaseState = clone(EMPTY_DB);
  const PAGE = 1000;   // the API's default row cap per request
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('records').select('kind, id, data')
      .order('kind').order('id')
      .range(from, from + PAGE - 1);
    if (error) throw friendly(error);
    (data || []).forEach(r => { (db[r.kind as Kind] as any[])?.push(r.data); });
    if (!data || data.length < PAGE) break;
  }
  lastSeen = clone(db);
  return db;
}

async function apply(changes: Changes) {
  // Large sets (the import) go in batches; an everyday save is a single call.
  const BATCH = 500;
  const total = Math.max(changes.upserts.length, changes.deletes.length);
  for (let i = 0; i === 0 || i < total; i += BATCH) {
    const { error } = await supabase.rpc('apply_changes', {
      p_upserts: changes.upserts.slice(i, i + BATCH),
      p_deletes: changes.deletes.slice(i, i + BATCH),
    });
    if (error) throw friendly(error);
  }
}

/** Save what changed on this device since it last loaded or saved. */
export async function saveChanges(next: DatabaseState): Promise<void> {
  // An emptied copy (as after a sign-out) is never read as "delete everything".
  if (lastSeen && isEmpty(next) && !isEmpty(lastSeen)) {
    throw new Error('Nothing to save: the records on this screen are empty. Reload to try again.');
  }
  const changes = diffRecords(lastSeen, next);
  if (!changes.upserts.length && !changes.deletes.length) return;
  await apply(changes);
  lastSeen = clone(next);
}

// ── Settings (branch profiles and the like) ───────────────────
/**
 * Config keys that are company settings, not branches. Everything else in the
 * config is a branch keyed by its outlet id, so these must be skipped wherever
 * branches are listed and kept wherever branches are saved.
 */
export const RESERVED_CONFIG_KEYS = ['settings', 'notifications'];
export const isBranchKey = (key: string) => !RESERVED_CONFIG_KEYS.includes(key);

export type PayrollScope = 'company' | 'branch';
/** Payroll lists the whole company's staff together unless the company chose branches. */
export const payrollScopeOf = (config: Record<string, any>): PayrollScope =>
  config?.settings?.payroll_scope === 'branch' ? 'branch' : 'company';

/** Change company settings without touching the branches saved beside them. */
export async function saveCompanySettings(patch: Record<string, any>): Promise<Record<string, any>> {
  const current = await loadConfig();
  const next = { ...current, settings: { ...(current.settings || {}), ...patch } };
  await saveConfig(next);
  return next;
}

export async function loadConfig(): Promise<Record<string, any>> {
  const { data, error } = await supabase.from('config').select('key, value');
  if (error) throw friendly(error);
  return Object.fromEntries((data || []).map(r => [r.key, r.value]));
}

/** Saves the whole set: keys left out are removed. */
export async function saveConfig(config: Record<string, any>): Promise<void> {
  const { error } = await supabase.rpc('replace_config', { p_config: config });
  if (error) throw friendly(error);
}

// ── Moving from Google Sheets ─────────────────────────────────
export interface ImportResult { counts: Record<Kind, number>; branches: number }

/**
 * Copy a Code.gs exportForBizEazy() file into this company. Safe to run again:
 * every record is written under its own id, so a second run updates rather
 * than duplicates. The branch settings in the file replace the current ones.
 */
export async function importSheetExport(
  text: string,
  toProfiles: (config: Record<string, any>) => CompanyProfile[],
): Promise<ImportResult> {
  let file: any;
  try { file = JSON.parse(text); } catch { throw new Error('That file is not a BizEazy export (it is not valid JSON).'); }

  // A backup from this app: records are already in the app's shape.
  if (file?.format === BACKUP_FORMAT && file.data && typeof file.data === 'object') {
    const config = file.config && typeof file.config === 'object' ? file.config : {};
    if (Object.keys(config).length) await saveConfig(config);
    const db = { ...EMPTY_DB, ...Object.fromEntries(KINDS.map(k => [k, Array.isArray(file.data[k]) ? file.data[k] : []])) } as DatabaseState;
    await apply(diffRecords(null, db));
    const counts = Object.fromEntries(KINDS.map(k => [k, (db[k] as any[]).length])) as Record<Kind, number>;
    return { counts, branches: toProfiles(config).length };
  }

  if (!file || file.format !== 'bizeazy-sheets-export' || typeof file.data !== 'object') {
    throw new Error('That file is not a BizEazy export. Run exportForBizEazy() in Apps Script and choose the file it saves.');
  }

  const config = file.config && typeof file.config === 'object' ? file.config : {};
  if (Object.keys(config).length) await saveConfig(config);

  const db = parseSheetExport(file.data, toProfiles(config));
  await apply(diffRecords(null, db));

  const counts = Object.fromEntries(KINDS.map(k => [k, (db[k] as any[]).length])) as Record<Kind, number>;
  return { counts, branches: toProfiles(config).length };
}

// ── Backups ───────────────────────────────────────────────────
const BACKUP_FORMAT = 'bizeazy-backup';

/**
 * Everything this user can see, as one file. Restoring it (Data & Import)
 * writes every record back under its own id: it puts back anything missing or
 * changed since, and leaves records created after the backup alone.
 */
export const backupJson = (db: DatabaseState, config: Record<string, any>, companyName: string): string =>
  JSON.stringify({ format: BACKUP_FORMAT, version: 1, exported_at: new Date().toISOString(), company: companyName, config, data: db });

const SHEET_TITLES: Record<Kind, string> = {
  invoices: 'Invoices', invoice_items: 'Invoice lines', payments: 'Payments', customers: 'Customers',
  employees: 'Employees', payslips: 'Payslips', quotations: 'Quotations',
  quotation_days: 'Quotation days', quotation_items: 'Quotation lines',
};

/** One worksheet per record type, plus the branches without their logos and designs. */
export function workbookSheets(db: DatabaseState, config: Record<string, any>) {
  const branches = Object.entries(config)
    .filter(([k, v]) => isBranchKey(k) && v && typeof v === 'object' && !Array.isArray(v))
    .map(([id, v]: [string, any]) => {
      const { logo_url, template, ...rest } = v;
      return { Branch_ID: id, ...rest };
    });
  return [
    ...KINDS.map(k => ({ name: SHEET_TITLES[k], rows: db[k] as any[] })),
    { name: 'Branches', rows: branches },
  ];
}

// ── Who changed what ──────────────────────────────────────────
export interface Change { kind: Kind; id: string; at: string; by: string }

/**
 * The latest edits and additions, newest first, with who made them. Deletions
 * leave no row behind, so they do not appear here.
 */
export async function recentChanges(limit = 30): Promise<Change[]> {
  const [{ data: rows, error }, { data: people }] = await Promise.all([
    supabase.from('records').select('kind, id, updated_at, updated_by').order('updated_at', { ascending: false }).limit(limit),
    supabase.from('profiles').select('user_id, display_id, full_name'),
  ]);
  if (error) throw friendly(error);
  const names = new Map((people || []).map(p => [p.user_id, p.full_name || p.display_id]));
  return (rows || []).map(r => ({
    kind: r.kind as Kind, id: r.id, at: r.updated_at,
    by: r.updated_by ? names.get(r.updated_by) || 'A removed user' : 'Unknown',
  }));
}
