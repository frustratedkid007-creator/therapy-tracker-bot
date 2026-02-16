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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('phone', userPhone)
      .single();

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
  await supabase.from('users').insert({
    phone: phone,
    created_at: new Date().toISOString()
  });
}

// Handle attended session
async function handleAttended(userPhone, user) {
  const today = new Date().toISOString().split('T')[0];
  
  // Get current month config
  const currentMonth = new Date().toISOString().slice(0, 7);
  const { data: config } = await supabase
    .from('monthly_config')
    .select('*')
    .eq('user_phone', userPhone)
    .eq('month', currentMonth)
    .single();

  if (!config) {
    await sendMessage(userPhone, 
      `⚠️ Please run setup first!\n\nType 'setup' to configure your monthly sessions.`
    );
    return;
  }

  // Log session
  await supabase.from('sessions').insert({
    user_phone: userPhone,
    date: today,
    status: 'attended',
    month: currentMonth
  });

  // Get stats
  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_phone', userPhone)
    .eq('month', currentMonth);

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
  await supabase
    .from('users')
    .update({ waiting_for: 'cancellation_reason' })
    .eq('phone', userPhone);

  await sendMessage(userPhone, 'Why was the session cancelled?');
}

// Handle waiting responses
async function handleWaitingResponse(userPhone, message, user) {
  if (user.waiting_for === 'cancellation_reason') {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toISOString().slice(0, 7);

    await supabase.from('sessions').insert({
      user_phone: userPhone,
      date: today,
      status: 'cancelled',
      reason: message,
      month: currentMonth
    });

    await supabase
      .from('users')
      .update({ waiting_for: null })
      .eq('phone', userPhone);

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

    await supabase
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

    await supabase
      .from('users')
      .update({ waiting_for: null })
      .eq('phone', userPhone);

    await sendMessage(userPhone, `✅ Setup complete for ${month}. You can now type 'attended'.`);
    return;
  }
}

// Handle summary request
async function handleSummary(userPhone, user) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  
  // Get config
  const { data: config } = await supabase
    .from('monthly_config')
    .select('*')
    .eq('user_phone', userPhone)
    .eq('month', currentMonth)
    .single();

  if (!config) {
    await sendMessage(userPhone, 'No data for this month. Type "setup" to configure.');
    return;
  }

  // Get sessions
  const { data: sessions } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_phone', userPhone)
    .eq('month', currentMonth);

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

  await supabase
    .from('users')
    .update({ waiting_for: 'setup_config' })
    .eq('phone', userPhone);
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

    await supabase.from('holidays').insert({
      user_phone: userPhone,
      date: dateStr,
      month: currentMonth
    });
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
