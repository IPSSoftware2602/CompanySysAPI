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

app.use(cors());
app.use(express.json());

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
