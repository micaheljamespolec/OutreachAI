import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const FULLENRICH_URL = 'https://app.fullenrich.com/api/v1'
const FULLENRICH_KEY = Deno.env.get('FULLENRICH_API_KEY') ?? ''
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors() })
  }

  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return error('Missing auth token', 401)

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    )
    if (authErr || !user) return error('Unauthorized', 401)

    // ── Credits check ─────────────────────────────────────────────────────────
    const { data: credits } = await supabase
      .from('credits')
      .select('lookups_used, tier')
      .eq('user_id', user.id)
      .single()

    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max  = tier === 'pro' ? 200 : tier === 'sourcer' ? 50 : 10
    if (used >= max) return error('No lookups remaining', 402)

    // ── Parse body ────────────────────────────────────────────────────────────
    const { firstName, lastName, linkedinUrl, company } = await req.json()
    if (!firstName && !lastName) return error('Missing name fields', 400)

    // ── FullEnrich bulk enrich ────────────────────────────────────────────────
    const enrichRes = await fetch(`${FULLENRICH_URL}/contact/enrich/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${FULLENRICH_KEY}`,
      },
      body: JSON.stringify({
        name: `${firstName} ${lastName}`.trim(),
        datas: [{
          firstname:      firstName,
          lastname:       lastName,
          linkedin_url:   linkedinUrl,
          company_name:   company,
          enrich_fields:  ['contact.emails'],
        }],
      }),
    })

    if (!enrichRes.ok) {
      const text = await enrichRes.text()
      return error(`FullEnrich enrich failed: ${enrichRes.status} ${text}`, 502)
    }

    const enrichData = await enrichRes.json()
    const enrichmentId = enrichData?.id ?? enrichData?.enrichment_id

    if (!enrichmentId) return error('No enrichment ID returned', 502)

    // ── Poll for result ───────────────────────────────────────────────────────
    let email = ''
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2000))

      const pollRes = await fetch(`${FULLENRICH_URL}/bulk/${enrichmentId}`, {
        headers: { 'Authorization': `Bearer ${FULLENRICH_KEY}` },
      })

      if (!pollRes.ok) continue

      const pollData = await pollRes.json()
      if (pollData?.status !== 'finished') continue

      const contact = pollData?.results?.[0]
      const emails  = contact?.contact?.emails ?? contact?.emails ?? []
      if (emails.length > 0) {
        email = emails[0]?.email ?? emails[0] ?? ''
      }
      break
    }

    const found = !!email

    // ── Deduct credit only if found ───────────────────────────────────────────
    if (found) {
      await supabase
        .from('credits')
        .update({ lookups_used: used + 1 })
        .eq('user_id', user.id)
    }

    return new Response(
      JSON.stringify({ email, source: 'FullEnrich', found }),
      { headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return error(e.message, 500)
  }
})

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function error(msg: string, status: number) {
  return new Response(
    JSON.stringify({ error: msg }),
    { status, headers: { ...cors(), 'Content-Type': 'application/json' } }
  )
}
