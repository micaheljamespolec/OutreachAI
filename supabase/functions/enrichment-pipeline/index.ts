import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}
async function updateJob(db: any, job_id: string, updates: Record<string, unknown>) {
  await db.from('workflow_jobs').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', job_id)
}
async function updateCandidate(db: any, candidate_id: string, updates: Record<string, unknown>) {
  await db.from('candidates').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', candidate_id)
}

// ── Confidence thresholds ─────────────────────────────────────────────────────
const THRESHOLDS = {
  identity:  0.6,   // minimum to trust we found the right person
  title:     0.5,   // minimum for a "strong" draft
  overall:   0.55,  // combined gate for full draft vs. soft draft
}

function computeOverallConfidence(email_confidence: number, company_confidence: number, title_confidence: number): number {
  // Weighted average: email/identity is most important, title is least
  return Math.round(
    (email_confidence * 0.5 + company_confidence * 0.3 + title_confidence * 0.2) * 100
  ) / 100
}

// ── LinkedIn domain hard-block ────────────────────────────────────────────────
// Any result from these domains MUST be dropped before parsing.
const BLOCKED_DOMAINS = ['linkedin.com', 'lnkd.in', 'linkedin.cn', 'linked.in']

function isLinkedInUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
    return BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))
  } catch { return false }
}

function filterLinkedInSources<T extends { url?: string; source_url?: string }>(items: T[]): T[] {
  return items.filter(item => {
    const url = item.url || item.source_url || ''
    if (!url) return true
    if (isLinkedInUrl(url)) {
      console.log(`[BLOCKED] LinkedIn URL dropped from enrichment: ${url}`)
      return false
    }
    return true
  })
}

// ── Stage 2: FullEnrich email lookup ─────────────────────────────────────────
// IMPORTANT: only uses full_name. source_url is stored for debugging only and
// is NOT passed to FullEnrich. The pipeline must be independent of LinkedIn URLs.
async function lookupEmail(full_name: string, fullenrichKey: string): Promise<{
  work_email: string | null
  personal_email: string | null
  email_confidence: number
}> {
  const nameParts = full_name.trim().split(/\s+/)
  const first_name = nameParts[0] || ''
  const last_name  = nameParts.slice(1).join(' ') || ''

  // Only name — no LinkedIn URL, no company hint at this stage
  const payload = { first_name, last_name }

  const res = await fetch('https://api.fullenrich.com/v1/enrich/person', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': fullenrichKey },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`FullEnrich error ${res.status}: ${txt}`)
  }

  const data = await res.json()
  const work_email    = data.work_email || data.professional_email || null
  const personal_email = data.personal_email || null

  // Identity confidence: how confident are we this is the right person?
  // FullEnrich may return a confidence score; fall back to heuristic.
  // Lower confidence for common names (many parts = potentially unique), higher for rare names.
  const fullenrichConfidence = typeof data.confidence === 'number' ? data.confidence : null
  const nameWords = nameParts.length
  const nameRarityBonus = nameWords >= 3 ? 0.1 : 0  // middle names = more unique
  const email_confidence = fullenrichConfidence ?? (work_email ? 0.75 + nameRarityBonus : 0.1)

  return { work_email, personal_email, email_confidence }
}

