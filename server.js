const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));

function validateEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_KEY', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID'];
  if (process.env.NODE_ENV === 'production' && process.env.SKIP_WEBHOOK_SIGNATURE !== 'true') required.push('WHATSAPP_APP_SECRET');
  const missing = required.filter((k) => !process.env[k] || process.env[k].trim() === '');
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  const url = process.env.SUPABASE_URL;
  if (!/^https?:\/\//i.test(url)) {
    console.error('Invalid SUPABASE_URL. It must start with http:// or https://');
    process.exit(1);
  }
}

validateEnv();

const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);

// WhatsApp configuration
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'therapy_tracker_2025';
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const processedMessageIds = new Map();
const duplicateWindowMs = 5 * 60 * 1000;

function safeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyWebhookSignature(req) {
  if (process.env.SKIP_WEBHOOK_SIGNATURE === 'true') return true;
  if (!WHATSAPP_APP_SECRET) return false;
  const signature = req.get('x-hub-signature-256');
  if (!signature) return false;
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = `sha256=${crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`;
  return safeEqual(signature, expected);
}

function seenRecently(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > duplicateWindowMs) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

async function shouldProcessInboundMessage(messageId) {
  if (!messageId) return true;
  if (seenRecently(messageId)) return false;
  try {
    const { error } = await supabase.from('processed_inbound_messages').insert({ message_id: messageId });
    if (!error) return true;
    if (String(error.code) === '23505') return false;
    return true;
  } catch {
    return true;
  }
}

// Webhook verification (required by Meta)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) {
      res.sendStatus(403);
      return;
    }
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      
      if (value?.messages?.[0]) {
        const message = value.messages[0];
        const ok = await shouldProcessInboundMessage(message.id);
        if (!ok) {
          res.sendStatus(200);
          return;
        }
        const from = message.from;
        let messageBody = (message.text?.body || '').toLowerCase().trim();
        if (message.type === 'interactive') {
          const bid = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
          if (bid) messageBody = bid.toLowerCase();
        }
        
        console.log(`Message from ${from}: ${messageBody}`);
        
        // Process the message
        await handleMessage(from, messageBody);
      } else {
        const hasStatuses = Array.isArray(value?.statuses) && value.statuses.length > 0;
        console.log('Webhook event received but no messages array; statuses:', hasStatuses ? JSON.stringify(value.statuses) : 'none');
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.sendStatus(500);
  }
});

