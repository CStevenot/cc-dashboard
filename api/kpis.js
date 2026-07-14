// Vercel serverless function — reads real calls from Retell and returns KPIs.
// Env vars (set in Vercel): RETELL_API_KEY (required), optionally AGENT_IDS (comma-separated to filter).
// A per-request ?agent=<id> also scopes the data (used by the customer login).
export default async function handler(req, res) {
  const key = process.env.RETELL_API_KEY;
  if (!key) return res.status(500).json({ error: "RETELL_API_KEY not set" });

  const agentFilter = (process.env.AGENT_IDS || (req.query.agent || ""))
    .split(",").map(s => s.trim()).filter(Boolean);

  try {
    // Retell list-calls (POST). v2 still works; v3 returns { items: [...] }.
    const r = await fetch("https://api.retellai.com/v2/list-calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 500, sort_order: "descending" })
    });
    if (!r.ok) return res.status(502).json({ error: "Retell API error", status: r.status });
    let calls = await r.json();
    if (!Array.isArray(calls)) calls = calls.items || calls.calls || [];

    if (agentFilter.length) calls = calls.filter(c => agentFilter.includes(c.agent_id));

    const durSec = c => {
      if (c.duration_ms) return c.duration_ms / 1000;
      if (c.start_timestamp && c.end_timestamp) return (c.end_timestamp - c.start_timestamp) / 1000;
      return (c.call_cost && c.call_cost.total_duration_seconds) || 0;
    };
    const cad = c => (c.call_analysis && c.call_analysis.custom_analysis_data) || {};
    // Caller name / callback / email can arrive under several field-name conventions across agents.
    const nameOf = d => (d.caller_name || d.business_name ||
      [d.first_name, d.last_name].filter(Boolean).join(" ").trim() || "");
    const callbackOf = d => (d.best_callback_number || d.callback_number || "");
    const emailOf = d => (d.email || d.caller_email || d.customer_email || d.contact_email || "");

    let totalSec = 0, leads = 0, appts = 0;
    const recent = [];
    for (const c of calls) {
      const s = durSec(c); totalSec += s;
      const d = cad(c);
      const outcome = (d.call_outcome || "").toLowerCase();
      const name = nameOf(d);
      const callback = callbackOf(d);
      const phone = callback || c.from_number || "";
      const email = emailOf(d);
      const isLead = !!name || !!callback || outcome.includes("lead");
      const isAppt = outcome.includes("book") || outcome.includes("appointment") || outcome.includes("appt") || d.booked === true;
      if (isLead) leads++;
      if (isAppt) appts++;
      if (recent.length < 100) recent.push({
        ts: c.start_timestamp || 0,
        time: c.start_timestamp ? new Date(c.start_timestamp).toLocaleString() : "",
        caller: name || phone || "Unknown",
        name, phone, email,
        secs: Math.round(s),
        outcome: isAppt ? "Booked" : isLead ? "Lead captured" : (s <= 8 ? "No info given" : "Handled")
      });
    }
    const answeredCalls = calls.filter(c => durSec(c) > 8).length;
    res.setHeader("Cache-Control", "s-maxage=60");
    res.status(200).json({
      calls: answeredCalls,
      minutesUsed: Math.round(totalSec / 60),
      leads, appointments: appts,
      avgSec: answeredCalls ? Math.round(totalSec / answeredCalls) : 0,
      recent
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
