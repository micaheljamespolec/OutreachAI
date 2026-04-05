import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const LINKEDIN_DOMAINS = ['linkedin.com', 'lnkd.in', 'linkedin.cn', 'linked.in']

function isLinkedInUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return LINKEDIN_DOMAINS.some(d => h === d || h.endsWith('.' + d))
  } catch { return false }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ')
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

// ── FullEnrich: name only, no LinkedIn URL ────────────────────────────────────
async function enrichEmail(fullName: string, companyHint: string | null, key: string): Promise<{
  work_email: string | null
  personal_email: string | null
  company: string | null
  title: string | null
  confidence: number
  raw: any
}> {
  const parts = fullName.trim().split(/\s+/)
  const payload: any = { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '' }
  if (companyHint) payload.company = companyHint
  // No LinkedIn URL — never passed to FullEnrich

  const res = await fetch('https://api.fullenrich.com/v1/enrich/person', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(payload),
  })
  const raw = await res.json()
  if (!res.ok) throw new Error(`FullEnrich error ${res.status}`)

  return {
    work_email: raw.work_email || raw.professional_email || null,
    personal_email: raw.personal_email || null,
    company: raw.company || raw.organization || null,
    title: raw.title || null,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.7,
    raw,
  }
}

// ── Employer resolution from email domain ─────────────────────────────────────
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
    `What company uses email domain "${domain}"? No LinkedIn. Reply ONLY JSON: {"company_name":"...","confidence":0.0-1.0}`)
  const p = parseJson(raw)
  const company = p.company_name || domain
  const confidence = typeof p.confidence === 'number' ? p.confidence : 0.4
  await db.from('company_domains').upsert({ domain, canonical_company_name: company, confidence })
  return { company, confidence }
}

// ── Public-web title inference (LinkedIn hard-blocked) ────────────────────────
async function inferTitle(fullName: string, company: string, anthropicKey: string): Promise<{
  title: string | null
  confidence: number
  sources: string[]
  summary: string
}> {
  if (!anthropicKey) return { title: null, confidence: 0, sources: [], summary: '' }

  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 350, `
HARD RULE: Do NOT use LinkedIn, lnkd.in, or any LinkedIn-adjacent source.
If only LinkedIn evidence exists: return title null, confidence 0.
Allowed: company websites, conference bios, press releases, RocketReach, ZoomInfo, Apollo, Crunchbase, SEC filings, personal sites.

Person: "${fullName}" at "${company}"

Return ONLY JSON:
{
  "title": "best matching title or null",
  "confidence": 0.0-1.0,
  "sources": ["source type 1"],
  "evidence_summary": "brief note on evidence"
}`)

  const p = parseJson(raw)
  const sources: string[] = (p.sources || []).filter((s: string) => !isLinkedInUrl(s) && !s.toLowerCase().includes('linkedin'))
  const hadLinkedIn = (p.sources || []).length > sources.length
  const confidencePenalty = hadLinkedIn ? 0.2 : 0
  const confidence = Math.max(0, (typeof p.confidence === 'number' ? p.confidence : 0) - confidencePenalty)

  return {
    title: confidence < 0.3 ? null : (p.title || null),
    confidence,
    sources,
    summary: p.evidence_summary || '',
  }
}

// ── Draft generation (confidence-gated) ──────────────────────────────────────
async function generateDraft(
  fullName: string, company: string | null, title: string | null,
  email: string | null, userContext: string | null,
  personConf: number, titleConf: number, draftConf: number,
  anthropicKey: string
): Promise<{ subject: string; body: string } | null> {
  if (!anthropicKey) return null

  const isHighConf = draftConf >= 0.65
  const hasTitleSignal = title && titleConf >= 0.5

  const titleInstruction = hasTitleSignal
    ? `Candidate's inferred role: ${title} (moderate-to-high confidence — may be referenced professionally).`
    : `Candidate's role is uncertain — do NOT claim any specific title. Write warmly using name and company only.`

  const prompt = `Write a concise recruiter outreach email (60–120 words). Use ONLY the supplied information. Do not invent facts.

Candidate: ${fullName}
${company ? `Company: ${company}` : ''}
${titleInstruction}
${email ? `Email: ${email}` : 'No email — generate body only.'}
${userContext ? `Recruiter context: ${userContext}` : ''}
Confidence level: ${isHighConf ? 'normal — personalize where evidence exists' : 'low — be warm but generic, no specific claims'}

Rules:
- No mention of "I saw your profile", "I noticed you", or LinkedIn.
- No exclamation marks.
- No invented achievements.
- Tone: professional, modern, peer-to-peer.
- One soft CTA.
- Do NOT mention Analyze Fit, match scores, or compatibility.

Return ONLY JSON: {"subject": "...", "body": "..."}`

  const raw = await callAnthropic(anthropicKey, 'claude-sonnet-4-5', 500, prompt)
  const p = parseJson(raw)
  if (!p.body) return null
  return { subject: p.subject || `Reaching out — ${fullName}`, body: p.body }
}

