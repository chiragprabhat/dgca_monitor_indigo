import React, { useState, useEffect } from 'react'
import './SectionView.css'

function SectionView({ section, onBack }) {
  const [updates, setUpdates] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const limit = 20

  useEffect(() => {
    fetchUpdates()
  }, [section, page])

  const fetchUpdates = async () => {
    try {
      const offset = page * limit
      const res = await fetch(
        `http://localhost:5000/api/sections/${section}?limit=${limit}&offset=${offset}`
      )
      const data = await res.json()
      setUpdates(data.data)
    } catch (error) {
      console.error('Error fetching section updates:', error)
    } finally {
      setLoading(false)
    }
  }

  const getSectionName = (id) => {
    const names = {
      tenders: 'Tenders',
      regulation: 'Regulation',
      guidance: 'Guidance',
      announcements: 'Announcements'
    }
    return names[id] || id
  }

  const getSectionIcon = (id) => {
    const icons = {
      tenders: '🎯',
      regulation: '📋',
      guidance: '📖',
      announcements: '📢'
    }
    return icons[id] || '📄'
  }

  return (
    <div className="section-view">
      <div className="section-header-bar">
        <button className="back-btn" onClick={onBack}>← Back</button>
        <h1>{getSectionIcon(section)} {getSectionName(section)}</h1>
      </div>

      {loading ? (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading updates...</p>
        </div>
      ) : updates.length === 0 ? (
        <div className="empty">
          <p>No updates in this section yet.</p>
        </div>
      ) : (
        <>
          <div className="updates-grid">
            {updates.map(update => (
              <div key={update.id} className="update-card">
                <div className="update-header">
                  <h3>{update.title}</h3>
                  <time>{new Date(update.publication_date).toLocaleDateString('en-IN')}</time>
                </div>

                {update.description && (
                  <p className="update-description">{update.description}</p>
                )}

                <div className="update-footer">
                  {update.pdf_urls && update.pdf_urls.length > 0 && (
                    <div className="pdf-links">
                      {update.pdf_urls.map((url, i) => (
                        <a
                          key={i}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="pdf-btn"
                        >
                          📄 PDF {i + 1}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="pagination">
            <button
              onClick={() => setPage(p => p - 1)}
              disabled={page === 0}
              className="pagination-btn"
            >
              ← Previous
            </button>
            <span className="page-info">Page {page + 1}</span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={updates.length < limit}
              className="pagination-btn"
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default SectionView
