import React, { useState } from 'react'
import './Pages.css'
import { api } from '../api'
import { PriorityBadge, formatDate } from '../components/Priority'
import { ReviewBadge } from '../components/Review'

const EXAMPLES = ['EFB', 'fatigue OR FDTL', '"flight duty period"', 'wet lease', 'unruly passenger', 'CAT III']

// Snippets arrive with \u0001 ... \u0002 around matched words.
function Snippet({ text }) {
  if (!text) return null
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/)
  return (
    <span>
      {parts.map((p, i) => p.startsWith('\u0001')
        ? <mark key={i} style={{ background: '#FEF08A', padding: '0 2px' }}>{p.slice(1, -1)}</mark>
        : <React.Fragment key={i}>{p}</React.Fragment>)}
    </span>
  )
}

function SearchDocuments({ onNavigate }) {
  const [query, setQuery] = useState('')
  const [section, setSection] = useState('')
  const [origin, setOrigin] = useState('')
  const [sort, setSort] = useState('relevance')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const search = async (q = query, overrides = {}) => {
    const opts = { section, origin, sort, ...overrides }
    if (!q.trim()) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ q, limit: '100', sort: opts.sort })
      if (opts.section) params.set('section', opts.section)
      if (opts.origin) params.set('origin', opts.origin)
      setResult(await api(`/search?${params}`))
    } catch (e) {
      setError(e.message)
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const setAndSearch = (setter, key) => e => {
    setter(e.target.value)
    if (result) search(query, { [key]: e.target.value })
  }

  return (
    <div className="page-container">
      <section className="card">
        <div className="card-header">
          <h3>Search Documents</h3>
          <span className="section-meta">Searches the full text of every stored DGCA PDF, not just titles</span>
        </div>

        <form onSubmit={e => { e.preventDefault(); search() }} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <input
            id="doc-search"
            type="search"
            placeholder='e.g. EFB, fatigue OR FDTL, "flight duty period"'
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: '240px', padding: '10px' }}
          />
          <select value={section} onChange={setAndSearch(setSection, 'section')} style={{ padding: '8px' }}>
            <option value="">All categories</option>
            <option value="regulation">Regulation</option>
            <option value="guidance">Guidance</option>
            <option value="announcements">Announcements</option>
            <option value="tenders">Tenders</option>
          </select>
          <select value={origin} onChange={setAndSearch(setOrigin, 'origin')} style={{ padding: '8px' }}>
            <option value="">Current and archive</option>
            <option value="monitor">Found by the monitor</option>
            <option value="archive">DGCA archive only</option>
          </select>
          <select value={sort} onChange={setAndSearch(setSort, 'sort')} style={{ padding: '8px' }}>
            <option value="relevance">Best match first</option>
            <option value="date">Newest first</option>
          </select>
          <button className="btn-primary" type="submit" disabled={loading || !query.trim()}>{loading ? 'Searching...' : 'Search'}</button>
        </form>

        <div style={{ fontSize: '13px', color: 'var(--secondary-text, #6B7280)', marginBottom: '16px' }}>
          Try: {EXAMPLES.map((ex, i) => (
            <React.Fragment key={ex}>
              {i > 0 && ', '}
              <a href="#" onClick={e => { e.preventDefault(); setQuery(ex); search(ex) }}>{ex}</a>
            </React.Fragment>
          ))}.
          All words must appear; use OR for either, and "quotes" for an exact phrase.
        </div>

        {error && <div className="badge badge-error" style={{ textTransform: 'none', fontSize: '13px', padding: '8px 12px' }}>{error}</div>}

        {result && (
          <>
            <p style={{ fontSize: '13px', margin: '0 0 12px' }}>
              <strong>{result.total}</strong> publication{result.total === 1 ? '' : 's'} match "{result.query}"
              {result.total > result.data.length && ` (showing the first ${result.data.length})`}.
              {' '}{result.searchable} PDFs have searchable text; scanned PDFs are matched by title only.
            </p>
            {result.data.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">—</div>
                <div className="empty-state-title">No matches</div>
                <div className="empty-state-description">Try fewer words, OR between alternatives, or a different spelling (licence / license).</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {result.data.map(r => (
                  <div key={r.id} style={{ border: '1px solid var(--border-light, #E5E7EB)', borderRadius: '6px', padding: '12px 14px' }}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' }}>
                      <PriorityBadge priority={r.priority} />
                      <span className="badge badge-info">{r.section}</span>
                      {r.origin === 'archive' && <span className="badge badge-neutral">ARCHIVE</span>}
                      <ReviewBadge status={r.review_status} archive={r.origin === 'archive'} />
                      <small>{formatDate(r.publication_date)}{r.pdf_pages ? ` • ${r.pdf_pages} pages` : ''}{!r.has_text ? ' • scanned PDF, title match only' : ''}</small>
                    </div>
                    <div style={{ fontWeight: 600, marginBottom: '6px' }}>{r.title.length > 220 ? `${r.title.slice(0, 217)}...` : r.title}</div>
                    {r.has_text && r.snippet && <div style={{ fontSize: '13px', lineHeight: 1.6, color: 'var(--secondary-text, #374151)' }}><Snippet text={r.snippet} /></div>}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                      {r.pdf_urls?.[0] && <a className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }} href={r.pdf_urls[0]} target="_blank" rel="noreferrer">Open PDF</a>}
                      {onNavigate && <button className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px' }} onClick={() => onNavigate('comparison', { a: r.id })}>Compare with...</button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

export default SearchDocuments
