require('./test_env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../reminder');

test('deriveRiskLevel buckets by attended/missed counts', () => {
  assert.equal(__test.deriveRiskLevel(0, 0), 'low');
  assert.equal(__test.deriveRiskLevel(4, 1), 'medium');
  assert.equal(__test.deriveRiskLevel(2, 3), 'high');
});

test('buildRiskReminderText adds escalation for high risk', () => {
  const low = __test.buildRiskReminderText({ level: 'low', attended: 5, missed: 0 });
  const high = __test.buildRiskReminderText({ level: 'high', attended: 2, missed: 3 });
  assert.match(low, /Reminder/);
  assert.doesNotMatch(low, /High risk/);
  assert.match(high, /High risk/);
});
