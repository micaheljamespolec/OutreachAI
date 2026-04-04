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

// ── Stage 2: FullEnrich email lookup ─────────────────────────────────────────
async function lookupEmail(full_name: string, source_url: string | null, fullenrichKey: string) {
  const nameParts = full_name.trim().split(/\s+/)
  const first_name = nameParts[0] || ''
  const last_name = nameParts.slice(1).join(' ') || ''

  // Extract LinkedIn URL if available
  const linkedin_url = source_url?.includes('linkedin.com') ? source_url : undefined

  const payload: Record<string, string> = { first_name, last_name }
  if (linkedin_url) payload.linkedin_url = linkedin_url

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
  return {
    work_email: data.work_email || data.professional_email || null,
    personal_email: data.personal_email || null,
    confidence: data.confidence || null,
    raw: data,
  }
}

// ── Stage 3: Employer resolution from email domain ────────────────────────────
async function resolveEmployer(domain: string, db: any, anthropicKey: string) {
  // Check company_domains cache first
  const { data: cached } = await db.from('company_domains').select('canonical_company_name, confidence').eq('domain', domain).single()
  if (cached) return { company_name: cached.canonical_company_name, confidence: cached.confidence, from_cache: true }

  // Well-known domains shortcut
  const knownDomains: Record<string, string> = {
    'google.com': 'Google', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple',
    'amazon.com': 'Amazon', 'meta.com': 'Meta', 'salesforce.com': 'Salesforce',
    'bms.com': 'Bristol Myers Squibb', 'pfizer.com': 'Pfizer', 'jnj.com': 'Johnson & Johnson',
    'ibm.com': 'IBM', 'oracle.com': 'Oracle', 'sap.com': 'SAP', 'adobe.com': 'Adobe',
    'goodparty.org': 'Good Party',
  }
  if (knownDomains[domain]) {
    const company_name = knownDomains[domain]
    await db.from('company_domains').upsert({ domain, canonical_company_name: company_name, confidence: 0.99 })
    return { company_name, confidence: 0.99, from_cache: false }
  }

  // AI resolver: infer company from domain
  const prompt = `Given the email domain "${domain}", what is the canonical full company name? Reply with ONLY a JSON object: {"company_name": "...", "confidence": 0.0-1.0}. If unsure, confidence below 0.5.`
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: prompt }] }),
  })
  const data = await res.json()
  const raw = data.content?.[0]?.text?.trim() || '{}'
  const parsed = JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim())
  const company_name = parsed.company_name || domain
  const confidence = parsed.confidence || 0.5

  // Cache result
  await db.from('company_domains').upsert({ domain, canonical_company_name: company_name, confidence })
  return { company_name, confidence, from_cache: false }
}

// ── Stage 4: Public-web title enrichment ──────────────────────────────────────
async function searchPublicTitle(full_name: string, company_name: string, anthropicKey: string): Promise<{ titles: string[], summary: string }> {
  // We use AI to simulate what public-web search would surface about this person
  // In production this would call a real search API (e.g. Serper, Brave Search)
  const prompt = `You are a research assistant. Based on publicly available signals (company bios, conference pages, press releases, directories like RocketReach or ZoomInfo), infer the likely current professional title of "${full_name}" who works at "${company_name}".

Do NOT use LinkedIn data. Return ONLY valid JSON:
{
  "titles": ["most likely title", "alternative title if unclear"],
  "evidence_summary": "Brief description of what public signals suggest about this person's role",
  "confidence": 0.0-1.0
}

If you have no reliable signal, return confidence below 0.4 and titles as ["Unknown"].`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
  })
  const data = await res.json()
  const raw = data.content?.[0]?.text?.trim() || '{}'
  try {
    const parsed = JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim())
    return { titles: parsed.titles || [], summary: parsed.evidence_summary || '' }
  } catch { return { titles: [], summary: '' } }
}

