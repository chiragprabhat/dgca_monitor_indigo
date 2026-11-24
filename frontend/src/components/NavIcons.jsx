import React from 'react'

// Line icons for the sidebar menu: 24px grid, 1.75 stroke, rounded ends, drawn in currentColor
// so they follow the menu text colour (dimmed, hover, active).
const shapes = {
  overview: <>
    <rect x="3" y="3" width="7.5" height="9" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="5" rx="1.5" />
    <rect x="13.5" y="11" width="7.5" height="10" rx="1.5" />
    <rect x="3" y="15" width="7.5" height="6" rx="1.5" />
  </>,
  updates: <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h6M9 9h2" />
  </>,
  search: <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20.5 20.5l-4.9-4.9" />
  </>,
  comparison: <>
    <rect x="3" y="4" width="7" height="16" rx="1.5" />
    <rect x="14" y="4" width="7" height="16" rx="1.5" />
    <path d="M5.5 9h2M5.5 12.5h2M16.5 9h2M16.5 12.5h2" />
  </>,
  impact: <>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4V3h6v1" />
    <path d="M9 13l2 2 4-4" />
  </>,
  activity: <>
    <path d="M3 12h4l3-8 4 16 3-8h4" />
  </>,
  settings: <>
    <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
    <circle cx="15" cy="6" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="18" r="2" />
  </>
}

// The dotted-aircraft logo, drawn in currentColor so it matches the sidebar text.
const LOGO_DOTS = [
  [150, 107], [213, 107], [276, 107], [339, 107], [401, 107], [444, 63], [489, 18],
  [401, 170], [401, 232], [401, 295], [401, 357],
  [339, 170], [293, 214], [249, 258], [205, 302],
  [36, 347], [98, 347], [161, 347], [161, 409], [161, 471]
]

export function LogoMark({ size = 36 }) {
  return (
    <svg viewBox="0 -2 528 494" width={size} height={size} fill="currentColor" aria-hidden="true">
      {LOGO_DOTS.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="21" />)}
    </svg>
  )
}

export default function NavIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {shapes[name]}
    </svg>
  )
}
