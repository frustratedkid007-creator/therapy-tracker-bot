const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

const supabaseKey = config.SUPABASE_SERVICE_ROLE || config.SUPABASE_KEY;
const supabase = createClient(config.SUPABASE_URL, supabaseKey);

module.exports = { supabase };
