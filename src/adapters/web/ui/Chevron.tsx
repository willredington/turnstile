/** Phosphor's caret, pointing whichever way the panel it belongs to would move. */
export function Chevron({ dir }: { dir: 'left' | 'right' | 'up' | 'down' }) {
  // Up and down are the right-pointing chevron turned a quarter either way.
  const turn =
    dir === 'down' ? 'rotate(90 128 128)' : dir === 'up' ? 'rotate(-90 128 128)' : undefined
  return (
    <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      {dir === 'left' ? (
        <path d="M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z" />
      ) : (
        <path
          transform={turn}
          d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z"
        />
      )}
    </svg>
  )
}
