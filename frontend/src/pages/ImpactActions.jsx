import React, { useState, useEffect } from 'react'
import './Pages.css'
import { api } from '../api'
import { DeadlineText, formatDate, pdfUrl } from '../components/Priority'
import { ReviewControl, RevisionPanel, REVIEW_STATUSES } from '../components/Review'

const PAGE = 50

function ImpactActions({ onNavigate }) {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState('high')
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [review, setReview] = useState('open')
  const [limit, setLimit] = useState(PAGE)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api('/updates?sort=priority&limit=5000')
      .then(data => {
        setItems((data.data || []).filter(u => u.priority))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { setLimit(PAGE) }, [filter, source, query, review])

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const pool = items
    .filter(i => source === 'all' || (source === 'archive') === (i.origin === 'archive'))
    // "Open" leaves out archive items nobody has picked up; they are history, not a to-do list.
    .filter(i => review === 'all' || (review === 'open'
      ? ['new', 'under_review'].includes(i.review_status || 'new') && !(i.origin === 'archive' && !i.review_status)
      : (i.review_status || 'new') === review))
    .filter(i => terms.every(t => `${i.title} ${i.section} ${i.publication_date}`.toLowerCase().includes(t)))
  const filters = ['high', 'medium', 'low', 'all']
  const counts = Object.fromEntries(filters.map(f => [f, f === 'all' ? pool.length : pool.filter(i => i.priority === f).length]))
  const matching = filter === 'all' ? pool : pool.filter(i => i.priority === filter)
  const shown = matching.slice(0, limit)

  return (
    <div className="page-container">
      <section className="card">
        <div className="card-header">
          <h3>Impact & Actions</h3>
          <span className="section-meta">What each publication means for operations</span>
        </div>

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <input
            id="impact-search"
            type="search"
            placeholder="Search title, category or year..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: '200px', padding: '8px' }}
          />
          <select id="impact-source" value={source} onChange={e => setSource(e.target.value)} style={{ padding: '8px' }}>
            <option value="all">Current and archive</option>
            <option value="monitor">Found by the monitor</option>
            <option value="archive">DGCA archive only</option>
          </select>
          <select id="impact-review" value={review} onChange={e => setReview(e.target.value)} style={{ padding: '8px' }}>
            <option value="open">Open: new or under review (current items)</option>
            <option value="all">Any review status</option>
            {REVIEW_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' }}>
          {filters.map(f => (
            <button
              key={f}
              className={`btn-${filter === f ? 'primary' : 'ghost'}`}
              onClick={() => setFilter(f)}
              style={{ fontSize: '13px', padding: '6px 12px' }}
            >
              {f === 'all' ? 'All' : f.toUpperCase()} ({counts[f]})
            </button>
          ))}
        </div>

        {loading ? (
          <div className="loading">Loading...</div>
        ) : shown.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon" style={{ fontSize: '32px' }}>—</div>
            <div className="empty-state-title">No {filter === 'all' ? '' : filter + '-priority '}items</div>
            <div className="empty-state-description">{review === 'open' ? 'Nothing left to review with these filters. Choose "Any review status" to see reviewed items.' : 'Publications appear here once the monitor has analysed them.'}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {shown.map(item => (
              <div key={item.id} className={`priority-item priority-${item.priority}`}>
                <div className="priority-badge">{item.priority.toUpperCase()}</div>
                <div className="priority-content" style={{ flex: 1 }}>
                  <h4>{item.title}{item.origin === 'archive' && <span className="badge badge-neutral" style={{ marginLeft: '8px', verticalAlign: 'middle' }}>ARCHIVE</span>}</h4>
                  <p><strong>Action:</strong> {item.action_required || 'Review for applicability.'}</p>
                  <small>
                    {item.priority_reason} • {item.section} • Published {formatDate(item.publication_date)}
                    {item.deadline && <> • <DeadlineText deadline={item.deadline} /></>}
                    {item.applies_to?.length > 0 && <> • Applies to: {item.applies_to.join(', ')}</>}
                  </small>
                  <div style={{ marginTop: '6px', fontSize: '12px' }}>Email: {item.email_status || 'not processed'}</div>
                  <div style={{ marginTop: '8px' }}>
                    {item.car_in_force && (
                          <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px', marginBottom: '8px' }} onClick={() => onNavigate?.('comparison', { a: `car:${item.car_in_force.id}`, b: item.id })}>
                            Compare with CAR 8 {item.car_in_force.series} Part {item.car_in_force.part} in force
                          </button>
                        )}
                    <RevisionPanel update={item} onCompare={(a, b) => onNavigate?.('comparison', { a, b })} />
                  </div>
                  <div style={{ marginTop: '8px' }}>
                    <ReviewControl key={item.reviewed_at || 'new'} update={item} onSaved={saved => setItems(list => list.map(u => u.id === saved.id ? { ...u, ...saved } : u))} />
                  </div>
                </div>
                {pdfUrl(item) && <a className="btn-ghost" href={pdfUrl(item)} target="_blank" rel="noreferrer">Open PDF →</a>}
              </div>
            ))}
            {matching.length > limit && (
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <button className="btn-ghost" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, matching.length - limit)} more</button>
                <small>Showing {limit} of {matching.length}</small>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

export default ImpactActions
