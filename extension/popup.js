// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCredits, deductAiRun } from './core/credits.js'
import { createCheckout, lookupEmail, generateDraft as apiGenerateDraft, extractJob, requirementsMatch } from './core/api.js'

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(el, msg, type = 'info') { el.textContent = msg; el.className = `status ${type} show` }
function hideStatus(el) { el.textContent = ''; el.className = 'status' }
function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)) }
function setStorage(obj) { return new Promise(r => chrome.storage.local.set(obj, r)) }
function $(id) { return document.getElementById(id) }

// ── Theme ─────────────────────────────────────────────────────────────────────
function resolveTheme(pref) {
  if (pref === 'dark') return 'dark'
  if (pref === 'light') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
function applyTheme(pref) {
  document.body.classList.toggle('dark', resolveTheme(pref || 'system') === 'dark')
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
function switchTab(name) { document.querySelector(`.tab[data-tab="${name}"]`)?.click() }

// ── Login ─────────────────────────────────────────────────────────────────────
function showLoginScreen() {
  getStorage(['pref_theme', 'pref_dark_mode']).then(d => applyTheme(d.pref_theme || (d.pref_dark_mode ? 'dark' : 'system')))
  $('login-screen').style.display = 'block'
  $('main-app').style.display = 'none'
  const statusEl = $('login-status')
  $('btn-send-magic-link').addEventListener('click', async () => {
    const email = $('login-email').value.trim()
    if (!email) { showStatus(statusEl, 'Please enter your email.', 'error'); return }
    showStatus(statusEl, 'Sending magic link…', 'info')
    const { error } = await sendMagicLink(email)
    if (error) { showStatus(statusEl, `Error: ${error.message}`, 'error'); return }
    showStatus(statusEl, 'Check your email for the magic link!', 'success')
  })
  $('btn-google-signin').addEventListener('click', () => signInWithGoogle())
}

// ── Main app ──────────────────────────────────────────────────────────────────
async function showMainApp(user) {
  const prefs = await getStorage(['pref_theme', 'pref_dark_mode'])
  applyTheme(prefs.pref_theme || (prefs.pref_dark_mode ? 'dark' : 'system'))
  $('login-screen').style.display = 'none'
  $('main-app').style.display = 'block'
  setupTabs()
  await loadCreditsUI()

  // Credit pill click → pricing/upgrade
  $('credit-pill')?.addEventListener('click', () => createCheckout())

  const profile = await scrapeCurrentProfile()
  await setupEmailTab(profile)
  await setupRequirementsMatch(profile)
  setupProfileTab(profile)
  setupJobTab()
  await setupSettingsTab(user)
}

// ── Credits ───────────────────────────────────────────────────────────────────
async function loadCreditsUI() {
  const pill = $('credit-pill')
  try {
    const credits = await getCredits()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max = CONFIG.tiers[tier]?.lookups ?? 10
    const left = max - used
    // Set copy and state
    if (left <= 0) {
      pill.textContent = '0 lookups · Upgrade'
      pill.className = 'credit-pill critical'
    } else if (left <= 2) {
      pill.textContent = `${left} lookup${left === 1 ? '' : 's'} left · Upgrade`
      pill.className = 'credit-pill critical'
    } else if (left <= 5) {
      pill.textContent = `${left} lookups left`
      pill.className = 'credit-pill low'
    } else {
      pill.textContent = `${left} lookups left`
      pill.className = 'credit-pill'
    }
    return { used, max, left }
  } catch {
    pill.textContent = '— lookups'
    pill.className = 'credit-pill'
    return { used: 0, max: 10, left: 10 }
  }
}

// ── Scrape ────────────────────────────────────────────────────────────────────
async function scrapeCurrentProfile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''
  if (!url.includes('linkedin.com/in/') && !url.includes('linkedin.com/talent/') && !url.includes('linkedin.com/recruiter/')) return null
  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: 'scrape' })
    return data?.fullName ? data : null
  } catch { return null }
}

// ── Email tab — workflow dashboard ────────────────────────────────────────────
// Tracks workflow state
let _emailState = { email: null, emailSource: null, hasDraft: false }

