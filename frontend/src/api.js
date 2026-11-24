export const API = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '') || '/api'

async function jobResult(id, signal) {
  const deadline = Date.now() + 45 * 60 * 1000
  let result = ''
  let offset = 0
  while (Date.now() < deadline) {
    const job = await api(`/jobs/${encodeURIComponent(id)}?offset=${offset}`, { signal })
    if (job.state === 'queued' || job.state === 'running') {
      await new Promise(resolve => setTimeout(resolve, 15000))
      continue
    }
    result += job.chunk || ''
    if (job.next !== null) {
      offset = job.next
      continue
    }
    const data = JSON.parse(result)
    if (job.status >= 400) throw new Error(data.error || `Request failed (${job.status})`)
    return data
  }
  throw new Error('This job is still pending. Check the dashboard before retrying.')
}

export async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  if (res.status === 202 && data.jobId) return jobResult(data.jobId, options.signal)
  return data
}

// Sends a PDF the user picked (as raw bytes) to be stored for Document Comparison.
export async function uploadPdf(file) {
  if (__DGCA_SERVERLESS__) {
    const { id, chunkBytes } = await api('/compare/upload-sessions', {
      method: 'POST', body: JSON.stringify({ name: file.name, bytes: file.size })
    })
    for (let offset = 0, part = 0; offset < file.size; offset += chunkBytes, part++) {
      const response = await fetch(`${API}/compare/upload-sessions/${id}/${part}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.slice(offset, offset + chunkBytes)
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || `Upload failed (${response.status})`)
      }
    }
    return api(`/compare/upload-sessions/${id}/finish`, { method: 'POST' })
  }
  const res = await fetch(`${API}/compare/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/pdf' },
    body: file
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`)
  return data
}

// Per-browser display preferences (not shared with other users or the backend).
const PREFS_KEY = 'dgca-display-prefs'
const DEFAULT_PREFS = { dateFormat: 'dd-mmm-yyyy', browserNotifications: false }

export function getPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  window.dispatchEvent(new Event('dgca-prefs-changed'))
  return next
}

export function readLocal(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}

export function writeLocal(key, value) {
  try { localStorage.setItem(key, value) } catch { /* private mode */ }
}

// Database timestamps without a zone marker represent UTC.
export function parseDbTime(value) {
  if (!value) return null
  const s = String(value)
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`)
}

export function formatDateTime(value) {
  const d = value instanceof Date ? value : parseDbTime(value)
  if (!d || isNaN(d)) return '—'
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
}
