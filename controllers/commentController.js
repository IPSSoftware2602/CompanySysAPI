const Comment = require('../models/commentModel');

exports.createComment = async (req, res) => {
    try {
        const comment = await Comment.create(req.body);
        res.status(201).json(comment);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create comment' });
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
