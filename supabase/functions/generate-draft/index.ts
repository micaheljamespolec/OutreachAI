const GEMINI_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() })
  try {
    const { profile, job, recruiter } = await req.json()
    const prompt = buildPrompt(profile, job, recruiter)
    console.log('Generating draft for:', profile?.firstName, profile?.lastName)

    // Check if API key is configured
    if (!GEMINI_KEY) {
      console.error('GEMINI_API_KEY is not set in Edge Function secrets')
      return error('AI service not configured. Please set GEMINI_API_KEY in Supabase Edge Function secrets.', 503)
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 512,
          },
        }),
      }
    )

    if (!res.ok) {
      const text = await res.text()
      console.error('Gemini API error:', res.status, text)
      return error(`AI generation failed (${res.status}). Check GEMINI_API_KEY.`, 502)
    }

    const data = await res.json()
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    console.log('Raw Gemini response length:', raw.length)

    let subject = '', body = raw
    try {
      const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(jsonStr)
      subject = parsed.subject ?? ''
      body    = parsed.body ?? raw
    } catch {
      // Non-JSON response — use the raw text as the body
      console.log('Response was not JSON, using raw text')
    }

    return new Response(
      JSON.stringify({ draft: body, subject }),
      { headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    console.error('generate-draft error:', e.message)
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
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function error(msg: string, status: number) {
  return new Response(
    JSON.stringify({ error: msg }),
    { status, headers: { ...cors(), 'Content-Type': 'application/json' } }
  )
}
