import React, { useState } from 'react'
import { formatDate } from './Priority'

// Search box + list, so a document can be found among hundreds (e.g. type "CAR 66" or "2019").
function DocPicker({ id, docs, value, onChange, label }) {
  const [query, setQuery] = useState('')
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = docs.filter(u => {
    if (u.id === value) return true
    const hay = `${u.title} ${u.section} ${u.publication_date} ${formatDate(u.publication_date)}`.toLowerCase()
    return terms.every(t => hay.includes(t))
  })
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '6px' }}>
      <input
        id={`${id}-search`}
        type="search"
        placeholder={`Search ${docs.length} publications (title, category or year)...`}
        value={query}
        onChange={e => setQuery(e.target.value)}
        style={{ padding: '8px', width: '100%', boxSizing: 'border-box' }}
      />
      <select id={id} value={value} onChange={e => onChange(e.target.value)} style={{ padding: '8px', width: '100%', boxSizing: 'border-box' }}>
        <option value="">{query ? `${matches.length} matching - choose one...` : 'Choose a stored publication...'}</option>
        {[...matches.filter(u => u.id === value), ...matches.filter(u => u.id !== value).slice(0, 300)].map(u => <option key={u.id} value={u.id}>{label(u)}{u.origin === 'archive' ? ' (archive)' : ''}</option>)}
      </select>
    </div>
  )
}

export default DocPicker
