/**
 * Self-check for src/index.js. Hits the real CRM but creates nothing — every
 * case here is rejected before insert, so it is safe to run any time.
 *
 *   CRM_ANON_KEY=<anon key> node test-lead.mjs
 *
 * `wrangler dev` cannot be used for this: it watches the assets directory ("."),
 * which contains its own .wrangler state, so it reload-loops and 503s every POST.
 */
import assert from "node:assert";
import worker from "./src/index.js";

const env = {
  CRM_SUPABASE_URL: "https://qrzfavryrkzptsitsrcz.supabase.co",
  CRM_ANON_KEY: process.env.CRM_ANON_KEY,
  ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
};
assert(env.CRM_ANON_KEY, "set CRM_ANON_KEY (see .dev.vars)");

const req = (body, init = {}) =>
  worker.fetch(new Request("https://propsense.ai/api/lead", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body), ...init,
  }), env);

const check = async (label, res, status, fragment) => {
  const text = await res.text();
  assert.equal(res.status, status, `${label}: status ${res.status} != ${status} (${text})`);
  assert(text.includes(fragment), `${label}: ${text} lacks ${fragment}`);
  console.log("ok  ", label);
};

// The RPC is the trust boundary, so these two prove the whole round trip.
await check("invalid phone", await req({ name: "x", phone: "1" }), 200, "invalid_phone");
await check("landline prefix", await req({ name: "x", phone: "1234567890" }), 200, "invalid_phone");
// Honeypot must answer 200 so a bot cannot tell it was caught.
await check("honeypot", await req({ company: "bot", phone: "9000000001" }), 200, '"success":true');
await check("bad json", await req("{oops"), 400, "bad_json");
await check("oversized", await req({ name: "x".repeat(5000), phone: "9876543210" }), 413, "too_large");
await check("GET rejected",
  await worker.fetch(new Request("https://propsense.ai/api/lead"), env), 405, "Method not allowed");
await check("missing env",
  await worker.fetch(new Request("https://propsense.ai/api/lead", { method: "POST", body: "{}" }),
    { ASSETS: env.ASSETS }), 500, "not_configured");
await check("static passthrough",
  await worker.fetch(new Request("https://propsense.ai/"), env), 200, "asset");

console.log("\nall passed — no rows created");
