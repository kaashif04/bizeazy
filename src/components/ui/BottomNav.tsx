/**
 * BottomNav.tsx — primary navigation where the thumb already is.
 *
 * Phone only. On a phone the module switcher used to live behind a hamburger
 * at the top-left, which is the furthest point from a thumb on a held device,
 * and in a second ad-hoc row of pills in the hub header. Both are replaced by
 * one bar. The off-canvas sidebar stays for the things you touch rarely:
 * branch, refresh, settings, users, theme, sign out.
 */
import React from 'react';
import { LayoutDashboard, FileText, CalendarRange, Users, BarChart3, UserCheck } from 'lucide-react';

export type NavView = 'hub' | 'invoicing' | 'quotations' | 'payroll' | 'reports' | 'team';

const TABS: { view: NavView; label: string; Icon: React.FC<React.SVGProps<SVGSVGElement>> }[] = [
  { view: 'hub', label: 'Hub', Icon: LayoutDashboard },
  { view: 'invoicing', label: 'Invoices', Icon: FileText },
  { view: 'quotations', label: 'Quotes', Icon: CalendarRange },
  { view: 'payroll', label: 'Payroll', Icon: Users },
  { view: 'reports', label: 'Reports', Icon: BarChart3 },
  { view: 'team', label: 'Team', Icon: UserCheck },
];

export function BottomNav({
  activeView, onNavigate, allowed, badgeCount = 0,
}: {
  activeView: NavView;
  onNavigate: (v: NavView) => void;
  allowed: (v: NavView) => boolean;
  /** Unresolved reminders, shown on Payroll where salary deadlines live. */
  badgeCount?: number;
}) {
  const tabs = TABS.filter(t => allowed(t.view));
  // With a single destination there is nothing to switch between.
  if (tabs.length < 2) return null;

  return (
    <nav
      data-chrome
      aria-label="Main"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-ink-100 dark:border-ink-800 bg-white dark:bg-ink-950 pb-safe"
    >
      <ul className="flex items-stretch">
        {tabs.map(({ view, label, Icon }) => {
          const active = activeView === view;
          const showBadge = view === 'payroll' && badgeCount > 0;
          return (
            <li key={view} className="flex-1">
              <button
                type="button"
                onClick={() => onNavigate(view)}
                aria-current={active ? 'page' : undefined}
                className={`relative w-full h-16 flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                  active
                    ? 'text-brand-700 dark:text-brand-300'
                    : 'text-ink-500 dark:text-ink-400 active:bg-ink-100 dark:active:bg-ink-800'
                }`}
              >
                {/* The active tab wears a pill behind its icon. */}
                <span className={`relative flex items-center justify-center w-14 h-8 rounded-full transition-colors duration-200 ${
                  active ? 'bg-brand-100 dark:bg-brand-900/80' : ''
                }`}>
                  <Icon className="w-5 h-5" strokeWidth={active ? 2.4 : 1.9} />
                  {showBadge && (
                    <span className="absolute -top-0.5 right-2 min-w-[16px] h-4 px-1 rounded-full bg-rose-600 text-white text-[11px] font-black leading-none flex items-center justify-center">
                      {badgeCount > 9 ? '9+' : badgeCount}
                    </span>
                  )}
                </span>
                <span className={`text-2xs ${active ? 'font-bold' : 'font-semibold'}`}>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
