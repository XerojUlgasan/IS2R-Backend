const { supabase } = require("../lib/supabaseClient");

// Verifies the Bearer JWT from the Authorization header using Supabase auth
// and populates req.user with the authenticated user. Rejects with 401 otherwise.
async function requireAuth(req, res, next) {
  const authHeader = req.header("authorization") || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  try {
    // Supabase validates the token's signature/expiry and returns the user.
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data || !data.user) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.user = { id: data.user.id, email: data.user.email };
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Authentication failed" });
  }
}

module.exports = { requireAuth };
