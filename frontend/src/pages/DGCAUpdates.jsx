import React, { useState, useEffect } from 'react'
import './Pages.css'
import { PriorityBadge, DeadlineText, formatDate, pdfUrl } from '../components/Priority'
import { ReviewBadge, ReviewControl, RevisionPanel, REVIEW_STATUSES } from '../components/Review'

const RANK = { high: 0, medium: 1, low: 2 }
const PAGE = 100
const isArchive = u => u.origin === 'archive'

function DGCAUpdates({ initialCategory, onNavigate }) {
  const [updates, setUpdates] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedCategory, setSelectedCategory] = useState(initialCategory || 'all')
  const [selectedPriority, setSelectedPriority] = useState('all')
  const [sortBy, setSortBy] = useState('date')
  const [source, setSource] = useState('all')
  const [review, setReview] = useState('all')
  const [shown, setShown] = useState(PAGE)
  const [expanded, setExpanded] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { setShown(PAGE) }, [searchTerm, selectedCategory, selectedPriority, sortBy, source, review])

  useEffect(() => {
    fetch('http://localhost:5000/api/updates?limit=5000')
      .then(r => r.json())
      .then(data => {
        setUpdates(data.data || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const categories = ['all', 'tenders', 'regulation', 'guidance', 'announcements']

  const term = searchTerm.toLowerCase()
  const filtered = updates
    .filter(u => (u.title.toLowerCase().includes(term) || (u.summary || '').toLowerCase().includes(term))
      && (selectedCategory === 'all' || u.section === selectedCategory)
      && (selectedPriority === 'all' || u.priority === selectedPriority)
      && (source === 'all' || (source === 'archive') === isArchive(u))
      && (review === 'all' || (u.review_status || 'new') === review))
    .sort((a, b) => sortBy === 'priority'
      ? (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3) || b.publication_date.localeCompare(a.publication_date)
      : b.publication_date.localeCompare(a.publication_date))

  return (
    <div className="page-container">
      <section className="card">
        <div className="card-header">
          <h3>DGCA Publications</h3>
          <span className="section-meta">{filtered.length} publications</span>
        </div>

        <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Search titles and summaries..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ flex: 1, minWidth: '200px' }}
          />
          <select value={selectedCategory} onChange={(e) => setSelectedCategory(e.target.value)} style={{ padding: 'var(--space-md) var(--space-lg)' }}>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat === 'all' ? 'All Categories' : cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
            ))}
          </select>
          <select value={selectedPriority} onChange={(e) => setSelectedPriority(e.target.value)} style={{ padding: 'var(--space-md) var(--space-lg)' }}>
            <option value="all">All Priorities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={{ padding: 'var(--space-md) var(--space-lg)' }}>
            <option value="all">Current and archive</option>
            <option value="monitor">Found by the monitor</option>
            <option value="archive">DGCA archive only</option>
          </select>
          <select value={review} onChange={(e) => setReview(e.target.value)} style={{ padding: 'var(--space-md) var(--space-lg)' }}>
            <option value="all">Any review status</option>
            {REVIEW_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ padding: 'var(--space-md) var(--space-lg)' }}>
            <option value="date">Newest first</option>
            <option value="priority">Highest priority first</option>
          </select>
        </div>

        {loading ? (
          <div className="loading">Loading publications...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">—</div>
            <div className="empty-state-title">No publications found</div>
            <div className="empty-state-description">Try adjusting your search or filter criteria</div>
          </div>
        ) : (
          <table className="publications-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Published</th>
                <th>Priority</th>
                <th>Review</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, shown).map(update => (
                <React.Fragment key={update.id}>
                  <tr>
                    <td>
                      <strong>{update.title}</strong>
                      {isArchive(update) && <span className="badge badge-neutral" style={{ marginLeft: '8px' }}>ARCHIVE</span>}
                      {update.earlier_versions > 0 && <span className="badge badge-info" style={{ marginLeft: '8px' }} title="An earlier version of this document is stored">REVISION</span>}
                      {update.priority_reason && <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6B7280)', marginTop: '4px' }}>{update.priority_reason}</div>}
                    </td>
                    <td><span className="badge badge-info">{update.section}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(update.publication_date)}</td>
                    <td><PriorityBadge priority={update.priority} /></td>
                    <td><ReviewBadge status={update.review_status} archive={isArchive(update)} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }} onClick={() => setExpanded(expanded === update.id ? null : update.id)}>
                        {expanded === update.id ? 'Hide' : 'Summary'}
                      </button>
                    </td>
                  </tr>
                  {expanded === update.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--accent-sky, #E1EDF7)' }}>
                        <p style={{ margin: '0 0 8px' }}>{update.summary || 'Summary not generated yet.'}</p>
                        {update.key_points?.length > 0 && (
                          <ul style={{ margin: '0 0 8px', paddingLeft: '20px' }}>
                            {update.key_points.map((p, i) => <li key={i}>{p}</li>)}
                          </ul>
                        )}
                        {update.action_required && <p style={{ margin: '0 0 8px' }}><strong>Action required:</strong> {update.action_required}</p>}
                        {update.car_in_force && (
                          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px', marginBottom: '8px' }} onClick={() => onNavigate?.('comparison', { a: `car:${update.car_in_force.id}`, b: update.id })}>
                            Compare with CAR 8 {update.car_in_force.series} Part {update.car_in_force.part} in force
                          </button>
                        )}
                        <div style={{ margin: '0 0 10px' }}>
                          <RevisionPanel update={update} onCompare={(a, b) => onNavigate?.('comparison', { a, b })} />
                        </div>
                        <div style={{ margin: '0 0 10px' }}>
                          <ReviewControl key={update.reviewed_at || 'new'} update={update} onSaved={saved => setUpdates(list => list.map(u => u.id === saved.id ? { ...u, ...saved } : u))} />
                        </div>
                        <p style={{ margin: 0, fontSize: '12px' }}>
                          {update.deadline && <><DeadlineText deadline={update.deadline} /> • </>}
                          Email: {update.email_status || 'not processed'}
                          {pdfUrl(update) && <> • <a href={pdfUrl(update)} target="_blank" rel="noreferrer">Open PDF</a></>}
                          {' • '}<a href={`http://localhost:5000/api/updates/${update.id}/email-preview`} target="_blank" rel="noreferrer">Preview email</a>
                        </p>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
        {!loading && filtered.length > shown && (
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '16px' }}>
            <button className="btn-ghost" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, filtered.length - shown)} more</button>
            <small>Showing {shown} of {filtered.length}</small>
          </div>
        )}
      </section>
    </div>
  )
}

export default DGCAUpdates
