// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCredits } from './core/credits.js'
import { createCheckout, bootstrapCandidate, pollJob, getOutreachPackage, extractJob } from './core/api.js'

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)
function showStatus(el, msg, type = 'info') { el.textContent = msg; el.className = `status ${type} show` }
function hideStatus(el) { el.textContent = ''; el.className = 'status' }
function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)) }
function setStorage(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)) }
function show(id) { $(id).style.display = 'block' }
function hide(id) { $(id).style.display = 'none'  }

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(pref) {
  const dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.classList.toggle('dark', dark)
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === (pref || 'system')))
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
      tab.classList.add('active')
      $(`tab-${tab.dataset.tab}`)?.classList.add('active')
    })
  })
}
const switchTab = name => document.querySelector(`.tab[data-tab="${name}"]`)?.click()

// ── Login ─────────────────────────────────────────────────────────────────────
function showLoginScreen() {
  getStorage(['pref_theme']).then(d => applyTheme(d.pref_theme || 'system'))
  $('login-screen').style.display = 'block'
  $('main-app').style.display = 'none'
  const statusEl = $('login-status')
  $('btn-send-magic-link').addEventListener('click', async () => {
    const email = $('login-email').value.trim()
    if (!email) { showStatus(statusEl, 'Please enter your email.', 'error'); return }
    showStatus(statusEl, 'Sending magic link…', 'info')
    const { error } = await sendMagicLink(email)
    error ? showStatus(statusEl, `Error: ${error.message}`, 'error')
           : showStatus(statusEl, 'Check your email for the magic link!', 'success')
  })
  $('btn-google-signin').addEventListener('click', () => signInWithGoogle())
}

// ── Main app ──────────────────────────────────────────────────────────────────
async function showMainApp(user) {
  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')
  $('login-screen').style.display = 'none'
  $('main-app').style.display = 'block'
  setupTabs()
  await loadCreditsUI()
  $('credit-pill').addEventListener('click', () => createCheckout())

  // Read candidate name from active LinkedIn tab (minimal capture)
  const capture = await captureFromLinkedIn()
  await setupOutreachTab(capture)
  setupJobTab()
  await setupSettingsTab(user)
}

// ── Capture from LinkedIn (name only) ─────────────────────────────────────────
async function captureFromLinkedIn() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''
  const isLinkedIn = url.includes('linkedin.com/in/') || url.includes('linkedin.com/talent/') || url.includes('linkedin.com/recruiter/')
  if (!isLinkedIn) return null
  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: 'scrape' })
    if (!data?.full_name) return null
    return { ...data, tab_url: url }
  } catch { return null }
}

// ── Credits ───────────────────────────────────────────────────────────────────
async function loadCreditsUI() {
  const pill = $('credit-pill')
  try {
    const credits = await getCredits()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max  = CONFIG.tiers[tier]?.lookups ?? 10
    const left = max - used
    if (left <= 0)      { pill.textContent = '0 lookups · Upgrade'; pill.className = 'credit-pill critical' }
    else if (left <= 2) { pill.textContent = `${left} left · Upgrade`; pill.className = 'credit-pill critical' }
    else if (left <= 5) { pill.textContent = `${left} lookups left`; pill.className = 'credit-pill low' }
    else                { pill.textContent = `${left} lookups left`; pill.className = 'credit-pill' }
  } catch { pill.textContent = '— lookups'; pill.className = 'credit-pill' }
}

// ── Progress steps ─────────────────────────────────────────────────────────────
const STEPS = {
  email_lookup:        { dot: 'dot-email',    lbl: 'lbl-email',    text: 'Finding work email…' },
  employer_resolution: { dot: 'dot-employer', lbl: 'lbl-employer', text: 'Confirming employer from email domain…' },
  title_enrichment:    { dot: 'dot-title',    lbl: 'lbl-title',    text: 'Checking public role signals…' },
  draft_generation:    { dot: 'dot-draft',    lbl: 'lbl-draft',    text: 'Writing outreach draft…' },
}
const STEP_ORDER = ['email_lookup','employer_resolution','title_enrichment','draft_generation']

