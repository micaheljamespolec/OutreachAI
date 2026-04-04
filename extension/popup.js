// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCredits, deductAiRun } from './core/credits.js'
import { createCheckout, lookupEmail, generateDraft as apiGenerateDraft, extractJob, requirementsMatch } from './core/api.js'

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)
function showStatus(el, msg, type = 'info') { el.textContent = msg; el.className = `status ${type} show` }
function hideStatus(el) { el.textContent = ''; el.className = 'status' }
function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)) }
function setStorage(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)) }

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

  // Scrape the active LinkedIn tab
  const profile = await scrapeProfile()

  await setupOutreachTab(profile)
  setupCandidateTab(profile)
  setupJobTab()
  await setupSettingsTab(user)
}

// ── Scrape ────────────────────────────────────────────────────────────────────
async function scrapeProfile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''
  const isLinkedIn = url.includes('linkedin.com/in/') || url.includes('linkedin.com/talent/') || url.includes('linkedin.com/recruiter/')
  if (!isLinkedIn) return null
  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: 'scrape' })
    return data?.fullName ? data : null
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
    if (left <= 0)      { pill.textContent = '0 lookups · Upgrade';                          pill.className = 'credit-pill critical' }
    else if (left <= 2) { pill.textContent = `${left} lookup${left===1?'':'s'} left · Upgrade`; pill.className = 'credit-pill critical' }
    else if (left <= 5) { pill.textContent = `${left} lookups left`;                           pill.className = 'credit-pill low' }
    else                { pill.textContent = `${left} lookups left`;                           pill.className = 'credit-pill' }
  } catch { pill.textContent = '— lookups'; pill.className = 'credit-pill' }
}

// ── Workflow state ────────────────────────────────────────────────────────────
let _email = null, _hasDraft = false, _linkedInUrl = null, _profile = null

function updateWorkflowUI() {
  // Chips
  $('chip-email').textContent = _email ? '✓ Found' : 'Not found'
  $('chip-email').className   = `status-chip-value${_email ? ' found' : ''}`
  $('chip-draft').textContent = _hasDraft ? '✓ Ready' : 'Not ready'
  $('chip-draft').className   = `status-chip-value${_hasDraft ? ' ready' : ''}`

  // Primary CTA
  $('btn-find-email').style.display    = (!_email) ? 'block' : 'none'
  $('btn-generate-draft').style.display = (_email && !_hasDraft) ? 'block' : 'none'
  $('open-email-row').style.display    = (_hasDraft) ? 'flex' : 'none'

  // Secondary actions — only show when relevant
  const showSecondary = _email || _hasDraft
  $('secondary-actions').style.display = showSecondary ? 'flex' : 'none'
  $('btn-recheck-email').style.display = _email ? 'block' : 'none'
  $('btn-regenerate').style.display    = _hasDraft ? 'block' : 'none'
}

