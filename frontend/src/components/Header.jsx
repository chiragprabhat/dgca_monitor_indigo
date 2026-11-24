import React, { useState, useRef, useEffect } from 'react'
import './Header.css'
import { PriorityBadge, formatDate } from './Priority'
import { parseDbTime } from '../api'

const PAGE_TITLES = {
  overview: { title: 'Overview', subtitle: 'Executive dashboard & regulatory intelligence' },
  updates: { title: 'DGCA Updates', subtitle: 'Browse and search publications' },
  search: { title: 'Search Documents', subtitle: 'Search inside every stored DGCA PDF' },
  comparison: { title: 'Document Comparison', subtitle: 'Compare two documents' },
  impact: { title: 'Impact & Actions', subtitle: 'Review priorities and recommendations' },
  activity: { title: 'Activity Log', subtitle: 'Checks, emails and settings changes' },
  settings: { title: 'Settings', subtitle: 'Configuration & preferences' }
}

function Header({ onMenuToggle, activePage, lastCheckTime, monitoringStatus, latest, lastSeen, onMarkRead, onOpenUpdates }) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef(null)
  const pageInfo = PAGE_TITLES[activePage] || PAGE_TITLES.overview
  const isHealthy = monitoringStatus?.scheduler?.running
  const lastCheck = lastCheckTime
    ? lastCheckTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : 'Not yet'

  const isUnread = u => lastSeen && parseDbTime(u.detected_at) > lastSeen
  const unread = (latest || []).filter(isUnread).length

  useEffect(() => {
    if (!open) return
    const close = e => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <header className="app-header">
      <div className="header-left">
        <button className="menu-toggle" onClick={onMenuToggle} title="Toggle sidebar">
          ☰
        </button>
        <div className="page-info">
          <h1>{pageInfo.title}</h1>
          <p>{pageInfo.subtitle}</p>
        </div>
      </div>

      <div className="header-right">
        <div className="monitoring-status">
          <div className={`status-indicator ${isHealthy ? 'healthy' : 'inactive'}`}>
            <span className="status-dot"></span>
            <span className="status-text">
              {monitoringStatus === null ? 'Connecting...' : monitoringStatus.offline ? 'Backend offline' : isHealthy ? 'Monitoring Active' : 'Monitoring Stopped'}
            </span>
          </div>
          <div className="last-check">
            <small>Last check: {lastCheck}</small>
          </div>
        </div>

        <div ref={panelRef} style={{ position: 'relative' }}>
          <button className="notification-bell" title={unread ? `${unread} new publication${unread === 1 ? '' : 's'}` : 'No new publications'} onClick={() => setOpen(!open)}>
            🔔
            {unread > 0 && <span className="notification-badge">{unread > 9 ? '9+' : unread}</span>}
          </button>
          {open && (
            <div style={{ position: 'absolute', right: 0, top: '44px', width: '380px', maxWidth: '90vw', background: 'var(--card-bg, #fff)', border: '1px solid var(--border-color, #E5E7EB)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 50 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border-color, #E5E7EB)' }}>
                <strong>{unread ? `${unread} new since you last looked` : 'Latest publications'}</strong>
                {unread > 0 && <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: '12px' }} onClick={onMarkRead}>Mark all as read</button>}
              </div>
              <div style={{ maxHeight: '360px', overflowY: 'auto' }}>
                {(latest || []).length === 0 && <div style={{ padding: '16px' }}>No publications yet.</div>}
                {(latest || []).slice(0, 8).map(u => (
                  <button
                    key={u.id}
                    onClick={() => { setOpen(false); onOpenUpdates() }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px', border: 'none', borderBottom: '1px solid var(--border-light, #F3F4F6)', background: isUnread(u) ? 'var(--accent-sky, #E1EDF7)' : 'transparent', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
                      <PriorityBadge priority={u.priority} />
                      <small>{u.section} • {formatDate(u.publication_date)}</small>
                      {isUnread(u) && <small><strong>NEW</strong></small>}
                    </div>
                    <div style={{ fontSize: '13px', lineHeight: 1.4 }}>{u.title.length > 110 ? `${u.title.slice(0, 107)}...` : u.title}</div>
                  </button>
                ))}
              </div>
              <div style={{ padding: '10px 16px' }}>
                <button className="btn-ghost" style={{ width: '100%' }} onClick={() => { setOpen(false); onOpenUpdates() }}>View all publications</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

export default Header