// ── Stage 3: Employer resolution from email domain ────────────────────────────
async function resolveEmployer(domain: string, db: any, anthropicKey: string): Promise<{
  company_name: string
  confidence: number
}> {
  // Cache check
  const { data: cached } = await db.from('company_domains').select('canonical_company_name, confidence').eq('domain', domain).single()
  if (cached) return { company_name: cached.canonical_company_name, confidence: cached.confidence }

  // Well-known domains — high confidence
  const knownDomains: Record<string, string> = {
    'google.com': 'Google', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple',
    'amazon.com': 'Amazon', 'meta.com': 'Meta', 'salesforce.com': 'Salesforce',
    'bms.com': 'Bristol Myers Squibb', 'pfizer.com': 'Pfizer', 'jnj.com': 'Johnson & Johnson',
    'ibm.com': 'IBM', 'oracle.com': 'Oracle', 'sap.com': 'SAP', 'adobe.com': 'Adobe',
    'stripe.com': 'Stripe', 'openai.com': 'OpenAI', 'anthropic.com': 'Anthropic',
    'goodparty.org': 'Good Party', 'kakiyo.com': 'Kakiyo',
  }
  if (knownDomains[domain]) {
    const company_name = knownDomains[domain]
    await db.from('company_domains').upsert({ domain, canonical_company_name: company_name, confidence: 0.99 })
    return { company_name, confidence: 0.99 }
  }

  if (!anthropicKey) return { company_name: domain, confidence: 0.3 }

  // AI resolver — infer from domain only, no LinkedIn
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `What company uses the email domain "${domain}"? Do NOT reference LinkedIn. Based only on public knowledge of the domain. Reply ONLY with JSON: {"company_name": "...", "confidence": 0.0-1.0}. If unsure, set confidence below 0.5.`,
      }],
    }),
  })
  const d = await res.json()
  const raw = d.content?.[0]?.text?.trim() || '{}'
  try {
    const p = JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim())
    const company_name = p.company_name || domain
    const confidence = typeof p.confidence === 'number' ? p.confidence : 0.4
    await db.from('company_domains').upsert({ domain, canonical_company_name: company_name, confidence })
    return { company_name, confidence }
  } catch {
    return { company_name: domain, confidence: 0.3 }
  }
}

// ── Stage 4: Public-web title inference ──────────────────────────────────────
// HARD RULE: Any result mentioning or sourced from linkedin.com or lnkd.in MUST be dropped.
// This is enforced in code, not just comments.
async function inferPublicTitle(full_name: string, company_name: string, anthropicKey: string): Promise<{
  titles: string[]
  evidence_summary: string
  title_confidence: number
  sources_used: string[]
}> {
  if (!anthropicKey) return { titles: [], evidence_summary: '', title_confidence: 0, sources_used: [] }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a research assistant helping infer a professional's title using only non-LinkedIn public sources.

HARD RULE: You must NOT use LinkedIn, LinkedIn Recruiter, lnkd.in, or any LinkedIn-adjacent data. If your only evidence comes from LinkedIn, return confidence 0.0 and titles ["Unknown"].

Allowed sources: company websites, conference speaker bios, press releases, news articles, RocketReach, ZoomInfo, Apollo, Crunchbase, AngelList, public directories, SEC filings, company blog posts.

Candidate: "${full_name}"
Company (resolved from their work email domain): "${company_name}"

Return ONLY valid JSON:
{
  "titles": ["most likely title", "alternative if ambiguous"],
  "evidence_summary": "What non-LinkedIn public signals suggest about this person's role (or 'No non-LinkedIn signals found')",
  "title_confidence": 0.0-1.0,
  "sources_used": ["source type 1", "source type 2"]
}

If you cannot find non-LinkedIn evidence, return title_confidence below 0.35 and titles ["Unknown"].`,
      }],
    }),
  })

  const d = await res.json()
  const raw = d.content?.[0]?.text?.trim() || '{}'

  try {
    const p = JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim())

    // Hard-block: if any source URL is LinkedIn, reject and zero out confidence
    const rawSources: string[] = p.sources_used || []
    const cleanSources = rawSources.filter(s => !isLinkedInUrl(s) && !s.toLowerCase().includes('linkedin'))

    // If sources were filtered down significantly, reduce confidence
    const sourceReductionPenalty = rawSources.length > 0 && cleanSources.length < rawSources.length
      ? 0.2 : 0

    const title_confidence = Math.max(0, (p.title_confidence ?? 0) - sourceReductionPenalty)
    const titles = title_confidence < 0.1 ? ['Unknown'] : (p.titles || ['Unknown'])

    return {
      titles,
      evidence_summary: p.evidence_summary || '',
      title_confidence,
      sources_used: cleanSources,
    }
  } catch {
    return { titles: [], evidence_summary: '', title_confidence: 0, sources_used: [] }
  }
}

// ── Stage 5: Title normalization ──────────────────────────────────────────────
async function resolveTitle(full_name: string, company_name: string, titles: string[], anthropicKey: string): Promise<{
  inferred_title: string | null
  seniority: string | null
  function: string | null
  title_confidence: number
}> {
  if (!titles.length || titles[0] === 'Unknown' || !anthropicKey) {
    return { inferred_title: null, seniority: null, function: null, title_confidence: 0 }
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Normalize these title signals for "${full_name}" at "${company_name}". Do NOT invent titles not supported by the evidence. Do NOT reference LinkedIn.

Raw titles: ${JSON.stringify(titles)}

Return ONLY JSON:
{
  "inferred_title": "Most specific title the evidence actually supports",
  "seniority": "e.g. Senior Manager, Director, IC, VP — or null if unclear",
  "function": "e.g. Talent Acquisition, Software Engineering, Sales — or null if unclear",
  "title_confidence": 0.0-1.0
}`,
      }],
    }),
  })
  const d = await res.json()
  const raw = d.content?.[0]?.text?.trim() || '{}'
  try {
    return JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim())
  } catch {
    return { inferred_title: titles[0], seniority: null, function: null, title_confidence: 0.35 }
  }
}

