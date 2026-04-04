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
  $('credit-pill')?.addEventListener('click', () => createCheckout())

  // Detect current tab URL — no DOM scraping
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const pageUrl = activeTab?.url ?? ''
  const linkedInUrl = extractLinkedInUrl(pageUrl)

  await setupOutreachTab(linkedInUrl)
  setupCandidateTab(linkedInUrl)
  setupJobTab()
  await setupSettingsTab(user)
}

// ── Extract LinkedIn URL from page URL ─────────────────────────────────────────
function extractLinkedInUrl(pageUrl) {
  if (!pageUrl) return null
  // Regular profiles: linkedin.com/in/username
  const inMatch = pageUrl.match(/linkedin\.com\/in\/[^/?#]+/)
  if (inMatch) return 'https://www.' + inMatch[0]
  // Recruiter profiles: linkedin.com/talent/profile/...
  const talentMatch = pageUrl.match(/linkedin\.com\/talent\/profile\/[^/?#]+/)
  if (talentMatch) return 'https://www.' + talentMatch[0]
  return null
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

// ── Workflow state ────────────────────────────────────────────────────────────
let _state = { email: null, emailSource: null, hasDraft: false, linkedInUrl: null }

function updateWorkflowUI() {
  const { email, hasDraft } = _state

  // Status chips
  $('chip-email').textContent = email ? '✓ Found' : 'Not found'
  $('chip-email').className = `status-chip-value${email ? ' found' : ' missing'}`
  $('chip-draft').textContent = hasDraft ? '✓ Ready' : 'Not ready'
  $('chip-draft').className = `status-chip-value${hasDraft ? ' ready' : ' missing'}`

  // Primary CTA
  $('btn-find-email').style.display = 'none'
  $('btn-generate-draft').style.display = 'none'
  $('open-email-row').style.display = 'none'

  if (!email) {
    $('btn-find-email').style.display = 'block'
  } else if (!hasDraft) {
    $('btn-generate-draft').style.display = 'block'
  } else {
    $('open-email-row').style.display = 'flex'
  }

  // Secondary actions
  $('btn-recheck-email').style.display = email ? 'block' : 'none'
  $('btn-regenerate').style.display = hasDraft ? 'block' : 'none'
}

// ── Outreach tab ──────────────────────────────────────────────────────────────
async function setupOutreachTab(linkedInUrl) {
  _state.linkedInUrl = linkedInUrl

  // ── Candidate card — restore or pre-fill from URL ────────────────────────
  const stored = await getStorage(['cand_name', 'cand_title', 'cand_company', 'cand_linkedin_url'])

  // If URL changed (new profile), clear old candidate data
  const storedUrl = stored.cand_linkedin_url || ''
  const urlChanged = linkedInUrl && storedUrl && linkedInUrl !== storedUrl

  if (urlChanged) {
    // New profile — clear fields so recruiter fills them fresh
    await setStorage({ cand_name: '', cand_title: '', cand_company: '', cand_linkedin_url: linkedInUrl })
    $('cand-name').value = ''
    $('cand-title').value = ''
    $('cand-company').value = ''
  } else {
    $('cand-name').value = stored.cand_name || ''
    $('cand-title').value = stored.cand_title || ''
    $('cand-company').value = stored.cand_company || ''
    if (linkedInUrl) await setStorage({ cand_linkedin_url: linkedInUrl })
  }

  // Show LinkedIn URL row if on a profile page
  if (linkedInUrl) {
    const slug = linkedInUrl.replace('https://www.', '')
    const urlLink = $('cand-url-link')
    urlLink.href = linkedInUrl
    urlLink.textContent = slug.length > 36 ? slug.slice(0, 36) + '…' : slug
    $('cand-url-row').style.display = 'flex'
  }

  // Copy URL button
  $('btn-copy-url')?.addEventListener('click', () => {
    if (linkedInUrl) navigator.clipboard.writeText(linkedInUrl).catch(() => {})
  })

  // Auto-focus first empty field
  const nameInput = $('cand-name')
  const titleInput = $('cand-title')
  const compInput = $('cand-company')
  if (!nameInput.value) nameInput.focus()
  else if (!titleInput.value) titleInput.focus()
  else if (!compInput.value) compInput.focus()

  // Enter key advances to next field
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); titleInput.focus() } })
  titleInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); compInput.focus() } })
  compInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); compInput.blur() } })

  // Save candidate fields on change
  const saveCandidate = () => setStorage({
    cand_name: $('cand-name').value.trim(),
    cand_title: $('cand-title').value.trim(),
    cand_company: $('cand-company').value.trim(),
    cand_linkedin_url: linkedInUrl || '',
  })
  ;[$('cand-name'), $('cand-title'), $('cand-company')].forEach(el => {
    el.addEventListener('blur', saveCandidate)
    el.addEventListener('input', saveCandidate)
  })

  // ── Job context row ───────────────────────────────────────────────────────
  const jobData = await getStorage(['job_title', 'job_company'])
  const jcrContent = $('jcr-content')
  if (jobData.job_title) {
    jcrContent.innerHTML = `
      <div class="job-context-title">${jobData.job_title}</div>
      ${jobData.job_company ? `<div class="job-context-company">${jobData.job_company}</div>` : ''}
    `
  }
  $('btn-edit-job').addEventListener('click', () => switchTab('job'))

  // ── Check cache for this LinkedIn URL ─────────────────────────────────────
  if (linkedInUrl) {
    const cacheKey = `email_cache_${linkedInUrl}`
    const draftKey = `draft_cache_${linkedInUrl}`
    const cached = await getStorage([cacheKey, draftKey])
    if (cached[cacheKey]?.email) {
      setEmailFound(cached[cacheKey].email, 'cached')
    }
    if (cached[draftKey]?.draft) {
      setDraftReady(cached[draftKey].draft, cached[draftKey].subject)
    } else if (cached[cacheKey]?.email) {
      // Email cached but no draft — silent server check then auto-generate
    }
  }

  updateWorkflowUI()

  // ── Button wiring ─────────────────────────────────────────────────────────

  $('btn-find-email').addEventListener('click', async () => {
    await saveCandidate()
    const name = $('cand-name').value.trim()
    const company = $('cand-company').value.trim()
    if (!name) { showStatus($('email-status'), 'Enter the candidate\'s name first.', 'error'); return }

    const btn = $('btn-find-email')
    const statusEl = $('email-status')
    btn.disabled = true
    showStatus(statusEl, 'Looking up email…', 'info')

    // Parse first/last from full name
    const parts = name.split(' ')
    const firstName = parts[0] || ''
    const lastName = parts.slice(1).join(' ') || ''

    try {
      const result = await lookupEmail(firstName, lastName, _state.linkedInUrl || '', company)
      if (result.found && result.email) {
        setEmailFound(result.email, result.source)
        if (_state.linkedInUrl) {
          await setStorage({ [`email_cache_${_state.linkedInUrl}`]: { email: result.email, source: result.source, timestamp: Date.now() } })
        }
        hideStatus(statusEl)
        await generateDraft()
      } else {
        showStatus(statusEl, 'No email found for this candidate.', 'error')
      }
    } catch (e) {
      let msg = 'Lookup failed. Try again.'
      if (e.message === 'Not signed in') msg = 'Please sign in first.'
      else if (e.message?.includes('Credit limit') || e.message?.includes('402')) msg = 'Lookup limit reached. Upgrade your plan.'
      showStatus(statusEl, msg, 'error')
    }
    btn.disabled = false
    await loadCreditsUI()
  })

  $('btn-generate-draft').addEventListener('click', () => generateDraft())
  $('btn-regenerate').addEventListener('click', () => generateDraft())

  $('btn-recheck-email').addEventListener('click', async () => {
    await saveCandidate()
    const name = $('cand-name').value.trim()
    const company = $('cand-company').value.trim()
    if (!name) { showStatus($('email-status'), 'Enter the candidate\'s name first.', 'error'); return }
    const btn = $('btn-recheck-email')
    const statusEl = $('email-status')
    btn.disabled = true
    showStatus(statusEl, 'Re-checking email…', 'info')
    const parts = name.split(' ')
    try {
      const result = await lookupEmail(parts[0] || '', parts.slice(1).join(' ') || '', _state.linkedInUrl || '', company)
      if (result.found && result.email) {
        setEmailFound(result.email, result.source)
        if (_state.linkedInUrl) {
          await setStorage({ [`email_cache_${_state.linkedInUrl}`]: { email: result.email, source: result.source, timestamp: Date.now() } })
        }
        hideStatus(statusEl)
      } else {
        showStatus(statusEl, 'Still no email found.', 'error')
      }
    } catch { showStatus($('email-status'), 'Re-check failed.', 'error') }
    btn.disabled = false
    await loadCreditsUI()
  })

  // ── Open email compose ────────────────────────────────────────────────────
  function getComposeData() {
    const draft = $('email-draft').value.trim()
    const to = _state.email || ''
    const subject = $('email-draft')?.dataset?.subject || `Exciting opportunity for ${$('cand-name').value.trim().split(' ')[0] || 'you'}`
    return { draft, to, subject }
  }

  $('btn-open-outlook').addEventListener('click', () => {
    const { draft, to, subject } = getComposeData()
    const url = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}`
    chrome.tabs.create({ url })
  })

  $('btn-open-gmail').addEventListener('click', () => {
    const { draft, to, subject } = getComposeData()
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}` })
  })

  // ── Analyze Fit collapsible ───────────────────────────────────────────────
  const fitToggle = $('fit-toggle')
  const fitBody = $('fit-body')
  fitToggle.addEventListener('click', () => {
    const open = fitBody.classList.toggle('open')
    fitToggle.classList.toggle('open', open)
  })

  $('btn-run-fit')?.addEventListener('click', () => runAnalyzeFit())
}

