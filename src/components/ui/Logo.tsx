/**
 * Logo.tsx — the BizEazy mark: a lowercase b with a mint spark, on cobalt.
 *
 * Friendly and modern; the spark is the moment a payment lands (the same mint
 * as "paid" across the app). Reads at 16px. public/favicon.svg and
 * public/apple-touch-icon.png are the same drawing.
 */
import React, { useId } from 'react';

export function LogoMark({ className = 'w-9 h-9', title = 'BizEazy' }: { className?: string; title?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4C82FF" />
          <stop offset=".55" stopColor="#1450E6" />
          <stop offset="1" stopColor="#0B34A8" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill={`url(#${id}g)`} />
      <path d="M17 11v26" stroke="#fff" strokeWidth="5.4" strokeLinecap="round" />
      <circle cx="25.5" cy="28.5" r="7.2" fill="none" stroke="#fff" strokeWidth="5.4" />
      <circle cx="34.5" cy="13.5" r="3" fill="#7CF0C8" />
    </svg>
  );
}
