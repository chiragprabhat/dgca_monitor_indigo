import React, { useState, useEffect } from 'react'
import './Pages.css'
import { api } from '../api'
import { formatDate } from '../components/Priority'
import CarLibrary from '../components/CarLibrary'
import DocPicker from '../components/DocPicker'
import UploadCompare from '../components/UploadCompare'

const ADDED = { background: '#DCFCE7', borderLeft: '3px solid #16A34A' }
const REMOVED = { background: '#FEE2E2', borderLeft: '3px solid #DC2626' }
const SAME = { color: 'var(--secondary-text, #6B7280)' }
const line = { padding: '4px 8px', fontSize: '13px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
const MAX_CHUNKS = 400

function Collapsed({ lines }) {
  const [open, setOpen] = useState(false)
  if (lines.length <= 4 || open) return lines.map((l, i) => <div key={i} style={{ ...line, ...SAME }}>{l}</div>)
  return (
    <>
      <div style={{ ...line, ...SAME }}>{lines[0]}</div>
      <button className="btn-ghost" style={{ margin: '4px 8px', padding: '2px 8px', fontSize: '12px' }} onClick={() => setOpen(true)}>
        Show {lines.length - 2} unchanged lines
      </button>
      <div style={{ ...line, ...SAME }}>{lines[lines.length - 1]}</div>
    </>
  )
}

function DocumentComparison({ initialA = '', initialB = '' }) {
  const [docs, setDocs] = useState([])
  const [tab, setTab] = useState(initialA.startsWith('car:') ? 'car' : 'pubs')
  const [a, setA] = useState(initialA)
  const [b, setB] = useState(initialB)
  const [mode, setMode] = useState('stored')
  const [url, setUrl] = useState('')
  const [view, setView] = useState('summary')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api('/updates?limit=5000').then(d => setDocs((d.data || []).filter(u => (u.pdf_urls || []).length))).catch(e => setError(`Backend unreachable: ${e.message}`))
  }, [])

  const label = u => `${formatDate(u.publication_date)} • ${u.section} • ${u.title.length > 90 ? `${u.title.slice(0, 87)}...` : u.title}`
  const canCompare = a && (mode === 'stored' ? b && b !== a : url.trim())

  // With arguments: compare those two (used by the CAR tab); without: the pickers above.
  const compare = async (left, right) => {
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const query = left
        ? `a=${encodeURIComponent(left)}&b=${encodeURIComponent(right)}`
        : mode === 'stored' ? `a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` : `a=${encodeURIComponent(a)}&url=${encodeURIComponent(url.trim())}`
      setResult(await api(`/compare?${query}`))
      setTimeout(() => document.getElementById('compare-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Opened from "Open full comparison": run it straight away.
  useEffect(() => { if (initialA && initialB) compare(initialA, initialB) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const chunks = result ? result.chunks.slice(0, MAX_CHUNKS) : []
  const changes = chunks.filter(c => c.type !== 'same')

  return (
    <div className="page-container">
      <section className="card">
        <div className="card-header">
          <h3>Document Comparison</h3>
          <span className="section-meta">What changed between two documents</span>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
          {[['pubs', 'Two publications'], ['car', 'CAR Section 8 in force'], ['upload', 'Upload file']].map(([id, text]) => (
            <button key={id} className={`btn-${tab === id ? 'primary' : 'ghost'}`} onClick={() => { setTab(id); setResult(null); setError('') }}>{text}</button>
          ))}
        </div>

        {tab === 'car' && (
          <>
            <CarLibrary
              docs={docs}
              label={label}
              busy={loading}
              active={result ? [a, b] : []}
              onCompare={(carId, pubId) => { setA(`car:${carId}`); setB(pubId); compare(`car:${carId}`, pubId) }}
            />
            {loading && <p style={{ fontSize: '14px' }}>Comparing with the CAR in force (long CARs take a few seconds)...</p>}
            {error && <div className="badge badge-error" style={{ textTransform: 'none', fontSize: '13px', padding: '8px 12px', marginBottom: '12px' }}>{error}</div>}
          </>
        )}

        {tab === 'upload' && (
          <>
            <UploadCompare
              docs={docs}
              label={label}
              busy={loading}
              active={result ? [a, b] : []}
              onCompare={(left, right) => { setA(left); setB(right); compare(left, right) }}
            />
            {loading && <p style={{ fontSize: '14px' }}>Comparing (long documents take a few seconds)...</p>}
            {error && <div className="badge badge-error" style={{ textTransform: 'none', fontSize: '13px', padding: '8px 12px', marginBottom: '12px' }}>{error}</div>}
          </>
        )}

        {tab === 'pubs' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
          <label><strong>Document A</strong> (older / original)</label>
          <DocPicker id="doc-a" docs={docs} value={a} onChange={setA} label={label} />


          <label><strong>Document B</strong> (newer / revised)</label>
          <div style={{ display: 'flex', gap: '16px', fontSize: '14px' }}>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="radio" checked={mode === 'stored'} onChange={() => setMode('stored')} /> Stored publication
            </label>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input type="radio" checked={mode === 'url'} onChange={() => setMode('url')} /> DGCA PDF link
            </label>
          </div>
          {mode === 'stored' ? (
            <DocPicker id="doc-b" docs={docs.filter(u => u.id !== a)} value={b} onChange={setB} label={label} />
          ) : (
            <input
              type="url"
              placeholder="https://www.dgca.gov.in/... (e.g. the current CAR, to compare with its draft)"
              value={url}
              onChange={e => setUrl(e.target.value)}
              style={{ padding: '8px' }}
            />
          )}
          <div>
            <button className="btn-primary" onClick={() => compare()} disabled={!canCompare || loading}>
              {loading ? 'Comparing (downloading PDFs)...' : 'Compare'}
            </button>
          </div>
          {error && <div className="badge badge-error" style={{ textTransform: 'none', fontSize: '13px', padding: '8px 12px' }}>{error}</div>}
        </div>
        )}

        {tab === 'pubs' && !result && !loading && (
          <div style={{ background: 'var(--page-bg)', padding: 'var(--space-2xl)', borderRadius: 'var(--radius-lg)', color: 'var(--secondary-text)' }}>
            Pick two documents, for example a draft CAR and the CAR currently in force. Text is compared sentence by sentence:
            <span style={{ ...ADDED, padding: '0 6px', margin: '0 4px' }}>added in B</span>
            <span style={{ ...REMOVED, padding: '0 6px', margin: '0 4px' }}>removed from A</span>.
            Scanned PDFs have no readable text, so they can't be compared.
          </div>
        )}

        <div id="compare-result" />
        {result && (
          <>
            <div className="kpi-grid" style={{ marginBottom: '16px' }}>
              {[
                ['Similarity', `${result.stats.similarity}%`],
                ['Added (B)', result.stats.added],
                ['Removed (A)', result.stats.removed],
                ['Unchanged', result.stats.unchanged]
              ].map(([k, v]) => (
                <div className="kpi-card" key={k}><div className="kpi-content"><div className="kpi-label">{k}</div><div className="kpi-value">{v}</div></div></div>
              ))}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--secondary-text)' }}>
              A: {result.left.label} ({result.left.pages ?? '?'} pages, {result.left.lines} sentences)<br />
              B: {result.right.label} ({result.right.pages ?? '?'} pages, {result.right.lines} sentences)
            </p>
            {result.warnings.map(w => <p key={w} className="badge badge-warning" style={{ textTransform: 'none', display: 'block', padding: '8px 12px' }}>{w}</p>)}
            {result.chunks.length > MAX_CHUNKS && <p style={{ fontSize: '13px' }}>Showing the first {MAX_CHUNKS} of {result.chunks.length} sections of differences.</p>}

            <div style={{ display: 'flex', gap: '8px', margin: '16px 0' }}>
              {[['summary', 'Changes only'], ['sidebyside', 'Side-by-side'], ['unified', 'Full document']].map(([id, text]) => (
                <button key={id} className={`btn-${view === id ? 'primary' : 'ghost'}`} onClick={() => setView(id)}>{text}</button>
              ))}
            </div>

            {view === 'summary' && (
              <div style={{ border: '1px solid var(--border-light, #E5E7EB)', borderRadius: '6px' }}>
                {changes.length === 0 && <div style={line}>No differences found.</div>}
                {changes.map((c, i) => c.lines.map((l, j) => (
                  <div key={`${i}-${j}`} style={{ ...line, ...(c.type === 'added' ? ADDED : REMOVED) }}>{c.type === 'added' ? '+ ' : '− '}{l}</div>
                )))}
              </div>
            )}

            {view === 'unified' && (
              <div style={{ border: '1px solid var(--border-light, #E5E7EB)', borderRadius: '6px' }}>
                {chunks.map((c, i) => c.type === 'same'
                  ? <Collapsed key={i} lines={c.lines} />
                  : c.lines.map((l, j) => <div key={`${i}-${j}`} style={{ ...line, ...(c.type === 'added' ? ADDED : REMOVED) }}>{c.type === 'added' ? '+ ' : '− '}{l}</div>))}
              </div>
            )}

            {view === 'sidebyside' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <strong>A</strong><strong>B</strong>
                {chunks.map((c, i) => (
                  <React.Fragment key={i}>
                    <div>{c.type === 'same' ? <Collapsed lines={c.lines} /> : c.type === 'removed' ? c.lines.map((l, j) => <div key={j} style={{ ...line, ...REMOVED }}>{l}</div>) : null}</div>
                    <div>{c.type === 'same' ? <Collapsed lines={c.lines} /> : c.type === 'added' ? c.lines.map((l, j) => <div key={j} style={{ ...line, ...ADDED }}>{l}</div>) : null}</div>
                  </React.Fragment>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

export default DocumentComparison
