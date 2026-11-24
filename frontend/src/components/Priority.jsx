import React from 'react'
import { getPrefs } from '../api'

const BADGE = { high: 'badge-error', medium: 'badge-warning', low: 'badge-neutral' }

export function PriorityBadge({ priority }) {
  if (!priority) return <span className="badge badge-neutral">PENDING</span>
  return <span className={`badge ${BADGE[priority] || 'badge-neutral'}`}>{priority.toUpperCase()}</span>
}

export function formatDate(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const dd = String(d).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  switch (getPrefs().dateFormat) {
    case 'dd-mm-yyyy': return `${dd}-${mm}-${y}`
    case 'yyyy-mm-dd': return `${y}-${mm}-${dd}`
    default:
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  }
}

export function daysLeft(iso) {
  if (!iso) return null
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)
}

export function DeadlineText({ deadline }) {
  if (!deadline) return null
  const days = daysLeft(deadline)
  const suffix = days === null ? '' : days < 0 ? ' (passed)' : ` (${days} day${days === 1 ? '' : 's'} left)`
  return <span>Deadline {formatDate(deadline)}{suffix}</span>
}

export function pdfUrl(update) {
  return (update.pdf_urls || [])[0] || ''
}
