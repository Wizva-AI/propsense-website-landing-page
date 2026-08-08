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

Cloudflare dashboard → **propsense.ai** (the zone, not the Worker) →
**Security → WAF → Rate limiting rules → Create rule**:

- **Name:** `lead-intake-limit`
- **If incoming requests match:** `URI Path` `equals` `/api/lead`
- **Characteristics:** `IP with NAT support` (the default)
- **Rate:** `5` requests per `10 minutes`
- **Then:** `Block` for `1 hour`

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
