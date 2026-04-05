import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

async function callAnthropic(key: string, model: string, maxTokens: number, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  })
  const d = await res.json()
  return d.content?.[0]?.text?.trim() || '{}'
}

function parseJson(s: string): any {
  try { return JSON.parse(s.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()) } catch { return {} }
}

// ── FullEnrich v2: LinkedIn URL → work email, personal email, name, title, company ──
async function enrichWithLinkedInV2(linkedinUrl: string, key: string): Promise<{
  full_name: string | null
  work_email: string | null
  personal_email: string | null
  title: string | null
  company: string | null
  company_domain: string | null
  raw: any
}> {
  const empty = { full_name: null, work_email: null, personal_email: null, title: null, company: null, company_domain: null, raw: null }

  // Step 1: start bulk enrichment
  const startRes = await fetch('https://app.fullenrich.com/api/v2/contact/enrich/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      name: `OutreachAI-${Date.now()}`,
      data: [{ linkedin_url: linkedinUrl, enrich_fields: ['contact.emails'] }],
    }),
  })

  const startData = await startRes.json()
  if (!startRes.ok) throw new Error(`FullEnrich start error ${startRes.status}: ${JSON.stringify(startData)}`)

  const enrichmentId = startData.enrichment_id
  if (!enrichmentId) throw new Error('FullEnrich did not return enrichment_id')

  // Step 2: poll GET endpoint until FINISHED (2s intervals, max 15 attempts = 30s)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000))

    const pollRes = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    })
    const pollData = await pollRes.json()

    if (pollData.status === 'FINISHED') {
      const contact = pollData.data?.[0]
      if (!contact) return { ...empty, raw: pollData }

      const workEmail     = contact.contact_info?.most_probable_work_email?.email || null
      const personalEmail = contact.contact_info?.most_probable_personal_email?.email || null
      const profile       = contact.profile || {}
      const current       = profile.employment?.current

      return {
        full_name:      profile.full_name || null,
        work_email:     workEmail,
        personal_email: personalEmail,
        title:          current?.title || null,
        company:        current?.company?.name || null,
        company_domain: current?.company?.domain || null,
        raw:            pollData,
      }
    }

    if (pollData.status === 'FAILED') throw new Error('FullEnrich enrichment failed')
    // PENDING or IN_PROGRESS — keep polling
  }

  throw new Error('FullEnrich timeout — enrichment did not complete within 26s')
}

// ── Employer resolution from email domain (fallback if FullEnrich has no company) ──
async function resolveEmployer(domain: string, db: any, anthropicKey: string): Promise<{ company: string; confidence: number }> {
  const { data: cached } = await db.from('company_domains').select('canonical_company_name,confidence').eq('domain', domain).single()
  if (cached) return { company: cached.canonical_company_name, confidence: cached.confidence }

  const known: Record<string, string> = {
    'google.com': 'Google', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple',
    'amazon.com': 'Amazon', 'meta.com': 'Meta', 'salesforce.com': 'Salesforce',
    'bms.com': 'Bristol Myers Squibb', 'pfizer.com': 'Pfizer', 'jnj.com': 'Johnson & Johnson',
    'ibm.com': 'IBM', 'oracle.com': 'Oracle', 'adobe.com': 'Adobe', 'stripe.com': 'Stripe',
    'openai.com': 'OpenAI', 'anthropic.com': 'Anthropic', 'goodparty.org': 'Good Party',
  }
  if (known[domain]) {
    await db.from('company_domains').upsert({ domain, canonical_company_name: known[domain], confidence: 0.99 })
    return { company: known[domain], confidence: 0.99 }
  }

  if (!anthropicKey) return { company: domain, confidence: 0.3 }

  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 100,
    `What company uses email domain "${domain}"? Reply ONLY JSON: {"company_name":"...","confidence":0.0-1.0}`)
  const p = parseJson(raw)
  const company = p.company_name || domain
  const confidence = typeof p.confidence === 'number' ? p.confidence : 0.4
  await db.from('company_domains').upsert({ domain, canonical_company_name: company, confidence })
  return { company, confidence }
}

// ── Title fallback: Claude infers from training data when FullEnrich has no title ──
async function inferTitleFallback(fullName: string, company: string, anthropicKey: string): Promise<{
  title: string | null
  confidence: number
}> {
  if (!anthropicKey) return { title: null, confidence: 0 }

  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 200, `
You are inferring a person's current job title from your training data only.
Do NOT use LinkedIn or any LinkedIn-adjacent source.
Use only: company websites, press releases, conference bios, SEC filings, Crunchbase, ZoomInfo-type public records.
If you have no reliable non-LinkedIn evidence, return title: null and confidence: 0.

Person: "${fullName}" at "${company}"

Return ONLY JSON: {"title": "job title or null", "confidence": 0.0}`)

  const p = parseJson(raw)
  const confidence = typeof p.confidence === 'number' ? Math.min(p.confidence, 0.6) : 0
  return {
    title: confidence >= 0.25 ? (p.title || null) : null,
    confidence,
  }
}