// Handle incoming messages
async function handleMessage(userPhone, message) {
  try {
    if (!message) {
      await sendQuickMenu(userPhone);
      return;
    }
    // Get user's current state
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('phone', userPhone)
      .single();
    if (userErr) {
      console.error('Supabase users select error:', userErr.message);
    }

    // New user - send welcome
    if (!user) {
      await createUser(userPhone);
      await sendMessage(userPhone, 
        `👋 Welcome to Therapy Tracker\n` +
        `⚙️ Type 'setup' to begin`
      );
      await sendQuickMenu(userPhone);
      return;
    }

    if (message === 'cancel' || message === 'back' || message === 'menu') {
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendQuickMenu(userPhone);
      return;
    }

    if (message === 'undo' || message === 'undo_last') {
      await handleUndo(userPhone);
      return;
    }

    // Check if waiting for response
    if (user.waiting_for) {
      const handled = await handleWaitingResponse(userPhone, message, user);
      if (handled) return;
    }

    // Handle commands
    if (message === 'yes' || message === 'y' || message === 'confirm_yes') {
      if (user.waiting_for === 'state:AWAITING_CONFIRMATION') {
        await confirmAttended(userPhone);
        return;
      }
    } else if (message === 'no' || message === 'n' || message === 'confirm_no') {
      if (user.waiting_for === 'state:AWAITING_CONFIRMATION') {
        await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
        await sendMessage(userPhone, 'Okay, not logged.');
        await sendQuickMenu(userPhone);
        return;
      }
    } else {
      const { intent } = parseIntent(message);
      if (intent === 'ATTENDED') {
        await sendAttendedDatePicker(userPhone);
        return;
      }
      if (intent === 'MISSED') {
        await handleMissed(userPhone);
        return;
      }
      if (intent === 'SUMMARY') {
        await handleSummary(userPhone, user);
        return;
      }
    }

    if (message.startsWith('missed_date:')) {
      const date = message.split(':')[1];
      await supabase.from('users').update({ waiting_for: `missed_reason:${date}` }).eq('phone', userPhone);
      await sendMessage(userPhone, `Reason for missing on ${date}?`);
    } else if (message.startsWith('attended_date:')) {
      const date = message.split(':')[1];
      await supabase.from('users').update({ waiting_for: `attended_count:${date}` }).eq('phone', userPhone);
      await sendAttendedCountPicker(userPhone, date);
    } else if (message === 'backfill_attended') {
      await sendBackfillDatePicker(userPhone, 'attended');
    } else if (message === 'backfill_missed') {
      await sendBackfillDatePicker(userPhone, 'missed');
    } else if (message.startsWith('backfill_date:')) {
      const parts = message.split(':');
      const type = parts[1];
      const date = parts[2];
      if (type === 'attended') {
        await supabase.from('users').update({ waiting_for: `backfill_attended_count:${date}` }).eq('phone', userPhone);
        await sendBackfillCountPicker(userPhone, 'attended', date);
      } else if (type === 'missed') {
        await supabase.from('users').update({ waiting_for: `backfill_missed_count:${date}` }).eq('phone', userPhone);
        await sendBackfillCountPicker(userPhone, 'missed', date);
      }
    } else if (message === 'holiday_today') {
      await markHolidayRange(userPhone, 1);
    } else if (message === 'holiday_next3') {
      await markHolidayRange(userPhone, 3);
    } else if (message === 'holiday_next7') {
      await markHolidayRange(userPhone, 7);
    } else if (message === 'holiday_range') {
      await supabase.from('users').update({ waiting_for: 'holiday_range' }).eq('phone', userPhone);
      await sendMessage(userPhone, 'Type range as YYYY-MM-DD..YYYY-MM-DD');
    } else if (message === 'setup_other') {
      await handleSetup(userPhone);
    } else if (message === 'setup_fresh') {
      await sendSetupPresets(userPhone);
      const { error: setWaitErr } = await supabase
        .from('users')
        .update({ waiting_for: 'setup_config' })
        .eq('phone', userPhone);
      if (setWaitErr) console.error('Supabase users set waiting error:', setWaitErr.message);
    } else if (message === 'setup_mid') {
      await supabase.from('users').update({ waiting_for: 'setup_mid_config' }).eq('phone', userPhone);
      await sendMessage(userPhone, `🧮 Mid‑month setup\nReply: [total] [cost] [carry] [used]\nEx: 16 800 2 6`);
    } else if (message.includes('reset') || message === 'confirm_reset' || message === 'cancel_reset') {
      await handleReset(userPhone, message);
    } else if (message.includes('attended') || message === 'done' || message === 'ok' || message === '✓') {
      await sendAttendedDatePicker(userPhone);
    } else if (message.includes('missed') || message.includes('cancelled')) {
      await handleMissed(userPhone);
    } else if (message.includes('summary') || message.includes('report')) {
      await handleSummary(userPhone, user);
    } else if (message.includes('setup')) {
      await handleSetup(userPhone);
    } else if (message.includes('holiday') || message.includes('leave')) {
      await showHolidayPicker(userPhone);
    } else if (message.includes('more') || message.includes('menu')) {
      await sendMoreMenu(userPhone);
    } else {
      await sendQuickMenu(userPhone);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await sendMessage(userPhone, '⚠️ Something went wrong. Please try again.');
  }
}

// Create new user
async function createUser(phone) {
  const { error } = await supabase.from('users').insert({
    phone: phone,
    created_at: new Date().toISOString()
  });
  if (error) {
    console.error('Supabase users insert error:', error.message);
  }
}

// Handle attended session
async function handleAttended(userPhone, user) {
  const today = new Date().toISOString().split('T')[0];
  
  // Get current month config
  const currentMonth = new Date().toISOString().slice(0, 7);
  const { data: config, error: cfgErr } = await supabase
    .from('monthly_config')
    .select('*')
    .eq('user_phone', userPhone)
    .eq('month', currentMonth)
    .single();
  if (cfgErr) {
    console.error('Supabase monthly_config select error:', cfgErr.message);
  }

  if (!config) {
    await sendMessage(userPhone, 
      `⚠️ Please run setup first!\n\nType 'setup' to configure your monthly sessions.`
    );
    return;
  }

  // Log session
  const { error: insErr } = await supabase.from('sessions').insert({
    user_phone: userPhone,
    date: today,
    status: 'attended',
    month: currentMonth
  });
  if (insErr) {
    console.error('Supabase sessions insert error:', insErr.message);
  }

  // Get stats
  const { data: sessions, error: sesErr } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_phone', userPhone)
    .eq('month', currentMonth);
  if (sesErr) {
    console.error('Supabase sessions select error:', sesErr.message);
  }

  const list = Array.isArray(sessions) ? sessions : [];
  const attended = list.filter(s => s.status === 'attended').length;
  const todayCount = list.filter(s => s.date === today && s.status === 'attended').length;
  const totalSessions = (config.paid_sessions || 0) + (config.carry_forward || 0);
  const remaining = totalSessions - attended;

  await sendMessage(userPhone,
    `✅ Session logged\n` +
    `🎯 ${remaining} left this month`
  );
  await sendQuickMenu(userPhone);
}

// Handle missed session
async function handleMissed(userPhone) {
  await sendMissedDatePicker(userPhone);
}

// Handle waiting responses
async function handleWaitingResponse(userPhone, message, user) {
  if (message === 'cancel' || message === 'back' || message === 'menu') {
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    await sendQuickMenu(userPhone);
    return true;
  }
  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('state:AWAITING_CONFIRMATION')) {
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes';
    const no = message === 'no' || message === 'n' || message === 'confirm_no';
    const { intent } = parseIntent(message);
    // Treat 'attended' while waiting as implicit YES
    if (yes || intent === 'ATTENDED') { await confirmAttended(userPhone); return true; }
    // Allow switching to 'missed' directly from confirmation state
    if (intent === 'MISSED') {
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await handleMissed(userPhone);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, 'Okay, not logged.');
      await sendQuickMenu(userPhone);
      return true;
    }
    await sendYesNo(userPhone, 'Log session for today?');
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('missed_reason:')) {
    const date = user.waiting_for.split(':')[1];
    const month = date.slice(0,7);
    const reason = message;
    const childId = await getOrCreateDefaultChild(userPhone);

    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing, error: exErr } = await supabase
      .from('sessions')
      .select('status')
      .eq(idKey, idVal)
      .eq('date', date);
    if (exErr) console.error('Supabase select existing for missed:', exErr.message);

    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');

    if (hasAttended) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `replace_with_missed:${date}:${payload}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Replace with Missed?`);
      return true;
    }
    if (hasMissed) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `dup_missed:${date}:${payload}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Add again?`);
      return true;
    }

    const { error: insErr } = await supabase.from('sessions').insert({
      user_phone: userPhone,
      child_id: childId,
      logged_by: userPhone,
      sessions_done: 1,
      date,
      status: 'cancelled',
      reason,
      month
    });
    if (insErr) console.error('Supabase sessions insert cancel error:', insErr.message);
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    await sendMessage(userPhone, `❌ Missed logged\n🗓 ${date}\n📝 ${reason}`);
    await sendQuickMenu(userPhone);
    return true;
  }

  if (user.waiting_for === 'cancellation_reason') {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toISOString().slice(0, 7);

    const { error: canErr } = await supabase.from('sessions').insert({
      user_phone: userPhone,
      date: today,
      status: 'cancelled',
      reason: message,
      month: currentMonth
    });
    if (canErr) {
      console.error('Supabase sessions insert cancel error:', canErr.message);
    }

    const { error: clrErr } = await supabase
      .from('users')
      .update({ waiting_for: null })
      .eq('phone', userPhone);
    if (clrErr) {
      console.error('Supabase users clear waiting error:', clrErr.message);
    }

    await sendMessage(userPhone,
      `❌ Missed logged\n` +
      `🗓 ${today}\n` +
      `📝 ${message}`
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
      const month = date.slice(0,7);
      const childId = await getOrCreateDefaultChild(userPhone);
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month, reason: 'duplicate_confirmed' });
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, `✅ Added again\n🗓 ${date}`);
      await sendQuickMenu(userPhone);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, '❎ Skipped');
      await sendQuickMenu(userPhone);
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
      const childId = await getOrCreateDefaultChild(userPhone);
      const month = date.slice(0,7);
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'cancelled', month, reason });
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, `❌ Missed logged again\n🗓 ${date}\n🔢 ${count}\n📝 ${reason}`);
      await sendQuickMenu(userPhone);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, '❎ Skipped');
      await sendQuickMenu(userPhone);
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
      const childId = await getOrCreateDefaultChild(userPhone);
      const key = childId ? 'child_id' : 'user_phone';
      const val = childId ? childId : userPhone;
      await supabase.from('sessions').delete().eq(key, val).eq('date', date).eq('status', 'attended');
      const month = date.slice(0,7);
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'cancelled', month, reason });
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, `🔁 Replaced Attended with Missed\n🗓 ${date}\n🔢 ${count}\n📝 ${reason}`);
      await sendQuickMenu(userPhone);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, 'Kept as Attended');
      await sendQuickMenu(userPhone);
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
      const childId = await getOrCreateDefaultChild(userPhone);
      const key = childId ? 'child_id' : 'user_phone';
      const val = childId ? childId : userPhone;
      await supabase.from('sessions').delete().eq(key, val).eq('date', date).eq('status', 'cancelled');
      const month = date.slice(0,7);
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month, reason: 'replaced_cancelled' });
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, `🔁 Replaced Missed with Attended\n🗓 ${date}`);
      await sendQuickMenu(userPhone);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, 'Kept as Missed');
      await sendQuickMenu(userPhone);
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
    const month = date.slice(0,7);
    const childId = await getOrCreateDefaultChild(userPhone);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing } = await supabase.from('sessions').select('status').eq(idKey, idVal).eq('date', date);
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');
    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    if (hasMissed) {
      await supabase.from('users').update({ waiting_for: `repl_can_attend:${date}:${count}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Replace with Attended?`);
      return true;
    }
    if (hasAttended) {
      await supabase.from('users').update({ waiting_for: `dup_attend:${date}:${count}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Add again?`);
      return true;
    }
    await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month });
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    await sendMessage(userPhone, `✅ Attended logged\n🗓 ${date}\n🔢 ${count}`);
    await sendQuickMenu(userPhone);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('backfill_attended_count:')) {
    const date = user.waiting_for.split(':')[1];
    if (!message.startsWith('backfill_count:')) {
      await sendBackfillCountPicker(userPhone, 'attended', date);
      return true;
    }
    const count = Math.max(1, parseInt(message.split(':')[1] || '1', 10));
    const month = date.slice(0,7);
    const childId = await getOrCreateDefaultChild(userPhone);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing } = await supabase.from('sessions').select('status').eq(idKey, idVal).eq('date', date);
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');
    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    if (hasMissed) {
      await supabase.from('users').update({ waiting_for: `repl_can_attend:${date}:${count}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Replace with Attended?`);
      return true;
    }
    if (hasAttended) {
      await supabase.from('users').update({ waiting_for: `dup_attend:${date}:${count}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Add again?`);
      return true;
    }
    await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month, reason: 'backfill' });
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    await sendMessage(userPhone, `✅ Backfilled Attended\n🗓 ${date}\n🔢 ${count}`);
    await sendQuickMenu(userPhone);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('backfill_missed_count:')) {
    const date = user.waiting_for.split(':')[1];
    if (!message.startsWith('backfill_count:')) {
      await sendBackfillCountPicker(userPhone, 'missed', date);
      return true;
    }
    const count = Math.max(1, parseInt(message.split(':')[1] || '1', 10));
    await supabase.from('users').update({ waiting_for: `backfill_missed_reason:${date}:${count}` }).eq('phone', userPhone);
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
      await supabase.from('users').update({ waiting_for: `backfill_missed_note:${date}:${count}` }).eq('phone', userPhone);
      await sendMessage(userPhone, `Type reason for ${date}`);
      return true;
    }
    const reason = reasonKey === 'sick' ? 'Sick' : reasonKey === 'travel' ? 'Travel' : reasonKey === 'therapist' ? 'Therapist unavailable' : 'Other';
    const month = date.slice(0,7);
    const childId = await getOrCreateDefaultChild(userPhone);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing } = await supabase.from('sessions').select('status').eq(idKey, idVal).eq('date', date);
    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');
    if (hasAttended) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `replace_with_missed:${date}:${count}:${payload}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Replace with Missed?`);
      return true;
    }
    if (hasMissed) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `dup_missed:${date}:${count}:${payload}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Add again?`);
      return true;
    }
    await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'cancelled', month, reason });
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    await sendMessage(userPhone, `❌ Backfilled Missed\n🗓 ${date}\n🔢 ${count}\n📝 ${reason}`);
    await sendQuickMenu(userPhone);
    return true;
  }

  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('backfill_missed_note:')) {
    const parts = user.waiting_for.split(':');
    const date = parts[1];
    const count = Math.max(1, parseInt(parts[2] || '1', 10));
    const reason = message;
    const month = date.slice(0,7);
    const childId = await getOrCreateDefaultChild(userPhone);
    const idKey = childId ? 'child_id' : 'user_phone';
    const idVal = childId ? childId : userPhone;
    const { data: existing } = await supabase.from('sessions').select('status').eq(idKey, idVal).eq('date', date);
    const hasAttended = Array.isArray(existing) && existing.some(r => r.status === 'attended');
    const hasMissed = Array.isArray(existing) && existing.some(r => r.status === 'cancelled');
    if (hasAttended) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `replace_with_missed:${date}:${count}:${payload}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Attended on ${date}. Replace with Missed?`);
      return true;
    }
    if (hasMissed) {
      const payload = Buffer.from(reason, 'utf8').toString('base64');
      await supabase.from('users').update({ waiting_for: `dup_missed:${date}:${count}:${payload}` }).eq('phone', userPhone);
      await sendYesNo(userPhone, `Already marked Missed on ${date}. Add again?`);
      return true;
    }
    await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'cancelled', month, reason });
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    await sendMessage(userPhone, `❌ Backfilled Missed\n🗓 ${date}\n🔢 ${count}\n📝 ${reason}`);
    await sendQuickMenu(userPhone);
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
    const month = new Date().toISOString().slice(0, 7);

    const { error: upsertErr } = await supabase
      .from('monthly_config')
      .upsert([
        {
          user_phone: userPhone,
          month,
          paid_sessions,
          cost_per_session,
          carry_forward
        }
      ], { onConflict: 'user_phone,month' });
    if (upsertErr) {
      console.error('Supabase monthly_config upsert error:', upsertErr.message);
    }

    const { error: clr2Err } = await supabase
      .from('users')
      .update({ waiting_for: null })
      .eq('phone', userPhone);
    if (clr2Err) {
      console.error('Supabase users clear after setup error:', clr2Err.message);
    }

    await sendMessage(userPhone, `✅ Setup complete for ${month}.\nTotal sessions: ${total_sessions}\nCarry forward: ${carry_forward}\nPaid this month: ${paid_sessions}\nYou can now tap 'Attended'.`);
    return true;
  }

  if (user.waiting_for === 'setup_mid_config') {
    const parts = message.split(/\s+/).map(v => v.trim()).filter(Boolean);
    if (parts.length < 4 || parts.some(p => isNaN(parseInt(p, 10)))) {
      await sendMessage(userPhone, `🧮 Mid‑month setup\nReply: [total] [cost] [carry] [used]\nEx: 16 800 2 6`);
      return true;
    }
    const total_sessions = parseInt(parts[0], 10);
    const cost_per_session = parseInt(parts[1], 10);
    const carry_forward = parseInt(parts[2], 10);
    const used = Math.max(0, parseInt(parts[3], 10));
    const paid_sessions = Math.max(0, total_sessions - carry_forward);
    const month = new Date().toISOString().slice(0, 7);

    const { error: upErr } = await supabase.from('monthly_config').upsert([
      { user_phone: userPhone, month, paid_sessions, cost_per_session, carry_forward }
    ], { onConflict: 'user_phone,month' });
    if (upErr) console.error('monthly_config upsert mid error:', upErr.message);

    // Bulk backfill attended across earlier days this month
    if (used > 0) {
      await bulkBackfillAttended(userPhone, used, month);
    }

    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    const remaining = total_sessions - used;
    await sendMessage(userPhone, `✅ Setup complete\n🧮 Total: ${total_sessions}\n✅ Done: ${used}\n🎯 Remaining: ${remaining}`);
    await sendQuickMenu(userPhone);
    return true;
  }
  return false;
}

