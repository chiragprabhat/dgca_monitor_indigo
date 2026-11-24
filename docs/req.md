# Requirements Document - DGCA Monitoring System

**Version**: 1.0  
**Date**: 2026-10-15  
**Status**: Approved  
**Author**: Claude Code  

---

## Executive Summary

The DGCA Monitoring System is a web-based application that automatically monitors the DGCA (Directorate General of Civil Aviation) website for updates across four key sections: Tenders, Regulations, Guidance, and Announcements. When new updates are detected, the system sends email notifications to configured recipients and displays them in a real-time dashboard.

---

## 1. Business Requirements

### 1.1 Project Goals

1. **Automate Monitoring**: Continuously monitor DGCA website without manual intervention
2. **Real-time Notifications**: Alert users immediately when new updates are found
3. **Centralized Dashboard**: Provide single-pane-of-glass view of all DGCA updates
4. **Improve Accessibility**: Make DGCA information easily accessible to end-users
5. **Ensure Reliability**: 99%+ uptime with automatic error handling

### 1.2 Stakeholders

| Stakeholder | Role | Expectations |
|-------------|------|--------------|
| Primary User | Monitor DGCA updates | Accurate, timely, easy-to-read updates |
| Email Recipient | Receive notifications | Formatted emails with PDF links |
| System Administrator | Manage deployment | Easy setup, monitoring, troubleshooting |
| Organization | Enterprise deployment | Scalability, security, compliance |

### 1.3 Success Criteria

- [ ] System monitors DGCA website successfully (first time)
- [ ] Detects new updates within 5 minutes of posting
- [ ] Sends email notifications within 30 seconds
- [ ] Dashboard displays all updates in real-time
- [ ] Zero data loss (persistent storage)
- [ ] 99%+ uptime (< 30 min downtime/month)
- [ ] Scalable to 1M+ updates
- [ ] Easy to deploy and maintain

---

## 2. Functional Requirements

### 2.1 Monitoring Module

#### FR-M1: Website Scraping
- **Description**: System shall scrape DGCA website automatically
- **Acceptance Criteria**:
  - Fetches website successfully (> 99%)
  - Extracts data from all 4 sections
  - Handles website changes gracefully
  - Retries up to 3 times on failure
  - Timeout after 30 seconds

#### FR-M2: Data Extraction
- **Description**: System shall extract structured data from updates
- **Required Fields**:
  - Update title (mandatory)
  - Publication date (mandatory)
  - Description/summary (optional)
  - PDF links (optional)
  - Section (mandatory)
- **Acceptance Criteria**:
  - All mandatory fields present
  - Accurate data extraction
  - No corrupted data in database

#### FR-M3: Duplicate Detection
- **Description**: System shall not send duplicate notifications
- **Acceptance Criteria**:
  - SHA256 hash-based comparison
  - Detects exact duplicates
  - Detects similar updates (same section + title)
  - Manual override capability (future)

#### FR-M4: Scheduled Monitoring
- **Description**: System shall monitor on a schedule
- **Acceptance Criteria**:
  - Runs every 2 hours (configurable)
  - Only between 9 AM - 9 PM IST (configurable)
  - Can be manually triggered anytime
  - Logs every monitoring cycle

### 2.2 Notification Module

#### FR-N1: Email Notifications
- **Description**: System shall send email for new updates
- **Acceptance Criteria**:
  - Uses Gmail SMTP
  - Sends within 30 seconds of detection
  - HTML formatted email
  - Includes PDF links
  - Retries 3 times on failure
  - Configurable recipient

#### FR-N2: Email Template
- **Description**: Email shall contain specific information
- **Content Requirements**:
  - Header with DGCA branding
  - Section badge (Tender/Regulation/etc)
  - Update title
  - Publication date
  - Short description
  - PDF download link(s)
  - Link to DGCA portal
  - Footer with company info
- **Acceptance Criteria**:
  - Renders correctly in all email clients
  - Mobile-responsive
  - Links are clickable and valid
  - No missing information

#### FR-N3: Notification History
- **Description**: System shall maintain notification delivery logs
- **Acceptance Criteria**:
  - Records all sent notifications
  - Tracks delivery status (sent/failed/bounced)
  - Stores failure reasons
  - Accessible via API

