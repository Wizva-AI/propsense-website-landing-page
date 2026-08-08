# propsense.ai

Static site (6 hand-written HTML pages, all CSS/JS inline) served by a Cloudflare
Worker. The Worker exists only for `POST /api/lead`; everything else falls
through to the assets binding.

```
npx wrangler dev      # local, reads .dev.vars
npx wrangler deploy   # production
```

## Lead flow

```
modal form submit
  ├─ POST api.web3forms.com   email safety net, gates the success UI
  └─ POST /api/lead           same origin, keepalive
        → rpc submit_web_lead()          CRM, SECURITY DEFINER, insert-only
        → INSERT public.leads
        → trigger on_lead_insert → lead-notification
             ├─ Slack
             └─ WhatsApp "Propsense New lead / Call back notification channel"
```

There is deliberately **no Slack code here** — the CRM trigger fans out by
itself. Ported from propvison, which shares the same RPC.

The two POSTs are independent on purpose: the success UI is gated on the
Web3Forms result only, so a CRM hiccup never blocks the user.

`asset: "propsense-website"` is hardcoded server-side (`src/index.js`) and is
what separates these leads from propvison's in the CRM's `lead_source` filter.

### Environment variables

Cloudflare → Workers → propsense-landing-page → Settings → Variables.
**Production only** — a preview-scoped variable would also run on every preview URL.

| Name | Value |
|---|---|
| `CRM_SUPABASE_URL` | `https://qrzfavryrkzptsitsrcz.supabase.co` |
| `CRM_ANON_KEY` | the CRM project's **public anon** key |

The anon key is public by design. `submit_web_lead` is `SECURITY DEFINER` and
insert-only, granted to `anon`, and confers **no read access** — it cannot dump
existing leads. Verified: a direct `select` on `leads` with that key returns `[]`.
That is why no `service_role` key lives on Cloudflare.

New variables only apply to **new deployments**. After changing one, redeploy or
the Worker keeps the old values and returns `not_configured`.

### Required: rate limiting on `/api/lead`

The endpoint is public and unauthenticated, and every successful insert pings
Slack *and* the team's WhatsApp group. Without a limit, anyone who finds the URL
can spam both. This cannot be done in code — a per-isolate counter does not hold
across Cloudflare's Workers isolates — so it is a dashboard rule.

**Already applied** (2026-08-08) as rule `lead-intake-limit` in the zone's
`http_ratelimit` phase — 5 requests per 10s per IP+colo, block for 10s.
Verified firing: a 12-request burst returns 429, and recovers after the timeout.

Those numbers are **not** the ones you'd choose — they are the only ones the
zone's **Free** plan permits. The API rejects anything else outright:

```
period 600            -> "not entitled to use the period 600, can only use a period among [10]"
mitigation_timeout    -> "not entitled to use a mitigation timeout different from 10"
```

5-per-10s stops a script hammering the endpoint, but a patient attacker pacing
at 4 requests per 10 seconds can still push ~34k leads/day into Slack and the
team WhatsApp group. Closing that needs a paid plan (Pro or above), which
unlocks longer periods and mitigation timeouts — then set 5 per 10 minutes,
block 1 hour:

```bash
source ~/.cloudflare/wizva.env
curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/91adbd2c0a44e6bb5ba75c9a222f5d3e/rulesets/phases/http_ratelimit/entrypoint" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"rules":[{"action":"block","description":"lead-intake-limit","expression":"(http.request.uri.path eq \"/api/lead\")","ratelimit":{"characteristics":["ip.src","cf.colo.id"],"period":600,"requests_per_period":5,"mitigation_timeout":3600}}]}'
```

Second layer, already in place: `submit_web_lead` uses
`ON CONFLICT (mobile_number, project) DO NOTHING`, so repeat submissions from one
number never create duplicate rows, and a phone must match `^[6-9][0-9]{9}$`
server-side.

### Verifying it works

```bash
# config reachable, creates nothing, pings nobody
curl -s -X POST https://propsense.ai/api/lead \
  -H 'Content-Type: application/json' -d '{"phone":"1"}'
# -> {"success":false,"error":"invalid_phone"}   (not_configured = env vars missing)

# non-POST must not fall through to a static page
curl -s -o /dev/null -w '%{http_code}\n' "https://propsense.ai/api/lead?cb=$RANDOM"
# -> 405
```

Cloudflare's edge caches aggressively, so add a cache-busting query param when
spot-checking or you may read a stale response from before the deploy.

A full end-to-end test inserts a real row and notifies the team — mark it
clearly (`TEST - ignore`) and delete it afterwards:

```sql
delete from public.leads where mobile_number = '+919000000001';
```

## Favicons

`favicon.ico` / `apple-touch-icon.png` / `icon-192.png` / `icon-512.png` are
generated from `images/Propsense_logo.png` — the source has a wide transparent
margin, so it is trimmed to its alpha bbox and re-padded square first, or the
icon renders tiny and off-centre at 16px. Regenerate with the script in the
commit that added them if the logo changes.