function updateProgressUI(currentStep) {
  let passedCurrent = false
  for (const key of STEP_ORDER) {
    const s = STEPS[key]
    if (!s) continue
    const dot = $(s.dot), lbl = $(s.lbl)
    if (!dot || !lbl) continue
    if (key === currentStep) {
      dot.className = 'progress-dot active'
      lbl.textContent = s.text
      lbl.className = 'progress-label active'
      passedCurrent = true
    } else if (!passedCurrent) {
      dot.className = 'progress-dot done'
      lbl.className = 'progress-label done'
    } else {
      dot.className = 'progress-dot'
      lbl.className = 'progress-label'
    }
  }
}

// ── Outreach tab ──────────────────────────────────────────────────────────────
let _candidate = null   // capture payload
let _package   = null   // enriched outreach package
let _pollTimer = null

async function setupOutreachTab(capture) {
  _candidate = capture

  // Determine if on LinkedIn
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''
  const isLinkedIn = url.includes('linkedin.com/in/') || url.includes('linkedin.com/talent/') || url.includes('linkedin.com/recruiter/')

  if (!isLinkedIn || !capture?.full_name) {
    show('state-not-linkedin')
    hide('state-main')
    return
  }

  hide('state-not-linkedin')
  show('state-main')

  // Identity card
  $('identity-name').textContent = capture.full_name
  $('identity-sub').textContent = capture.source_surface === 'linkedin_recruiter' ? 'LinkedIn Recruiter' : 'LinkedIn'
  if (capture.source_url) {
    const link = $('identity-url-link')
    link.href = capture.source_url
    link.textContent = capture.source_url.replace('https://www.','').replace('https://','').replace(/\?.*/,'')
    show('identity-url')
  }

  // Job pill
  const jobData = await getStorage(['job_title', 'job_company'])
  if (jobData.job_title) {
    $('job-pill-content').innerHTML = `
      <div class="job-pill-title">${jobData.job_title}</div>
      ${jobData.job_company ? `<div class="job-pill-company">${jobData.job_company}</div>` : ''}
    `
  }
  $('btn-edit-job').addEventListener('click', () => switchTab('job'))

  // Check for existing cached result
  const cacheKey = `outreach_${capture.source_url || capture.full_name}`
  const cached = await getStorage([cacheKey])
  if (cached[cacheKey]?.package) {
    _package = cached[cacheKey].package
    showReadyState(_package)
    return
  }

  // Show initial state
  hideAllStates()
  show('state-initial')

  // Wire up main CTA
  $('btn-prepare-outreach').addEventListener('click', () => startEnrichment(capture))

  // Retry buttons
  $('btn-retry-lookup')?.addEventListener('click', () => startEnrichment(capture))
  $('btn-retry-error')?.addEventListener('click', () => {
    // Hide sign-out button on retry
    const signOutBtn = document.getElementById('btn-error-signout')
    if (signOutBtn) signOutBtn.style.display = 'none'
    startEnrichment(capture)
  })
  // Auth failure — sign out option
  document.getElementById('btn-error-signout')?.addEventListener('click', async () => {
    const { signOut } = await import('./core/auth.js')
    await signOut()
    showLoginScreen()
  })

  // Refresh (bypass cache)
  $('btn-refresh')?.addEventListener('click', async () => {
    const cKey = `outreach_${capture.source_url || capture.full_name}`
    await setStorage({ [cKey]: null })
    _package = null
    hideAllStates()
    show('state-initial')
  })
}

function hideAllStates() {
  for (const s of ['state-initial','state-running','state-ready','state-low-confidence','state-no-email','state-error']) hide(s)
}

