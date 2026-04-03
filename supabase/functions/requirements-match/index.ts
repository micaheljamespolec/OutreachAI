import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { profile, job } = await req.json()

    const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'AI not configured' }), {
        status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const profileEvidence = [
      profile.fullName ? `Name: ${profile.fullName}` : null,
      profile.title ? `Current title: ${profile.title}` : null,
      profile.company ? `Current company: ${profile.company}` : null,
      profile.headline ? `LinkedIn headline: ${profile.headline}` : null,
      profile.about ? `About/Summary: ${profile.about.slice(0, 600)}` : null,
      profile.skills?.length ? `Visible skills: ${profile.skills.slice(0, 15).join(', ')}` : null,
      profile.experience?.length ? `Experience:\n${profile.experience.map((e: any) =>
        `  - ${e.title} at ${e.company}${e.current ? ' (current)' : ''} ${e.dates || ''}`
      ).join('\n')}` : null,
    ].filter(Boolean).join('\n')

    const jobContext = [
      job.title ? `Role: ${job.title}` : null,
      job.company ? `Company: ${job.company}` : null,
      job.description ? `Role highlights / requirements:\n${job.description}` : null,
    ].filter(Boolean).join('\n')

    const prompt = `You are a recruiter's assistant helping evaluate candidate fit. Analyze the candidate profile evidence against the job requirements and return a structured JSON assessment.

CANDIDATE PROFILE:
${profileEvidence}

JOB REQUIREMENTS:
${jobContext}

Return ONLY valid JSON in this exact format:
{
  "strong": [
    { "point": "Brief recruiter-language description of the match", "evidence": "Specific evidence from profile" }
  ],
  "possible": [
    { "point": "Brief description", "evidence": "Evidence or reasoning" }
  ],
  "unclear": [
    { "point": "What is missing or unclear", "evidence": "Why it cannot be confirmed" }
  ],
  "summary": "One sentence recruiter take on overall fit"
}

Rules:
- Use 'unclear' (not 'missing') when the profile simply lacks evidence for a requirement.
- Write in recruiter language, not HR jargon. Be direct and specific.
- Keep each point under 15 words.
- Return 2–5 items per section. Return empty arrays [] if nothing fits.
- Do not invent requirements not mentioned in the job context.
- Do not include a percentage score.`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Anthropic error: ${response.status} ${errText}`)
    }

    const data = await response.json()
    const raw = data.content?.[0]?.text?.trim() || '{}'
    const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    const result = JSON.parse(jsonStr)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (e) {
    console.error('requirements-match error:', e)
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
