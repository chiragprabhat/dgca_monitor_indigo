# Design Document - DGCA Monitoring System

## 1. System Architecture Design

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Layer                              │
│              (Web Browser - Dashboard)                       │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP(S)
┌──────────────────────▼──────────────────────────────────────┐
│                   Frontend Layer                             │
│           React SPA (Vite + Tailwind CSS)                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Components: Dashboard, SectionView, Header, Settings │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │ REST API (JSON)
┌──────────────────────▼──────────────────────────────────────┐
│                   API Gateway Layer                          │
│          Express.js REST Endpoints (port 5000)              │
│  /api/updates, /api/sections, /api/monitor, etc.           │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   ┌────────┐    ┌─────────┐    ┌──────────┐
   │Services│    │ Database │    │Scheduler │
   └────────┘    └─────────┘    └──────────┘
        │              │              │
        ├──────────────┼──────────────┤
        │
   ┌────▼──────────────────────────────────┐
   │     Business Logic Layer              │
   │  - Monitor Service (Orchestration)    │
   │  - Notification Service (Email)       │
   │  - State Service (Data Mgmt)          │
   │  - Scheduler Service (Timing)         │
   └────────────────────────────────────────┘
        │
   ┌────▼──────────────────────────────────┐
   │   Data Access & Scraping Layer        │
   │  - DGCA Scraper (Cheerio)             │
   │  - SQLite Database                    │
   │  - Email Provider (Gmail/Other)       │
   └────────────────────────────────────────┘
        │
   ┌────▼──────────────────────────────────┐
   │   External Services                   │
   │  - DGCA Website                       │
   │  - Gmail SMTP Server                  │
   │  - (Future: SMS, Slack, etc.)        │
   └────────────────────────────────────────┘
```

### 1.2 Component Relationships

```
Frontend (React)
    ├─ Header (Navigation)
    ├─ Dashboard (Stats & Feed)
    ├─ SectionView (Detailed)
    └─ Settings (Configuration)
         │
         └─ REST API Calls
              │
              └─ Backend (Express)
                   ├─ /api/updates
                   ├─ /api/sections
                   ├─ /api/monitor
                   └─ /api/notifications
                        │
                        └─ Services Layer
                             ├─ Monitor Service
                             │   └─ Scraper
                             ├─ Notification Service
                             │   └─ Email Provider
                             ├─ State Service
                             │   └─ SQLite
                             └─ Scheduler Service
                                 └─ node-cron
```

---

## 2. User Interface Design

### 2.1 Design System

**Theme**: GoIndigo-Inspired Aviation Theme

```
Primary Color:     #003580 (Deep Blue - Trust, Professionalism)
Secondary Color:   #005fb5 (Bright Blue - Action)
Accent Color:      #FF6F00 (Orange - Alerts, Highlights)
Success Color:     #4caf50 (Green - Positive)
Warning Color:     #ff9800 (Amber - Caution)
Error Color:       #f44336 (Red - Failures)
Background:        #f8f9fa (Light Gray)
Surface:           #ffffff (White - Cards)
```

### 2.2 Layout Structure

```
┌─────────────────────────────────────────────────┐
│  Header (Sticky)                                │
│  Logo | Navigation | Notification Bell          │
├─────────────────────────────────────────────────┤
│                                                 │
│  Main Content Area                              │
│  ┌─────────────────────────────────────────┐  │
│  │ Dashboard / Sections / Settings View    │  │
│  └─────────────────────────────────────────┘  │
│                                                 │
│  Footer (Optional)                              │
├─────────────────────────────────────────────────┤
```

### 2.3 Component Specifications

#### Header Component
- **Fixed Position**: Sticky at top
- **Content**: 
  - Logo + Title (left)
  - Navigation Tabs (center)
  - Notification Bell + Settings (right)
- **Responsive**: Hamburger menu on mobile

#### Dashboard View
- **Grid Layout**: 4 stat cards (responsive)
- **Stat Cards**:
  - Icon (emoji)
  - Section name
  - Update count
  - Hover effect → Click to view section
- **Latest Updates Section**:
  - List of 10 most recent updates
  - Title, date, description
  - PDF links

#### Section View
- **Header**: Section name + back button
- **Grid**: Update cards (responsive)
- **Pagination**: Load more at bottom
- **Update Card**:
  - Title
  - Publication date
  - Description excerpt
  - PDF download links

#### Settings View
- **Email Configuration**: Display current recipient
- **Manual Controls**:
  - Trigger monitoring now button
  - Test email connection button
- **Status Display**:
  - Is scheduler running?
  - Recent monitoring runs
  - Last update time

---

## 3. Data Design

### 3.1 Data Models

#### Update Entity
```javascript
{
  id: UUID,                           // Unique identifier
  section: 'tenders|regulation|guidance|announcements',
  title: string,                      // Update title
  description: string,                // Short description
  publicationDate: ISO8601,           // When published
  pdfUrls: string[],                  // PDF links
  sourcePageUrl: URL,                 // DGCA portal URL
  detectedAt: ISO8601,                // When system found it
  updatedAt: ISO8601,                 // Last updated
  isNotified: boolean,                // Email sent?
  notifiedAt: ISO8601,                // When notified
  hash: SHA256                        // For duplicate detection
}
```

#### Notification Entity
```javascript
{
  id: number,                         // Auto-increment
  updateId: UUID,                     // Foreign key
  recipientEmail: string,             // Recipient
  sentAt: ISO8601,                    // Sent timestamp
  status: 'sent|failed|bounced',      // Delivery status
  errorMessage: string,               // If failed
  retryCount: number                  // Retry attempts
}
```

#### Monitoring Log Entity
```javascript
{
  id: number,                         // Auto-increment
  runAt: ISO8601,                     // Execution time
  status: 'success|partial|failed',   // Result
  itemsFound: number,                 // Total items found
  itemsNew: number,                   // New items
  durationMs: number,                 // Execution time
  errorMessage: string,               // If failed
  nextScheduledRun: ISO8601           // When next run
}
```

### 3.2 Database Schema

```sql
-- Updates Table
CREATE TABLE updates (
  id TEXT PRIMARY KEY,
  section VARCHAR(50) NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  publication_date DATETIME,
  pdf_urls JSON,
  source_page_url TEXT,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_notified INTEGER DEFAULT 0,
  notified_at DATETIME,
  hash TEXT UNIQUE,
  INDEX idx_section (section),
  INDEX idx_is_notified (is_notified),
  INDEX idx_detected_at (detected_at DESC)
);

