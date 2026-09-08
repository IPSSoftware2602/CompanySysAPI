require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware

// Rate limiting buckets by client IP. Behind a reverse proxy (nginx, cPanel,
// Cloudflare) every request arrives from the proxy's address, so without this
// the whole team shares one bucket and a single attacker locks everyone out.
//
// Defaults to OFF because the opposite mistake is worse: trusting
// X-Forwarded-For when there is no proxy lets any client forge its own IP and
// bypass the limit entirely. Production is behind a proxy — set TRUST_PROXY to
// the number of proxy hops (usually 1).
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

/**
 * CORS was previously wide open — any site the team visited could call this API
 * with their browser's credentials. Locked to the app's own origins.
 *
 * Production is https://task.ips.com.my. Local Vite dev servers are included so
 * developers are not forced to edit this file; add more via CORS_ORIGINS
 * (comma-separated) rather than reopening it.
 */
const DEFAULT_ORIGINS = [
    'https://task.ips.com.my',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
];
const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .concat(DEFAULT_ORIGINS);

app.use(cors({
    origin(origin, cb) {
        // No Origin header: curl, server-to-server, same-origin navigation and
        // the /uploads links. Not a browser cross-origin request, so allow it —
        // CORS is not what protects those; authentication is.
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) return cb(null, true);

        // Refuse by withholding the header rather than throwing. Throwing
        // surfaces as a 500 and buries real faults in the logs; without the
        // header the browser blocks the response either way, and the preflight
        // for our Authorization header fails, so no authenticated cross-origin
        // call can complete.
        console.warn(`[cors] blocked origin: ${origin}`);
        cb(null, false);
    },
    credentials: true,
}));

// The IRIS receiver verifies an HMAC over the exact bytes it was sent, so the
// raw body has to survive parsing. Scoped to that one path — holding a Buffer
// for every upload in the app would be a memory cost for nothing.
app.use(express.json({
    verify: (req, res, buf) => {
        if (req.originalUrl.startsWith('/api/integration/iris')) req.rawBody = buf;
    },
}));

// Routes
const ticketRoutes = require('./routes/ticketRoutes');
const projectRoutes = require('./routes/projectRoutes');
const authRoutes = require('./routes/authRoutes');
const commentRoutes = require('./routes/commentRoutes');
const labelRoutes = require('./routes/labelRoutes');

app.use('/api/tickets', ticketRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/labels', labelRoutes);
app.use('/api/lists', require('./routes/listRoutes'));
app.use('/api/checklists', require('./routes/checklistRoutes'));
app.use('/api/users', require('./routes/userRoutes'));
app.use('/api/checklist-templates', require('./routes/checklistTemplateRoutes'));
app.use('/api/activity-logs', require('./routes/activityLogRoutes'));
app.use('/api/support-tickets', require('./routes/supportTicketRoutes'));
app.use('/api/supporting-projects', require('./routes/supportingProjectRoutes'));
app.use('/api/credits', require('./routes/creditRoutes'));
app.use('/api/upload', require('./routes/uploadRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/my-work', require('./routes/myWorkRoutes'));
app.use('/api/audit-logs', require('./routes/auditLogRoutes'));
app.use('/api/time-logs', require('./routes/timeLogRoutes'));
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
// Machine-facing contract for the AI workflow. Versioned and kept apart from
// the routes above, which serve the React app and may change freely.
app.use('/api/integration/v1', require('./routes/integrationRoutes'));

// IRIS (the AI that answers customers on WhatsApp) posts escalations here.
// Signature-authenticated, not API-key authenticated — see the controller.
app.use('/api/integration/iris', require('./routes/irisRoutes'));
// Human-facing views onto that integration — user JWT, not API keys.
app.use('/api/integration-admin', require('./routes/integrationAdminRoutes'));

// Managing the credentials those integrations authenticate with. JWT-gated, so
// an API key can never mint another API key.
app.use('/api/api-clients', require('./routes/apiKeyRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
// Attachments are served as downloads, never rendered inline. Combined with the
// extension allowlist in uploadRoutes, this is the second layer stopping an
// uploaded file from executing as script on our own origin — which, with the
// JWT in the browser, would be session theft. nosniff stops the browser
// second-guessing the declared type.
app.use('/uploads', express.static('uploads', {
    setHeaders: (res) => {
        res.setHeader('Content-Disposition', 'attachment');
        res.setHeader('X-Content-Type-Options', 'nosniff');
    },
}));

app.get('/', (req, res) => {
  res.json({ message: 'IOS Backend System is running', timestamp: new Date() });
});

app.get('/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.json({ status: 'ok', db_time: result.rows[0].now });
  } catch (err) {
    console.error('Database connection error', err);
    res.status(500).json({ status: 'error', message: 'Database connection failed' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
