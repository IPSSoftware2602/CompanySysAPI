const Comment = require('../models/commentModel');
const db = require('../db');
const SlaService = require('../services/slaService');

exports.createComment = async (req, res) => {
    const { ticket_id, support_ticket_id, content, is_internal } = req.body;

    if (!content || !String(content).trim()) {
        return res.status(400).json({ error: 'content is required' });
    }
    if (!ticket_id && !support_ticket_id) {
        return res.status(400).json({ error: 'ticket_id or support_ticket_id is required' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const comment = await Comment.create(
            {
                ticket_id,
                support_ticket_id,
                // Author is the authenticated user, never whatever the body claims —
                // req.body.user_id used to be passed straight through, which let a
                // caller post a comment under someone else's name.
                user_id: req.user.id,
                content,
                is_internal,
            },
            client
        );

        // A customer-visible reply on a support ticket stops the first-response
        // clock. Any internal user counts: support tickets here are logged BY
        // staff on the customer's behalf, so the ticket's creator is usually the
        // same person who answers — excluding them would never stamp anything.
        // recordFirstResponse is idempotent, so later replies are no-ops.
        let firstResponseRecorded = false;
        if (support_ticket_id && comment.is_internal === false) {
            firstResponseRecorded = await SlaService.recordFirstResponse(
                support_ticket_id,
                comment.created_at,
                client
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ ...comment, first_response_recorded: firstResponseRecorded });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be dead */ }
        console.error('Failed to create comment:', err);
        res.status(500).json({ error: 'Failed to create comment' });
    } finally {
        client.release();
    }
};

exports.getTicketComments = async (req, res) => {
    try {
        const comments = await Comment.getByTicket(req.params.ticketId);
        res.json(comments);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch comments' });
    }
};

exports.getSupportTicketComments = async (req, res) => {
    try {
        const comments = await Comment.getBySupportTicket(req.params.ticketId);
        res.json(comments);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch support comments' });
    }
};

exports.deleteComment = async (req, res) => {
    try {
        const comment = await Comment.getById(req.params.id);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (comment.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized to delete this comment' });
        }

        await Comment.delete(req.params.id);
        res.json({ message: 'Comment deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
};

exports.updateComment = async (req, res) => {
    try {
        const comment = await Comment.getById(req.params.id);
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (comment.user_id !== req.user.id) {
            return res.status(403).json({ error: 'Unauthorized to update this comment' });
        }

        const updatedComment = await Comment.update(req.params.id, req.body.content);
        res.json(updatedComment);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update comment' });
    }
};
