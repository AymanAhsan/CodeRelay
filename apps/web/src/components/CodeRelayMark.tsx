import type { SVGProps } from "react";

/**
 * CodeRelay's hub glyph: one node relaying to two teammates. Drawn in
 * `currentColor` so it can sit inline as a monochrome icon.
 */
export function CodeRelayGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="4 4 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 16 23 9M9 16l14 7" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="9" cy="16" r="3.4" fill="currentColor" />
      <circle cx="23" cy="9" r="3.4" fill="currentColor" />
      <circle cx="23" cy="23" r="3.4" fill="currentColor" />
    </svg>
  );
}

/** The full-color app mark: the hub glyph on the brand-red tile, as on the site. */
export function CodeRelayMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="7" fill="oklch(0.55 0.18 20)" />
      <path d="M9 16 23 9M9 16l14 7" stroke="#fff" strokeWidth="1.8" fill="none" />
      <circle cx="9" cy="16" r="3" fill="#fff" />
      <circle cx="23" cy="9" r="3" fill="#fff" />
      <circle cx="23" cy="23" r="3" fill="#fff" />
    </svg>
  );
}
