// Vercel serverless function — reads real calls from Retell and returns KPIs.
// Env vars (set in Vercel): RETELL_API_KEY (required), optionally AGENT_IDS (comma-separated to filter).
export default async function handler(req, res) {
  const key = process.env.RETELL_API_KEY;
  if (!key) return res.status(500).json({ error: "RETELL_API_KEY not set" });

  const agentFilter = (process.env.AGENT_IDS || (req.query.agent || ""))
    .split(",").map(s => s.trim()).filter(Boolean);

  try {
    // Retell v2 list-calls (POST). Pull recent calls.
    const r = await fetch("https://api.retellai.com/v2/list-calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 500, sort_order: "descending" })
    });
    if (!r.ok) return res.status(502).json({ error: "Retell API error", status: r.status });
    let calls = await r.json();
    if (!Array.isArray(calls)) calls = calls.calls || [];

    if (agentFilter.length) calls = calls.filter(c => agentFilter.includes(c.agent_id));

    const durSec = c => {
      if (c.duration_ms) return c.duration_ms / 1000;
      if (c.start_timestamp && c.end_timestamp) return (c.end_timestamp - c.start_timestamp) / 1000;
      return (c.call_cost && c.call_cost.total_duration_seconds) || 0;
    };
    const cad = c => (c.call_analysis && c.call_analysis.custom_analysis_data) || {};

    let totalSec = 0, leads = 0, appts = 0, answered = 0;
    const recent = [];
    for (const c of calls) {
      const s = durSec(c); totalSec += s;
      const d = cad(c);
      const outcome = (d.call_outcome || "").toLowerCase();
      const name = d.caller_name || d.business_name || "";
      const isLead = !!name || !!d.best_callback_number || outcome.includes("lead");
      const isAppt = outcome.includes("book") || outcome.includes("appointment") || outcome.includes("appt");
      if (s > 8) answered++;                 // real, connected calls
      if (isLead) leads++;
      if (isAppt) appts++;
      if (recent.length < 12) recent.push({
        time: c.start_timestamp ? new Date(c.start_timestamp).toLocaleString() : "",
        caller: name || (d.best_callback_number || "Unknown"),
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
