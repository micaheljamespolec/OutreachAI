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

  // Step 2: poll until FINISHED — initial 3s wait, then 5s intervals, max 22 attempts ≈ 110s
  await new Promise(r => setTimeout(r, 3000))
  for (let i = 0; i < 22; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000))

    const pollRes = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    })
    const pollData = await pollRes.json()

    if (pollData.status === 'FINISHED') {
      // FullEnrich returns either pollData.data or pollData.datas
      const results = pollData.datas ?? pollData.data ?? []
      const row = results[0]
      if (!row) return { ...empty, raw: pollData }

      // The contact wrapper may sit at row.contact or row itself
      const contactInfo = row.contact_info ?? row.contact?.contact_info ?? null
      const profile     = row.profile ?? row.contact?.profile ?? {}
      const current     = profile.employment?.current

      const workEmail = contactInfo?.most_probable_work_email?.email
        ?? contactInfo?.work_emails?.[0]?.email
        ?? row.contact?.most_probable_email
        ?? null
      const personalEmail = contactInfo?.most_probable_personal_email?.email
        ?? contactInfo?.personal_emails?.[0]?.email
        ?? null

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

  throw new Error('FullEnrich timeout — enrichment did not complete within 55s')
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

// ── Recruiter profile type ────────────────────────────────────────────────────
interface RecruiterProfile {
  full_name:    string
  company_name: string
  job_title:    string | null
  hiring_focus: string | null
  tone:         string | null
}

// ── Draft generation ──────────────────────────────────────────────────────────
async function generateDraft(
  fullName: string, company: string | null, title: string | null,
  titleVerified: boolean, email: string | null, userContext: string | null,
  draftConf: number, anthropicKey: string,
  recruiter: RecruiterProfile | null
): Promise<{ subject: string; body: string } | null> {
  if (!anthropicKey) return null

  const titleInstruction = title
    ? (titleVerified
        ? `Candidate's current role: ${title} (confirmed from data provider — reference it naturally).`
        : `Candidate's likely role: ${title} (inferred — reference it cautiously without claiming certainty).`)
    : `Candidate's role is unknown — do NOT claim any specific title. Write using name and company only.`

  // Build recruiter identity block
  const recruiterName    = recruiter?.full_name    || null
  const recruiterCompany = recruiter?.company_name || null
  const recruiterTitle   = recruiter?.job_title    || null
  const hiringFocus      = recruiter?.hiring_focus || null
  const tone             = recruiter?.tone         || null

  // Build sign-off per spec:
  // "Best,\nfull_name\njob_title at company_name" — job_title line omitted if null
  let signOff = 'Best,'
  if (recruiterName) {
    signOff = `Best,\n${recruiterName}`
    if (recruiterTitle && recruiterCompany) signOff += `\n${recruiterTitle} at ${recruiterCompany}`
    // If job_title is null, omit the title/company line entirely
  }

  const toneInstruction = tone
    ? `Tone: ${tone}, professional, peer-to-peer.`
    : 'Tone: professional, modern, peer-to-peer.'

  const hiringFocusInstruction = hiringFocus
    ? `Recruiter specializes in: ${hiringFocus} hiring.`
    : 'Recruiter specializes in general talent acquisition.'

  const recruiterBlock = recruiterName
    ? `Recruiter sending this email: ${recruiterName}${recruiterTitle ? `, ${recruiterTitle}` : ''}${recruiterCompany ? ` at ${recruiterCompany}` : ''}`
    : ''

  const prompt = `Write a concise recruiter outreach email (60–120 words). Use ONLY the supplied information. Do not invent facts.

Candidate: ${fullName}
${company ? `Company: ${company}` : ''}
${titleInstruction}
${email ? `Email: ${email}` : 'No email — generate body only.'}
${userContext ? `Recruiter context: ${userContext}` : ''}
${recruiterBlock}
${hiringFocusInstruction}
Confidence level: ${draftConf >= 0.65 ? 'normal — personalize where evidence exists' : 'low — be warm but generic, no specific claims'}

Rules:
- No mention of "I saw your profile", "I noticed you", or LinkedIn.
- No exclamation marks.
- No invented achievements.
- ${toneInstruction}
- One soft CTA.
- End the email body with exactly this sign-off (include it verbatim in the body field):
${signOff}

Return ONLY JSON: {"subject": "...", "body": "..."}`

  const raw = await callAnthropic(anthropicKey, 'claude-sonnet-4-5', 500, prompt)
  const p = parseJson(raw)
  if (!p.body) return null

  // Deterministic sign-off enforcement:
  // Strip any trailing lines that look like a sign-off (starting with "Best"),
  // then always append our canonical sign-off to guarantee exact format.
  const bodyLines = p.body.trimEnd().split('\n')
  let trimIdx = bodyLines.length
  for (let i = bodyLines.length - 1; i >= 0; i--) {
    const line = bodyLines[i].trim()
    if (line === '' || line.startsWith('Best')) { trimIdx = i; continue }
    break
  }
  const bodyWithoutSignOff = bodyLines.slice(0, trimIdx).join('\n').trimEnd()
  const finalBody = bodyWithoutSignOff ? `${bodyWithoutSignOff}\n\n${signOff}` : signOff

  return { subject: p.subject || `Reaching out — ${fullName}`, body: finalBody }
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
    const body   = await req.json()
    const action = body.action || 'enrich-and-draft'

    // ── Summarize-job action ───────────────────────────────────────────────────
    if (action === 'summarize-job') {
      const rawText  = (body.rawText  || '').slice(0, 3000)
      const jobTitle = (body.jobTitle || '').trim()
      const company  = (body.company  || '').trim()
      if (!rawText && !jobTitle) return json({ error: { code: 'MISSING_INPUT', message: 'No job text provided.' } }, 400)
      if (!anthropicKey)         return json({ error: { code: 'NO_API_KEY',    message: 'AI not configured.'     } }, 500)

      const prompt = `You are helping a recruiter understand a job posting so they can write personalized outreach emails.

Job title: ${jobTitle || 'not specified'}
Company: ${company || 'not specified'}

Raw job posting text:
${rawText}

Extract the 3–5 most useful selling points a recruiter would reference in an outreach email. Focus on:
- What the role actually does day-to-day (skip generic boilerplate)
- The seniority level and key skills required
- Anything distinctive: compensation range, tech stack, team size, company stage, notable impact
- Why a strong candidate would find this role interesting

Format as short bullet points starting with "•", max 15 words each.
Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.`

      const summary = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 400, prompt)
      if (!summary || summary === '{}') return json({ error: { code: 'SUMMARY_FAILED', message: 'Could not summarize job posting.' } }, 500)
      return json({ summary })
    }

    // ── Bookmark-profile action ────────────────────────────────────────────────
    if (action === 'bookmark-profile') {
      const linkedinUrl = (body.linkedinUrl || '').trim()
      const save        = body.save !== false  // default true
      if (!linkedinUrl) return json({ error: { code: 'MISSING_INPUT', message: 'linkedinUrl is required.' } }, 400)

      // Prefer explicit UPDATE to avoid nulling non-specified columns
      const { error: updateErr, count } = await db.from('saved_profiles')
        .update({ is_bookmarked: save, updated_at: new Date().toISOString() }, { count: 'exact' })
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)

      if (updateErr) {
        console.error('bookmark-profile update failed:', updateErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not update bookmark.' } }, 500)
      }
      // If no existing row (first-time bookmark before any enrichment), insert a stub
      if (count === 0) {
        const { error: insertErr } = await db.from('saved_profiles')
          .insert({ user_id: user.id, linkedin_url: linkedinUrl, is_bookmarked: save })
        if (insertErr) {
          console.error('bookmark-profile insert failed:', insertErr)
          return json({ error: { code: 'DB_ERROR', message: 'Could not create bookmark.' } }, 500)
        }
      }
      return json({ bookmarked: save })
    }

    // ── Check-saved-profile action (lightweight — no FullEnrich/Claude) ───────
    if (action === 'check-saved-profile') {
      const linkedinUrl = (body.linkedinUrl || '').trim()
      if (!linkedinUrl) return json({ found: false })

      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: cached } = await db.from('saved_profiles')
        .select('full_name, work_email, personal_email, title, company, title_verified, email_status, is_bookmarked, enriched_at')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .or(`is_bookmarked.eq.true,enriched_at.gte.${cacheWindow}`)
        .limit(1)
        .maybeSingle()

      if (!cached || !cached.full_name) return json({ found: false })

      return json({
        found: true,
        profile: {
          fullName:      cached.full_name,
          workEmail:     cached.work_email     || null,
          personalEmail: cached.personal_email || null,
          email:         cached.work_email || cached.personal_email || null,
          title:         cached.title          || null,
          titleVerified: cached.title_verified ?? false,
          company:       cached.company        || null,
          emailStatus:   cached.email_status   || 'not_found',
          isBookmarked:  cached.is_bookmarked  ?? false,
        },
      })
    }

    // ── Save-job action ────────────────────────────────────────────────────────
    if (action === 'save-job') {
      const label      = (body.label      || '').trim()
      const jobUrl     = (body.jobUrl     || '').trim() || null
      const roleTitle  = (body.roleTitle  || '').trim() || null
      const jobCompany = (body.company    || '').trim() || null
      const highlights = (body.highlights || '').trim() || null
      if (!label) return json({ error: { code: 'MISSING_INPUT', message: 'A job label is required.' } }, 400)

      const { data: job, error: upsertErr } = await db.from('saved_jobs')
        .upsert({
          user_id: user.id, label, job_url: jobUrl, role_title: roleTitle,
          company: jobCompany, highlights, updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,label' })
        .select('id, label, job_url, role_title, company, highlights')
        .single()

      if (upsertErr) {
        console.error('save-job upsert failed:', upsertErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not save job.' } }, 500)
      }
      return json({ job })
    }

    // ── Get-saved-jobs action ──────────────────────────────────────────────────
    if (action === 'get-saved-jobs') {
      const { data: jobs, error: fetchErr } = await db.from('saved_jobs')
        .select('id, label, job_url, role_title, company, highlights, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(30)

      if (fetchErr) {
        console.error('get-saved-jobs failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load saved jobs.' } }, 500)
      }
      return json({ jobs: jobs || [] })
    }

    // ── Delete-job action ──────────────────────────────────────────────────────
    if (action === 'delete-job') {
      const jobId = (body.jobId || '').trim()
      if (!jobId) return json({ error: { code: 'MISSING_INPUT', message: 'jobId is required.' } }, 400)

      const { error: deleteErr } = await db.from('saved_jobs')
        .delete()
        .eq('id', jobId)
        .eq('user_id', user.id)

      if (deleteErr) {
        console.error('delete-job failed:', deleteErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not delete job.' } }, 500)
      }
      return json({ deleted: true })
    }

    // ── Get-saved-profiles action ──────────────────────────────────────────────
    if (action === 'get-saved-profiles') {
      const { data: profiles, error: fetchErr } = await db.from('saved_profiles')
        .select('id, linkedin_url, full_name, work_email, personal_email, title, company, title_verified, email_status, enriched_at, is_bookmarked')
        .eq('user_id', user.id)
        .eq('is_bookmarked', true)
        .order('updated_at', { ascending: false })
        .limit(20)

      if (fetchErr) {
        console.error('get-saved-profiles fetch failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load saved profiles.' } }, 500)
      }
      return json({ profiles: profiles || [] })
    }

    // ── Enrich-and-draft action ────────────────────────────────────────────────
    const linkedinUrl = body.linkedinUrl?.trim() || null
    const companyHint = body.companyHint?.trim() || null
    const userContext = body.userContext?.trim() || null
    const fullNameHint = body.fullNameHint?.trim() || null

    if (!linkedinUrl) return json({ error: { code: 'NO_LINKEDIN_URL', message: 'Open a LinkedIn profile to generate a draft.' } }, 400)

    // ── Fetch recruiter profile for draft personalization ─────────────────────
    let recruiterProfile: RecruiterProfile | null = null
    try {
      const { data: rp } = await db.from('recruiter_profiles')
        .select('full_name, company_name, job_title, hiring_focus, tone')
        .eq('user_id', user.id)
        .maybeSingle()
      if (rp) recruiterProfile = rp as RecruiterProfile
    } catch (e) { console.warn('recruiter_profiles fetch failed (non-fatal):', e) }

    // ── Cache lookup: check saved_profiles before hitting FullEnrich ──────────
    const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: cached } = await db.from('saved_profiles')
      .select('full_name, work_email, personal_email, title, company, title_verified, email_status, is_bookmarked, enriched_at')
      .eq('user_id', user.id)
      .eq('linkedin_url', linkedinUrl)
      .or(`is_bookmarked.eq.true,enriched_at.gte.${cacheWindow}`)
      .limit(1)
      .maybeSingle()

    if (cached && cached.full_name) {
      // Serve from cache — skip FullEnrich entirely
      const fullName     = cached.full_name
      const work_email   = cached.work_email || null
      const personal_email = cached.personal_email || null
      const selectedEmail  = work_email || personal_email || null
      const company        = companyHint || cached.company || null
      const title          = cached.title || null
      const titleVerified  = cached.title_verified ?? false
      const emailStatus    = (cached.email_status as 'found' | 'not_found' | 'uncertain') || 'not_found'

      const personConfidence  = 0.95
      const companyConfidence = company ? 0.90 : 0.3
      const titleConfidence   = title ? (titleVerified ? 0.90 : 0.40) : 0

      const draftConfidence = computeDraftConfidence(
        personConfidence, companyConfidence, titleConfidence,
        emailStatus, (userContext || '').length
      )

      let status: 'success' | 'partial' | 'not_enough_data' = 'success'
      if (!selectedEmail && !company) status = 'not_enough_data'
      else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

      let draft: { subject: string; body: string } | null = null
      if (status !== 'not_enough_data' && anthropicKey) {
        try {
          draft = await generateDraft(
            fullName, company, title, titleVerified,
            selectedEmail, userContext,
            draftConfidence, anthropicKey,
            recruiterProfile
          )
        } catch (e) { console.error('Draft generation (cache) failed:', e) }
      }

      if (!draft && status !== 'not_enough_data') {
        return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' } }, 500)
      }

      return json({
        status,
        fromCache: true,
        isBookmarked: cached.is_bookmarked ?? false,
        person: {
          fullName,
          company,
          title,
          titleVerified,
          email:         selectedEmail,
          workEmail:     work_email,
          personalEmail: personal_email,
          emailStatus,
        },
        confidence: {
          personConfidence,
          companyConfidence,
          titleConfidence,
          draftConfidence,
        },
        sources: [{ type: 'saved_profile', label: 'From saved profile (cached)', confidence: 0.95 }],
        draft: draft || null,
      })
    }

    // ── Credit gate: deduct before calling FullEnrich ────────────────────────
    // Cache hits are free — only fresh enrichments cost a credit.
    const { data: creditAllowed, error: creditErr } = await db.rpc('deduct_credit', { p_user_id: user.id })
    if (creditErr) {
      console.error('deduct_credit RPC error:', creditErr)
      return json({ error: { code: 'CREDIT_ERROR', message: 'Could not verify your credit balance. Please try again.' } }, 500)
    }
    if (creditAllowed === false) {
      return json({ error: { code: 'CREDIT_LIMIT_REACHED', message: 'You have reached your lookup limit. Upgrade your plan for more enrichments.' } }, 402)
    }

    // ── Fresh enrichment ──────────────────────────────────────────────────────
    const sources: any[] = []
    let personConfidence = 0.5

    let fullName: string = fullNameHint || ''
    let work_email: string | null = null
    let personal_email: string | null = null
    let selectedEmail: string | null = null
    let company: string | null = companyHint || null
    let companyDomain: string | null = null
    let providerTitle: string | null = null
    let emailStatus: 'found' | 'not_found' | 'uncertain' = 'not_found'
    let emailDomain: string | null = null
    let companyConfidence = companyHint ? 0.7 : 0.3
    let titleVerified = false
    let rawDataPayload: any = null

    if (fullenrichKey) {
      let enrichRaw: any = null
      let enrichStatus = 0
      try {
        const enrichResult = await enrichWithLinkedInV2(linkedinUrl, fullenrichKey)
        enrichRaw       = enrichResult.raw
        rawDataPayload  = enrichResult.raw
        enrichStatus = 200

        if (enrichResult.full_name) {
          fullName = enrichResult.full_name
          personConfidence = 0.95
        }

        work_email     = enrichResult.work_email
        personal_email = enrichResult.personal_email
        selectedEmail  = work_email || personal_email || null
        emailStatus    = work_email ? 'found' : personal_email ? 'uncertain' : 'not_found'
        if (work_email) emailDomain = work_email.split('@')[1] || null
        else if (personal_email) emailDomain = personal_email.split('@')[1] || null

        if (enrichResult.company) {
          company = enrichResult.company
          companyDomain = enrichResult.company_domain
          companyConfidence = 0.95
        } else if (enrichResult.company_domain) {
          companyDomain = enrichResult.company_domain
        }

        if (enrichResult.title) {
          providerTitle = enrichResult.title
          titleVerified = true
        }

        // ── Persist all resolved fields immediately after FullEnrich succeeds ───
        // Writing the full profile here means any "Try again" retry will hit the
        // cache and cost zero credits, even if draft generation later fails.
        try {
          const earlyEmailStatus = enrichResult.work_email ? 'found'
            : enrichResult.personal_email ? 'uncertain' : 'not_found'
          await db.from('saved_profiles').upsert({
            user_id:        user.id,
            linkedin_url:   linkedinUrl,
            full_name:      enrichResult.full_name || fullName || null,
            work_email:     enrichResult.work_email || null,
            personal_email: enrichResult.personal_email || null,
            title:          enrichResult.title || null,
            company:        enrichResult.company || companyHint || null,
            title_verified: !!enrichResult.title,
            email_status:   earlyEmailStatus,
            raw_data:       enrichResult.raw,
            enriched_at:    new Date().toISOString(),
            updated_at:     new Date().toISOString(),
          }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })
        } catch (e) { console.error('early upsert failed (non-fatal):', e) }

        sources.push({ type: 'fullenrich_v2', label: 'LinkedIn URL enrichment', confidence: 0.95 })
      } catch (e: any) {
        console.error('FullEnrich v2 failed:', e)
        enrichRaw    = { error: String(e?.message || e) }
        enrichStatus = 500
        sources.push({ type: 'fullenrich_v2', label: 'Enrichment unavailable', confidence: 0 })
      } finally {
        try {
          await db.from('enrichment_debug_logs').insert({
            user_id: user.id, provider: 'fullenrich_v2',
            request_payload: { linkedin_url: linkedinUrl, company_hint: companyHint },
            response_payload: enrichRaw,
            status_code: enrichStatus,
          })
        } catch {}
      }
    } else {
      console.warn('FULLENRICH_API_KEY not set — skipping enrichment')
    }

    if (!fullName) return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL.' } }, 422)

    // ── Stage 2: Company resolution ────────────────────────────────────────────
    if (emailDomain && !company) {
      try {
        const emp = await resolveEmployer(emailDomain, db, anthropicKey)
        company = emp.company
        companyConfidence = emp.confidence
        sources.push({ type: 'domain_lookup', label: 'Company from email domain', confidence: emp.confidence })
      } catch (e) { console.error('Employer resolution failed:', e) }
    }

    if (companyDomain && !company) {
      try {
        const emp = await resolveEmployer(companyDomain, db, anthropicKey)
        company = emp.company
        companyConfidence = emp.confidence
        sources.push({ type: 'domain_lookup', label: 'Company from profile domain', confidence: emp.confidence })
      } catch (e) { console.error('Company domain resolution failed:', e) }
    }

    // ── Stage 3: Title ─────────────────────────────────────────────────────────
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

    // ── Stage 4: Confidence ────────────────────────────────────────────────────
    const draftConfidence = computeDraftConfidence(
      personConfidence, companyConfidence, titleConfidence,
      emailStatus, (userContext || '').length
    )

    let status: 'success' | 'partial' | 'not_enough_data' = 'success'
    if (!selectedEmail && !company) status = 'not_enough_data'
    else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

    // ── Stage 5: Draft ─────────────────────────────────────────────────────────
    let draft: { subject: string; body: string } | null = null
    if (status !== 'not_enough_data' && anthropicKey) {
      try {
        draft = await generateDraft(
          fullName, company, title, titleVerified,
          selectedEmail, userContext,
          draftConfidence, anthropicKey,
          recruiterProfile
        )
      } catch (e) { console.error('Draft generation failed:', e) }
    }

    if (!draft && status !== 'not_enough_data') {
      return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' } }, 500)
    }

    // ── Stage 6a: Increment AI run counter ────────────────────────────────────
    try {
      await db.rpc('increment_ai_run', { p_user_id: user.id })
    } catch (e) { console.error('increment_ai_run RPC failed (non-fatal):', e) }

    // ── Stage 6: Persist outreach_runs ─────────────────────────────────────────
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

    // ── Stage 7: Upsert into saved_profiles cache, read back bookmark state ────
    let isBookmarked = false
    try {
      await db.from('saved_profiles').upsert({
        user_id:        user.id,
        linkedin_url:   linkedinUrl,
        full_name:      fullName,
        work_email:     work_email || null,
        personal_email: personal_email || null,
        title:          title || null,
        company:        company || null,
        title_verified: titleVerified,
        email_status:   emailStatus,
        enriched_at:    new Date().toISOString(),
        updated_at:     new Date().toISOString(),
        raw_data:       rawDataPayload || null,
        // Do NOT include is_bookmarked — preserve existing bookmark state on conflict
      }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })

      // Read back the actual is_bookmarked value so the UI is authoritative
      const { data: savedRow } = await db.from('saved_profiles')
        .select('is_bookmarked')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .maybeSingle()
      isBookmarked = savedRow?.is_bookmarked ?? false
    } catch (e) { console.error('saved_profiles upsert failed (non-fatal):', e) }

    // ── Response ───────────────────────────────────────────────────────────────
    return json({
      status,
      fromCache: false,
      isBookmarked,
      runId,
      person: {
        fullName,
        company:       company || null,
        title:         title || null,
        titleVerified,
        email:         selectedEmail || null,
        workEmail:     work_email || null,
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

  } catch (e: any) {
    console.error('enrich-and-draft error:', String(e?.message || e), e?.stack || '')
    return json({ error: { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' } }, 500)
  }
})
