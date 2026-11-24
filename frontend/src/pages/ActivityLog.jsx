import React, { useState, useEffect } from 'react'
import './Pages.css'
import { api, formatDateTime } from '../api'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'monitor-run', label: 'DGCA checks' },
  { id: 'email-sent', label: 'Emails sent' },
  { id: 'system-error', label: 'Errors' },
  { id: 'config-change', label: 'Settings changes' },
  { id: 'review', label: 'Reviews' },
  { id: 'car-change', label: 'CAR Section 8 changes' }
]
const TYPE_LABELS = { 'monitor-run': 'DGCA CHECK', 'email-sent': 'EMAIL SENT', 'system-error': 'ERROR', 'config-change': 'SETTINGS', review: 'REVIEW', 'car-change': 'CAR CHANGE' }

function ActivityLog() {
  const [logs, setLogs] = useState([])
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hideQuiet, setHideQuiet] = useState(false)

  useEffect(() => {
    api('/monitor/logs?limit=300')
      .then(data => { setLogs(data.data || []); setLoading(false) })
      .catch(e => { setError(`Backend unreachable: ${e.message}`); setLoading(false) })
  }, [])

  const counts = Object.fromEntries(FILTERS.map(f => [f.id, f.id === 'all' ? logs.length : logs.filter(l => l.event_type === f.id).length]))
  const shown = logs
    .filter(l => filter === 'all' || l.event_type === filter)
    .filter(l => !hideQuiet || !(l.event_type === 'monitor-run' && /, 0 new/.test(l.details)))

  return (
    <div className="page-container">
      <section className="card">
        <div className="card-header">
          <h3>Activity Log</h3>
          <span className="section-meta">{shown.length} of {logs.length} events</span>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
          {FILTERS.map(f => (
            <button
              key={f.id}
              className={`btn-${filter === f.id ? 'primary' : 'ghost'}`}
              onClick={() => setFilter(f.id)}
              style={{ fontSize: '13px', padding: '6px 12px' }}
            >
              {f.label} ({counts[f.id]})
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '20px', fontSize: '13px' }}>
          <input type="checkbox" checked={hideQuiet} onChange={e => setHideQuiet(e.target.checked)} />
          Hide checks that found nothing new
        </label>

        {loading ? (
          <div className="loading">Loading activity log...</div>
        ) : error ? (
          <div className="empty-state"><div className="empty-state-title">{error}</div></div>
        ) : shown.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">—</div>
            <div className="empty-state-title">No matching events</div>
            <div className="empty-state-description">Try another filter.</div>
          </div>
        ) : (
          <table className="publications-table">
            <thead>
              <tr>
                <th>Time (IST)</th>
                <th>Event</th>
                <th>Details</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(log => (
                <tr key={log.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(log.created_at)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><strong>{TYPE_LABELS[log.event_type] || log.event_type}</strong></td>
                  <td>{log.details}</td>
                  <td><span className={`badge ${log.result === 'success' ? 'badge-success' : 'badge-error'}`}>{log.result === 'success' ? 'OK' : 'FAILED'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

export default ActivityLog
