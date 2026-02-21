﻿const axios = require('axios');
const PDFDocument = require('pdfkit');
const { supabase } = require('./db');
const { config } = require('./config');
const { nowPartsInTimeZone, getUserTimeZone } = require('./time');
const {
  sendMessage,
  sendImage,
  sendDocument,
  sendQuickMenu,
  sendMoreMenu,
  sendProUpsell,
  sendTimezonePicker,
  sendRemindersPicker,
  sendReminderTimePicker,
  showHolidayPicker,
  sendMissedDatePicker,
  sendAttendedDatePicker,
  sendAttendedCountPicker,
  sendBackfillDatePicker,
  sendBackfillCountPicker,
  sendBackfillReasonPicker,
  sendSetupPresets,
  sendSetupMode,
  sendYesNo,
  sendInviteTypePicker,
  sendInviteDecisionPicker,
  sendVoiceNotePrompt,
  sendMoodPicker
} = require('./whatsapp');

function extractVoiceNote(message) {
  if (!message || typeof message !== 'string') return '';
  if (!message.startsWith('voice_note:')) return '';
  return message.slice('voice_note:'.length).trim();
}

function extractVoiceNoteRef(message) {
  if (!message || typeof message !== 'string') return '';
  if (!message.startsWith('voice_note_ref:')) return '';
  return message.slice('voice_note_ref:'.length).trim();
}

function encodeStateSegment(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64');
}

