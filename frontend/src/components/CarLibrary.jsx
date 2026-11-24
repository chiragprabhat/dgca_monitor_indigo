import React, { useState, useEffect, useCallback } from 'react'
import { api, formatDateTime } from '../api'
import { formatDate } from './Priority'

const SERIES_NAMES = { A: 'Scope and extent', B: 'IAL procedures and approval', C: 'Aerodrome operating minima', D: 'Load, trim and checklists', F: 'Flight crew', H: 'Helicopters', O: 'Operations', S: 'Specific approvals' }
const muted = { color: 'var(--secondary-text, #6B7280)' }
const CHANGE_BADGE = { added: 'badge-success', amended: 'badge-warning', details: 'badge-info', revoked: 'badge-error', removed: 'badge-error', reinstated: 'badge-success' }

// Section 8 (Aircraft Operations) CARs in force, read from DGCA, each with the
// What's New publications about it. onCompare(carId, publicationId) runs the comparison.
function CarLibrary({ docs, label, busy, active, onCompare }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [series, setSeries] = useState('all')
  const [open, setOpen] = useState(null)
  const [other, setOther] = useState({})
  const [query, setQuery] = useState('')

  const load = useCallback(() => api('/cars').then(setData).catch(e => setError(`Could not load the CAR list: ${e.message}`)), [])
  useEffect(() => { load() }, [load])

  // While DGCA is being read, refresh every few seconds; otherwise every few minutes, so
  // the list follows the hourly check of DGCA without reloading the page.
  const syncingNow = !!data?.status?.syncing
  useEffect(() => {
    const t = setInterval(load, syncingNow ? 4000 : 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [syncingNow, load])

  const refresh = async () => {
    try { await api('/cars/sync', { method: 'POST' }) } catch (e) { setError(e.message) }
    setTimeout(load, 800)
  }

  if (error && !data) return <div className="badge badge-error" style={{ textTransform: 'none', padding: '8px 12px' }}>{error}</div>
  if (!data) return <div className="loading">Loading Section 8 CARs...</div>

  const { status, cars, changes = [] } = data
  const seriesList = [...new Set(cars.map(c => c.series))]
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = cars
    .filter(c => series === 'all' || c.series === series)
    .filter(c => terms.every(t => `${c.id} ${c.subject} part ${c.part}`.toLowerCase().includes(t)))
  const last = status.lastSync

  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px', marginBottom: '12px' }}>
        <span>
          <strong>{status.total || 0} CARs</strong> from DGCA Regulations and Guidance &rarr; Civil Aviation Requirements &rarr; Section 8 - Aircraft Operations
          {' '}({status.inForce || 0} in force, {status.revoked || 0} revoked{status.removed ? `, ${status.removed} no longer listed` : ''}, {status.withText || 0} PDFs read)
        </span>
        <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }} onClick={refresh} disabled={status.syncing}>
          {status.syncing ? 'Reading DGCA...' : 'Refresh from DGCA'}
        </button>
        {last && <span style={muted}>Checked {formatDateTime(new Date(last.finishedAt || last.startedAt))}, automatically every {status.checkEveryMinutes === 60 ? 'hour' : `${status.checkEveryMinutes} minutes`}{last.error ? ` - failed: ${last.error}` : ''}{last.failed ? ` - ${last.failed} PDF(s) could not be downloaded, will retry` : ''}</span>}
      </div>
      {!status.total && (
        <p style={{ fontSize: '14px' }}>No CARs stored yet. Click <strong>Refresh from DGCA</strong> - reading all Section 8 PDFs takes about a minute.</p>
      )}

      {changes.length > 0 && (
        <details style={{ marginBottom: '12px', fontSize: '13px' }} open={changes.some(c => Date.now() - new Date(`${c.detected_at.replace(' ', 'T')}Z`) < 7 * 864e5)}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Recent changes on DGCA ({changes.length})</summary>
          <table className="publications-table" style={{ marginTop: '6px' }}>
            <tbody>
              {changes.map(c => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: 'nowrap', width: '150px', ...muted }}>{formatDateTime(new Date(`${c.detected_at.replace(' ', 'T')}Z`))}</td>
                  <td style={{ width: '100px' }}><span className={`badge ${CHANGE_BADGE[c.change] || 'badge-info'}`}>{c.change}</span></td>
                  <td>{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <button className={`btn-${series === 'all' ? 'primary' : 'ghost'}`} style={{ padding: '4px 12px', fontSize: '12px' }} onClick={() => setSeries('all')}>All series</button>
        {seriesList.map(sr => (
          <button key={sr} title={SERIES_NAMES[sr] || ''} className={`btn-${series === sr ? 'primary' : 'ghost'}`} style={{ padding: '4px 12px', fontSize: '12px' }} onClick={() => setSeries(sr)}>
            Series {sr}
          </button>
        ))}
        <input type="search" placeholder="Search CAR subject..." value={query} onChange={e => setQuery(e.target.value)} style={{ padding: '4px 8px', minWidth: '200px', flex: 1 }} />
      </div>

      <table className="publications-table" style={{ tableLayout: 'fixed', width: '100%' }}>
        <colgroup><col style={{ width: '17%' }} /><col style={{ width: '49%' }} /><col style={{ width: '20%' }} /><col style={{ width: '14%' }} /></colgroup>
        <thead>
          <tr><th>CAR</th><th>Subject</th><th>In force</th><th>Related</th></tr>
        </thead>
        <tbody>
          {shown.map(car => {
            const revoked = car.status !== 'in force'
            const isOpen = open === car.id
            return (
              <React.Fragment key={car.id}>
                <tr style={revoked ? { opacity: 0.55 } : { cursor: 'pointer' }} onClick={() => !revoked && setOpen(isOpen ? null : car.id)}>
                  <td><strong>Series {car.series} Part {car.part}</strong>{revoked && <span className="badge badge-neutral" style={{ marginLeft: '6px' }}>{car.status === 'removed' ? 'NO LONGER LISTED' : 'REVOKED'}</span>}</td>
                  <td>{car.subject}</td>
                  <td style={{ fontSize: '12px' }}>
                    {[car.issue, car.amendment && !/^no rev/i.test(car.amendment) ? car.amendment : ''].filter(Boolean).join(', ')}
                    {car.amendment_date && <div style={muted}>{formatDate(car.amendment_date)}</div>}
                    {!revoked && !car.has_text && <div style={{ color: '#B45309' }}>PDF not read yet</div>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {revoked ? '—' : <button className="btn-ghost" style={{ padding: '2px 10px', fontSize: '12px' }}>{car.related.length} {isOpen ? '▴' : '▾'}</button>}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={4} style={{ background: 'var(--accent-sky, #E1EDF7)' }}>
                      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px', fontSize: '13px' }}>
                        <span>Document A will be <strong>CAR 8 {car.series} Part {car.part} in force</strong>{car.pdf_pages ? ` (${car.pdf_pages} pages)` : ''}; Document B the publication you choose. Green = in the publication but not in the CAR in force.</span>
                        {car.pdf_url && <a href={car.pdf_url} target="_blank" rel="noreferrer">Open CAR PDF</a>}
                      </div>
                      {car.related.length === 0 && <p style={{ fontSize: '13px', margin: '0 0 8px' }}>No stored publication mentions this CAR yet.</p>}
                      {car.related.map(p => {
                        const isActive = active[0] === `car:${car.id}` && active[1] === p.id
                        return (
                          <div key={p.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '6px 0', borderTop: '1px solid rgba(0,0,0,0.06)', fontSize: '13px' }}>
                            <button className={`btn-${isActive ? 'primary' : 'ghost'}`} style={{ padding: '2px 10px', fontSize: '12px', whiteSpace: 'nowrap' }} disabled={busy || !p.pdf_urls.length} onClick={e => { e.stopPropagation(); onCompare(car.id, p.id) }}>
                              {isActive ? 'Compared' : 'Compare'}
                            </button>
                            <span style={{ whiteSpace: 'nowrap', ...muted }}>{formatDate(p.publication_date)}</span>
                            <span className="badge badge-info">{p.section}</span>
                            {p.origin === 'archive' && <span className="badge badge-neutral">ARCHIVE</span>}
                            <span style={{ flex: 1 }}>{p.title.length > 160 ? `${p.title.slice(0, 157)}...` : p.title}</span>
                            <span style={{ ...muted, fontSize: '11px', whiteSpace: 'nowrap' }}>matched by {p.match}</span>
                          </div>
                        )
                      })}
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                        <span style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>Or any What's New publication:</span>
                        <select value={other[car.id] || ''} onChange={e => setOther({ ...other, [car.id]: e.target.value })} style={{ padding: '6px', flex: 1, minWidth: 0 }} onClick={e => e.stopPropagation()}>
                          <option value="">Choose from {docs.length} publications (Tenders, Regulation, Guidance, Announcements)...</option>
                          {docs.map(u => <option key={u.id} value={u.id}>{label(u)}{u.origin === 'archive' ? ' (archive)' : ''}</option>)}
                        </select>
                        <button className="btn-primary" style={{ padding: '6px 14px', fontSize: '13px' }} disabled={busy || !other[car.id]} onClick={e => { e.stopPropagation(); onCompare(car.id, other[car.id]) }}>Compare</button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default CarLibrary
