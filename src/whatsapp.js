﻿const axios = require('axios');
const FormData = require('form-data');
const { supabase } = require('./db');
const { config } = require('./config');
const { nowPartsInTimeZone, getUserTimeZone, lastNDatesFromToday } = require('./time');

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`Message sent to ${to}`);
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
  }
}

async function sendImage(to, url) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: url }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Error sending image:', error.response?.data || error.message);
  }
}

async function sendDocument(to, buffer, filename, caption, mimeType = 'application/pdf') {
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, { contentType: mimeType, filename });
    const upload = await axios.post(
      `https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
          ...form.getHeaders()
        }
      }
    );
    const mediaId = upload?.data?.id;
    if (!mediaId) return;
    await axios.post(
      `https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: {
          id: mediaId,
          filename,
          caption
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Error sending document:', error.response?.data || error.message);
  }
}

async function sendQuickMenu(to, tenantId) {
  try {
    const tz = await getUserTimeZone(to, tenantId);
    const { today, month } = nowPartsInTimeZone(tz);
    let stats = '';
    let hasConfig = false;
    const cfgMatch = tenantId ? { tenant_id: tenantId, user_phone: to } : { user_phone: to };
    const { data: cfg } = await supabase.from('monthly_config').select('*').match(cfgMatch).eq('month', month).single();
    if (cfg) {
      hasConfig = true;
      const { data: ss } = await supabase.from('sessions').select('*').match(cfgMatch).eq('month', month);
      const lst = Array.isArray(ss) ? ss : [];
      const att = lst.filter(s => s.status === 'attended').length;
      const totalSessions = (cfg.paid_sessions || 0) + (cfg.carry_forward || 0);
      const days = lastNDatesFromToday(today, 30);
      const recentMatch = tenantId ? { tenant_id: tenantId, user_phone: to } : { user_phone: to };
      const { data: recent } = await supabase
        .from('sessions')
        .select('date,status')
        .match(recentMatch)
        .in('date', days);
      const attendedSet = new Set((recent || []).filter(r => r.status === 'attended').map(r => String(r.date).slice(0, 10)));
      let streak = 0;
      for (const d of days) {
        if (attendedSet.has(d)) streak += 1;
        else break;
      }
      const streakText = streak > 0 ? `${streak} day streak` : 'No streak yet';
      stats = `${month} | ${att}/${totalSessions} attended | ${streakText}`;
    } else {
      stats = `${month} | setup pending`;
    }
    const promptText = hasConfig ? 'What would you like to do?' : 'Setup required before logging sessions.';
    const primaryButtons = hasConfig
      ? [
          { type: 'reply', reply: { id: 'attended', title: 'Attended' } },
          { type: 'reply', reply: { id: 'missed', title: 'Missed' } },
          { type: 'reply', reply: { id: 'summary', title: 'Summary' } }
        ]
      : [
          { type: 'reply', reply: { id: 'setup', title: 'Setup' } },
          { type: 'reply', reply: { id: 'status', title: 'Status' } },
          { type: 'reply', reply: { id: 'more', title: 'More' } }
        ];
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `${stats}\n${promptText}` },
        action: {
          buttons: primaryButtons
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Quick actions' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'status', title: 'Status' } },
            { type: 'reply', reply: { id: 'weekly', title: 'Weekly' } },
            { type: 'reply', reply: { id: 'more', title: 'More' } }
          ]
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending quick menu:', error.response?.data || error.message);
  }
}

async function sendMoreMenu(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
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
              { id: 'status', title: 'Current status' },
              { id: 'weekly', title: 'Weekly insights' },
              { id: 'summary', title: 'Monthly summary' },
              { id: 'download_report', title: 'Download report PDF' },
              { id: 'undo', title: 'Undo last log' }
            ]},
            { title: 'Account', rows: [
              { id: 'setup_other', title: 'Update configuration' },
              { id: 'plan_status', title: 'Plan status' },
              { id: 'go_pro', title: 'Upgrade plan' },
              { id: 'export_data', title: 'Export my data' },
              { id: 'consent_status', title: 'Consent status' }
            ]}
          ]
        }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending more menu:', e.response?.data || e.message);
  }
}

async function sendProUpsell(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Pro unlocks report PDF and advanced insights' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'go_pro', title: 'Go Pro' } }
          ]
        }
      }
    }, {
      headers: {
        'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending pro upsell:', error.response?.data || error.message);
  }
}

