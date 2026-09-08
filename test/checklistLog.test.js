const test = require('node:test');
const assert = require('node:assert');
const { checklistLogMessage } = require('../utils/checklistLog');

test('checklist log messages', () => {
    assert.equal(checklistLogMessage('ADD', {}, { content: 'Deploy' }), 'Added "Deploy"');
    assert.equal(checklistLogMessage('DELETE', { content: 'Deploy' }, {}), 'Removed "Deploy"');
    assert.equal(
        checklistLogMessage('UPDATE', { content: 'a', is_done: false }, { content: 'a', is_done: true }),
        'Ticked "a"'
    );
    assert.equal(
        checklistLogMessage('UPDATE', { content: 'a', is_done: true }, { content: 'b', is_done: false }),
        'Renamed "a" to "b" · Unticked "b"'
    );
    // A reorder says nothing worth reading.
    assert.equal(checklistLogMessage('UPDATE', { content: 'a', position: 0 }, { content: 'a', position: 1 }), null);
});
