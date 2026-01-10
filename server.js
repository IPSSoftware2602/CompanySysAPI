require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
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
app.use('/uploads', express.static('uploads'));

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