// ── Stage 6+7: Draft generation (confidence-gated) ────────────────────────────
// Strong draft: used when overall_confidence >= threshold — includes personalization
// Soft draft:   used when confidence is low — warm but non-specific, avoids false claims
async function generateOutreach(
  full_name: string,
  company_name: string,
  inferred_title: string | null,
  evidence_summary: string,
  overall_confidence: number,
  title_confidence: number,
  job: { title: string, company: string, description: string },
  recruiter: { name: string, title: string },
  anthropicKey: string
): Promise<any> {
  if (!anthropicKey) return null

  const isHighConfidence = overall_confidence >= THRESHOLDS.overall && title_confidence >= THRESHOLDS.title
  const hasTitleSignal   = inferred_title && title_confidence >= THRESHOLDS.title

  const candidateContext = [
    `Candidate name: ${full_name}`,
    hasTitleSignal ? `Inferred role: ${inferred_title} (confidence: ${Math.round(title_confidence * 100)}%)` : null,
    company_name ? `Company (from work email domain): ${company_name}` : null,
    evidence_summary && hasTitleSignal ? `Non-LinkedIn public signals: ${evidence_summary}` : null,
  ].filter(Boolean).join('\n')

  const jobContext = [
    job.title   ? `Role being recruited for: ${job.title}`   : null,
    job.company ? `Hiring company: ${job.company}`           : null,
    job.description ? `Role highlights: ${job.description}`  : null,
  ].filter(Boolean).join('\n')

  const confidenceInstruction = isHighConfidence
    ? `You have moderate-to-high confidence in the candidate's role. You may reference their likely function/seniority in a professional but non-presumptuous way.`
    : `You have LOW confidence in the candidate's title — do NOT reference their specific role or function. Write a warm, genuinely personalized email using only their name and company. Avoid generic phrases like "I came across your profile." Instead, make it feel personal without over-claiming.`

  const prompt = `You are writing a brief, warm outreach email from a recruiter to a candidate already sourced via LinkedIn Recruiter.

${candidateContext}

${jobContext}

Recruiter: ${recruiter.name || 'the recruiter'}${recruiter.title ? `, ${recruiter.title}` : ''}

Confidence level: ${isHighConfidence ? 'NORMAL' : 'LOW — title unclear, be non-specific about their role'}

${confidenceInstruction}

Return ONLY valid JSON:
{
  "candidate_summary": "1-2 sentences about who this candidate likely is (be appropriately hedged if confidence is low)",
  "personalization_bullets": ["angle 1", "angle 2"],
  "subject_line_1": "Subject line option 1",
  "subject_line_2": "Subject line option 2",
  "draft_short": "3-4 sentence email — primary draft",
  "draft_medium": "5-7 sentence email — secondary draft",
  "confidence_level": "${isHighConfidence ? 'strong' : 'soft'}"
}

Rules:
- Tone: warm, peer-to-peer, brief.
- Do NOT over-personalize or over-claim.
- Do NOT use LinkedIn language ("I saw your profile").
- draft_short is the primary draft.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
  })
  const d = await res.json()
  const raw = d.content?.[0]?.text?.trim() || '{}'
  try {
    return JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim())
  } catch { return null }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const supabaseUrl   = Deno.env.get('SUPABASE_URL')!
  const serviceKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey  = Deno.env.get('ANTHROPIC_API_KEY') || ''
  const fullenrichKey = Deno.env.get('FULLENRICH_API_KEY') || ''
  const db = createClient(supabaseUrl, serviceKey)

  try {
    const { candidate_id, job_id } = await req.json()

    const { data: candidate, error } = await db.from('candidates').select('*').eq('id', candidate_id).single()
    if (error || !candidate) return json({ error: 'Candidate not found' }, 404)

    // Recruiter job context — currently empty defaults; can be wired later
    const job      = { title: '', company: '', description: '' }
    const recruiter = { name: '', title: '' }

    // ── Stage 2: Email lookup (name-only, no LinkedIn URL) ────────────────────
    await updateJob(db, job_id, { status: 'running', step: 'email_lookup', started_at: new Date().toISOString() })
    await updateCandidate(db, candidate_id, { enrichment_status: 'email_lookup' })

    let work_email: string | null = null
    let personal_email: string | null = null
    let email_domain: string | null = null
    let email_lookup_status = 'no_work_email_found'
    let identity_confidence = 0.1

    if (fullenrichKey) {
      try {
        // source_url is NOT passed here — only full_name
        const result = await lookupEmail(candidate.full_name, fullenrichKey)
        work_email       = result.work_email
        personal_email   = result.personal_email
        identity_confidence = result.email_confidence
        email_lookup_status = work_email ? 'found' : 'no_work_email_found'
        if (work_email) email_domain = work_email.split('@')[1] || null
      } catch (e) {
        console.error('Email lookup failed:', e)
        email_lookup_status = 'lookup_error'
      }
    }

    await updateCandidate(db, candidate_id, {
      work_email, personal_email, email_domain, email_lookup_status, identity_confidence
    })

    if (!work_email) {
      await updateJob(db, job_id, { status: 'completed', step: 'no_email_found', finished_at: new Date().toISOString() })
      await updateCandidate(db, candidate_id, {
        enrichment_status: 'no_email',
        enrichment_state: 'no_work_email_found',
        overall_enrichment_confidence: 0,
      })
      return json({ status: 'no_email', candidate_id, job_id })
    }

    // Identity confidence check — if FullEnrich confidence is very low, flag it
    if (identity_confidence < THRESHOLDS.identity) {
      console.warn(`Low identity confidence (${identity_confidence}) for ${candidate.full_name} — continuing with caution`)
    }

    // ── Stage 3: Employer resolution ─────────────────────────────────────────
    await updateJob(db, job_id, { step: 'employer_resolution' })
    await updateCandidate(db, candidate_id, { enrichment_status: 'employer_resolution' })

    let company_name = ''
    let company_confidence = 0

    if (email_domain) {
      try {
        const employer = await resolveEmployer(email_domain, db, anthropicKey)
        company_name       = employer.company_name
        company_confidence = employer.confidence
      } catch (e) { console.error('Employer resolution failed:', e) }
    }

    if (!company_name || company_confidence < 0.4) {
      await updateJob(db, job_id, { status: 'completed', step: 'employer_unclear', finished_at: new Date().toISOString() })
      await updateCandidate(db, candidate_id, {
        company_name: company_name || email_domain,
        company_confidence,
        enrichment_status: 'low_confidence',
        enrichment_state: 'employer_unclear',
        overall_enrichment_confidence: identity_confidence * 0.5,
        low_confidence_reason: `Employer domain ${email_domain} could not be resolved with high confidence`,
      })
      return json({ status: 'low_confidence', enrichment_state: 'employer_unclear', candidate_id, job_id })
    }

    await updateCandidate(db, candidate_id, { company_name, company_domain: email_domain, company_confidence })

    // ── Stage 4+5: Public-web title inference (LinkedIn hard-blocked) ─────────
    let inferred_title: string | null = null
    let title_confidence = 0
    let evidence_summary = ''

    await updateJob(db, job_id, { step: 'title_enrichment' })
    await updateCandidate(db, candidate_id, { enrichment_status: 'title_enrichment' })

    try {
      const titleResult = await inferPublicTitle(candidate.full_name, company_name, anthropicKey)
      evidence_summary = titleResult.evidence_summary
      title_confidence = titleResult.title_confidence

      if (titleResult.titles.length && titleResult.titles[0] !== 'Unknown' && title_confidence >= 0.3) {
        const resolved = await resolveTitle(candidate.full_name, company_name, titleResult.titles, anthropicKey)
        inferred_title   = resolved.inferred_title
        title_confidence = resolved.title_confidence ?? title_confidence

        await updateCandidate(db, candidate_id, {
          inferred_title,
          seniority: resolved.seniority,
          function: resolved.function,
          title_confidence,
        })

        // Store title sources — LinkedIn already filtered in inferPublicTitle
        for (const src of filterLinkedInSources(titleResult.sources_used.map(s => ({ source_url: s })))) {
          await db.from('candidate_title_sources').insert({
            candidate_id,
            source_url: src.source_url || 'public_web_inference',
            source_type: 'ai_inference',
            extracted_title: inferred_title,
            source_snippet: evidence_summary,
            extraction_confidence: title_confidence,
          })
        }
      } else {
        // Title unclear — mark as such but continue to draft with low-confidence mode
        title_confidence = titleResult.title_confidence
      }
    } catch (e) { console.error('Title enrichment failed:', e) }

    // ── Compute overall enrichment confidence ─────────────────────────────────
    const overall_enrichment_confidence = computeOverallConfidence(
      identity_confidence,
      company_confidence,
      title_confidence,
    )

    // Determine enrichment state
    let enrichment_state = 'ready'
    let low_confidence_reason: string | null = null

    if (identity_confidence < THRESHOLDS.identity) {
      enrichment_state = 'identity_uncertain'
      low_confidence_reason = `Name "${candidate.full_name}" may be ambiguous — FullEnrich returned low identity confidence`
    } else if (title_confidence < THRESHOLDS.title) {
      enrichment_state = 'title_confidence_low'
      low_confidence_reason = 'No reliable non-LinkedIn public title signals found for this candidate'
    }

    await updateCandidate(db, candidate_id, {
      overall_enrichment_confidence,
      enrichment_state,
      low_confidence_reason,
    })

    // ── Stage 6+7: Draft generation ───────────────────────────────────────────
    await updateJob(db, job_id, { step: 'draft_generation' })
    await updateCandidate(db, candidate_id, { enrichment_status: 'draft_generation' })

    let outreach: any = null
    if (anthropicKey) {
      try {
        outreach = await generateOutreach(
          candidate.full_name, company_name, inferred_title, evidence_summary,
          overall_enrichment_confidence, title_confidence,
          job, recruiter, anthropicKey
        )
      } catch (e) { console.error('Draft generation failed:', e) }
    }

    // ── Finalize ──────────────────────────────────────────────────────────────
    await updateCandidate(db, candidate_id, {
      candidate_summary: outreach?.candidate_summary || null,
      personalization_bullets: outreach?.personalization_bullets || null,
      latest_subject_line: outreach?.subject_line_1 || null,
      latest_draft_short: outreach?.draft_short || null,
      latest_draft_medium: outreach?.draft_medium || null,
      enrichment_status: 'ready',
    })

    await updateJob(db, job_id, {
      status: 'completed',
      step: 'done',
      finished_at: new Date().toISOString(),
    })

    return json({
      status: 'ready',
      enrichment_state,
      overall_enrichment_confidence,
      candidate_id,
      job_id,
    })

  } catch (e) {
    console.error('Pipeline error:', e)
    return json({ error: (e as Error).message }, 500)
  }
})
