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
        const messageBody = (message.text?.body || '').toLowerCase().trim();
        
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
        `Quick commands:\n\n` +
        `• 'attended' - log today's session\n` +
        `• 'missed' - log cancelled session\n` +
        `• 'summary' - monthly report\n` +
        `• 'setup' - configure tracking`
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
        `👋 Welcome to Therapy Tracker!\n\n` +
        `Let's set up your tracking. Type 'setup' to begin.`
      );
      return;
    }

    // Check if waiting for response
    if (user.waiting_for) {
      await handleWaitingResponse(userPhone, message, user);
      return;
    }

    // Handle commands
    if (message.includes('attended') || message === 'done' || message === 'ok' || message === '✓') {
      await handleAttended(userPhone, user);
    } else if (message.includes('missed') || message.includes('cancelled')) {
      await handleMissed(userPhone);
    } else if (message.includes('summary') || message.includes('report')) {
      await handleSummary(userPhone, user);
    } else if (message.includes('setup')) {
      await handleSetup(userPhone);
    } else if (message.includes('holiday') || message.includes('leave')) {
      await handleHoliday(userPhone, message);
    } else {
      await sendMessage(userPhone,
        `Quick commands:\n\n` +
        `• 'attended' - log today's session\n` +
        `• 'missed' - log cancelled session\n` +
        `• 'summary' - monthly report\n` +
        `• 'setup' - configure tracking`
      );
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await sendMessage(userPhone, 'Sorry, something went wrong. Please try again.');
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
  const remaining = config.paid_sessions - attended;

  await sendMessage(userPhone,
    `✅ Session logged for ${today}!\n\n` +
    `Today: ${todayCount} session(s)\n` +
    `This month: ${attended} sessions\n` +
    `Remaining: ${remaining} sessions`
  );
}

// Handle missed session
async function handleMissed(userPhone) {
  // Set waiting state
  const { error: missErr } = await supabase
    .from('users')
    .update({ waiting_for: 'cancellation_reason' })
    .eq('phone', userPhone);
  if (missErr) {
    console.error('Supabase users update error:', missErr.message);
  }

  await sendMessage(userPhone, 'Why was the session cancelled?');
}

// Handle waiting responses
async function handleWaitingResponse(userPhone, message, user) {
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
      `✓ Cancelled session recorded for ${today}\n` +
      `Reason: ${message}`
    );
    return;
  }

  if (user.waiting_for === 'setup_config') {
    const parts = message.split(/\s+/).map(v => v.trim()).filter(Boolean);
    if (parts.length < 3 || parts.some(p => isNaN(parseInt(p, 10)))) {
      await sendMessage(userPhone,
        `Please reply with: [sessions] [cost] [carry_forward]\nExample: 16 800 0`
      );
      return;
    }

    const paid_sessions = parseInt(parts[0], 10);
    const cost_per_session = parseInt(parts[1], 10);
    const carry_forward = parseInt(parts[2], 10);
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

    await sendMessage(userPhone, `✅ Setup complete for ${month}. You can now type 'attended'.`);
    return;
  }
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
    await sendMessage(userPhone, 'No data for this month. Type "setup" to configure.');
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
  const remaining = config.paid_sessions - attended;
  const amountUsed = attended * config.cost_per_session;
  const amountWasted = cancelled * config.cost_per_session;

  const monthName = new Date(currentMonth + '-01').toLocaleDateString('en-US', { 
    month: 'long', 
    year: 'numeric' 
  });

  const summary = 
    `📊 *${monthName.toUpperCase()} SUMMARY*\n\n` +
    `💰 *PAYMENT*\n` +
    `• Paid: ${config.paid_sessions} sessions\n` +
    `• Cost: ₹${config.cost_per_session}/session\n` +
    `• Total: ₹${config.paid_sessions * config.cost_per_session}\n\n` +
    `📈 *ATTENDANCE*\n` +
    `• Attended: ${attended} (₹${amountUsed})\n` +
    `• Cancelled: ${cancelled} (₹${amountWasted})\n\n` +
    `✨ *SUMMARY*\n` +
    `• Remaining: ${remaining} sessions\n` +
    `• Carry forward: ${remaining} sessions`;

  await sendMessage(userPhone, summary);
}

// Handle setup
async function handleSetup(userPhone) {
  await sendMessage(userPhone,
    `Let's set up your monthly tracking!\n\n` +
    `Please reply with:\n` +
    `[sessions] [cost] [carry_forward]\n\n` +
    `Example: 16 800 0\n` +
    `(16 sessions, ₹800 each, 0 carry forward)`
  );

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

  await sendMessage(userPhone, `✓ Marked ${days} day(s) as planned absence`);
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
