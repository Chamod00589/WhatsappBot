/**
 * Shared brand mark for favicon / PWA icons (matches sidebar logo).
 * Used inside `next/og` ImageResponse — keep styles as plain objects.
 */
export function BrandIconMark({
  size,
  radius,
  strokeWidth = 2.5,
}: {
  size: number
  radius: number
  strokeWidth?: number
}) {
  const glyph = Math.round(size * 0.62)
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#7c3aed',
        borderRadius: radius,
      }}
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#ffffff"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
  )
}
