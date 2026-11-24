import React, { useState, useEffect, useCallback, useRef } from 'react'
import { api, uploadPdf, formatDateTime } from '../api'
import DocPicker from './DocPicker'

const MAX_UPLOAD_MB = 40
const muted = { color: 'var(--secondary-text, #6B7280)' }
const errorStyle = { textTransform: 'none', fontSize: '13px', padding: '8px 12px', display: 'block', marginBottom: '12px' }

const sizeLabel = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

// Upload a PDF from this PC, then compare it with a CAR Section 8 in force or any stored publication.
// onCompare(idA, idB) runs the comparison; the result is shown by the page below.
function UploadCompare({ docs, label, busy, active, onCompare }) {
  const [uploads, setUploads] = useState([])
  const [selected, setSelected] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [target, setTarget] = useState('car')
  const [cars, setCars] = useState(null)
  const [carId, setCarId] = useState('')
  const [carQuery, setCarQuery] = useState('')
  const [pubId, setPubId] = useState('')
  const [role, setRole] = useState('b')
  const fileInput = useRef(null)

  const loadUploads = useCallback(() => api('/compare/uploads').then(d => { setUploads(d.data || []); return d.data || [] }), [])

  useEffect(() => {
    loadUploads().then(list => setSelected(s => s || list[0]?.id || '')).catch(e => setError(`Backend unreachable: ${e.message}`))
  }, [loadUploads])

  useEffect(() => {
    if (target !== 'car' || cars) return
    api('/cars').then(d => setCars((d.cars || []).filter(c => c.status === 'in force'))).catch(e => setError(`Could not load the CAR list: ${e.message}`))
  }, [target, cars])

  const upload = async file => {
    setError('')
    setNotice('')
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return setError('Choose a PDF file.')
    if (file.size > MAX_UPLOAD_MB * 1048576) return setError(`That file is larger than ${MAX_UPLOAD_MB} MB.`)
    setUploading(true)
    try {
      const stored = await uploadPdf(file)
      await loadUploads()
      setSelected(stored.id)
      if (!stored.hasText) setNotice('This PDF has little or no readable text (probably a scan), so a comparison will show almost nothing.')
      else if (stored.duplicate) setNotice('This file was uploaded before; using the stored copy.')
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }

  const remove = async id => {
    setError('')
    try {
      await api(`/compare/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const rest = await loadUploads()
      if (selected === id) setSelected(rest[0]?.id || '')
    } catch (e) {
      setError(e.message)
    }
  }

  const terms = carQuery.toLowerCase().split(/\s+/).filter(Boolean)
  const carMatches = (cars || []).filter(c => c.id === carId || terms.every(t => `${c.id} series ${c.series} part ${c.part} ${c.subject}`.toLowerCase().includes(t)))
  const targetId = target === 'car' ? (carId && `car:${carId}`) : pubId
  const chosen = uploads.find(u => u.id === selected)
  const canCompare = !!chosen && !!targetId
  const compare = () => (role === 'b' ? onCompare(targetId, selected) : onCompare(selected, targetId))
  const isActive = active[0] && active[1] && [active[0], active[1]].includes(selected) && [active[0], active[1]].includes(targetId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '20px' }}>
      <div>
        <label><strong>1. Upload a PDF from your computer</strong></label>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' }}>
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) upload(f) }} />
          <button className="btn-primary" disabled={uploading} onClick={() => fileInput.current?.click()}>
            {uploading ? 'Uploading and reading the PDF...' : 'Choose PDF file'}
          </button>
          <span style={{ fontSize: '13px', ...muted }}>Up to {MAX_UPLOAD_MB} MB. The file is read here and its text stored in your system.</span>
        </div>
      </div>

      {error && <div className="badge badge-error" style={errorStyle}>{error}</div>}
      {notice && <div className="badge badge-warning" style={errorStyle}>{notice}</div>}

      <div>
        <label><strong>Your uploaded files</strong></label>
        {uploads.length === 0 ? (
          <p style={{ fontSize: '13px', margin: '6px 0 0', ...muted }}>Nothing uploaded yet.</p>
        ) : (
          <div style={{ border: '1px solid var(--border-light, #E5E7EB)', borderRadius: '6px', marginTop: '6px' }}>
            {uploads.map(u => (
              <div key={u.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '6px 10px', borderTop: '1px solid rgba(0,0,0,0.06)', fontSize: '13px' }}>
                <label style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 1, minWidth: 0, cursor: 'pointer' }}>
                  <input type="radio" name="uploaded-file" checked={selected === u.id} onChange={() => setSelected(u.id)} />
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.filename}</strong>
                </label>
                {!u.hasText && <span className="badge badge-warning">NO TEXT</span>}
                <span style={{ whiteSpace: 'nowrap', ...muted }}>{u.pages ?? '?'} pages • {sizeLabel(u.sizeBytes)} • {formatDateTime(u.uploadedAt)}</span>
                <button className="btn-ghost" style={{ padding: '2px 10px', fontSize: '12px' }} disabled={busy} onClick={() => remove(u.id)}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <label><strong>2. Compare it with</strong></label>
        <div style={{ display: 'flex', gap: '16px', fontSize: '14px', margin: '6px 0' }}>
          <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input type="radio" checked={target === 'car'} onChange={() => setTarget('car')} /> CAR Section 8 in force
          </label>
          <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input type="radio" checked={target === 'pub'} onChange={() => setTarget('pub')} /> A stored publication
          </label>
        </div>
        {target === 'car' ? (
          !cars ? <span style={{ fontSize: '13px', ...muted }}>Loading CARs...</span> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '6px' }}>
              <input type="search" placeholder={`Search ${cars.length} CARs in force (series, part or subject)...`} value={carQuery} onChange={e => setCarQuery(e.target.value)} style={{ padding: '8px', width: '100%', boxSizing: 'border-box' }} />
              <select value={carId} onChange={e => setCarId(e.target.value)} style={{ padding: '8px', width: '100%', boxSizing: 'border-box' }}>
                <option value="">{carQuery ? `${carMatches.length} matching - choose one...` : 'Choose a CAR in force...'}</option>
                {carMatches.map(c => <option key={c.id} value={c.id}>Series {c.series} Part {c.part} - {c.subject}</option>)}
              </select>
              {cars.length === 0 && <span style={{ fontSize: '13px', ...muted }}>No CARs stored yet. Open the "CAR Section 8 in force" tab and click Refresh from DGCA.</span>}
            </div>
          )
        ) : (
          <DocPicker id="upload-pub" docs={docs} value={pubId} onChange={setPubId} label={label} />
        )}
      </div>

      <div>
        <label><strong>3. Your file is the</strong></label>
        <div style={{ display: 'flex', gap: '16px', fontSize: '14px', margin: '6px 0' }}>
          <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input type="radio" checked={role === 'b'} onChange={() => setRole('b')} /> Newer / revised version (B)
          </label>
          <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input type="radio" checked={role === 'a'} onChange={() => setRole('a')} /> Older / original version (A)
          </label>
        </div>
        <span style={{ fontSize: '13px', ...muted }}>
          {role === 'b'
            ? 'Green = in your file but not in the document you chose. Red = in the chosen document but missing from your file.'
            : 'Red = in your file but not in the document you chose. Green = in the chosen document but missing from your file.'}
        </span>
      </div>

      <div>
        <button className="btn-primary" onClick={compare} disabled={!canCompare || busy || uploading}>
          {busy ? 'Comparing...' : isActive ? 'Compare again' : 'Compare'}
        </button>
        {!canCompare && <span style={{ fontSize: '13px', marginLeft: '12px', ...muted }}>{!chosen ? 'Upload or select a file first.' : 'Choose what to compare it with.'}</span>}
      </div>
    </div>
  )
}

export default UploadCompare
