const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

function validateEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_KEY', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID'];
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
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      
      if (value?.messages?.[0]) {
        const message = value.messages[0];
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
      await sendMessage(userPhone,
        `👋 *Therapy Tracker*\n\n` +
        `Here's what you can do:\n\n` +
        `✅ *attended* — log today's session\n` +
        `❌ *missed* — log a missed session\n` +
        `📊 *summary* — monthly report\n` +
        `⚙️ *setup* — configure tracking`
      );
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
        `👋 *Welcome to Therapy Tracker!*\n\n` +
        `Track your child's therapy sessions easily right here on WhatsApp.\n\n` +
        `✅ Log attended sessions\n` +
        `❌ Track missed sessions with reason\n` +
        `📊 Get monthly summaries\n` +
        `💰 Track costs & carry forward\n\n` +
        `Let's get started! Tap *Setup* below ⬇️`
      );
      await sendQuickMenu(userPhone);
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
        await sendMessage(userPhone, '👍 No problem, session not logged.');
        await sendQuickMenu(userPhone);
        return;
      }
    } else {
      const { intent, count } = parseIntent(message);
      if (intent === 'ATTENDED') {
        const suffix = count && count > 1 ? `:${count}` : '';
        await supabase.from('users').update({ waiting_for: `state:AWAITING_CONFIRMATION${suffix}` }).eq('phone', userPhone);
        const c = count && count > 1 ? `${count} sessions` : 'session';
        await sendYesNo(userPhone, `Log ${count && count > 1 ? count + ' ' : ''}${c} for today?`);
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
      await sendMessage(userPhone, `📝 *Why was the session missed?*\n\n🗓 Date: ${date}\n\nPlease type a brief reason:\n_e.g. "child was sick", "therapist unavailable"_`);
    } else if (message === 'holiday_today') {
      await markHolidayRange(userPhone, 1);
    } else if (message === 'holiday_next3') {
      await markHolidayRange(userPhone, 3);
    } else if (message === 'holiday_next7') {
      await markHolidayRange(userPhone, 7);
    } else if (message === 'holiday_range') {
      await supabase.from('users').update({ waiting_for: 'holiday_range' }).eq('phone', userPhone);
      await sendMessage(userPhone, `📅 *Mark Holiday Range*\n\nType the date range in this format:\n*YYYY-MM-DD..YYYY-MM-DD*\n\nExample: \`2026-02-20..2026-02-25\``);
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
      await sendMessage(userPhone, `🧮 *Mid-month Setup*\n\nReply with 4 numbers:\n*[total] [cost] [carry] [used]*\n\nExample: \`16 800 2 6\`\n_(16 total • ₹800 each • 2 carried • 6 already done)_`);
    } else if (message.includes('reset') || message === 'confirm_reset' || message === 'cancel_reset') {
      await handleReset(userPhone, message);
    } else if (message.includes('attended') || message === 'done' || message === 'ok' || message === '✓') {
      await supabase.from('users').update({ waiting_for: 'state:AWAITING_CONFIRMATION' }).eq('phone', userPhone);
      await sendYesNo(userPhone, `✅ *Log today's session?*\n\nTap Yes to record an attended session for today.`);
    } else if (message.includes('missed') || message.includes('cancelled')) {
      await handleMissed(userPhone);
    } else if (message.includes('summary') || message.includes('report')) {
      await handleSummary(userPhone, user);
    } else if (message.includes('setup')) {
      await handleSetup(userPhone);
    } else if (message.includes('holiday') || message.includes('leave')) {
      await showHolidayPicker(userPhone);
    } else {
      await sendMessage(userPhone, `👇 Quick actions`);
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
      `⚙️ *Setup required!*\n\nNo plan found for this month.\nType *setup* to configure your sessions first.`
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
  if (user.waiting_for && typeof user.waiting_for === 'string' && user.waiting_for.startsWith('state:AWAITING_CONFIRMATION')) {
    const yes = message === 'yes' || message === 'y' || message === 'confirm_yes';
    const no = message === 'no' || message === 'n' || message === 'confirm_no';
    if (yes) { await confirmAttended(userPhone); return true; }
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
    const childId = await getOrCreateDefaultChild(userPhone);
    const { error: insErr } = await supabase.from('sessions').insert({
      user_phone: userPhone,
      child_id: childId,
      logged_by: userPhone,
      sessions_done: 1,
      date,
      status: 'cancelled',
      reason: message,
      month
    });
    if (insErr) {
      console.error('Supabase sessions insert cancel error:', insErr.message);
    }
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
    await sendMessage(userPhone, `❌ *Missed session recorded*\n\n🗓 Date: ${date}\n📝 Reason: ${message}`);
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
      `❌ *Missed session recorded*\n\n` +
      `🗓 Date: ${today}\n` +
      `📝 Reason: ${message}`
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
      await insertSessionsWithFallback({ userPhone, childId, date, count, status: 'attended', month });
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, `✅ *Extra session added!*\n\n🗓 Date: ${date}`);
      await sendQuickMenu(userPhone);
      return true;
    }
    if (no) {
      await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
      await sendMessage(userPhone, '👍 Got it, no extra session added.');
      await sendQuickMenu(userPhone);
      return true;
    }
    await sendYesNo(userPhone, `⚠️ *Already logged today!*\n\nWant to add another session?`);
    return true;
  }

  if (user.waiting_for === 'setup_config') {
    const parts = message.split(/\s+/).map(v => v.trim()).filter(Boolean);
    if (parts.length < 3 || parts.some(p => isNaN(parseInt(p, 10)))) {
      await sendMessage(userPhone,
        `⚠️ *Invalid format*\n\nPlease reply with:\n*[sessions] [cost] [carry_forward]*\n\nExample: \`16 800 0\`\n_(16 sessions • ₹800 each • 0 carry forward)_`
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

    await sendMessage(userPhone,
      `✅ *Setup complete for ${month}!*\n\n` +
      `📊 *Monthly Plan*\n` +
      `• Total sessions: ${total_sessions}\n` +
      `• Cost per session: ₹${cost_per_session}\n` +
      `• Carry forward: ${carry_forward}\n` +
      `• Paid this month: ${paid_sessions}\n` +
      `• *Total due: ₹${paid_sessions * cost_per_session}*\n\n` +
      `You're all set! Tap *Attended* after each session 👇`
    );
    return true;
  }

  if (user.waiting_for === 'setup_mid_config') {
    const parts = message.split(/\s+/).map(v => v.trim()).filter(Boolean);
    if (parts.length < 4 || parts.some(p => isNaN(parseInt(p, 10)))) {
      await sendMessage(userPhone, `⚠️ *Invalid format*\n\nPlease reply with 4 numbers:\n*[total] [cost] [carry] [used]*\n\nExample: \`16 800 2 6\``);
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
    await sendMessage(userPhone,
      `✅ *Mid-month setup complete!*\n\n` +
      `🧮 Total: ${total_sessions}\n` +
      `✅ Already done: ${used}\n` +
      `🎯 Remaining: ${remaining}\n\n` +
      `Tap *Attended* after each session 👇`
    );
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
    await sendMessage(userPhone, `⚙️ *No data yet!*\n\nType *setup* to configure your monthly tracking first.`);
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
  const amountUsed = Math.min(attended, config.paid_sessions) * config.cost_per_session;
  const amountWasted = Math.min(Math.max(cancelled, 0), Math.max(config.paid_sessions - Math.min(attended, config.paid_sessions), 0)) * config.cost_per_session;

  const monthName = new Date(currentMonth + '-01').toLocaleDateString('en-US', { 
    month: 'long', 
    year: 'numeric' 
  });

  const summary = 
    `📊 *${monthName} Summary*\n\n` +
    `💰 *Payment*\n` +
    `• Sessions paid: ${config.paid_sessions}\n` +
    `• Carry forward: ${config.carry_forward || 0}\n` +
    `• Rate: ₹${config.cost_per_session}/session\n` +
    `• Total due: ₹${config.paid_sessions * config.cost_per_session}\n\n` +
    `📈 *Attendance*\n` +
    `• ✅ Attended: ${attended}\n` +
    `• ❌ Missed: ${cancelled}\n` +
    `• 🎯 Remaining: ${remaining}\n\n` +
    `💸 *Cost Breakdown*\n` +
    `• Used: ₹${amountUsed}\n` +
    `• Wasted: ₹${amountWasted}\n\n` +
    `_${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}_`;

  await sendMessage(userPhone, summary);
  if (user?.waiting_for && user.waiting_for.startsWith && user.waiting_for.startsWith('state:')) {
    await supabase.from('users').update({ waiting_for: null }).eq('phone', userPhone);
  }
}

// Handle setup
async function handleSetup(userPhone) {
  await sendMessage(userPhone, `⚙️ *Monthly Setup*\n\nChoose how to set up this month:`);
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

  await sendMessage(userPhone, `🏖️ *${days} day(s) marked as holiday!*\n\nThese days won't count against your sessions.`);
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
      stats = `📅 ${month}\n✅ ${att} of ${totalSessions} sessions attended`;
    } else {
      stats = `📅 ${month}\n⚙️ Setup not done yet`;
    }
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `${stats}\n\nWhat would you like to do?` },
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

async function sendMissedDatePicker(to) {
  try {
    const today = new Date();
    const rows = [];
    const todayStr = new Date(today).toISOString().split('T')[0];
    rows.push({ id: `missed_date:${todayStr}`, title: 'Today', description: todayStr });
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const date = d.toISOString().split('T')[0];
      const label = i === 1 ? 'Yesterday' : `${i} days ago`;
      rows.push({ id: `missed_date:${date}`, title: label, description: date });
    }
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '❌ Log Missed Session' },
        body: { text: 'Which date was the session missed?\nAfter selecting, you\'ll be asked for the reason.' },
        action: { button: '📅 Choose date', sections: [{ title: 'Last 7 days', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending missed date picker:', e.response?.data || e.message);
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
          { type: 'reply', reply: { id: 'confirm_yes', title: '✅ Yes' } },
          { type: 'reply', reply: { id: 'confirm_no', title: '❌ No' } }
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
    await sendMessage(userPhone, `⚙️ *Setup required!*\n\nNo config found for this month.\nType *setup* to get started.`);
    return;
  }
  const { data: dup } = await supabase
    .from('sessions')
    .select('id')
    .eq(childId ? 'child_id' : 'user_phone', childId ? childId : userPhone)
    .eq('date', today)
    .eq('status', 'attended');
  if (Array.isArray(dup) && dup.length) {
    await supabase.from('users').update({ waiting_for: `dup_attend:${today}:${count}` }).eq('phone', userPhone);
    await sendYesNo(userPhone, `⚠️ *Already logged today!*\n\nYou've already recorded a session for today.\nWant to add another one?`);
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
  await sendMessage(userPhone, `✅ *Session logged!*\n\n🎯 *${remaining}* sessions left this month`);
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

async function insertSessionsWithFallback({ userPhone, childId, date, count, status, month }) {
  const rows = Array.from({ length: count }, () => ({
    user_phone: userPhone,
    date,
    status,
    month,
    child_id: childId,
    logged_by: userPhone,
    sessions_done: 1
  }));
  const { error } = await supabase.from('sessions').insert(rows);
  if (error) {
    const minimal = rows.map(r => ({ user_phone: r.user_phone, date: r.date, status: r.status, month: r.month }));
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

app.get('/debug/env', (req, res) => {
  const mask = (v) => (v && v.length > 6 ? v.slice(0, 3) + '***' + v.slice(-3) : !!v);
  res.json({
    supabaseUrlSet: !!process.env.SUPABASE_URL,
    supabaseServiceRoleSet: !!process.env.SUPABASE_SERVICE_ROLE,
    supabaseAnonSet: !!process.env.SUPABASE_KEY,
    phoneNumberId: mask(process.env.PHONE_NUMBER_ID || ''),
  });
});

app.post('/internal/reminders', async (req, res) => {
  try {
    const token = req.headers['x-reminder-token'] || req.query.token;
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