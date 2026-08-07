const WorkTimeLog = require('../models/workTimeLogModel');
const TimeLogService = require('../services/timeLogService');
const AuditService = require('../services/auditService');
const db = require('../db');
const { MANAGER_ROLES, AUDIT_ACTION, AUDIT_ENTITY } = require('../constants');

// Only these may lock a billing period. Deliberately narrower than
// MANAGER_ROLES: a lock is what makes numbers final for invoicing.
const LOCK_ROLES = ['ADMIN', 'CEO'];

const isManager = (user) => MANAGER_ROLES.includes(user.role);

/** POST /api/time-logs */
exports.create = async (req, res) => {
    try {
        const {
            ticket_id, support_ticket_id, minutes, logged_for_date,
            is_billable, note, user_id,
        } = req.body;

        // Logging time for someone else is a manager action — otherwise anyone
        // could inflate a colleague's billable hours.
        let targetUserId = req.user.id;
        if (user_id && user_id !== req.user.id) {
            if (!isManager(req.user)) {
                return res.status(403).json({ error: "You can only log time against your own work" });
            }
            targetUserId = user_id;
        }

        const errors = TimeLogService.validate({ minutes, logged_for_date, ticket_id, support_ticket_id });
        if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

        const entry = await WorkTimeLog.create({
            ticket_id, support_ticket_id, user_id: targetUserId,
            minutes: Number(minutes), logged_for_date, is_billable, note,
        });

        await AuditService.record(req, {
            action: AUDIT_ACTION.CREATE,
            entity_type: AUDIT_ENTITY.TIME_LOG,
            entity_id: entry.id,
            after_data: { minutes: entry.minutes, logged_for_date: entry.logged_for_date, user_id: targetUserId },
        });

        res.status(201).json(await WorkTimeLog.getById(entry.id));
    } catch (err) {
        console.error('Create time log error:', err);
        res.status(500).json({ error: 'Failed to log time', details: err.message });
    }
};

/** GET /api/time-logs */
exports.list = async (req, res) => {
    try {
        const { projectId, clientName, from, to, status, ticketId, supportTicketId } = req.query;

        // Non-managers only ever see their own time.
        let userId = req.query.userId;
        if (!isManager(req.user)) {
            userId = req.user.id;
        }

        const entries = await WorkTimeLog.list({
            userId, projectId, clientName, from, to, status, ticketId, supportTicketId,
            billableOnly: req.query.billableOnly === 'true',
        });

        const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);
        res.json({
            count: entries.length,
            total_minutes: totalMinutes,
            total_hours: TimeLogService.toHours(totalMinutes),
            entries,
        });
    } catch (err) {
        console.error('List time logs error:', err);
        res.status(500).json({ error: 'Failed to list time logs', details: err.message });
    }
};

/** PATCH /api/time-logs/:id */
exports.update = async (req, res) => {
    try {
        const entry = await WorkTimeLog.getById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Time log not found' });

        if (entry.user_id !== req.user.id && !isManager(req.user)) {
            return res.status(403).json({ error: "You can only edit your own time logs" });
        }

        const editable = TimeLogService.canEdit(entry);
        if (!editable.ok) return res.status(409).json({ error: editable.reason });

        const { minutes, logged_for_date, is_billable, note } = req.body;
        const errors = TimeLogService.validate({
            minutes: minutes ?? entry.minutes,
            logged_for_date: logged_for_date ?? entry.logged_for_date,
            ticket_id: entry.ticket_id,
            support_ticket_id: entry.support_ticket_id,
        });
        if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

        const updated = await WorkTimeLog.update(req.params.id, { minutes, logged_for_date, is_billable, note });

        await AuditService.record(req, {
            action: AUDIT_ACTION.UPDATE,
            entity_type: AUDIT_ENTITY.TIME_LOG,
            entity_id: entry.id,
            before_data: { minutes: entry.minutes, logged_for_date: entry.logged_for_date, is_billable: entry.is_billable },
            after_data: { minutes: updated.minutes, logged_for_date: updated.logged_for_date, is_billable: updated.is_billable },
        });

        res.json(await WorkTimeLog.getById(req.params.id));
    } catch (err) {
        console.error('Update time log error:', err);
        res.status(500).json({ error: 'Failed to update time log', details: err.message });
    }
};

/**
 * POST /api/time-logs/:id/transition   { status, reason? }
 * Handles SUBMITTED / APPROVED / DRAFT (reject) in one place so the transition
 * table is the single source of truth for what is legal.
 */
exports.transition = async (req, res) => {
    try {
        const { status, reason } = req.body;
        const entry = await WorkTimeLog.getById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Time log not found' });

        const allowed = TimeLogService.canTransition(entry.status, status);
        if (!allowed.ok) return res.status(409).json({ error: allowed.reason });

        if (status === 'SUBMITTED') {
            if (entry.user_id !== req.user.id && !isManager(req.user)) {
                return res.status(403).json({ error: 'You can only submit your own time' });
            }
        }

        if (status === 'APPROVED' || (status === 'DRAFT' && entry.status === 'SUBMITTED')) {
            if (!isManager(req.user)) {
                return res.status(403).json({ error: 'Only a manager can approve or reject time' });
            }
            // Separation of duties: the person whose hours these are cannot be
            // the person who signs them off, even when that person is a manager.
            // Someone else with a manager role approves theirs.
            if (entry.user_id === req.user.id) {
                return res.status(403).json({
                    error: 'You cannot approve or reject your own time. Another manager must review it.',
                });
            }
        }

        if (status === 'DRAFT' && entry.status === 'APPROVED' && !LOCK_ROLES.includes(req.user.role)) {
            return res.status(403).json({ error: 'Only an admin can reopen approved time' });
        }

        const updated = await WorkTimeLog.setStatus(req.params.id, status, { userId: req.user.id });

        await AuditService.record(req, {
            action: AUDIT_ACTION.STATUS_CHANGE,
            entity_type: AUDIT_ENTITY.TIME_LOG,
            entity_id: entry.id,
            before_data: { status: entry.status },
            after_data: { status },
            reason,
        });

        res.json(await WorkTimeLog.getById(updated.id));
    } catch (err) {
        console.error('Transition time log error:', err);
        res.status(500).json({ error: 'Failed to change time log status', details: err.message });
    }
};

