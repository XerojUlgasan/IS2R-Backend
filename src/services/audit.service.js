const { supabase } = require("../lib/supabaseClient");
const { assertOwner } = require("./membership.service");

const AUDIT_COLUMNS = "id, action, description, actorId, created_at";

// Fire-and-forget audit write. Callers must NOT await this so it never adds to
// the request's response time; failures are logged but never surface to the user.
function recordLog(businessId, actorId, action, description) {
  supabase
    .from("audit_logs")
    .insert({ businessId, actorId, action, description })
    .then(({ error }) => {
      if (error) {
        console.error(`[audit] failed to record ${action}:`, error.message);
      }
    });
}

// Shapes an audit log row for the API, resolving the actor's display name.
function buildAuditLogResponse(log, user) {
  return {
    id: log.id,
    action: log.action,
    description: log.description,
    actor_name: user && user.fullname ? user.fullname : null,
    created_at: log.created_at,
  };
}

// Returns the ISO timestamp for midnight UTC of the day after the given YYYY-MM-DD.
function startOfNextDay(dateStr) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

// Builds a Map of userId -> { fullname } for the given actor ids.
async function getUsersByIds(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from("users")
    .select("userId, fullname")
    .in("userId", ids);

  if (error) {
    throw new Error(error.message);
  }
  return new Map((data || []).map((u) => [u.userId, u]));
}

// Lists a business's audit logs, newest first, paginated and optionally filtered.
// Owner only.
async function listAuditLogs(userId, businessId, filters) {
  await assertOwner(userId, businessId);

  const { page, limit, action, dateFrom, dateTo, search } = filters;
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from("audit_logs")
    .select(AUDIT_COLUMNS, { count: "exact" })
    .eq("businessId", businessId);

  if (action) query = query.eq("action", action);
  if (dateFrom) query = query.gte("created_at", `${dateFrom}T00:00:00.000Z`);
  if (dateTo) query = query.lt("created_at", startOfNextDay(dateTo));
  if (search) query = query.ilike("description", `%${search}%`);

  query = query.order("created_at", { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const logs = data || [];
  const users = await getUsersByIds(logs.map((l) => l.actorId));
  const total = count || 0;

  return {
    logs: logs.map((l) => buildAuditLogResponse(l, users.get(l.actorId))),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

module.exports = { listAuditLogs, recordLog };