async function startEnrichment(capture) {
  hideAllStates()
  show('state-running')
  updateProgressUI('email_lookup')

  // Get recruiter prefs for job context
  const prefs = await getStorage(['job_title','job_company','job_description','pref_name','pref_title'])

  try {
    // Bootstrap: send name to backend, get job token
    const bootstrap = await bootstrapCandidate({
      full_name: capture.full_name,
      source_surface: capture.source_surface,
      source_url: capture.source_url || null,
      session_id: crypto.randomUUID(),
    })

    if (bootstrap.status === 'ready' && bootstrap.cached) {
      // Already enriched — fetch package immediately
      const pkg = await getOutreachPackage(bootstrap.candidate_id)
      if (pkg) {
        _package = pkg
        await cacheAndShowPackage(capture, pkg)
        return
      }
    }

    if (!bootstrap.job_id) throw new Error('No job token returned from bootstrap.')

    // Poll for completion
    await pollForCompletion(bootstrap.job_id, bootstrap.candidate_id, capture)

  } catch (e) {
    hideAllStates()
    show('state-error')

    // Parse structured error messages — never render raw JSON to the user
    let msg = e.message || 'Something went wrong.'
    try {
      // If the message is itself a JSON string (from raw API error), parse it
      const parsed = JSON.parse(msg)
      msg = parsed.message || parsed.error || parsed.msg || msg
    } catch {}

    // Map to friendly messages
    if (msg.toLowerCase().includes('invalid jwt') || msg.toLowerCase().includes('jwt expired') ||
        msg.toLowerCase().includes('session expired') || e.message?.includes('401')) {
      msg = 'Session expired — click here to sign out and sign back in.'
      $('error-message').textContent = msg
      // Show sign-out option in error state
      const signOutBtn = document.getElementById('btn-error-signout')
      if (signOutBtn) signOutBtn.style.display = 'block'
    } else if (msg.includes('402') || msg.toLowerCase().includes('lookup limit') || msg.toLowerCase().includes('credit limit')) {
      msg = 'Lookup limit reached. Upgrade your plan to continue.'
      $('error-message').textContent = msg
    } else if (msg.toLowerCase().includes('not signed in')) {
      msg = 'Please sign in to use OutreachAI.'
      $('error-message').textContent = msg
    } else {
      $('error-message').textContent = msg
    }
  }

  await loadCreditsUI()
}

async function pollForCompletion(job_id, candidate_id, capture) {
  const maxAttempts = 60  // 2 minutes at 2s intervals
  let attempts = 0

  return new Promise((resolve, reject) => {
    _pollTimer = setInterval(async () => {
      attempts++
      if (attempts > maxAttempts) {
        clearInterval(_pollTimer)
        reject(new Error('Enrichment timed out. Try refreshing.'))
        return
      }

      try {
        const job = await pollJob(job_id)
        if (!job) return

        // Update progress UI based on job step
        if (job.step && STEPS[job.step]) updateProgressUI(job.step)
        else if (job.step === 'done') updateProgressUI('draft_generation')

        if (job.status === 'completed' && job.step === 'done') {
          clearInterval(_pollTimer)
          const pkg = await getOutreachPackage(candidate_id)
          if (pkg && pkg.enrichment_status === 'ready') {
            _package = pkg
            await cacheAndShowPackage(capture, pkg)
            resolve()
          } else {
            reject(new Error('Package not ready after completion.'))
          }
        } else if (job.status === 'completed' && job.step === 'no_email_found') {
          clearInterval(_pollTimer)
          hideAllStates()
          show('state-no-email')
          resolve()
        } else if (job.status === 'completed' && job.step === 'employer_unclear') {
          clearInterval(_pollTimer)
          const pkg = await getOutreachPackage(candidate_id)
          showLowConfidenceState(pkg, 'employer_unclear')
          resolve()
        } else if (job.status === 'failed') {
          clearInterval(_pollTimer)
          reject(new Error(job.error_message || 'Enrichment failed.'))
        }
      } catch (e) {
        console.error('Poll error:', e)
      }
    }, 2000)
  })
}

async function cacheAndShowPackage(capture, pkg) {
  const cacheKey = `outreach_${capture.source_url || capture.full_name}`
  await setStorage({ [cacheKey]: { package: pkg, timestamp: Date.now() } })

  // Route to the appropriate UI state based on enrichment_state
  const state = pkg?.enrichment_state
  if (state === 'identity_uncertain' || state === 'title_confidence_low') {
    showLowConfidenceState(pkg, state)
  } else {
    showReadyState(pkg)
  }
}

