/**
 * The Turnstile mark: a batch of changes (thin rows, one held back at reduced opacity) meeting
 * a gate (the thick stroke). Drawn on a 32-unit grid at two stroke weights — 2.6 for the
 * changes, 3 for the gate — with round caps throughout. Below 18px the three rows start to
 * merge, so `size <= 16` switches to a two-row cut (one held row instead of two) rather than
 * scaling the three-row version further down. Colour comes from `currentColor`, so callers
 * control it the same way they'd control any icon — via CSS `color`.
 */
export function TurnstileMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {size <= 16 ? (
        <>
          <path d="M4 12 H28" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <path
            d="M4 21 H14"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            opacity="0.55"
          />
          <path d="M20 4 V28" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M4 8 H28" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          <path
            d="M4 16 H15 M4 24 H15"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            opacity="0.55"
          />
          <path d="M21 3 V29" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}
