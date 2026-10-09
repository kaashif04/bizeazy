/**
 * Logo.tsx — the BizEazy mark: a receipt with a torn edge carrying a bold B.
 *
 * The receipt is the Hub's whole job (invoices, quotations, payslips); the B
 * makes it ours. Cobalt tile, ivory-white paper, so it sits in the Soft System
 * palette and still reads at 16px. public/favicon.svg and
 * public/apple-touch-icon.png are the same drawing.
 */
import React, { useId } from 'react';

export function LogoMark({ className = 'w-9 h-9', title = 'BizEazy' }: { className?: string; title?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3B74F6" />
          <stop offset="1" stopColor="#0E40C2" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill={`url(#${id}g)`} />
      {/* Receipt: rounded top, torn bottom edge. */}
      <path d="M14.5 9.5h19a2.5 2.5 0 0 1 2.5 2.5v26.2l-3 2-3-2-3 2-3-2-3 2-3-2-3 2V12a2.5 2.5 0 0 1 2.5-2.5z" fill="#fff" />
      {/* B, with its two counters cut out. */}
      <path d="M18.5 15h6.3a4 4 0 0 1 .9 7.9 4.3 4.3 0 0 1-.6 8.6h-6.6z" fill="#1450E6" />
      <path d="M21.6 17.8v3.6h3a1.8 1.8 0 0 0 0-3.6z M21.6 24.1v4.6h3.3a2.3 2.3 0 0 0 0-4.6z" fill="#fff" />
    </svg>
  );
}