// Handle summary request
async function handleSummary(userPhone, user) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  
  // Get config
  const { data: config, error: cfgErr2 } = await supabase
    .from('monthly_config')
    .select('*')
    .eq('user_phone', userPhone)
    .eq('month', currentMonth)
    .single();
  if (cfgErr2) {
    console.error('Supabase monthly_config select error:', cfgErr2.message);
  }

  if (!config) {
    await sendMessage(userPhone, 'ℹ️ No config. Type "setup" to begin.');
    return;
  }

  // Get sessions
  const { data: sessions, error: sesErr2 } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_phone', userPhone)
    .eq('month', currentMonth);
  if (sesErr2) {
    console.error('Supabase sessions select error:', sesErr2.message);
  }

  const list = Array.isArray(sessions) ? sessions : [];
  const attended = list.filter(s => s.status === 'attended').length;
  const cancelled = list.filter(s => s.status === 'cancelled').length;
  const totalSessions = (config.paid_sessions || 0) + (config.carry_forward || 0);
  const remaining = totalSessions - attended;
  const amountUsed = Math.max(0, Math.min(attended, config.paid_sessions || 0)) * (config.cost_per_session || 0);
  const amountCancelled = Math.max(0, Math.min(cancelled, Math.max((config.paid_sessions || 0) - Math.min(attended, config.paid_sessions || 0), 0))) * (config.cost_per_session || 0);
  const bufferSessions = Math.max(0, totalSessions - attended - cancelled);
  const bufferValue = bufferSessions * (config.cost_per_session || 0);

  const dt = new Date(currentMonth + '-01');
  const monthName = dt.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }).toUpperCase();
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const lastWeekStart = new Date(lastDay); lastWeekStart.setDate(lastDay.getDate() - 6);
  const isLastWeek = now >= lastWeekStart;

  const header = `📊 ${monthName} SUMMARY`;
  const payment = `💰 PAYMENT\n• Paid: ${config.paid_sessions || 0} sessions\n• Cost: ₹${config.cost_per_session || 0}/session\n• Total paid: ₹${(config.paid_sessions || 0) * (config.cost_per_session || 0)}`;
  const attendance = `📈 ATTENDANCE\n• Attended: ${attended} (₹${amountUsed})\n• Cancelled: ${cancelled} (₹${amountCancelled})`;
  const costBreakdown = `💸 COST BREAKDOWN\n• Used: ₹${amountUsed}\n• Buffer: ₹${bufferValue}`;
  const summaryBlock = `✨ SUMMARY\n• Remaining: ${Math.max(0, remaining)} sessions` + (isLastWeek ? `\n• Carry forward: ${Math.max(0, remaining)} sessions` : '');

  const summary = [header, '', payment, '', attendance, '', costBreakdown, '', summaryBlock].join('\n');

  await sendMessage(userPhone, summary);
  if (user?.waiting_for && user.waiting_for.startsWith && user.waiting_for.startsWith('state:')) {
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
  }
}

