/**
 * Worker entry for propsense.ai.
 *
 * The site is static; everything except POST /api/lead falls straight through
 * to the assets binding. Ported from propvison's functions/api/lead.js — the
 * only difference is that leads from here carry asset "propsense-website", so
 * the CRM's lead_source doesn't mislabel them as propvision-website.
 *
 * The lead is filed via submit_web_lead, whose insert fires the CRM's
 * on_lead_insert trigger, which fans out to Slack + the team WhatsApp group.
 * That is why there is deliberately no Slack code here.
 *
 * Env (Cloudflare > Worker > Settings > Variables, PRODUCTION only):
 *   CRM_SUPABASE_URL   https://qrzfavryrkzptsitsrcz.supabase.co
 *   CRM_ANON_KEY       public anon key — submit_web_lead is SECURITY DEFINER
 *                      and insert-only, so it grants no read access to leads.
 *
 * Rate limiting is a WAF dashboard rule, not code: a per-isolate counter does
 * not hold across Cloudflare's Workers isolates. See README.
 */

const MAX_BODY = 4096; // a lead is a few hundred bytes; anything larger is abuse

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function handleLead(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!env.CRM_SUPABASE_URL || !env.CRM_ANON_KEY) {
    console.error("lead: missing CRM_SUPABASE_URL / CRM_ANON_KEY");
    return json({ success: false, error: "not_configured" }, 500);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ success: false, error: "too_large" }, 413);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ success: false, error: "bad_json" }, 400);
  }

  // Honeypot: real users never fill a hidden field. Answer 200 so a bot cannot
  // tell it was caught and retry with the field removed.
  if (body.company) return json({ success: true });

  const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

  const res = await fetch(`${env.CRM_SUPABASE_URL}/rest/v1/rpc/submit_web_lead`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.CRM_ANON_KEY,
      Authorization: `Bearer ${env.CRM_ANON_KEY}`,
    },
    body: JSON.stringify({
      p_name: str(body.name, 120),
      p_phone: str(body.phone, 20),
      p_project: str(body.project, 80),
      p_property: str(body.property, 200),
      p_page: str(body.page, 300),
      p_utm_source: str(body.utm_source, 80),
      p_asset: "propsense-website",
    }),
  });

  if (!res.ok) {
    console.error("lead: rpc http", res.status, (await res.text()).slice(0, 300));
    return json({ success: false, error: "upstream" }, 502);
  }

  // The RPC validates the phone itself — the browser is not a trust boundary.
  const out = await res.json();
  return json(out && out.success ? { success: true } : { success: false, error: (out && out.error) || "rejected" });
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/api/lead") {
      try {
        return await handleLead(request, env);
      } catch (err) {
        console.error("lead: unhandled", err && err.message);
        return json({ success: false, error: "server_error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
