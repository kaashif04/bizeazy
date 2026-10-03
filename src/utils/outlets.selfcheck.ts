/**
 * Runnable check for outlet resolution: `npx tsx src/utils/outlets.selfcheck.ts`.
 *
 * This is the piece that decides which outlet an existing invoice belongs to.
 * Get it wrong and years of real invoices silently reassign themselves to the
 * wrong branch, so the legacy cases are pinned here deliberately.
 */
import { CompanyProfile } from '../types';
import {
  resolveOutletId, activeOutlet, findOutlet, outletLabel, outletInitials,
  outletColor, outletUsage, newOutletId, OUTLET_COLORS,
} from './outlets';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

const profile = (over: Partial<CompanyProfile> & { id: string }): CompanyProfile => ({
  name: '', address: '', email: '', phone: '', currency_symbol: 'RM', ...over,
} as CompanyProfile);

// The original company, exactly as its Config tab holds it.
const legacyPair = [
  profile({ id: 'Bistro', name: 'A1 Bistro', store_name: 'A1 Bistro', series_format: 'BIS-26-' }),
  profile({ id: 'Nasi Kandar', name: "Kiya's Restaurant", store_name: "Kiya's Restaurant", series_format: 'NK-26-' }),
];

// ── Resolution: by name ──
ok(resolveOutletId('A1 Bistro', 'BIS-26-0001', legacyPair) === 'Bistro', 'exact store name must resolve');
ok(resolveOutletId("kiya's restaurant", 'NK-26-0007', legacyPair) === 'Nasi Kandar', 'name match must ignore case');

// ── Resolution: by series prefix, when the name has since been changed ──
ok(resolveOutletId('Some Old Name', 'NK-26-0007', legacyPair) === 'Nasi Kandar',
   'a renamed outlet must still be found by its invoice prefix');
ok(resolveOutletId('', 'BIS-26-0100', legacyPair) === 'Bistro', 'a blank Company column must fall back to the prefix');

// ── Resolution: legacy rows from the original build ──
ok(resolveOutletId('', 'LEG-NK-0003', legacyPair) === 'Nasi Kandar', 'LEG-NK must stay Nasi Kandar');
ok(resolveOutletId('', 'LEG-BIS-0003', legacyPair) === 'Bistro', 'LEG-BIS must stay Bistro');
ok(resolveOutletId('Nasi Kandar', 'X-1', legacyPair) === 'Nasi Kandar', 'the bare words must still resolve');

// ── Resolution: unknowable rows land on the first outlet, never undefined ──
ok(resolveOutletId('', '', legacyPair) === 'Bistro', 'an unresolvable row must fall back to the first outlet');
ok(resolveOutletId('Whatever', 'ZZZ-1', []) === 'Bistro', 'no profiles at all must still return something');

// ── Resolution with many outlets, including generated ids ──
const many = [
  profile({ id: 'Bistro', store_name: 'A1 Bistro', series_format: 'BIS-26-' }),
  profile({ id: 'outlet-x1', store_name: 'Georgetown Branch', series_format: 'GT-26-' }),
  profile({ id: 'outlet-x2', store_name: 'Ipoh Branch', series_format: 'IP-26-' }),
  profile({ id: 'outlet-x3', store_name: 'Johor Branch', series_format: 'B' }),
];
ok(resolveOutletId('Ipoh Branch', 'IP-26-0001', many) === 'outlet-x2', 'a generated-id outlet must resolve by name');
ok(resolveOutletId('', 'GT-26-0009', many) === 'outlet-x1', 'a generated-id outlet must resolve by prefix');
ok(resolveOutletId('', 'BIS-26-0009', many) === 'Bistro',
   'the longest matching prefix must win over a one-letter series');
ok(resolveOutletId('', 'B-26-0009', many) === 'outlet-x3', 'a short prefix still matches when nothing longer does');
ok(resolveOutletId('Unknown Co', 'QQ-1', many) === 'Bistro', 'unresolvable must take the first outlet, not guess');

