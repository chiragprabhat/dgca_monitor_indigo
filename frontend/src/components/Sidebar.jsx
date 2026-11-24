import React from 'react'
import './Sidebar.css'
import NavIcon, { LogoMark } from './NavIcons'

function Sidebar({ activePage, onPageChange, isOpen }) {
  const menuItems = [
    {
      id: 'overview',
      label: 'Overview',
      description: 'Executive dashboard & KPIs'
    },
    {
      id: 'updates',
      label: 'DGCA Updates',
      description: 'Browse publications'
    },
    {
      id: 'search',
      label: 'Search Documents',
      description: 'Search inside every PDF'
    },
    {
      id: 'comparison',
      label: 'Document Comparison',
      description: 'Version comparison'
    },
    {
      id: 'impact',
      label: 'Impact & Actions',
      description: 'Review priorities'
    },
    {
      id: 'activity',
      label: 'Activity Log',
      description: 'System events'
    },
    {
      id: 'settings',
      label: 'Settings',
      description: 'Configuration'
    }
  ]

  return (
    <aside className={`sidebar ${isOpen ? 'open' : 'closed'}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <span className="logo-icon"><LogoMark /></span>
          <span className="logo-text">DGCA</span>
        </div>
        <div className="logo-subtitle">Regulatory Intelligence</div>
      </div>

      <nav className="sidebar-nav">
        {menuItems.map(item => (
          <button
            key={item.id}
            className={`nav-item ${activePage === item.id ? 'active' : ''}`}
            onClick={() => onPageChange(item.id)}
            title={item.description}
          >
            <span className="nav-icon"><NavIcon name={item.id} /></span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="footer-info">
          <small>DGCA What's New monitor</small>
          <small>v1.1.0</small>
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