### 2.3 Dashboard Module

#### FR-D1: Dashboard Display
- **Description**: Dashboard shall display all DGCA updates
- **Acceptance Criteria**:
  - Shows 4 stat cards (one per section)
  - Displays update counts
  - Shows latest 10 updates
  - Updates in real-time
  - Mobile responsive

#### FR-D2: Section Views
- **Description**: Users can view updates by section
- **Acceptance Criteria**:
  - Filter updates by section
  - Paginated results (20 per page)
  - Sort by date (newest first)
  - PDF links are clickable
  - Description visible on click

#### FR-D3: Search & Filter
- **Description**: Users can search updates (future)
- **Acceptance Criteria**:
  - Search by keyword
  - Filter by date range
  - Filter by section
  - Filter by PDF availability

#### FR-D4: Settings View
- **Description**: Users can configure system
- **Acceptance Criteria**:
  - View current configuration
  - Manual monitoring trigger
  - Email connection test
  - View monitoring status
  - Modify notification preferences

### 2.4 API Module

#### FR-A1: REST API
- **Description**: System shall provide REST API for all operations
- **Endpoints Required**:
  - GET /api/updates
  - GET /api/sections
  - GET /api/monitor/status
  - POST /api/monitor/trigger
  - GET /api/notifications/history
- **Acceptance Criteria**:
  - All endpoints functional
  - Proper HTTP status codes
  - JSON response format
  - Error messages clear
  - Rate limiting enabled

#### FR-A2: Data Pagination
- **Description**: API shall support pagination for large datasets
- **Acceptance Criteria**:
  - Limit parameter (default: 20, max: 100)
  - Offset parameter for pagination
  - Total count in response
  - Consistent across endpoints

---

## 3. Non-Functional Requirements

### 3.1 Performance Requirements

| Requirement | Target | Notes |
|-------------|--------|-------|
| API Response Time | < 500ms | 95th percentile |
| Dashboard Load | < 2s | First contentful paint |
| Email Delivery | < 30s | From detection to sent |
| Scraping Cycle | < 2 min | End-to-end monitoring |
| Database Query | < 100ms | 99th percentile |

### 3.2 Reliability Requirements

| Requirement | Target | Notes |
|-------------|--------|-------|
| System Uptime | 99.5% | Max 30 min/month downtime |
| Scraper Success Rate | 99% | Handles website errors |
| Email Delivery Success | 99% | Account for transient failures |
| Data Persistence | 100% | No data loss |
| Error Recovery | Automatic | Self-healing mechanisms |

### 3.3 Scalability Requirements

| Requirement | Capacity | Notes |
|-------------|----------|-------|
| Updates/Month | 1M+ | From single server to distributed |
| Concurrent Users | 10K+ | With load balancing |
| Database Size | 10GB+ | With archival strategies |
| Email Volume | 100K/month | Via multiple providers |

### 3.4 Security Requirements

#### FR-S1: Authentication (Future)
- API key authentication for protected endpoints
- JWT token support
- Role-based access control (Admin/User)

#### FR-S2: Encryption
- TLS/SSL for all communications
- Encrypted credentials in .env
- Password hashing (future)

#### FR-S3: Access Control
- CORS limited to frontend origin
- Rate limiting (100 req/min per IP)
- Input validation on all endpoints
- SQL injection prevention

#### FR-S4: Compliance
- GDPR data privacy (if applicable)
- Regular security audits
- Penetration testing (annual)
- Vulnerability scanning

### 3.5 Usability Requirements

#### FR-U1: User Interface
- Intuitive navigation
- Clear labeling
- Consistent styling
- Mobile responsive
- Accessible (WCAG AA minimum)

#### FR-U2: Documentation
- Setup guide (15 min to first update)
- API documentation
- Troubleshooting guide
- Architecture documentation

### 3.6 Maintainability Requirements

#### FR-M1: Code Quality
- Modular design
- Clear separation of concerns
- Comprehensive logging
- Error handling on all paths
- Code comments for complex logic

