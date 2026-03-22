const FULLENRICH_URL = 'https://app.fullenrich.com/api/v1'
const FULLENRICH_KEY = Deno.env.get('FULLENRICH_API_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors() })
  }

  try {
    // Auth temporarily disabled for testing - re-enable before launch

    // ── Parse body ────────────────────────────────────────────────────────────
    const { firstName, lastName, linkedinUrl, company } = await req.json()
    if (!firstName && !lastName) return error('Missing name fields', 400)
    console.log('Received:', { firstName, lastName, company, linkedinUrl })

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

    console.log('FullEnrich status:', enrichRes.status)
    if (!enrichRes.ok) {
      const text = await enrichRes.text()
      return error(`FullEnrich enrich failed: ${enrichRes.status} ${text}`, 502)
    }

    const enrichData = await enrichRes.json()
    const enrichmentId = enrichData?.id ?? enrichData?.enrichment_id
    console.log('Enrichment ID:', enrichmentId)

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
      console.log('Full poll response:', JSON.stringify(pollData))
      if (pollData?.status !== 'finished') continue

      const results = pollData?.datas || pollData?.results || pollData?.data || []
      const firstResult = Array.isArray(results) ? results[0] : results
      console.log('First result:', JSON.stringify(firstResult))
      const emailObj = firstResult?.emails?.[0] || firstResult?.contact?.emails?.[0] || firstResult?.email
      email = emailObj?.email || emailObj || ''
      console.log('Extracted email:', email)
      break
    }

    console.log('Email found:', email)
    const found = !!email

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
