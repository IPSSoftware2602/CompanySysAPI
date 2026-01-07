const SupportTicket = require('../models/supportTicketModel');
const db = require('../db');

// Helper for SLA Calculation
// Helper for SLA Calculation
function calculateSLA(priority, startDate) {
    const start = startDate ? new Date(startDate) : new Date();
    // Simplified logic: P0=2h, P1=24h, P2=5d, P3=14d
    // TODO: Implement business hours logic
    switch (priority) {
        case 'P0':
            return new Date(start.getTime() + 2 * 60 * 60 * 1000); // 2 hours
        case 'P1':
            return new Date(start.getTime() + 24 * 60 * 60 * 1000); // 24 hours
        case 'P2':
            const p2Date = new Date(start);
            p2Date.setDate(p2Date.getDate() + 5);
            return p2Date;
        case 'P3':
            const p3Date = new Date(start);
            p3Date.setDate(p3Date.getDate() + 14);
            return p3Date;
        default:
            return null;
    }
}

exports.createTicket = async (req, res) => {
    try {
        const {
            supporting_project_id,
            request_type,
            priority,
            risk_level,
            title,
            description,
            steps_to_reproduce,
            attachments,
            assigned_pm_id,
            assigned_dev_id,
            start_date // Optional
        } = req.body;

        // 1. Generate ID SC-YYYYMM-XXXX
        const dateObj = new Date();
        const yyyy = dateObj.getFullYear();
        const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        const prefix = `SC-${yyyy}${mm}`;

        const latestKey = await SupportTicket.getLatestKey(prefix);
        let sequence = 1;
        if (latestKey) {
            const parts = latestKey.split('-');
            const lastNum = parseInt(parts[2], 10);
            if (!isNaN(lastNum)) sequence = lastNum + 1;
        }
        const ticket_key = `${prefix}-${String(sequence).padStart(4, '0')}`;

        // 2. Calculate SLA
        const sla_due_at = calculateSLA(priority, start_date);

        // 3. Create Ticket
        const ticket = await SupportTicket.create({
            supporting_project_id,
            ticket_key,
            request_type,
            priority,
            risk_level,
            title,
            description,
            steps_to_reproduce,
            description,
            steps_to_reproduce,
            attachments,
            start_date,
            sla_due_at,
            created_by_user_id: req.user?.id, // Assuming auth middleware
            assigned_pm_id,
            assigned_dev_id
        });

        res.status(201).json(ticket);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create support ticket' });
    }
};

exports.transitionTicket = async (req, res) => {
    // Similar to existing transition but simpler initially (just status update)
    const { id } = req.params;
    const { status, reason, start_date, actual_end_date, priority } = req.body; // Allow updating dates/priority here too?

    try {
        const ticket = await SupportTicket.getById(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const updateData = {};
        if (status) updateData.status = status;
        if (actual_end_date) updateData.actual_end_date = actual_end_date;

        // If start_date changes, recalculate SLA
        // Also if priority changes (not in req.body usually for transition, but if edited, handled elsewhere? 
        // Let's assume this endpoint might handle edits too or we create a separate update endpoint. 
        // For now, let's assume this handles Updates + Transitions.
        let newSla = null;
        if (start_date && start_date !== ticket.start_date) {
            updateData.start_date = start_date;
            newSla = calculateSLA(priority || ticket.priority, start_date);
            updateData.sla_due_at = newSla;
        }

        if (status === 'CLOSED' && !ticket.closed_at) {
            updateData.closed_at = new Date().toISOString();
        }

        const updatedTicket = await SupportTicket.update(id, updateData);

        // Log transition ONLY if status changed
        if (status && status !== ticket.status) {
            await db.query(
                'INSERT INTO support_ticket_transitions (support_ticket_id, from_status, to_status, performed_by_user_id, reason) VALUES ($1, $2, $3, $4, $5)',
                [id, ticket.status, status, req.user?.id, reason]
            );
        }

        res.json(updatedTicket);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to transition ticket' });
    }
};

exports.updateTicket = async (req, res) => {
    const { id } = req.params;
    const { title, description, priority, risk_level, steps_to_reproduce, expected_result, actual_result, user_impact, assigned_dev_id, start_date, actual_end_date } = req.body;

    try {
        const ticket = await SupportTicket.getById(id);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const updateData = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (priority !== undefined) updateData.priority = priority;
        if (risk_level !== undefined) updateData.risk_level = risk_level;
        if (steps_to_reproduce !== undefined) updateData.steps_to_reproduce = steps_to_reproduce;
        if (assigned_dev_id !== undefined) updateData.assigned_dev_id = assigned_dev_id;
        if (start_date !== undefined) updateData.start_date = start_date;
        if (actual_end_date !== undefined) updateData.actual_end_date = actual_end_date;
        if (req.body.attachments !== undefined) {
            updateData.attachments = JSON.stringify(req.body.attachments);
        }

        // Recalculate SLA if priority changes
        if (priority && priority !== ticket.priority) {
            const newSla = calculateSLA(priority, ticket.start_date);
            updateData.sla_due_at = newSla;
        }

        const updatedTicket = await SupportTicket.update(id, updateData);
        res.json(updatedTicket);
    } catch (err) {
        console.error('Error in updateTicket:', err); // Debug Log
        console.error('Update Data was:', updateData); // Debug Log
        res.status(500).json({ error: 'Failed to update ticket', details: err.message });
    }
};

exports.getBoardTickets = async (req, res) => {
    try {
        // Fetch all support tickets, ordered by created_at DESC or updated_at
        // In real app, filter by project if needed. For now, fetch all visibility.
        const result = await db.query(`
            SELECT st.*, 
                   sp.name as project_name,
                   assignee.full_name as assigned_to_name
            FROM support_tickets st
            LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
            LEFT JOIN users assignee ON st.assigned_dev_id = assignee.id 
            ORDER BY st.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch support tickets' });
    }
};
