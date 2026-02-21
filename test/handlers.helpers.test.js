require('./test_env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../src/handlers');

test('bulk parser accepts attended_dates', () => {
  const parsed = __test.parseBulkLogCommand('attended_dates 2026-02-01,2026-02-03');
  assert.equal(parsed.type, 'bulk');
  assert.equal(parsed.status, 'attended');
  assert.deepEqual(parsed.dates, ['2026-02-01', '2026-02-03']);
});

test('bulk parser rejects invalid range', () => {
  const parsed = __test.parseBulkLogCommand('attended_range 2026-02-31..2026-03-02');
  assert.ok(parsed.error);
});

test('bulk parser supports missed_range with reason', () => {
  const parsed = __test.parseBulkLogCommand('missed_range 2026-02-10..2026-02-12 travel');
  assert.equal(parsed.type, 'bulk');
  assert.equal(parsed.status, 'cancelled');
  assert.equal(parsed.reason, 'travel');
  assert.deepEqual(parsed.dates, ['2026-02-10', '2026-02-11', '2026-02-12']);
});

test('permission model blocks therapist for billing and setup', () => {
  assert.equal(__test.hasPermission('therapist', 'billing'), false);
  assert.equal(__test.hasPermission('therapist', 'setup'), false);
  assert.equal(__test.hasPermission('therapist', 'log'), true);
});

test('pending role detection works', () => {
  assert.equal(__test.isPendingRole('pending_parent'), true);
  assert.equal(__test.pendingTargetRole('pending_parent'), 'parent');
  assert.equal(__test.isInviteAcceptCommand('accept_invite'), true);
  assert.equal(__test.isInviteRejectCommand('reject_invite'), true);
});

test('month bounds helper returns UTC range', () => {
  const bounds = __test.monthBoundsIso('2026-02');
  assert.equal(bounds.startIso, '2026-02-01T00:00:00.000Z');
  assert.equal(bounds.endIso, '2026-03-01T00:00:00.000Z');
});

test('missed reason normalization groups common labels', () => {
  assert.equal(__test.normalizeMissReason('fever and cough'), 'Health issue');
  assert.equal(__test.normalizeMissReason('out of station travel'), 'Travel');
  assert.equal(__test.normalizeMissReason('therapist not available'), 'Therapist unavailable');
});

test('risk helper marks high risk for heavy misses', () => {
  assert.equal(__test.deriveRiskLevel(1, 3), 'High');
  assert.equal(__test.deriveRiskLevel(4, 1), 'Medium');
  assert.equal(__test.deriveRiskLevel(5, 0), 'Low');
});

test('structured note transcript contains required sections', () => {
  const txt = __test.buildStructuredNoteTranscript({
    goal: 'Eye contact',
    activity: 'Flash cards',
    response: 'Improved',
    homework: '10 mins daily'
  });
  assert.match(txt, /Goal: Eye contact/);
  assert.match(txt, /Activity: Flash cards/);
  assert.match(txt, /Response: Improved/);
  assert.match(txt, /Homework: 10 mins daily/);
});

test('locale/theme normalizers keep supported values', () => {
  assert.equal(__test.normalizeLocale('hi-IN'), 'hi');
  assert.equal(__test.normalizeLocale('te'), 'te');
  assert.equal(__test.normalizeLocale('xx'), 'en');
  assert.equal(__test.normalizeTheme('ocean'), 'ocean');
  assert.equal(__test.normalizeTheme('unknown'), 'sunrise');
});

test('referral and streak helpers return stable values', () => {
  const code = __test.generateReferralCode('919876543210');
  assert.match(code, /^TT\d{4}[A-Z0-9]{4}$/);
  assert.equal(__test.nextStreakMilestone(0), 3);
  assert.equal(__test.nextStreakMilestone(8), 14);
  assert.equal(__test.badgeForStreak(30), 'Legend 30');
});
