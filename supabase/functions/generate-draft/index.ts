const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() })
  try {
    // Auth temporarily disabled for testing - re-enable before launch
    const { profile, job, recruiter } = await req.json()

    const prompt = buildPrompt(profile, job, recruiter)
    console.log('Generating draft for:', profile?.firstName, profile?.lastName)

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      return error(`Claude API error: ${res.status} ${text}`, 502)
    }

    const data = await res.json()
    const raw = data.content?.[0]?.text ?? ''
    console.log('Raw Claude response:', raw)

    let subject = '', body = raw
    try {
      const parsed = JSON.parse(raw)
      subject = parsed.subject ?? ''
      body    = parsed.body ?? raw
    } catch { /* non-JSON fallback */ }

    return new Response(
      JSON.stringify({ draft: body, subject }),
      { headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return error(e.message, 500)
  }
})

function buildPrompt(profile: any, job: any, recruiter: any) {
  const jobText = [job?.title, job?.company, job?.description].filter(Boolean).join(' | ')
  return `You are an expert recruiter writing professional outreach emails to potential candidates.

Candidate LinkedIn Profile:
- Name: ${profile?.firstName ?? ''} ${profile?.lastName ?? ''}
- Current Title: ${profile?.title ?? 'Unknown'}
- Current Company: ${profile?.company ?? 'Unknown'}

Job Opening: ${jobText || 'Not specified'}
Recruiter: ${recruiter?.name ?? ''}, ${recruiter?.title ?? ''}

Write a concise, personalized recruiter outreach email:
1. Open with a warm, personalized reference to their current role
2. Briefly introduce the opportunity
3. Highlight 1-2 reasons why they specifically are a great fit
4. Be conversational and 150-200 words max
5. End with a soft call-to-action

Respond ONLY with valid JSON (no markdown, no backticks):
{"subject": "Email subject line", "body": "Full email body"}`
}

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
