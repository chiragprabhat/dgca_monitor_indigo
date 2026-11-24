# Architecture Document - DGCA Monitoring System

## Table of Contents
1. [System Architecture](#system-architecture)
2. [Module Breakdown](#module-breakdown)
3. [Data Flow](#data-flow)
4. [Communication Patterns](#communication-patterns)
5. [Deployment Architecture](#deployment-architecture)
6. [Technology Stack](#technology-stack)

---

## System Architecture

### Layered Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      PRESENTATION LAYER                          │
│                    (React Frontend - Port 5173)                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Components: Header, Dashboard, SectionView, Settings        │ │
│  │ State: React Context API                                    │ │
│  │ Styling: CSS3 with GoIndigo Theme                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────────────┘
                   │ REST API (HTTP/JSON)
┌──────────────────▼──────────────────────────────────────────────┐
│                   API/APPLICATION LAYER                         │
│              (Express.js Server - Port 5000)                    │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Routes:                                                      │ │
│  │  ├─ /api/updates (GET/POST)                                │ │
│  │  ├─ /api/sections (GET)                                    │ │
│  │  ├─ /api/monitor (GET/POST)                                │ │
│  │  ├─ /api/notifications (GET)                               │ │
│  │  └─ /api/health (GET)                                      │ │
│  └─────────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Middleware:                                                  │ │
│  │  ├─ CORS (Cross-Origin Resource Sharing)                   │ │
│  │  ├─ Error Handler (Global Exception)                       │ │
│  │  ├─ Request Logger                                          │ │
│  │  └─ Rate Limiter (100 req/min)                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────────┐
│                   BUSINESS LOGIC LAYER                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Monitor Service (Orchestration)                          │  │
│  │  ├─ Orchestrates scraper                                │  │
│  │  ├─ Detects new items                                   │  │
│  │  ├─ Triggers notifications                              │  │
│  │  └─ Logs monitoring cycles                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Notification Service                                     │  │
│  │  ├─ Formats email content                                │  │
│  │  ├─ Sends via SMTP (Gmail)                              │  │
│  │  ├─ Handles retries                                      │  │
│  │  └─ Logs delivery status                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ State Service (Data Management)                          │  │
│  │  ├─ Saves/retrieves updates                              │  │
│  │  ├─ Duplicate detection                                  │  │
│  │  ├─ Marks notifications sent                             │  │
│  │  └─ Queries by section/date                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Scheduler Service                                        │  │
│  │  ├─ Manages node-cron jobs                               │  │
│  │  ├─ Respects time windows                                │  │
│  │  ├─ Handles retries                                      │  │
│  │  └─ Logs execution                                       │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────┬──────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────────┐
│                   DATA ACCESS LAYER                             │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ DGCA Scraper                                             │  │
│  │  ├─ Axios HTTP client (with retries)                     │  │
│  │  ├─ Cheerio HTML parser                                  │  │
│  │  ├─ Section-specific parsers                             │  │
│  │  └─ PDF link validator                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Database Layer (SQLite)                                  │  │
│  │  ├─ Updates table                                        │  │
│  │  ├─ Notifications table                                  │  │
│  │  ├─ Monitoring logs table                                │  │
│  │  └─ Config table                                         │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Email Provider (Nodemailer)                              │  │
│  │  ├─ Gmail SMTP configuration                             │  │
│  │  ├─ Email template rendering                             │  │
│  │  └─ Delivery tracking                                    │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────┬──────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────────┐
│                  EXTERNAL SERVICES LAYER                        │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐  │
│  │  DGCA Website│      │ Gmail SMTP   │      │ Future:Slack │  │
│  │ (Public Web) │      │  (Email)     │      │   (Chat)     │  │
│  └──────────────┘      └──────────────┘      └──────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Module Breakdown

### 1. Frontend Module

**Location**: `frontend/src/`

```
Frontend/
├── components/
│   ├── Header.jsx                (Navigation)
│   ├── Dashboard.jsx             (Main View)
│   └── SectionView.jsx           (Detail View)
├── services/
│   └── api-client.js             (Axios instance)
├── hooks/
│   ├── useFetchUpdates.js        (Data fetching)
│   └── usePolling.js             (Auto-refresh)
├── context/
│   ├── UpdatesContext.js         (State management)
│   └── ThemeContext.js           (Light/dark mode)
└── styles/
    ├── index.css                 (Global)
    └── [component].css           (Component-specific)
```

**Responsibilities**:
- Render UI components
- Fetch data from API
- Display updates in real-time
- Handle user interactions
- Manage local state

**Key Technologies**:
- React 18
- Vite (build tool)
- CSS3 (styling)

---

### 2. Backend Module

#### 2.1 Server Core

**Location**: `backend/src/index.js`

```javascript
Responsibilities:
├─ Initialize Express app
├─ Setup CORS & middleware
├─ Mount API routes
├─ Initialize database
├─ Start scheduler
└─ Handle errors globally
```

#### 2.2 Configuration Module

**Location**: `backend/src/config/`

```
config/
├── database.js
│   ├─ SQLite initialization
│   ├─ Schema creation
│   └─ Connection pooling
└── email.js (optional future)
    ├─ Multiple provider support
    └─ Fallback strategies
```

#### 2.3 Services Module

**Location**: `backend/src/services/`

```
services/
├── monitor-service.js
│   ├─ Orchestrates monitoring cycle
│   ├─ Calls scraper → detector → notifier
│   └─ Error handling & logging
│
├── notification-service.js
│   ├─ Email template rendering
│   ├─ SMTP configuration
│   ├─ Retry logic
│   └─ Delivery tracking
│
├── state-service.js
│   ├─ Database CRUD operations
│   ├─ Duplicate detection (SHA256)
│   ├─ Query builders
│   └─ Statistics aggregation
│
└── scheduler-service.js
    ├─ node-cron integration
    ├─ Time window validation
    ├─ Job execution
    └─ Error notifications
```

#### 2.4 Scraper Module

**Location**: `backend/src/scrapers/`

```
scrapers/
├── dgca-scraper.js
│   ├─ HTTP client (Axios)
│   ├─ HTML parser (Cheerio)
│   ├─ Section extractors
│   └─ Retry mechanism
│
└── parsers/ (future)
    ├─ tenders-parser.js
    ├─ regulation-parser.js
    ├─ guidance-parser.js
    └─ announcements-parser.js
```

#### 2.5 Routes Module

**Location**: `backend/src/routes/`

```
routes/
├── updates.js
│   ├─ GET /api/updates (list)
│   ├─ GET /api/updates/:id (detail)
│   └─ POST /api/updates (admin)
│
├── sections.js
│   ├─ GET /api/sections (all)
│   └─ GET /api/sections/:section (filtered)
│
├── monitor.js
│   ├─ POST /api/monitor/trigger (manual)
│   ├─ GET /api/monitor/status (info)
│   └─ GET /api/monitor/test-email (test)
│
└── notifications.js
    └─ GET /api/notifications/history
```

#### 2.6 Utilities Module

**Location**: `backend/src/utils/`

```
utils/
├── logger.js
│   ├─ Console logging
│   ├─ File logging
│   ├─ Log rotation
│   └─ Level filtering
│
├── retry-handler.js (future)
│   ├─ Exponential backoff
│   └─ Circuit breaker
│
└── date-parser.js (future)
    └─ Multiple date format handling
```

---

## Data Flow

### 1. Monitoring Cycle Flow

```
┌─────────────────────────────────────┐
│     Scheduler Trigger               │
│  (Every 2 hours, 9 AM - 9 PM)      │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Monitor Service Start              │
│  (Starts timing, logs event)         │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│     DGCA Scraper                     │
│  1. Fetch DGCA website (Axios)       │
│  2. Parse HTML (Cheerio)             │
│  3. Extract data per section         │
│  4. Retry on failure (3x)            │
│  Result: Array of items              │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│    State Service (Detector)          │
│  1. For each item:                   │
│     a. Generate hash(section+title)  │
│     b. Check if exists in DB         │
│     c. Mark NEW if not found         │
│  Result: Separate new/old items      │
└──────────────┬──────────────────────┘
               │
         ┌─────┴──────────────┐
         │                    │
    ┌────▼─────┐      ┌──────▼──────┐
    │ NEW Items│      │ Old Items    │
    │  (Save)  │      │  (Ignore)    │
    └────┬─────┘      └─────────────┘
         │
┌────────▼──────────────────────────┐
│  Notification Service              │
│  1. Create email HTML              │
│  2. Send via Gmail SMTP            │
│  3. Log delivery                   │
│  4. Mark as notified in DB         │
│  5. Retry if failed                │
└────────┬───────────────────────────┘
         │
┌────────▼───────────────────────────┐
│  Logging & Completion              │
│  - Log monitoring_logs table        │
│  - Record duration                  │
│  - Set next run time                │
└────────────────────────────────────┘
```

### 2. Dashboard Update Flow

```
┌──────────────────────────────┐
│   User Opens Dashboard       │
│   (Browser loads page)       │
└─────────────┬────────────────┘
              │ React renders
┌─────────────▼────────────────┐
│  Frontend Mounts Components   │
└─────────────┬────────────────┘
              │ useEffect hook
┌─────────────▼────────────────┐
│  Call /api/sections          │
│  (Get section counts)        │
└─────────────┬────────────────┘
              │ Axios HTTP GET
┌─────────────▼────────────────┐
│  Backend Routes Handler       │
│  (sections.js)               │
└─────────────┬────────────────┘
              │ Query DB
┌─────────────▼────────────────┐
│  SQLite Execute Query         │
│  SELECT COUNT(*) per section  │
└─────────────┬────────────────┘
              │ JSON response
┌─────────────▼────────────────┐
│  Frontend Updates State       │
│  (React Context)             │
└─────────────┬────────────────┘
              │ Re-render
┌─────────────▼────────────────┐
│  Display Stat Cards           │
│  (User sees counts)           │
└──────────────────────────────┘
```

---

## Communication Patterns

### 1. Synchronous (Request-Response)

```
Frontend                Backend
    │                      │
    ├─ HTTP GET /api/updates
    │                      │
    │                  Query DB
    │                      │
    │     ◄─ JSON response  │
    │                      │
Display data                │
```

**Used for**:
- Dashboard data fetching
- Section queries
- Status checks

**Advantages**:
- Simple & familiar
- Built-in browser support
- Easy debugging

---

### 2. Asynchronous (Scheduled)

```
Scheduler              Backend              External
    │                      │                   │
    ├─ Trigger every 2 hrs │                   │
    │                      │                   │
    │              Monitor Service starts      │
    │                      │                   │
    │                      ├─ Scrape DGCA ───► DGCA Website
    │                      │                   │
    │                      │ ◄─ HTML response──┤
    │                      │                   │
    │                      ├─ Send email ─────► Gmail SMTP
    │                      │                   │
    │                      │ ◄─ ACK ───────────┤
    │                      │                   │
    │              Logging complete            │
    │                      │                   │
```

**Used for**:
- Monitoring cycles
- Email sending
- Logging

**Advantages**:
- Non-blocking
- Batch processing
- Better scalability

---

## Deployment Architecture

### Single Server Deployment

```
┌─────────────────────────────────────────┐
│           Single Server (Linux)         │
│                                         │
│  ┌─────────────────────────────────┐  │
│  │  Nginx (Reverse Proxy)          │  │
│  │  ├─ Port 80/443                 │  │
│  │  └─ Route to Node.js (5000)     │  │
│  └─────────────────────────────────┘  │
│                                         │
│  ┌─────────────────────────────────┐  │
│  │  Node.js Process (PM2)          │  │
│  │  ├─ Express Server (5000)       │  │
│  │  ├─ Services                    │  │
│  │  └─ Scheduler                   │  │
│  └─────────────────────────────────┘  │
│                                         │
│  ┌─────────────────────────────────┐  │
│  │  SQLite Database                │  │
│  │  ├─ updates table               │  │
│  │  ├─ notifications table         │  │
│  │  └─ logs table                  │  │
│  └─────────────────────────────────┘  │
│                                         │
│  ┌─────────────────────────────────┐  │
│  │  File System                    │  │
│  │  ├─ /data/ (DB file)            │  │
│  │  └─ /logs/ (Log files)          │  │
│  └─────────────────────────────────┘  │
│                                         │
└─────────────────────────────────────────┘
```

### Containerized Deployment

```
┌──────────────────────────────────────┐
│     Docker Host                      │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  dgca-backend (Container)      │ │
│  │  ├─ Node.js runtime            │ │
│  │  ├─ Express server             │ │
│  │  └─ Services                   │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  dgca-frontend (Container)     │ │
│  │  ├─ Nginx                      │ │
│  │  └─ React SPA                  │ │
│  └────────────────────────────────┘ │
│                                      │
│  ┌────────────────────────────────┐ │
│  │  dgca-db (Volume)              │ │
│  │  └─ SQLite database            │ │
│  └────────────────────────────────┘ │
│                                      │
└──────────────────────────────────────┘
```

---

## Technology Stack

### Frontend Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **UI Framework** | React 18 | Component-based UI |
| **Build Tool** | Vite | Fast bundling |
| **Styling** | CSS3 | Responsive design |
| **State** | Context API | Global state |
| **HTTP Client** | Axios | REST API calls |
| **Package Manager** | npm | Dependency management |

### Backend Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Node.js 18+ | JavaScript execution |
| **Framework** | Express.js | HTTP server |
| **Web Scraping** | Axios + Cheerio | HTML parsing |
| **Database** | SQLite | Data persistence |
| **Notifications** | Nodemailer | Email sending |
| **Scheduling** | node-cron | Job scheduling |
| **Logging** | Winston | Structured logging |
| **Package Manager** | npm | Dependency management |

### DevOps Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Process Manager** | PM2 | Keep app running |
| **Web Server** | Nginx | Reverse proxy |
| **SSL** | Let's Encrypt | HTTPS certificates |
| **Containerization** | Docker | Deployment |
| **Container Orchestration** | Docker Compose | Multi-container setup |
| **CI/CD** | GitHub Actions | Automated testing |

---

**Architecture Version**: 1.0  
**Last Updated**: 2026-10-15  
**Status**: Approved for Production