-- Notifications Table
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id TEXT,
  recipient_email TEXT,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20),
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  FOREIGN KEY (update_id) REFERENCES updates(id),
  INDEX idx_status (status),
  INDEX idx_sent_at (sent_at DESC)
);

-- Monitoring Logs Table
CREATE TABLE monitoring_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20),
  items_found INTEGER,
  items_new INTEGER,
  duration_ms INTEGER,
  error_message TEXT,
  next_run DATETIME,
  INDEX idx_run_at (run_at DESC),
  INDEX idx_status (status)
);

-- Configuration Table
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);
```

---

## 4. API Design

### 4.1 REST Endpoints

#### Updates Endpoints
```
GET /api/updates
  Query: ?limit=20&offset=0&section=tenders&dateFrom=2026-10-01&dateTo=2026-10-31
  Response: { data: [], total: 100, limit: 20, offset: 0 }

GET /api/updates/:id
  Response: { id, section, title, description, ... }

POST /api/updates
  (Admin only) Create update manually
  
DELETE /api/updates/:id
  (Admin only) Delete update
```

#### Sections Endpoints
```
GET /api/sections
  Response: [
    { id: 'tenders', name: 'Tenders', count: 25, lastUpdated: ISO8601 },
    ...
  ]

GET /api/sections/:section
  Query: ?limit=20&offset=0
  Response: { section: 'Tenders', data: [], total: 25, ... }
```

#### Monitoring Endpoints
```
POST /api/monitor/trigger
  Response: { success: true, itemsFound: 10, itemsNew: 2, duration: 5234 }

GET /api/monitor/status
  Response: { 
    running: true, 
    nextRun: ISO8601,
    recentRuns: [{status, itemsFound, itemsNew, runAt}, ...]
  }

GET /api/monitor/test-email
  Response: { success: true, message: 'Email connection verified' }

GET /api/monitor/logs?limit=20
  Response: { logs: [], total: 100 }
```

#### Notifications Endpoints
```
GET /api/notifications/history?limit=20
  Response: { 
    data: [{ id, updateId, recipientEmail, sentAt, status }, ...],
    total: 500
  }

GET /api/notifications/stats
  Response: { 
    totalSent: 500,
    totalFailed: 2,
    successRate: 99.6,
    avgDeliveryTime: 1234
  }
```

#### Health & Status
```
GET /api/health
  Response: { status: 'ok', uptime: 3600, timestamp: ISO8601 }

GET /api/stats
  Response: { 
    totalUpdates: 1000,
    totalNotifications: 950,
    avgResponseTime: 123,
    lastScrape: ISO8601,
    databaseSize: '5MB'
  }
