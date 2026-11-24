import React, { useState } from 'react'
import { api, readLocal, writeLocal, formatDateTime } from '../api'
import { formatDate } from './Priority'

export const REVIEW_STATUSES = [
  { id: 'new', label: 'New', badge: 'badge-info' },
  { id: 'under_review', label: 'Under review', badge: 'badge-warning' },
  { id: 'actioned', label: 'Actioned', badge: 'badge-success' },
  { id: 'not_applicable', label: 'Not applicable', badge: 'badge-neutral' }
]
const STATUS = Object.fromEntries(REVIEW_STATUSES.map(s => [s.id, s]))
const REVIEWER_KEY = 'dgca-reviewer-name'

// Archive items nobody has reviewed show no badge rather than hundreds of "New".
export function ReviewBadge({ status, archive }) {
  if (!status && archive) return <span style={{ color: 'var(--secondary-text, #6B7280)' }}>—</span>
  const s = STATUS[status || 'new']
  return <span className={`badge ${s.badge}`}>{s.label}</span>
}

// Status, owner and note for one publication. onSaved receives the updated publication.
export function ReviewControl({ update, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState(update.review_status || 'new')
  const [owner, setOwner] = useState(update.review_owner || readLocal(REVIEWER_KEY, ''))
  const [note, setNote] = useState(update.review_note || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState(null)

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const saved = await api(`/updates/${update.id}/review`, { method: 'PATCH', body: JSON.stringify({ status, owner, note }) })
      if (owner.trim()) writeLocal(REVIEWER_KEY, owner.trim())
      setEditing(false)
      setHistory(null)
      onSaved?.(saved)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const showHistory = async () => {
    if (history) return setHistory(null)
    try { setHistory((await api(`/updates/${update.id}/review-log`)).data) } catch (e) { setError(e.message) }
  }

  if (!editing) {
    return (
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px' }}>
        <strong>Review:</strong> <ReviewBadge status={update.review_status} />
        {update.review_owner && update.review_status && update.review_status !== 'new' && (
          <span>by {update.review_owner}{update.reviewed_at ? ` on ${formatDate(update.reviewed_at)}` : ''}</span>
        )}
        {update.review_note && <span style={{ color: 'var(--secondary-text, #6B7280)' }}>"{update.review_note}"</span>}
        <button className="btn-ghost" style={{ padding: '2px 10px', fontSize: '12px' }} onClick={() => setEditing(true)}>Update</button>
        {update.reviewed_at && <button className="btn-ghost" style={{ padding: '2px 10px', fontSize: '12px' }} onClick={showHistory}>{history ? 'Hide history' : 'History'}</button>}
        {error && <span className="badge badge-error" style={{ textTransform: 'none' }}>{error}</span>}
        {history && (
          <ul style={{ width: '100%', margin: '4px 0 0', paddingLeft: '20px', fontSize: '12px' }}>
            {history.map((h, i) => (
              <li key={i}>{formatDateTime(h.changed_at)}: {STATUS[h.status]?.label || h.status} by {h.owner || '—'}{h.note ? ` - ${h.note}` : ''}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: '8px', fontSize: '13px', maxWidth: '640px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ padding: '6px' }}>
          {REVIEW_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <input placeholder="Your name" value={owner} onChange={e => setOwner(e.target.value)} style={{ padding: '6px', flex: 1, minWidth: '160px' }} />
      </div>
      <textarea placeholder="Note, e.g. 'OM Part A rev raised' or 'Applies to NSOP only'" value={note} onChange={e => setNote(e.target.value)} rows={2} style={{ padding: '6px', fontFamily: 'inherit' }} />
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button className="btn-primary" style={{ padding: '6px 14px', fontSize: '13px' }} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        <button className="btn-ghost" style={{ padding: '6px 14px', fontSize: '13px' }} onClick={() => setEditing(false)}>Cancel</button>
        {error && <span className="badge badge-error" style={{ textTransform: 'none' }}>{error}</span>}
      </div>
    </div>
  )
}

// What changed since the previous stored version of the same document, loaded on request.
export function RevisionPanel({ update, onCompare }) {
  const [state, setState] = useState({ loading: false, data: null, error: '' })
  if (!update.earlier_versions) return null

  const load = async () => {
    setState({ loading: true, data: null, error: '' })
    try {
      setState({ loading: false, data: await api(`/updates/${update.id}/revision`), error: '' })
    } catch (e) {
      setState({ loading: false, data: null, error: e.message })
    }
  }

  const rev = state.data?.revision || (state.data ? null : update.revision)
  if (!rev) {
    return (
      <div style={{ fontSize: '13px' }}>
        <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }} onClick={load} disabled={state.loading}>
          {state.loading ? 'Comparing with the previous version...' : `What changed since the previous version? (${update.earlier_versions} earlier version${update.earlier_versions === 1 ? '' : 's'} stored)`}
        </button>
        {state.data && !state.data.revision && <span style={{ marginLeft: '8px' }}>{state.data.reason}</span>}
        {state.error && <span className="badge badge-error" style={{ marginLeft: '8px', textTransform: 'none' }}>{state.error}</span>}
      </div>
    )
  }

  const line = { padding: '4px 8px', marginBottom: '4px', fontSize: '13px', lineHeight: 1.5 }
  return (
    <div style={{ fontSize: '13px', border: '1px solid var(--border-light, #E5E7EB)', borderRadius: '6px', padding: '10px 12px', background: 'var(--card-bg, #FFFFFF)' }}>
      <div style={{ marginBottom: '6px' }}>
        <strong>What changed</strong> since <em>{rev.previous.title.length > 120 ? `${rev.previous.title.slice(0, 117)}...` : rev.previous.title}</em> ({formatDate(rev.previous.publication_date)})
      </div>
      {rev.stats && <div style={{ fontWeight: 600, marginBottom: '6px' }}>{rev.stats.added} sentences added, {rev.stats.removed} removed, {rev.stats.similarity}% unchanged</div>}
      {rev.note && <div style={{ marginBottom: '6px', color: 'var(--secondary-text, #6B7280)' }}>{rev.note}</div>}
      {(rev.added || []).map((l, i) => <div key={`a${i}`} style={{ ...line, background: '#DCFCE7', borderLeft: '3px solid #16A34A', color: '#14532D' }}>+ {l}</div>)}
      {(rev.removed || []).map((l, i) => <div key={`r${i}`} style={{ ...line, background: '#FEE2E2', borderLeft: '3px solid #DC2626', color: '#7F1D1D' }}>− {l}</div>)}
      {onCompare && <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px', marginTop: '4px' }} onClick={() => onCompare(rev.previous.id, update.id)}>Open full comparison</button>}
    </div>
  )
}
