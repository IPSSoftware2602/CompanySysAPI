const ActivityLog = require('../models/activityLogModel');

exports.getTicketLogs = async (req, res) => {
    try {
        const logs = await ActivityLog.getByTicket(req.params.ticketId);
        // Format logs for easy reading
        const formatted = logs.map(log => ({
            ...log,
            message: ActivityLog.formatLogMessage(log)
        }));
        res.json(formatted);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch activity logs' });
    }
};