#### FR-M2: Testing
- Unit tests for services (>80% coverage)
- Integration tests for API endpoints
- E2E tests for dashboard
- Automated testing on commit

#### FR-M3: Monitoring
- System health checks
- Performance metrics
- Error alerting
- Uptime monitoring

---

## 4. User Stories

### Story 1: Monitor DGCA Updates
**As a** aviation professional  
**I want to** automatically receive DGCA updates  
**So that** I stay informed about regulations without manual checking  

**Acceptance Criteria**:
- System monitors every 2 hours
- Email sent for each new update
- Dashboard shows all updates
- No duplicate notifications

**Estimated Story Points**: 13

---

### Story 2: View Updates in Dashboard
**As a** user  
**I want to** see all DGCA updates in one place  
**So that** I can quickly review what's new  

**Acceptance Criteria**:
- Dashboard shows stat cards with counts
- Latest updates displayed
- Can filter by section
- Mobile-responsive design

**Estimated Story Points**: 8

---

### Story 3: Search for Specific Updates
**As a** user  
**I want to** search for specific DGCA updates  
**So that** I can find relevant information quickly  

**Acceptance Criteria**:
- Search by keyword
- Filter by date range
- Filter by section
- Results are accurate

**Estimated Story Points**: 5 (Future)

---

### Story 4: Configure Notifications
**As an** administrator  
**I want to** configure notification settings  
**So that** updates go to the right place  

**Acceptance Criteria**:
- Change recipient email
- Change monitoring schedule
- Change active hours
- Test email configuration

**Estimated Story Points**: 3

---

### Story 5: Monitor System Health
**As an** administrator  
**I want to** see system health and monitoring status  
**So that** I can ensure it's working correctly  

**Acceptance Criteria**:
- View last monitoring run results
- See next scheduled run
- View error logs
- Manual trigger capability

**Estimated Story Points**: 5

---

## 5. Data Requirements

### 5.1 Data Model

```
Updates
├── id (UUID) - Primary Key
├── section (enum) - Tenders, Regulation, Guidance, Announcements
├── title (string, required) - Update title
├── description (text) - Optional description
├── publication_date (datetime) - When published
├── pdf_urls (json array) - Links to PDFs
├── is_notified (boolean) - Email sent?
├── detected_at (datetime) - When system found it
└── hash (string, unique) - For duplicate detection
```

### 5.2 Data Retention

| Data Type | Retention | Rationale |
|-----------|-----------|-----------|
| Updates | 2 years | Historical reference |
| Notifications | 1 year | Audit trail |
| Logs | 30 days | Troubleshooting |
| Database Backup | Ongoing | Disaster recovery |

### 5.3 Data Volume Estimates

- **Initial**: ~1000 updates
- **Year 1**: ~5000 updates
- **Year 3**: ~15000 updates
- **Database Size**: ~50MB (with logs)

---

## 6. Integration Requirements

### 6.1 External Systems

#### DGCA Website
- **URL**: https://www.dgca.gov.in/digigov-portal/
- **Protocol**: HTTP(S)
- **Authentication**: None (public website)
- **Rate Limiting**: Respect robots.txt
- **Fallback**: Cache recent HTML

#### Gmail SMTP
- **Service**: Gmail
- **Authentication**: OAuth2 (App Password)
- **Protocol**: TLS
- **Rate Limit**: 1000 emails/hour
- **Fallback**: Queue messages, retry later

### 6.2 Future Integrations

- Slack notifications
- SMS notifications
- Telegram bot
- RSS feed generation
- API for external systems

---

## 7. Constraints

### 7.1 Technical Constraints

- **Language**: JavaScript (Node.js + React)
- **Database**: SQLite (or PostgreSQL for scale)
- **Email**: Gmail SMTP (configurable)
- **Hosting**: Self-hosted or cloud (AWS/Heroku)
- **Browser**: Chrome, Firefox, Safari, Edge (latest 2 versions)

### 7.2 Operational Constraints

- **Monitoring Hours**: 9 AM - 9 PM IST (configurable)
- **Check Interval**: 2 hours (configurable)
- **Email Recipient**: Single or multiple (configurable)
- **Deployment**: Linux-based servers
- **Team Size**: 1-5 person team