```

### 4.2 Response Format

**Success Response**:
```json
{
  "data": { ... },
  "success": true,
  "timestamp": "2026-10-15T10:30:00Z",
  "message": "Operation successful"
}
```

**Error Response**:
```json
{
  "error": "Email configuration missing",
  "success": false,
  "timestamp": "2026-10-15T10:30:00Z",
  "code": "CONFIG_ERROR",
  "details": { ... }
}
```

---

## 5. Email Design

### 5.1 Email Template Structure

```
┌──────────────────────────────────┐
│        Header Section            │
│  - DGCA Logo                      │
│  - Title: "DGCA Update"           │
│  - Section Badge                 │
├──────────────────────────────────┤
│       Content Section            │
│  - Update Title (h2)             │
│  - Publication Date              │
│  - Description (paragraph)       │
│  - [PDF Download Link]           │
├──────────────────────────────────┤
│      Action Section              │
│  - View on DGCA Portal button    │
│  - Mark as Read link             │
├──────────────────────────────────┤
│      Footer Section              │
│  - Unsubscribe link              │
│  - Preferences link              │
│  - Company info                  │
└──────────────────────────────────┘
```

### 5.2 Email Styling

- **Font Family**: System fonts (Segoe UI, Helvetica, Arial)
- **Colors**: Match UI theme (Blue #003580, Orange #FF6F00)
- **Layout**: Responsive for mobile
- **Images**: Inline SVG for logos
- **Links**: Clear CTA buttons with hover states

---

## 6. Scalability Design

### 6.1 Current Architecture (Single Server)

```
Single Node.js Server
├─ Express API
├─ Scraper (sequential)
├─ Email (queue of 1)
└─ SQLite DB
```

**Capacity**: ~1000 updates/month, 1 concurrent user

### 6.2 Medium Scale (Horizontal)

```
Load Balancer (Nginx)
├─ API Server 1
├─ API Server 2
├─ API Server 3
├─ Message Queue (Redis)
├─ Database (PostgreSQL)
└─ Email Service (SendGrid)
```

**Capacity**: ~100K updates/month, 1000 concurrent users

### 6.3 Large Scale (Distributed)

```
CDN (CloudFlare)
├─ Load Balancer (AWS ALB)
├─ API Servers (Autoscaled)
├─ Scraper Workers (Parallel)
├─ Message Queue (RabbitMQ)
├─ Database (PostgreSQL + Replica)
├─ Cache (Redis Cluster)
└─ Email Service (AWS SES)
```

**Capacity**: ~1M updates/month, 100K concurrent users

---

## 7. Security Design

### 7.1 Authentication & Authorization

```
┌─────────────────────────────────┐
│     Public Endpoints (GET)       │
│  /api/updates, /api/sections    │
│  No authentication required      │
└─────────────────────────────────┘
         ↓ (Future: Add Auth)
┌─────────────────────────────────┐
│  Protected Endpoints (POST/DEL)  │
│  /api/monitor/trigger           │
│  /api/updates (create/delete)   │
│  Requires API Key or JWT         │
└─────────────────────────────────┘
```

### 7.2 Data Security

- **Credentials**: Environment variables (.env in .gitignore)
- **Passwords**: Never logged or displayed
- **Emails**: Encrypted in transit (TLS)
- **Database**: WAL mode + backups
- **Inputs**: Validated & sanitized

### 7.3 Infrastructure Security

- **HTTPS/TLS**: Required in production
- **CORS**: Limited to frontend origin
- **Rate Limiting**: 100 req/min per IP
- **Headers**: Security headers (X-Frame-Options, CSP, etc.)
- **Logging**: No sensitive data in logs

---

## 8. Performance Design

### 8.1 Response Times (Targets)

- **API responses**: < 500ms
- **Dashboard load**: < 2 seconds
- **Section load**: < 1 second
- **Email delivery**: < 30 seconds
- **Scraping cycle**: < 2 minutes

### 8.2 Caching Strategy

```
Frontend
├─ Browser cache (3600s for static assets)
├─ Service Worker (offline support)
└─ In-memory cache (updates list)

Backend
├─ SQLite WAL cache (in-memory queries)
├─ HTML scrape cache (1 hour)
└─ Redis cache (optional, for scale)
```

### 8.3 Database Optimization

- Indexes on: section, is_notified, detected_at
- Query optimization with EXPLAIN PLAN
- Periodic VACUUM to reclaim space
- Connection pooling (for scale)

---

## 9. Monitoring & Observability

### 9.1 Logging

```
Levels: ERROR > WARN > INFO > DEBUG

Files:
├─ application.log (all events)
├─ scraper.log (scraping details)
├─ notifications.log (email logs)
└─ performance.log (timing metrics)
```

### 9.2 Metrics to Track

- Scraper success rate (target: 99%)
- Email delivery success (target: 99.5%)
- API response times (target: < 500ms)
- Database query times (target: < 100ms)
- Monitoring cycle time (target: < 2 min)
- Uptime percentage (target: 99.9%)

### 9.3 Alerting

- Scraper fails 3 consecutive times → Alert
- Email delivery fails 10+ times → Alert
- API errors > 5% → Alert
- Database size > 80% → Alert
- Server load > 80% → Alert

---

## 10. Continuous Improvement

See [CONTINUOUS_IMPROVEMENT.md](CONTINUOUS_IMPROVEMENT.md) for detail on:
- Weekly reviews
- Monthly optimization
- Quarterly major updates
- User feedback integration
- Performance monitoring
- Security patches

---

**Design Version**: 1.0  
**Last Updated**: 2026-10-15  
**Status**: Complete & Production-Ready