// A fifth outlet whose name happens to contain "bistro" must not be dragged to
// the legacy 'Bistro' id when it resolves by name first.
const withDecoy = [...many, profile({ id: 'outlet-x4', store_name: 'Bistro Penang', series_format: 'BP-26-' })];
ok(resolveOutletId('Bistro Penang', 'BP-26-0001', withDecoy) === 'outlet-x4',
   'an outlet merely named "Bistro …" must resolve to itself');

// ── Active outlet from the branch name held in app state ──
ok(activeOutlet(many, 'Ipoh Branch')?.id === 'outlet-x2', 'active outlet must match the branch label');
ok(activeOutlet(many, 'ipoh branch')?.id === 'outlet-x2', 'active outlet match must ignore case');
ok(activeOutlet(many, 'Ipoh')?.id === 'outlet-x2', 'a partial branch name must still find its outlet');
ok(activeOutlet(many, '')?.id === 'Bistro', 'no branch selected must mean the first outlet');
ok(activeOutlet([], 'anything') === undefined, 'no outlets must mean no active outlet');

// ── Lookup, labels, colours ──
ok(findOutlet(many, 'outlet-x2')?.id === 'outlet-x2', 'findOutlet must match by id');
ok(findOutlet(many, 'Johor Branch')?.id === 'outlet-x3', 'findOutlet must match by display name');
ok(findOutlet(many, 'nope') === undefined, 'findOutlet must return undefined when absent');
ok(findOutlet(many, '') === undefined, 'findOutlet must not match on an empty string');

ok(outletLabel(profile({ id: 'x', store_name: 'Store', name: 'Name' })) === 'Store', 'store_name wins the label');
ok(outletLabel(profile({ id: 'x', name: 'Name' })) === 'Name', 'name is the next label choice');
ok(outletLabel(profile({ id: 'x' })) === 'x', 'the id is the last resort label');
ok(outletInitials(profile({ id: 'x', store_name: 'La Bistro Cafe' })) === 'LB', 'initials take the first two words');
ok(outletInitials(profile({ id: 'x', store_name: 'Ipoh' })) === 'I', 'a one-word name gives one initial');

ok(outletColor(profile({ id: 'x', template: { primary_color: '#123456' } as any }), 3) === '#123456',
   'a configured accent colour must be used');
ok(outletColor(profile({ id: 'x' }), 1) === OUTLET_COLORS[1], 'without one, the palette is indexed by position');
ok(outletColor(profile({ id: 'x' }), OUTLET_COLORS.length) === OUTLET_COLORS[0], 'the palette wraps round');
ok(outletColor(undefined, 0) === OUTLET_COLORS[0], 'a missing profile still yields a colour');

ok(newOutletId() !== newOutletId(), 'generated outlet ids must differ');
ok(/^outlet-[a-z0-9]+$/.test(newOutletId()), 'generated ids must be config-key safe');

// ── Usage count, which is what blocks deleting an outlet with data ──
const db = {
  invoices:   [{ Company: 'Ipoh Branch' }, { Company: 'outlet-x2' }, { Company: 'A1 Bistro' }],
  quotations: [{ Company: 'Ipoh Branch' }],
  employees:  [{ Assigned_Outlet: 'Ipoh Branch' }, { Assigned_Outlet: 'A1 Bistro' }],
};
const used = outletUsage(many, 'outlet-x2', db);
ok(used.invoices === 2, `rows referencing the outlet by id OR name must both count, got ${used.invoices}`);
ok(used.quotations === 1 && used.employees === 1, 'quotations and employees must be counted');
ok(used.total === 4, `total must add up, got ${used.total}`);
ok(outletUsage(many, 'outlet-x3', db).total === 0, 'an unused outlet must report zero');

console.log('All outlet self-checks passed.');
