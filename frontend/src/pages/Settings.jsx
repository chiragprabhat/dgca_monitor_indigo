import React, { useState, useEffect, useCallback } from 'react'
import './Pages.css'
import { API, api, getPrefs, setPrefs, formatDateTime } from '../api'

const CATEGORY_LABELS = { tenders: 'Tenders', regulation: 'Regulation', guidance: 'Guidance', announcements: 'Announcements' }
const INTERVAL_LABELS = { 15: 'Every 15 minutes', 30: 'Every 30 minutes', 60: 'Every hour', 240: 'Every 4 hours' }
const PRIORITY_LABELS = { low: 'All priorities (Low and above)', medium: 'Medium and High only', high: 'High only' }
const PROVIDER_LABELS = { auto: 'Automatic (best available)', claude: 'Claude AI', ollama: 'Local model (Ollama)', basic: 'Built-in text summary' }
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

const field = { width: '100%', padding: '8px', marginTop: '8px', borderRadius: '4px', border: '1px solid var(--border-color)' }
const row = { display: 'flex', gap: '8px', alignItems: 'center' }

function StatusLine({ ok, warn, children }) {
  const bg = ok ? '#D1FAE5' : warn ? '#FEF3C7' : '#FEE2E2'
  return (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '12px', background: bg, borderRadius: '4px' }}>
      <span style={{ fontSize: '14px', lineHeight: '20px' }}>●</span>
      <div style={{ lineHeight: '20px' }}>{children}</div>
    </div>
  )
}

const SECTION_NAMES = { tenders: 'Tenders', regulation: 'Regulation', guidance: 'Guidance', announcements: 'Announcements' }

// Imports every older publication from DGCA's "More" > "Archived" lists. Never emails.
function ArchivePanel() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState('')

  const refresh = useCallback(() => api('/archive/status').then(setStatus).catch(e => setError(e.message)), [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (!status || !(status.importing || status.analysing)) return
    const t = setTimeout(refresh, 5000)
    return () => clearTimeout(t)
  }, [status, refresh])

  const start = async () => {
    setError('')
    try {
      await api('/archive/import', { method: 'POST' })
    } catch (e) {
      setError(e.message)
    }
    refresh()
  }

  const busy = status && (status.importing || status.analysing)
  const pct = status && status.total ? Math.round((100 * status.analysed) / status.total) : 0
  const last = status?.lastImport

  return (
    <section className="card">
      <div className="card-header">
        <h3>DGCA Archive</h3>
        <span className="section-meta">Older publications for comparison and review</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <p style={{ margin: 0 }}>
          Brings in every publication from each tab's <strong>More → Archived</strong> list on the DGCA site, back to 2016, so
          they can be searched, compared and reviewed. Archived publications are <strong>never emailed</strong>. Their PDFs are
          read slowly in the background (about 25 a minute) with the built-in summary, so no AI costs are run up.
        </p>
        {status && (
          <StatusLine ok={!error && !last?.error} warn={busy || !!last?.error}>
            {status.total === 0 && !busy
              ? 'Not imported yet.'
              : <>
                  <strong>{status.total} archived publications</strong>
                  {Object.keys(status.bySection).length > 0 && <> ({Object.entries(status.bySection).map(([k, v]) => `${SECTION_NAMES[k] || k} ${v}`).join(', ')})</>}
                  <br />
                  {status.importing && 'Reading the lists from DGCA... '}
                  {status.analysing && `Reading PDFs: ${status.analysed} of ${status.total} (${pct}%)`}
                  {!busy && `${status.analysed} of ${status.total} PDFs read, ${status.withText} with readable text`}
                </>}
            {last?.error && <><br /><strong>Last import:</strong> {last.error}</>}
          </StatusLine>
        )}
        {busy && (
          <div style={{ height: '8px', background: 'var(--border-light, #E5E7EB)', borderRadius: '4px', overflow: 'hidden' }} aria-hidden="true">
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--primary-blue, #0759A8)', transition: 'width 0.5s' }} />
          </div>
        )}
        {error && <StatusLine>{error}</StatusLine>}
        <div>
          <button className="btn-ghost" onClick={start} disabled={!!busy}>
            {busy ? 'Import running...' : status?.total ? 'Check for more archived publications' : 'Import DGCA archive'}
          </button>
        </div>
      </div>
    </section>
  )
}

