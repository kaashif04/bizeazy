/**
 * KaidaConnectModal.tsx — link this admin login to the owner's Kaida planner.
 *
 * Kaida signs in with a different account, so the link is a one-time code:
 * made here, typed into Kaida within 10 minutes. Kaida then reads the same
 * reminders as the bell (salaries, invoices, quotations, leave) and nothing
 * else: no amounts, IC numbers or bank details (see plan_hub_feed).
 */
import React, { useEffect, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { supabase } from '../supabase';
import { Sheet, sheetBtn } from './ui/Sheet';

const VALID_SECONDS = 10 * 60;

export function KaidaConnectModal({ onClose, onToast }: {
  onClose: () => void;
  onToast: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    supabase.rpc('hub_kaida_linked').then(({ data }) => setLinked(!!data));
  }, []);
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setLeft(l => {
      if (l <= 1) { setCode(null); return 0; }
      return l - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [code]);
  // Once a code is out, check now and then whether Kaida has used it.
  useEffect(() => {
    if (!code) return;
    const t = setInterval(async () => {
      const { data } = await supabase.rpc('hub_kaida_linked');
      if (data) { setLinked(true); setCode(null); onToast('Kaida is connected', 'success'); }
    }, 4000);
    return () => clearInterval(t);
  }, [code, onToast]);

  async function makeCode() {
    setBusy(true);
    const { data, error } = await supabase.rpc('hub_kaida_code');
    setBusy(false);
    if (error) return onToast(error.code === '42501' ? 'Only an admin can connect Kaida.' : 'Could not make a code. Check the connection and try again.', 'error');
    setCode(String(data));
    setLeft(VALID_SECONDS);
  }

  async function disconnect() {
    setBusy(true);
    const { error } = await supabase.rpc('hub_kaida_unlink');
    setBusy(false);
    setConfirmOff(false);
    if (error) return onToast('Could not disconnect. Check the connection and try again.', 'error');
    setLinked(false);
    setCode(null);
    onToast('Kaida disconnected. It no longer receives reminders.', 'success');
  }

  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <Sheet
      title="Connect Kaida"
      subtitle="Get salary, invoice, quotation and leave reminders in your Kaida planner."
      icon={<CalendarCheck className="w-5 h-5 text-brand-600 dark:text-brand-400" />}
      onClose={onClose}
      maxWidth="md"
      footer={<button type="button" onClick={onClose} className={sheetBtn.ghost}>Done</button>}
    >
      <div className="space-y-4">
        {linked && !code && (
          <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Kaida is connected to this login.</p>
        )}

        {code ? (
          <div className="rounded-2xl border border-ink-200 dark:border-ink-800 bg-ink-50 dark:bg-ink-900 p-5 text-center">
            <p className="text-xs font-semibold text-ink-500 dark:text-ink-400">Type this in Kaida → You → BizHub</p>
            <p className="mt-2 text-4xl font-black tracking-[0.3em] tabular-nums text-ink-900 dark:text-white" aria-live="polite">{code}</p>
            <p className="mt-2 text-xs text-ink-500 dark:text-ink-400 tabular-nums">Works once, for {mmss} more</p>
          </div>
        ) : (
          <ol className="list-decimal pl-5 space-y-1 text-sm text-ink-700 dark:text-ink-300">
            <li>Make a code here.</li>
            <li>In Kaida, open You, then BizHub, and type the code.</li>
            <li>Each outlet becomes a space in Kaida. You choose there which reminders to get.</li>
          </ol>
        )}

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={makeCode} disabled={busy} className={sheetBtn.primary}>
            {code ? 'New code' : linked ? 'Make a code for another device' : 'Make a code'}
          </button>
          {linked && !confirmOff && (
            <button type="button" onClick={() => setConfirmOff(true)} disabled={busy} className={sheetBtn.ghost}>Disconnect Kaida</button>
          )}
        </div>

        {confirmOff && (
          <div className="rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-3 space-y-2">
            <p className="text-xs font-semibold text-rose-800 dark:text-rose-300">Stop sending reminders to Kaida? The owner's Kaida keeps its outlet spaces.</p>
            <div className="flex gap-2">
              <button type="button" onClick={disconnect} disabled={busy} className={sheetBtn.danger}>Disconnect</button>
              <button type="button" onClick={() => setConfirmOff(false)} className={sheetBtn.ghost}>Keep connected</button>
            </div>
          </div>
        )}

        <p className="text-2xs text-ink-500 dark:text-ink-400">
          Kaida sees staff names, pay months and whether they are paid. Never salary amounts, IC numbers or bank details.
        </p>
      </div>
    </Sheet>
  );
}
