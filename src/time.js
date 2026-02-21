const { supabase } = require('./db');
const { config } = require('./config');

function nowPartsInTimeZone(timeZone) {
  const tz = timeZone || config.DEFAULT_TIMEZONE;
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return { today, month: today.slice(0, 7), timeZone: tz };
}

async function getUserTimeZone(userPhone, tenantId) {
  try {
    const match = tenantId ? { tenant_id: tenantId, phone: userPhone } : { phone: userPhone };
    const { data: u } = await supabase.from('users').select('*').match(match).single();
    return (u && typeof u.timezone === 'string' && u.timezone) ? u.timezone : config.DEFAULT_TIMEZONE;
  } catch (_) {
    return config.DEFAULT_TIMEZONE;
  }
}

function lastNDatesFromToday(todayStr, n) {
  const base = new Date(`${todayStr}T00:00:00Z`);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

module.exports = {
  nowPartsInTimeZone,
  getUserTimeZone,
  lastNDatesFromToday
};