async function handleUndo(userPhone) {
  const { data: last } = await supabase
    .from('sessions')
    .select('id,date,status,reason,created_at')
    .eq('user_phone', userPhone)
    .order('created_at', { ascending: false })
    .limit(1);
  const row = Array.isArray(last) ? last[0] : null;
  if (!row?.id) {
    await sendMessage(userPhone, `Nothing to undo`);
    await sendQuickMenu(userPhone);
    return;
  }
  await supabase.from('sessions').delete().eq('id', row.id);
  const label = row.status === 'attended' ? '✅ Attended' : '❌ Missed';
  await sendMessage(userPhone, `↩️ Undone\n${label}\n🗓 ${String(row.date).slice(0,10)}`);
  await sendQuickMenu(userPhone);
}

// Handle setup
async function handleSetup(userPhone) {
  await sendMessage(userPhone, `⚙️ Setup\nChoose a mode:`);
  await sendSetupMode(userPhone);

  const { error: setWaitErr } = await supabase
    .from('users')
    .update({ waiting_for: 'setup_config' })
    .eq('phone', userPhone);
  if (setWaitErr) {
    console.error('Supabase users set waiting error:', setWaitErr.message);
  }
}

// Handle holiday
async function handleHoliday(userPhone, message) {
  const daysMatch = message.match(/(\d+)\s*days?/);
  const days = daysMatch ? parseInt(daysMatch[1]) : 1;
  
  const currentMonth = new Date().toISOString().slice(0, 7);
  const today = new Date();

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];

    const { error: holErr } = await supabase.from('holidays').insert({
      user_phone: userPhone,
      date: dateStr,
      month: currentMonth
    });
    if (holErr) {
      console.error('Supabase holidays insert error:', holErr.message);
    }
  }

  await sendMessage(userPhone, `🏖️ Marked ${days} day(s) off`);
}

// Send WhatsApp message
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Message sent to ${to}`);
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
  }
}

async function sendQuickMenu(to) {
  try {
    const month = new Date().toISOString().slice(0,7);
    let stats = '';
    const { data: cfg } = await supabase.from('monthly_config').select('*').eq('user_phone', to).eq('month', month).single();
    if (cfg) {
      const { data: ss } = await supabase.from('sessions').select('*').eq('user_phone', to).eq('month', month);
      const lst = Array.isArray(ss)?ss:[];
      const att = lst.filter(s=>s.status==='attended').length;
      const totalSessions = (cfg.paid_sessions || 0) + (cfg.carry_forward || 0);
      stats = `${month} • ${att}/${totalSessions} attended`;
    } else {
      stats = `${month} • setup pending`;
    }
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `${stats}\nWhat would you like to do?` },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'attended', title: '✅ Attended' } },
            { type: 'reply', reply: { id: 'missed', title: '❌ Missed' } },
            { type: 'reply', reply: { id: 'summary', title: '📊 Summary' } }
          ]
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending quick menu:', error.response?.data || error.message);
  }
}

async function sendMoreMenu(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'More options' },
        body: { text: 'Open tools and settings' },
        action: {
          button: 'Open',
          sections: [
            { title: 'Tools', rows: [
              { id: 'summary', title: 'Monthly summary' },
              { id: 'backfill_attended', title: 'Backfill • Attended' },
              { id: 'backfill_missed', title: 'Backfill • Missed' },
              { id: 'holiday_range', title: 'Mark absence (range)' },
              { id: 'holiday_next3', title: 'Mark next 3 days' },
              { id: 'holiday_next7', title: 'Mark next 7 days' }
            ]},
            { title: 'Settings', rows: [
              { id: 'setup_other', title: 'Update configuration' },
              { id: 'setup_fresh', title: 'Setup • Start Fresh' },
              { id: 'setup_mid', title: 'Setup • Start Mid‑Month' },
              { id: 'reset', title: 'Reset month' }
            ]}
          ]
        }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending more menu:', e.response?.data || e.message);
  }
}

async function showHolidayPicker(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Mark planned absence' },
        body: { text: 'Pick a range' },
        action: {
          button: 'Choose',
          sections: [
            { title: 'Quick options', rows: [
              { id: 'holiday_today', title: 'Today' },
              { id: 'holiday_next3', title: 'Next 3 days' },
              { id: 'holiday_next7', title: 'Next 7 days' },
              { id: 'holiday_range', title: 'Custom range' }
            ]}
          ]
        }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending holiday picker:', e.response?.data || e.message);
  }
}

async function markHolidayRange(userPhone, days) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const { error } = await supabase.from('holidays').insert({ user_phone: userPhone, date: dateStr, month: currentMonth });
    if (error) console.error('Supabase holidays insert error:', error.message);
  }
  await sendMessage(userPhone, `🏖️ Marked ${days} day(s) off`);
}

async function sendMissedDatePicker(to) {
  try {
    const today = new Date();
    const rows = [];
    const todayStr = new Date(today).toISOString().split('T')[0];
    rows.push({ id: `missed_date:${todayStr}`, title: `${todayStr} (Today)` });
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().split('T')[0];
      rows.push({ id: `missed_date:${date}`, title: date });
    }
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Pick missed session date' },
        body: { text: 'Choose a date and then type reason' },
        action: { button: 'Choose date', sections: [{ title: 'Last 7 days', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending missed date picker:', e.response?.data || e.message);
  }
}

async function sendAttendedDatePicker(to) {
  try {
    const today = new Date();
    const rows = [];
    const todayStr = new Date(today).toISOString().split('T')[0];
    rows.push({ id: `attended_date:${todayStr}`, title: `${todayStr} (Today)` });
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().split('T')[0];
      rows.push({ id: `attended_date:${date}`, title: date });
    }
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Pick session date' },
        body: { text: 'Choose the date you attended' },
        action: { button: 'Choose date', sections: [{ title: 'Last 7 days', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending attended date picker:', e.response?.data || e.message);
  }
}

async function sendAttendedCountPicker(to, date) {
  try {
    const rows = [1, 2, 3, 4, 5].map(n => ({ id: `attended_count:${n}`, title: `${n} session${n > 1 ? 's' : ''}` }));
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'How many sessions?' },
        body: { text: `Date: ${date}` },
        action: { button: 'Choose count', sections: [{ title: 'Sessions', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending attended count picker:', e.response?.data || e.message);
  }
}

async function sendBackfillDatePicker(to, type) {
  try {
    const today = new Date();
    const rows = [];
    for (let i = 0; i <= 20; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().split('T')[0];
      rows.push({ id: `backfill_date:${type}:${date}`, title: i === 0 ? `${date} (Today)` : date });
    }
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: type === 'attended' ? 'Backfill Attended' : 'Backfill Missed' },
        body: { text: 'Pick a date' },
        action: { button: 'Choose date', sections: [{ title: 'Last 21 days', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending backfill date picker:', e.response?.data || e.message);
  }
}

async function sendBackfillCountPicker(to, type, date) {
  try {
    const rows = [1, 2, 3, 4, 5].map(n => ({ id: `backfill_count:${n}`, title: `${n} session${n > 1 ? 's' : ''}` }));
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: type === 'attended' ? 'How many attended?' : 'How many missed?' },
        body: { text: `Date: ${date}` },
        action: { button: 'Choose count', sections: [{ title: 'Sessions', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending backfill count picker:', e.response?.data || e.message);
  }
}

async function sendBackfillReasonPicker(to) {
  try {
    const rows = [
      { id: 'backfill_reason:sick', title: 'Sick' },
      { id: 'backfill_reason:travel', title: 'Travel' },
      { id: 'backfill_reason:therapist', title: 'Therapist unavailable' },
      { id: 'backfill_reason:other', title: 'Other' }
    ];
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Reason for missed' },
        body: { text: 'Pick a reason' },
        action: { button: 'Choose reason', sections: [{ title: 'Reasons', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending backfill reason picker:', e.response?.data || e.message);
  }
}

async function sendSetupPresets(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Setup Presets' },
        body: { text: 'Pick a preset or choose Other to type your own.' },
        action: {
          button: 'Choose preset',
          sections: [
            {
              title: 'Common Plans',
              rows: [
                { id: '16 800 0', title: '16 sessions • ₹800 • 0 CF' },
                { id: '12 1000 0', title: '12 sessions • ₹1000 • 0 CF' },
                { id: '8 800 0', title: '8 sessions • ₹800 • 0 CF' }
              ]
            },
            {
              title: 'Custom',
              rows: [
                { id: 'setup_other', title: 'Other (I will type it)' }
              ]
            }
          ]
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending setup presets:', error.response?.data || error.message);
  }
}

async function sendSetupMode(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Choose how to set up' },
        action: { buttons: [
          { type: 'reply', reply: { id: 'setup_fresh', title: 'Start Fresh' } },
          { type: 'reply', reply: { id: 'setup_mid', title: 'Start Mid‑Month' } }
        ] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending setup mode:', e.response?.data || e.message);
  }
}

async function bulkBackfillAttended(userPhone, used, month) {
  try {
    const year = parseInt(month.split('-')[0], 10);
    const mon = parseInt(month.split('-')[1], 10);
    const today = new Date();
    const first = new Date(Date.UTC(year, mon - 1, 1));
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const maxDays = Math.max(0, Math.min(used, Math.max(0, Math.floor((yesterday - first) / 86400000) + 1)));
    if (maxDays <= 0) return;
    const childId = await getOrCreateDefaultChild(userPhone);
    const rows = [];
    for (let i = 0; i < maxDays; i++) {
      const d = new Date(first); d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0,10);
      rows.push({ user_phone: userPhone, child_id: childId, logged_by: userPhone, sessions_done: 1, date, status: 'attended', month });
    }
    await supabase.from('sessions').insert(rows);
  } catch (e) {
    console.error('bulkBackfillAttended error:', e.message);
  }
}

async function sendYesNo(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: { buttons: [
          { type: 'reply', reply: { id: 'confirm_yes', title: 'Yes' } },
          { type: 'reply', reply: { id: 'confirm_no', title: 'No' } }
        ] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending yes/no:', e.response?.data || e.message);
  }
}

async function confirmAttended(userPhone) {
  const today = new Date().toISOString().split('T')[0];
  const currentMonth = new Date().toISOString().slice(0, 7);
  const { data: u } = await supabase.from('users').select('waiting_for').eq('phone', userPhone).single();
  let count = 1;
  if (u?.waiting_for && typeof u.waiting_for === 'string') {
    const m = u.waiting_for.match(/state:AWAITING_CONFIRMATION:(\d+)/);
    if (m) count = Math.max(1, parseInt(m[1], 10));
  }
  const childId = await getOrCreateDefaultChild(userPhone);
  const { data: config } = await supabase
    .from('monthly_config')
    .select('*')
    .eq(childId ? 'child_id' : 'user_phone', childId ? childId : userPhone)
    .eq('month', currentMonth)
    .single();
  if (!config) {
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    await sendMessage(userPhone, `No config set. Type 'setup' first.`);
    return;
  }
  const key = childId ? 'child_id' : 'user_phone';
  const val = childId ? childId : userPhone;
  const { data: todays } = await supabase
    .from('sessions')
    .select('status')
    .eq(key, val)
    .eq('date', today);
  const hasAtt = Array.isArray(todays) && todays.some(r => r.status === 'attended');
  const hasMiss = Array.isArray(todays) && todays.some(r => r.status === 'cancelled');
  if (hasMiss) {
    await supabase.from('users').update({ waiting_for: `repl_can_attend:${today}:${count}` }).eq('phone', userPhone);
    await sendYesNo(userPhone, 'Marked missed today. Replace with Attended?');
    return;
  }
  if (hasAtt) {
    await supabase.from('users').update({ waiting_for: `dup_attend:${today}:${count}` }).eq('phone', userPhone);
    await sendYesNo(userPhone, 'Already logged today. Add again?');
    return;
  }
  await insertSessionsWithFallback({ userPhone, childId, date: today, count, status: 'attended', month: currentMonth });
  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .eq(childId ? 'child_id' : 'user_phone', childId ? childId : userPhone)
    .eq('month', currentMonth);
  const list = Array.isArray(sessions) ? sessions : [];
  const attended = list.filter(s => s.status === 'attended').length;
  const totalSessions = (config.paid_sessions || 0) + (config.carry_forward || 0);
  const remaining = totalSessions - attended;
  await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
  await sendMessage(userPhone, `✅ Session logged\n🎯 ${remaining} left this month`);
  await sendQuickMenu(userPhone);
}

 

async function getOrCreateDefaultChild(userPhone) {
  try {
    const { data: link } = await supabase
      .from('child_members')
      .select('child_id')
      .eq('member_phone', userPhone)
      .limit(1);
    if (Array.isArray(link) && link[0]?.child_id) return link[0].child_id;
    const { data: childIns, error: childErr } = await supabase
      .from('children')
      .insert([{ name: 'Default', created_by: userPhone }])
      .select('id');
    if (childErr) return null;
    const id = Array.isArray(childIns) ? childIns[0]?.id : null;
    if (id) await supabase.from('child_members').insert([{ child_id: id, member_phone: userPhone, role: 'owner' }]);
    return id || null;
  } catch (_) { return null; }
}

async function insertSessionsWithFallback({ userPhone, childId, date, count, status, month, reason }) {
  const rows = Array.from({ length: count }, () => ({
    user_phone: userPhone,
    date,
    status,
    month,
    child_id: childId,
    logged_by: userPhone,
    sessions_done: 1,
    ...(reason ? { reason } : {})
  }));
  const { error } = await supabase.from('sessions').insert(rows);
  if (error) {
    const minimal = rows.map(r => ({ user_phone: r.user_phone, date: r.date, status: r.status, month: r.month, ...(reason ? { reason } : {}) }));
    await supabase.from('sessions').insert(minimal);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Therapy Tracker Bot is running! 🏥');
});

app.get('/privacy', (req, res) => {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy · Therapy Tracker Bot</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:40px;max-width:860px}h1{font-size:28px;margin-bottom:8px}h2{font-size:20px;margin-top:28px}code,pre{background:#f6f8fa;padding:2px 6px;border-radius:4px}</style></head><body><h1>Privacy Policy</h1><p>Therapy Tracker Bot helps users log therapy sessions and receive summaries via WhatsApp.</p><h2>Data We Process</h2><ul><li>WhatsApp phone number</li><li>Message content used for commands (e.g., attended, missed, summary, setup)</li><li>Session records: date, status, optional cancellation reason</li><li>Monthly configuration: paid sessions, cost, carry forward</li></ul><h2>Purpose</h2><p>We use the data to log sessions, generate summaries, and provide the service requested by the user.</p><h2>Storage & Retention</h2><p>Data is stored in Supabase in the region selected on project creation and retained until the user requests deletion or the account is deactivated.</p><h2>Sharing</h2><p>Data is not sold. It is shared only with our processors necessary to deliver the service (e.g., WhatsApp Cloud API by Meta and Supabase as our database provider).</p><h2>Security</h2><p>Access tokens and API keys are kept in server environment variables. Transport uses HTTPS.</p><h2>Your Rights</h2><p>Users can request access, correction, or deletion of their data by contacting us.</p><h2>Contact</h2><p>Email: privacy@therapy-tracker.example</p><h2>Updates</h2><p>We may update this policy. Changes will be posted on this page with the updated date.</p><p>Last updated: ${new Date().toISOString().slice(0,10)}</p></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
});

app.get('/health/db', async (req, res) => {
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/internal/reminders', async (req, res) => {
  try {
    const token = req.headers['x-reminder-token'];
    if (!token || token !== process.env.REMINDER_TOKEN) return res.sendStatus(401);
    const { runOnce } = require('./reminder');
    await runOnce();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

function parseIntent(text) {
  const t = (text || '').toLowerCase();
  if (/(\bsummary\b|\breport\b|\bstatus\b)/.test(t)) return { intent: 'SUMMARY' };
  if (/(\bmissed\b|\bcancelled\b|\bnot\s+attended\b|\bno\s*show\b)/.test(t)) return { intent: 'MISSED' };
  if (/(\battended\b|\bdone\b|\bcompleted\b|\d+\s*(sessions?|done))/i.test(t)) {
    const m = t.match(/(\d+)\s*(?:sessions?|done|attended|completed)?/);
    const c = m ? parseInt(m[1], 10) : undefined;
    return { intent: 'ATTENDED', count: c };
  }
  return { intent: null };
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