// ── Draft generation ──────────────────────────────────────────────────────────
async function generateDraft(
  fullName: string, company: string | null, title: string | null,
  titleVerified: boolean, email: string | null, userContext: string | null,
  draftConf: number, anthropicKey: string
): Promise<{ subject: string; body: string } | null> {
  if (!anthropicKey) return null

  const titleInstruction = title
    ? (titleVerified
        ? `Candidate's current role: ${title} (confirmed from data provider — reference it naturally).`
        : `Candidate's likely role: ${title} (inferred — reference it cautiously without claiming certainty).`)
    : `Candidate's role is unknown — do NOT claim any specific title. Write using name and company only.`

  const prompt = `Write a concise recruiter outreach email (60–120 words). Use ONLY the supplied information. Do not invent facts.

Candidate: ${fullName}
${company ? `Company: ${company}` : ''}
${titleInstruction}
${email ? `Email: ${email}` : 'No email — generate body only.'}
${userContext ? `Recruiter context: ${userContext}` : ''}
Confidence level: ${draftConf >= 0.65 ? 'normal — personalize where evidence exists' : 'low — be warm but generic, no specific claims'}

Rules:
- No mention of "I saw your profile", "I noticed you", or LinkedIn.
- No exclamation marks.
- No invented achievements.
- Tone: professional, modern, peer-to-peer.
- One soft CTA.

Return ONLY JSON: {"subject": "...", "body": "..."}`

  const raw = await callAnthropic(anthropicKey, 'claude-sonnet-4-5', 500, prompt)
  const p = parseJson(raw)
  if (!p.body) return null
  return { subject: p.subject || `Reaching out — ${fullName}`, body: p.body }
}

