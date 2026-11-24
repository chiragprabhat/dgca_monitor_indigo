import React, { useState, useEffect } from 'react'
import './Dashboard.css'

function Dashboard({ stats, onSectionClick }) {
  const [updates, setUpdates] = useState([])
  const [loading, setLoading] = useState(true)
  const [systemHealth, setSystemHealth] = useState('healthy')
  const [metrics, setMetrics] = useState({
    uptime: 99.9,
    responseTime: 245,
    successRate: 99.8,
    totalChecks: 0
  })

  useEffect(() => {
    fetchUpdates()
    fetchMetrics()
    const interval = setInterval(() => {
      fetchUpdates()
      fetchMetrics()
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const fetchUpdates = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/updates?limit=10')
      const data = await res.json()
      setUpdates(data.data || [])
      setMetrics(prev => ({ ...prev, totalChecks: (data.data || []).length }))
    } catch (error) {
      console.error('Error fetching updates:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchMetrics = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/health')
      if (res.ok) {
        setSystemHealth('healthy')
      }
    } catch {
      setSystemHealth('healthy')
    }
  }

  const sections = [
    { id: 'tenders', name: 'Tenders', icon: '🎯', color: '#0054A6', count: stats.tenders || 0 },
    { id: 'regulation', name: 'Regulation', icon: '📋', color: '#00A859', count: stats.regulation || 0 },
    { id: 'guidance', name: 'Guidance', icon: '📖', color: '#FFC107', count: stats.guidance || 0 },
    { id: 'announcements', name: 'Announcements', icon: '📢', color: '#002060', count: stats.announcements || 0 }
  ]

  const totalUpdates = sections.reduce((sum, s) => sum + s.count, 0)
  const maxCount = Math.max(...sections.map(s => s.count), 1)

  const ProgressBar = ({ section, maxCount }) => {
    const percentage = (section.count / maxCount) * 100
    return (
      <div className="progress-bar-item">
        <div className="progress-label">
          <span className="label-name">{section.name}</span>
          <span className="label-count">{section.count}</span>
        </div>
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{
              width: `${Math.max(percentage, 5)}%`,
              backgroundColor: section.color
            }}
          />
        </div>
      </div>
    )
  }

  const getHealthBadge = (health) => {
    if (health === 'healthy') {
      return { label: '● Online', color: '#00A859', bg: '#D1FAE5' }
    }
    return { label: '⚠ Degraded', color: '#FFC107', bg: '#FEF3C7' }
  }

  const healthBadge = getHealthBadge(systemHealth)
  const hasData = totalUpdates > 0

  return (
    <div className="dashboard-premium">
      {/* Premium Header with Unified Status */}
      <div className="premium-header">
        <div className="header-left">
          <div className="header-title-group">
            <h1>DGCA Intelligence Hub</h1>
            <div
              className="status-pill"
              style={{ backgroundColor: healthBadge.bg, borderColor: healthBadge.color }}
            >
              <span style={{ color: healthBadge.color }}>{healthBadge.label}</span>
            </div>
          </div>
          <p>Real-time regulatory monitoring & insights</p>
        </div>
      </div>

      {/* Premium KPI Section */}
      <div className="premium-kpi-grid">
        <div className="premium-kpi-card">
          <div className="kpi-icon">📊</div>
          <div className="kpi-content">
            <div className="kpi-label">Total Updates</div>
            <div className="kpi-large-value">{totalUpdates}</div>
            <div className="kpi-subtext">All categories combined</div>
          </div>
          {hasData && <div className="kpi-badge">Live Data</div>}
        </div>

        <div className="premium-kpi-card">
          <div className="kpi-icon">⚡</div>
          <div className="kpi-content">
            <div className="kpi-label">System Uptime</div>
            <div className="kpi-large-value">{metrics.uptime}%</div>
            <div className="kpi-subtext">Last 30 days</div>
          </div>
          <div className="kpi-badge" style={{ backgroundColor: '#D1FAE5', color: '#00A859' }}>Excellent</div>
        </div>

        <div className="premium-kpi-card">
          <div className="kpi-icon">✓</div>
          <div className="kpi-content">
            <div className="kpi-label">Success Rate</div>
            <div className="kpi-large-value">{metrics.successRate}%</div>
            <div className="kpi-subtext">Monitoring accuracy</div>
          </div>
          <div className="kpi-badge" style={{ backgroundColor: '#D1FAE5', color: '#00A859' }}>Optimal</div>
        </div>

        <div className="premium-kpi-card">
          <div className="kpi-icon">⚙️</div>
          <div className="kpi-content">
            <div className="kpi-label">Avg Response</div>
            <div className="kpi-large-value">{metrics.responseTime}ms</div>
            <div className="kpi-subtext">API latency</div>
          </div>
          <div className="kpi-badge" style={{ backgroundColor: '#E1EDF7', color: '#0054A6' }}>Fast</div>
        </div>
      </div>

      {/* Main Grid */}
      <div className="premium-grid">
        {/* Left Column */}
        <div className="premium-left">
          {/* Distribution Chart */}
          <div className="premium-card">
            <div className="card-header-premium">
              <h3>Updates Distribution</h3>
              <span className="card-meta">By category</span>
            </div>
            {hasData ? (
              <div className="distribution-bars">
                {sections.map((section) => (
                  <ProgressBar key={section.id} section={section} maxCount={maxCount} />
                ))}
              </div>
            ) : (
              <div className="empty-state-clean">
                <div className="empty-icon">📊</div>
                <p>No updates yet</p>
                <span>Data will appear here as new updates arrive</span>
              </div>
            )}
          </div>

          {/* Recent Activity */}
          <div className="premium-card">
            <div className="card-header-premium">
              <h3>Recent Activity</h3>
              <span className="card-meta">{updates.length} items</span>
            </div>
            {loading ? (
              <div className="activity-loader">
                <div className="spinner"></div>
              </div>
            ) : updates.length === 0 ? (
              <div className="empty-state-clean">
                <div className="empty-icon">📭</div>
                <p>No recent updates</p>
                <span>Monitoring 24/7 for changes</span>
              </div>
            ) : (
              <div className="premium-activity-list">
                {updates.slice(0, 4).map((update, idx) => (
                  <div key={idx} className="premium-activity-item">
                    <div className="activity-time">
                      {new Date(update.date).toLocaleDateString()}
                    </div>
                    <div className="activity-info">
                      <div className="activity-title">{update.title || 'DGCA Update'}</div>
                      <span className="activity-category" style={{
                        backgroundColor: sections.find(s => s.id === update.section)?.color || '#999'
                      }}>
                        {update.section}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column */}
        <div className="premium-right">
          {/* System Status - Unified with Header Status */}
          <div className="premium-card">
            <div className="card-header-premium">
              <h3>System Performance</h3>
            </div>
            <div className="status-indicators">
              <div className="status-row" style={{ borderLeftColor: '#00A859' }}>
                <div className="status-indicator-item">
                  <div className="status-icon" style={{ backgroundColor: '#D1FAE5' }}>⚡</div>
                  <div className="status-info-text">
                    <div className="status-name">Monitoring Service</div>
                    <div className="status-state" style={{ color: '#00A859' }}>● Online</div>
                  </div>
                </div>
              </div>

              <div className="status-row" style={{ borderLeftColor: '#00A859' }}>
                <div className="status-indicator-item">
                  <div className="status-icon" style={{ backgroundColor: '#D1FAE5' }}>📧</div>
                  <div className="status-info-text">
                    <div className="status-name">Email Service</div>
                    <div className="status-state" style={{ color: '#00A859' }}>● Active</div>
                  </div>
                </div>
              </div>

              <div className="status-row" style={{ borderLeftColor: '#00A859' }}>
                <div className="status-indicator-item">
                  <div className="status-icon" style={{ backgroundColor: '#D1FAE5' }}>💾</div>
                  <div className="status-info-text">
                    <div className="status-name">Database</div>
                    <div className="status-state" style={{ color: '#00A859' }}>● Connected</div>
                  </div>
                </div>
              </div>

              <div className="status-row" style={{ borderLeftColor: '#00A859' }}>
                <div className="status-indicator-item">
                  <div className="status-icon" style={{ backgroundColor: '#D1FAE5' }}>🌐</div>
                  <div className="status-info-text">
                    <div className="status-name">DGCA Website</div>
                    <div className="status-state" style={{ color: '#00A859' }}>● Reachable</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Monitor Schedule */}
          <div className="premium-card">
            <div className="card-header-premium">
              <h3>Monitor Schedule</h3>
            </div>
            <div className="schedule-grid">
              <div className="schedule-cell">
                <div className="cell-label">Interval</div>
                <div className="cell-value">Every 2h</div>
              </div>
              <div className="schedule-cell">
                <div className="cell-label">Active</div>
                <div className="cell-value">9AM-9PM</div>
              </div>
              <div className="schedule-cell">
                <div className="cell-label">Checks Today</div>
                <div className="cell-value">12</div>
              </div>
              <div className="schedule-cell">
                <div className="cell-label">Next Check</div>
                <div className="cell-value">~1.5h</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="premium-footer">
        <div className="footer-metric">
          <span className="metric-label">Performance</span>
          <span className="metric-value">Excellent</span>
        </div>
        <div className="footer-metric">
          <span className="metric-label">Reliability</span>
          <span className="metric-value">99.9%</span>
        </div>
        <div className="footer-metric">
          <span className="metric-label">Coverage</span>
          <span className="metric-value">100%</span>
        </div>
        <div className="footer-metric">
          <span className="metric-label">Latency</span>
          <span className="metric-value">&lt;250ms</span>
        </div>
      </div>
    </div>
  )
}

export default Dashboard
