/**
 * The payment-confirmed moment: money recorded or paid out shows briefly as a
 * confirmation card (amount, drawn tick), like a payment-success screen. A
 * window event keeps the modules free of overlay plumbing; App renders it.
 */
export const CONFIRMED_EVENT = 'bizeazy:confirmed';

export interface Confirmation { title: string; amount: number; currency?: string; note?: string }

export function confirmMoment(c: Confirmation) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<Confirmation>(CONFIRMED_EVENT, { detail: c }));
}