// ── Stage 5: Title normalization ──────────────────────────────────────────────
async function resolveTitle(full_name: string, company_name: string, titles: string[], anthropicKey: string) {
  if (!titles.length || titles[0] === 'Unknown') {
    return { inferred_title: null, seniority: null, function: null, confidence: 0 }
  }

  const prompt = `Normalize the following candidate title signals for "${full_name}" at "${company_name}".

Raw titles: ${JSON.stringify(titles)}

Return ONLY valid JSON:
{
  "inferred_title": "Most specific title supported by signals",
  "seniority": "e.g. Senior Manager, Director, IC, VP",
  "function": "e.g. Talent Acquisition, Software Engineering, Sales",
  "title_confidence": 0.0-1.0
}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
  })
  const data = await res.json()
  const raw = data.content?.[0]?.text?.trim() || '{}'
  try {
    return JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim())
  } catch { return { inferred_title: titles[0], seniority: null, function: null, title_confidence: 0.4 } }
}

// ── Stage 6+7: Context synthesis + draft generation ───────────────────────────
async function generateOutreach(full_name: string, company_name: string, inferred_title: string | null,
  evidence_summary: string, job: { title: string, company: string, description: string },
  recruiter: { name: string, title: string }, anthropicKey: string) {

  const candidateContext = [
    `Candidate: ${full_name}`,
    inferred_title ? `Inferred title: ${inferred_title}` : null,
    `Company: ${company_name}`,
    evidence_summary ? `Public signals: ${evidence_summary}` : null,
  ].filter(Boolean).join('\n')

  const jobContext = [
    job.title ? `Role being recruited for: ${job.title}` : null,
    job.company ? `Hiring company: ${job.company}` : null,
    job.description ? `Role highlights: ${job.description}` : null,
  ].filter(Boolean).join('\n')

  const prompt = `You are an expert recruiter writing a short, warm outreach email to a candidate they already sourced via LinkedIn Recruiter. The email should feel personal but brief — suitable for re-engaging a discovered candidate, not cold outreach.

${candidateContext}

${jobContext}

Recruiter: ${recruiter.name || 'the recruiter'}${recruiter.title ? `, ${recruiter.title}` : ''}

Return ONLY valid JSON:
{
  "candidate_summary": "1-2 sentence description of who this candidate likely is",
  "personalization_bullets": ["angle 1", "angle 2", "angle 3"],
  "subject_line_1": "First subject line option",
  "subject_line_2": "Second subject line option",
  "draft_short": "Short 3-4 sentence email",
  "draft_medium": "Medium 5-7 sentence email with slightly more detail"
}

Rules:
- Emails should be warm, professional, and concise.
- Do not over-personalize or over-claim knowledge of the candidate.
- Tone: peer-to-peer, not salesy.
- draft_short is the primary draft.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
  })
  const data = await res.json()
  const raw = data.content?.[0]?.text?.trim() || '{}'
  try {
    return JSON.parse(raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim())
  } catch { return null }
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const supabaseUrl  = Deno.env.get('SUPABASE_URL')!
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') || ''
  const fullenrichKey = Deno.env.get('FULLENRICH_API_KEY') || ''

  const db = createClient(supabaseUrl, serviceKey)

  try {
    const { candidate_id, job_id, user_id } = await req.json()

    // Fetch candidate record
    const { data: candidate, error } = await db.from('candidates').select('*').eq('id', candidate_id).single()
    if (error || !candidate) return json({ error: 'Candidate not found' }, 404)

    // Fetch job context (for draft generation)
    // We store recruiter's active job separately — retrieve from a simple key-value via user metadata or a settings table
    // For now, look up from Supabase credits/settings or pass defaults
    const job = { title: '', company: '', description: '' }
    const recruiter = { name: '', title: '' }

    // ── Stage 2: Email lookup ─────────────────────────────────────────────────
    await updateJob(db, job_id, { status: 'running', step: 'email_lookup', started_at: new Date().toISOString() })
    await updateCandidate(db, candidate_id, { enrichment_status: 'email_lookup' })

    let work_email: string | null = null
    let personal_email: string | null = null
    let email_domain: string | null = null
    let email_lookup_status = 'no_work_email_found'

    if (fullenrichKey) {
      try {
        const result = await lookupEmail(candidate.full_name, candidate.source_url, fullenrichKey)
        work_email = result.work_email
        personal_email = result.personal_email
        email_lookup_status = work_email ? 'found' : 'no_work_email_found'
        if (work_email) email_domain = work_email.split('@')[1] || null
      } catch (e) {
        console.error('Email lookup failed:', e)
        email_lookup_status = 'lookup_error'
      }
    }

    await updateCandidate(db, candidate_id, { work_email, personal_email, email_domain, email_lookup_status })

    if (!work_email) {
      await updateJob(db, job_id, { status: 'completed', step: 'no_email_found', finished_at: new Date().toISOString() })
      await updateCandidate(db, candidate_id, { enrichment_status: 'no_email' })
      return json({ status: 'no_email', candidate_id, job_id })
    }

    // ── Stage 3: Employer resolution ─────────────────────────────────────────
    await updateJob(db, job_id, { step: 'employer_resolution' })
    await updateCandidate(db, candidate_id, { enrichment_status: 'employer_resolution' })

    let company_name = ''
    let company_confidence = 0

    if (email_domain && anthropicKey) {
      try {
        const employer = await resolveEmployer(email_domain, db, anthropicKey)
        company_name = employer.company_name
        company_confidence = employer.confidence
      } catch (e) { console.error('Employer resolution failed:', e) }
    }

    await updateCandidate(db, candidate_id, { company_name, company_domain: email_domain, company_confidence })

    // ── Stage 4+5: Title enrichment ───────────────────────────────────────────
    let inferred_title: string | null = null
    let evidence_summary = ''

    if (company_name && anthropicKey) {
      await updateJob(db, job_id, { step: 'title_enrichment' })
      await updateCandidate(db, candidate_id, { enrichment_status: 'title_enrichment' })

      try {
        const { titles, summary } = await searchPublicTitle(candidate.full_name, company_name, anthropicKey)
        evidence_summary = summary

        if (titles.length && titles[0] !== 'Unknown') {
          const resolved = await resolveTitle(candidate.full_name, company_name, titles, anthropicKey)
          inferred_title = resolved.inferred_title
          await updateCandidate(db, candidate_id, {
            inferred_title: resolved.inferred_title,
            seniority: resolved.seniority,
            function: resolved.function,
            title_confidence: resolved.title_confidence,
          })

          // Store title sources
          for (const t of titles) {
            await db.from('candidate_title_sources').insert({
              candidate_id,
              source_url: 'public_web_inference',
              source_type: 'ai_inference',
              extracted_title: t,
              source_snippet: summary,
              extraction_confidence: resolved.title_confidence,
            })
          }
        }
      } catch (e) { console.error('Title enrichment failed:', e) }
    }

    // ── Stage 6+7: Draft generation ───────────────────────────────────────────
    await updateJob(db, job_id, { step: 'draft_generation' })
    await updateCandidate(db, candidate_id, { enrichment_status: 'draft_generation' })

    let outreach: any = null
    if (anthropicKey) {
      try {
        outreach = await generateOutreach(
          candidate.full_name, company_name, inferred_title,
          evidence_summary, job, recruiter, anthropicKey
        )
      } catch (e) { console.error('Draft generation failed:', e) }
    }

    // ── Stage 8: Finalize ─────────────────────────────────────────────────────
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

    return json({ status: 'ready', candidate_id, job_id })

  } catch (e) {
    console.error('Pipeline error:', e)
    return json({ error: (e as Error).message }, 500)
  }
})
