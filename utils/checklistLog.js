/**
 * One line describing a checklist change, built at write time.
 *
 * Written here rather than formatted on read so the log reader stays a dumb
 * list: a second copy of this logic in the UI is a second thing to get wrong.
 * Returns null for a change worth no line (a reorder), which the caller takes
 * as "do not log".
 */
function checklistLogMessage(action, before = {}, after = {}) {
    if (action === 'ADD') return `Added "${after.content}"`;
    if (action === 'DELETE') return `Removed "${before.content}"`;

    const parts = [];
    if (after.content !== undefined && after.content !== before.content) {
        parts.push(`Renamed "${before.content}" to "${after.content}"`);
    }
    if (after.is_done !== undefined && after.is_done !== before.is_done) {
        parts.push(`${after.is_done ? 'Ticked' : 'Unticked'} "${after.content ?? before.content}"`);
    }
    return parts.join(' · ') || null;
}

module.exports = { checklistLogMessage };