async function sendTimezonePicker(to, tenantId) {
  try {
    const match = tenantId ? { tenant_id: tenantId, phone: to } : { phone: to };
    const { data: u } = await supabase.from('users').select('*').match(match).single();
    const current = (u && typeof u.timezone === 'string' && u.timezone) ? u.timezone : config.DEFAULT_TIMEZONE;
    const rows = [
      { id: 'tz:Asia/Kolkata', title: 'Asia/Kolkata' },
      { id: 'tz:Asia/Dubai', title: 'Asia/Dubai' },
      { id: 'tz:Europe/London', title: 'Europe/London' },
      { id: 'tz:America/New_York', title: 'America/New_York' },
      { id: 'tz:America/Los_Angeles', title: 'America/Los_Angeles' },
      { id: 'tz:Australia/Sydney', title: 'Australia/Sydney' },
      { id: 'tz:Etc/UTC', title: 'Etc/UTC' }
    ];
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Timezone' },
        body: { text: `Current: ${current}\nChoose your timezone` },
        action: { button: 'Choose', sections: [{ title: 'Timezones', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending timezone picker:', e.response?.data || e.message);
  }
}

async function sendRemindersPicker(to, tenantId) {
  try {
    const match = tenantId ? { tenant_id: tenantId, phone: to } : { phone: to };
    const { data: u } = await supabase.from('users').select('*').match(match).single();
    const enabled = u?.reminders_enabled !== false;
    const rows = [
      { id: 'reminders_on', title: 'ON' },
      { id: 'reminders_off', title: 'OFF' }
    ];
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Reminders' },
        body: { text: `Current: ${enabled ? 'ON' : 'OFF'}\nChoose an option` },
        action: { button: 'Choose', sections: [{ title: 'Reminders', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending reminders picker:', e.response?.data || e.message);
  }
}

async function sendReminderTimePicker(to, tenantId) {
  try {
    const match = tenantId ? { tenant_id: tenantId, phone: to } : { phone: to };
    const { data: u } = await supabase.from('users').select('*').match(match).single();
    const currentHour = Number.isInteger(u?.reminder_time_hour) ? u.reminder_time_hour : config.DEFAULT_REMINDER_HOUR;
    const sections = [
      { title: 'Morning', rows: [
        { id: 'reminder_time:8', title: '08:00' },
        { id: 'reminder_time:9', title: '09:00' },
        { id: 'reminder_time:10', title: '10:00' },
        { id: 'reminder_time:11', title: '11:00' }
      ]},
      { title: 'Afternoon', rows: [
        { id: 'reminder_time:12', title: '12:00' },
        { id: 'reminder_time:13', title: '13:00' },
        { id: 'reminder_time:14', title: '14:00' },
        { id: 'reminder_time:15', title: '15:00' }
      ]},
      { title: 'Evening', rows: [
        { id: 'reminder_time:18', title: '18:00' },
        { id: 'reminder_time:19', title: '19:00' },
        { id: 'reminder_time:20', title: '20:00' },
        { id: 'reminder_time:21', title: '21:00' }
      ]}
    ];
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Reminder time' },
        body: { text: `Current: ${String(currentHour).padStart(2, '0')}:00\nChoose a time` },
        action: { button: 'Choose', sections }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending reminder time picker:', e.response?.data || e.message);
  }
}

async function showHolidayPicker(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
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
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending holiday picker:', e.response?.data || e.message);
  }
}

async function sendMissedDatePicker(to, tenantId) {
  try {
    const tz = await getUserTimeZone(to, tenantId);
    const { today } = nowPartsInTimeZone(tz);
    const days = lastNDatesFromToday(today, 7);
    const rows = days.map((d, idx) => ({ id: `missed_date:${d}`, title: idx === 0 ? `${d} (Today)` : d }));
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Pick missed session date' },
        body: { text: 'Choose a date and then type reason' },
        action: { button: 'Choose date', sections: [{ title: 'Last 7 days', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending missed date picker:', e.response?.data || e.message);
  }
}

async function sendAttendedDatePicker(to, tenantId) {
  try {
    const tz = await getUserTimeZone(to, tenantId);
    const { today } = nowPartsInTimeZone(tz);
    const days = lastNDatesFromToday(today, 7);
    const rows = days.map((d, idx) => ({ id: `attended_date:${d}`, title: idx === 0 ? `${d} (Today)` : d }));
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Pick session date' },
        body: { text: 'Choose the date you attended' },
        action: { button: 'Choose date', sections: [{ title: 'Last 7 days', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending attended date picker:', e.response?.data || e.message);
  }
}

async function sendAttendedCountPicker(to, date) {
  try {
    const rows = [1, 2, 3, 4, 5].map(n => ({ id: `attended_count:${n}`, title: `${n} session${n > 1 ? 's' : ''}` }));
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'How many sessions?' },
        body: { text: `Date: ${date}` },
        action: { button: 'Choose count', sections: [{ title: 'Sessions', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending attended count picker:', e.response?.data || e.message);
  }
}

async function sendBackfillDatePicker(to, type, tenantId) {
  try {
    const tz = await getUserTimeZone(to, tenantId);
    const { today } = nowPartsInTimeZone(tz);
    const days = lastNDatesFromToday(today, 20);
    const rows = days.map((d, idx) => ({ id: `backfill_date:${type}:${d}`, title: idx === 0 ? `${d} (Today)` : d }));
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: type === 'attended' ? 'Backfill Attended' : 'Backfill Missed' },
        body: { text: 'Pick a date' },
        action: { button: 'Choose date', sections: [{ title: 'Last 21 days', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending backfill date picker:', e.response?.data || e.message);
  }
}

async function sendBackfillCountPicker(to, type, date) {
  try {
    const rows = [1, 2, 3, 4, 5].map(n => ({ id: `backfill_count:${n}`, title: `${n} session${n > 1 ? 's' : ''}` }));
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: type === 'attended' ? 'How many attended?' : 'How many missed?' },
        body: { text: `Date: ${date}` },
        action: { button: 'Choose count', sections: [{ title: 'Sessions', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
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
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Reason for missed' },
        body: { text: 'Pick a reason' },
        action: { button: 'Choose reason', sections: [{ title: 'Reasons', rows }] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending backfill reason picker:', e.response?.data || e.message);
  }
}

async function sendSetupPresets(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
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
                { id: '16 800 0', title: '16 sessions â€¢ â‚¹800 â€¢ 0 CF' },
                { id: '12 1000 0', title: '12 sessions â€¢ â‚¹1000 â€¢ 0 CF' },
                { id: '8 800 0', title: '8 sessions â€¢ â‚¹800 â€¢ 0 CF' }
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
        'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending setup presets:', error.response?.data || error.message);
  }
}

async function sendSetupMode(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Choose how to set up' },
        action: { buttons: [
          { type: 'reply', reply: { id: 'setup_fresh', title: 'Start Fresh' } },
          { type: 'reply', reply: { id: 'setup_mid', title: 'Start Midâ€‘Month' } }
        ] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending setup mode:', e.response?.data || e.message);
  }
}

async function sendYesNo(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
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
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending yes/no:', e.response?.data || e.message);
  }
}

async function sendVoiceNotePrompt(to) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `Send voice note about today's session? (therapist discussion)\nOr tap mood below` },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'voice_note_today', title: 'Send Voice Note' } }
          ]
        }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending voice note prompt:', e.response?.data || e.message);
  }
}

async function sendMoodPicker(to, date, count) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `How was the session?\nðŸ—“ ${date} â€¢ ${count} session${count > 1 ? 's' : ''}` },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'mood:excellent', title: 'ðŸ˜ Excellent' } },
            { type: 'reply', reply: { id: 'mood:good', title: 'ðŸ™‚ Good' } },
            { type: 'reply', reply: { id: 'mood:okay', title: 'ðŸ˜ Okay' } }
          ]
        }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    await axios.post(`https://graph.facebook.com/v18.0/${config.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'More options' },
        action: { buttons: [ { type: 'reply', reply: { id: 'mood:tough', title: 'ðŸ˜£ Tough' } } ] }
      }
    }, { headers: { 'Authorization': `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('Error sending mood picker:', e.response?.data || e.message);
  }
}

module.exports = {
  sendMessage,
  sendImage,
  sendDocument,
  sendQuickMenu,
  sendMoreMenu,
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
  sendProUpsell,
  sendVoiceNotePrompt,
  sendMoodPicker
};