function showReadyState(pkg, isLowConfidence = false) {
  hideAllStates()
  show('state-ready')

  // Low-confidence banner (if applicable)
  const existingBanner = document.getElementById('ready-confidence-banner')
  if (existingBanner) existingBanner.remove()
  if (isLowConfidence && pkg?.enrichment_state && pkg.enrichment_state !== 'ready') {
    const banner = document.createElement('div')
    banner.id = 'ready-confidence-banner'
    banner.className = 'confidence-banner'
    banner.style.marginBottom = '8px'
    const conf = Math.round((pkg.overall_enrichment_confidence ?? 0) * 100)
    banner.innerHTML = `<div class="confidence-banner-icon">⚠️</div>
      <div class="confidence-banner-text">
        <div class="confidence-banner-title">Low confidence draft</div>
        <div>Enrichment confidence: ${conf}%. This draft uses limited signals — review before sending.</div>
      </div>`
    document.getElementById('state-ready')?.prepend(banner)
  }

  // Email
  $('res-email').textContent = pkg.work_email || '—'

  // Title
  if (pkg.inferred_title) {
    $('res-title').textContent = pkg.inferred_title
    $('res-title-row').style.display = 'block'
  }

  // Company
  if (pkg.company_name) {
    $('res-company').textContent = pkg.company_name
    $('res-company-row').style.display = 'block'
  }

  // Personalization bullets
  const bullets = pkg.personalization_bullets
  if (bullets?.length) {
    $('res-bullets').innerHTML = bullets.map(b => `<li>${b}</li>`).join('')
    $('res-bullets-row').style.display = 'block'
  }

  // Draft
  const draft = pkg.latest_draft_short || ''
  $('email-draft').value = draft
  if (pkg.latest_subject_line) {
    $('draft-subject-line').textContent = pkg.latest_subject_line
    $('email-draft').dataset.subject = pkg.latest_subject_line
  }

  // Compose helpers
  function composeData(useAlt = false) {
    const body = useAlt ? (pkg.latest_draft_medium || draft) : $('email-draft').value.trim()
    const to = pkg.work_email || ''
    const subject = $('email-draft').dataset?.subject || `Opportunity for ${pkg.full_name?.split(' ')[0] || 'you'}`
    return { body, to, subject }
  }

  $('btn-open-outlook').onclick = () => {
    const { body, to, subject } = composeData()
    chrome.tabs.create({ url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
  }
  $('btn-open-gmail').onclick = () => {
    const { body, to, subject } = composeData()
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
  }
  $('btn-copy-draft').onclick = () => {
    navigator.clipboard.writeText($('email-draft').value.trim()).then(() => {
      const btn = $('btn-copy-draft')
      btn.textContent = '✓ Copied'
      setTimeout(() => { btn.textContent = '📋 Copy draft' }, 2000)
    })
  }
  $('btn-alt-draft').onclick = () => {
    const alt = pkg.latest_draft_medium || ''
    if (alt) {
      $('email-draft').value = alt
      $('btn-alt-draft').textContent = 'Short draft'
      $('btn-alt-draft').onclick = () => {
        $('email-draft').value = pkg.latest_draft_short || ''
        $('btn-alt-draft').textContent = 'Medium draft'
      }
    }
  }
}

// ── Low-confidence state ─────────────────────────────────────────────────────
function showLowConfidenceState(pkg, enrichment_state) {
  hideAllStates()
  show('state-low-confidence')

  const conf = pkg?.overall_enrichment_confidence ?? 0
  const pct = Math.round(conf * 100)
  const bar = document.getElementById('lc-bar')
  const pctEl = document.getElementById('lc-pct')
  if (bar) {
    bar.style.width = `${pct}%`
    bar.className = `confidence-fill ${pct >= 60 ? 'high' : pct >= 35 ? 'mid' : 'low'}`
  }
  if (pctEl) pctEl.textContent = `${pct}%`

  // State-specific messaging
  const titles = {
    employer_unclear: 'Employer unclear',
    identity_uncertain: 'Identity uncertain',
    title_confidence_low: 'Role signals weak',
  }
  const reasons = {
    employer_unclear: "We found a work email but couldn't confirm the employer from the domain. The draft may be generic.",
    identity_uncertain: "This name may be common — we can't confirm the email matches this specific person with high confidence.",
    title_confidence_low: "We found email and employer, but no reliable non-LinkedIn signals for this person's role. Draft will be personalized by name and company only.",
  }
  const titleEl = document.getElementById('lc-title')
  const reasonEl = document.getElementById('lc-reason')
  if (titleEl) titleEl.textContent = titles[enrichment_state] || 'Low enrichment confidence'
  if (reasonEl) reasonEl.textContent = pkg?.low_confidence_reason || reasons[enrichment_state] || 'Enrichment confidence is below threshold.'

  // "Open partial draft anyway" — show ready state with confidence banner
  document.getElementById('btn-open-partial-draft')?.addEventListener('click', () => {
    if (pkg) {
      _package = pkg
      showReadyState(pkg, true /* isLowConfidence */)
    }
  })
  document.getElementById('btn-retry-lc')?.addEventListener('click', () => {
    if (_candidate) startEnrichment(_candidate)
  })
}

// ── Job tab ───────────────────────────────────────────────────────────────────
function setupJobTab() {
  getStorage(['job_title','job_company','job_description','job_url']).then(d => {
    if (d.job_title)       $('job-title').value       = d.job_title
    if (d.job_company)     $('job-company').value     = d.job_company
    if (d.job_description) $('job-description').value = d.job_description
    if (d.job_url)         $('job-url').value         = d.job_url
  })

  $('btn-extract-job').addEventListener('click', async () => {
    const url = $('job-url').value.trim()
    const statusEl = $('extract-status')
    if (!url || !url.startsWith('http')) { showStatus(statusEl, 'Enter a valid job posting URL.', 'error'); return }
    const btn = $('btn-extract-job')
    btn.disabled = true
    showStatus(statusEl, 'Extracting job details…', 'info')
    try {
      const jobTab = await chrome.tabs.create({ url, active: false })
      await new Promise(resolve => {
        const listener = (tabId, info) => { if (tabId === jobTab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve() } }
        chrome.tabs.onUpdated.addListener(listener)
        setTimeout(resolve, 15000)
      })
      await new Promise(r => setTimeout(r, 1500))
      let pageText = ''
      try { const res = await chrome.scripting.executeScript({ target: { tabId: jobTab.id }, func: () => document.body?.innerText ?? '' }); pageText = res?.[0]?.result ?? '' } catch {}
      chrome.tabs.remove(jobTab.id).catch(() => {})
      if (!pageText) { showStatus(statusEl, 'Could not read that page.', 'error'); btn.disabled = false; return }
      const jobData = await extractJob(pageText.slice(0, 12000))
      if (jobData?.title)       $('job-title').value       = jobData.title
      if (jobData?.company)     $('job-company').value     = jobData.company
      if (jobData?.description) $('job-description').value = jobData.description
      showStatus(statusEl, 'Job details extracted!', 'success')
    } catch (e) { showStatus(statusEl, `Extraction failed: ${e.message}`, 'error') }
    btn.disabled = false
  })

  $('btn-save-job').addEventListener('click', async () => {
    const statusEl = $('job-status')
    const title = $('job-title').value.trim()
    if (!title) { showStatus(statusEl, 'Add a role title first.', 'error'); return }
    await setStorage({ job_title: title, job_company: $('job-company').value.trim(), job_description: $('job-description').value.trim(), job_url: $('job-url').value.trim() })
    showStatus(statusEl, 'Job saved!', 'success')
    setTimeout(() => hideStatus(statusEl), 2000)
  })
}

// ── Settings tab ──────────────────────────────────────────────────────────────
async function setupSettingsTab(user) {
  if (user?.email) $('settings-email').textContent = user.email
  try {
    const credits = await getCredits()
    const tier = credits?.tier ?? 'free'
    const badge = $('settings-plan-badge')
    badge.textContent = CONFIG.tiers[tier]?.label ?? 'Free'
    badge.className = `plan-badge${tier === 'free' ? ' free' : ''}`
    $('settings-lookups').textContent = `${credits?.lookups_used ?? 0} / ${CONFIG.tiers[tier]?.lookups ?? 10}`
    const aiEl = $('settings-ai-runs')
    if (aiEl) aiEl.textContent = `${credits?.ai_runs_used ?? 0} / ${CONFIG.tiers[tier]?.ai_runs ?? 20}`
  } catch {}
  $('btn-upgrade').addEventListener('click', () => createCheckout())
  $('btn-sign-out').addEventListener('click', async () => { await signOut(); showLoginScreen() })

  // Theme
  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => { await setStorage({ pref_theme: btn.dataset.theme }); applyTheme(btn.dataset.theme) })
  })

  // Recruiter identity
  const d = await getStorage(['pref_name','pref_title'])
  if (d.pref_name)  $('pref-name').value  = d.pref_name
  if (d.pref_title) $('pref-title').value = d.pref_title
  $('btn-save-prefs').addEventListener('click', async () => {
    await setStorage({ pref_name: $('pref-name').value.trim(), pref_title: $('pref-title').value.trim() })
    showStatus($('prefs-status'), 'Saved!', 'success')
    setTimeout(() => hideStatus($('prefs-status')), 2000)
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) { showLoginScreen(); return }
  await showMainApp(await getUser())
}
init()