// ── Outreach tab ──────────────────────────────────────────────────────────────
async function setupOutreachTab(profile) {
  _profile = profile
  _linkedInUrl = profile?.linkedinUrl || null

  // Determine if we're on a LinkedIn page
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = activeTab?.url ?? ''
  const isLinkedIn = url.includes('linkedin.com/in/') || url.includes('linkedin.com/talent/') || url.includes('linkedin.com/recruiter/')

  if (!isLinkedIn) {
    $('state-not-linkedin').style.display = 'block'
    $('state-email').style.display = 'none'
    return
  }
  $('state-not-linkedin').style.display = 'none'
  $('state-email').style.display = 'block'

  // ── Candidate header ──────────────────────────────────────────────────────
  if (profile?.fullName) {
    $('sc-name').textContent = profile.fullName
    const meta = [profile.title, profile.company].filter(Boolean).join(' · ')
    $('sc-meta').textContent = meta || ''

    if (profile.linkedinUrl) {
      const link = $('sc-url-link')
      link.href = profile.linkedinUrl
      link.textContent = profile.linkedinUrl.replace('https://www.', '').replace('https://', '').replace(/\?.*/, '')
      $('sc-url').style.display = 'flex'
    }
  } else {
    $('sc-name').innerHTML = '<span class="cand-scanning">Could not read profile</span>'
  }

  // ── Job pill ──────────────────────────────────────────────────────────────
  const jobData = await getStorage(['job_title', 'job_company'])
  if (jobData.job_title) {
    $('job-pill-content').innerHTML = `
      <div class="job-pill-title">${jobData.job_title}</div>
      ${jobData.job_company ? `<div class="job-pill-company">${jobData.job_company}</div>` : ''}
    `
  }
  $('btn-edit-job').addEventListener('click', () => switchTab('job'))

  // ── Cache check ───────────────────────────────────────────────────────────
  if (_linkedInUrl) {
    const cacheKey = `email_cache_${_linkedInUrl}`
    const draftKey = `draft_cache_${_linkedInUrl}`
    const cached   = await getStorage([cacheKey, draftKey])

    if (cached[cacheKey]?.email) {
      setEmailFound(cached[cacheKey].email, 'cached')
    } else {
      // Silent server-side cache check
      try {
        if (profile?.firstName) {
          const r = await lookupEmail(profile.firstName, profile.lastName, _linkedInUrl, profile.company, true)
          if (r.found && r.email) {
            setEmailFound(r.email, 'cached')
            await setStorage({ [cacheKey]: { email: r.email, source: 'cache', timestamp: Date.now() } })
          }
        }
      } catch {}
    }

    if (cached[draftKey]?.draft) {
      setDraftReady(cached[draftKey].draft, cached[draftKey].subject)
    } else if (_email && !_hasDraft) {
      await generateDraft()
    }
  }

  updateWorkflowUI()

  // ── Button wiring ─────────────────────────────────────────────────────────
  $('btn-find-email').addEventListener('click', async () => {
    if (!profile?.firstName) { showStatus($('email-status'), 'No profile loaded.', 'error'); return }
    const btn = $('btn-find-email'), statusEl = $('email-status')
    btn.disabled = true
    showStatus(statusEl, 'Looking up email…', 'info')
    try {
      const r = await lookupEmail(profile.firstName, profile.lastName, _linkedInUrl || '', profile.company)
      if (r.found && r.email) {
        setEmailFound(r.email, r.source)
        if (_linkedInUrl) await setStorage({ [`email_cache_${_linkedInUrl}`]: { email: r.email, source: r.source, timestamp: Date.now() } })
        hideStatus(statusEl)
        await generateDraft()
      } else {
        showStatus(statusEl, 'No email found for this candidate.', 'error')
      }
    } catch (e) {
      const msg = e.message?.includes('402') ? 'Lookup limit reached. Upgrade your plan.'
                : e.message === 'Not signed in' ? 'Please sign in first.'
                : 'Lookup failed. Try again.'
      showStatus(statusEl, msg, 'error')
    }
    btn.disabled = false
    await loadCreditsUI()
  })

  $('btn-generate-draft').addEventListener('click', () => generateDraft())
  $('btn-regenerate').addEventListener('click', () => generateDraft())

  $('btn-recheck-email').addEventListener('click', async () => {
    if (!profile?.firstName) return
    const btn = $('btn-recheck-email'), statusEl = $('email-status')
    btn.disabled = true
    showStatus(statusEl, 'Re-checking email…', 'info')
    try {
      const r = await lookupEmail(profile.firstName, profile.lastName, _linkedInUrl || '', profile.company)
      if (r.found && r.email) {
        setEmailFound(r.email, r.source)
        if (_linkedInUrl) await setStorage({ [`email_cache_${_linkedInUrl}`]: { email: r.email, source: r.source, timestamp: Date.now() } })
        hideStatus(statusEl)
      } else {
        showStatus(statusEl, 'Still no email found.', 'error')
      }
    } catch { showStatus($('email-status'), 'Re-check failed.', 'error') }
    btn.disabled = false
    await loadCreditsUI()
  })

  // Compose helpers
  function composeData() {
    const draft   = $('email-draft').value.trim()
    const to      = _email || ''
    const subject = $('email-draft').dataset?.subject || `Exciting opportunity for ${profile?.firstName || 'you'}`
    return { draft, to, subject }
  }

  $('btn-open-outlook').addEventListener('click', () => {
    const { draft, to, subject } = composeData()
    chrome.tabs.create({ url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}` })
  })

  $('btn-open-gmail').addEventListener('click', () => {
    const { draft, to, subject } = composeData()
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}` })
  })

  // ── Analyze Fit collapsible ───────────────────────────────────────────────
  $('fit-toggle').addEventListener('click', () => {
    const open = $('fit-body').classList.toggle('open')
    $('fit-toggle').classList.toggle('open', open)
  })
  $('btn-run-fit')?.addEventListener('click', () => runAnalyzeFit())
}

function setEmailFound(email, source) {
  _email = email
  $('email-banner').style.display = 'block'
  $('found-email').textContent = email
  $('found-email-confidence').textContent = (source === 'cached' || source === 'cache') ? '✅ Previously found' : '✅ Found'
  updateWorkflowUI()
}

function setDraftReady(draftText, subject) {
  _hasDraft = true
  $('draft-area').style.display = 'block'
  $('email-draft').value = draftText
  if (subject) $('email-draft').dataset.subject = subject
  updateWorkflowUI()
}

async function generateDraft() {
  const statusEl = $('draft-status')
  $('draft-area').style.display = 'block'
  showStatus(statusEl, 'Generating outreach email…', 'info')
  try {
    const storage = await getStorage(['job_title', 'job_company', 'job_description', 'pref_your_name', 'pref_your_title'])
    const profile = _profile || {}
    // Light prompt: basics only, short email
    const result = await apiGenerateDraft(
      { fullName: profile.fullName, firstName: profile.firstName, lastName: profile.lastName,
        title: profile.title, company: profile.company, about: profile.about || '', linkedinUrl: _linkedInUrl || '' },
      { title: storage.job_title || '', company: storage.job_company || '', description: storage.job_description || '' },
      { name: storage.pref_your_name || '', title: storage.pref_your_title || '' }
    )
    if (result.draft) {
      setDraftReady(result.draft, result.subject)
      if (_linkedInUrl) await setStorage({ [`draft_cache_${_linkedInUrl}`]: { draft: result.draft, subject: result.subject || '', timestamp: Date.now() } })
      showStatus(statusEl, 'Draft ready!', 'success')
      setTimeout(() => hideStatus(statusEl), 2500)
    } else {
      showStatus(statusEl, 'No draft returned. Try regenerating.', 'error')
    }
  } catch (e) {
    const msg = e.message?.includes('503') ? 'AI service not configured.'
              : e.message?.includes('429') ? 'AI rate limit hit. Wait and try again.'
              : 'Failed to generate draft.'
    showStatus(statusEl, msg, 'error')
  }
}