function updateWorkflowUI() {
  const { email, emailSource, hasDraft } = _emailState

  // Status chips
  if (email) {
    $('chip-email').textContent = '✓ Found'
    $('chip-email').className = 'status-chip-value found'
  } else {
    $('chip-email').textContent = 'Not found'
    $('chip-email').className = 'status-chip-value missing'
  }
  if (hasDraft) {
    $('chip-draft').textContent = '✓ Ready'
    $('chip-draft').className = 'status-chip-value ready'
  } else {
    $('chip-draft').textContent = 'Not ready'
    $('chip-draft').className = 'status-chip-value missing'
  }

  // Primary CTA — show exactly one
  $('btn-find-email').style.display = 'none'
  $('btn-generate-draft').style.display = 'none'
  $('btn-open-gmail').style.display = 'none'

  if (!email) {
    $('btn-find-email').style.display = 'block'
  } else if (!hasDraft) {
    $('btn-generate-draft').style.display = 'block'
  } else {
    $('btn-open-gmail').style.display = 'block'
  }

  // Secondary actions
  $('btn-recheck-email').style.display = email ? 'block' : 'none'
  $('btn-regenerate').style.display = hasDraft ? 'block' : 'none'
}

async function setupEmailTab(profile) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''
  const isLinkedIn = url.includes('linkedin.com/in/') || url.includes('linkedin.com/talent/') || url.includes('linkedin.com/recruiter/')

  if (!isLinkedIn) {
    $('state-not-linkedin').style.display = 'block'
    $('state-email').style.display = 'none'
    return
  }
  $('state-not-linkedin').style.display = 'none'
  $('state-email').style.display = 'block'

  // ── Candidate summary ─────────────────────────────────────────────────────
  if (!profile?.fullName) {
    $('email-profile-error').style.display = 'block'
    $('summary-candidate').style.opacity = '0.4'
    $('sc-name').textContent = 'Not found'
    $('sc-meta').textContent = ''
  } else {
    $('sc-name').textContent = profile.fullName
    $('sc-meta').textContent = [profile.title, profile.company].filter(Boolean).join(' · ')
  }

  // ── Job summary ───────────────────────────────────────────────────────────
  const jobData = await getStorage(['job_title', 'job_company'])
  if (jobData.job_title) {
    $('sc-job-title').textContent = jobData.job_title
    $('sc-job-company').textContent = jobData.job_company || ''
    $('summary-job').classList.remove('empty')
  } else {
    $('sc-job-title').textContent = 'No job set'
    $('summary-job').classList.add('empty')
  }

  $('btn-view-profile').addEventListener('click', () => switchTab('profile'))
  $('btn-edit-job').addEventListener('click', () => switchTab('job'))

  // Initialize workflow state
  updateWorkflowUI()

  if (!await isLoggedIn()) {
    $('btn-find-email').textContent = 'Sign in to look up emails'
    $('btn-find-email').disabled = true
    $('btn-find-email').style.display = 'block'
    $('btn-generate-draft').style.display = 'none'
    return
  }

  // ── Check cache ───────────────────────────────────────────────────────────
  if (profile?.linkedinUrl) {
    const cacheKey = `email_cache_${profile.linkedinUrl}`
    const draftKey = `draft_cache_${profile.linkedinUrl}`
    const cached = await getStorage([cacheKey, draftKey])

    if (cached[cacheKey]?.email) {
      setEmailFound(cached[cacheKey].email, 'cached')
    } else {
      // Check server cache silently
      const statusEl = $('email-status')
      try {
        const serverResult = await lookupEmail(profile.firstName, profile.lastName, profile.linkedinUrl, profile.company, true)
        if (serverResult.found && serverResult.email) {
          setEmailFound(serverResult.email, 'cached')
          await setStorage({ [cacheKey]: { email: serverResult.email, source: 'cache', timestamp: Date.now() } })
        }
      } catch {}
      hideStatus(statusEl)
    }

    if (cached[draftKey]?.draft) {
      setDraftReady(cached[draftKey].draft, cached[draftKey].subject)
    } else if (_emailState.email && !_emailState.hasDraft) {
      // Email found but no draft — auto-generate
      await generateDraft(profile)
    }
  }

  // ── Button wiring ─────────────────────────────────────────────────────────
  $('btn-find-email').addEventListener('click', async () => {
    if (!profile?.fullName) return
    const btn = $('btn-find-email')
    const statusEl = $('email-status')
    btn.disabled = true
    showStatus(statusEl, 'Looking up email…', 'info')
    try {
      const result = await lookupEmail(profile.firstName, profile.lastName, profile.linkedinUrl, profile.company)
      if (result.found && result.email) {
        setEmailFound(result.email, result.source)
        const cacheKey = `email_cache_${profile.linkedinUrl}`
        await setStorage({ [cacheKey]: { email: result.email, source: result.source, timestamp: Date.now() } })
        hideStatus(statusEl)
        await generateDraft(profile)
      } else {
        showStatus(statusEl, 'No email found for this profile.', 'error')
      }
    } catch (e) {
      let msg = 'Lookup failed. Try again.'
      if (e.message === 'Not signed in') msg = 'Please sign in first.'
      else if (e.message?.includes('Credit limit') || e.message?.includes('402')) msg = 'Credit limit reached. Upgrade your plan.'
      showStatus(statusEl, msg, 'error')
    }
    btn.disabled = false
    await loadCreditsUI()
  })

  $('btn-generate-draft').addEventListener('click', () => generateDraft(profile))
  $('btn-regenerate').addEventListener('click', () => generateDraft(profile))

  $('btn-recheck-email').addEventListener('click', async () => {
    if (!profile?.fullName) return
    const statusEl = $('email-status')
    $('btn-recheck-email').disabled = true
    showStatus(statusEl, 'Re-checking email…', 'info')
    try {
      const result = await lookupEmail(profile.firstName, profile.lastName, profile.linkedinUrl, profile.company)
      if (result.found && result.email) {
        setEmailFound(result.email, result.source)
        const cacheKey = `email_cache_${profile.linkedinUrl}`
        await setStorage({ [cacheKey]: { email: result.email, source: result.source, timestamp: Date.now() } })
        hideStatus(statusEl)
      } else {
        showStatus(statusEl, 'Still no email found.', 'error')
      }
    } catch (e) {
      showStatus(statusEl, 'Re-check failed. Try again.', 'error')
    }
    $('btn-recheck-email').disabled = false
    await loadCreditsUI()
  })

  $('btn-open-gmail').addEventListener('click', () => {
    const draft = $('email-draft').value.trim()
    const to = _emailState.email || ''
    const subject = encodeURIComponent($('email-draft')?.dataset?.subject || `Exciting opportunity for ${profile?.firstName || 'you'}`)
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${encodeURIComponent(draft)}` })
  })
}

function setEmailFound(email, source) {
  _emailState.email = email
  _emailState.emailSource = source
  $('email-banner').style.display = 'block'
  $('found-email').textContent = email
  $('found-email-confidence').textContent = (source === 'cached' || source === 'cache') ? '✅ Previously found' : '✅ Found via FullEnrich'
  updateWorkflowUI()
}

function setDraftReady(draftText, subject) {
  _emailState.hasDraft = true
  $('draft-area').style.display = 'block'
  $('email-draft').value = draftText
  if (subject) $('email-draft').dataset.subject = subject
  updateWorkflowUI()
}

async function generateDraft(profile) {
  const statusEl = $('draft-status')
  $('draft-area').style.display = 'block'
  showStatus(statusEl, 'Generating personalized email…', 'info')
  try {
    const storage = await getStorage(['job_title', 'job_company', 'job_description', 'pref_your_name', 'pref_your_title'])
    // Include match context if available (panel is visible and has content)
    const matchSummary = $('match-summary')?.textContent?.trim() || ''
    const job = {
      title: storage.job_title || '',
      company: storage.job_company || '',
      description: storage.job_description || '',
      matchContext: matchSummary || undefined,
    }
    const result = await apiGenerateDraft(
      profile,
      job,
      { name: storage.pref_your_name || '', title: storage.pref_your_title || '' }
    )
    if (result.draft) {
      setDraftReady(result.draft, result.subject)
      if (profile?.linkedinUrl) {
        await setStorage({ [`draft_cache_${profile.linkedinUrl}`]: { draft: result.draft, subject: result.subject || '', timestamp: Date.now() } })
      }
      showStatus(statusEl, 'Draft ready!', 'success')
      setTimeout(() => hideStatus(statusEl), 2500)
    } else {
      showStatus(statusEl, 'No draft returned. Try regenerating.', 'error')
    }
  } catch (e) {
    let msg = 'Failed to generate draft.'
    if (e.message?.includes('503') || e.message?.includes('not configured')) msg = 'AI service not configured.'
    else if (e.message?.includes('429') || e.message?.includes('rate limit')) msg = 'AI rate limit hit. Wait and try again.'
    showStatus(statusEl, msg, 'error')
  }
}

// ── Requirements Match ───────────────────────────────────────────────────────
function renderMatchItem(text, evidence) {
  return `<div style="margin-bottom:6px;padding:6px 8px;background:#f9fafb;border-radius:5px;">
    <div style="font-size:12px;font-weight:500;color:#111827;line-height:1.4;">${text}</div>
    ${evidence ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;line-height:1.3;">${evidence}</div>` : ''}
  </div>`
}

function showMatchPanel(result) {
  const panel = $('match-panel')
  panel.style.display = 'block'

  if (result.summary) $('match-summary').textContent = result.summary

  const sections = [
    { key: 'strong', listId: 'match-strong-list', wrapperId: 'match-strong' },
    { key: 'possible', listId: 'match-possible-list', wrapperId: 'match-possible' },
    { key: 'unclear', listId: 'match-unclear-list', wrapperId: 'match-unclear' },
  ]
  for (const { key, listId, wrapperId } of sections) {
    const items = result[key] || []
    if (items.length) {
      $(listId).innerHTML = items.map(i => renderMatchItem(i.point, i.evidence)).join('')
      $(wrapperId).style.display = 'block'
    } else {
      $(wrapperId).style.display = 'none'
    }
  }

  // Update fit chip
  const strongCount = (result.strong || []).length
  const chip = $('chip-match')
  if (strongCount >= 3) { chip.textContent = 'Strong fit'; chip.className = 'status-chip-value found' }
  else if (strongCount >= 1) { chip.textContent = 'Partial fit'; chip.className = 'status-chip-value warn' }
  else { chip.textContent = 'Weak fit'; chip.className = 'status-chip-value missing' }
}

async function setupRequirementsMatch(profile) {
  $('btn-close-match')?.addEventListener('click', () => {
    $('match-panel').style.display = 'none'
  })

  $('btn-check-fit')?.addEventListener('click', async () => {
    if (!profile?.fullName) {
      showStatus($('match-status'), 'No profile loaded — open a LinkedIn profile first.', 'error')
      $('match-panel').style.display = 'block'
      return
    }
    const storage = await getStorage(['job_title', 'job_company', 'job_description'])
    if (!storage.job_title) {
      showStatus($('match-status'), 'No job set — add one in the Job tab first.', 'error')
      $('match-panel').style.display = 'block'
      return
    }

    // ── Cache check: reuse result if same candidate + same job ──────────────
    const cacheKey = `match_cache_${profile.linkedinUrl}_${storage.job_title}_${storage.job_company || ''}`
    const cached = await getStorage([cacheKey])
    if (cached[cacheKey]?.result) {
      $('match-panel').style.display = 'block'
      showMatchPanel(cached[cacheKey].result)
      // Show subtle cached indicator
      const statusEl = $('match-status')
      showStatus(statusEl, '↩ Showing cached result — re-run to refresh.', 'info')
      return
    }

    // ── Check AI run quota ──────────────────────────────────────────────────
    const credits = await getCredits()
    if (credits) {
      const tier = credits.tier ?? 'free'
      const aiUsed = credits.ai_runs_used ?? 0
      const aiMax = CONFIG.tiers[tier]?.ai_runs ?? 20
      if (aiUsed >= aiMax) {
        showStatus($('match-status'), `AI run limit reached (${aiMax}/month). Upgrade to analyze more candidates.`, 'error')
        $('match-panel').style.display = 'block'
        return
      }
    }

    const statusEl = $('match-status')
    $('match-panel').style.display = 'block'
    $('match-summary').textContent = ''
    $('match-strong').style.display = 'none'
    $('match-possible').style.display = 'none'
    $('match-unclear').style.display = 'none'
    showStatus(statusEl, 'Analyzing fit against job requirements…', 'info')

    try {
      const result = await requirementsMatch(profile, {
        title: storage.job_title,
        company: storage.job_company || '',
        description: storage.job_description || '',
      })
      if (result.error) throw new Error(result.error)

      // Deduct AI run client-side (server doesn't track this yet)
      await deductAiRun()
      await loadCreditsUI()

      // Cache the result for this candidate + job combination
      await setStorage({ [cacheKey]: { result, timestamp: Date.now() } })

      hideStatus(statusEl)
      showMatchPanel(result)
    } catch (e) {
      showStatus(statusEl, `Match analysis failed: ${e.message}`, 'error')
    }
  })
}

// ── Profile tab ───────────────────────────────────────────────────────────────
function setupProfileTab(profile) {
  const showNotLinkedIn = () => { $('profile-not-linkedin').style.display = 'block'; $('profile-data-view').style.display = 'none'; $('profile-loading-state').style.display = 'none'; $('profile-error-state').style.display = 'none' }
  const showError = () => { $('profile-not-linkedin').style.display = 'none'; $('profile-data-view').style.display = 'none'; $('profile-loading-state').style.display = 'none'; $('profile-error-state').style.display = 'block' }
  const showData = (p) => {
    $('profile-not-linkedin').style.display = 'none'
    $('profile-error-state').style.display = 'none'
    $('profile-loading-state').style.display = 'none'
    $('profile-data-view').style.display = 'block'
    $('prof-name').textContent = p.fullName || '—'
    $('prof-title').textContent = p.title || '—'
    $('prof-company').textContent = p.company || '—'
    const urlEl = $('prof-url')
    if (p.linkedinUrl) {
      urlEl.innerHTML = `<a href="${p.linkedinUrl}" target="_blank">${p.linkedinUrl.replace('https://', '')}</a>`
    } else { urlEl.textContent = '—' }
    if (p.experience?.length) {
      const list = $('prof-experience-list')
      list.innerHTML = p.experience.map((exp, i) => `
        <div style="margin-bottom:${i < p.experience.length - 1 ? '10px' : '0'};${i < p.experience.length - 1 ? 'padding-bottom:10px;border-bottom:1px solid #f3f4f6;' : ''}">
          <div style="font-size:13px;font-weight:600;color:#111827;">${exp.title || ''}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:1px;">${exp.company || ''}${exp.dates ? ' · ' + exp.dates : ''}</div>
        </div>`).join('')
      $('prof-experience-card').style.display = 'block'
    }
  }

  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    const url = activeTab?.url ?? ''
    const isLinkedIn = url.includes('linkedin.com/in/') || url.includes('linkedin.com/talent/') || url.includes('linkedin.com/recruiter/')
    if (!isLinkedIn) { showNotLinkedIn(); return }
    if (!profile) { showError(); return }
    showData(profile)
  })

  $('btn-rescrape')?.addEventListener('click', async () => {
    $('profile-loading-state').style.display = 'block'
    $('profile-data-view').style.display = 'none'
    const fresh = await scrapeCurrentProfile()
    if (fresh) showData(fresh)
    else showError()
  })
}

// ── Job tab ───────────────────────────────────────────────────────────────────
function setupJobTab() {
  getStorage(['job_title', 'job_company', 'job_description', 'job_url']).then(d => {
    if (d.job_title) $('job-title').value = d.job_title
    if (d.job_company) $('job-company').value = d.job_company
    if (d.job_description) $('job-description').value = d.job_description
    if (d.job_url) $('job-url').value = d.job_url
  })

  $('btn-extract-job').addEventListener('click', async () => {
    const url = $('job-url').value.trim()
    const statusEl = $('extract-status')
    if (!url) { showStatus(statusEl, 'Paste a job posting URL first.', 'error'); return }
    if (!url.startsWith('http')) { showStatus(statusEl, 'Enter a valid URL starting with http.', 'error'); return }
    const btn = $('btn-extract-job')
    btn.disabled = true
    showStatus(statusEl, 'Opening job page and extracting…', 'info')
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
        const results = await chrome.scripting.executeScript({ target: { tabId: jobTab.id }, func: () => document.body?.innerText ?? '' })
        pageText = results?.[0]?.result ?? ''
      } catch {}
      chrome.tabs.remove(jobTab.id).catch(() => {})
      if (!pageText) { showStatus(statusEl, 'Could not read that page. Paste details manually.', 'error'); btn.disabled = false; return }
      const jobData = await extractJob(pageText.slice(0, 12000))
      if (jobData?.title) $('job-title').value = jobData.title
      if (jobData?.company) $('job-company').value = jobData.company
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
    const lookupsUsed = credits?.lookups_used ?? 0
    const lookupsMax = CONFIG.tiers[tier]?.lookups ?? 10
    const aiUsed = credits?.ai_runs_used ?? 0
    const aiMax = CONFIG.tiers[tier]?.ai_runs ?? 20
    const badge = $('settings-plan-badge')
    badge.textContent = CONFIG.tiers[tier]?.label ?? 'Free'
    badge.className = `plan-badge${tier === 'free' ? ' free' : ''}`
    $('settings-lookups').textContent = `${lookupsUsed} / ${lookupsMax}`
    if ($('settings-ai-runs')) $('settings-ai-runs').textContent = `${aiUsed} / ${aiMax}`
  } catch {}
  $('btn-upgrade').addEventListener('click', () => createCheckout())
  $('btn-sign-out').addEventListener('click', async () => { await signOut(); showLoginScreen() })

  const prefs = await getStorage(['pref_theme', 'pref_dark_mode'])
  applyTheme(prefs.pref_theme || (prefs.pref_dark_mode ? 'dark' : 'system'))
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
