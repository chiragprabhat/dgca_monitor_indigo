# Flow Documentation - DGCA Monitoring System

Comprehensive workflows and data flows for all system operations.

---

## Table of Contents

1. [Monitoring Cycle Flow](#monitoring-cycle-flow)
2. [Email Notification Flow](#email-notification-flow)
3. [Dashboard Update Flow](#dashboard-update-flow)
4. [User Interaction Flows](#user-interaction-flows)
5. [Error Handling Flows](#error-handling-flows)
6. [Data Flow Diagrams](#data-flow-diagrams)

---

## Monitoring Cycle Flow

### Overview Flowchart

```
START: Scheduler Trigger
  │
  ├─► Check if within active hours (9 AM - 9 PM IST)
  │   ├─ NO → Wait until next interval
  │   └─ YES → Continue
  │
  ├─► Initialize Monitor Service
  │   ├─ Start timer
  │   ├─ Log cycle start
  │   └─ Check if already monitoring
  │
  ├─► SCRAPE: Fetch DGCA Website
  │   ├─ Attempt 1: Fetch HTML
  │   ├─ Parse with Cheerio
  │   ├─ Extract data from 4 sections
  │   │   ├─ Tenders
  │   │   ├─ Regulation
  │   │   ├─ Guidance
  │   │   └─ Announcements
  │   ├─ Build items array
  │   └─ On failure:
  │       ├─ Attempt 2 (wait 2s)
  │       ├─ Attempt 3 (wait 4s)
  │       └─ On final failure: Log error, use cached data
  │
  ├─► DETECT: Find New Items
  │   ├─ For each scraped item:
  │   │   ├─ Generate SHA256 hash
  │   │   ├─ Query DB for hash
  │   │   ├─ If found: Mark as OLD
  │   │   └─ If not found: Mark as NEW
  │   ├─ Separate: new_items[], old_items[]
  │   └─ Log: "Found X items, Y new"
  │
  ├─► SAVE: Store New Items
  │   ├─ For each new_item:
  │   │   ├─ Create item object
  │   │   ├─ Insert into DB
  │   │   ├─ On duplicate: Skip (silent)
  │   │   └─ Log: "Saved item: {title}"
  │   └─ Commit transaction
  │
  ├─► NOTIFY: Send Emails
  │   ├─ For each new_item:
  │   │   ├─ Get recipient from .env
  │   │   ├─ Create email content
  │   │   ├─ Send via Gmail SMTP
  │   │   ├─ On success:
  │   │   │   ├─ Mark is_notified = 1
  │   │   │   ├─ Set notified_at timestamp
  │   │   │   ├─ Log: "Email sent"
  │   │   │   └─ Record in notifications table
  │   │   └─ On failure:
  │   │       ├─ Retry 2 more times
  │   │       ├─ Log: "Email failed: {reason}"
  │   │       └─ Record error in DB
  │   └─ Email summary
  │
  ├─► LOG: Record Monitoring Results
  │   ├─ Insert into monitoring_logs:
  │   │   ├─ run_at: NOW
  │   │   ├─ status: "success" | "partial" | "failed"
  │   │   ├─ items_found: count
  │   │   ├─ items_new: count
  │   │   ├─ duration_ms: elapsed time
  │   │   └─ error_message: null (if success)
  │   └─ Display results
  │
  └─► END: Return to scheduler
      └─ Next monitoring in 2 hours
```

### Detailed Scraper Logic

```
SCRAPER_FUNCTION(dgcaUrl):
  │
  ├─► RETRY_LOOP (max_attempts = 3):
  │   │
  │   ├─ Attempt N:
  │   │   ├─ Set timeout: 30 seconds
  │   │   ├─ Fetch page: axios.get(dgcaUrl)
  │   │   ├─ Parse HTML: cheerio.load(html)
  │   │   ├─ FOR each section in [tenders, regulation, guidance, announcements]:
  │   │   │   ├─ Find section selector
  │   │   │   ├─ FOR each item in section:
  │   │   │   │   ├─ Extract title
  │   │   │   │   ├─ Extract date
  │   │   │   │   ├─ Extract description
  │   │   │   │   ├─ Extract PDF URLs
  │   │   │   │   └─ Create item object
  │   │   │   └─ Add to items array
  │   │   ├─ Validate items (all have title, section, date)
  │   │   └─ Return items on success
  │   │
  │   └─ On timeout/error:
  │       ├─ Log error
  │       ├─ Wait (2^attempt seconds)
  │       └─ Continue to next attempt
  │
  └─ Return: items[] or empty[] on failure
```

### State Service Logic

```
DETECT_NEW_ITEMS(scraped_items):
  │
  ├─► Initialize: new_items = [], old_items = []
  │
  ├─► FOR each item in scraped_items:
  │   │
  │   ├─ Generate hash:
  │   │   └─ hash = SHA256(section + "|" + title + "|" + date)
  │   │
  │   ├─ Query DB:
  │   │   └─ existing = DB.query("SELECT * FROM updates WHERE hash = ?", hash)
  │   │
  │   ├─ IF existing.length > 0:
  │   │   └─ old_items.push(item)  // Already in DB
  │   │
  │   └─ ELSE:
  │       ├─ Save to DB:
  │       │   ├─ INSERT INTO updates VALUES (...)
  │       │   ├─ Set is_notified = 0
  │       │   └─ Set detected_at = NOW
  │       └─ new_items.push(item)  // Ready to notify
  │
  └─► Return: { new_items, old_items }
```

---

## Email Notification Flow

### Email Generation & Sending

```
SEND_NOTIFICATION(update):
  │
  ├─► Validate Input:
  │   ├─ update.title (required)
  │   ├─ update.section (required)
  │   └─ update.pdfUrls (optional)
  │
  ├─► Get Configuration:
  │   ├─ recipient = process.env.EMAIL_RECIPIENT
  │   ├─ sender = process.env.EMAIL_FROM
  │   └─ IF not configured: return { success: false, error: "CONFIG_ERROR" }
  │
  ├─► Generate Email Content:
  │   ├─ Create HTML template:
  │   │   ├─ Header section (logo + title)
  │   │   ├─ Section badge (colored)
  │   │   ├─ Update title (large font)
  │   │   ├─ Publication date
  │   │   ├─ Description (if available)
  │   │   ├─ PDF links (if available)
  │   │   ├─ Action buttons
  │   │   └─ Footer
  │   └─ subject = "DGCA Update: [SECTION] - [TITLE]"
  │
  ├─► Configure Nodemailer:
  │   ├─ transport = {
  │   │   service: 'gmail',
  │   │   auth: {
  │   │     user: EMAIL_FROM,
  │   │     pass: EMAIL_APP_PASSWORD
  │   │   }
  │   │ }
  │   └─ connection pool (max 5 concurrent)
  │
  ├─► RETRY_LOOP (max_attempts = 3):
  │   │
  │   ├─ Attempt N:
  │   │   ├─ Send email: nodemailer.sendMail({...})
  │   │   ├─ On success:
  │   │   │   ├─ messageId = response.messageId
  │   │   │   ├─ Log success
  │   │   │   ├─ Update DB: is_notified = 1, notified_at = NOW
  │   │   │   ├─ Record in notifications table
  │   │   │   └─ Return { success: true, messageId }
  │   │   └─ On error:
  │   │       ├─ Log error
  │   │       ├─ IF attempt < max_attempts:
  │   │       │   └─ Wait and retry
  │   │       └─ ELSE:
  │   │           ├─ Record failure in DB
  │   │           └─ Return { success: false, error }
  │   │
  │   └─ Continue if transient error
  │
  └─► Return result
```

### Email Template Structure

```
HTML Email Structure:

┌────────────────────────────────────────────┐
│ <email>                                    │
│  <head>                                    │
│    <style>                                 │
│      Colors, fonts, responsive layout     │
│    </style>                                │
│  </head>                                   │
│  <body>                                    │
│    ┌──────────────────────────────────┐   │
│    │ HEADER                            │   │
│    │ - DGCA Logo/Title                │   │
│    │ - Section Badge (colored)        │   │
│    └──────────────────────────────────┘   │
│    ┌──────────────────────────────────┐   │
│    │ CONTENT                           │   │
│    │ - Update Title (h2)              │   │
│    │ - Publication Date               │   │
│    │ - Description (paragraph)        │   │
│    │ - PDF Download Link(s)           │   │
│    └──────────────────────────────────┘   │
│    ┌──────────────────────────────────┐   │
│    │ FOOTER                            │   │
│    │ - Unsubscribe Link               │   │
│    │ - Company Info                   │   │
│    │ - Timestamp                      │   │
│    └──────────────────────────────────┘   │
│  </body>                                   │
│</email>                                    │
└────────────────────────────────────────────┘
```

---

## Dashboard Update Flow

### Frontend → Backend Flow

```
USER OPENS DASHBOARD:
  │
  ├─► Browser loads http://localhost:5173
  │
  ├─► React App Mounts:
  │   ├─ Load index.jsx
  │   ├─ Render App.jsx
  │   └─ Render Header + Dashboard
  │
  ├─► useEffect Hook Runs:
  │   ├─ On component mount
  │   └─ Call fetchStats()
  │
  ├─► API Call #1: GET /api/sections
  │   │
  │   ├─ Axios.get('http://localhost:5000/api/sections')
  │   │
  │   ├─ Backend receives:
  │   │   ├─ Route handler: sections.js
  │   │   ├─ Query DB: SELECT COUNT(*) per section
  │   │   └─ Return JSON: { data: [{section, count}, ...] }
  │   │
  │   └─ Frontend receives:
  │       ├─ Parse JSON
  │       ├─ Update React state
  │       └─ Re-render stat cards
  │
  ├─► API Call #2: GET /api/updates?limit=10
  │   │
  │   ├─ Axios.get('...?limit=10')
  │   │
  │   ├─ Backend receives:
  │   │   ├─ Parse query params
  │   │   ├─ SELECT * FROM updates LIMIT 10
  │   │   └─ Return JSON: { data: [...], total: X }
  │   │
  │   └─ Frontend receives:
  │       ├─ Parse JSON
  │       ├─ Update state
  │       └─ Re-render updates feed
  │
  ├─► Display Dashboard:
  │   ├─ Render stat cards with counts
  │   ├─ Render updates list
  │   ├─ Apply GoIndigo styling
  │   └─ Show to user
  │
  ├─► Auto-Refresh (every 5 minutes):
  │   ├─ useEffect with interval
  │   ├─ Repeat API calls
  │   └─ Update display if changed
  │
  └─► User Interaction:
      ├─ Click stat card → Navigate to SectionView
      ├─ Click PDF link → Download file
      ├─ Click "Settings" → Show SettingsView
      └─ Click "Refresh" → Manual API call
```

### Component Rendering Flow

```
App.jsx
  │
  ├─ Header.jsx
  │   ├─ Logo + Title
  │   ├─ Navigation tabs
  │   └─ Notification bell
  │
  ├─ activeTab = "dashboard"?
  │   │
  │   └─ Dashboard.jsx
  │       ├─ StatCard x4
  │       │   ├─ Icon
  │       │   ├─ Section name
  │       │   ├─ Count (from API)
  │       │   └─ Hover animation
  │       │
  │       └─ UpdatesFeed.jsx
  │           ├─ For each update:
  │           │   ├─ UpdateItem
  │           │   │   ├─ Title
  │           │   │   ├─ Date
  │           │   │   ├─ Description
  │           │   │   └─ PDF link
  │           │   └─ 10 items total
  │           │
  │           └─ Loading spinner (if fetching)
  │
  ├─ activeTab = "section"?
  │   │
  │   └─ SectionView.jsx
  │       ├─ Back button
  │       ├─ Section title
  │       ├─ UpdateCard x20 (paginated)
  │       ├─ Pagination controls
  │       └─ PDF download links
  │
  └─ activeTab = "settings"?
      │
      └─ Settings.jsx
          ├─ Email configuration
          ├─ Manual trigger button
          ├─ Test email button
          ├─ Monitoring status
          └─ Recent runs log
```

---

## User Interaction Flows

### Manual Monitoring Trigger

```
USER CLICKS "Trigger Check Now" BUTTON:
  │
  ├─► Frontend sends POST request:
  │   └─ POST /api/monitor/trigger
  │
  ├─► Backend receives request:
  │   ├─ Check if already monitoring
  │   ├─ IF YES: Return { success: false, error: "Already running" }
  │   └─ IF NO: Call checkForUpdates()
  │
  ├─► Monitoring executes:
  │   ├─ Same as Monitoring Cycle Flow
  │   ├─ Scrape → Detect → Save → Notify → Log
  │   └─ Return results
  │
  ├─► Frontend receives response:
  │   ├─ Parse JSON: { success, itemsFound, itemsNew, duration }
  │   ├─ Show toast notification: "Check complete!"
  │   ├─ Update stats immediately
  │   └─ Refresh updates feed
  │
  └─► User sees results instantly
```

### Email Test Flow

```
USER CLICKS "Test Email Connection" BUTTON:
  │
  ├─► Frontend sends GET request:
  │   └─ GET /api/monitor/test-email
  │
  ├─► Backend receives request:
  │   ├─ Initialize Nodemailer
  │   ├─ Call transporter.verify()
  │   ├─ ON SUCCESS:
  │   │   └─ Return { success: true, message: "Connected" }
  │   └─ ON FAILURE:
  │       └─ Return { success: false, error: "Connection failed" }
  │
  ├─► Frontend receives response:
  │   ├─ IF success: Show green checkmark + "Email is configured"
  │   └─ IF failure: Show red error + reason
  │
  └─► User knows if email is working
```

### View Section Updates

```
USER CLICKS ON "TENDERS" STAT CARD:
  │
  ├─► React state change:
  │   ├─ activeTab = "section"
  │   ├─ selectedSection = "tenders"
  │   └─ Re-render App.jsx
  │
  ├─► SectionView component mounts:
  │   ├─ useEffect hook runs
  │   └─ API call: GET /api/sections/tenders?limit=20&offset=0
  │
  ├─► Backend processes:
  │   ├─ Parse section parameter
  │   ├─ Query DB: SELECT * FROM updates WHERE section='tenders' LIMIT 20
  │   └─ Return JSON with updates array
  │
  ├─► Frontend receives:
  │   ├─ Display section header
  │   ├─ Render update cards grid
  │   ├─ Show pagination controls
  │   └─ Apply GoIndigo styling
  │
  ├─► User interaction on this view:
  │   ├─ Click PDF link → Download file
  │   ├─ Click "Next" → Load next 20 items (offset += 20)
  │   └─ Click "Back" → Return to Dashboard
  │
  └─► Pagination flow on "Next":
      ├─ API call: GET /api/sections/tenders?limit=20&offset=20
      ├─ Fetch next batch
      ├─ Append/replace results
      └─ Scroll to top
```

---

## Error Handling Flows

### Scraper Error Handling

```
SCRAPER ENCOUNTERS ERROR:
  │
  ├─► Error Type 1: Timeout (> 30 seconds)
  │   ├─ Catch in fetchWithRetry()
  │   ├─ Log: "Scraper timeout on attempt X"
  │   ├─ IF attempts < max:
  │   │   ├─ Wait 2^attempt seconds
  │   │   └─ Retry
  │   └─ ELSE:
  │       ├─ Return: { success: false, error: "Timeout" }
  │       └─ Use cached HTML (if available)
  │
  ├─► Error Type 2: Connection Error
  │   ├─ Catch: axios error
  │   ├─ Log: "Failed to connect to DGCA"
  │   ├─ Retry with exponential backoff
  │   └─ After max attempts: Use cache
  │
  ├─► Error Type 3: HTML Parse Error
  │   ├─ Catch: cheerio error
  │   ├─ Log: "Failed to parse HTML"
  │   ├─ Try fallback selectors
  │   └─ If all fail: Return empty array
  │
  ├─► Error Type 4: Selector Not Found
  │   ├─ Gracefully handle missing elements
  │   ├─ Try multiple selector patterns
  │   ├─ Skip unavailable sections
  │   └─ Log: "Section selector not found: tenders"
  │
  └─► Impact:
      ├─ Monitoring cycle: Mark as "partial" status
      ├─ Database: Don't save incomplete data
      ├─ Notification: Alert admin after 3 failures
      └─ Next cycle: Retry normally
```

### Email Error Handling

```
EMAIL SEND FAILS:
  │
  ├─► Error Type 1: Gmail Authentication Failed
  │   ├─ Check: Email password correct?
  │   ├─ Check: Gmail 2FA enabled?
  │   ├─ Check: App password used (not regular password)?
  │   └─ Solution: Update .env and restart
  │
  ├─► Error Type 2: SMTP Connection Failed
  │   ├─ Transient error → Retry (exponential backoff)
  │   ├─ Permanent error → Log and alert
  │   └─ Solution: Check internet connection
  │
  ├─► Error Type 3: Invalid Recipient Email
  │   ├─ Check: EMAIL_RECIPIENT configured?
  │   ├─ Check: Email format valid?
  │   └─ Solution: Fix .env file
  │
  ├─► Retry Strategy:
  │   ├─ Attempt 1: Immediate
  │   ├─ Attempt 2: Wait 2 seconds
  │   ├─ Attempt 3: Wait 4 seconds
  │   └─ After 3 failures: Mark as failed, log, alert
  │
  └─► Logging:
      ├─ Log to: logs/application.log
      ├─ Log to: DB notifications table
      └─ Alert: Admin notification (future)
```

### Database Error Handling

```
DATABASE OPERATION FAILS:
  │
  ├─► Error Type 1: Connection Lost
  │   ├─ Catch: sqlite3 error
  │   ├─ Retry: Up to 3 times
  │   └─ Fallback: In-memory cache
  │
  ├─► Error Type 2: Disk Full
  │   ├─ Alert: Email admin
  │   ├─ Stop: Accepting new data
  │   └─ Action: Archive old records
  │
  ├─► Error Type 3: Corrupt Database
  │   ├─ Log: Error details
  │   ├─ Action: Restore from backup
  │   └─ Alert: Admin notification
  │
  └─► Prevention:
      ├─ Regular backups (daily)
      ├─ Database integrity checks (weekly)
      └─ Space monitoring (ongoing)
```

### API Error Handling

```
API ENDPOINT ERRORS:
  │
  ├─► Error Type 1: Missing Query Parameters
  │   ├─ Validate: limit, offset, section
  │   ├─ Set defaults: limit=20, offset=0
  │   └─ Return: Valid response or 400 Bad Request
  │
  ├─► Error Type 2: Invalid Section Name
  │   ├─ Validate: section in [tenders, regulation, guidance, announcements]
  │   └─ Return: 404 Not Found
  │
  ├─► Error Type 3: Database Query Error
  │   ├─ Catch: SQL error
  │   ├─ Log: Error details
  │   └─ Return: 500 Internal Server Error
  │
  ├─► Response Format (Error):
  │   ├─ {
  │   ├─   error: "Error message",
  │   ├─   success: false,
  │   ├─   timestamp: ISO8601,
  │   ├─   code: "ERROR_CODE"
  │   ├─ }
  │   └─ HTTP Status: 400/404/500
  │
  └─► Logging:
      └─ All errors logged to application.log
```

---

## Data Flow Diagrams

### Complete System Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                     User Interactions                             │
│  (Browser: Dashboard, Section View, Settings)                    │
└──────────────────┬───────────────────────────────────────────────┘
                   │
            HTTP JSON Requests
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│                   Express API Server                              │
│  ├─ Route: GET /api/updates                                      │
│  ├─ Route: GET /api/sections/:section                            │
│  ├─ Route: POST /api/monitor/trigger                             │
│  └─ Route: GET /api/notifications/history                        │
└──────────────────┬───────────────────────────────────────────────┘
                   │
         SQL Queries & Responses
                   │
┌──────────────────▼───────────────────────────────────────────────┐
│                  SQLite Database                                  │
│  ├─ Table: updates (new items found)                             │
│  ├─ Table: notifications (email history)                         │
│  ├─ Table: monitoring_logs (cycle results)                       │
│  └─ Table: config (settings)                                     │
└──────────────────┬───────────────────────────────────────────────┘
                   │
        ┌──────────┼──────────┐
        │          │          │
   ┌────▼────┐ ┌──▼─────┐ ┌──▼──────┐
   │ Scraper  │ │ Email  │ │ Service │
   │ Service  │ │Service │ │ Service │
   └────┬─────┘ └───┬────┘ └──┬──────┘
        │           │         │
   ┌────▼─────────┐ │     ┌───▼──────┐
   │ HTTP fetch   │ │     │ Monitor  │
   │ DGCA website │ │     │ Logging  │
   └──────────────┘ │     └──────────┘
                    │
            ┌───────▼────────┐
            │  Gmail SMTP    │
            │  (Email send)  │
            └────────────────┘
```

### Request-Response Cycle

```
User Action (Frontend)
    │
    ▼
React State Change / useEffect hook
    │
    ▼
Axios HTTP Request
    │
    ├─ GET /api/updates
    ├─ GET /api/sections
    ├─ POST /api/monitor/trigger
    └─ GET /api/notifications/history
    │
    ▼
Express Route Handler (Backend)
    │
    ├─ Parse URL params
    ├─ Validate input
    ├─ Query database
    └─ Build response JSON
    │
    ▼
SQLite Query Execution
    │
    ├─ SELECT * FROM updates ...
    ├─ COUNT(*) per section
    ├─ ORDER BY date DESC
    └─ LIMIT/OFFSET pagination
    │
    ▼
JSON Response
    │
    ├─ { success: true, data: [...], total: X }
    └─ HTTP 200 OK
    │
    ▼
Frontend Receives Response
    │
    ├─ Parse JSON
    ├─ Update React State
    └─ Trigger re-render
    │
    ▼
React Components Re-render
    │
    ├─ Dashboard component
    ├─ Stat cards
    └─ Updates feed
    │
    ▼
User Sees Updated Display
```

---

**Flow Documentation Version**: 1.0  
**Last Updated**: 2026-10-15  
**Status**: Complete
