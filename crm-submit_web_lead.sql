-- submit_web_lead: derive lead_source from p_asset instead of hardcoding
-- 'propvision-website'.
--
-- propsense.ai now files leads through this same RPC, and every one of them was
-- landing in the CRM labelled propvision-website. p_asset was only being
-- concatenated into requirements, so the source was unrecoverable.
--
-- Backward compatible: no propvison page sends `asset`, so p_asset arrives NULL
-- or '' from there and still resolves to 'propvision-website'.
--
-- The RPC is callable by anon, so p_asset is untrusted input. An allowlist keeps
-- a stranger from inventing lead_source values and polluting the CRM's source
-- filter; anything unrecognised falls back to the default rather than erroring,
-- because dropping a real lead is worse than mislabelling one.

create or replace function public.submit_web_lead(
  p_name text, p_phone text, p_project text default null::text,
  p_property text default null::text, p_page text default null::text,
  p_utm_source text default null::text, p_asset text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_digits  text;
  v_mobile  text;
  v_project text;
  v_source  text;
  v_req     text;
  v_id      uuid;
  v_created boolean := false;
begin
  -- ---- trust boundary: anon can call this, so validate HERE, not in the browser
  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_digits := ltrim(v_digits, '0');
  -- strip a country code only when exactly 10 digits remain, mirroring the client
  -- regex /^\+?91(?=\d{10}$)/. A blind ltrim of '91' would corrupt valid numbers
  -- that legitimately start with 91, e.g. 9176543210.
  if length(v_digits) = 12 and left(v_digits, 2) = '91' then
    v_digits := right(v_digits, 10);
  end if;

  if v_digits !~ '^[6-9][0-9]{9}$' then
    return jsonb_build_object('success', false, 'error', 'invalid_phone');
  end if;

  v_mobile  := '+91' || v_digits;
  v_project := coalesce(nullif(trim(p_project), ''), 'Others');

  v_source := lower(trim(coalesce(p_asset, '')));
  if v_source not in ('propsense-website', 'propvision-website') then
    v_source := 'propvision-website';
  end if;

  -- p_asset now lives in lead_source, so it no longer belongs in requirements
  v_req := nullif(concat_ws(E'\n',
             nullif(trim(coalesce(p_property, '')), ''),
             nullif(trim(coalesce(p_page,     '')), '')), '');

  insert into public.leads (
    lead_name, mobile_number, project, lead_source, utm_source, requirements, lead_month
  ) values (
    coalesce(nullif(trim(coalesce(p_name, '')), ''), 'Didn''t Capture'),
    v_mobile,
    v_project,
    v_source,
    nullif(trim(coalesce(p_utm_source, '')), ''),
    v_req,
    to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM')
  )
  on conflict (mobile_number, project) do nothing
  returning id into v_id;

  if v_id is not null then
    -- on_lead_insert already fired Slack + WhatsApp for this row.
    v_created := true;
  else
    select id into v_id
      from public.leads
     where mobile_number = v_mobile and project = v_project
     limit 1;

    if v_id is null then
      return jsonb_build_object('success', false, 'error', 'insert_failed');
    end if;

    update public.leads
       set requirements = nullif(concat_ws(E'\n---\n', requirements, v_req), ''),
           updated_at   = now()
     where id = v_id;

    perform net.http_post(
      url     := 'https://qrzfavryrkzptsitsrcz.supabase.co/functions/v1/lead-notification',
      body    := jsonb_build_object(
                   'type',   'REINQUIRY',
                   'table',  'leads',
                   'schema', 'public',
                   'record', (select row_to_json(l)::jsonb
                                from public.leads l where l.id = v_id)),
      headers := '{"Content-Type": "application/json"}'::jsonb
    );
  end if;

  return jsonb_build_object('success', true, 'lead_id', v_id, 'created', v_created);
exception when others then
  -- Never leak SQL internals to a public caller; the detail goes to the log.
  raise warning 'submit_web_lead failed: %', sqlerrm;
  return jsonb_build_object('success', false, 'error', 'server_error');
end;
$function$;