### 7.3 Regulatory Constraints

- **Data Privacy**: GDPR compliant (if applicable)
- **Email**: CAN-SPAM compliance
- **Accessibility**: WCAG AA minimum
- **Security**: TLS encryption required

---

## 8. Acceptance Criteria Summary

### Must Have (MVP)

- [ ] Scrape DGCA website every 2 hours
- [ ] Detect new updates reliably
- [ ] Send email notifications to configured address
- [ ] Display updates in dashboard
- [ ] Database persistence
- [ ] Error handling & logging
- [ ] Mobile-responsive UI
- [ ] Complete documentation

### Should Have (v1.0)

- [ ] Settings panel for configuration
- [ ] Manual monitoring trigger
- [ ] Email connection testing
- [ ] Monitoring status display
- [ ] API documentation
- [ ] Production deployment guide

### Could Have (Future)

- [ ] Multiple email recipients
- [ ] Slack/SMS notifications
- [ ] Full-text search
- [ ] Advanced filtering
- [ ] Data export (CSV/PDF)
- [ ] User authentication
- [ ] Admin dashboard

### Won't Have (Out of Scope)

- [ ] Web scraping for other websites
- [ ] Financial transactions
- [ ] Multi-tenant support
- [ ] Mobile native apps (web app instead)
- [ ] Machine learning/AI analysis

---

## 9. Testing Requirements

### 9.1 Unit Testing

- **Coverage**: > 80%
- **Framework**: Jest
- **Services**: Monitor, Notification, State
- **Utilities**: Parsers, Helpers

### 9.2 Integration Testing

- **Database**: SQLite operations
- **API**: All REST endpoints
- **Email**: Nodemailer integration
- **Scraper**: HTML parsing

### 9.3 E2E Testing

- **Dashboard**: Component rendering
- **Section View**: Filtering and pagination
- **API Flow**: End-to-end monitoring cycle
- **Error Scenarios**: Failure handling

### 9.4 Performance Testing

- **Load Testing**: 1000 concurrent users
- **Stress Testing**: Database under load
- **Endurance Testing**: 24-hour run
- **Spike Testing**: Sudden traffic increases

---

## 10. Deployment Requirements

### 10.1 Deployment Environments

| Environment | Purpose | Infrastructure |
|-------------|---------|-----------------|
| Development | Local testing | Laptop/Desktop |
| Staging | Pre-production | Single server |
| Production | Live system | Load-balanced cluster |

### 10.2 Deployment Checklist

- [ ] Node.js 16+ installed
- [ ] Dependencies installed
- [ ] .env configured
- [ ] Database initialized
- [ ] HTTPS/SSL enabled
- [ ] Email configured & tested
- [ ] Logging enabled
- [ ] Backups configured
- [ ] Monitoring set up
- [ ] Documentation reviewed

---

## 11. Maintenance & Support

### 11.1 Support Levels

| Level | Response Time | Resolution Time |
|-------|---------------|-----------------|
| Critical | 1 hour | 4 hours |
| High | 4 hours | 24 hours |
| Medium | 1 day | 1 week |
| Low | 3 days | 2 weeks |

### 11.2 Maintenance Windows

- **Weekly**: Log rotation, cache clearing
- **Monthly**: Database optimization, dependency updates
- **Quarterly**: Security patches, feature releases
- **Annual**: Major version upgrades, compliance audit

### 11.3 Change Management

- All changes in Git with commit messages
- Testing before production deployment
- Rollback capability for each release
- Communications to stakeholders

---

## 12. Success Metrics

### KPIs (Key Performance Indicators)

| Metric | Target | Measurement |
|--------|--------|-------------|
| System Availability | 99.5% | Monthly uptime report |
| Average Response Time | < 500ms | APM tool tracking |
| Email Delivery Rate | 99% | SMTP server logs |
| Update Detection Accuracy | 100% | Manual spot checks |
| User Satisfaction | 4.5/5 | Quarterly surveys |
| Mean Time to Recovery | < 15 min | Incident logs |

---

**Document Version**: 1.0  
**Last Reviewed**: 2026-10-15  
**Next Review**: 2026-12-15  
**Approved By**: Project Owner
