const axios = require('axios')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID
const TZ = process.env.TIMEZONE || 'Asia/Kolkata'
const REMINDER_HOUR = parseInt(process.env.REMINDER_TIME_HOUR || '13', 10)

function nowParts() {
  const now = new Date()
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const hourStr = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now)
  return { today: dateStr, hour: parseInt(hourStr, 10) }
}

async function sendMessage(to, text) {
  await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  }, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }
  })
}

async function hasLogTodayByChild(childId, userPhone, today) {
  const byChild = childId ? { child_id: childId } : { user_phone: userPhone }
  const { data: s } = await supabase.from('sessions').select('id').eq('date', today).eq('status', 'attended').match(byChild).limit(1)
  if (Array.isArray(s) && s.length) return true
  const { data: c } = await supabase.from('sessions').select('id').eq('date', today).eq('status', 'cancelled').match(byChild).limit(1)
  if (Array.isArray(c) && c.length) return true
  const { data: h } = await supabase.from('holidays').select('id').eq('date', today).match(byChild).limit(1)
  if (Array.isArray(h) && h.length) return true
  return false
}

async function main() {
  const { today, hour } = nowParts()
  if (hour < REMINDER_HOUR) return

  const { data: users, error } = await supabase.from('users').select('*')
  if (error) throw new Error(error.message)

  for (const u of users || []) {
    if (u.reminders_enabled === false) continue
    if (u.last_reminder_sent && String(u.last_reminder_sent) === today) continue
    const { data: links } = await supabase.from('child_members').select('child_id').eq('member_phone', u.phone)
    let needReminder = true
    if (Array.isArray(links) && links.length) {
      for (const l of links) {
        const exists = await hasLogTodayByChild(l.child_id, u.phone, today)
        if (exists) { needReminder = false; break }
      }
    } else {
      const exists = await hasLogTodayByChild(null, u.phone, today)
      if (exists) needReminder = false
    }
    if (!needReminder) continue
    try {
      await sendMessage(u.phone, `⏰ Reminder\nNo session logged today yet.\nReply: done / missed / holiday`)
      await supabase.from('users').update({ last_reminder_sent: today }).eq('phone', u.phone)
      console.log('Reminder sent to', u.phone)
    } catch (e) {
      console.error('Reminder send failed for', u.phone, e.response?.data || e.message)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })

