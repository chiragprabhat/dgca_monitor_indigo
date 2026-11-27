import React, { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import Overview from './pages/Overview'
import DGCAUpdates from './pages/DGCAUpdates'
import DocumentComparison from './pages/DocumentComparison'
import ImpactActions from './pages/ImpactActions'
import ActivityLog from './pages/ActivityLog'
import Settings from './pages/Settings'
import SearchDocuments from './pages/SearchDocuments'
import { api, getPrefs, readLocal, writeLocal, parseDbTime } from './api'
import { pollWhileVisible } from './visible-polling'

const LAST_SEEN_KEY = 'dgca-last-seen'

function App() {
  const [activePage, setActivePageRaw] = useState('overview')
  const [pageParams, setPageParams] = useState({})
  const setActivePage = (page, params = {}) => { setPageParams(params); setActivePageRaw(page) }
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [monitoringStatus, setMonitoringStatus] = useState(null)
  const [lastCheckTime, setLastCheckTime] = useState(null)
  const [latest, setLatest] = useState([])
  const [lastSeen, setLastSeen] = useState(() => {
    const stored = readLocal(LAST_SEEN_KEY, null)
    if (stored) return new Date(stored)
    const now = new Date()
    writeLocal(LAST_SEEN_KEY, now.toISOString())
    return now
  })
  const [, setPrefsVersion] = useState(0)
  const knownIds = useRef(null)

  const fetchMonitoringStatus = useCallback(async () => {
    try {
      const data = await api('/monitor/status')
      setMonitoringStatus(data)
      const lastOk = (data.recentRuns || []).find(r => r.status === 'success')
      if (lastOk) setLastCheckTime(parseDbTime(lastOk.run_at))
    } catch {
      setMonitoringStatus({ offline: true })
    }
  }, [])

  // Newest publications, for the bell and desktop notifications.
  const fetchLatest = useCallback(async () => {
    try {
      const { data } = await api('/updates?limit=20&origin=monitor')
      if (knownIds.current) {
        const arrived = data.filter(u => !knownIds.current.has(u.id))
        const prefs = getPrefs()
        if (arrived.length && prefs.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
          for (const u of arrived.slice(0, 3)) {
            new Notification(`[${(u.priority || 'new').toUpperCase()}] DGCA ${u.section}`, { body: u.title.slice(0, 180) })
          }
        }
      }
      knownIds.current = new Set(data.map(u => u.id))
      setLatest(data)
    } catch { /* backend offline - header shows it */ }
  }, [])

  useEffect(() => {
    const stopPolling = pollWhileVisible(
      () => Promise.all([fetchMonitoringStatus(), fetchLatest()]), 6 * 60 * 1000
    )
    const onPrefs = () => setPrefsVersion(v => v + 1)
    window.addEventListener('dgca-prefs-changed', onPrefs)
    return () => { stopPolling(); window.removeEventListener('dgca-prefs-changed', onPrefs) }
  }, [fetchMonitoringStatus, fetchLatest])

  const markRead = () => {
    const now = new Date()
    writeLocal(LAST_SEEN_KEY, now.toISOString())
    setLastSeen(now)
  }

  const renderPage = () => {
    switch (activePage) {
      case 'updates':
        return <DGCAUpdates key={pageParams.category || 'all'} initialCategory={pageParams.category} onNavigate={setActivePage} />
      case 'comparison':
        return <DocumentComparison key={`${pageParams.a}-${pageParams.b}`} initialA={pageParams.a} initialB={pageParams.b} />
      case 'impact':
        return <ImpactActions onNavigate={setActivePage} />
      case 'search':
        return <SearchDocuments onNavigate={setActivePage} />
      case 'activity':
        return <ActivityLog />
      case 'settings':
        return <Settings onStatusUpdate={() => { fetchMonitoringStatus(); fetchLatest() }} />
      default:
        return <Overview monitoringStatus={monitoringStatus} onNavigate={setActivePage} />
    }
  }

  return (
    <div className="app-container">
      <Sidebar
        activePage={activePage}
        onPageChange={page => setActivePage(page)}
        isOpen={sidebarOpen}
      />

      <div className="app-content">
        <Header
          onMenuToggle={() => setSidebarOpen(!sidebarOpen)}
          activePage={activePage}
          lastCheckTime={lastCheckTime}
          monitoringStatus={monitoringStatus}
          latest={latest}
          lastSeen={lastSeen}
          onMarkRead={markRead}
          onOpenUpdates={() => { markRead(); setActivePage('updates') }}
        />

        <main className="app-main">
          {renderPage()}
        </main>
      </div>
    </div>
  )
}

export default App