function decodeStateSegment(value) {
  try {
    return Buffer.from(String(value || ''), 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function readTextPayload(message) {
  const voice = extractVoiceNote(message);
  const raw = voice || message;
  return String(raw || '').trim();
}

function truncateText(value, maxLen = 80) {
  const t = String(value || '').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}...`;
}

function normalizeMissReason(reason) {
  const raw = String(reason || '').trim();
  if (!raw) return 'Unspecified';
  const t = raw.toLowerCase();
  if (/(sick|ill|fever|health|hospital|cold|cough)/.test(t)) return 'Health issue';
  if (/(travel|trip|out of station|vacation|holiday)/.test(t)) return 'Travel';
  if (/(therapist|doctor unavailable|provider unavailable)/.test(t)) return 'Therapist unavailable';
  if (/(school|exam|class|tuition)/.test(t)) return 'School/Exam';
  if (/(family|function|guest|wedding)/.test(t)) return 'Family events';
  if (/(rain|traffic|transport|vehicle)/.test(t)) return 'Transport/Commute';
  return truncateText(raw, 28);
}

function buildStructuredNoteTranscript({ goal, activity, response, homework }) {
  return [
    'Therapist structured note',
    `Goal: ${String(goal || '').trim()}`,
    `Activity: ${String(activity || '').trim()}`,
    `Response: ${String(response || '').trim()}`,
    `Homework: ${String(homework || '').trim()}`
  ].join('\n');
}

function extractHomeworkFromTranscript(transcript) {
  const text = String(transcript || '');
  if (!text) return '';
  const match = text.match(/homework\s*:\s*(.+)/i);
  if (!match) return '';
  return truncateText(match[1], 90);
}

function deriveConsistencyTip({ attended, missed, topReason, homeworkHint, notesCount }) {
  if (homeworkHint) return `Follow this week homework: ${homeworkHint}`;
  if (missed >= 3) return 'High misses this week. Lock fixed slot + backup slot for next week.';
  if (missed > attended) return 'Misses are higher than attended. Keep reminders ON and pre-book times.';
  if (notesCount === 0) return 'Ask therapist to share one structured note after each session.';
  if (topReason) return `Main blocker: ${topReason}. Plan around this in advance.`;
  return 'Good consistency. Keep same routine next week.';
}

const SUPPORTED_LOCALES = new Set(['en', 'hi', 'te']);

function normalizeLocale(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.startsWith('hi')) return 'hi';
  if (raw.startsWith('te')) return 'te';
  return 'en';
}

function i18nText(locale, key, vars = {}) {
  const lang = normalizeLocale(locale);
  const dict = {
    en: {
      language_prompt: `Choose language:\n- lang:en (English)\n- lang:hi (Hindi)\n- lang:te (Telugu)`,
      language_saved: `✅ Language updated to {lang}.`,
      streak_empty: `No attended sessions yet. Start with one session today.`,
      referral_intro: `🎁 Your referral code: {code}\nShare this with another parent.\nThey use: redeem {code}\nReward: both get +{days} Pro days.`,
      referral_invalid: 'Referral code not found.',
      referral_self: 'You cannot redeem your own referral code.',
      referral_already: 'Referral already used for this account.',
      referral_done: `✅ Referral applied.\nYou and referrer received +{days} Pro days.`,
      coupon_prompt: 'Use: apply_coupon CODE',
      coupon_invalid: 'Coupon not valid or expired.',
      coupon_already: 'Coupon already used by this account.',
      coupon_done: `✅ Coupon applied: +{days} Pro days.`,
      theme_saved: `🎨 Theme updated to {theme}.`,
      theme_prompt: `Themes:\n- theme:sunrise\n- theme:ocean\n- theme:forest`,
      streak_status: `🔥 Streak journey\nCurrent streak: {current} day(s)\nBest streak: {best} day(s)\nNext milestone: {next} day(s)`,
      streak_badge: `🏅 Milestone unlocked: {badge}\nCurrent streak: {current} day(s)`
    },
    hi: {
      language_prompt: `भाषा चुनें:\n- lang:en (English)\n- lang:hi (Hindi)\n- lang:te (Telugu)`,
      language_saved: `✅ भाषा अपडेट हो गई: {lang}`,
      streak_empty: `अभी तक attended session नहीं है। आज से शुरू करें।`,
      referral_intro: `🎁 आपका referral code: {code}\nइसे दूसरे parent के साथ share करें.\nवह लिखे: redeem {code}\nReward: दोनों को +{days} Pro दिन मिलेंगे।`,
      referral_invalid: 'Referral code नहीं मिला।',
      referral_self: 'अपना referral code redeem नहीं कर सकते।',
      referral_already: 'यह account referral पहले ही use कर चुका है।',
      referral_done: `✅ Referral लागू हो गया।\nआप और referrer को +{days} Pro दिन मिले।`,
      coupon_prompt: 'Use करें: apply_coupon CODE',
      coupon_invalid: 'Coupon valid नहीं है या expire हो चुका है।',
      coupon_already: 'यह coupon पहले ही use हो चुका है।',
      coupon_done: `✅ Coupon लागू हुआ: +{days} Pro दिन।`,
      theme_saved: `🎨 Theme अपडेट हुआ: {theme}`,
      theme_prompt: `Themes:\n- theme:sunrise\n- theme:ocean\n- theme:forest`,
      streak_status: `🔥 Streak journey\nCurrent streak: {current} दिन\nBest streak: {best} दिन\nNext milestone: {next} दिन`,
      streak_badge: `🏅 Milestone unlocked: {badge}\nCurrent streak: {current} दिन`
    },
    te: {
      language_prompt: `భాష ఎంచుకోండి:\n- lang:en (English)\n- lang:hi (Hindi)\n- lang:te (Telugu)`,
      language_saved: `✅ భాష మార్చబడింది: {lang}`,
      streak_empty: `ఇప్పటివరకు attended session లేదు. ఈరోజు మొదలు పెట్టండి.`,
      referral_intro: `🎁 మీ referral code: {code}\nఇది మరో parent కి share చేయండి.\nవారు type చేయాలి: redeem {code}\nReward: ఇద్దరికీ +{days} Pro రోజులు.`,
      referral_invalid: 'Referral code దొరకలేదు.',
      referral_self: 'మీ referral code మీరే redeem చేయలేరు.',
      referral_already: 'ఈ account referral ఇప్పటికే ఉపయోగించింది.',
      referral_done: `✅ Referral apply అయింది.\nమీకు మరియు referrer కి +{days} Pro రోజులు వచ్చాయి.`,
      coupon_prompt: 'ఇలా వాడండి: apply_coupon CODE',
      coupon_invalid: 'Coupon valid కాదు లేదా expire అయింది.',
      coupon_already: 'ఈ coupon ఇప్పటికే వాడారు.',
      coupon_done: `✅ Coupon apply అయింది: +{days} Pro రోజులు.`,
      theme_saved: `🎨 Theme మార్చబడింది: {theme}`,
      theme_prompt: `Themes:\n- theme:sunrise\n- theme:ocean\n- theme:forest`,
      streak_status: `🔥 Streak journey\nCurrent streak: {current} రోజులు\nBest streak: {best} రోజులు\nNext milestone: {next} రోజులు`,
      streak_badge: `🏅 Milestone unlocked: {badge}\nCurrent streak: {current} రోజులు`
    }
  };
  const source = dict[lang] || dict.en;
  const template = source[key] || dict.en[key] || '';
  return template.replace(/\{(\w+)\}/g, (_m, name) => String(vars[name] ?? ''));
}

function withTenant(tenantId, data) {
  if (!config.ENABLE_TENANT_SCOPING || !tenantId) return data;
  return { tenant_id: tenantId, ...data };
}

function userMatch(tenantId, userPhone) {
  return withTenant(tenantId, { phone: userPhone });
}

function userPhoneMatch(tenantId, userPhone) {
  return withTenant(tenantId, { user_phone: userPhone });
}

async function summarizeFeedback(text) {
  const note = String(text || '').trim();
  if (!note) return '';
  const key = config.GROQ_API_KEY;
  if (!key) return '';
  try {
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'Summarize the feedback in the same language as the input. Keep it concise and parent-friendly.' },
          { role: 'user', content: note }
        ]
      },
      { headers: { Authorization: `Bearer ${key}` } }
    );
    const summary = data?.choices?.[0]?.message?.content || '';
    return String(summary).trim();
  } catch (_) {
    return '';
  }
}

async function saveFeedbackNote(userPhone, text, tenantId, options = {}) {
  const note = String(text || '').trim();
  if (!note) return { ok: false };
  const source = String(options.source || 'text').trim().toLowerCase() || 'text';
  const mediaId = String(options.mediaId || '').trim() || null;
  const transcriptionStatus = String(options.transcriptionStatus || 'ok').trim().toLowerCase() || 'ok';
  const skipSummary = options.skipSummary === true || transcriptionStatus !== 'ok';
  const summary = skipSummary ? '' : await summarizeFeedback(note);
  const fullRow = withTenant(tenantId, {
    user_phone: userPhone,
    transcript: note,
    summary,
    source,
    media_id: mediaId,
    transcription_status: transcriptionStatus,
    created_at: new Date().toISOString()
  });
  let { error } = await supabase.from('feedback_notes').insert(fullRow);
  if (error && /(source|media_id|transcription_status)/i.test(error.message || '')) {
    const fallbackRow = withTenant(tenantId, {
      user_phone: userPhone,
      transcript: note,
      summary,
      created_at: new Date().toISOString()
    });
    const retry = await supabase.from('feedback_notes').insert(fallbackRow);
    error = retry.error || null;
  }
  if (error) {
    console.error('Supabase feedback_notes insert error:', error.message);
    return { ok: false, summary };
  }
  return { ok: true, summary, transcriptionStatus };
}

function isProActive(user) {
  if (!user || user.is_pro !== true) return false;
  if (!user.pro_expires_at) return true;
  const t = Date.parse(user.pro_expires_at);
  return Number.isFinite(t) && t > Date.now();
}

const OPT_OUT_COMMANDS = new Set(['stop', 'opt_out', 'optout', 'unsubscribe', 'pause']);
const OPT_IN_COMMANDS = new Set(['start', 'opt_in', 'optin', 'subscribe', 'resume']);
const ALLOWED_WHILE_OPTED_OUT = new Set([
  ...OPT_IN_COMMANDS,
  'consent_status',
  'plan',
  'my_plan',
  'plan_status',
  'payment_status',
  'billing_status',
  'export_data',
  'export_my_data',
  'delete_data',
  'delete_my_data',
  'erase_data',
  'invite_accept',
  'accept_invite',
  'invite_reject',
  'reject_invite'
]);

function formatIsoDate(value) {
  const t = Date.parse(String(value || ''));
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

function normalizeMemberPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length > 10 && digits.startsWith('0')) return digits.replace(/^0+/, '');
  return digits;
}

const ALLOWED_BY_PERMISSION = {
  log: new Set(['owner', 'parent', 'therapist', 'member']),
  notes: new Set(['owner', 'parent', 'therapist', 'member']),
  view: new Set(['owner', 'parent', 'therapist', 'member']),
  setup: new Set(['owner', 'parent']),
  reset: new Set(['owner', 'parent']),
  billing: new Set(['owner', 'parent']),
  data: new Set(['owner', 'parent']),
  members_view: new Set(['owner', 'parent']),
  members_manage: new Set(['owner']),
  admin: new Set(['owner'])
};

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function isPendingRole(role) {
  return normalizeRole(role).startsWith('pending_');
}

function pendingTargetRole(role) {
  const r = normalizeRole(role);
  return isPendingRole(r) ? r.slice('pending_'.length) : r;
}

function isInviteAcceptCommand(command) {
  const c = String(command || '').trim().toLowerCase();
  return c === 'invite_accept' || c === 'accept_invite' || c === 'accept invite' || c === 'join_invite' || c === 'join';
}

function isInviteRejectCommand(command) {
  const c = String(command || '').trim().toLowerCase();
  return c === 'invite_reject' || c === 'reject_invite' || c === 'reject invite' || c === 'decline_invite' || c === 'decline' || c === 'reject';
}

function hasPermission(role, permission) {
  const r = normalizeRole(role);
  const allowed = ALLOWED_BY_PERMISSION[permission];
  if (!allowed) return true;
  return allowed.has(r);
}

function permissionDeniedText(role, permission) {
  const r = pendingTargetRole(role) || 'member';
  if (permission === 'members_manage') return `Only owner can invite or manage members. Your role: ${r}.`;
  if (permission === 'admin') return `Clinic admin commands are allowed for owner only. Your role: ${r}.`;
  if (permission === 'billing') return `Billing actions are allowed for owner/parent. Your role: ${r}.`;
  if (permission === 'setup') return `Setup changes are allowed for owner/parent. Your role: ${r}.`;
  if (permission === 'reset') return `Reset is allowed for owner/parent. Your role: ${r}.`;
  if (permission === 'data') return `Data export/delete is allowed for owner/parent. Your role: ${r}.`;
  if (permission === 'members_view') return `Members view is allowed for owner/parent. Your role: ${r}.`;
  if (permission === 'log') return `Session logging is not allowed for your role (${r}).`;
  return `Action is not allowed for your role (${r}).`;
}

async function resolveMemberContext(userPhone, tenantId) {
  try {
    const { data, error } = await supabase
      .from('child_members')
      .select('child_id,role,created_at')
      .match(withTenant(tenantId, { member_phone: userPhone }))
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) {
      console.error('child_members role lookup error:', error.message);
      return { role: 'owner', childId: null };
    }
    const row = Array.isArray(data) && data.length ? data[0] : null;
    const role = normalizeRole(row?.role || 'owner');
    return {
      role: role || 'owner',
      childId: row?.child_id || null
    };
  } catch (_) {
    return { role: 'owner', childId: null };
  }
}

async function listPendingInvites(userPhone, tenantId, limit = 10) {
  try {
    const { data, error } = await supabase
      .from('child_members')
      .select('id,child_id,role,created_at')
      .match(withTenant(tenantId, { member_phone: userPhone }))
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) {
      console.error('child_members pending invite lookup error:', error.message);
      return [];
    }
    return (Array.isArray(data) ? data : []).filter((row) => isPendingRole(row?.role));
  } catch (_) {
    return [];
  }
}

async function findChildOwnerPhone(childId, tenantId) {
  if (!childId) return '';
  try {
    const { data, error } = await supabase
      .from('children')
      .select('created_by')
      .match(withTenant(tenantId, { id: childId }))
      .limit(1);
    if (error) return '';
    return Array.isArray(data) && data[0]?.created_by ? String(data[0].created_by) : '';
  } catch (_) {
    return '';
  }
}

async function handleInviteAccept(userPhone, tenantId) {
  const pending = await listPendingInvites(userPhone, tenantId);
  if (!pending.length) {
    await sendMessage(userPhone, 'No pending invite found.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const invite = pending[0];
  const finalRole = pendingTargetRole(invite.role) || 'member';
  const { error } = await supabase
    .from('child_members')
    .update({ role: finalRole })
    .match(withTenant(tenantId, { id: invite.id }));
  if (error) {
    await sendMessage(userPhone, `Could not accept invite: ${error.message}`);
    return;
  }
  const ownerPhone = await findChildOwnerPhone(invite.child_id, tenantId);
  if (ownerPhone && ownerPhone !== userPhone) {
    await sendMessage(ownerPhone, `✅ Invite accepted\n📱 ${userPhone}\n👤 Role: ${finalRole}`);
  }
  await sendMessage(userPhone, `✅ Invite accepted\nRole: ${finalRole}`);
  await sendQuickMenu(userPhone, tenantId);
}

async function handleInviteReject(userPhone, tenantId) {
  const pending = await listPendingInvites(userPhone, tenantId);
  if (!pending.length) {
    await sendMessage(userPhone, 'No pending invite found.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const invite = pending[0];
  const role = pendingTargetRole(invite.role) || 'member';
  const { error } = await supabase
    .from('child_members')
    .delete()
    .match(withTenant(tenantId, { id: invite.id }));
  if (error) {
    await sendMessage(userPhone, `Could not reject invite: ${error.message}`);
    return;
  }
  const ownerPhone = await findChildOwnerPhone(invite.child_id, tenantId);
  if (ownerPhone && ownerPhone !== userPhone) {
    await sendMessage(ownerPhone, `❌ Invite rejected\n📱 ${userPhone}\n👤 Role: ${role}`);
  }
  await sendMessage(userPhone, 'Invite rejected.');
  await sendQuickMenu(userPhone, tenantId);
}

function isValidIsoDate(dateStr) {
  const raw = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const t = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString().slice(0, 10) === raw;
}

function parseCommaDateList(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const d of parts) {
    if (!isValidIsoDate(d)) return null;
    if (!seen.has(d)) {
      out.push(d);
      seen.add(d);
    }
  }
  return out;
}

function expandDateRange(start, end, maxDays = 62) {
  const s = String(start || '').trim();
  const e = String(end || '').trim();
  if (!isValidIsoDate(s) || !isValidIsoDate(e)) return null;
  const startMs = Date.parse(`${s}T00:00:00Z`);
  const endMs = Date.parse(`${e}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return null;
  const days = Math.floor((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
  if (days < 1 || days > maxDays) return null;
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startMs + (i * 24 * 60 * 60 * 1000));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function parseBulkLogCommand(command) {
  const cmd = String(command || '').trim().toLowerCase();
  if (!cmd) return null;
  if (cmd === 'bulk_log_help' || cmd === 'bulk_help') return { type: 'help' };

  if (cmd.startsWith('attended_dates ')) {
    const dates = parseCommaDateList(cmd.slice('attended_dates '.length));
    if (!dates || !dates.length) return { error: 'Invalid date list. Use: attended_dates 2026-02-01,2026-02-03' };
    return { type: 'bulk', status: 'attended', dates };
  }

  if (cmd.startsWith('attended_range ')) {
    const rangeText = cmd.slice('attended_range '.length).trim();
    const parts = rangeText.split('..');
    if (parts.length !== 2) return { error: 'Invalid range. Use: attended_range 2026-02-01..2026-02-07' };
    const dates = expandDateRange(parts[0], parts[1]);
    if (!dates || !dates.length) return { error: 'Invalid range or too long (max 62 days).' };
    return { type: 'bulk', status: 'attended', dates };
  }

  if (cmd.startsWith('missed_dates ')) {
    const payload = cmd.slice('missed_dates '.length).trim();
    const firstSpace = payload.indexOf(' ');
    const datePart = firstSpace >= 0 ? payload.slice(0, firstSpace).trim() : payload;
    const reasonPart = firstSpace >= 0 ? payload.slice(firstSpace + 1).trim() : '';
    const dates = parseCommaDateList(datePart);
    if (!dates || !dates.length) return { error: 'Invalid date list. Use: missed_dates 2026-02-01,2026-02-03 sick' };
    const reason = reasonPart || 'Missed (bulk)';
    return { type: 'bulk', status: 'cancelled', dates, reason };
  }

  if (cmd.startsWith('missed_range ')) {
    const payload = cmd.slice('missed_range '.length).trim();
    const firstSpace = payload.indexOf(' ');
    const rangePart = firstSpace >= 0 ? payload.slice(0, firstSpace).trim() : payload;
    const reasonPart = firstSpace >= 0 ? payload.slice(firstSpace + 1).trim() : '';
    const range = rangePart.split('..');
    if (range.length !== 2) return { error: 'Invalid range. Use: missed_range 2026-02-01..2026-02-07 travel' };
    const dates = expandDateRange(range[0], range[1]);
    if (!dates || !dates.length) return { error: 'Invalid range or too long (max 62 days).' };
    const reason = reasonPart || 'Missed (bulk)';
    return { type: 'bulk', status: 'cancelled', dates, reason };
  }

  return null;
}

async function sendBulkLogHelp(userPhone) {
  await sendMessage(
    userPhone,
    `🗂️ Bulk logging commands\n` +
    `1) attended_dates YYYY-MM-DD,YYYY-MM-DD\n` +
    `2) attended_range YYYY-MM-DD..YYYY-MM-DD\n` +
    `3) missed_dates YYYY-MM-DD,YYYY-MM-DD <reason>\n` +
    `4) missed_range YYYY-MM-DD..YYYY-MM-DD <reason>\n\n` +
    `Examples:\n` +
    `attended_dates 2026-02-01,2026-02-03\n` +
    `attended_range 2026-02-10..2026-02-14\n` +
    `missed_dates 2026-02-02,2026-02-06 sick\n` +
    `missed_range 2026-02-20..2026-02-22 travel`
  );
}

async function applyBulkLog({ userPhone, tenantId, status, dates, reason }) {
  const normalizedDates = Array.from(new Set((dates || []).map((d) => String(d || '').trim()).filter(Boolean)));
  if (!normalizedDates.length) {
    return { inserted: 0, skippedFuture: 0, skippedDuplicate: 0, skippedConflict: 0, insertedDates: [] };
  }

  const childId = await getOrCreateDefaultChild(userPhone, tenantId);
  const idKey = childId ? 'child_id' : 'user_phone';
  const idVal = childId ? childId : userPhone;
  const tz = await getUserTimeZone(userPhone, tenantId);
  const { today } = nowPartsInTimeZone(tz);

  const existingByDate = new Map();
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('date,status')
      .match(withTenant(tenantId, { [idKey]: idVal }))
      .in('date', normalizedDates);
    if (error) {
      console.error('bulk sessions read error:', error.message);
    } else {
      for (const row of (data || [])) {
        const d = String(row?.date || '').slice(0, 10);
        if (!d) continue;
        const state = existingByDate.get(d) || { attended: false, cancelled: false };
        if (row.status === 'attended') state.attended = true;
        if (row.status === 'cancelled') state.cancelled = true;
        existingByDate.set(d, state);
      }
    }
  } catch (_) {
  }

  const rowsToInsert = [];
  let skippedFuture = 0;
  let skippedDuplicate = 0;
  let skippedConflict = 0;
  const insertedDates = [];

  for (const date of normalizedDates) {
    if (!isValidIsoDate(date)) continue;
    if (date > today) {
      skippedFuture += 1;
      continue;
    }
    const existing = existingByDate.get(date) || { attended: false, cancelled: false };
    if (status === 'attended') {
      if (existing.cancelled) {
        skippedConflict += 1;
        continue;
      }
      if (existing.attended) {
        skippedDuplicate += 1;
        continue;
      }
    } else {
      if (existing.attended) {
        skippedConflict += 1;
        continue;
      }
      if (existing.cancelled) {
        skippedDuplicate += 1;
        continue;
      }
    }
    rowsToInsert.push(withTenant(tenantId, {
      user_phone: userPhone,
      child_id: childId,
      logged_by: userPhone,
      sessions_done: 1,
      date,
      status,
      ...(status === 'cancelled' ? { reason: String(reason || 'Missed (bulk)') } : {}),
      month: date.slice(0, 7)
    }));
    insertedDates.push(date);
  }

  if (rowsToInsert.length) {
    const { error } = await supabase.from('sessions').insert(rowsToInsert);
    if (error) {
      console.error('bulk sessions insert error:', error.message);
      let recovered = 0;
      for (const row of rowsToInsert) {
        const { error: oneErr } = await supabase.from('sessions').insert(row);
        if (!oneErr) recovered += 1;
      }
      if (recovered < insertedDates.length) {
        insertedDates.splice(recovered);
      }
    }
  }

  return {
    inserted: insertedDates.length,
    skippedFuture,
    skippedDuplicate,
    skippedConflict,
    insertedDates
  };
}

async function recordConsentEvent(userPhone, tenantId, eventType, details = {}) {
  try {
    const row = withTenant(tenantId, {
      user_phone: userPhone,
      event_type: eventType,
      details,
      created_at: new Date().toISOString()
    });
    const { error } = await supabase.from('consent_events').insert(row);
    if (error && !/consent_events/i.test(error.message || '')) {
      console.error('consent_events insert error:', error.message);
    }
  } catch (_) {
  }
}

async function getConsentState(userPhone, tenantId) {
  try {
    const { data, error } = await supabase
      .from('consent_events')
      .select('event_type,created_at')
      .match(userPhoneMatch(tenantId, userPhone))
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      if (!/consent_events/i.test(error.message || '')) {
        console.error('consent_events select error:', error.message);
      }
      return { optedOut: false, eventType: null, at: null };
    }
    const row = Array.isArray(data) && data.length ? data[0] : null;
    const eventType = row?.event_type ? String(row.event_type) : null;
    return {
      optedOut: eventType === 'opt_out',
      eventType,
      at: row?.created_at || null
    };
  } catch (_) {
    return { optedOut: false, eventType: null, at: null };
  }
}

async function ensureUserExists(phone, tenantId) {
  const { data } = await supabase
    .from('users')
    .select('phone')
    .match(userMatch(tenantId, phone))
    .limit(1);
  if (Array.isArray(data) && data.length) return;
  await createUser(phone, tenantId);
}

async function handlePlanStatus(userPhone, user) {
  if (isProActive(user)) {
    const expiry = formatIsoDate(user?.pro_expires_at);
    const daysLeft = expiry
      ? Math.max(0, Math.ceil((Date.parse(user.pro_expires_at) - Date.now()) / (24 * 60 * 60 * 1000)))
      : null;
    await sendMessage(
      userPhone,
      `PLAN STATUS\n` +
      `Pro: Active\n` +
      `${expiry ? `Valid until: ${expiry}\n` : ''}` +
      `${daysLeft !== null ? `Days left: ${daysLeft}` : 'No expiry set'}`
    );
    if (daysLeft !== null && daysLeft <= 7) {
      const link = config.RAZORPAY_PAYMENT_LINK_499 || config.RAZORPAY_PAYMENT_LINK_199 || config.RAZORPAY_PAYMENT_LINK || '';
      if (link) {
        await sendMessage(userPhone, `Renew now:\n${link}`);
      }
    }
    return;
  }
  const link199 = config.RAZORPAY_PAYMENT_LINK_199 || config.RAZORPAY_PAYMENT_LINK;
  const link499 = config.RAZORPAY_PAYMENT_LINK_499;
  if (link199 && link499) {
    await sendMessage(
      userPhone,
      `PLAN STATUS\n` +
      `Pro: Not active\n` +
      `INR 199 (Parent Basic): ${link199}\n` +
      `INR 499 (Pro Plus): ${link499}`
    );
    return;
  }
  if (link499 || link199) {
    await sendMessage(
      userPhone,
      `PLAN STATUS\n` +
      `Pro: Not active\n` +
      `Upgrade link:\n${link499 || link199}`
    );
    return;
  }
  await sendMessage(userPhone, 'PLAN STATUS\nPro: Not active\nPayment links are not configured.');
}

async function getLastPaymentForUser(userPhone, tenantId) {
  try {
    const { data, error } = await supabase
      .from('subscription_payments')
      .select('payment_id,event_name,plan_code,plan_days,amount_paise,currency,status,paid_at,created_at')
      .match(userPhoneMatch(tenantId, userPhone))
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      if (!/subscription_payments/i.test(error.message || '')) {
        console.error('subscription_payments lookup error:', error.message);
      }
      return null;
    }
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (_) {
    return null;
  }
}

async function handlePaymentStatus(userPhone, user, tenantId) {
  const active = isProActive(user);
  const expiry = formatIsoDate(user?.pro_expires_at);
  const last = await getLastPaymentForUser(userPhone, tenantId);
  const lines = [
    'PAYMENT STATUS',
    `Pro: ${active ? 'Active' : 'Not active'}`
  ];
  if (expiry) lines.push(`Valid until: ${expiry}`);
  if (last) {
    const paidAt = formatIsoDate(last.paid_at || last.created_at) || 'unknown';
    const amount = Number.isInteger(last.amount_paise) ? (last.amount_paise / 100).toFixed(2) : null;
    const currency = String(last.currency || 'INR').toUpperCase();
    lines.push(`Last payment: ${last.payment_id || 'n/a'}`);
    if (amount) lines.push(`Amount: ${currency} ${amount}`);
    lines.push(`Plan: ${last.plan_code || 'n/a'} (${last.plan_days || config.PRO_PLAN_DAYS || 30} days)`);
    lines.push(`Paid on: ${paidAt}`);
    lines.push(`Event: ${last.event_name || 'n/a'} (${last.status || 'paid'})`);
  } else {
    lines.push('Last payment: not found');
  }
  await sendMessage(userPhone, lines.join('\n'));
  if (!active) {
    const link199 = config.RAZORPAY_PAYMENT_LINK_199 || config.RAZORPAY_PAYMENT_LINK;
    const link499 = config.RAZORPAY_PAYMENT_LINK_499;
    if (link199 && link499) {
      await sendMessage(
        userPhone,
        `Upgrade links:\n` +
        `INR 199: ${link199}\n` +
        `INR 499: ${link499}`
      );
    } else if (link499 || link199) {
      await sendMessage(userPhone, `Upgrade link:\n${link499 || link199}`);
    }
  }
}

async function handleReconcilePayment(userPhone, paymentId, user, tenantId) {
  const pid = String(paymentId || '').trim();
  if (!pid) {
    await sendMessage(userPhone, 'Usage: reconcile_payment <payment_id>');
    return;
  }
  try {
    const { data, error } = await supabase
      .from('subscription_payments')
      .select('payment_id,plan_code,plan_days,paid_at,status,created_at')
      .match(withTenant(tenantId, { payment_id: pid }))
      .limit(1);
    if (error) {
      if (/subscription_payments/i.test(error.message || '')) {
        await sendMessage(userPhone, 'subscription_payments table missing. Run database_hardening.sql');
        return;
      }
      await sendMessage(userPhone, `Could not verify payment: ${error.message}`);
      return;
    }
    const row = Array.isArray(data) && data.length ? data[0] : null;
    if (!row) {
      await sendMessage(userPhone, `Payment not found: ${pid}`);
      return;
    }
    const days = Math.max(1, parseInt(String(row.plan_days || config.PRO_PLAN_DAYS || 30), 10) || 30);
    const nowMs = Date.now();
    const currentExpiryMs = user?.pro_expires_at ? Date.parse(user.pro_expires_at) : NaN;
    const baseMs = Number.isFinite(currentExpiryMs) && currentExpiryMs > nowMs ? currentExpiryMs : nowMs;
    const nextExpiry = new Date(baseMs + (days * 24 * 60 * 60 * 1000));
    const { error: upErr } = await supabase
      .from('users')
      .update({ is_pro: true, pro_expires_at: nextExpiry.toISOString() })
      .match(userMatch(tenantId, userPhone));
    if (upErr) {
      await sendMessage(userPhone, `Could not apply reconcile: ${upErr.message}`);
      return;
    }
    await sendMessage(
      userPhone,
      `✅ Payment reconciled\n` +
      `Payment: ${row.payment_id || pid}\n` +
      `Plan: ${row.plan_code || 'pro'} (${days} days)\n` +
      `Pro valid until: ${nextExpiry.toISOString().slice(0, 10)}`
    );
    await recordConsentEvent(userPhone, tenantId, 'payment_reconciled', {
      payment_id: row.payment_id || pid,
      plan_code: row.plan_code || 'pro',
      plan_days: days,
      status: row.status || 'paid',
      reconciled_at: new Date().toISOString(),
      expires_at: nextExpiry.toISOString()
    });
  } catch (e) {
    await sendMessage(userPhone, `Could not reconcile payment: ${e.message}`);
  }
}

async function handleMembersList(userPhone, tenantId) {
  const childId = await getOrCreateDefaultChild(userPhone, tenantId);
  if (!childId) {
    await sendMessage(userPhone, 'Could not load members.');
    return;
  }
  const { data, error } = await supabase
    .from('child_members')
    .select('member_phone,role')
    .match(withTenant(tenantId, { child_id: childId }))
    .order('created_at', { ascending: true });
  if (error) {
    await sendMessage(userPhone, 'Could not load members.');
    return;
  }
  const rows = (data || []).map((m) => {
    const role = normalizeRole(m.role || 'member');
    const label = isPendingRole(role) ? `pending ${pendingTargetRole(role)}` : role;
    return `- ${label}: ${String(m.member_phone || '')}`;
  });
  if (!rows.length) {
    await sendMessage(userPhone, 'No members linked yet.');
    return;
  }
  await sendMessage(userPhone, `MEMBERS\n${rows.join('\n')}`);
}

async function handleAddMember(userPhone, tenantId, role, rawPhone) {
  const childId = await getOrCreateDefaultChild(userPhone, tenantId);
  if (!childId) {
    await sendMessage(userPhone, 'Could not load child account.');
    return;
  }
  const normalized = normalizeMemberPhone(rawPhone);
  if (!normalized) {
    await sendMessage(userPhone, 'Invalid phone. Example: add_parent 919876543210');
    return;
  }
  const { data: current } = await supabase
    .from('child_members')
    .select('role')
    .match(withTenant(tenantId, { child_id: childId, member_phone: userPhone }))
    .limit(1);
  const currentRole = Array.isArray(current) && current[0]?.role ? String(current[0].role).toLowerCase() : '';
  if (currentRole !== 'owner') {
    await sendMessage(userPhone, 'Only owner can add members.');
    return;
  }

  await ensureUserExists(normalized, tenantId);
  const memberMatch = withTenant(tenantId, { child_id: childId, member_phone: normalized });
  const { data: existing } = await supabase
    .from('child_members')
    .select('id,role')
    .match(memberMatch)
    .limit(1);
  const targetRole = normalizeRole(role) === 'therapist' ? 'therapist' : 'parent';
  const pendingRole = `pending_${targetRole}`;
  if (Array.isArray(existing) && existing.length) {
    const existingId = existing[0].id;
    const existingRole = normalizeRole(existing[0].role || '');
    if (existingRole === targetRole) {
      await sendMessage(userPhone, `${normalized} is already added as ${targetRole}.`);
      return;
    }
    if (isPendingRole(existingRole)) {
      await supabase.from('child_members').update({ role: pendingRole }).match(withTenant(tenantId, { id: existingId }));
      await sendMessage(userPhone, `Invite is pending for ${normalized} as ${targetRole}.`);
      await sendMessage(
        normalized,
        `You are invited to join Therapy Tracker as ${targetRole}.\nReply "accept_invite" to join or "reject_invite" to decline.`
      );
      await sendInviteDecisionPicker(normalized, targetRole);
      return;
    }
    await supabase.from('child_members').update({ role: targetRole }).match(withTenant(tenantId, { id: existingId }));
    await sendMessage(userPhone, `Updated member role to ${targetRole}: ${normalized}`);
    return;
  }
  const row = withTenant(tenantId, {
    child_id: childId,
    member_phone: normalized,
    role: pendingRole
  });
  const { error } = await supabase.from('child_members').insert(row);
  if (error) {
    await sendMessage(userPhone, `Could not add member: ${error.message}`);
    return;
  }
  await sendMessage(
    userPhone,
    `Invite sent for ${targetRole}: ${normalized}\n` +
    `They must accept before getting access.`
  );
  await sendMessage(
    normalized,
    `You are invited to join Therapy Tracker as ${targetRole}.\nReply "accept_invite" to join or "reject_invite" to decline.`
  );
  await sendInviteDecisionPicker(normalized, targetRole);
}

async function handleDataExport(userPhone, tenantId) {
  const userMatchRow = userMatch(tenantId, userPhone);
  const userPhoneRow = userPhoneMatch(tenantId, userPhone);
  const readRows = async (table, select, match, orderBy) => {
    try {
      let q = supabase.from(table).select(select).match(match);
      if (orderBy) q = q.order(orderBy, { ascending: true });
      const { data, error } = await q;
      if (error) return [];
      return Array.isArray(data) ? data : [];
    } catch (_) {
      return [];
    }
  };
  const [users, configs, sessions, holidays, feedback, payments, consent] = await Promise.all([
    readRows('users', 'phone,timezone,reminders_enabled,reminder_time_hour,is_pro,pro_expires_at,created_at', userMatchRow),
    readRows('monthly_config', '*', userPhoneRow, 'month'),
    readRows('sessions', '*', userPhoneRow, 'date'),
    readRows('holidays', '*', userPhoneRow, 'date'),
    readRows('feedback_notes', '*', userPhoneRow, 'created_at'),
    readRows('subscription_payments', '*', userPhoneRow, 'created_at'),
    readRows('consent_events', '*', userPhoneRow, 'created_at')
  ]);

  const payload = {
    exported_at: new Date().toISOString(),
    user: users[0] || null,
    monthly_config: configs,
    sessions,
    holidays,
    feedback_notes: feedback,
    subscription_payments: payments,
    consent_events: consent
  };
  const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  const filename = `therapy-tracker-export-${Date.now()}.json`;
  await sendDocument(userPhone, buf, filename, 'Your data export', 'application/json');
  await sendMessage(userPhone, 'Data export sent as JSON file.');
}

async function handleDeleteData(userPhone, tenantId) {
  const byUser = userMatch(tenantId, userPhone);
  const byPhone = userPhoneMatch(tenantId, userPhone);
  try {
    const { data: memberships } = await supabase
      .from('child_members')
      .select('child_id')
      .match(withTenant(tenantId, { member_phone: userPhone }));
    const childIds = Array.from(new Set((memberships || []).map((m) => m.child_id).filter(Boolean)));

    if (childIds.length) {
      await supabase.from('child_members').delete().match(withTenant(tenantId, { member_phone: userPhone }));
      for (const childId of childIds) {
        const { data: left } = await supabase
          .from('child_members')
          .select('member_phone,role')
          .match(withTenant(tenantId, { child_id: childId }))
          .limit(50);
        const remaining = Array.isArray(left) ? left : [];
        if (!remaining.length) {
          await supabase.from('children').delete().match(withTenant(tenantId, { id: childId }));
          continue;
        }
        const { data: childRows } = await supabase
          .from('children')
          .select('id,created_by')
          .match(withTenant(tenantId, { id: childId }))
          .limit(1);
        const createdBy = Array.isArray(childRows) && childRows[0]?.created_by ? String(childRows[0].created_by) : '';
        if (createdBy === userPhone) {
          const owner = remaining.find((r) => String(r.role || '').toLowerCase() === 'owner');
          const nextCreatedBy = owner?.member_phone || remaining[0]?.member_phone;
          if (nextCreatedBy) {
            await supabase
              .from('children')
              .update({ created_by: nextCreatedBy })
              .match(withTenant(tenantId, { id: childId }));
          }
        }
      }
    }

    const { data: createdChildren } = await supabase
      .from('children')
      .select('id')
      .match(withTenant(tenantId, { created_by: userPhone }));
    for (const child of (createdChildren || [])) {
      const childId = child?.id;
      if (!childId) continue;
      const { data: left } = await supabase
        .from('child_members')
        .select('member_phone,role')
        .match(withTenant(tenantId, { child_id: childId }))
        .limit(50);
      const remaining = Array.isArray(left) ? left : [];
      if (!remaining.length) {
        await supabase.from('children').delete().match(withTenant(tenantId, { id: childId }));
        continue;
      }
      const owner = remaining.find((r) => String(r.role || '').toLowerCase() === 'owner');
      const nextCreatedBy = owner?.member_phone || remaining[0]?.member_phone;
      if (nextCreatedBy) {
        await supabase
          .from('children')
          .update({ created_by: nextCreatedBy })
          .match(withTenant(tenantId, { id: childId }));
      }
    }

    await supabase.from('feedback_notes').delete().match(byPhone);
    await supabase.from('consent_events').delete().match(byPhone);
    await supabase.from('subscription_payments').delete().match(byPhone);
    await supabase.from('sessions').delete().match(byPhone);
    await supabase.from('holidays').delete().match(byPhone);
    await supabase.from('monthly_config').delete().match(byPhone);
    await supabase.from('users').delete().match(byUser);
    await sendMessage(userPhone, 'Your data has been deleted. You can message anytime to start fresh.');
  } catch (error) {
    console.error('delete data error:', error.message);
    await sendMessage(userPhone, 'Could not delete data right now. Please try again.');
  }
}

function lastNDates(todayStr, n) {
  const base = new Date(`${todayStr}T00:00:00Z`);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function loadMonthlyStats(userPhone, tenantId, month) {
  const { data: configRow, error: cfgErr } = await supabase
    .from('monthly_config')
    .select('*')
    .match(userPhoneMatch(tenantId, userPhone))
    .eq('month', month)
    .single();
  if (cfgErr && !String(cfgErr.message || '').includes('0 rows')) {
    console.error('monthly_config select error:', cfgErr.message);
  }
  if (!configRow) return null;
  const { data: sessions, error: sesErr } = await supabase
    .from('sessions')
    .select('*')
    .match(userPhoneMatch(tenantId, userPhone))
    .eq('month', month);
  if (sesErr) console.error('sessions select error:', sesErr.message);
  const list = Array.isArray(sessions) ? sessions : [];
  const attended = list.filter((s) => s.status === 'attended').length;
  const cancelled = list.filter((s) => s.status === 'cancelled').length;
  const totalSessions = (configRow.paid_sessions || 0) + (configRow.carry_forward || 0);
  const remaining = Math.max(0, totalSessions - attended);
  return { configRow, sessions: list, attended, cancelled, totalSessions, remaining };
}

async function handleStatus(userPhone, user, tenantId) {
  const { today, month } = nowPartsInTimeZone(user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE);
  const stats = await loadMonthlyStats(userPhone, tenantId, month);
  if (!stats) {
    await sendMessage(userPhone, `⚙️ No setup found for ${month}.\nType setup to begin.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const { configRow, attended, cancelled, totalSessions, remaining } = stats;
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric'
  });
  await sendMessage(
    userPhone,
    `📊 STATUS - ${monthLabel}\n` +
    `📅 Today: ${today}\n` +
    `✅ Attended: ${attended}/${totalSessions}\n` +
    `❌ Missed: ${cancelled}\n` +
    `🎯 Remaining: ${remaining}\n` +
    `💸 Rate: INR ${configRow.cost_per_session || 0}`
  );
  await sendQuickMenu(userPhone, tenantId);
}

async function handleWeekly(userPhone, user, tenantId) {
  const tz = user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE;
  const { today } = nowPartsInTimeZone(tz);
  const days = lastNDates(today, 6);
  const currentMonth = today.slice(0, 7);
  const { data: rows, error } = await supabase
    .from('sessions')
    .select('date,status,reason')
    .match(userPhoneMatch(tenantId, userPhone))
    .in('date', days)
    .order('date', { ascending: true });
  if (error) {
    console.error('weekly sessions select error:', error.message);
  }
  const list = Array.isArray(rows) ? rows : [];
  const byDate = new Map();
  const reasonCount = new Map();
  for (const r of list) {
    const date = String(r.date).slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { attended: 0, cancelled: 0 });
    const slot = byDate.get(date);
    if (r.status === 'attended') slot.attended += 1;
    if (r.status === 'cancelled') {
      slot.cancelled += 1;
      const reason = normalizeMissReason(r.reason);
      reasonCount.set(reason, (reasonCount.get(reason) || 0) + 1);
    }
  }
  let attended = 0;
  let missed = 0;
  const timeline = days.slice().reverse().map((d) => {
    const slot = byDate.get(d) || { attended: 0, cancelled: 0 };
    attended += slot.attended;
    missed += slot.cancelled;
    if (slot.attended > 0) return `${d.slice(5)}:A`;
    if (slot.cancelled > 0) return `${d.slice(5)}:M`;
    return `${d.slice(5)}:-`;
  }).join(' | ');
  const totalLogged = attended + missed;
  const consistency = totalLogged > 0 ? Math.round((attended / totalLogged) * 100) : 0;
  const topReason = Array.from(reasonCount.entries()).sort((a, b) => b[1] - a[1])[0];
  const tip = deriveConsistencyTip({
    attended,
    missed,
    topReason: topReason ? topReason[0] : '',
    homeworkHint: '',
    notesCount: 0
  });
  await sendMessage(
    userPhone,
    `📈 WEEKLY INSIGHTS (${currentMonth})\n` +
    `${timeline}\n` +
    `✅ Attended: ${attended}\n` +
    `❌ Missed: ${missed}\n` +
    `🎯 Consistency: ${consistency}%\n` +
    `${topReason ? `📝 Top miss reason: ${topReason[0]}` : '📝 No miss reasons this week'}\n` +
    `💡 Tip: ${tip}`
  );
  await sendQuickMenu(userPhone, tenantId);
}

function monthStartEndIso(month) {
  const m = String(month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) return null;
  const year = parseInt(m.slice(0, 4), 10);
  const mon = parseInt(m.slice(5, 7), 10);
  if (!Number.isInteger(year) || !Number.isInteger(mon) || mon < 1 || mon > 12) return null;
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end = new Date(Date.UTC(year, mon, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function handleWeeklyDigest(userPhone, user, tenantId) {
  const tz = user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE;
  const { today } = nowPartsInTimeZone(tz);
  const days = lastNDates(today, 6);
  const start = new Date(`${days[days.length - 1]}T00:00:00Z`).toISOString();
  const end = new Date(`${today}T23:59:59Z`).toISOString();

  const [sessionsRes, notesRes] = await Promise.all([
    supabase
      .from('sessions')
      .select('date,status,reason,mood')
      .match(userPhoneMatch(tenantId, userPhone))
      .in('date', days),
    supabase
      .from('feedback_notes')
      .select('transcript,summary,created_at')
      .match(userPhoneMatch(tenantId, userPhone))
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false })
      .limit(20)
  ]);
  const sessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : [];
  const notes = Array.isArray(notesRes.data) ? notesRes.data : [];
  const attended = sessions.filter((r) => r.status === 'attended').length;
  const missed = sessions.filter((r) => r.status === 'cancelled').length;
  const total = attended + missed;
  const adherence = total > 0 ? Math.round((attended / total) * 100) : 0;

  const reasonCount = new Map();
  for (const row of sessions) {
    if (row.status !== 'cancelled') continue;
    const key = normalizeMissReason(row.reason);
    reasonCount.set(key, (reasonCount.get(key) || 0) + 1);
  }
  const topReason = Array.from(reasonCount.entries()).sort((a, b) => b[1] - a[1])[0];

  const moodCount = new Map();
  for (const row of sessions) {
    if (row.status !== 'attended') continue;
    const mood = truncateText(row.mood || 'Not set', 20);
    moodCount.set(mood, (moodCount.get(mood) || 0) + 1);
  }
  const topMood = Array.from(moodCount.entries()).sort((a, b) => b[1] - a[1])[0];

  const homeworkHint = notes.map((n) => extractHomeworkFromTranscript(n.transcript)).find(Boolean) || '';
  const tip = deriveConsistencyTip({
    attended,
    missed,
    topReason: topReason ? topReason[0] : '',
    homeworkHint,
    notesCount: notes.length
  });

  await sendMessage(
    userPhone,
    `👪 WEEKLY PARENT DIGEST\n` +
    `🗓️ ${days[days.length - 1]} to ${today}\n` +
    `✅ Attended: ${attended}\n` +
    `❌ Missed: ${missed}\n` +
    `🎯 Adherence: ${adherence}%\n` +
    `${topMood ? `🙂 Mood trend: ${topMood[0]}` : '🙂 Mood trend: Not enough data'}\n` +
    `${topReason ? `📝 Main miss reason: ${topReason[0]}` : '📝 Main miss reason: None'}\n` +
    `📌 Therapist notes this week: ${notes.length}\n` +
    `💡 Action for next week: ${tip}`
  );
  await sendQuickMenu(userPhone, tenantId);
}

async function handleMissedAnalytics(userPhone, user, tenantId) {
  const tz = user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE;
  const { month } = nowPartsInTimeZone(tz);
  const { data: rows, error } = await supabase
    .from('sessions')
    .select('date,reason')
    .match(userPhoneMatch(tenantId, userPhone))
    .eq('month', month)
    .eq('status', 'cancelled')
    .order('date', { ascending: true });
  if (error) {
    console.error('missed analytics sessions read error:', error.message);
  }
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    await sendMessage(userPhone, `📉 MISSED ANALYTICS (${month})\nNo missed sessions this month.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }

  const reasonCount = new Map();
  const weekdayCount = new Map();
  for (const row of list) {
    const reason = normalizeMissReason(row.reason);
    reasonCount.set(reason, (reasonCount.get(reason) || 0) + 1);
    const d = new Date(`${String(row.date).slice(0, 10)}T00:00:00Z`);
    const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    weekdayCount.set(wd, (weekdayCount.get(wd) || 0) + 1);
  }

  const total = list.length;
  const topReasons = Array.from(reasonCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, c]) => `• ${k}: ${c} (${Math.round((c / total) * 100)}%)`)
    .join('\n');
  const topDay = Array.from(weekdayCount.entries()).sort((a, b) => b[1] - a[1])[0];

  await sendMessage(
    userPhone,
    `📉 MISSED ANALYTICS (${month})\n` +
    `Total missed: ${total}\n` +
    `Top reasons:\n${topReasons}\n` +
    `${topDay ? `High-risk day: ${topDay[0]} (${topDay[1]})\n` : ''}` +
    `💡 Tip: Pre-confirm slot on the high-risk day to reduce misses.`
  );
  await sendQuickMenu(userPhone, tenantId);
}

async function buildMonthlyTrendInsights({ userPhone, tenantId, month, sessions }) {
  const weeklyBuckets = new Map([
    ['Week 1', { attended: 0, missed: 0 }],
    ['Week 2', { attended: 0, missed: 0 }],
    ['Week 3', { attended: 0, missed: 0 }],
    ['Week 4+', { attended: 0, missed: 0 }]
  ]);
  const reasonCount = new Map();
  const moodCount = new Map();

  for (const row of sessions || []) {
    const date = String(row.date || '').slice(0, 10);
    const day = parseInt(date.slice(8, 10), 10);
    const wk = Number.isInteger(day) && day > 0 ? (day <= 7 ? 'Week 1' : day <= 14 ? 'Week 2' : day <= 21 ? 'Week 3' : 'Week 4+') : 'Week 4+';
    const bucket = weeklyBuckets.get(wk);
    if (row.status === 'attended') {
      bucket.attended += 1;
      const mood = truncateText(row.mood || '', 20);
      if (mood) moodCount.set(mood, (moodCount.get(mood) || 0) + 1);
    } else if (row.status === 'cancelled') {
      bucket.missed += 1;
      const reason = normalizeMissReason(row.reason);
      reasonCount.set(reason, (reasonCount.get(reason) || 0) + 1);
    }
  }

  const bounds = monthStartEndIso(month);
  let notes = [];
  if (bounds) {
    const { data } = await supabase
      .from('feedback_notes')
      .select('transcript,summary,created_at')
      .match(userPhoneMatch(tenantId, userPhone))
      .gte('created_at', bounds.startIso)
      .lt('created_at', bounds.endIso)
      .order('created_at', { ascending: false })
      .limit(50);
    notes = Array.isArray(data) ? data : [];
  }
  const highlights = notes
    .map((n) => truncateText(n.summary || n.transcript || '', 110))
    .filter(Boolean)
    .slice(0, 3);
  const homeworkHints = notes.map((n) => extractHomeworkFromTranscript(n.transcript)).filter(Boolean).slice(0, 2);

  return {
    weeklyBuckets,
    reasonCount,
    moodCount,
    noteCount: notes.length,
    highlights,
    homeworkHints
  };
}

async function buildMonthlyReportPdf({ userPhone, month, stats, trends }) {
  const { configRow, sessions, attended, cancelled, totalSessions, remaining } = stats;
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
  });
  doc.on('data', (c) => chunks.push(c));
  doc.fontSize(18).text(`Therapy Tracker Monthly Report`);
  doc.moveDown(0.3);
  doc.fontSize(11).text(`Phone: ${userPhone}`);
  doc.fontSize(11).text(`Month: ${month}`);
  doc.moveDown(0.8);
  doc.fontSize(13).text('Summary');
  doc.fontSize(11).text(`Attended: ${attended}`);
  doc.fontSize(11).text(`Missed: ${cancelled}`);
  doc.fontSize(11).text(`Remaining: ${remaining}`);
  doc.fontSize(11).text(`Total planned: ${totalSessions}`);
  doc.fontSize(11).text(`Cost per session: INR ${configRow.cost_per_session || 0}`);
  doc.fontSize(11).text(`Paid sessions: ${configRow.paid_sessions || 0}`);
  doc.fontSize(11).text(`Carry forward: ${configRow.carry_forward || 0}`);
  if (trends) {
    doc.moveDown(0.8);
    doc.fontSize(13).text('Trend snapshot');
    for (const [week, data] of trends.weeklyBuckets.entries()) {
      doc.fontSize(10).text(`${week}: Attended ${data.attended} | Missed ${data.missed}`);
    }
    doc.moveDown(0.4);
    const reasons = Array.from(trends.reasonCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    doc.fontSize(11).text('Top missed reasons');
    if (!reasons.length) {
      doc.fontSize(10).text('No missed-session reasons this month.');
    } else {
      for (const [reason, count] of reasons) {
        doc.fontSize(10).text(`- ${reason}: ${count}`);
      }
    }
    doc.moveDown(0.3);
    const moods = Array.from(trends.moodCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    doc.fontSize(11).text('Mood trend');
    if (!moods.length) {
      doc.fontSize(10).text('No mood entries this month.');
    } else {
      for (const [mood, count] of moods) {
        doc.fontSize(10).text(`- ${mood}: ${count}`);
      }
    }
    doc.moveDown(0.3);
    doc.fontSize(11).text(`Therapist notes captured: ${trends.noteCount}`);
    if (trends.homeworkHints.length) {
      doc.fontSize(11).text('Homework highlights');
      for (const line of trends.homeworkHints) {
        doc.fontSize(10).text(`- ${line}`);
      }
    }
    if (trends.highlights.length) {
      doc.moveDown(0.3);
      doc.fontSize(11).text('Recent note highlights');
      for (const line of trends.highlights) {
        doc.fontSize(10).text(`- ${line}`);
      }
    }
  }
  doc.moveDown(0.8);
  doc.fontSize(13).text('Session log (latest first)');
  const sorted = sessions.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const limit = Math.min(sorted.length, 80);
  for (let i = 0; i < limit; i++) {
    const r = sorted[i];
    const date = String(r.date).slice(0, 10);
    const status = r.status === 'attended' ? 'Attended' : 'Missed';
    const reason = r.reason ? ` (${String(r.reason).slice(0, 60)})` : '';
    const mood = r.mood ? ` [Mood: ${String(r.mood).slice(0, 24)}]` : '';
    doc.fontSize(10).text(`${date} - ${status}${reason}${mood}`);
  }
  if (sorted.length > limit) {
    doc.moveDown(0.5);
    doc.fontSize(10).text(`... ${sorted.length - limit} more rows omitted`);
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

async function handleReportDownload(userPhone, user, tenantId) {
  if (!isProActive(user)) {
    await sendMessage(userPhone, 'Report PDF is a Pro feature.');
    await sendProUpsell(userPhone);
    return;
  }
  const tz = user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE;
  const { month } = nowPartsInTimeZone(tz);
  const stats = await loadMonthlyStats(userPhone, tenantId, month);
  if (!stats) {
    await sendMessage(userPhone, `No setup found for ${month}. Type setup to begin.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const trends = await buildMonthlyTrendInsights({ userPhone, tenantId, month, sessions: stats.sessions });
  const pdf = await buildMonthlyReportPdf({ userPhone, month, stats, trends });
  await sendDocument(userPhone, pdf, `Therapy-Report-${month}.pdf`, `Monthly report ${month}`);
  await sendMessage(userPhone, 'Report sent as PDF.');
  await sendQuickMenu(userPhone, tenantId);
}

async function listOwnedChildIds(userPhone, tenantId) {
  const set = new Set();
  try {
    const { data: links } = await supabase
      .from('child_members')
      .select('child_id')
      .match(withTenant(tenantId, { member_phone: userPhone, role: 'owner' }))
      .limit(200);
    for (const row of (links || [])) {
      if (row?.child_id) set.add(row.child_id);
    }
    const { data: created } = await supabase
      .from('children')
      .select('id')
      .match(withTenant(tenantId, { created_by: userPhone }))
      .limit(200);
    for (const row of (created || [])) {
      if (row?.id) set.add(row.id);
    }
  } catch (_) {
  }
  return Array.from(set.values());
}

function deriveRiskLevel(attended, missed) {
  const total = Math.max(0, attended + missed);
  if (missed >= 3) return 'High';
  if (total >= 4 && (attended / total) < 0.6) return 'High';
  if (missed >= 1) return 'Medium';
  return 'Low';
}

async function handleClinicAdminOverview(userPhone, user, tenantId) {
  const childIds = await listOwnedChildIds(userPhone, tenantId);
  if (!childIds.length) {
    await sendMessage(userPhone, '🏥 CLINIC ADMIN\nNo children found for owner account yet.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const tz = user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE;
  const { month } = nowPartsInTimeZone(tz);
  const [membersRes, sessionsRes] = await Promise.all([
    supabase
      .from('child_members')
      .select('child_id,member_phone,role')
      .match(withTenant(tenantId, {}))
      .in('child_id', childIds),
    supabase
      .from('sessions')
      .select('child_id,status')
      .match(withTenant(tenantId, {}))
      .in('child_id', childIds)
      .eq('month', month)
  ]);
  const members = Array.isArray(membersRes.data) ? membersRes.data : [];
  const sessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : [];
  const uniqueMembers = new Set(members.map((m) => String(m.member_phone || '').trim()).filter(Boolean));
  const roleCount = new Map();
  for (const m of members) {
    const role = normalizeRole(m.role || 'member');
    roleCount.set(role, (roleCount.get(role) || 0) + 1);
  }
  const attended = sessions.filter((s) => s.status === 'attended').length;
  const missed = sessions.filter((s) => s.status === 'cancelled').length;
  const activeChildren = new Set(sessions.map((s) => s.child_id)).size;
  await sendMessage(
    userPhone,
    `🏥 CLINIC ADMIN (${month})\n` +
    `👶 Children: ${childIds.length}\n` +
    `👥 Members: ${uniqueMembers.size}\n` +
    `- Parents: ${roleCount.get('parent') || 0}\n` +
    `- Therapists: ${roleCount.get('therapist') || 0}\n` +
    `✅ Attended logs: ${attended}\n` +
    `❌ Missed logs: ${missed}\n` +
    `📌 Active children this month: ${activeChildren}\n` +
    `Commands: admin_members, admin_risk`
  );
  await sendQuickMenu(userPhone, tenantId);
}

async function handleClinicAdminMembers(userPhone, tenantId) {
  const childIds = await listOwnedChildIds(userPhone, tenantId);
  if (!childIds.length) {
    await sendMessage(userPhone, 'No owned children found.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const { data: rows, error } = await supabase
    .from('child_members')
    .select('child_id,member_phone,role,created_at')
    .match(withTenant(tenantId, {}))
    .in('child_id', childIds)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) {
    await sendMessage(userPhone, `Could not fetch members: ${error.message}`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    await sendMessage(userPhone, 'No members found.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const roleCount = new Map();
  for (const row of list) {
    const role = normalizeRole(row.role || 'member');
    roleCount.set(role, (roleCount.get(role) || 0) + 1);
  }
  const preview = list.slice(0, 15).map((row) => {
    const role = normalizeRole(row.role || 'member');
    return `C${row.child_id} ${role}: ${row.member_phone}`;
  }).join('\n');
  await sendMessage(
    userPhone,
    `👥 CLINIC MEMBERS\n` +
    `Owners: ${roleCount.get('owner') || 0}, Parents: ${roleCount.get('parent') || 0}, Therapists: ${roleCount.get('therapist') || 0}\n` +
    `${preview}\n` +
    `${list.length > 15 ? `...and ${list.length - 15} more` : ''}`
  );
  await sendQuickMenu(userPhone, tenantId);
}

async function handleClinicAdminRisk(userPhone, user, tenantId) {
  const childIds = await listOwnedChildIds(userPhone, tenantId);
  if (!childIds.length) {
    await sendMessage(userPhone, 'No owned children found.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const tz = user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE;
  const { today } = nowPartsInTimeZone(tz);
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 13);
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);

  const [sessionsRes, childrenRes] = await Promise.all([
    supabase
      .from('sessions')
      .select('child_id,status,date')
      .match(withTenant(tenantId, {}))
      .in('child_id', childIds)
      .gte('date', startIso)
      .lte('date', endIso),
    supabase
      .from('children')
      .select('id,name')
      .match(withTenant(tenantId, {}))
      .in('id', childIds)
  ]);
  const sessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : [];
  const nameById = new Map((childrenRes.data || []).map((c) => [c.id, c.name || `Child ${c.id}`]));
  const byChild = new Map();
  for (const id of childIds) byChild.set(id, { attended: 0, missed: 0 });
  for (const row of sessions) {
    if (!row?.child_id) continue;
    const slot = byChild.get(row.child_id) || { attended: 0, missed: 0 };
    if (row.status === 'attended') slot.attended += 1;
    if (row.status === 'cancelled') slot.missed += 1;
    byChild.set(row.child_id, slot);
  }
  const ranked = Array.from(byChild.entries()).map(([childId, stats]) => ({
    childId,
    name: nameById.get(childId) || `Child ${childId}`,
    attended: stats.attended,
    missed: stats.missed,
    risk: deriveRiskLevel(stats.attended, stats.missed)
  }));
  ranked.sort((a, b) => {
    const score = (r) => (r.risk === 'High' ? 3 : r.risk === 'Medium' ? 2 : 1);
    const diff = score(b) - score(a);
    if (diff) return diff;
    return b.missed - a.missed;
  });
  const lines = ranked.slice(0, 12).map((row) =>
    `${row.name}: ${row.risk} (A:${row.attended}, M:${row.missed})`
  );
  await sendMessage(
    userPhone,
    `⚠️ RISK WATCH (last 14 days)\n` +
    `${lines.join('\n')}\n` +
    `Tip: Reach out first to High-risk rows and lock next-week slots.`
  );
  await sendQuickMenu(userPhone, tenantId);
}

function normalizeTheme(value) {
  const t = String(value || '').trim().toLowerCase();
  if (t === 'ocean') return 'ocean';
  if (t === 'forest') return 'forest';
  return 'sunrise';
}

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function generateReferralCode(userPhone) {
  const digits = String(userPhone || '').replace(/\D/g, '');
  const last4 = digits.slice(-4).padStart(4, '0');
  const entropy = Buffer.from(String(userPhone || '')).toString('base64').replace(/[^A-Z0-9]/ig, '').toUpperCase().slice(0, 4).padEnd(4, 'X');
  return `TT${last4}${entropy}`;
}

async function setUserLocale(userPhone, tenantId, locale) {
  const value = normalizeLocale(locale);
  try {
    const { error } = await supabase.from('users').update({ locale: value }).match(userMatch(tenantId, userPhone));
    if (error && /locale/i.test(error.message || '')) return { ok: false, schemaMissing: true };
    if (error) return { ok: false, error };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

function readUserLocale(user) {
  if (!user) return 'en';
  return normalizeLocale(user.locale || 'en');
}

async function setUserTheme(userPhone, tenantId, theme) {
  const value = normalizeTheme(theme);
  try {
    const { error } = await supabase.from('users').update({ theme: value }).match(userMatch(tenantId, userPhone));
    if (error && /theme/i.test(error.message || '')) return { ok: false, schemaMissing: true };
    if (error) return { ok: false, error };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

async function extendProDays(userPhone, tenantId, days, reason) {
  const n = Math.max(1, parseInt(String(days || 0), 10));
  const { data: userRow, error } = await supabase
    .from('users')
    .select('pro_expires_at,is_pro')
    .match(userMatch(tenantId, userPhone))
    .single();
  if (error && /pro_expires_at|is_pro/i.test(error.message || '')) {
    return { ok: false, schemaMissing: true };
  }
  if (error) return { ok: false, error };
  const nowMs = Date.now();
  const currentExpiry = Date.parse(userRow?.pro_expires_at || '');
  const baseMs = Number.isFinite(currentExpiry) && currentExpiry > nowMs ? currentExpiry : nowMs;
  const nextExpiry = new Date(baseMs + (n * 24 * 60 * 60 * 1000)).toISOString();
  const { error: upErr } = await supabase
    .from('users')
    .update({ is_pro: true, pro_expires_at: nextExpiry })
    .match(userMatch(tenantId, userPhone));
  if (upErr && /pro_expires_at|is_pro/i.test(upErr.message || '')) return { ok: false, schemaMissing: true };
  if (upErr) return { ok: false, error: upErr };
  await recordConsentEvent(userPhone, tenantId, 'reward_applied', { days: n, reason: reason || 'reward' });
  return { ok: true, expiresAt: nextExpiry, days: n };
}

async function getOrCreateReferralCode(userPhone, tenantId) {
  const fallbackCode = generateReferralCode(userPhone);
  try {
    const { data: row, error } = await supabase
      .from('users')
      .select('referral_code')
      .match(userMatch(tenantId, userPhone))
      .single();
    if (error && /referral_code/i.test(error.message || '')) return { ok: false, schemaMissing: true, code: fallbackCode };
    if (error) return { ok: false, error };
    const existing = normalizeCode(row?.referral_code || '');
    if (existing) return { ok: true, code: existing };
    const updateCode = fallbackCode;
    const { error: upErr } = await supabase.from('users').update({ referral_code: updateCode }).match(userMatch(tenantId, userPhone));
    if (upErr && /referral_code/i.test(upErr.message || '')) return { ok: false, schemaMissing: true, code: fallbackCode };
    if (upErr) return { ok: false, error: upErr };
    return { ok: true, code: updateCode };
  } catch (error) {
    return { ok: false, error, code: fallbackCode };
  }
}

async function handleReferralCode(userPhone, user, tenantId) {
  const locale = readUserLocale(user);
  const codeRes = await getOrCreateReferralCode(userPhone, tenantId);
  if (codeRes.schemaMissing) {
    await sendMessage(userPhone, `Referral setup pending. Run database_low_priority.sql, then retry.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (!codeRes.ok) {
    await sendMessage(userPhone, 'Could not generate referral code right now.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const rewardDays = 7;
  await sendMessage(userPhone, i18nText(locale, 'referral_intro', { code: codeRes.code, days: rewardDays }));
  await sendQuickMenu(userPhone, tenantId);
}

async function handleRedeemReferral(userPhone, user, tenantId, rawCode) {
  const locale = readUserLocale(user);
  const code = normalizeCode(rawCode);
  if (!code) {
    await sendMessage(userPhone, i18nText(locale, 'coupon_prompt'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const rewardDays = 7;
  const { data: refUser, error: refErr } = await supabase
    .from('users')
    .select('phone,referral_code')
    .match(withTenant(tenantId, { referral_code: code }))
    .limit(1);
  if (refErr && /referral_code/i.test(refErr.message || '')) {
    await sendMessage(userPhone, `Referral setup pending. Run database_low_priority.sql, then retry.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (refErr) {
    await sendMessage(userPhone, 'Could not validate referral now.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const referrer = Array.isArray(refUser) && refUser.length ? refUser[0] : null;
  if (!referrer?.phone) {
    await sendMessage(userPhone, i18nText(locale, 'referral_invalid'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (String(referrer.phone) === String(userPhone)) {
    await sendMessage(userPhone, i18nText(locale, 'referral_self'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }

  const referralRow = withTenant(tenantId, {
    referrer_phone: referrer.phone,
    referred_phone: userPhone,
    coupon_code: code,
    reward_days: rewardDays,
    created_at: new Date().toISOString()
  });
  const { error: insErr } = await supabase.from('referral_events').insert(referralRow);
  if (insErr && /referral_events|referred_phone|relation.*referral_events/i.test(insErr.message || '')) {
    await sendMessage(userPhone, `Referral setup pending. Run database_low_priority.sql, then retry.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (insErr && String(insErr.code) === '23505') {
    await sendMessage(userPhone, i18nText(locale, 'referral_already'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (insErr) {
    await sendMessage(userPhone, 'Could not apply referral right now.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }

  const meReward = await extendProDays(userPhone, tenantId, rewardDays, 'referral_redeem');
  const refReward = await extendProDays(referrer.phone, tenantId, rewardDays, 'referral_referrer');
  if (!meReward.ok || !refReward.ok) {
    await sendMessage(userPhone, 'Referral recorded, but reward credit failed. Please contact support.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }

  await sendMessage(userPhone, i18nText(locale, 'referral_done', { days: rewardDays }));
  await sendMessage(
    referrer.phone,
    `🎉 Referral reward unlocked.\n${userPhone} used your code ${code}.\n+${rewardDays} Pro days added.`
  );
  await sendQuickMenu(userPhone, tenantId);
}

async function handleApplyCoupon(userPhone, user, tenantId, rawCode) {
  const locale = readUserLocale(user);
  const code = normalizeCode(rawCode);
  if (!code) {
    await sendMessage(userPhone, i18nText(locale, 'coupon_prompt'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const { data: rows, error } = await supabase
    .from('coupon_codes')
    .select('*')
    .match(withTenant(tenantId, { code, active: true }))
    .limit(1);
  if (error && /coupon_codes|relation.*coupon_codes/i.test(error.message || '')) {
    await sendMessage(userPhone, `Coupon setup pending. Run database_low_priority.sql, then retry.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (error) {
    await sendMessage(userPhone, 'Could not validate coupon right now.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const coupon = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!coupon) {
    await sendMessage(userPhone, i18nText(locale, 'coupon_invalid'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (coupon.expires_at && Date.parse(coupon.expires_at) < Date.now()) {
    await sendMessage(userPhone, i18nText(locale, 'coupon_invalid'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (Number.isInteger(coupon.max_redemptions) && Number(coupon.used_count || 0) >= coupon.max_redemptions) {
    await sendMessage(userPhone, i18nText(locale, 'coupon_invalid'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }

  const { error: redErr } = await supabase.from('coupon_redemptions').insert(withTenant(tenantId, {
    code,
    user_phone: userPhone,
    applied_days: coupon.discount_type === 'days' ? Math.max(0, parseInt(coupon.discount_value || 0, 10)) : 0,
    created_at: new Date().toISOString()
  }));
  if (redErr && String(redErr.code) === '23505') {
    await sendMessage(userPhone, i18nText(locale, 'coupon_already'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (redErr && /coupon_redemptions|relation.*coupon_redemptions/i.test(redErr.message || '')) {
    await sendMessage(userPhone, `Coupon setup pending. Run database_low_priority.sql, then retry.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  if (redErr) {
    await sendMessage(userPhone, 'Could not redeem coupon right now.');
    await sendQuickMenu(userPhone, tenantId);
    return;
  }

  await supabase
    .from('coupon_codes')
    .update({ used_count: Number(coupon.used_count || 0) + 1 })
    .match(withTenant(tenantId, { code }));

  const addDays = coupon.discount_type === 'days'
    ? Math.max(0, parseInt(coupon.discount_value || 0, 10))
    : 0;
  if (addDays <= 0) {
    await sendMessage(userPhone, `Coupon accepted.\nNo day credit configured for this coupon type.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const reward = await extendProDays(userPhone, tenantId, addDays, `coupon:${code}`);
  if (!reward.ok) {
    await sendMessage(userPhone, `Coupon accepted, but pro extension failed. Contact support.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  await sendMessage(userPhone, i18nText(locale, 'coupon_done', { days: addDays }));
  await sendQuickMenu(userPhone, tenantId);
}

function badgeForStreak(value) {
  if (value >= 30) return 'Legend 30';
  if (value >= 14) return 'Gold 14';
  if (value >= 7) return 'Silver 7';
  if (value >= 3) return 'Bronze 3';
  return '';
}

function nextStreakMilestone(current) {
  const marks = [3, 7, 14, 30, 60];
  for (const m of marks) {
    if (current < m) return m;
  }
  return current + 30;
}

async function computeStreakStats(userPhone, tenantId) {
  const { data: rows } = await supabase
    .from('sessions')
    .select('date,status')
    .match(userPhoneMatch(tenantId, userPhone))
    .eq('status', 'attended')
    .order('date', { ascending: true });
  const dates = Array.from(new Set((rows || []).map((r) => String(r.date || '').slice(0, 10)).filter(Boolean)));
  if (!dates.length) return { current: 0, best: 0 };
  const set = new Set(dates);
  const today = new Date().toISOString().slice(0, 10);
  let cursor = today;
  let current = 0;
  while (set.has(cursor)) {
    current += 1;
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
  }
  let best = 0;
  let run = 0;
  let prev = '';
  for (const date of dates) {
    if (!prev) {
      run = 1;
    } else {
      const p = new Date(`${prev}T00:00:00Z`);
      p.setUTCDate(p.getUTCDate() + 1);
      const expected = p.toISOString().slice(0, 10);
      run = expected === date ? run + 1 : 1;
    }
    if (run > best) best = run;
    prev = date;
  }
  return { current, best };
}

async function handleStreakStatus(userPhone, user, tenantId) {
  const locale = readUserLocale(user);
  const streak = await computeStreakStats(userPhone, tenantId);
  if (!streak.current && !streak.best) {
    await sendMessage(userPhone, i18nText(locale, 'streak_empty'));
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const next = nextStreakMilestone(streak.current);
  await sendMessage(userPhone, i18nText(locale, 'streak_status', {
    current: streak.current,
    best: streak.best,
    next
  }));
  await sendQuickMenu(userPhone, tenantId);
}

async function maybeSendStreakMilestone(userPhone, user, tenantId) {
  const locale = readUserLocale(user);
  const streak = await computeStreakStats(userPhone, tenantId);
  const badge = badgeForStreak(streak.current);
  const exactMilestones = new Set([3, 7, 14, 30, 60]);
  if (!badge || !exactMilestones.has(streak.current)) return;
  await sendMessage(userPhone, i18nText(locale, 'streak_badge', { badge, current: streak.current }));
}

async function handleMessage(userPhone, message, tenantId) {
  try {
    const tenant = config.ENABLE_TENANT_SCOPING ? (tenantId || config.PHONE_NUMBER_ID || 'default') : null;
    if (!message) {
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .match(userMatch(tenant, userPhone))
      .single();
    if (userErr) {
      console.error('Supabase users select error:', userErr.message);
    }

    if (!user) {
      await createUser(userPhone, tenant);
      await sendMessage(userPhone,
        `👋 Welcome to Therapy Tracker\n` +
        `⚙️ Type 'setup' to begin`
      );
      await sendQuickMenu(userPhone, tenant);
      return;
    }

    const command = String(message || '').trim().toLowerCase();
    const memberContext = await resolveMemberContext(userPhone, tenant);
    const memberRole = memberContext.role || 'owner';
    const requirePermission = async (permission) => {
      if (hasPermission(memberRole, permission)) return true;
      await sendMessage(userPhone, permissionDeniedText(memberRole, permission));
      await sendQuickMenu(userPhone, tenant);
      return false;
    };

    if (OPT_OUT_COMMANDS.has(command)) {
      await supabase.from('users').update({ reminders_enabled: false, waiting_for: null }).match(userMatch(tenant, userPhone));
      await recordConsentEvent(userPhone, tenant, 'opt_out', { channel: 'whatsapp', text: command });
      await sendMessage(userPhone, 'You are opted out. Reply START anytime to opt in again.');
      return;
    }
    if (OPT_IN_COMMANDS.has(command)) {
      await supabase.from('users').update({ reminders_enabled: true, waiting_for: null }).match(userMatch(tenant, userPhone));
      await recordConsentEvent(userPhone, tenant, 'opt_in', { channel: 'whatsapp', text: command });
      await sendMessage(userPhone, 'You are opted in again.');
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'consent_status') {
      const state = await getConsentState(userPhone, tenant);
      const label = state.optedOut ? 'OPTED OUT' : 'OPTED IN';
      const when = state.at ? `\nLast change: ${formatIsoDate(state.at)}` : '';
      await sendMessage(userPhone, `Consent status: ${label}${when}`);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    const consentState = await getConsentState(userPhone, tenant);
    if (consentState.optedOut && !ALLOWED_WHILE_OPTED_OUT.has(command)) {
      await sendMessage(userPhone, 'You are currently opted out. Reply START to opt in again.');
      return;
    }

    if (isPendingRole(memberRole)) {
      if (isInviteAcceptCommand(command)) {
        await handleInviteAccept(userPhone, tenant);
        return;
      }
      if (isInviteRejectCommand(command)) {
        await handleInviteReject(userPhone, tenant);
        return;
      }
      await sendMessage(
        userPhone,
        `You have a pending invite as ${pendingTargetRole(memberRole)}.\n` +
        `Reply "accept_invite" to join or "reject_invite" to decline.`
      );
      await sendInviteDecisionPicker(userPhone, pendingTargetRole(memberRole));
      return;
    }

    if (isInviteAcceptCommand(command)) {
      await handleInviteAccept(userPhone, tenant);
      return;
    }
    if (isInviteRejectCommand(command)) {
      await handleInviteReject(userPhone, tenant);
      return;
    }

    const bulkRequest = parseBulkLogCommand(command);
    if (bulkRequest) {
      if (bulkRequest.type === 'help') {
        await sendBulkLogHelp(userPhone);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (bulkRequest.error) {
        await sendMessage(userPhone, `⚠️ ${bulkRequest.error}`);
        await sendBulkLogHelp(userPhone);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (!await requirePermission('log')) return;
      const result = await applyBulkLog({
        userPhone,
        tenantId: tenant,
        status: bulkRequest.status,
        dates: bulkRequest.dates,
        reason: bulkRequest.reason
      });
      const label = bulkRequest.status === 'attended' ? '✅ Attended' : '❌ Missed';
      await sendMessage(
        userPhone,
        `${label} bulk update complete\n` +
        `Inserted: ${result.inserted}\n` +
        `Skipped duplicate: ${result.skippedDuplicate}\n` +
        `Skipped conflict: ${result.skippedConflict}\n` +
        `Skipped future dates: ${result.skippedFuture}`
      );
      await sendQuickMenu(userPhone, tenant);
      return;
    }

    if (command === 'cancel' || command === 'back' || command === 'menu') {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenant, userPhone));
      await sendQuickMenu(userPhone, tenant);
      return;
    }

    if (command === 'undo' || command === 'undo_last') {
      if (!await requirePermission('log')) return;
      await handleUndo(userPhone, tenant);
      return;
    }

    if (command === 'plan' || command === 'my_plan' || command === 'plan_status') {
      if (!await requirePermission('billing')) return;
      await handlePlanStatus(userPhone, user);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'payment_status' || command === 'billing_status') {
      if (!await requirePermission('billing')) return;
      await handlePaymentStatus(userPhone, user, tenant);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    const reconcileMatch = command.match(/^reconcile_payment\s+(.+)$/);
    if (reconcileMatch) {
      if (!await requirePermission('billing')) return;
      await handleReconcilePayment(userPhone, reconcileMatch[1], user, tenant);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'export_data' || command === 'export_my_data' || command === 'data_export') {
      if (!await requirePermission('data')) return;
      await handleDataExport(userPhone, tenant);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'delete_data' || command === 'delete_my_data' || command === 'erase_data') {
      if (!await requirePermission('data')) return;
      await supabase.from('users').update({ waiting_for: 'delete_data_confirm' }).match(userMatch(tenant, userPhone));
      await sendYesNo(userPhone, 'Delete all your data permanently?');
      return;
    }
    if (command === 'members' || command === 'team') {
      if (!await requirePermission('members_view')) return;
      await handleMembersList(userPhone, tenant);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'language' || command === 'lang') {
      const locale = readUserLocale(user);
      await sendMessage(userPhone, i18nText(locale, 'language_prompt'));
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command.startsWith('lang:') || command.startsWith('language ')) {
      const localeArg = command.startsWith('lang:') ? command.slice(5) : command.slice('language '.length);
      const target = normalizeLocale(localeArg);
      const setRes = await setUserLocale(userPhone, tenant, target);
      if (!setRes.ok && setRes.schemaMissing) {
        await sendMessage(userPhone, `Language setup pending. Run database_low_priority.sql then retry.`);
      } else if (!setRes.ok) {
        await sendMessage(userPhone, 'Could not update language right now.');
      } else {
        await sendMessage(userPhone, i18nText(target, 'language_saved', { lang: target }));
      }
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'theme') {
      const locale = readUserLocale(user);
      await sendMessage(userPhone, i18nText(locale, 'theme_prompt'));
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command.startsWith('theme:') || command.startsWith('theme_')) {
      const themeArg = command.startsWith('theme:') ? command.slice(6) : command.slice('theme_'.length);
      const targetTheme = normalizeTheme(themeArg);
      const saveTheme = await setUserTheme(userPhone, tenant, targetTheme);
      const locale = readUserLocale(user);
      if (!saveTheme.ok && saveTheme.schemaMissing) {
        await sendMessage(userPhone, `Theme setup pending. Run database_low_priority.sql then retry.`);
      } else if (!saveTheme.ok) {
        await sendMessage(userPhone, 'Could not update theme right now.');
      } else {
        await sendMessage(userPhone, i18nText(locale, 'theme_saved', { theme: targetTheme }));
      }
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'streak' || command === 'streak_status' || command === 'journey') {
      if (!await requirePermission('view')) return;
      await handleStreakStatus(userPhone, user, tenant);
      return;
    }
    if (command === 'my_referral' || command === 'referral' || command === 'referral_code') {
      if (!await requirePermission('billing')) return;
      await handleReferralCode(userPhone, user, tenant);
      return;
    }
    const redeemMatch = command.match(/^redeem\s+(.+)$/);
    if (redeemMatch) {
      if (!await requirePermission('billing')) return;
      await handleRedeemReferral(userPhone, user, tenant, redeemMatch[1]);
      return;
    }
    const couponMatch = command.match(/^(?:apply_coupon|coupon)\s+(.+)$/);
    if (couponMatch) {
      if (!await requirePermission('billing')) return;
      await handleApplyCoupon(userPhone, user, tenant, couponMatch[1]);
      return;
    }
    if (command === 'invite_member' || command === 'invite') {
      if (!await requirePermission('members_manage')) return;
      await sendInviteTypePicker(userPhone);
      return;
    }
    if (command === 'invite_parent') {
      if (!await requirePermission('members_manage')) return;
      await supabase.from('users').update({ waiting_for: 'invite_parent_phone' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, 'Send parent phone with country code.\nExample: 919876543210');
      return;
    }
    if (command === 'invite_therapist') {
      if (!await requirePermission('members_manage')) return;
      await supabase.from('users').update({ waiting_for: 'invite_therapist_phone' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, 'Send therapist phone with country code.\nExample: 919876543210');
      return;
    }
    const addParentMatch = command.match(/^add_parent\s+(.+)$/);
    if (addParentMatch) {
      if (!await requirePermission('members_manage')) return;
      await handleAddMember(userPhone, tenant, 'parent', addParentMatch[1]);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    const addTherapistMatch = command.match(/^add_therapist\s+(.+)$/);
    if (addTherapistMatch) {
      if (!await requirePermission('members_manage')) return;
      await handleAddMember(userPhone, tenant, 'therapist', addTherapistMatch[1]);
      await sendQuickMenu(userPhone, tenant);
      return;
    }

    if (user.waiting_for) {
      const handled = await handleWaitingResponse(userPhone, message, user, tenant, memberRole);
      if (handled) return;
    }

    if (message === 'note_template' || message === 'structured_note' || message === 'therapist_note') {
      if (!await requirePermission('notes')) return;
      await supabase.from('users').update({ waiting_for: 'note_template:goal' }).match(userMatch(tenant, userPhone));
      await sendMessage(
        userPhone,
        `🧾 Structured therapy note\nStep 1/4: Goal\n` +
        `Reply with today's therapy goal in one line.`
      );
      return;
    }
    if (message === 'feedback' || message === 'feedback_note' || message === 'note') {
      if (!await requirePermission('notes')) return;
      await supabase.from('users').update({ waiting_for: 'feedback_note' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, 'Send a voice note or type the feedback.');
      return;
    }
    const voiceNote = extractVoiceNote(message);
    if (voiceNote) {
      if (!await requirePermission('notes')) return;
      const { ok, summary } = await saveFeedbackNote(userPhone, voiceNote, tenant);
      if (ok && summary) {
        await sendMessage(userPhone, `Summary:\n${summary}`);
      } else if (ok) {
        await sendMessage(userPhone, 'Feedback saved');
      } else {
        await sendMessage(userPhone, 'Could not save feedback. Please try again.');
      }
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    const voiceRef = extractVoiceNoteRef(message);
    if (voiceRef || message.startsWith('voice_note_ref:')) {
      if (!await requirePermission('notes')) return;
      const marker = `Voice note received (transcription pending)\nmedia_id=${voiceRef || 'unknown'}`;
      await saveFeedbackNote(userPhone, marker, tenant, {
        source: 'voice',
        mediaId: voiceRef || null,
        transcriptionStatus: 'failed',
        skipSummary: true
      });
      await supabase.from('users').update({ waiting_for: 'feedback_note' }).match(userMatch(tenant, userPhone));
      await sendMessage(
        userPhone,
        `🎙️ Voice note received, but I could not transcribe it.\n` +
        `Please type a short note now, or resend a clearer voice note.`
      );
      return;
    }

    if (message === 'go_pro' || message === 'go_pro_199' || message === 'go_pro_499') {
      if (!await requirePermission('billing')) return;
      const link199 = config.RAZORPAY_PAYMENT_LINK_199 || config.RAZORPAY_PAYMENT_LINK;
      const link499 = config.RAZORPAY_PAYMENT_LINK_499;
      if (message === 'go_pro_199') {
        if (link199) await sendMessage(userPhone, `Parent plan INR 199\n${link199}`);
        else await sendMessage(userPhone, 'INR 199 payment link not configured.');
        return;
      }
      if (message === 'go_pro_499') {
        if (link499) await sendMessage(userPhone, `Pro plan INR 499\n${link499}`);
        else await sendMessage(userPhone, 'INR 499 payment link not configured.');
        return;
      }
      if (link199 && link499) {
        await sendMessage(
          userPhone,
          `Choose a plan:\n` +
          `INR 199 (Parent Basic): ${link199}\n` +
          `INR 499 (Pro Plus): ${link499}`
        );
      } else if (link199) {
        await sendMessage(userPhone, `Parent plan INR 199\n${link199}`);
      } else if (link499) {
        await sendMessage(userPhone, `Pro plan INR 499\n${link499}`);
      } else {
        await sendMessage(userPhone, 'Payment links not configured. Please contact support.');
      }
      return;
    }
    if (message === 'status' || message === 'today_status') {
      if (!await requirePermission('view')) return;
      await handleStatus(userPhone, user, tenant);
      return;
    }
    if (message === 'weekly' || message === 'weekly_insights') {
      if (!await requirePermission('view')) return;
      await handleWeekly(userPhone, user, tenant);
      return;
    }
    if (message === 'weekly_digest' || message === 'parent_digest') {
      if (!await requirePermission('view')) return;
      await handleWeeklyDigest(userPhone, user, tenant);
      return;
    }
    if (message === 'missed_analytics' || message === 'missed_report') {
      if (!await requirePermission('view')) return;
      await handleMissedAnalytics(userPhone, user, tenant);
      return;
    }
    if (message === 'download_report' || message === 'report_pdf' || message === 'monthly_pdf') {
      if (!await requirePermission('view')) return;
      await handleReportDownload(userPhone, user, tenant);
      return;
    }
    if (message === 'clinic_admin' || message === 'admin') {
      if (!await requirePermission('admin')) return;
      await handleClinicAdminOverview(userPhone, user, tenant);
      return;
    }
    if (message === 'admin_members') {
      if (!await requirePermission('admin')) return;
      await handleClinicAdminMembers(userPhone, tenant);
      return;
    }
    if (message === 'admin_risk') {
      if (!await requirePermission('admin')) return;
      await handleClinicAdminRisk(userPhone, user, tenant);
      return;
    }

    if (message === 'yes' || message === 'y' || message === 'confirm_yes') {
      if (user.waiting_for === 'state:AWAITING_CONFIRMATION') {
        await confirmAttended(userPhone, tenant);
        return;
      }
    } else if (message === 'no' || message === 'n' || message === 'confirm_no') {
      if (user.waiting_for === 'state:AWAITING_CONFIRMATION') {
        await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenant, userPhone));
        await sendMessage(userPhone, 'Okay, not logged.');
        await sendQuickMenu(userPhone, tenant);
        return;
      }
    } else {
      const parsedIntent = parseIntent(message);
      const intent = parsedIntent.intent;
      if (intent === 'LANGUAGE') {
        const locale = readUserLocale(user);
        await sendMessage(userPhone, i18nText(locale, 'language_prompt'));
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (intent === 'THEME') {
        const locale = readUserLocale(user);
        await sendMessage(userPhone, i18nText(locale, 'theme_prompt'));
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (intent === 'STREAK') {
        if (!await requirePermission('view')) return;
        await handleStreakStatus(userPhone, user, tenant);
        return;
      }
      if (intent === 'REFERRAL') {
        if (!await requirePermission('billing')) return;
        await handleReferralCode(userPhone, user, tenant);
        return;
      }
      if (intent === 'REDEEM') {
        if (!await requirePermission('billing')) return;
        await handleRedeemReferral(userPhone, user, tenant, parsedIntent.code || '');
        return;
      }
      if (intent === 'COUPON') {
        if (!await requirePermission('billing')) return;
        await handleApplyCoupon(userPhone, user, tenant, parsedIntent.code || '');
        return;
      }
      if (intent === 'ATTENDED') {
        if (!await requirePermission('log')) return;
        await sendAttendedDatePicker(userPhone, tenant);
        return;
      }
      if (intent === 'MISSED') {
        if (!await requirePermission('log')) return;
        await handleMissed(userPhone, tenant);
        return;
      }
      if (intent === 'SUMMARY') {
        if (!await requirePermission('view')) return;
        await handleSummary(userPhone, user, tenant);
        return;
      }
      if (intent === 'STATUS') {
        if (!await requirePermission('view')) return;
        await handleStatus(userPhone, user, tenant);
        return;
      }
      if (intent === 'WEEKLY') {
        if (!await requirePermission('view')) return;
        await handleWeekly(userPhone, user, tenant);
        return;
      }
      if (intent === 'WEEKLY_DIGEST') {
        if (!await requirePermission('view')) return;
        await handleWeeklyDigest(userPhone, user, tenant);
        return;
      }
      if (intent === 'MISSED_ANALYTICS') {
        if (!await requirePermission('view')) return;
        await handleMissedAnalytics(userPhone, user, tenant);
        return;
      }
      if (intent === 'NOTE_TEMPLATE') {
        if (!await requirePermission('notes')) return;
        await supabase.from('users').update({ waiting_for: 'note_template:goal' }).match(userMatch(tenant, userPhone));
        await sendMessage(
          userPhone,
          `🧾 Structured therapy note\nStep 1/4: Goal\n` +
          `Reply with today's therapy goal in one line.`
        );
        return;
      }
      if (intent === 'REPORT_PDF') {
        if (!await requirePermission('view')) return;
        await handleReportDownload(userPhone, user, tenant);
        return;
      }
      if (intent === 'CLINIC_ADMIN') {
        if (!await requirePermission('admin')) return;
        await handleClinicAdminOverview(userPhone, user, tenant);
        return;
      }
      if (intent === 'ADMIN_MEMBERS') {
        if (!await requirePermission('admin')) return;
        await handleClinicAdminMembers(userPhone, tenant);
        return;
      }
      if (intent === 'ADMIN_RISK') {
        if (!await requirePermission('admin')) return;
        await handleClinicAdminRisk(userPhone, user, tenant);
        return;
      }
      if (intent === 'PLAN') {
        if (!await requirePermission('billing')) return;
        await handlePlanStatus(userPhone, user);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (intent === 'PAYMENT_STATUS') {
        if (!await requirePermission('billing')) return;
        await handlePaymentStatus(userPhone, user, tenant);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (intent === 'EXPORT_DATA') {
        if (!await requirePermission('data')) return;
        await handleDataExport(userPhone, tenant);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (intent === 'DELETE_DATA') {
        if (!await requirePermission('data')) return;
        await supabase.from('users').update({ waiting_for: 'delete_data_confirm' }).match(userMatch(tenant, userPhone));
        await sendYesNo(userPhone, 'Delete all your data permanently?');
        return;
      }
      if (intent === 'MEMBERS') {
        if (!await requirePermission('members_view')) return;
        await handleMembersList(userPhone, tenant);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (intent === 'INVITE_MEMBER') {
        if (!await requirePermission('members_manage')) return;
        await sendInviteTypePicker(userPhone);
        return;
      }
    }

    if (message.startsWith('missed_date:')) {
      if (!await requirePermission('log')) return;
      const date = message.split(':')[1];
      await supabase.from('users').update({ waiting_for: `missed_reason:${date}` }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `Reason for missing on ${date}?`);
    } else if (message.startsWith('attended_date:')) {
      if (!await requirePermission('log')) return;
      const date = message.split(':')[1];
      await supabase.from('users').update({ waiting_for: `attended_count:${date}` }).match(userMatch(tenant, userPhone));
      await sendAttendedCountPicker(userPhone, date);
    } else if (message === 'backfill_attended') {
      if (!await requirePermission('log')) return;
      await sendBackfillDatePicker(userPhone, 'attended', tenant);
    } else if (message === 'backfill_missed') {
      if (!await requirePermission('log')) return;
      await sendBackfillDatePicker(userPhone, 'missed', tenant);
    } else if (message.startsWith('backfill_date:')) {
      if (!await requirePermission('log')) return;
      const parts = message.split(':');
      const type = parts[1];
      const date = parts[2];
      if (type === 'attended') {
        await supabase.from('users').update({ waiting_for: `backfill_attended_count:${date}` }).match(userMatch(tenant, userPhone));
        await sendBackfillCountPicker(userPhone, 'attended', date);
      } else if (type === 'missed') {
        await supabase.from('users').update({ waiting_for: `backfill_missed_count:${date}` }).match(userMatch(tenant, userPhone));
        await sendBackfillCountPicker(userPhone, 'missed', date);
      }
    } else if (message === 'holiday_today') {
      if (!await requirePermission('log')) return;
      await markHolidayRange(userPhone, 1, tenant);
    } else if (message === 'holiday_next3') {
      if (!await requirePermission('log')) return;
      await markHolidayRange(userPhone, 3, tenant);
    } else if (message === 'holiday_next7') {
      if (!await requirePermission('log')) return;
      await markHolidayRange(userPhone, 7, tenant);
    } else if (message === 'holiday_range') {
      if (!await requirePermission('log')) return;
      await supabase.from('users').update({ waiting_for: 'holiday_range' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, 'Type range as YYYY-MM-DD..YYYY-MM-DD');
    } else if (message === 'setup_other') {
      if (!await requirePermission('setup')) return;
      await handleSetup(userPhone, tenant);
    } else if (message === 'settings_timezone') {
      await sendTimezonePicker(userPhone, tenant);
    } else if (message.startsWith('tz:')) {
      const tz = message.slice(3);
      await supabase.from('users').update({ timezone: tz }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `✅ Timezone updated\n🌍 ${tz}`);
      await sendQuickMenu(userPhone, tenant);
    } else if (message === 'settings_reminders') {
      await sendRemindersPicker(userPhone, tenant);
    } else if (message === 'settings_reminder_time') {
      await sendReminderTimePicker(userPhone, tenant);
    } else if (message.startsWith('reminder_time:')) {
      const hour = parseInt(message.split(':')[1], 10);
      if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
        await supabase.from('users').update({ reminder_time_hour: hour }).match(userMatch(tenant, userPhone));
        await sendMessage(userPhone, `✅ Reminder time updated\n⏰ ${String(hour).padStart(2, '0')}:00`);
        await sendQuickMenu(userPhone, tenant);
      } else {
        await sendReminderTimePicker(userPhone, tenant);
      }
    } else if (message === 'reminders_on') {
      await supabase.from('users').update({ reminders_enabled: true }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `✅ Reminders ON`);
      await sendQuickMenu(userPhone, tenant);
    } else if (message === 'reminders_off') {
      await supabase.from('users').update({ reminders_enabled: false }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `✅ Reminders OFF`);
      await sendQuickMenu(userPhone, tenant);
    } else if (message === 'setup_fresh') {
      if (!await requirePermission('setup')) return;
      await sendSetupPresets(userPhone);
      const { error: setWaitErr } = await supabase
        .from('users')
        .update({ waiting_for: 'setup_config' })
        .match(userMatch(tenant, userPhone));
      if (setWaitErr) console.error('Supabase users set waiting error:', setWaitErr.message);
    } else if (message === 'setup_mid') {
      if (!await requirePermission('setup')) return;
      await supabase.from('users').update({ waiting_for: 'setup_mid_config' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `🧮 Mid-month setup\nReply: [total] [cost] [carry] [used]\nEx: 16 800 2 6`);
    } else if (command === 'reset_month' || command === 'confirm_reset' || command === 'cancel_reset' || /\breset\b/.test(command)) {
      if (!await requirePermission('reset')) return;
      await handleReset(userPhone, command, tenant);
    } else if (message.includes('attended') || message === 'done' || message === 'ok' || message === '✅') {
      if (!await requirePermission('log')) return;
      await sendAttendedDatePicker(userPhone, tenant);
    } else if (message.includes('missed') || message.includes('cancelled')) {
      if (!await requirePermission('log')) return;
      await handleMissed(userPhone, tenant);
    } else if (message.includes('plan')) {
      if (!await requirePermission('billing')) return;
      await handlePlanStatus(userPhone, user);
      await sendQuickMenu(userPhone, tenant);
    } else if (message.includes('payment') && message.includes('status')) {
      if (!await requirePermission('billing')) return;
      await handlePaymentStatus(userPhone, user, tenant);
      await sendQuickMenu(userPhone, tenant);
    } else if (message.includes('export') && message.includes('data')) {
      if (!await requirePermission('data')) return;
      await handleDataExport(userPhone, tenant);
      await sendQuickMenu(userPhone, tenant);
    } else if (message.includes('delete') && message.includes('data')) {
      if (!await requirePermission('data')) return;
      await supabase.from('users').update({ waiting_for: 'delete_data_confirm' }).match(userMatch(tenant, userPhone));
      await sendYesNo(userPhone, 'Delete all your data permanently?');
    } else if (message.includes('members') || message.includes('team')) {
      if (!await requirePermission('members_view')) return;
      await handleMembersList(userPhone, tenant);
      await sendQuickMenu(userPhone, tenant);
    } else if (message.includes('admin') && message.includes('members')) {
      if (!await requirePermission('admin')) return;
      await handleClinicAdminMembers(userPhone, tenant);
    } else if (message.includes('admin') && message.includes('risk')) {
      if (!await requirePermission('admin')) return;
      await handleClinicAdminRisk(userPhone, user, tenant);
    } else if (message.includes('clinic') && message.includes('admin')) {
      if (!await requirePermission('admin')) return;
      await handleClinicAdminOverview(userPhone, user, tenant);
    } else if (message.includes('invite')) {
      if (!await requirePermission('members_manage')) return;
      await sendInviteTypePicker(userPhone);
    } else if ((message.includes('note') && message.includes('template')) || message.includes('structured note')) {
      if (!await requirePermission('notes')) return;
      await supabase.from('users').update({ waiting_for: 'note_template:goal' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `🧾 Structured therapy note\nStep 1/4: Goal\nReply with today's therapy goal.`);
    } else if (message.includes('status')) {
      if (!await requirePermission('view')) return;
      await handleStatus(userPhone, user, tenant);
    } else if (message.includes('digest')) {
      if (!await requirePermission('view')) return;
      await handleWeeklyDigest(userPhone, user, tenant);
    } else if (message.includes('missed') && message.includes('analytics')) {
      if (!await requirePermission('view')) return;
      await handleMissedAnalytics(userPhone, user, tenant);
    } else if (message.includes('weekly')) {
      if (!await requirePermission('view')) return;
      await handleWeekly(userPhone, user, tenant);
    } else if (message.includes('download') || message.includes('pdf')) {
      if (!await requirePermission('view')) return;
      await handleReportDownload(userPhone, user, tenant);
    } else if (message.includes('summary') || message.includes('report')) {
      if (!await requirePermission('view')) return;
      await handleSummary(userPhone, user, tenant);
    } else if (message.includes('setup')) {
      if (!await requirePermission('setup')) return;
      await handleSetup(userPhone, tenant);
    } else if (message.includes('holiday') || message.includes('leave')) {
      if (!await requirePermission('log')) return;
      await showHolidayPicker(userPhone);
    } else if (message.includes('more') || message.includes('menu')) {
      await sendMoreMenu(userPhone);
    } else {
      await sendQuickMenu(userPhone, tenant);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await sendMessage(userPhone, '⚠️ Something went wrong. Please try again.');
  }
}

async function createUser(phone, tenantId) {
  const row = withTenant(tenantId, {
    phone: phone,
    reminder_time_hour: config.DEFAULT_REMINDER_HOUR,
    created_at: new Date().toISOString()
  });
  const { error } = await supabase.from('users').insert(row);
  if (error) {
    console.error('Supabase users insert error:', error.message);
  }
}

async function handleAttended(userPhone, user, tenantId) {
  const { today, month: currentMonth } = nowPartsInTimeZone(user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE);
  const { data: configRow, error: cfgErr } = await supabase
    .from('monthly_config')
    .select('*')
    .match(userPhoneMatch(tenantId, userPhone))
    .eq('month', currentMonth)
    .single();
  if (cfgErr) {
    console.error('Supabase monthly_config select error:', cfgErr.message);
  }

  if (!configRow) {
    await sendMessage(userPhone,
      `⚠️ Please run setup first!\n\nType 'setup' to configure your monthly sessions.`
    );
    return;
  }

  const { error: insErr } = await supabase.from('sessions').insert(withTenant(tenantId, {
    user_phone: userPhone,
    date: today,
    status: 'attended',
    month: currentMonth
  }));
  if (insErr) {
    console.error('Supabase sessions insert error:', insErr.message);
  }

  const { data: sessions, error: sesErr } = await supabase
    .from('sessions')
    .select('*')
    .match(userPhoneMatch(tenantId, userPhone))
    .eq('month', currentMonth);
  if (sesErr) {
    console.error('Supabase sessions select error:', sesErr.message);
  }

  const list = Array.isArray(sessions) ? sessions : [];
  const attended = list.filter(s => s.status === 'attended').length;
  const totalSessions = (configRow.paid_sessions || 0) + (configRow.carry_forward || 0);
  const remaining = totalSessions - attended;

  await sendMessage(userPhone,
    `✅ Session logged\n` +
    `🎯 ${remaining} left this month`
  );
  await maybeSendStreakMilestone(userPhone, user, tenantId);
  await sendQuickMenu(userPhone, tenantId);
  await promptMood(userPhone, today, 1, tenantId, true);
}

async function handleMissed(userPhone, tenantId) {
  await sendMissedDatePicker(userPhone, tenantId);
}

async function promptMood(userPhone, date, count, tenantId, includeVoicePrompt = false) {
  await supabase.from('users').update({ waiting_for: `mood:${date}:${count}` }).match(userMatch(tenantId, userPhone));
  if (includeVoicePrompt) {
    await sendVoiceNotePrompt(userPhone);
  }
  await sendMoodPicker(userPhone, date, count);
}

async function handleWaitingResponse(userPhone, message, user, tenantId, memberRole = 'owner') {
  const can = (permission) => hasPermission(memberRole, permission);
  if (message === 'cancel' || message === 'back' || message === 'menu') {
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('note_template:')) {
    const parts = user.waiting_for.split(':');
    const stage = parts[1] || '';
    const voiceRef = extractVoiceNoteRef(message);
    if (voiceRef || message.startsWith('voice_note_ref:')) {
      await sendMessage(
        userPhone,
        `🎙️ Could not transcribe this voice note.\n` +
        `Please type this step in text.`
      );
      return true;
    }
    const input = readTextPayload(message);
    if (!input) {
      if (stage === 'goal') {
        await sendMessage(userPhone, 'Step 1/4: Share today\'s therapy goal.');
      } else if (stage === 'activity') {
        await sendMessage(userPhone, 'Step 2/4: Share activity done in session.');
      } else if (stage === 'response') {
        await sendMessage(userPhone, 'Step 3/4: How child responded?');
      } else if (stage === 'homework') {
        await sendMessage(userPhone, 'Step 4/4: What homework/practice is suggested?');
      } else {
        await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      }
      return true;
    }

    if (stage === 'goal') {
      await supabase
        .from('users')
        .update({ waiting_for: `note_template:activity:${encodeStateSegment(input)}` })
        .match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, `Step 2/4: Activity\nWhat activity/exercise was done?`);
      return true;
    }
    if (stage === 'activity') {
      const goal = decodeStateSegment(parts[2] || '');
      await supabase
        .from('users')
        .update({
          waiting_for: `note_template:response:${encodeStateSegment(goal)}:${encodeStateSegment(input)}`
        })
        .match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, `Step 3/4: Response\nHow did the child respond?`);
      return true;
    }
    if (stage === 'response') {
      const goal = decodeStateSegment(parts[2] || '');
      const activity = decodeStateSegment(parts[3] || '');
      await supabase
        .from('users')
        .update({
          waiting_for: `note_template:homework:${encodeStateSegment(goal)}:${encodeStateSegment(activity)}:${encodeStateSegment(input)}`
        })
        .match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, `Step 4/4: Homework\nWhat should parents practice this week?`);
      return true;
    }
    if (stage === 'homework') {
      const goal = decodeStateSegment(parts[2] || '');
      const activity = decodeStateSegment(parts[3] || '');
      const response = decodeStateSegment(parts[4] || '');
      const transcript = buildStructuredNoteTranscript({
        goal: goal || '-',
        activity: activity || '-',
        response: response || '-',
        homework: input
      });
      const { ok, summary } = await saveFeedbackNote(userPhone, transcript, tenantId, { source: 'template' });
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      if (!ok) {
        await sendMessage(userPhone, 'Could not save structured note. Please try again.');
        await sendQuickMenu(userPhone, tenantId);
        return true;
      }
      await sendMessage(
        userPhone,
        `🧾 Structured note saved\n` +
        `Goal: ${truncateText(goal || '-', 90)}\n` +
        `Activity: ${truncateText(activity || '-', 90)}\n` +
        `Response: ${truncateText(response || '-', 90)}\n` +
        `Homework: ${truncateText(input, 90)}`
      );
      if (summary) {
        await sendMessage(userPhone, `Summary:\n${summary}`);
      }
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }

    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for === 'feedback_note') {
    const voiceRef = extractVoiceNoteRef(message);
    if (voiceRef || message.startsWith('voice_note_ref:')) {
      const marker = `Voice note received (transcription pending)\nmedia_id=${voiceRef || 'unknown'}`;
      await saveFeedbackNote(userPhone, marker, tenantId, {
        source: 'voice',
        mediaId: voiceRef || null,
        transcriptionStatus: 'failed',
        skipSummary: true
      });
      await sendMessage(
        userPhone,
        `🎙️ Voice note received, but transcription failed.\n` +
        `Please type a short note, or send another clear voice note.`
      );
      return true;
    }
    const voice = extractVoiceNote(message);
    let note = voice;
    if (!note && !message.startsWith('voice_note:')) note = message;
    note = String(note || '').trim();
    if (!note) {
      await sendMessage(userPhone, 'Please send a voice note or type the feedback.');
      return true;
    }
    const { ok, summary } = await saveFeedbackNote(userPhone, note, tenantId);
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    if (ok && summary) {
      await sendMessage(userPhone, `Summary:\n${summary}`);
    } else if (ok) {
      await sendMessage(userPhone, 'Feedback saved');
    } else {
      await sendMessage(userPhone, 'Could not save feedback. Please try again.');
    }
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('mood:')) {
    const parts = user.waiting_for.split(':');
    const date = parts[1];
    const count = Math.max(1, parseInt(parts[2] || '1', 10));
    const voiceNote = extractVoiceNote(message);
    const voiceRef = extractVoiceNoteRef(message);
    let mood = '';
    if (message === 'voice_note_today') {
      await sendMessage(userPhone, `Please send a voice note about today's session.`);
      return true;
    }
    if (voiceRef || message.startsWith('voice_note_ref:')) {
      const marker = `Mood voice note received (transcription pending)\nmedia_id=${voiceRef || 'unknown'}`;
      await saveFeedbackNote(userPhone, marker, tenantId, {
        source: 'voice',
        mediaId: voiceRef || null,
        transcriptionStatus: 'failed',
        skipSummary: true
      });
      await sendMessage(
        userPhone,
        `🎙️ Could not transcribe this voice note.\n` +
        `Please choose mood buttons or send short text mood note.`
      );
      await sendMoodPicker(userPhone, date, count);
      return true;
    }
    if (message.startsWith('mood:')) {
      mood = message.split(':')[1];
      const allowed = new Set(['excellent', 'good', 'okay', 'tough']);
      if (!allowed.has(mood)) {
        await sendMoodPicker(userPhone, date, count);
        return true;
      }
    } else if (voiceNote) {
      mood = voiceNote;
    } else {
      await sendMoodPicker(userPhone, date, count);
      return true;
    }
    const childId = await getOrCreateDefaultChild(userPhone, tenantId);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: rows } = await supabase
      .from('sessions')
      .select('id')
      .match(withTenant(tenantId, { [idKey]: idVal }))
      .eq('date', date)
      .eq('status', 'attended')
      .order('created_at', { ascending: false })
      .limit(count);
    if (Array.isArray(rows) && rows.length) {
      const ids = rows.map(r => r.id);
      await supabase.from('sessions').update({ mood }).in('id', ids);
    }
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    if (message.startsWith('mood:')) {
      const label = mood.charAt(0).toUpperCase() + mood.slice(1);
      await sendMessage(userPhone, `Mood saved: ${label}`);
    } else {
      await sendMessage(userPhone, `Mood note saved`);
    }
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for === 'invite_parent_phone') {
    if (!can('members_manage')) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, permissionDeniedText(memberRole, 'members_manage'));
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    const phone = normalizeMemberPhone(message);
    if (!phone) {
      await sendMessage(userPhone, 'Invalid phone. Example: 919876543210');
      return true;
    }
    await handleAddMember(userPhone, tenantId, 'parent', phone);
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for === 'invite_therapist_phone') {
    if (!can('members_manage')) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, permissionDeniedText(memberRole, 'members_manage'));
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    const phone = normalizeMemberPhone(message);
    if (!phone) {
      await sendMessage(userPhone, 'Invalid phone. Example: 919876543210');
      return true;
    }
    await handleAddMember(userPhone, tenantId, 'therapist', phone);
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for === 'delete_data_confirm') {
    if (!can('data')) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, permissionDeniedText(memberRole, 'data'));
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes';
    const no = message === 'no' || message === 'n' || message === 'confirm_no';
    if (yes) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await handleDeleteData(userPhone, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, 'Data deletion cancelled.');
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    await sendYesNo(userPhone, 'Delete all your data permanently?');
    return true;
  }

  if (user.waiting_for === 'reset_confirm') {
    if (!can('reset')) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, permissionDeniedText(memberRole, 'reset'));
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes' || message === 'confirm_reset';
    const no = message === 'no' || message === 'n' || message === 'confirm_no' || message === 'cancel_reset';
    if (yes) {
      const tz = await getUserTimeZone(userPhone, tenantId);
      const { month } = nowPartsInTimeZone(tz);
      await resetCurrentMonthData(userPhone, month, tenantId);
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, `🧹 Reset complete for ${month}\nType "setup" to start this month from beginning.`);
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, 'Reset cancelled');
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    await sendYesNo(userPhone, 'Reset this month? This clears sessions, notes, holidays and setup for this month.');
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('state:AWAITING_CONFIRMATION')) {
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes';
    const no = message === 'no' || message === 'n' || message === 'confirm_no';
    const { intent } = parseIntent(message);
    if (yes || intent === 'ATTENDED') { await confirmAttended(userPhone, tenantId); return true; }
    if (intent === 'MISSED') {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await handleMissed(userPhone, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, 'Okay, not logged.');
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    await sendYesNo(userPhone, 'Log session for today?');
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('missed_reason:')) {
    const date = user.waiting_for.split(':')[1];
    const month = date.slice(0, 7);
    const reason = extractVoiceNote(message) || message;
    const childId = await getOrCreateDefaultChild(userPhone, tenantId);

    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing, error: exErr } = await supabase
      .from('sessions')
      .select('status')
      .match(withTenant(tenantId, { [idKey]: idVal }))
      .eq('date', date);
    if (exErr) console.error('Supabase select existing for missed:', exErr.message);

    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');

    if (hasAttended) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `replace_with_missed:${date}:${payload}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Replace with Missed?`);
      return true;
    }
    if (hasMissed) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `dup_missed:${date}:${payload}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Add again?`);
      return true;
    }

    const { error: insErr } = await supabase.from('sessions').insert(withTenant(tenantId, {
      user_phone: userPhone,
      child_id: childId,
      logged_by: userPhone,
      sessions_done: 1,
      date,
      status: 'cancelled',
      reason,
      month
    }));
    if (insErr) console.error('Supabase sessions insert cancel error:', insErr.message);
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendMessage(userPhone, `❌ Missed logged\n🗓️ ${date}\n📝 ${reason}`);
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for === 'cancellation_reason') {
    const tz = await getUserTimeZone(userPhone, tenantId);
    const { today, month: currentMonth } = nowPartsInTimeZone(tz);

    const { error: canErr } = await supabase.from('sessions').insert(withTenant(tenantId, {
      user_phone: userPhone,
      date: today,
      status: 'cancelled',
      reason: extractVoiceNote(message) || message,
      month: currentMonth
    }));
    if (canErr) {
      console.error('Supabase sessions insert cancel error:', canErr.message);
    }

    const { error: clrErr } = await supabase
      .from('users')
      .update({ waiting_for: null })
      .match(userMatch(tenantId, userPhone));
    if (clrErr) {
      console.error('Supabase users clear waiting error:', clrErr.message);
    }

    await sendMessage(userPhone,
      `❌ Missed logged\n` +
      `🗓️ ${today}\n` +
      `📝 ${extractVoiceNote(message) || message}`
    );
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('dup_attend:')) {
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes';
    const no = message === 'no' || message === 'n' || message === 'confirm_no';
    const parts = user.waiting_for.split(':');
    const date = parts[1];
    const count = Math.max(1, parseInt(parts[2] || '1', 10));
    if (yes) {
      const month = date.slice(0, 7);
      const childId = await getOrCreateDefaultChild(userPhone, tenantId);
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month, reason: 'duplicate_confirmed', tenantId });
      await sendMessage(userPhone, `✅ Added again\n🗓️ ${date}`);
      await sendQuickMenu(userPhone, tenantId);
      await promptMood(userPhone, date, count, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, '❎ Skipped');
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    await sendYesNo(userPhone, 'Already logged today. Add again?');
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('dup_missed:')) {
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes';
    const no = message === 'no' || message === 'n' || message === 'confirm_no';
    const parts = user.waiting_for.split(':');
    const date = parts[1];
    let count = 1;
    let payloadIndex = 2;
    if (parts[2] && !isNaN(parseInt(parts[2], 10))) {
      count = Math.max(1, parseInt(parts[2], 10));
      payloadIndex = 3;
    }
    const reason = Buffer.from(parts.slice(payloadIndex).join(':'), 'base64').toString('utf8');
    if (yes) {
      const childId = await getOrCreateDefaultChild(userPhone, tenantId);
      const month = date.slice(0, 7);
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'cancelled', month, reason, tenantId });
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, `❌ Missed logged again\n🗓️ ${date}\n🔢 ${count}\n📝 ${reason}`);
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, '❎ Skipped');
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    await sendYesNo(userPhone, 'Already marked missed. Add again?');
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('replace_with_missed:')) {
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes';
    const no = message === 'no' || message === 'n' || message === 'confirm_no';
    const parts = user.waiting_for.split(':');
    const date = parts[1];
    let count = 1;
    let payloadIndex = 2;
    if (parts[2] && !isNaN(parseInt(parts[2], 10))) {
      count = Math.max(1, parseInt(parts[2], 10));
      payloadIndex = 3;
    }
    const reason = Buffer.from(parts.slice(payloadIndex).join(':'), 'base64').toString('utf8');
    if (yes) {
      const childId = await getOrCreateDefaultChild(userPhone, tenantId);
      const key = childId ? 'child_id' : 'user_phone';
      const val = childId ? childId : userPhone;
      await supabase.from('sessions').delete().match(withTenant(tenantId, { [key]: val })).eq('date', date).eq('status', 'attended');
      const month = date.slice(0, 7);
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'cancelled', month, reason, tenantId });
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, `🔁 Replaced Attended with Missed\n🗓️ ${date}\n🔢 ${count}\n📝 ${reason}`);
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, 'Kept as Attended');
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    await sendYesNo(userPhone, 'Replace Attended with Missed?');
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('repl_can_attend:')) {
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes';
    const no = message === 'no' || message === 'n' || message === 'confirm_no';
    const parts = user.waiting_for.split(':');
    const date = parts[1];
    const count = Math.max(1, parseInt(parts[2] || '1', 10));
    if (yes) {
      const childId = await getOrCreateDefaultChild(userPhone, tenantId);
      const key = childId ? 'child_id' : 'user_phone';
      const val = childId ? childId : userPhone;
      await supabase.from('sessions').delete().match(withTenant(tenantId, { [key]: val })).eq('date', date).eq('status', 'cancelled');
      const month = date.slice(0, 7);
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month, reason: 'replaced_cancelled', tenantId });
      await sendMessage(userPhone, `🔁 Replaced Missed with Attended\n🗓️ ${date}`);
      await sendQuickMenu(userPhone, tenantId);
      await promptMood(userPhone, date, count, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, 'Kept as Missed');
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    await sendYesNo(userPhone, 'Replace Missed with Attended?');
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('attended_count:')) {
    const date = user.waiting_for.split(':')[1];
    if (!message.startsWith('attended_count:')) {
      await sendAttendedCountPicker(userPhone, date);
      return true;
    }
    const count = Math.max(1, parseInt(message.split(':')[1] || '1', 10));
    const month = date.slice(0, 7);
    const childId = await getOrCreateDefaultChild(userPhone, tenantId);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing } = await supabase.from('sessions').select('status').match(withTenant(tenantId, { [idKey]: idVal })).eq('date', date);
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');
    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    if (hasMissed) {
      await supabase.from('users').update({ waiting_for: `repl_can_attend:${date}:${count}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Replace with Attended?`);
      return true;
    }
    if (hasAttended) {
      await supabase.from('users').update({ waiting_for: `dup_attend:${date}:${count}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Add again?`);
      return true;
    }
    await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month, tenantId });
    await sendMessage(userPhone, `✅ Attended logged\n🗓️ ${date}\n🔢 ${count}`);
    await sendQuickMenu(userPhone, tenantId);
    await promptMood(userPhone, date, count, tenantId);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('backfill_attended_count:')) {
    const date = user.waiting_for.split(':')[1];
    if (!message.startsWith('backfill_count:')) {
      await sendBackfillCountPicker(userPhone, 'attended', date);
      return true;
    }
    const count = Math.max(1, parseInt(message.split(':')[1] || '1', 10));
    const month = date.slice(0, 7);
    const childId = await getOrCreateDefaultChild(userPhone, tenantId);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing } = await supabase.from('sessions').select('status').match(withTenant(tenantId, { [idKey]: idVal })).eq('date', date);
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');
    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    if (hasMissed) {
      await supabase.from('users').update({ waiting_for: `repl_can_attend:${date}:${count}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Replace with Attended?`);
      return true;
    }
    if (hasAttended) {
      await supabase.from('users').update({ waiting_for: `dup_attend:${date}:${count}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Add again?`);
      return true;
    }
    await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month, tenantId });
    await sendMessage(userPhone, `✅ Backfilled Attended\n🗓️ ${date}\n🔢 ${count}`);
    await sendQuickMenu(userPhone, tenantId);
    await promptMood(userPhone, date, count, tenantId);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('backfill_missed_count:')) {
    const date = user.waiting_for.split(':')[1];
    if (!message.startsWith('backfill_count:')) {
      await sendBackfillCountPicker(userPhone, 'missed', date);
      return true;
    }
    const count = Math.max(1, parseInt(message.split(':')[1] || '1', 10));
    await supabase.from('users').update({ waiting_for: `backfill_missed_reason:${date}:${count}` }).match(userMatch(tenantId, userPhone));
    await sendBackfillReasonPicker(userPhone);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('backfill_missed_reason:')) {
    const parts = user.waiting_for.split(':');
    const date = parts[1];
    const count = Math.max(1, parseInt(parts[2] || '1', 10));
    if (!message.startsWith('backfill_reason:')) {
      await sendBackfillReasonPicker(userPhone);
      return true;
    }
    const reasonKey = message.split(':')[1];
    if (reasonKey === 'other') {
      await supabase.from('users').update({ waiting_for: `backfill_missed_note:${date}:${count}` }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, `Type reason for ${date}`);
      return true;
    }
    const reason = reasonKey === 'sick' ? 'Sick' : reasonKey === 'travel' ? 'Travel' : reasonKey === 'therapist' ? 'Therapist unavailable' : 'Other';
    const month = date.slice(0, 7);
    const childId = await getOrCreateDefaultChild(userPhone, tenantId);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing } = await supabase.from('sessions').select('status').match(withTenant(tenantId, { [idKey]: idVal })).eq('date', date);
    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');
    if (hasAttended) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `replace_with_missed:${date}:${count}:${payload}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Replace with Missed?`);
      return true;
    }
    if (hasMissed) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `dup_missed:${date}:${count}:${payload}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Add again?`);
      return true;
    }
    await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'cancelled', month, reason, tenantId });
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendMessage(userPhone, `❌ Backfilled Missed\n🗓️ ${date}\n🔢 ${count}\n📝 ${reason}`);
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('backfill_missed_note:')) {
    const parts = user.waiting_for.split(':');
    const date = parts[1];
    const count = Math.max(1, parseInt(parts[2] || '1', 10));
    const reason = extractVoiceNote(message) || message;
    const month = date.slice(0, 7);
    const childId = await getOrCreateDefaultChild(userPhone, tenantId);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing } = await supabase.from('sessions').select('status').match(withTenant(tenantId, { [idKey]: idVal })).eq('date', date);
    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');
    if (hasAttended) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `replace_with_missed:${date}:${count}:${payload}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Replace with Missed?`);
      return true;
    }
    if (hasMissed) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `dup_missed:${date}:${count}:${payload}` }).match(userMatch(tenantId, userPhone));
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Add again?`);
      return true;
    }
    await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'cancelled', month, reason, tenantId });
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendMessage(userPhone, `❌ Backfilled Missed\n🗓️ ${date}\n🔢 ${count}\n📝 ${reason}`);
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for === 'setup_config') {
    if (!can('setup')) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, permissionDeniedText(memberRole, 'setup'));
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    const parts = message.split(/\s+/).map(v => v.trim()).filter(Boolean);
    if (parts.length < 3 || parts.some(p => isNaN(parseInt(p, 10)))) {
      await sendMessage(userPhone,
        `Please reply with: [sessions] [cost] [carry_forward]\nExample: 16 800 0`
      );
      return true;
    }

    const total_sessions = parseInt(parts[0], 10);
    const cost_per_session = parseInt(parts[1], 10);
    const carry_forward = parseInt(parts[2], 10);
    const paid_sessions = Math.max(0, total_sessions - carry_forward);
    const tz = await getUserTimeZone(userPhone, tenantId);
    const { month } = nowPartsInTimeZone(tz);

    const { error: upsertErr } = await supabase
      .from('monthly_config')
      .upsert([
        withTenant(tenantId, {
          user_phone: userPhone,
          month,
          paid_sessions,
          cost_per_session,
          carry_forward
        })
      ], { onConflict: (config.ENABLE_TENANT_SCOPING && tenantId) ? 'tenant_id,user_phone,month' : 'user_phone,month' });
    if (upsertErr) {
      console.error('Supabase monthly_config upsert error:', upsertErr.message);
    }

    const { error: clr2Err } = await supabase
      .from('users')
      .update({ waiting_for: null })
      .match(userMatch(tenantId, userPhone));
    if (clr2Err) {
      console.error('Supabase users clear after setup error:', clr2Err.message);
    }

    await sendMessage(userPhone, `✅ Setup complete for ${month}.\nTotal sessions: ${total_sessions}\nCarry forward: ${carry_forward}\nPaid this month: ${paid_sessions}\nYou can now tap 'Attended'.`);
    return true;
  }

  if (user.waiting_for === 'setup_mid_config') {
    if (!can('setup')) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, permissionDeniedText(memberRole, 'setup'));
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    const parts = message.split(/\s+/).map(v => v.trim()).filter(Boolean);
    if (parts.length < 4 || parts.some(p => isNaN(parseInt(p, 10)))) {
      await sendMessage(userPhone, `🧮 Mid-month setup\nReply: [total] [cost] [carry] [used]\nEx: 16 800 2 6`);
      return true;
    }
    const total_sessions = parseInt(parts[0], 10);
    const cost_per_session = parseInt(parts[1], 10);
    const carry_forward = parseInt(parts[2], 10);
    const used = Math.max(0, parseInt(parts[3], 10));
    const paid_sessions = Math.max(0, total_sessions - carry_forward);
    const tz = await getUserTimeZone(userPhone, tenantId);
    const { month } = nowPartsInTimeZone(tz);

    const { error: upErr } = await supabase.from('monthly_config').upsert([
      withTenant(tenantId, { user_phone: userPhone, month, paid_sessions, cost_per_session, carry_forward })
    ], { onConflict: (config.ENABLE_TENANT_SCOPING && tenantId) ? 'tenant_id,user_phone,month' : 'user_phone,month' });
    if (upErr) console.error('monthly_config upsert mid error:', upErr.message);

    if (used > 0) {
      await bulkBackfillAttended(userPhone, used, month, tenantId);
    }

    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    const remaining = total_sessions - used;
    await sendMessage(userPhone, `✅ Setup complete\n🧮 Total: ${total_sessions}\n✅ Done: ${used}\n🎯 Remaining: ${remaining}`);
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }
  return false;
}

async function handleSummary(userPhone, user, tenantId) {
  const { month: currentMonth } = nowPartsInTimeZone(user && typeof user.timezone === 'string' ? user.timezone : config.DEFAULT_TIMEZONE);

  const { data: configRow, error: cfgErr2 } = await supabase
    .from('monthly_config')
    .select('*')
    .match(userPhoneMatch(tenantId, userPhone))
    .eq('month', currentMonth)
    .single();
  if (cfgErr2) {
    console.error('Supabase monthly_config select error:', cfgErr2.message);
  }

  if (!configRow) {
    await sendMessage(userPhone, 'ℹ️ No config. Type "setup" to begin.');
    return;
  }

  const { data: sessions, error: sesErr2 } = await supabase
    .from('sessions')
    .select('*')
    .match(userPhoneMatch(tenantId, userPhone))
    .eq('month', currentMonth);
  if (sesErr2) {
    console.error('Supabase sessions select error:', sesErr2.message);
  }

  const list = Array.isArray(sessions) ? sessions : [];
  const attended = list.filter(s => s.status === 'attended').length;
  const cancelled = list.filter(s => s.status === 'cancelled').length;
  const totalSessions = (configRow.paid_sessions || 0) + (configRow.carry_forward || 0);
  const remaining = totalSessions - attended;
  const amountUsed = Math.max(0, Math.min(attended, configRow.paid_sessions || 0)) * (configRow.cost_per_session || 0);
  const amountCancelled = Math.max(0, Math.min(cancelled, Math.max((configRow.paid_sessions || 0) - Math.min(attended, configRow.paid_sessions || 0), 0))) * (configRow.cost_per_session || 0);
  const bufferSessions = Math.max(0, totalSessions - attended - cancelled);
  const bufferValue = bufferSessions * (configRow.cost_per_session || 0);
  const reasonCount = new Map();
  for (const row of list) {
    if (row.status !== 'cancelled') continue;
    const key = normalizeMissReason(row.reason);
    reasonCount.set(key, (reasonCount.get(key) || 0) + 1);
  }
  const topReasons = Array.from(reasonCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const reasonText = topReasons.length
    ? topReasons.map(([reason, count]) => `• ${reason}: ${count}`).join('\n')
    : '• No missed sessions';
  const risk = deriveRiskLevel(attended, cancelled);

  const dt = new Date(currentMonth + '-01');
  const monthName = dt.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }).toUpperCase();
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const lastWeekStart = new Date(lastDay); lastWeekStart.setDate(lastDay.getDate() - 6);
  const isLastWeek = now >= lastWeekStart;

  const header = `📊 ${monthName} SUMMARY`;
  const payment = `💰 PAYMENT\n• Paid: ${configRow.paid_sessions || 0} sessions\n• Cost: ₹${configRow.cost_per_session || 0}/session\n• Total paid: ₹${(configRow.paid_sessions || 0) * (configRow.cost_per_session || 0)}`;
  const attendance = `📈 ATTENDANCE\n• Attended: ${attended} (₹${amountUsed})\n• Cancelled: ${cancelled} (₹${amountCancelled})`;
  const missedAnalytics = `📉 MISSED ANALYTICS\n${reasonText}\n• Risk: ${risk}`;
  const costBreakdown = `💸 COST BREAKDOWN\n• Used: ₹${amountUsed}\n• Buffer: ₹${bufferValue}`;
  const summaryBlock = `✨ SUMMARY\n• Remaining: ${Math.max(0, remaining)} sessions` + (isLastWeek ? `\n• Carry forward: ${Math.max(0, remaining)} sessions` : '');

  const summary = [header, '', payment, '', attendance, '', missedAnalytics, '', costBreakdown, '', summaryBlock].join('\n');

  const chartConfig = {
    type: 'doughnut',
    data: {
      labels: ['Attended', 'Missed', 'Remaining'],
      datasets: [{
        data: [attended, cancelled, Math.max(0, remaining)],
        backgroundColor: ['#22c55e', '#ef4444', '#3b82f6']
      }]
    },
    options: {
      plugins: { legend: { display: true, position: 'bottom' } },
      cutout: '60%'
    }
  };
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  await sendImage(userPhone, chartUrl);
  await sendMessage(userPhone, summary);
  if (user?.waiting_for && user.waiting_for.startsWith && user.waiting_for.startsWith('state:')) {
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
  }
}

async function handleUndo(userPhone, tenantId) {
  const { data: last } = await supabase
    .from('sessions')
    .select('id,date,status,reason,created_at')
    .match(userPhoneMatch(tenantId, userPhone))
    .order('created_at', { ascending: false })
    .limit(1);
  const row = Array.isArray(last) ? last[0] : null;
  if (!row?.id) {
    await sendMessage(userPhone, `Nothing to undo`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  await supabase.from('sessions').delete().eq('id', row.id);
  const label = row.status === 'attended' ? '✅ Attended' : '❌ Missed';
  await sendMessage(userPhone, `↩️ Undone\n${label}\n🗓️ ${String(row.date).slice(0, 10)}`);
  await sendQuickMenu(userPhone, tenantId);
}

async function handleSetup(userPhone, tenantId) {
  await sendMessage(userPhone, `⚙️ Setup\nChoose a mode:`);
  await sendSetupMode(userPhone);

  const { error: setWaitErr } = await supabase
    .from('users')
    .update({ waiting_for: 'setup_config' })
    .match(userMatch(tenantId, userPhone));
  if (setWaitErr) {
    console.error('Supabase users set waiting error:', setWaitErr.message);
  }
}

async function handleHoliday(userPhone, message, tenantId) {
  const daysMatch = message.match(/(\d+)\s*days?/);
  const days = daysMatch ? parseInt(daysMatch[1]) : 1;

  const tz = await getUserTimeZone(userPhone, tenantId);
  const { today, month: currentMonth } = nowPartsInTimeZone(tz);
  const base = new Date(`${today}T00:00:00Z`);

  for (let i = 0; i < days; i++) {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + i);
    const dateStr = date.toISOString().slice(0, 10);

    const { error: holErr } = await supabase.from('holidays').insert(withTenant(tenantId, {
      user_phone: userPhone,
      date: dateStr,
      month: currentMonth
    }));
    if (holErr) {
      console.error('Supabase holidays insert error:', holErr.message);
    }
  }

  await sendMessage(userPhone, `🏖️ Marked ${days} day(s) off`);
}

async function handleReset(userPhone, message, tenantId) {
  if (message === 'confirm_reset' || message === 'cancel_reset') {
    await supabase.from('users').update({ waiting_for: 'reset_confirm' }).match(userMatch(tenantId, userPhone));
    await handleWaitingResponse(userPhone, message === 'confirm_reset' ? 'confirm_yes' : 'confirm_no', { waiting_for: 'reset_confirm' }, tenantId);
    return;
  }
  await supabase.from('users').update({ waiting_for: 'reset_confirm' }).match(userMatch(tenantId, userPhone));
  await sendYesNo(userPhone, 'Reset this month? This clears sessions, notes, holidays and setup for this month.');
}

function monthBoundsIso(month) {
  const m = String(month || '');
  if (!/^\d{4}-\d{2}$/.test(m)) return null;
  const year = parseInt(m.slice(0, 4), 10);
  const mon = parseInt(m.slice(5, 7), 10);
  if (!Number.isInteger(year) || !Number.isInteger(mon) || mon < 1 || mon > 12) return null;
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end = new Date(Date.UTC(year, mon, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function resetCurrentMonthData(userPhone, month, tenantId) {
  const byPhone = userPhoneMatch(tenantId, userPhone);
  const bounds = monthBoundsIso(month);
  const ops = [
    { label: 'sessions', req: supabase.from('sessions').delete().match(byPhone).eq('month', month) },
    { label: 'holidays', req: supabase.from('holidays').delete().match(byPhone).eq('month', month) },
    { label: 'monthly_config', req: supabase.from('monthly_config').delete().match(byPhone).eq('month', month) }
  ];
  if (bounds) {
    ops.push({
      label: 'feedback_notes',
      req: supabase
        .from('feedback_notes')
        .delete()
        .match(byPhone)
        .gte('created_at', bounds.startIso)
        .lt('created_at', bounds.endIso)
    });
  }
  const results = await Promise.all(ops.map((op) => op.req));
  results.forEach((result, i) => {
    if (result?.error && !new RegExp(ops[i].label, 'i').test(result.error.message || '')) {
      console.error(`reset ${ops[i].label} delete error:`, result.error.message);
    }
  });
}

async function markHolidayRange(userPhone, days, tenantId) {
  const tz = await getUserTimeZone(userPhone, tenantId);
  const { today, month: currentMonth } = nowPartsInTimeZone(tz);
  const base = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const { error } = await supabase.from('holidays').insert(withTenant(tenantId, { user_phone: userPhone, date: dateStr, month: currentMonth }));
    if (error) console.error('Supabase holidays insert error:', error.message);
  }
  await sendMessage(userPhone, `🏖️ Marked ${days} day(s) off`);
}

async function sendReminderDefaults(userPhone, tenantId) {
  const { data: u } = await supabase.from('users').select('*').match(userMatch(tenantId, userPhone)).single();
  if (!u || !Number.isInteger(u.reminder_time_hour)) {
    await supabase.from('users').update({ reminder_time_hour: config.DEFAULT_REMINDER_HOUR }).match(userMatch(tenantId, userPhone));
  }
}

async function bulkBackfillAttended(userPhone, used, month, tenantId) {
  try {
    const year = parseInt(month.split('-')[0], 10);
    const mon = parseInt(month.split('-')[1], 10);
    const today = new Date();
    const first = new Date(Date.UTC(year, mon - 1, 1));
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const maxDays = Math.max(0, Math.min(used, Math.max(0, Math.floor((yesterday - first) / 86400000) + 1)));
    if (maxDays <= 0) return;
    const childId = await getOrCreateDefaultChild(userPhone, tenantId);
    const rows = [];
    for (let i = 0; i < maxDays; i++) {
      const d = new Date(first); d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      rows.push(withTenant(tenantId, { user_phone: userPhone, child_id: childId, logged_by: userPhone, sessions_done: 1, date, status: 'attended', month }));
    }
    await supabase.from('sessions').insert(rows);
  } catch (e) {
    console.error('bulkBackfillAttended error:', e.message);
  }
}

async function confirmAttended(userPhone, tenantId) {
  const { data: u } = await supabase.from('users').select('*').match(userMatch(tenantId, userPhone)).single();
  const { today, month: currentMonth } = nowPartsInTimeZone((u && typeof u.timezone === 'string') ? u.timezone : config.DEFAULT_TIMEZONE);
  let count = 1;
  if (u?.waiting_for && typeof u.waiting_for === 'string') {
    const m = u.waiting_for.match(/state:AWAITING_CONFIRMATION:(\d+)/);
    if (m) count = Math.max(1, parseInt(m[1], 10));
  }
  const childId = await getOrCreateDefaultChild(userPhone, tenantId);
  const { data: configRow } = await supabase
    .from('monthly_config')
    .select('*')
    .match(withTenant(tenantId, { [childId ? 'child_id' : 'user_phone']: childId ? childId : userPhone }))
    .eq('month', currentMonth)
    .single();
  if (!configRow) {
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendMessage(userPhone, `No config set. Type 'setup' first.`);
    return;
  }
  const key = childId ? 'child_id' : 'user_phone';
  const val = childId ? childId : userPhone;
  const { data: todays } = await supabase
    .from('sessions')
    .select('status')
    .match(withTenant(tenantId, { [key]: val }))
    .eq('date', today);
  const hasAtt = Array.isArray(todays) && todays.some(r => r.status === 'attended');
  const hasMiss = Array.isArray(todays) && todays.some(r => r.status === 'cancelled');
  if (hasMiss) {
    await supabase.from('users').update({ waiting_for: `repl_can_attend:${today}:${count}` }).match(userMatch(tenantId, userPhone));
    await sendYesNo(userPhone, 'Marked missed today. Replace with Attended?');
    return;
  }
  if (hasAtt) {
    await supabase.from('users').update({ waiting_for: `dup_attend:${today}:${count}` }).match(userMatch(tenantId, userPhone));
    await sendYesNo(userPhone, 'Already logged today. Add again?');
    return;
  }
  await insertSessionsWithFallback({ userPhone, childId, date: today, count, status: 'attended', month: currentMonth, tenantId });
  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .match(withTenant(tenantId, { [childId ? 'child_id' : 'user_phone']: childId ? childId : userPhone }))
    .eq('month', currentMonth);
  const list = Array.isArray(sessions) ? sessions : [];
  const attended = list.filter(s => s.status === 'attended').length;
  const totalSessions = (configRow.paid_sessions || 0) + (configRow.carry_forward || 0);
  const remaining = totalSessions - attended;
  await sendMessage(userPhone, `✅ Session logged\n🎯 ${remaining} left this month`);
  await maybeSendStreakMilestone(userPhone, u, tenantId);
  await sendQuickMenu(userPhone, tenantId);
  await promptMood(userPhone, today, count, tenantId, true);
}

async function getOrCreateDefaultChild(userPhone, tenantId) {
  try {
    const { data: link } = await supabase
      .from('child_members')
      .select('child_id')
      .match(withTenant(tenantId, { member_phone: userPhone }))
      .limit(1);
    if (Array.isArray(link) && link[0]?.child_id) return link[0].child_id;
    const { data: childIns, error: childErr } = await supabase
      .from('children')
      .insert([withTenant(tenantId, { name: 'Default', created_by: userPhone })])
      .select('id');
    if (childErr) return null;
    const id = Array.isArray(childIns) ? childIns[0]?.id : null;
    if (id) await supabase.from('child_members').insert([withTenant(tenantId, { child_id: id, member_phone: userPhone, role: 'owner' })]);
    return id || null;
  } catch (_) { return null; }
}

async function insertSessionsWithFallback({ userPhone, childId, date, count, status, month, reason, tenantId }) {
  const rows = Array.from({ length: count }, () => withTenant(tenantId, ({
    user_phone: userPhone,
    date,
    status,
    month,
    child_id: childId,
    logged_by: userPhone,
    sessions_done: 1,
    ...(reason ? { reason } : {})
  })));
  const { error } = await supabase.from('sessions').insert(rows);
  if (error) {
    const minimal = rows.map(r => withTenant(tenantId, ({ user_phone: r.user_phone, date: r.date, status: r.status, month: r.month, ...(reason ? { reason } : {}) })));
    await supabase.from('sessions').insert(minimal);
  }
}

function parseIntent(text) {
  const t = (text || '').toLowerCase();
  if (/(\blanguage\b|\blang\b|\bmultilingual\b)/.test(t)) return { intent: 'LANGUAGE' };
  if (/(\btheme\b|\bbranding\b)/.test(t)) return { intent: 'THEME' };
  if (/(\bstreak\b|\bjourney\b|\bgamif)/.test(t)) return { intent: 'STREAK' };
  if (/(\bmy\s+referral\b|\breferral\s+code\b|\breferral\b)/.test(t)) return { intent: 'REFERRAL' };
  if (/(\bredeem\s+\w+)/.test(t)) {
    const m = t.match(/\bredeem\s+([a-z0-9_-]+)/i);
    return { intent: 'REDEEM', code: m ? m[1] : '' };
  }
  if (/(\bapply_coupon\s+\w+|\bcoupon\s+\w+)/.test(t)) {
    const m = t.match(/(?:apply_coupon|coupon)\s+([a-z0-9_-]+)/i);
    return { intent: 'COUPON', code: m ? m[1] : '' };
  }
  if (/(\badmin\s+members\b)/.test(t)) return { intent: 'ADMIN_MEMBERS' };
  if (/(\badmin\s+risk\b|\brisk\s+watch\b)/.test(t)) return { intent: 'ADMIN_RISK' };
  if (/(\bclinic\s+admin\b|\badmin\s+dashboard\b)/.test(t)) return { intent: 'CLINIC_ADMIN' };
  if (/(\bweekly\s+digest\b|\bparent\s+digest\b)/.test(t)) return { intent: 'WEEKLY_DIGEST' };
  if (/(\bmissed\s+analytics\b|\bmissed\s+report\b|\bmiss\s+analytics\b)/.test(t)) return { intent: 'MISSED_ANALYTICS' };
  if (/(\bstructured\s+note\b|\bnote\s+template\b|\btherapist\s+note\b)/.test(t)) return { intent: 'NOTE_TEMPLATE' };
  if (/(\bplan\b|\bmy\s+plan\b)/.test(t)) return { intent: 'PLAN' };
  if (/(\bpayment\s+status\b|\bbilling\s+status\b)/.test(t)) return { intent: 'PAYMENT_STATUS' };
  if (/(\binvite\b|\badd\s+parent\b|\badd\s+therapist\b)/.test(t)) return { intent: 'INVITE_MEMBER' };
  if (/(\bexport\b.*\bdata\b|\bdata\s*export\b)/.test(t)) return { intent: 'EXPORT_DATA' };
  if (/(\bdelete\b.*\bdata\b|\berase\b.*\bdata\b)/.test(t)) return { intent: 'DELETE_DATA' };
  if (/(\bmembers\b|\bteam\b)/.test(t)) return { intent: 'MEMBERS' };
  if (/(\bstatus\b|\btoday\s+status\b)/.test(t)) return { intent: 'STATUS' };
  if (/(\bweekly\b|\bweek\b)/.test(t)) return { intent: 'WEEKLY' };
  if (/(\bdownload\b.*\bpdf\b|\breport\s*pdf\b|\bmonthly\s*pdf\b)/.test(t)) return { intent: 'REPORT_PDF' };
  if (/(\bsummary\b|\breport\b)/.test(t)) return { intent: 'SUMMARY' };
  if (/(\bmissed\b|\bcancelled\b|\bnot\s+attended\b|\bno\s*show\b)/.test(t)) return { intent: 'MISSED' };
  if (/(\battended\b|\bdone\b|\bcompleted\b|\d+\s*(sessions?|done))/i.test(t)) {
    const m = t.match(/(\d+)\s*(?:sessions?|done|attended|completed)?/);
    const c = m ? parseInt(m[1], 10) : undefined;
    return { intent: 'ATTENDED', count: c };
  }
  return { intent: null };
}

module.exports = {
  handleMessage,
  sendReminderDefaults,
  __test: {
    isValidIsoDate,
    parseCommaDateList,
    expandDateRange,
    parseBulkLogCommand,
    monthBoundsIso,
    monthStartEndIso,
    hasPermission,
    normalizeRole,
    isPendingRole,
    pendingTargetRole,
    isInviteAcceptCommand,
    isInviteRejectCommand,
    normalizeMissReason,
    deriveRiskLevel,
    buildStructuredNoteTranscript,
    normalizeLocale,
    normalizeTheme,
    generateReferralCode,
    nextStreakMilestone,
    badgeForStreak
  }
};
