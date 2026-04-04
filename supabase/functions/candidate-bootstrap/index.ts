import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim()
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors, 'Content-Type': 'application/json' }
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const db = createClient(supabaseUrl, serviceKey)

    // Auth: get user from JWT
    const authHeader = req.headers.get('Authorization') || ''
    const anonKey    = Deno.env.get('SUPABASE_ANON_KEY')!
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    })
    const { data: { user }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json()
    const { full_name, source_surface, source_url, session_id } = body

    if (!full_name?.trim()) return json({ error: 'full_name is required' }, 400)

    const normalized_full_name = normalizeName(full_name)
    const capture_timestamp    = new Date().toISOString()

    // Check for existing fresh candidate record (within 30 days)
    const freshnessCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await db
      .from('candidates')
      .select('id, enrichment_status, work_email, latest_draft_short, latest_draft_medium, latest_subject_line, inferred_title, company_name, candidate_summary, personalization_bullets')
      .eq('user_id', user.id)
      .eq('normalized_full_name', normalized_full_name)
      .gte('updated_at', freshnessCutoff)
      .order('updated_at', { ascending: false })
      .limit(1)

    let candidate_id: string

    if (existing && existing.length > 0) {
      candidate_id = existing[0].id
      // If already enriched, check for existing pending job
      if (existing[0].enrichment_status === 'ready') {
        // Find or create job token to return cached result
        const { data: job } = await db
          .from('workflow_jobs')
          .select('id, status')
          .eq('candidate_id', candidate_id)
          .order('created_at', { ascending: false })
          .limit(1)

        return json({
          candidate_id,
          job_id: job?.[0]?.id,
          status: 'ready',
          cached: true,
        })
      }
      // Update source info
      await db.from('candidates').update({ source_surface, source_url, updated_at: capture_timestamp })
        .eq('id', candidate_id)
    } else {
      // Create new candidate record
      const { data: created, error: createErr } = await db
        .from('candidates')
        .insert({
          user_id: user.id,
          full_name: full_name.trim(),
          normalized_full_name,
          source_surface: source_surface || 'linkedin_profile',
          source_url: source_url || null,
          enrichment_status: 'pending',
        })
        .select('id')
        .single()

      if (createErr || !created) return json({ error: 'Failed to create candidate record' }, 500)
      candidate_id = created.id
    }

    // Create workflow job
    const { data: job, error: jobErr } = await db
      .from('workflow_jobs')
      .insert({
        candidate_id,
        user_id: user.id,
        job_type: 'full_enrichment',
        status: 'pending_email_lookup',
        step: 'queued',
      })
      .select('id')
      .single()

    if (jobErr || !job) return json({ error: 'Failed to create workflow job' }, 500)

    // Kick off the enrichment pipeline asynchronously (fire and forget)
    const enrichUrl = `${supabaseUrl}/functions/v1/enrichment-pipeline`
    fetch(enrichUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': anonKey,
      },
      body: JSON.stringify({ candidate_id, job_id: job.id, user_id: user.id }),
    }).catch(console.error) // fire and forget

    return json({
      candidate_id,
      job_id: job.id,
      status: 'pending_email_lookup',
    })

  } catch (e) {
    console.error('bootstrap error:', e)
    return json({ error: (e as Error).message }, 500)
  }
})
