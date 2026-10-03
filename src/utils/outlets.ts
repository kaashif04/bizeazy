/**
 * outlets.ts — everything that used to be `isBistro ? … : …`.
 *
 * An outlet's id is simply its key in the company Config tab. That is why no
 * data migration was needed to lift the two-outlet cap: the original company
 * keeps the keys 'Bistro' and 'Nasi Kandar' as ids (internal, never displayed),
 * while outlets added from now on get a generated id. Sheet rows go on
 * referencing outlets by display name in their Company column, exactly as
 * before, and resolveOutletId maps that back to an id on read.
 */
import { CompanyProfile } from '../types';

/** Dot/accent colours for outlets with no primary_color of their own yet. */
export const OUTLET_COLORS = [
  '#B45309', '#065F46', '#1D4ED8', '#BE123C', '#4338CA', '#0D9488', '#C2410C', '#4D7C0F',
];

const norm = (v?: string): string => String(v || '').trim().toLowerCase();

export const outletLabel = (p: CompanyProfile): string => p.store_name || p.name || p.id;

export const outletColor = (p: CompanyProfile | undefined, index: number): string =>
  p?.template?.primary_color || OUTLET_COLORS[Math.max(0, index) % OUTLET_COLORS.length];

/** "La Bistro Cafe" → "LB". Used where a logo has not been uploaded. */
export const outletInitials = (p: CompanyProfile): string =>
  outletLabel(p).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

export const newOutletId = (): string =>
  `outlet-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const outletIndex = (profiles: CompanyProfile[], id: string): number =>
  profiles.findIndex(p => p.id === id);

export const findOutlet = (profiles: CompanyProfile[], idOrName: string): CompanyProfile | undefined => {
  const needle = norm(idOrName);
  if (!needle) return undefined;
  return profiles.find(p => norm(p.id) === needle)
      || profiles.find(p => norm(outletLabel(p)) === needle)
      || profiles.find(p => norm(p.name) === needle);
};

/**
 * Which outlet the user is working in. `activeBranchLocation` holds a display
 * name, because that is what gets written to every row's Branch_Location.
 */
export const activeOutlet = (
  profiles: CompanyProfile[], activeBranchLocation: string,
): CompanyProfile | undefined => {
  const needle = norm(activeBranchLocation);
  return findOutlet(profiles, activeBranchLocation)
      || (needle ? profiles.find(p => norm(outletLabel(p)).indexOf(needle) !== -1) : undefined)
      || profiles[0];
};

/** Legacy shapes written by the original two-outlet build. */
function legacyGuess(company: string, docId: string): string | null {
  const comp = norm(company);
  const id = String(docId || '');
  // Nasi Kandar first: the original resolution order, and 'NK' is the more
  // distinctive marker of the two.
  if (id.indexOf('LEG-NK') === 0 || id.indexOf('NK') !== -1
      || comp.indexOf('nasi') !== -1 || comp.indexOf('kandar') !== -1 || comp.indexOf('kiya') !== -1) {
    return 'Nasi Kandar';
  }
  if (id.indexOf('LEG-BIS') === 0 || comp.indexOf('bistro') !== -1) return 'Bistro';
  return null;
}

/**
 * Map a sheet row back to an outlet id. Rows store the outlet's display NAME in
 * their Company column, and a renamed outlet leaves older rows holding the old
 * name — hence the series-prefix and legacy fallbacks rather than a name match
 * alone.
 */
export function resolveOutletId(
  rowCompany: string, docId: string, profiles: CompanyProfile[],
): string {
  if (!profiles.length) return legacyGuess(rowCompany, docId) || 'Bistro';
  const fallback = profiles[0].id;
  const comp = norm(rowCompany);
  const id = String(docId || '');

  // 1. The row names the outlet outright.
  const byName = profiles.find(p =>
    comp && (norm(p.store_name) === comp || norm(p.name) === comp || norm(p.id) === comp));
  if (byName) return byName.id;

  // 2. The document id carries the outlet's series prefix. Longest match wins,
  //    so "BIS-26-" beats an outlet whose series is merely "B".
  const byPrefix = profiles
    .filter(p => p.series_format && id.indexOf(p.series_format) === 0)
    .sort((a, b) => (b.series_format || '').length - (a.series_format || '').length)[0];
  if (byPrefix) return byPrefix.id;

  // 3. Rows from before this company had outlets configured at all.
  const legacy = legacyGuess(rowCompany, docId);
  if (legacy && profiles.some(p => p.id === legacy)) return legacy;

  return fallback;
}

/**
 * How many stored rows still point at an outlet. Used to refuse deleting an
 * outlet that would orphan invoices, quotations or staff.
 */
export function outletUsage(
  profiles: CompanyProfile[], id: string,
  db: { invoices: { Company: string }[]; quotations: { Company: string }[]; employees: { Assigned_Outlet: string }[] },
): { invoices: number; quotations: number; employees: number; total: number } {
  const target = findOutlet(profiles, id);
  const label = target ? norm(outletLabel(target)) : '';
  const matches = (v: string) => norm(v) === norm(id) || (!!label && norm(v) === label);

  const invoices = db.invoices.filter(r => matches(r.Company)).length;
  const quotations = db.quotations.filter(r => matches(r.Company)).length;
  const employees = db.employees.filter(r => matches(r.Assigned_Outlet)).length;
  return { invoices, quotations, employees, total: invoices + quotations + employees };
}

/** "#B45309" → [180, 83, 9], for jsPDF which takes component arrays. */
export const hexToRgb = (hex: string): [number, number, number] => {
  const clean = (hex || '').replace('#', '');
  if (clean.length < 6) return [180, 83, 9];
  return [
    parseInt(clean.slice(0, 2), 16) || 30,
    parseInt(clean.slice(2, 4), 16) || 140,
    parseInt(clean.slice(4, 6), 16) || 120,
  ];
};