function Settings({ onStatusUpdate }) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [health, setHealth] = useState(null)
  const [storage, setStorage] = useState(null)
  const [newRecipient, setNewRecipient] = useState('')
  const [message, setMessage] = useState(null)
  const [busy, setBusy] = useState('')
  const [prefs, setPrefsState] = useState(getPrefs())
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async ({ keepDraft = false } = {}) => {
    try {
      const [s, h, st] = await Promise.all([api('/settings'), api('/system/health'), api('/system/storage')])
      setData(s)
      if (!keepDraft) setDraft(s.settings)
      setHealth(h)
      setStorage(st)
      setLoadError('')
    } catch (e) {
      setLoadError(`Could not reach the backend (${e.message}). Is the API window running?`)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loadError) return <div className="page-container"><section className="card"><StatusLine>{loadError}</StatusLine></section></div>
  if (!data || !draft) return <div className="page-container"><div className="loading">Loading settings...</div></div>

  const saved = data.settings
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft)
  const set = patch => setDraft({ ...draft, ...patch })
  const status = data.status
  const email = status.email

  const addRecipient = () => {
    const value = newRecipient.trim()
    if (!value) return
    if (!EMAIL_RE.test(value)) { setMessage({ ok: false, text: `"${value}" is not a valid email address.` }); return }
    if (draft.recipients.some(r => r.toLowerCase() === value.toLowerCase())) { setNewRecipient(''); return }
    set({ recipients: [...draft.recipients, value] })
    setNewRecipient('')
    setMessage(null)
  }

  const toggleCategory = cat => {
    const has = draft.categories.includes(cat)
    set({ categories: has ? draft.categories.filter(c => c !== cat) : [...draft.categories, cat] })
  }

  const save = async () => {
    setBusy('save')
    setMessage(null)
    try {
      const patch = {}
      for (const key of Object.keys(draft)) if (JSON.stringify(draft[key]) !== JSON.stringify(saved[key])) patch[key] = draft[key]
      const result = await api('/settings', { method: 'PUT', body: JSON.stringify(patch) })
      setData(result)
      setDraft(result.settings)
      setMessage({ ok: true, text: result.changed.length ? 'Saved. Changes apply to the next check and the next alert.' : 'Nothing to save.' })
      onStatusUpdate?.()
      api('/system/health').then(setHealth).catch(() => {})
    } catch (e) {
      setMessage({ ok: false, text: e.message })
    } finally {
      setBusy('')
    }
  }

  const discard = () => { setDraft(saved); setMessage(null) }

  const checkNow = async () => {
    setBusy('check')
    setMessage(null)
    try {
      const r = await api('/monitor/trigger', { method: 'POST' })
      setMessage(r.success
        ? { ok: true, text: `Checked DGCA: ${r.itemsFound} publications, ${r.newItems} new, ${r.notificationsSent} emailed.` }
        : { ok: false, text: `Check failed: ${r.error}` })
      onStatusUpdate?.()
      load({ keepDraft: true })
    } catch (e) {
      setMessage({ ok: false, text: e.message })
    } finally {
      setBusy('')
    }
  }

  const sendTest = async () => {
    setBusy('test')
    setMessage(null)
    try {
      const r = await api('/notifications/test', { method: 'POST' })
      setMessage({ ok: true, text: `Test alert sent to ${r.recipients.join(', ')}. Check your inbox (and Junk folder).` })
      load({ keepDraft: true })
    } catch (e) {
      setMessage({ ok: false, text: `Test email failed: ${e.message}` })
    } finally {
      setBusy('')
    }
  }

  const changePref = async patch => {
    if (patch.browserNotifications && 'Notification' in window && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setMessage({ ok: false, text: 'The browser blocked notifications. Allow them for this site in the browser settings, then try again.' })
        return
      }
    }
    setPrefsState(setPrefs(patch))
  }

  const engines = status.summaries
  const engineAvailable = {
    auto: true,
    claude: engines.claude.keySet,
    ollama: engines.ollama.reachable && engines.ollama.hasModel,
    basic: true
  }
  const activeEngineLabel = { claude: 'Claude AI', ollama: `local model ${engines.ollama.model}`, basic: 'built-in text summary' }[engines.active]
    || 'Select the built-in summary engine for this deployment'
  const lastFailedIsLatest = email.lastFailed && (!email.lastSent || email.lastFailed.sent_at > email.lastSent.sent_at)

  return (
    <div className="page-container">
      {message && (
        <StatusLine ok={message.ok}>{message.text}</StatusLine>
      )}

      {/* Monitoring */}
      <section className="card">
        <div className="card-header">
          <h3>Monitoring</h3>
          <span className="section-meta">How often DGCA is checked</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label><strong>Source</strong></label>
            <div style={{ marginTop: '8px' }}>
              <a href="https://www.dgca.gov.in/digigov-portal/" target="_blank" rel="noreferrer">DGCA portal - What's New</a> (Tenders, Regulation, Guidance, Announcements)
            </div>
          </div>
          <div>
            <label><strong>Check interval</strong></label>
            <select value={draft.intervalMinutes} onChange={e => set({ intervalMinutes: Number(e.target.value) })} style={field}>
              {data.options.intervals.map(m => <option key={m} value={m}>{INTERVAL_LABELS[m] || `Every ${m} minutes`}</option>)}
            </select>
          </div>
          <StatusLine ok={health?.monitoring.ok}>
            <strong>Monitoring:</strong> {health?.monitoring.detail}
            {health?.monitoring.lastRunAt && <> • last check {formatDateTime(health.monitoring.lastRunAt)} IST</>}
          </StatusLine>
          <div><button className="btn-ghost" onClick={checkNow} disabled={!!busy}>{busy === 'check' ? 'Checking...' : 'Check DGCA now'}</button></div>
        </div>
      </section>

      {/* Email alerts */}
      <section className="card">
        <div className="card-header">
          <h3>Email Alerts</h3>
          <span className="section-meta">Who gets alerted, and for what</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <label style={row}>
            <input type="checkbox" checked={draft.emailEnabled} onChange={e => set({ emailEnabled: e.target.checked })} />
            <strong>Send email alerts</strong>
          </label>

          <div>
            <label><strong>Recipients</strong></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
              {draft.recipients.length === 0 && <span style={{ color: 'var(--secondary-text)' }}>No recipients yet</span>}
              {draft.recipients.map(r => (
                <span key={r} className="badge badge-info" style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '13px', textTransform: 'none' }}>
                  {r}
                  <button onClick={() => set({ recipients: draft.recipients.filter(x => x !== r) })} title={`Remove ${r}`} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '14px', padding: 0 }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <input
                type="email"
                placeholder="name@goindigo.in"
                value={newRecipient}
                onChange={e => setNewRecipient(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRecipient() } }}
                style={{ ...field, marginTop: 0, flex: 1 }}
              />
              <button className="btn-ghost" onClick={addRecipient}>Add</button>
            </div>
          </div>

          <div>
            <label><strong>Email these categories</strong></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', marginTop: '8px' }}>
              {data.options.categories.map(cat => (
                <label key={cat} style={row}>
                  <input type="checkbox" checked={draft.categories.includes(cat)} onChange={() => toggleCategory(cat)} />
                  {CATEGORY_LABELS[cat]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label><strong>Minimum priority to email</strong></label>
            <select value={draft.minPriority} onChange={e => set({ minPriority: e.target.value })} style={field}>
              {data.options.priorities.map(p => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
            </select>
          </div>

          <label style={row}>
            <input type="checkbox" checked={draft.sameDayOnly} onChange={e => set({ sameDayOnly: e.target.checked })} />
            <span>Only email publications dated today (India time)</span>
          </label>

          <label style={row}>
            <input type="checkbox" checked={draft.attachPdf} onChange={e => set({ attachPdf: e.target.checked })} />
            <span>Attach the PDF (up to 15 MB; larger ones are linked)</span>
          </label>

          <StatusLine ok={email.isConfigured && !lastFailedIsLatest} warn={!email.enabled}>
            <strong>Sender:</strong> {email.fromName} &lt;{email.from || 'not set'}&gt; via {email.transport === 'gmail' ? 'Gmail' : email.transport.replace('smtp:', 'SMTP ')}
            {!email.senderPasswordSet && <> - <strong>sender password missing in .env</strong></>}
            <br />
            {email.lastSent ? <>Last sent {formatDateTime(email.lastSent.sent_at)} IST to {email.lastSent.recipient_email}</> : 'No alert sent yet'}
            {lastFailedIsLatest && <><br /><strong>Last attempt failed:</strong> {email.lastFailed.error_message}</>}
            <br />
            <small>The sender account and its password are set in the backend's .env file, never through this page.</small>
          </StatusLine>

          <div>
            <button className="btn-ghost" onClick={sendTest} disabled={!!busy || dirty || !saved.emailEnabled}>
              {busy === 'test' ? 'Sending...' : 'Send test email'}
            </button>
            {(dirty || !saved.emailEnabled) && <small style={{ marginLeft: '12px', color: 'var(--secondary-text)' }}>{dirty ? 'Save your changes first' : 'Turn alerts on and save first'}</small>}
          </div>
        </div>
      </section>

      {/* Summaries */}
      <section className="card">
        <div className="card-header">
          <h3>Summaries &amp; Priority</h3>
          <span className="section-meta">How each publication is analysed</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label><strong>Summary engine</strong></label>
            <select value={draft.summaryProvider} onChange={e => set({ summaryProvider: e.target.value })} style={field}>
              {data.options.providers.map(p => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}{engineAvailable[p] ? '' : ' - not available'}</option>
              ))}
            </select>
          </div>
          <StatusLine ok={engines.active === 'claude' || engines.active === 'ollama'} warn={!engines.active || engines.active === 'basic'}>
            <strong>In use now:</strong> {activeEngineLabel}
            <br />
            Claude AI: {engines.claude.keySet ? `API key set (${engines.claude.model})` : 'no ANTHROPIC_API_KEY in .env'}
            {' • '}Local model: {engines.ollama.reachable ? (engines.ollama.hasModel ? `${engines.ollama.model} ready` : `Ollama running, ${engines.ollama.model} not installed`) : 'Ollama not running'}
            <br />
            <small>Priority (High / Medium / Low) is set by airline-operations rules, or by the AI when an AI engine is in use.</small>
          </StatusLine>
        </div>
      </section>

      {/* Documents */}
      <section className="card">
        <div className="card-header">
          <h3>Document Processing</h3>
          <span className="section-meta">PDF reading</span>
        </div>
        <StatusLine ok={health?.documents.ok}>
          <strong>PDF text extraction:</strong> {health?.documents.detail}
          <br />
          <small>Text is read directly from the PDF. There is no OCR, so scanned PDFs are attached to alerts but can't be summarised unless Claude AI is in use.</small>
        </StatusLine>
      </section>

      {/* Data */}
      <section className="card">
        <div className="card-header">
          <h3>Data</h3>
          <span className="section-meta">What's stored on this PC</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <StatusLine ok={health?.database.ok}>
            <strong>Database:</strong> {storage ? `${storage.publications} publications, ${storage.emails} emails, ${storage.checks} checks logged, ${(storage.sizeBytes / 1048576).toFixed(1)} MB` : '...'}
          </StatusLine>
          <div><a className="btn-ghost" href={`${API}/system/export.csv`}>Download all publications (CSV)</a></div>
        </div>
      </section>

      <ArchivePanel />

      {/* Display */}
      <section className="card">
        <div className="card-header">
          <h3>Display</h3>
          <span className="section-meta">This browser only - applies immediately</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label><strong>Date format</strong></label>
            <select value={prefs.dateFormat} onChange={e => changePref({ dateFormat: e.target.value })} style={field}>
              <option value="dd-mmm-yyyy">13 Oct 2026</option>
              <option value="dd-mm-yyyy">13-10-2026</option>
              <option value="yyyy-mm-dd">2026-10-13</option>
            </select>
          </div>
          <label style={row}>
            <input
              type="checkbox"
              checked={prefs.browserNotifications}
              disabled={!('Notification' in window)}
              onChange={e => changePref({ browserNotifications: e.target.checked })}
            />
            <span>Desktop notification when a new publication appears while this dashboard is open</span>
          </label>
        </div>
      </section>

      <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', alignItems: 'center', marginTop: '8px' }}>
        {dirty && <small style={{ color: 'var(--secondary-text)' }}>You have unsaved changes</small>}
        <button className="btn-ghost" onClick={discard} disabled={!dirty || !!busy}>Discard changes</button>
        <button className="btn-primary" onClick={save} disabled={!dirty || !!busy}>{busy === 'save' ? 'Saving...' : 'Save changes'}</button>
      </div>
    </div>
  )
}

export default Settings