/**
 * POST /api/time-logs/:id/correct   { minutes, note }
 * The only way to change an approved entry: a new entry carrying the delta,
 * linked back to the original.
 */
exports.correct = async (req, res) => {
    const client = await db.pool.connect();
    try {
        const original = await WorkTimeLog.getById(req.params.id);
        if (!original) { client.release(); return res.status(404).json({ error: 'Time log not found' }); }

        if (!isManager(req.user)) {
            client.release();
            return res.status(403).json({ error: 'Only a manager can issue a correction' });
        }

        const { minutes, note } = req.body;
        const corrected = Number(minutes);
        if (!Number.isInteger(corrected) || corrected <= 0) {
            client.release();
            return res.status(400).json({ error: 'minutes must be a positive whole number' });
        }

        await client.query('BEGIN');

        // The correction carries the corrected TOTAL; the original is reversed
        // by being excluded from billing rather than edited, so both remain
        // visible in the audit trail.
        const entry = await WorkTimeLog.create({
            ticket_id: original.ticket_id,
            support_ticket_id: original.support_ticket_id,
            user_id: original.user_id,
            minutes: corrected,
            logged_for_date: original.logged_for_date,
            is_billable: original.is_billable,
            note: note || `Correction of ${original.minutes}m entry`,
            corrects_entry_id: original.id,
        }, client);

        // Original stops being billable but is not deleted — an invoice that
        // already went out still has its supporting row.
        await client.query(
            'UPDATE work_time_logs SET is_billable = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [original.id]
        );

        await client.query('COMMIT');

        await AuditService.record(req, {
            action: AUDIT_ACTION.UPDATE,
            entity_type: AUDIT_ENTITY.TIME_LOG,
            entity_id: original.id,
            before_data: { minutes: original.minutes, is_billable: original.is_billable },
            after_data: { minutes: corrected, corrected_by_entry: entry.id, is_billable: false },
            reason: note,
        });

        res.status(201).json(await WorkTimeLog.getById(entry.id));
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('Correct time log error:', err);
        res.status(500).json({ error: 'Failed to correct time log', details: err.message });
    } finally {
        client.release();
    }
};

/** DELETE /api/time-logs/:id — soft delete, editable entries only. */
exports.remove = async (req, res) => {
    try {
        const entry = await WorkTimeLog.getById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'Time log not found' });

        if (entry.user_id !== req.user.id && !isManager(req.user)) {
            return res.status(403).json({ error: 'You can only delete your own time logs' });
        }

        const editable = TimeLogService.canEdit(entry);
        if (!editable.ok) return res.status(409).json({ error: editable.reason });

        await WorkTimeLog.softDelete(req.params.id);
        await AuditService.record(req, {
            action: AUDIT_ACTION.DELETE,
            entity_type: AUDIT_ENTITY.TIME_LOG,
            entity_id: entry.id,
            before_data: { minutes: entry.minutes, logged_for_date: entry.logged_for_date },
        });

        res.json({ message: 'Time log deleted' });
    } catch (err) {
        console.error('Delete time log error:', err);
        res.status(500).json({ error: 'Failed to delete time log', details: err.message });
    }
};

/** GET /api/time-logs/period/status?from=&to= — what blocks a lock. */
exports.periodStatus = async (req, res) => {
    try {
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        const blocking = await WorkTimeLog.unapprovedInPeriod({ from, to });
        res.json({
            from, to,
            can_lock: blocking.length === 0,
            blocking_count: blocking.length,
            blocking,
        });
    } catch (err) {
        console.error('Period status error:', err);
        res.status(500).json({ error: 'Failed to read period status', details: err.message });
    }
};

/** POST /api/time-logs/period/lock   { from, to, force? } */
exports.lockPeriod = async (req, res) => {
    try {
        if (!LOCK_ROLES.includes(req.user.role)) {
            return res.status(403).json({ error: 'Only an admin can lock a billing period' });
        }

        const { from, to, force } = req.body;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        // Locking around unapproved time would quietly bill a partial period.
        // Overridable, but never the default, and the override is audited.
        const blocking = await WorkTimeLog.unapprovedInPeriod({ from, to });
        if (blocking.length && !force) {
            return res.status(409).json({
                error: `${blocking.length} entr${blocking.length === 1 ? 'y is' : 'ies are'} not yet approved in this period`,
                blocking,
                hint: 'Approve them, or repeat with force: true to lock only the approved entries.',
            });
        }

        const locked = await WorkTimeLog.lockPeriod({ from, to });

        await AuditService.record(req, {
            action: AUDIT_ACTION.LOCK,
            entity_type: AUDIT_ENTITY.TIME_LOG,
            entity_id: null,
            after_data: { from, to, locked_count: locked, forced: Boolean(force), skipped: blocking.length },
            reason: force ? 'Forced lock with unapproved entries present' : null,
        });

        res.json({
            from, to,
            locked_count: locked,
            skipped_unapproved: force ? blocking.length : 0,
        });
    } catch (err) {
        console.error('Lock period error:', err);
        res.status(500).json({ error: 'Failed to lock period', details: err.message });
    }
};
