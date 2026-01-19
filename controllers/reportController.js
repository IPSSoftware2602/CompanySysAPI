const db = require('../db');

// Get Performance Report with filters
exports.getPerformanceReport = async (req, res) => {
    try {
        const { startDate, endDate, userId, kanbanProjectId, supportProjectId } = req.query;

        console.log('Report filters:', { startDate, endDate, userId, kanbanProjectId, supportProjectId });

        // Get all users for the report
        const usersResult = await db.query('SELECT id, full_name, role FROM users ORDER BY full_name');
        const users = usersResult.rows;

        // Get all projects for reference
        const kanbanProjects = (await db.query('SELECT id, name FROM projects ORDER BY name')).rows;
        const supportProjects = (await db.query('SELECT id, name FROM supporting_projects ORDER BY name')).rows;

        // Build Kanban query - get tickets with evaluations
        let kanbanParams = [];
        let kanbanConditions = ["ce.status = 'SUBMITTED'", "ce.ticket_id IS NOT NULL"];
        let paramIdx = 1;

        if (startDate && endDate) {
            kanbanConditions.push(`ce.created_at >= $${paramIdx++}`);
            kanbanConditions.push(`ce.created_at <= $${paramIdx++}`);
            kanbanParams.push(startDate, endDate);
        }
        if (userId) {
            kanbanConditions.push(`ce.assignee_user_id = $${paramIdx++}`);
            kanbanParams.push(userId);
        }
        if (kanbanProjectId) {
            kanbanConditions.push(`t.project_id = $${paramIdx++}`);
            kanbanParams.push(kanbanProjectId);
        }

        const kanbanQuery = `
            SELECT 
                ce.id as evaluation_id,
                ce.assignee_user_id as user_id,
                u.full_name as user_name,
                ce.ticket_id,
                t.title as ticket_title,
                t.start_date,
                t.end_date,
                p.id as project_id,
                p.name as project_name,
                ce.complexity_score,
                ce.effectiveness_score,
                ce.completeness_score,
                ce.final_score,
                ce.ticket_mark,
                ce.status as evaluation_status,
                ce.created_at
            FROM credit_evaluations ce
            JOIN users u ON ce.assignee_user_id = u.id
            JOIN tickets t ON ce.ticket_id = t.id
            JOIN projects p ON t.project_id = p.id
            WHERE ${kanbanConditions.join(' AND ')}
            ORDER BY ce.created_at DESC
        `;

        console.log('Kanban query:', kanbanQuery);
        console.log('Kanban params:', kanbanParams);

        const kanbanEvals = (await db.query(kanbanQuery, kanbanParams)).rows;

        // Build Support query with proper parameterization
        let supportParams = [];
        let supportConditions = ["ce.status = 'SUBMITTED'", "ce.support_ticket_id IS NOT NULL"];
        paramIdx = 1;

        if (startDate && endDate) {
            supportConditions.push(`ce.created_at >= $${paramIdx++}`);
            supportConditions.push(`ce.created_at <= $${paramIdx++}`);
            supportParams.push(startDate, endDate);
        }
        if (userId) {
            supportConditions.push(`ce.assignee_user_id = $${paramIdx++}`);
            supportParams.push(userId);
        }
        if (supportProjectId) {
            supportConditions.push(`st.supporting_project_id = $${paramIdx++}`);
            supportParams.push(supportProjectId);
        }

        const supportQuery = `
            SELECT 
                ce.id as evaluation_id,
                ce.assignee_user_id as user_id,
                u.full_name as user_name,
                ce.support_ticket_id,
                st.title as ticket_title,
                st.start_date,
                st.actual_end_date as end_date,
                st.sla_due_at,
                sp.id as project_id,
                sp.name as project_name,
                ce.complexity_score,
                ce.effectiveness_score,
                ce.completeness_score,
                ce.sla_score,
                ce.final_score,
                ce.ticket_mark,
                ce.status as evaluation_status,
                ce.created_at
            FROM credit_evaluations ce
            JOIN users u ON ce.assignee_user_id = u.id
            JOIN support_tickets st ON ce.support_ticket_id = st.id
            LEFT JOIN supporting_projects sp ON st.supporting_project_id = sp.id
            WHERE ${supportConditions.join(' AND ')}
            ORDER BY ce.created_at DESC
        `;

        console.log('Support query:', supportQuery);
        console.log('Support params:', supportParams);

        const supportEvals = (await db.query(supportQuery, supportParams)).rows;

        // Aggregate data per user
        const userSummaries = users.map(user => {
            const userKanban = kanbanEvals.filter(e => e.user_id === user.id);
            const userSupport = supportEvals.filter(e => e.user_id === user.id);

            // Group by project
            const kanbanByProject = {};
            userKanban.forEach(e => {
                if (!kanbanByProject[e.project_id]) {
                    kanbanByProject[e.project_id] = {
                        projectName: e.project_name,
                        totalScore: 0,
                        count: 0,
                        tickets: []
                    };
                }
                kanbanByProject[e.project_id].totalScore += parseFloat(e.final_score || 0);
                kanbanByProject[e.project_id].count++;
                kanbanByProject[e.project_id].tickets.push(e);
            });

            const supportByProject = {};
            userSupport.forEach(e => {
                const projId = e.project_id || 'unassigned';
                if (!supportByProject[projId]) {
                    supportByProject[projId] = {
                        projectName: e.project_name || 'Unassigned',
                        totalScore: 0,
                        count: 0,
                        tickets: []
                    };
                }
                supportByProject[projId].totalScore += parseFloat(e.final_score || 0);
                supportByProject[projId].count++;
                supportByProject[projId].tickets.push(e);
            });

            const totalKanbanScore = userKanban.reduce((sum, e) => sum + parseFloat(e.final_score || 0), 0);
            const totalSupportScore = userSupport.reduce((sum, e) => sum + parseFloat(e.final_score || 0), 0);

            return {
                userId: user.id,
                userName: user.full_name,
                role: user.role,
                kanbanScore: totalKanbanScore,
                supportScore: totalSupportScore,
                totalScore: totalKanbanScore + totalSupportScore,
                kanbanCount: userKanban.length,
                supportCount: userSupport.length,
                kanbanByProject: Object.values(kanbanByProject),
                supportByProject: Object.values(supportByProject),
                kanbanTickets: userKanban,
                supportTickets: userSupport
            };
        }).filter(u => u.totalScore > 0 || u.kanbanCount > 0 || u.supportCount > 0);

        res.json({
            summary: userSummaries,
            filters: {
                kanbanProjects,
                supportProjects,
                users: users.map(u => ({ id: u.id, name: u.full_name }))
            }
        });

    } catch (err) {
        console.error('Performance report error:', err);
        res.status(500).json({ error: 'Failed to generate report', details: err.message });
    }
};
