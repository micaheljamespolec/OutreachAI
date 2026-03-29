const FULLENRICH_KEY = Deno.env.get('FULLENRICH_API_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors() })
  }

  try {
    // Auth is enforced by Supabase's verify_jwt flag at the gateway level

    // ── Parse body ────────────────────────────────────────────────────────────
    const { firstName, lastName, linkedinUrl, company } = await req.json()
    if (!firstName && !lastName && !linkedinUrl) return error('Missing name or LinkedIn URL', 400)
    console.log('Received:', { firstName, lastName, company, linkedinUrl })

    // ── Build FullEnrich request — only include non-empty fields ───────────────
    const contactData: Record<string, any> = { enrich_fields: ['contact.emails'] }
    if (firstName) contactData.first_name = firstName
    if (lastName) contactData.last_name = lastName
    if (linkedinUrl) contactData.linkedin_url = linkedinUrl
    if (company) contactData.company_name = company

    const enrichRes = await fetch('https://app.fullenrich.com/api/v2/contact/enrich/bulk', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${FULLENRICH_KEY}`,
      },
      body: JSON.stringify({
        name: `${firstName || ''} ${lastName || ''}`.trim() || 'lookup',
        datas: [contactData],
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

      const pollRes = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
        headers: { 'Authorization': `Bearer ${FULLENRICH_KEY}` },
      })

      if (!pollRes.ok) continue

      const pollData = await pollRes.json()
      console.log('Full poll response:', JSON.stringify(pollData))
      if (pollData?.status !== 'FINISHED') continue

      const firstResult = pollData?.data?.[0]
      email = firstResult?.contact_info?.most_probable_work_email?.email ?? firstResult?.contact_info?.work_emails?.[0]?.email ?? ''
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
