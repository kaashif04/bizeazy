/**
 * payments.ts — shared partial-payment helpers.
 * Used by both the invoice list/modal (InvoicingModule) and the invoice
 * preview (App.tsx) so payment status is computed identically everywhere.
 */
import { Invoice, Payment } from '../types';

export type PaymentStatus = 'Paid' | 'Partial' | 'Unpaid';

export interface PaymentSummary {
  paid: number;        // total recorded against this invoice
  balance: number;     // outstanding (never negative)
  status: PaymentStatus;
}

// Selectable payment methods (Method is optional, so '' = unspecified).
export const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'Cheque', 'Other'] as const;

// Status is derived PURELY from recorded payments vs the invoice total.
// Back-compat: invoices marked Paid before this feature existed have no payment
// rows — those are still treated as fully paid so history doesn't flip to Unpaid.
export function getPaymentSummary(invoice: Invoice, payments: Payment[]): PaymentSummary {
  const total = Number(invoice.Total_Amount) || 0;
  const recorded = (payments || [])
    .filter(p => p.Invoice_ID === invoice.Invoice_ID)
    .reduce((s, p) => s + (Number(p.Amount) || 0), 0);

  if (recorded <= 0 && invoice.Status === 'Paid') {
    return { paid: total, balance: 0, status: 'Paid' };
  }

  const balance = Math.max(0, total - recorded);
  let status: PaymentStatus;
  if (recorded <= 0) status = 'Unpaid';
  else if (recorded + 0.005 >= total) status = 'Paid'; // epsilon for float rounding
  else status = 'Partial';

  return { paid: recorded, balance, status };
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  Paid: 'Paid',
  Partial: 'Partially Paid',
  Unpaid: 'Unpaid',
};

// Unique id for a new payment row (dedupe key on read/write is Payment_ID).
export function newPaymentId(invoiceId: string): string {
  return `PAY-${invoiceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
