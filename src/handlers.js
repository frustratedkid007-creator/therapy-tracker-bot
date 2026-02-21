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
  sendVoiceNotePrompt,
  sendMoodPicker
} = require('./whatsapp');

function extractVoiceNote(message) {
  if (!message || typeof message !== 'string') return '';
  if (!message.startsWith('voice_note:')) return '';
  return message.slice('voice_note:'.length).trim();
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

async function saveFeedbackNote(userPhone, text, tenantId) {
  const note = String(text || '').trim();
  if (!note) return { ok: false };
  const summary = await summarizeFeedback(note);
  const row = withTenant(tenantId, {
    user_phone: userPhone,
    transcript: note,
    summary,
    created_at: new Date().toISOString()
  });
  const { error } = await supabase.from('feedback_notes').insert(row);
  if (error) {
    console.error('Supabase feedback_notes insert error:', error.message);
    return { ok: false, summary };
  }
  return { ok: true, summary };
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
  'export_data',
  'export_my_data',
  'delete_data',
  'delete_my_data',
  'erase_data'
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
  const rows = (data || []).map((m) => `- ${String(m.role || 'member')}: ${String(m.member_phone || '')}`);
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
    .select('id')
    .match(memberMatch)
    .limit(1);
  if (Array.isArray(existing) && existing.length) {
    await supabase.from('child_members').update({ role }).match(memberMatch);
    await sendMessage(userPhone, `Updated member role to ${role}: ${normalized}`);
    return;
  }
  const row = withTenant(tenantId, {
    child_id: childId,
    member_phone: normalized,
    role
  });
  const { error } = await supabase.from('child_members').insert(row);
  if (error) {
    await sendMessage(userPhone, `Could not add member: ${error.message}`);
    return;
  }
  await sendMessage(userPhone, `Added ${role}: ${normalized}`);
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
    await sendMessage(userPhone, `No setup found for ${month}. Type setup to begin.`);
    await sendQuickMenu(userPhone, tenantId);
    return;
  }
  const { configRow, attended, cancelled, totalSessions, remaining } = stats;
  await sendMessage(
    userPhone,
    `STATUS ${month}\n` +
    `Today: ${today}\n` +
    `Attended: ${attended}/${totalSessions}\n` +
    `Missed: ${cancelled}\n` +
    `Remaining: ${remaining}\n` +
    `Rate: INR ${configRow.cost_per_session || 0}`
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
      const reason = String(r.reason || 'Unspecified').trim();
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
  const tip = missed === 0
    ? 'Great consistency this week. Keep the same routine.'
    : 'Set reminder + backup slot to reduce missed sessions.';
  await sendMessage(
    userPhone,
    `WEEKLY INSIGHTS (${currentMonth})\n` +
    `${timeline}\n` +
    `Attended: ${attended}\n` +
    `Missed: ${missed}\n` +
    `Consistency: ${consistency}%\n` +
    `${topReason ? `Top miss reason: ${topReason[0]}` : 'No miss reasons this week'}\n` +
    `Tip: ${tip}`
  );
  await sendQuickMenu(userPhone, tenantId);
}

async function buildMonthlyReportPdf({ userPhone, month, stats }) {
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
  const pdf = await buildMonthlyReportPdf({ userPhone, month, stats });
  await sendDocument(userPhone, pdf, `Therapy-Report-${month}.pdf`, `Monthly report ${month}`);
  await sendMessage(userPhone, 'Report sent as PDF.');
  await sendQuickMenu(userPhone, tenantId);
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
        `ðŸ‘‹ Welcome to Therapy Tracker\n` +
        `âš™ï¸ Type 'setup' to begin`
      );
      await sendQuickMenu(userPhone, tenant);
      return;
    }

    const command = String(message || '').trim().toLowerCase();

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

    if (command === 'cancel' || command === 'back' || command === 'menu') {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenant, userPhone));
      await sendQuickMenu(userPhone, tenant);
      return;
    }

    if (command === 'undo' || command === 'undo_last') {
      await handleUndo(userPhone, tenant);
      return;
    }

    if (command === 'plan' || command === 'my_plan' || command === 'plan_status') {
      await handlePlanStatus(userPhone, user);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'export_data' || command === 'export_my_data' || command === 'data_export') {
      await handleDataExport(userPhone, tenant);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    if (command === 'delete_data' || command === 'delete_my_data' || command === 'erase_data') {
      await supabase.from('users').update({ waiting_for: 'delete_data_confirm' }).match(userMatch(tenant, userPhone));
      await sendYesNo(userPhone, 'Delete all your data permanently?');
      return;
    }
    if (command === 'members' || command === 'team') {
      await handleMembersList(userPhone, tenant);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    const addParentMatch = command.match(/^add_parent\s+(.+)$/);
    if (addParentMatch) {
      await handleAddMember(userPhone, tenant, 'parent', addParentMatch[1]);
      await sendQuickMenu(userPhone, tenant);
      return;
    }
    const addTherapistMatch = command.match(/^add_therapist\s+(.+)$/);
    if (addTherapistMatch) {
      await handleAddMember(userPhone, tenant, 'therapist', addTherapistMatch[1]);
      await sendQuickMenu(userPhone, tenant);
      return;
    }

    if (user.waiting_for) {
      const handled = await handleWaitingResponse(userPhone, message, user, tenant);
      if (handled) return;
    }

    if (message === 'feedback' || message === 'feedback_note' || message === 'note') {
      await supabase.from('users').update({ waiting_for: 'feedback_note' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, 'Send a voice note or type the feedback.');
      return;
    }
    const voiceNote = extractVoiceNote(message);
    if (voiceNote) {
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

    if (message === 'go_pro' || message === 'go_pro_199' || message === 'go_pro_499') {
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
      await handleStatus(userPhone, user, tenant);
      return;
    }
    if (message === 'weekly' || message === 'weekly_insights') {
      await handleWeekly(userPhone, user, tenant);
      return;
    }
    if (message === 'download_report' || message === 'report_pdf' || message === 'monthly_pdf') {
      await handleReportDownload(userPhone, user, tenant);
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
      const { intent } = parseIntent(message);
      if (intent === 'ATTENDED') {
        await sendAttendedDatePicker(userPhone, tenant);
        return;
      }
      if (intent === 'MISSED') {
        await handleMissed(userPhone, tenant);
        return;
      }
      if (intent === 'SUMMARY') {
        await handleSummary(userPhone, user, tenant);
        return;
      }
      if (intent === 'STATUS') {
        await handleStatus(userPhone, user, tenant);
        return;
      }
      if (intent === 'WEEKLY') {
        await handleWeekly(userPhone, user, tenant);
        return;
      }
      if (intent === 'REPORT_PDF') {
        await handleReportDownload(userPhone, user, tenant);
        return;
      }
      if (intent === 'PLAN') {
        await handlePlanStatus(userPhone, user);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (intent === 'EXPORT_DATA') {
        await handleDataExport(userPhone, tenant);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
      if (intent === 'DELETE_DATA') {
        await supabase.from('users').update({ waiting_for: 'delete_data_confirm' }).match(userMatch(tenant, userPhone));
        await sendYesNo(userPhone, 'Delete all your data permanently?');
        return;
      }
      if (intent === 'MEMBERS') {
        await handleMembersList(userPhone, tenant);
        await sendQuickMenu(userPhone, tenant);
        return;
      }
    }

    if (message.startsWith('missed_date:')) {
      const date = message.split(':')[1];
      await supabase.from('users').update({ waiting_for: `missed_reason:${date}` }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `Reason for missing on ${date}?`);
    } else if (message.startsWith('attended_date:')) {
      const date = message.split(':')[1];
      await supabase.from('users').update({ waiting_for: `attended_count:${date}` }).match(userMatch(tenant, userPhone));
      await sendAttendedCountPicker(userPhone, date);
    } else if (message === 'backfill_attended') {
      await sendBackfillDatePicker(userPhone, 'attended', tenant);
    } else if (message === 'backfill_missed') {
      await sendBackfillDatePicker(userPhone, 'missed', tenant);
    } else if (message.startsWith('backfill_date:')) {
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
      await markHolidayRange(userPhone, 1, tenant);
    } else if (message === 'holiday_next3') {
      await markHolidayRange(userPhone, 3, tenant);
    } else if (message === 'holiday_next7') {
      await markHolidayRange(userPhone, 7, tenant);
    } else if (message === 'holiday_range') {
      await supabase.from('users').update({ waiting_for: 'holiday_range' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, 'Type range as YYYY-MM-DD..YYYY-MM-DD');
    } else if (message === 'setup_other') {
      await handleSetup(userPhone, tenant);
    } else if (message === 'settings_timezone') {
      await sendTimezonePicker(userPhone, tenant);
    } else if (message.startsWith('tz:')) {
      const tz = message.slice(3);
      await supabase.from('users').update({ timezone: tz }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `âœ… Timezone updated\nðŸŒ ${tz}`);
      await sendQuickMenu(userPhone, tenant);
    } else if (message === 'settings_reminders') {
      await sendRemindersPicker(userPhone, tenant);
    } else if (message === 'settings_reminder_time') {
      await sendReminderTimePicker(userPhone, tenant);
    } else if (message.startsWith('reminder_time:')) {
      const hour = parseInt(message.split(':')[1], 10);
      if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
        await supabase.from('users').update({ reminder_time_hour: hour }).match(userMatch(tenant, userPhone));
        await sendMessage(userPhone, `âœ… Reminder time updated\nâ° ${String(hour).padStart(2, '0')}:00`);
        await sendQuickMenu(userPhone, tenant);
      } else {
        await sendReminderTimePicker(userPhone, tenant);
      }
    } else if (message === 'reminders_on') {
      await supabase.from('users').update({ reminders_enabled: true }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `âœ… Reminders ON`);
      await sendQuickMenu(userPhone, tenant);
    } else if (message === 'reminders_off') {
      await supabase.from('users').update({ reminders_enabled: false }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `âœ… Reminders OFF`);
      await sendQuickMenu(userPhone, tenant);
    } else if (message === 'setup_fresh') {
      await sendSetupPresets(userPhone);
      const { error: setWaitErr } = await supabase
        .from('users')
        .update({ waiting_for: 'setup_config' })
        .match(userMatch(tenant, userPhone));
      if (setWaitErr) console.error('Supabase users set waiting error:', setWaitErr.message);
    } else if (message === 'setup_mid') {
      await supabase.from('users').update({ waiting_for: 'setup_mid_config' }).match(userMatch(tenant, userPhone));
      await sendMessage(userPhone, `ðŸ§® Midâ€‘month setup\nReply: [total] [cost] [carry] [used]\nEx: 16 800 2 6`);
    } else if (message.includes('reset') || message === 'confirm_reset' || message === 'cancel_reset') {
      await handleReset(userPhone, message, tenant);
    } else if (message.includes('attended') || message === 'done' || message === 'ok' || message === 'âœ“') {
      await sendAttendedDatePicker(userPhone, tenant);
    } else if (message.includes('missed') || message.includes('cancelled')) {
      await handleMissed(userPhone, tenant);
    } else if (message.includes('plan')) {
      await handlePlanStatus(userPhone, user);
      await sendQuickMenu(userPhone, tenant);
    } else if (message.includes('export') && message.includes('data')) {
      await handleDataExport(userPhone, tenant);
      await sendQuickMenu(userPhone, tenant);
    } else if (message.includes('delete') && message.includes('data')) {
      await supabase.from('users').update({ waiting_for: 'delete_data_confirm' }).match(userMatch(tenant, userPhone));
      await sendYesNo(userPhone, 'Delete all your data permanently?');
    } else if (message.includes('members') || message.includes('team')) {
      await handleMembersList(userPhone, tenant);
      await sendQuickMenu(userPhone, tenant);
    } else if (message.includes('status')) {
      await handleStatus(userPhone, user, tenant);
    } else if (message.includes('weekly')) {
      await handleWeekly(userPhone, user, tenant);
    } else if (message.includes('download') || message.includes('pdf')) {
      await handleReportDownload(userPhone, user, tenant);
    } else if (message.includes('summary') || message.includes('report')) {
      await handleSummary(userPhone, user, tenant);
    } else if (message.includes('setup')) {
      await handleSetup(userPhone, tenant);
    } else if (message.includes('holiday') || message.includes('leave')) {
      await showHolidayPicker(userPhone);
    } else if (message.includes('more') || message.includes('menu')) {
      await sendMoreMenu(userPhone);
    } else {
      await sendQuickMenu(userPhone, tenant);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await sendMessage(userPhone, 'âš ï¸ Something went wrong. Please try again.');
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
      `âš ï¸ Please run setup first!\n\nType 'setup' to configure your monthly sessions.`
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
    `âœ… Session logged\n` +
    `ðŸŽ¯ ${remaining} left this month`
  );
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

async function handleWaitingResponse(userPhone, message, user, tenantId) {
  if (message === 'cancel' || message === 'back' || message === 'menu') {
    await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for === 'feedback_note') {
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
    let mood = '';
    if (message === 'voice_note_today') {
      await sendMessage(userPhone, `Please send a voice note about today's session.`);
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

  if (user.waiting_for === 'delete_data_confirm') {
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
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes' || message === 'confirm_reset';
    const no = message === 'no' || message === 'n' || message === 'confirm_no' || message === 'cancel_reset';
    if (yes) {
      const tz = await getUserTimeZone(userPhone, tenantId);
      const { month } = nowPartsInTimeZone(tz);
      const childId = await getOrCreateDefaultChild(userPhone, tenantId);
      if (childId) {
        await supabase.from('sessions').delete().match(withTenant(tenantId, { child_id: childId })).eq('month', month);
        await supabase.from('holidays').delete().match(withTenant(tenantId, { child_id: childId })).eq('month', month);
      } else {
        await supabase.from('sessions').delete().match(userPhoneMatch(tenantId, userPhone)).eq('month', month);
        await supabase.from('holidays').delete().match(userPhoneMatch(tenantId, userPhone)).eq('month', month);
      }
      await supabase.from('monthly_config').delete().match(userPhoneMatch(tenantId, userPhone)).eq('month', month);
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, `ðŸ§¹ Reset complete for ${month}`);
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, 'Reset cancelled');
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    await sendYesNo(userPhone, 'Reset this month? This will clear sessions and config.');
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
    await sendMessage(userPhone, `âŒ Missed logged\nðŸ—“ ${date}\nðŸ“ ${reason}`);
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
      `âŒ Missed logged\n` +
      `ðŸ—“ ${today}\n` +
      `ðŸ“ ${extractVoiceNote(message) || message}`
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
      await sendMessage(userPhone, `âœ… Added again\nðŸ—“ ${date}`);
      await sendQuickMenu(userPhone, tenantId);
      await promptMood(userPhone, date, count, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, 'âŽ Skipped');
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
      await sendMessage(userPhone, `âŒ Missed logged again\nðŸ—“ ${date}\nðŸ”¢ ${count}\nðŸ“ ${reason}`);
      await sendQuickMenu(userPhone, tenantId);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).match(userMatch(tenantId, userPhone));
      await sendMessage(userPhone, 'âŽ Skipped');
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
      await sendMessage(userPhone, `ðŸ” Replaced Attended with Missed\nðŸ—“ ${date}\nðŸ”¢ ${count}\nðŸ“ ${reason}`);
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
      await sendMessage(userPhone, `ðŸ” Replaced Missed with Attended\nðŸ—“ ${date}`);
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
    await sendMessage(userPhone, `âœ… Attended logged\nðŸ—“ ${date}\nðŸ”¢ ${count}`);
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
    await sendMessage(userPhone, `âœ… Backfilled Attended\nðŸ—“ ${date}\nðŸ”¢ ${count}`);
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
    await sendMessage(userPhone, `âŒ Backfilled Missed\nðŸ—“ ${date}\nðŸ”¢ ${count}\nðŸ“ ${reason}`);
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
    await sendMessage(userPhone, `âŒ Backfilled Missed\nðŸ—“ ${date}\nðŸ”¢ ${count}\nðŸ“ ${reason}`);
    await sendQuickMenu(userPhone, tenantId);
    return true;
  }

  if (user.waiting_for === 'setup_config') {
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

    await sendMessage(userPhone, `âœ… Setup complete for ${month}.\nTotal sessions: ${total_sessions}\nCarry forward: ${carry_forward}\nPaid this month: ${paid_sessions}\nYou can now tap 'Attended'.`);
    return true;
  }

  if (user.waiting_for === 'setup_mid_config') {
    const parts = message.split(/\s+/).map(v => v.trim()).filter(Boolean);
    if (parts.length < 4 || parts.some(p => isNaN(parseInt(p, 10)))) {
      await sendMessage(userPhone, `ðŸ§® Midâ€‘month setup\nReply: [total] [cost] [carry] [used]\nEx: 16 800 2 6`);
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
    await sendMessage(userPhone, `âœ… Setup complete\nðŸ§® Total: ${total_sessions}\nâœ… Done: ${used}\nðŸŽ¯ Remaining: ${remaining}`);
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
    await sendMessage(userPhone, 'â„¹ï¸ No config. Type "setup" to begin.');
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

  const dt = new Date(currentMonth + '-01');
  const monthName = dt.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }).toUpperCase();
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const lastWeekStart = new Date(lastDay); lastWeekStart.setDate(lastDay.getDate() - 6);
  const isLastWeek = now >= lastWeekStart;

  const header = `ðŸ“Š ${monthName} SUMMARY`;
  const payment = `ðŸ’° PAYMENT\nâ€¢ Paid: ${configRow.paid_sessions || 0} sessions\nâ€¢ Cost: â‚¹${configRow.cost_per_session || 0}/session\nâ€¢ Total paid: â‚¹${(configRow.paid_sessions || 0) * (configRow.cost_per_session || 0)}`;
  const attendance = `ðŸ“ˆ ATTENDANCE\nâ€¢ Attended: ${attended} (â‚¹${amountUsed})\nâ€¢ Cancelled: ${cancelled} (â‚¹${amountCancelled})`;
  const costBreakdown = `ðŸ’¸ COST BREAKDOWN\nâ€¢ Used: â‚¹${amountUsed}\nâ€¢ Buffer: â‚¹${bufferValue}`;
  const summaryBlock = `âœ¨ SUMMARY\nâ€¢ Remaining: ${Math.max(0, remaining)} sessions` + (isLastWeek ? `\nâ€¢ Carry forward: ${Math.max(0, remaining)} sessions` : '');

  const summary = [header, '', payment, '', attendance, '', costBreakdown, '', summaryBlock].join('\n');

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
  const label = row.status === 'attended' ? 'âœ… Attended' : 'âŒ Missed';
  await sendMessage(userPhone, `â†©ï¸ Undone\n${label}\nðŸ—“ ${String(row.date).slice(0, 10)}`);
  await sendQuickMenu(userPhone, tenantId);
}

async function handleSetup(userPhone, tenantId) {
  await sendMessage(userPhone, `âš™ï¸ Setup\nChoose a mode:`);
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

  await sendMessage(userPhone, `ðŸ–ï¸ Marked ${days} day(s) off`);
}

async function handleReset(userPhone, message, tenantId) {
  if (message === 'confirm_reset' || message === 'cancel_reset') {
    await supabase.from('users').update({ waiting_for: 'reset_confirm' }).match(userMatch(tenantId, userPhone));
    await handleWaitingResponse(userPhone, message === 'confirm_reset' ? 'confirm_yes' : 'confirm_no', { waiting_for: 'reset_confirm' }, tenantId);
    return;
  }
  await supabase.from('users').update({ waiting_for: 'reset_confirm' }).match(userMatch(tenantId, userPhone));
  await sendYesNo(userPhone, 'Reset this month? This will clear sessions and config.');
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
  await sendMessage(userPhone, `ðŸ–ï¸ Marked ${days} day(s) off`);
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
  await sendMessage(userPhone, `âœ… Session logged\nðŸŽ¯ ${remaining} left this month`);
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
  if (/(\bplan\b|\bmy\s+plan\b)/.test(t)) return { intent: 'PLAN' };
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
  sendReminderDefaults
};