// ── Analyze Fit ───────────────────────────────────────────────────────────────
function renderMatchItem(text, evidence) {
  return `<div style="margin-bottom:6px;padding:6px 8px;background:#f9fafb;border-radius:5px;">
    <div style="font-size:12px;font-weight:500;color:#111827;line-height:1.4;">${text}</div>
    ${evidence ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;">${evidence}</div>` : ''}
  </div>`
}

function showMatchPanel(result) {
  if (result.summary) { $('match-summary').textContent = result.summary; $('match-summary').style.display = 'block' }
  for (const [key, listId, wrapperId] of [['strong','match-strong-list','match-strong'],['possible','match-possible-list','match-possible'],['unclear','match-unclear-list','match-unclear']]) {
    const items = result[key] || []
    if (items.length) {
      $(listId).innerHTML = items.map(i => renderMatchItem(i.point, i.evidence)).join('')
      $(wrapperId).style.display = 'block'
    }
  }
}

async function runAnalyzeFit() {
  const storage   = await getStorage(['job_title', 'job_company', 'job_description'])
  const statusEl  = $('match-status')
  if (!_profile?.fullName) { showStatus(statusEl, 'No profile loaded.', 'error'); return }
  if (!storage.job_title)  { showStatus(statusEl, 'No job set — add one in the Job tab first.', 'error'); return }

  const cacheKey = `match_cache_${_linkedInUrl || _profile.fullName}_${storage.job_title}_${storage.job_company || ''}`
  const cached   = await getStorage([cacheKey])
  if (cached[cacheKey]?.result) {
    showMatchPanel(cached[cacheKey].result)
    showStatus(statusEl, '↩ Showing cached result.', 'info')
    return
  }

  const credits = await getCredits()
  if (credits) {
    const tier = credits.tier ?? 'free'
    const aiUsed = credits.ai_runs_used ?? 0
    const aiMax  = CONFIG.tiers[tier]?.ai_runs ?? 20
    if (aiUsed >= aiMax) { showStatus(statusEl, `AI run limit reached (${aiMax}/month). Upgrade to continue.`, 'error'); return }
  }

  $('match-summary').style.display = 'none'
  $('match-strong').style.display = $('match-possible').style.display = $('match-unclear').style.display = 'none'
  showStatus(statusEl, 'Analyzing fit…', 'info')

  try {
    const result = await requirementsMatch(
      { fullName: _profile.fullName, title: _profile.title, company: _profile.company, about: _profile.about || '', linkedinUrl: _linkedInUrl || '' },
      { title: storage.job_title, company: storage.job_company || '', description: storage.job_description || '' }
    )
    if (result.error) throw new Error(result.error)
    await deductAiRun()
    await loadCreditsUI()
    await setStorage({ [cacheKey]: { result, timestamp: Date.now() } })
    hideStatus(statusEl)
    showMatchPanel(result)
  } catch (e) { showStatus(statusEl, `Analysis failed: ${e.message}`, 'error') }
}

// ── Candidate tab ─────────────────────────────────────────────────────────────
function setupCandidateTab(profile) {
  if (!profile?.fullName) {
    $('profile-not-linkedin').style.display = 'block'
    $('profile-data-view').style.display = 'none'
    return
  }
  $('profile-not-linkedin').style.display = 'none'
  $('profile-data-view').style.display = 'block'
  $('prof-name').textContent = profile.fullName || '—'
  $('prof-title').textContent = profile.title || '—'
  $('prof-company').textContent = profile.company || '—'
  const urlEl = $('prof-url')
  if (profile.linkedinUrl) {
    urlEl.innerHTML = `<a href="${profile.linkedinUrl}" target="_blank">${profile.linkedinUrl.replace('https://www.','').replace('https://','')}</a>`
  } else { urlEl.textContent = '—' }
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
      try {
        const res = await chrome.scripting.executeScript({ target: { tabId: jobTab.id }, func: () => document.body?.innerText ?? '' })
        pageText = res?.[0]?.result ?? ''
      } catch {}
      chrome.tabs.remove(jobTab.id).catch(() => {})
      if (!pageText) { showStatus(statusEl, 'Could not read that page. Paste details manually.', 'error'); btn.disabled = false; return }
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
  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => { await setStorage({ pref_theme: btn.dataset.theme }); applyTheme(btn.dataset.theme) })
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) { showLoginScreen(); return }
  await showMainApp(await getUser())
}
init()