function setEmailFound(email, source) {
  _state.email = email
  $('email-banner').style.display = 'block'
  $('found-email').textContent = email
  $('found-email-confidence').textContent = (source === 'cached' || source === 'cache') ? '✅ Previously found' : '✅ Found'
  updateWorkflowUI()
}

function setDraftReady(draftText, subject) {
  _state.hasDraft = true
  $('draft-area').style.display = 'block'
  $('email-draft').value = draftText
  if (subject) $('email-draft').dataset.subject = subject
  updateWorkflowUI()
}

async function generateDraft() {
  const statusEl = $('draft-status')
  $('draft-area').style.display = 'block'
  showStatus(statusEl, 'Generating personalized email…', 'info')
  try {
    const storage = await getStorage(['job_title', 'job_company', 'job_description', 'pref_your_name', 'pref_your_title'])
    const name = $('cand-name').value.trim()
    const parts = name.split(' ')
    const profile = {
      fullName: name,
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || '',
      title: $('cand-title').value.trim(),
      company: $('cand-company').value.trim(),
      linkedinUrl: _state.linkedInUrl || '',
    }
    // Include match context if available
    const matchSummary = $('match-summary')?.textContent?.trim() || ''
    const result = await apiGenerateDraft(
      profile,
      { title: storage.job_title || '', company: storage.job_company || '', description: storage.job_description || '', matchContext: matchSummary || undefined },
      { name: storage.pref_your_name || '', title: storage.pref_your_title || '' }
    )
    if (result.draft) {
      setDraftReady(result.draft, result.subject)
      if (_state.linkedInUrl) {
        await setStorage({ [`draft_cache_${_state.linkedInUrl}`]: { draft: result.draft, subject: result.subject || '', timestamp: Date.now() } })
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

// ── Analyze Fit ───────────────────────────────────────────────────────────────
function renderMatchItem(text, evidence) {
  return `<div style="margin-bottom:6px;padding:6px 8px;background:#f9fafb;border-radius:5px;">
    <div style="font-size:12px;font-weight:500;color:#111827;line-height:1.4;">${text}</div>
    ${evidence ? `<div style="font-size:11px;color:#6b7280;margin-top:2px;">${evidence}</div>` : ''}
  </div>`
}

function showMatchPanel(result) {
  if (result.summary) {
    $('match-summary').textContent = result.summary
    $('match-summary').style.display = 'block'
  }
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
    }
  }
  const strongCount = (result.strong || []).length
  const chip = $('chip-match')
  if (strongCount >= 3) { chip.textContent = 'Strong fit'; chip.className = 'status-chip-value found' }
  else if (strongCount >= 1) { chip.textContent = 'Partial fit'; chip.className = 'status-chip-value warn' }
  else { chip.textContent = 'Weak fit'; chip.className = 'status-chip-value missing' }
}

async function runAnalyzeFit() {
  const name = $('cand-name').value.trim()
  const storage = await getStorage(['job_title', 'job_company', 'job_description'])
  const statusEl = $('match-status')

  if (!name) { showStatus(statusEl, 'Enter the candidate\'s name first.', 'error'); return }
  if (!storage.job_title) { showStatus(statusEl, 'No job set — add one in the Job tab first.', 'error'); return }

  // Cache check
  const cacheKey = `match_cache_${_state.linkedInUrl || name}_${storage.job_title}_${storage.job_company || ''}`
  const cached = await getStorage([cacheKey])
  if (cached[cacheKey]?.result) {
    showMatchPanel(cached[cacheKey].result)
    showStatus(statusEl, '↩ Showing cached result — click Run again to refresh.', 'info')
    return
  }

  // AI run quota check
  const credits = await getCredits()
  if (credits) {
    const tier = credits.tier ?? 'free'
    const aiUsed = credits.ai_runs_used ?? 0
    const aiMax = CONFIG.tiers[tier]?.ai_runs ?? 20
    if (aiUsed >= aiMax) {
      showStatus(statusEl, `AI run limit reached (${aiMax}/month). Upgrade to continue.`, 'error')
      return
    }
  }

  showStatus(statusEl, 'Analyzing fit against job requirements…', 'info')
  // Reset sections
  $('match-summary').style.display = 'none'
  $('match-strong').style.display = 'none'
  $('match-possible').style.display = 'none'
  $('match-unclear').style.display = 'none'

  try {
    const parts = name.split(' ')
    const profile = {
      fullName: name,
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || '',
      title: $('cand-title').value.trim(),
      company: $('cand-company').value.trim(),
      linkedinUrl: _state.linkedInUrl || '',
    }
    const result = await requirementsMatch(profile, {
      title: storage.job_title,
      company: storage.job_company || '',
      description: storage.job_description || '',
    })
    if (result.error) throw new Error(result.error)
    await deductAiRun()
    await loadCreditsUI()
    await setStorage({ [cacheKey]: { result, timestamp: Date.now() } })
    hideStatus(statusEl)
    showMatchPanel(result)
  } catch (e) {
    showStatus(statusEl, `Analysis failed: ${e.message}`, 'error')
  }
}

// ── Candidate tab ─────────────────────────────────────────────────────────────
function setupCandidateTab(linkedInUrl) {
  const showNotLinkedIn = () => {
    $('profile-not-linkedin').style.display = 'block'
    $('profile-data-view').style.display = 'none'
    $('profile-loading-state').style.display = 'none'
    $('profile-error-state').style.display = 'none'
  }

  if (!linkedInUrl) { showNotLinkedIn(); return }

  // Show what we have from the editable fields + URL
  $('profile-not-linkedin').style.display = 'none'
  $('profile-data-view').style.display = 'block'
  $('profile-error-state').style.display = 'none'
  $('profile-loading-state').style.display = 'none'

  const refresh = async () => {
    const d = await getStorage(['cand_name', 'cand_title', 'cand_company', 'cand_linkedin_url'])
    $('prof-name').textContent = d.cand_name || '—'
    $('prof-title').textContent = d.cand_title || '—'
    $('prof-company').textContent = d.cand_company || '—'
    const urlEl = $('prof-url')
    const url = d.cand_linkedin_url || linkedInUrl
    if (url) {
      urlEl.innerHTML = `<a href="${url}" target="_blank">${url.replace('https://www.', '')}</a>`
    } else {
      urlEl.textContent = '—'
    }
  }
  refresh()

  $('btn-rescrape')?.addEventListener('click', refresh)
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