// ── Weighted confidence formula ────────────────────────────────────────────────
function computeDraftConfidence(
  personConf: number, companyConf: number, titleConf: number,
  emailStatus: string, userContextLength: number
): number {
  const emailConf   = emailStatus === 'found' ? 1 : emailStatus === 'uncertain' ? 0.5 : 0
  const contextConf = Math.min(1, userContextLength / 100)
  return Math.round((
    personConf  * 0.35 +
    companyConf * 0.20 +
    titleConf   * 0.20 +
    emailConf   * 0.15 +
    contextConf * 0.10
  ) * 100) / 100
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const supabaseUrl   = Deno.env.get('SUPABASE_URL')!
  const serviceKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey  = Deno.env.get('ANTHROPIC_API_KEY') || ''
  const fullenrichKey = Deno.env.get('FULLENRICH_API_KEY') || ''
  const db = createClient(supabaseUrl, serviceKey)

  // Auth — validate user JWT
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)
  const { data: { user }, error: authErr } = await db.auth.getUser(token)
  if (authErr || !user) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)

  try {
    const body        = await req.json()
    const linkedinUrl = body.linkedinUrl?.trim() || null
    const companyHint = body.companyHint?.trim() || null
    const userContext = body.userContext?.trim() || null
    const fullNameHint = body.fullNameHint?.trim() || null

    if (!linkedinUrl) return json({ error: { code: 'NO_LINKEDIN_URL', message: 'Open a LinkedIn profile to generate a draft.' } }, 400)

    const sources: any[] = []
    let personConfidence = 0.5

    // ── Stage 1: FullEnrich v2 — LinkedIn URL → email, name, title, company ──
    let fullName: string = fullNameHint || ''
    let work_email: string | null = null
    let personal_email: string | null = null
    let selectedEmail: string | null = null   // work_email first, personal_email fallback
    let company: string | null = companyHint || null
    let companyDomain: string | null = null
    let providerTitle: string | null = null
    let emailStatus: 'found' | 'not_found' | 'uncertain' = 'not_found'
    let emailDomain: string | null = null
    let companyConfidence = companyHint ? 0.7 : 0.3
    let titleVerified = false

    if (fullenrichKey) {
      let enrichRaw: any = null
      let enrichStatus = 0
      try {
        const enrichResult = await enrichWithLinkedInV2(linkedinUrl, fullenrichKey)
        enrichRaw    = enrichResult.raw
        enrichStatus = 200

        // Name: prefer FullEnrich result; fall back to hint
        if (enrichResult.full_name) {
          fullName = enrichResult.full_name
          personConfidence = 0.95
        }

        work_email     = enrichResult.work_email
        personal_email = enrichResult.personal_email
        selectedEmail  = work_email || personal_email || null
        emailStatus    = work_email ? 'found' : personal_email ? 'uncertain' : 'not_found'
        // Use work email domain first for company resolution — it's the definitive employer signal
        // Fall back to personal email domain only if no work email exists
        if (work_email) emailDomain = work_email.split('@')[1] || null
        else if (personal_email) emailDomain = personal_email.split('@')[1] || null

        // Company: prefer FullEnrich result, then domain, then hint
        if (enrichResult.company) {
          company = enrichResult.company
          companyDomain = enrichResult.company_domain
          companyConfidence = 0.95
        } else if (enrichResult.company_domain) {
          companyDomain = enrichResult.company_domain
        }

        // Title from FullEnrich (most reliable — their own data)
        if (enrichResult.title) {
          providerTitle = enrichResult.title
          titleVerified = true
        }

        sources.push({ type: 'fullenrich_v2', label: 'LinkedIn URL enrichment', confidence: 0.95 })
      } catch (e: any) {
        console.error('FullEnrich v2 failed:', e)
        enrichRaw    = { error: String(e?.message || e) }
        enrichStatus = 500
        sources.push({ type: 'fullenrich_v2', label: 'Enrichment unavailable', confidence: 0 })
      } finally {
        await db.from('enrichment_debug_logs').insert({
          user_id: user.id, provider: 'fullenrich_v2',
          request_payload: { linkedin_url: linkedinUrl, company_hint: companyHint },
          response_payload: enrichRaw,
          status_code: enrichStatus,
        }).catch(() => {})
      }
    } else {
      console.warn('FULLENRICH_API_KEY not set — skipping enrichment')
    }

    // Require at least a name to continue
    if (!fullName) return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL.' } }, 422)

    // ── Stage 2: Company resolution from work email domain (if needed) ────────
    if (emailDomain && !company) {
      try {
        const emp = await resolveEmployer(emailDomain, db, anthropicKey)
        company = emp.company
        companyConfidence = emp.confidence
        sources.push({ type: 'domain_lookup', label: 'Company from email domain', confidence: emp.confidence })
      } catch (e) { console.error('Employer resolution failed:', e) }
    }

    // Also resolve from FullEnrich company_domain if we still have no company
    if (companyDomain && !company) {
      try {
        const emp = await resolveEmployer(companyDomain, db, anthropicKey)
        company = emp.company
        companyConfidence = emp.confidence
        sources.push({ type: 'domain_lookup', label: 'Company from profile domain', confidence: emp.confidence })
      } catch (e) { console.error('Company domain resolution failed:', e) }
    }

    // ── Stage 3: Title — use FullEnrich result or fall back to Claude ─────────
    let title: string | null = providerTitle
    let titleConfidence = providerTitle ? 0.90 : 0

    if (!title && company && anthropicKey) {
      try {
        const fallback = await inferTitleFallback(fullName, company, anthropicKey)
        if (fallback.title && fallback.confidence >= 0.25) {
          title = fallback.title
          titleConfidence = fallback.confidence
          titleVerified = false
          sources.push({ type: 'claude_inference', label: 'Title inferred (unverified)', confidence: fallback.confidence })
        }
      } catch (e) { console.error('Title fallback failed:', e) }
    }

    // ── Stage 4: Confidence ───────────────────────────────────────────────────
    const draftConfidence = computeDraftConfidence(
      personConfidence, companyConfidence, titleConfidence,
      emailStatus, (userContext || '').length
    )

    let status: 'success' | 'partial' | 'not_enough_data' = 'success'
    if (!selectedEmail && !company) status = 'not_enough_data'
    else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

    // ── Stage 5: Draft ────────────────────────────────────────────────────────
    let draft: { subject: string; body: string } | null = null
    if (status !== 'not_enough_data' && anthropicKey) {
      try {
        draft = await generateDraft(
          fullName, company, title, titleVerified,
          selectedEmail, userContext,
          draftConfidence, anthropicKey
        )
      } catch (e) { console.error('Draft generation failed:', e) }
    }

    if (!draft && status !== 'not_enough_data') {
      return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' } }, 500)
    }

    // ── Stage 6: Persist (non-fatal) ──────────────────────────────────────────
    let runId: string | null = null
    try {
      const { data: run } = await db.from('outreach_runs').insert({
        user_id:            user.id,
        full_name:          fullName,
        company:            company || null,
        title:              title || null,
        email:              work_email || null,
        email_status:       emailStatus,
        person_confidence:  personConfidence,
        company_confidence: companyConfidence,
        title_confidence:   titleConfidence,
        draft_confidence:   draftConfidence,
        user_context:       userContext,
        company_hint:       companyHint,
        draft_subject:      draft?.subject || null,
        draft_body:         draft?.body || null,
        status,
        sources,
      }).select('id').single()
      runId = run?.id ?? null
    } catch (e) { console.error('outreach_runs insert failed (non-fatal):', e) }

    // ── Response ──────────────────────────────────────────────────────────────
    return json({
      status,
      runId,
      person: {
        fullName,
        company:      company || null,
        title:        title || null,
        titleVerified,
        email:        selectedEmail || null,   // work email first, personal email fallback
        workEmail:    work_email || null,
        personalEmail: personal_email || null,
        emailStatus,
      },
      confidence: {
        personConfidence,
        companyConfidence,
        titleConfidence,
        draftConfidence,
      },
      sources,
      draft: draft || null,
    })

  } catch (e) {
    console.error('enrich-and-draft error:', e)
    return json({ error: { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' } }, 500)
  }
})
