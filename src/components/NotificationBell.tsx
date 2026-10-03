/**
 * NotificationBell.tsx — the bell, its count, and the list behind it.
 *
 * Everything shown is derived from loaded data on each render (see
 * utils/notifications.ts), so there is nothing to mark read and nothing to
 * persist: an item is gone once the thing it is about is dealt with.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, AlertTriangle, Clock, Info, Check } from 'lucide-react';
import { DatabaseState, CompanyProfile } from '../types';
import { buildNotifications, AppNotification } from '../utils/notifications';

const SEVERITY: Record<AppNotification['severity'], {
  Icon: React.FC<React.SVGProps<SVGSVGElement>>; tone: string; dot: string;
}> = {
  danger:  { Icon: AlertTriangle, tone: 'text-rose-600 dark:text-rose-400',   dot: 'bg-rose-500' },
  warning: { Icon: Clock,         tone: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
  info:    { Icon: Info,          tone: 'text-slate-500 dark:text-slate-400', dot: 'bg-slate-400' },
};

export function NotificationBell({
  db, profiles, isDark, onOpenView,
}: {
  db: DatabaseState;
  profiles: CompanyProfile[];
  isDark: boolean;
  onOpenView: (view: AppNotification['view']) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const notifications = useMemo(() => buildNotifications(db, profiles), [db, profiles]);
  const urgent = notifications.some(n => n.severity === 'danger');

  // Click-away and Escape, so the panel never strands itself open on mobile.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={notifications.length
          ? `${notifications.length} item${notifications.length === 1 ? '' : 's'} need attention`
          : 'Nothing needs attention'}
        aria-expanded={open}
        className="relative p-2 rounded-lg text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer transition-colors"
      >
        <Bell className="w-4 h-4" />
        {notifications.length > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-black text-white flex items-center justify-center ${urgent ? 'bg-rose-500' : 'bg-amber-500'}`}>
            {notifications.length > 9 ? '9+' : notifications.length}
          </span>
        )}
      </button>

      {open && (
        <div className={`absolute right-0 top-full mt-2 w-[min(22rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-2xl shadow-2xl z-[70] ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-gray-200'}`}>
          <div className={`px-4 py-3 border-b ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
            <p className="text-xs font-bold text-gray-900 dark:text-white">Needs Attention</p>
            <p className="text-[10px] text-gray-400 dark:text-slate-500">
              Live from your records — items clear themselves once dealt with.
            </p>
          </div>

          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Check className="w-5 h-5 mx-auto text-emerald-500 mb-2" />
              <p className="text-xs font-semibold text-gray-600 dark:text-slate-300">All clear</p>
              <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">
                Salaries paid, invoices settled, quotations current.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-slate-800">
              {notifications.map(n => {
                const { Icon, tone, dot } = SEVERITY[n.severity];
                return (
                  <button
                    key={n.id}
                    onClick={() => { onOpenView(n.view); setOpen(false); }}
                    className="w-full text-left px-4 py-3 flex gap-2.5 hover:bg-gray-50 dark:hover:bg-slate-800/60 cursor-pointer transition-colors"
                  >
                    <span className="mt-0.5 flex-shrink-0">
                      <Icon className={`w-3.5 h-3.5 ${tone}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
                        <span className="text-[11px] font-bold text-gray-900 dark:text-white truncate">{n.title}</span>
                      </span>
                      <span className="block text-[10px] text-gray-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                        {n.detail}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
