import React, { useState, useEffect } from 'react'
import './Pages.css'
import { BarChartIcon, TrendingUpIcon, AlertIcon, SearchIcon, FileTextIcon, BookIcon, BellIcon, CheckCircleIcon } from '../components/Icons'
import { PriorityBadge, DeadlineText, formatDate, pdfUrl } from '../components/Priority'
import { api } from '../api'

function Overview({ monitoringStatus, onNavigate }) {
  const [updates, setUpdates] = useState([])
  const [priorityItems, setPriorityItems] = useState([])
  const [highCount, setHighCount] = useState(0)
  const [stats, setStats] = useState({ tenders: 0, regulation: 0, guidance: 0, announcements: 0 })
  const [loading, setLoading] = useState(true)
  const [health, setHealth] = useState(null)
  const [healthError, setHealthError] = useState('')

  useEffect(() => {
    Promise.all([
      api('/updates?limit=5'),
      api('/sections'),
      api('/updates?sort=priority&limit=3'),
      api('/updates?priority=high&origin=monitor&review=open&limit=1')
    ]).then(([updates, sections, top, high]) => {
      setUpdates(updates.data || [])
      setPriorityItems(top.data || [])
      setHighCount(high.total || 0)
      setStats(Object.fromEntries((sections.data || []).map(s => [s.id, s.count])))
      setLoading(false)
    }).catch(() => setLoading(false))
    api('/system/health').then(setHealth).catch(e => setHealthError(`Backend unreachable: ${e.message}`))
  }, [monitoringStatus?.recentRuns?.[0]?.id])

  const lastRun = monitoringStatus?.recentRuns?.[0]?.run_at
  const lastCheck = lastRun
    ? new Date(`${lastRun.replace(' ', 'T')}Z`).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : 'Not yet'

  const KPICard = ({ label, value, icon }) => (
    <div className="kpi-card">
      <div className="kpi-icon" style={{ fontSize: '24px', color: 'var(--primary-blue)' }}>
        {icon}
      </div>
      <div className="kpi-content">
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value}</div>
      </div>
    </div>
  )

  const sections = [
    { id: 'tenders', label: 'Tenders', count: stats.tenders, icon: SearchIcon, color: '#0759A8' },
    { id: 'regulation', label: 'Regulation', count: stats.regulation, icon: FileTextIcon, color: '#059669' },
    { id: 'guidance', label: 'Guidance', count: stats.guidance, icon: BookIcon, color: '#F8C400' },
    { id: 'announcements', label: 'Announcements', count: stats.announcements, icon: BellIcon, color: '#DC2626' }
  ]

  return (
    <div className="page-container">
      {/* Executive Summary */}
      <section className="kpi-section">
        <div className="section-header">
          <h2>Executive Summary</h2>
          <span className="section-meta">Regulatory intelligence dashboard</span>
        </div>
        <div className="kpi-grid">
          <KPICard label="Total Publications" value={Object.values(stats).reduce((a,b)=>a+b, 0)} icon={<BarChartIcon />} />
          <KPICard label="High Priority To Review" value={highCount} icon={<AlertIcon />} />
          <KPICard label="Last Check (IST)" value={lastCheck} icon={<TrendingUpIcon />} />
          <KPICard label="Monitoring Status" value={monitoringStatus?.scheduler?.running ? 'Active' : 'Paused'} icon={<SearchIcon />} />
        </div>
      </section>

      {/* Priority Review */}
      <section className="card">
        <div className="card-header">
          <h3>Priority Review</h3>
          <span className="section-meta">Highest priority first</span>
        </div>
        {priorityItems.length > 0 ? (
          <div className="priority-list">
            {priorityItems.map(update => (
              <div key={update.id} className={`priority-item priority-${update.priority || 'medium'}`}>
                <div className="priority-badge">{(update.priority || 'pending').toUpperCase()}</div>
                <div className="priority-content">
                  <h4>{update.title}</h4>
                  {update.summary && <p>{update.summary.length > 260 ? `${update.summary.slice(0, 257)}...` : update.summary}</p>}
                  <small>
                    {update.priority_reason && <>{update.priority_reason} • </>}
                    {update.section} • Published {formatDate(update.publication_date)}
                    {update.deadline && <> • <DeadlineText deadline={update.deadline} /></>}
                  </small>
                </div>
                {pdfUrl(update) && <a className="btn-ghost" href={pdfUrl(update)} target="_blank" rel="noreferrer">Open PDF →</a>}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">✓</div>
            <div className="empty-state-title">All caught up</div>
            <div className="empty-state-description">No DGCA publications available for review. Check back when the monitoring system detects new items.</div>
          </div>
        )}
      </section>

      {/* Updates by Category */}
      <section className="card">
        <div className="card-header">
          <h3>Updates by Category</h3>
          <span className="section-meta">{Object.values(stats).reduce((a,b)=>a+b, 0)} total</span>
        </div>
        <div className="category-grid">
          {sections.map(section => (
            <div key={section.id} className="category-card" style={{ borderLeftColor: section.color, cursor: 'pointer' }} onClick={() => onNavigate?.('updates', { category: section.id })} title={`Show ${section.label} publications`}>
              <div className="category-icon" style={{ color: section.color }}>
                <section.icon />
              </div>
              <div className="category-info">
                <h4>{section.label}</h4>
                <div className="category-count">{section.count} publications</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Latest Publications */}
      <section className="card">
        <div className="card-header">
          <h3>Latest Publications</h3>
          <span className="section-meta">{updates.length} recent items</span>
        </div>
        {loading ? (
          <div className="loading">Loading publications...</div>
        ) : updates.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon" style={{ fontSize: '32px' }}>—</div>
            <div className="empty-state-title">No publications yet</div>
            <div className="empty-state-description">The monitoring system has not discovered any publications. Check back when monitoring detects new items from DGCA.</div>
          </div>
        ) : (
          <table className="publications-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Published</th>
                <th>Priority</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {updates.map((update, idx) => (
                <tr key={idx}>
                  <td><strong>{update.title}</strong></td>
                  <td><span className="badge badge-info">{update.section}</span></td>
                  <td>{formatDate(update.publication_date)}</td>
                  <td><PriorityBadge priority={update.priority} /></td>
                  <td>{pdfUrl(update) ? <a className="btn-ghost" style={{ padding: '4px 12px', fontSize: '12px', display: 'inline-block', whiteSpace: 'nowrap' }} href={pdfUrl(update)} target="_blank" rel="noreferrer">PDF →</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Monitoring Health */}
      <section className="card">
        <div className="card-header">
          <h3>System Health</h3>
          <span className="section-meta">Component status</span>
        </div>
        {!health ? (
          <div className="loading">{healthError || 'Checking components...'}</div>
        ) : (
          <div className="health-grid">
            {[
              ['Monitoring Service', health.monitoring],
              ['Database', health.database],
              ['Document Processing', health.documents],
              ['Email Alerts', health.email]
            ].map(([name, part]) => {
              const state = part.ok ? (name === 'Email Alerts' && !part.enabled ? 'degraded' : 'healthy') : 'failed'
              return (
                <div className="health-item" key={name}>
                  <div className={`health-status ${state}`}>{state === 'healthy' ? '✓' : state === 'degraded' ? '–' : '!'}</div>
                  <div className="health-info">
                    <div className="health-name">{name}</div>
                    <div className="health-detail">{part.detail}</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

export default Overview