// ── Weighted confidence formula ───────────────────────────────────────────────
function computeDraftConfidence(
  personConf: number, companyConf: number, titleConf: number,
  emailStatus: string, userContextLength: number
): number {
  const emailConf = emailStatus === 'found' ? 1 : emailStatus === 'uncertain' ? 0.5 : 0
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

  // Auth — validate user JWT using the service role client
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)
  const { data: { user }, error: authErr } = await db.auth.getUser(token)
  if (authErr || !user) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)

  try {
    const body = await req.json()
    const fullName    = normalizeName(body.fullName || '')
    const companyHint = body.companyHint?.trim() || null
    const userContext = body.userContext?.trim() || null

    if (!fullName) return json({ error: { code: 'NO_PERSON_NAME', message: 'Enter a full name to continue.' } }, 400)

    const sources: any[] = [{ type: 'manual_input', label: 'Name submitted by user', confidence: 0.99 }]
    let personConfidence = 0.90  // high baseline for manually-entered names

    // ── Stage 1: FullEnrich ──────────────────────────────────────────────────
    let work_email: string | null = null
    let personal_email: string | null = null
    let company: string | null = companyHint || null
    let providerTitle: string | null = null
    let emailStatus: 'found' | 'not_found' | 'uncertain' = 'not_found'
    let emailDomain: string | null = null
    let companyConfidence = companyHint ? 0.7 : 0.3

    if (fullenrichKey) {
      let enrichRaw: any = null
      let enrichStatus = 0
      try {
        const enrichResult = await enrichEmail(fullName, companyHint, fullenrichKey)
        enrichRaw = enrichResult.raw
        enrichStatus = 200

        work_email = enrichResult.work_email
        personal_email = enrichResult.personal_email
        providerTitle = enrichResult.title
        personConfidence = Math.max(personConfidence, enrichResult.confidence)
        emailStatus = work_email ? 'found' : 'not_found'
        if (work_email) emailDomain = work_email.split('@')[1] || null

        if (enrichResult.company) {
          company = enrichResult.company
          companyConfidence = enrichResult.confidence
        }

        sources.push({ type: 'fullenrich', label: 'Email & employer enrichment', confidence: enrichResult.confidence })
      } catch (e: any) {
        console.error('FullEnrich failed:', e)
        enrichRaw = { error: String(e?.message || e) }
        enrichStatus = 500
        sources.push({ type: 'fullenrich', label: 'Enrichment unavailable', confidence: 0 })
      } finally {
        await db.from('enrichment_debug_logs').insert({
          user_id: user.id, provider: 'fullenrich',
          request_payload: { full_name: fullName, company_hint: companyHint },
          response_payload: enrichRaw,
          status_code: enrichStatus,
        }).catch(() => {})
      }
    } else {
      console.warn('FULLENRICH_API_KEY not set — skipping enrichment')
    }

    // ── Stage 2: Employer resolution from email domain ────────────────────────
    if (emailDomain && !company) {
      try {
        const emp = await resolveEmployer(emailDomain, db, anthropicKey)
        company = emp.company
        companyConfidence = emp.confidence
        sources.push({ type: 'inferred', label: 'Company from email domain', confidence: emp.confidence })
      } catch (e) { console.error('Employer resolution failed:', e) }
    }

    // ── Stage 3: Title inference (LinkedIn hard-blocked) ──────────────────────
    let title: string | null = providerTitle || null
    let titleConfidence = providerTitle ? 0.7 : 0

    if (!title && company && anthropicKey) {
      try {
        const ti = await inferTitle(fullName, company, anthropicKey)
        if (ti.title && ti.confidence >= 0.3) {
          title = ti.title
          titleConfidence = ti.confidence
          sources.push({ type: 'public_web', label: 'Title from public web signals', confidence: ti.confidence })
        }
      } catch (e) { console.error('Title inference failed:', e) }
    }

    // ── Stage 4: Compute confidence ───────────────────────────────────────────
    const draftConfidence = computeDraftConfidence(
      personConfidence, companyConfidence, titleConfidence,
      emailStatus, (userContext || '').length
    )

    // Determine result status
    let status: 'success' | 'partial' | 'not_enough_data' = 'success'
    if (!work_email && !company) status = 'not_enough_data'
    else if (!work_email || titleConfidence < 0.3) status = 'partial'

    // ── Stage 5: Draft generation ─────────────────────────────────────────────
    let draft: { subject: string; body: string } | null = null
    if (status !== 'not_enough_data' && anthropicKey) {
      try {
        draft = await generateDraft(
          fullName, company, title, work_email, userContext,
          personConfidence, titleConfidence, draftConfidence, anthropicKey
        )
      } catch (e) { console.error('Draft generation failed:', e) }
    }

    if (!draft && status !== 'not_enough_data') {
      return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' } }, 500)
    }

    // ── Stage 6: Persist to outreach_runs (non-fatal) ────────────────────────
    let runId: string | null = null
    try {
      const { data: run } = await db.from('outreach_runs').insert({
        user_id: user.id,
        full_name: fullName,
        company: company || null,
        title: title || null,
        email: work_email || null,
        email_status: emailStatus,
        person_confidence: personConfidence,
        company_confidence: companyConfidence,
        title_confidence: titleConfidence,
        draft_confidence: draftConfidence,
        user_context: userContext,
        company_hint: companyHint,
        draft_subject: draft?.subject || null,
        draft_body: draft?.body || null,
        status,
        sources,
      }).select('id').single()
      runId = run?.id ?? null
    } catch (e) {
      console.error('outreach_runs insert failed (non-fatal):', e)
    }

    // ── Response ──────────────────────────────────────────────────────────────
    return json({
      status,
      runId,
      person: {
        fullName,
        company: company || null,
        title: title || null,
        email: work_email || null,
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
