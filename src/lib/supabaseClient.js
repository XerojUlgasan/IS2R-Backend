const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables"
  );
}

// Supabase client bound to the `is2r` schema so every query targets it by default.
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  db: { schema: "is2r" },
  auth: { persistSession: false },
});

module.exports = { supabase };
