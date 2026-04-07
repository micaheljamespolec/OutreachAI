// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCreditsData, enrichAndDraft, summarizeJob, bookmarkProfile, getSavedProfiles, checkSavedProfile, saveJob, getSavedJobs, deleteJob, openUpgradePage, parseErrorMessage, isAuthError } from './core/api.js'

// ── State machine ─────────────────────────────────────────────────────────────
// States: IDLE | PREFILLED | SUBMITTING | ENRICHING | DRAFTING | SUCCESS | PARTIAL_SUCCESS | EMPTY_RESULT | AUTH_ERROR | GENERIC_ERROR
let _state = 'IDLE'
let _lastResult = null
let _linkedinUrl = null
let _isBookmarked = false

// ── Helpers ───────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id)
const qs = sel => document.querySelector(sel)
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

// ── Status message ────────────────────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  const el = $('statusMessage')
  el.textContent = msg
  el.className = type
}
function clearStatus() {
  const el = $('statusMessage')
  el.textContent = ''
  el.className = ''
  el.style.display = 'none'
}

// ── Progress dots ─────────────────────────────────────────────────────────────
function setProgress(step) {
  // step: 'enrich' | 'company' | 'draft' | 'done'
  const steps = ['enrich', 'company', 'draft']
  const idx = steps.indexOf(step)
  steps.forEach((s, i) => {
    const dot = $(`dot${s.charAt(0).toUpperCase() + s.slice(1)}`)
    const lbl = $(`lbl${s.charAt(0).toUpperCase() + s.slice(1)}`)
    if (!dot) return
    if (step === 'done') { dot.className = 'progress-dot done'; if (lbl) lbl.className = 'progress-label done' }
    else if (i < idx)   { dot.className = 'progress-dot done';  if (lbl) lbl.className = 'progress-label done' }
    else if (i === idx) { dot.className = 'progress-dot active'; if (lbl) lbl.className = 'progress-label active' }
    else                { dot.className = 'progress-dot';        if (lbl) lbl.className = 'progress-label' }
  })
}

// ── UI sections ───────────────────────────────────────────────────────────────
function showSection(id, visible = true) {
  const el = $(id)
  if (el) el.style.display = visible ? 'block' : 'none'
}

function resetToIdle() {
  showSection('progressSection', false)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  showSection('errorBox', false)
  showSection('inputSection', true)
  clearStatus()
  $('generateDraftButton').disabled = false
  $('generateDraftButton').textContent = '✨ Generate draft'
}

function showErrorBox(message, isAuth = false) {
  showSection('progressSection', false)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  const box = $('errorBox')
  box.className = isAuth ? 'auth' : ''
  box.style.display = 'block'
  $('errorMessage').textContent = message
  $('authRecoveryButton').style.display = isAuth ? 'block' : 'none'
  $('generateDraftButton').disabled = false
  $('generateDraftButton').textContent = '✨ Generate draft'
}

// ── Confidence display ────────────────────────────────────────────────────────
function renderConfidence(draftConfidence) {
  const pct = Math.round(draftConfidence * 100)
  const fill = $('confFill')
  const badge = $('confBadge')
  const note = $('confNote')
  if (!fill) return
  fill.style.width = `${pct}%`
  if (pct >= 80) {
    fill.className = 'confidence-fill high'
    badge.textContent = 'High confidence'
    badge.className = 'confidence-badge high'
    if (note) note.textContent = ''
  } else if (pct >= 60) {
    fill.className = 'confidence-fill mid'
    badge.textContent = 'Medium confidence'
    badge.className = 'confidence-badge mid'
    if (note) note.textContent = 'Draft based on partial information — review before sending.'
  } else {
    fill.className = 'confidence-fill low'
    badge.textContent = 'Low confidence'
    badge.className = 'confidence-badge low'
    if (note) note.textContent = 'Limited public signals available. Edit the draft carefully before sending.'
  }
}

// ── Result rendering ──────────────────────────────────────────────────────────
function renderResult(result) {
  const { person, confidence, draft, status } = result
  _lastResult = result

  // Result summary
  showSection('resultSummary', true)
  $('resName').textContent = person.fullName || '—'

  if (person.email) {
    $('resEmail').innerHTML = `<span class="result-value email-found">${person.email}</span>`
    $('resEmailRow').style.display = 'flex'
  } else {
    $('resEmail').textContent = person.emailStatus === 'not_found' ? 'Not found' : 'Uncertain'
    $('resEmailRow').style.display = 'flex'
  }

  if (person.company) {
    $('resCompany').textContent = person.company
    $('resCompanyRow').style.display = 'flex'
  }

  if (person.title) {
    const titleEl = $('resTitle')
    titleEl.textContent = person.title
    if (person.titleVerified === false) {
      const badge = document.createElement('span')
      badge.textContent = 'unverified'
      badge.style.cssText = 'font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:10px;font-weight:600;margin-left:5px;'
      titleEl.appendChild(badge)
    }
    $('resTitleRow').style.display = 'flex'
  }

  renderConfidence(confidence.draftConfidence)

  // Status messages for partial states
  if (status === 'partial') {
    if (!person.email) {
      setStatus('No work email found — draft generated from partial info.', 'warn')
    } else if (!person.title) {
      setStatus('Company found, but title is uncertain — draft keeps it general.', 'warn')
    }
  } else if (status === 'not_enough_data') {
    setStatus('Not enough reliable info to generate a strong draft.', 'warn')
    return
  }

  // Draft
  if (draft) {
    showSection('draftOutput', true)
    const subjectEl = $('draftSubjectLine')
    if (draft.subject) {
      subjectEl.innerHTML = `<strong>Subject:</strong> ${draft.subject}`
      $('draftBody').dataset.subject = draft.subject
    }
    $('draftBody').value = draft.body || ''
  }

  // Wire compose buttons
  const to = person.email || ''
  const subject = draft?.subject || `Reaching out — ${person.fullName}`
  const body = draft?.body || ''

  $('btnOpenOutlook').onclick = () => chrome.tabs.create({
    url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent($('draftBody').value)}`
  })
  $('btnOpenGmail').onclick = () => chrome.tabs.create({
    url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent($('draftBody').value)}`
  })
}

// ── Profile tab: populate after enrichment ────────────────────────────────────
function populateProfileTab(result) {
  const { person, fromCache, isBookmarked } = result
  _isBookmarked = isBookmarked ?? false

  // Hide empty state, show card
  showSection('profileEmpty', false)
  $('profileCard').style.display = 'block'

  // Cache badge
  const cacheBadge = $('profileCacheBadge')
  if (cacheBadge) cacheBadge.style.display = fromCache ? 'inline-block' : 'none'

  // Name
  $('profName').textContent = person.fullName || '—'

  // Email with work / personal badge (safe DOM — no innerHTML)
  const emailEl = $('profEmail')
  emailEl.textContent = ''
  if (person.email) {
    const isWork = !!person.workEmail
    const emailSpan = document.createElement('span')
    emailSpan.className = 'result-value email-found'
    emailSpan.textContent = person.email
    const typeBadge = document.createElement('span')
    typeBadge.textContent = isWork ? 'work' : 'personal'
    typeBadge.style.cssText = `font-size:10px;margin-left:5px;padding:1px 5px;border-radius:10px;font-weight:600;background:${isWork ? '#dcfce7' : '#fef3c7'};color:${isWork ? '#166534' : '#92400e'};`
    emailEl.appendChild(emailSpan)
    emailEl.appendChild(typeBadge)
    $('profEmailRow').style.display = 'flex'
  } else {
    emailEl.textContent = 'Not found'
    $('profEmailRow').style.display = 'flex'
  }

  // Title with verified/unverified badge
  if (person.title) {
    const titleEl = $('profTitle')
    titleEl.textContent = person.title
    const badge = document.createElement('span')
    if (person.titleVerified === false) {
      badge.textContent = 'unverified'
      badge.style.cssText = 'font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:10px;font-weight:600;margin-left:5px;'
    } else {
      badge.textContent = 'verified'
      badge.style.cssText = 'font-size:10px;background:#dcfce7;color:#166534;padding:1px 5px;border-radius:10px;font-weight:600;margin-left:5px;'
    }
    titleEl.appendChild(badge)
    $('profTitleRow').style.display = 'flex'
  } else {
    $('profTitleRow').style.display = 'none'
  }

  // Company
  if (person.company) {
    $('profCompany').textContent = person.company
    $('profCompanyRow').style.display = 'flex'
  } else {
    $('profCompanyRow').style.display = 'none'
  }

  // LinkedIn URL (truncated for display)
  const urlEl = $('profUrl')
  if (_linkedinUrl) {
    urlEl.textContent = _linkedinUrl.replace('https://www.linkedin.com/', 'linkedin.com/').replace('https://linkedin.com/', 'linkedin.com/')
    urlEl.title = _linkedinUrl
  }

  // Bookmark button state
  updateBookmarkButton()
}

function updateBookmarkButton() {
  const btn = $('btnBookmark')
  if (!btn) return
  btn.textContent = _isBookmarked ? '✅ Saved' : '🔖 Save profile'
  btn.className = _isBookmarked ? 'btn btn-ghost' : 'btn btn-ghost'
  btn.style.cssText = _isBookmarked
    ? 'font-size:11px;padding:4px 9px;width:auto;background:#f0fdf4;color:#16a34a;border-color:#bbf7d0;'
    : 'font-size:11px;padding:4px 9px;width:auto;'
}

// ── Profile tab: saved profiles list ─────────────────────────────────────────
async function loadSavedProfiles() {
  const listEl = $('savedProfilesList')
  if (!listEl) return
  try {
    const { profiles } = await getSavedProfiles()
    const emptyEl = $('savedProfilesEmpty')

    // Always clear stale rows first
    listEl.querySelectorAll('.saved-profile-row').forEach(el => el.remove())

    if (!profiles || profiles.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block'
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'

    for (const p of profiles) {
      const row = document.createElement('div')
      row.className = 'saved-profile-row'
      const meta = p.company || p.work_email || p.personal_email || ''
      const nameSpan = document.createElement('span')
      nameSpan.className = 'saved-profile-name'
      nameSpan.textContent = p.full_name || '—'
      const metaSpan = document.createElement('span')
      metaSpan.className = 'saved-profile-meta'
      metaSpan.textContent = meta
      row.appendChild(nameSpan)
      row.appendChild(metaSpan)
      row.addEventListener('click', () => {
        _linkedinUrl = p.linkedin_url
        // Pre-fill Draft tab inputs for when user navigates there
        if ($('fullNameInput'))    $('fullNameInput').value    = p.full_name || ''
        if ($('companyHintInput')) $('companyHintInput').value = p.company   || ''
        // Populate profile card and STAY on the Profile tab
        populateProfileTab({
          person: {
            fullName:      p.full_name      || '',
            email:         p.work_email || p.personal_email || null,
            workEmail:     p.work_email     || null,
            personalEmail: p.personal_email || null,
            title:         p.title          || null,
            titleVerified: p.title_verified ?? false,
            company:       p.company        || null,
            emailStatus:   p.email_status   || 'not_found',
          },
          fromCache: true,
          isBookmarked: p.is_bookmarked ?? false,
        })
      })
      listEl.appendChild(row)
    }
  } catch (e) {
    console.warn('loadSavedProfiles failed:', e)
  }
}

// ── Profile tab setup ─────────────────────────────────────────────────────────
function setupProfileTab() {
  // "Generate draft →" button — switches to Draft tab (user then clicks Generate)
  $('btnGoToDraft')?.addEventListener('click', () => {
    document.querySelector('.tab[data-tab="outreach"]')?.click()
  })

  // Bookmark toggle
  $('btnBookmark')?.addEventListener('click', async () => {
    if (!_linkedinUrl) return
    const newState = !_isBookmarked
    const btn = $('btnBookmark')
    btn.disabled = true
    try {
      await bookmarkProfile({ linkedinUrl: _linkedinUrl, save: newState })
      _isBookmarked = newState
      updateBookmarkButton()
      const statusEl = $('bookmarkStatus')
      if (statusEl) {
        statusEl.textContent = newState ? 'Profile saved to your list.' : 'Profile removed from saved list.'
        statusEl.style.color = newState ? '#16a34a' : '#9ca3af'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
      // Refresh saved list
      await loadSavedProfiles()
    } catch (e) {
      const statusEl = $('bookmarkStatus')
      if (statusEl) { statusEl.textContent = 'Could not save — try again.'; statusEl.style.color = '#dc2626' }
    } finally {
      btn.disabled = false
    }
  })

  // Load bookmarked profiles on init
  loadSavedProfiles()
}

// ── Core flow ─────────────────────────────────────────────────────────────────
async function generateDraftFlow() {
  const companyHint    = $('companyHintInput').value.trim() || null
  const userContext    = $('userContextInput').value.trim() || null
  const fullNameHint   = $('fullNameInput').value.trim() || null

  if (!_linkedinUrl) {
    setStatus('Open a LinkedIn profile page first, then click Generate draft.', 'error')
    return
  }

  // Get job context for draft personalization
  const jobData = await getStorage(['job_title', 'job_company', 'job_description'])
  const contextParts = [userContext]
  if (jobData.job_title) contextParts.push(`Recruiting for: ${jobData.job_title}${jobData.job_company ? ' at ' + jobData.job_company : ''}`)
  if (jobData.job_description) contextParts.push(jobData.job_description)
  const fullContext = contextParts.filter(Boolean).join('. ') || null

  // Disable input, show progress
  _state = 'ENRICHING'
  $('generateDraftButton').disabled = true
  $('generateDraftButton').textContent = 'Working…'
  clearStatus()
  showSection('progressSection', true)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  showSection('errorBox', false)
  setProgress('enrich')

  // Simulate step transitions (progress UI while async work runs)
  const companyTimer = setTimeout(() => setProgress('company'), 5000)
  const draftTimer   = setTimeout(() => setProgress('draft'), 12000)

  try {
    const result = await enrichAndDraft({
      linkedinUrl: _linkedinUrl,
      companyHint,
      userContext: fullContext,
      fullNameHint,
    })

    clearTimeout(companyTimer)
    clearTimeout(draftTimer)
    setProgress('done')

    showSection('progressSection', false)
    _state = result.status === 'success' ? 'SUCCESS'
           : result.status === 'partial' ? 'PARTIAL_SUCCESS'
           : 'EMPTY_RESULT'

    // Populate name and company fields from FullEnrich result for recruiter reference
    if (result.person?.fullName) {
      $('fullNameInput').value = result.person.fullName
    }
    if (result.person?.company && !$('companyHintInput').value.trim()) {
      $('companyHintInput').value = result.person.company
    }

    renderResult(result)
    populateProfileTab(result)

    // Cache result by LinkedIn URL
    const cacheKey = `outreach_${_linkedinUrl.replace(/[^a-z0-9]/gi, '_').slice(-60)}`
    await setStorage({ [cacheKey]: { result, timestamp: Date.now() } })

  } catch (e) {
    clearTimeout(companyTimer)
    clearTimeout(draftTimer)
    showSection('progressSection', false)

    const err = parseErrorMessage(e)
    const auth = isAuthError(e) || isAuthError(err)

    if (auth) {
      _state = 'AUTH_ERROR'
      showErrorBox('Your session expired. Click below to sign out and sign back in.', true)
    } else {
      _state = 'GENERIC_ERROR'
      const MESSAGES = {
        NO_LINKEDIN_URL:         'Open a LinkedIn profile page to generate a draft.',
        ENRICHMENT_UNAVAILABLE:  'Contact lookup is temporarily unavailable. Please try again.',
        NO_EMAIL_FOUND:          'No work email was found. A draft can still be generated.',
        NOT_ENOUGH_DATA:         "There isn't enough reliable public information to generate a strong draft.",
        DRAFT_GENERATION_FAILED: 'Contact details were found, but the draft could not be generated.',
      }
      showErrorBox(MESSAGES[err.code] || err.message || 'Something went wrong.')
    }
  }
}

// ── Page prefill strategy ─────────────────────────────────────────────────────
async function prefillFromPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) return

    try {
      const data = await chrome.tabs.sendMessage(tab.id, { type: 'scrape' })
      // Accept any LinkedIn profile URL: standard (/in/), Recruiter (/talent/, /recruiter/), etc.
      if (data?.linkedin_url && data.linkedin_url.includes('linkedin.com/')) {
        _linkedinUrl = data.linkedin_url
        _state = 'PREFILLED'

        // Check saved-profile cache immediately — no credit needed
        try {
          const check = await checkSavedProfile({ linkedinUrl: _linkedinUrl })
          if (check.found) {
            const p = check.profile
            setStatus('Saved profile detected — draft is free.', 'success')
            // Pre-fill Draft tab inputs
            if (p.fullName) $('fullNameInput').value = p.fullName
            if (p.company && !$('companyHintInput').value.trim()) $('companyHintInput').value = p.company
            // Auto-populate Profile tab card
            populateProfileTab({
              person: {
                fullName: p.fullName, email: p.email,
                workEmail: p.workEmail, personalEmail: p.personalEmail,
                title: p.title, titleVerified: p.titleVerified,
                company: p.company, emailStatus: p.emailStatus,
              },
              fromCache: true,
              isBookmarked: p.isBookmarked,
            })
          } else {
            setStatus('LinkedIn profile detected — ready to generate draft.', 'info')
          }
        } catch {
          setStatus('LinkedIn profile detected — ready to generate draft.', 'info')
        }
      } else {
        setStatus('Open a LinkedIn profile page to generate a draft.', 'warn')
      }
    } catch {
      setStatus('Open a LinkedIn profile page to generate a draft.', 'warn')
    }
  } catch {}
}

// ── Credits UI ────────────────────────────────────────────────────────────────
async function loadCreditsUI() {
  const pill = $('creditPill')
  try {
    const credits = await getCreditsData()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max  = CONFIG.tiers[tier]?.lookups ?? 10
    const left = max - used
    if (left <= 0)      { pill.textContent = '0 lookups · Upgrade'; pill.className = 'credit-pill critical' }
    else if (left <= 2) { pill.textContent = `${left} left · Upgrade`; pill.className = 'credit-pill critical' }
    else if (left <= 5) { pill.textContent = `${left} lookups left`; pill.className = 'credit-pill low' }
    else                { pill.textContent = `${left} lookups left`; pill.className = 'credit-pill' }

    // Settings tab
    if ($('settingsEmail') && credits?.user_id) {
      const user = await getUser()
      if (user?.email) $('settingsEmail').textContent = user.email
    }
    const badge = $('settingsPlanBadge')
    if (badge) {
      badge.textContent = CONFIG.tiers[tier]?.label ?? 'Free'
      badge.className = `plan-badge${tier === 'free' ? ' free' : ''}`
    }
    if ($('settingsLookups')) $('settingsLookups').textContent = `${used} / ${max}`
  } catch {
    pill.textContent = '— lookups'
    pill.className = 'credit-pill'
  }
}

// ── Login screen ──────────────────────────────────────────────────────────────
function showLoginScreen() {
  getStorage(['pref_theme']).then(d => applyTheme(d.pref_theme || 'system'))
  $('loginScreen').style.display = 'block'
  $('mainApp').style.display = 'none'

  const statusEl = $('loginStatus')
  $('btnSendMagicLink').addEventListener('click', async () => {
    const email = $('loginEmail').value.trim()
    if (!email) { statusEl.textContent = 'Enter your email first.'; statusEl.className = 'error'; return }
    statusEl.textContent = 'Sending magic link…'
    statusEl.className = 'info'
    const { error } = await sendMagicLink(email)
    if (error) { statusEl.textContent = `Error: ${error.message}`; statusEl.className = 'error' }
    else       { statusEl.textContent = 'Check your email — link sent!'; statusEl.className = 'success' }
  })
  $('btnGoogleSignin').addEventListener('click', () => signInWithGoogle())
}

// ── Main app ──────────────────────────────────────────────────────────────────
async function showMainApp(user) {
  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')
  $('loginScreen').style.display = 'none'
  $('mainApp').style.display = 'block'

  setupTabs()
  await loadCreditsUI()
  $('creditPill').addEventListener('click', () => openUpgradePage())

  // Prefill name and company from page
  await prefillFromPage()

  // ── Generate draft button ──────────────────────────────────────────────────
  $('generateDraftButton').addEventListener('click', () => generateDraftFlow())

  // Enter in name field triggers generate
  $('fullNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); generateDraftFlow() }
  })

  // Clear button
  $('clearButton').addEventListener('click', async () => {
    $('fullNameInput').value = ''
    $('companyHintInput').value = ''
    $('userContextInput').value = ''
    _linkedinUrl = null
    resetToIdle()
    await prefillFromPage()
  })

  // Retry buttons
  $('retryButton')?.addEventListener('click', () => generateDraftFlow())
  $('retryButton2')?.addEventListener('click', () => {
    showSection('errorBox', false)
    $('authRecoveryButton').style.display = 'none'
    generateDraftFlow()
  })

  // Auth recovery
  $('authRecoveryButton')?.addEventListener('click', async () => {
    await signOut()
    showLoginScreen()
  })

  // Copy draft
  $('btnCopyDraft')?.addEventListener('click', () => {
    const text = $('draftBody').value
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('btnCopyDraft')
      btn.textContent = '✓ Copied'
      setTimeout(() => { btn.textContent = '📋 Copy draft' }, 2000)
    })
  })

  // Settings
  await setupSettingsTab(user)
  setupJobTab()
  setupProfileTab()
}

// ── Job tab: saved jobs list ───────────────────────────────────────────────────
// Activate a saved-job row and populate fields (shared by auto-restore and row click)
function _activateSavedJobRow(row, j, allRows, showStatus = false) {
  allRows.forEach(r => r.classList.remove('active'))
  row.classList.add('active')
  if ($('jobTitle'))       $('jobTitle').value       = j.role_title || ''
  if ($('jobCompany'))     $('jobCompany').value     = j.company    || ''
  if ($('jobDescription')) $('jobDescription').value = j.highlights || ''
  if ($('jobUrl'))         $('jobUrl').value         = j.job_url    || ''
  if ($('jobLabel'))       $('jobLabel').value       = j.label
  if (showStatus) {
    const statusEl = $('jobStatus')
    if (statusEl) {
      statusEl.textContent = `"${j.label}" loaded.`
      statusEl.style.color = '#16a34a'
      setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = '' }, 2000)
    }
  }
}

async function loadSavedJobs() {
  const listEl = $('savedJobsList')
  if (!listEl) return
  try {
    const [{ jobs }, stored] = await Promise.all([
      getSavedJobs(),
      getStorage(['saved_job_last_id']),
    ])
    const lastId = stored.saved_job_last_id || null
    const emptyEl = $('savedJobsEmpty')

    // Clear stale rows
    listEl.querySelectorAll('.saved-job-row').forEach(el => el.remove())

    if (!jobs || jobs.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block'
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'

    const renderedRows = []

    for (const j of jobs) {
      const row = document.createElement('div')
      row.className = 'saved-job-row'
      row.dataset.jobId = j.id

      const labelSpan = document.createElement('span')
      labelSpan.className = 'saved-job-label'
      labelSpan.textContent = j.label

      const companySpan = document.createElement('span')
      companySpan.className = 'saved-job-company'
      companySpan.textContent = j.company || ''

      const delBtn = document.createElement('button')
      delBtn.className = 'saved-job-delete'
      delBtn.title = 'Delete this saved job'
      delBtn.textContent = '✕'
      delBtn.addEventListener('click', async e => {
        e.stopPropagation()
        delBtn.disabled = true
        try {
          await deleteJob({ jobId: j.id })
          if (lastId === j.id) await setStorage({ saved_job_last_id: null })
          await loadSavedJobs()
        } catch {
          delBtn.disabled = false
        }
      })

      row.appendChild(labelSpan)
      row.appendChild(companySpan)
      row.appendChild(delBtn)

      row.addEventListener('click', async () => {
        _activateSavedJobRow(row, j, renderedRows, true)
        await setStorage({
          job_title:         j.role_title || '',
          job_company:       j.company    || '',
          job_description:   j.highlights || '',
          job_url:           j.job_url    || '',
          saved_job_last_id: j.id,
        })
      })

      listEl.appendChild(row)
      renderedRows.push(row)
    }

    // Auto-restore: if we have a last-used ID that matches a fetched job, activate it silently
    if (lastId) {
      const idx = jobs.findIndex(j => j.id === lastId)
      if (idx !== -1) {
        _activateSavedJobRow(renderedRows[idx], jobs[idx], renderedRows, false)
      }
    }
  } catch (e) {
    console.warn('loadSavedJobs failed:', e)
  }
}

// ── Job tab ───────────────────────────────────────────────────────────────────
function setupJobTab() {
  getStorage(['job_title','job_company','job_description','job_url']).then(d => {
    if (d.job_title)       $('jobTitle').value       = d.job_title
    if (d.job_company)     $('jobCompany').value     = d.job_company
    if (d.job_description) $('jobDescription').value = d.job_description
    if (d.job_url)         $('jobUrl').value         = d.job_url
  })

  // Load saved jobs list on init
  loadSavedJobs()

  $('btnExtractJob').addEventListener('click', async () => {
    const url = $('jobUrl').value.trim()
    const statusEl = $('extractStatus')
    if (!url || !url.startsWith('http')) { statusEl.textContent = 'Enter a valid URL.'; return }
    const btn = $('btnExtractJob')
    btn.disabled = true
    statusEl.textContent = 'Fetching job details…'

    const DIRECTS = { 'google.com': 'Google', 'amazon.jobs': 'Amazon', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple', 'meta.com': 'Meta', 'netflix.com': 'Netflix', 'stripe.com': 'Stripe', 'openai.com': 'OpenAI' }
    const BOARDS  = ['greenhouse.io','lever.co','workday.com','myworkdayjobs.com','jobvite.com','smartrecruiters.com','ashbyhq.com','linkedin.com']
    const GENERIC = /^(job details?|job description|apply( now)?|about this role|overview|open role|career opportunity|careers|current opening|job posting|view job|find your dream job)$/i

    // ── Step 1: Instant pre-fill from URL slug & hostname ─────────────────────
    let preTitle = '', preCompany = ''
    try {
      const parsedHost = new URL(url).hostname.replace(/^www\./, '')
      for (const [d, n] of Object.entries(DIRECTS)) { if (parsedHost.includes(d)) { preCompany = n; break } }
      const slugPart = [...url.split('/')].reverse().find(p => /[a-zA-Z]/.test(p) && p.includes('-'))
      if (slugPart) preTitle = slugPart.replace(/^\d+-/, '').replace(/[-_]/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase())
    } catch {}
    if (preTitle)   $('jobTitle').value   = preTitle
    if (preCompany) $('jobCompany').value = preCompany

    // ── Step 2: Fetch HTML directly — no tabs opened ──────────────────────────
    try {
      const controller = new AbortController()
      const fetchTimer = setTimeout(() => controller.abort(), 10000)
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
      })
      clearTimeout(fetchTimer)
      const html = await resp.text()
      const doc = new DOMParser().parseFromString(html, 'text/html')

      // JSON-LD (best source — Google Careers, Greenhouse, Lever, Ashby all include this)
      let ldTitle = '', ldCompany = '', ldDescription = ''
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data; try { data = JSON.parse(s.textContent) } catch { continue }
        const nodes = data?.['@graph'] ? data['@graph'] : [data]
        const job = nodes.find(n => n?.['@type'] === 'JobPosting')
        if (job) {
          ldTitle   = (job.title || '').trim()
          ldCompany = (job.hiringOrganization?.name || '').trim()
          const tmp = document.createElement('div')
          tmp.innerHTML = job.description || ''
          ldDescription = (tmp.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600)
          break
        }
      }

      // Meta tag fallbacks
      const ogTitle   = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || ''
      const ogSite    = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() || ''
      const pageTitle = doc.title?.trim() || ''

      // Body text fallback (for description only)
      const mainEl = doc.querySelector('main, article, [role="main"], #main-content') || doc.body
      const NAV = /^(home|menu|skip|search|sign in|sign up|login|log in|careers|jobs|apply|share|back|next|prev|navigation|cookie|privacy|terms|©|\d{4})$/i
      const bodyLines = (mainEl?.textContent || '').split('\n').map(l => l.trim()).filter(l => l.length > 40 && !NAV.test(l))
      const bodyText  = bodyLines.join(' ')
      const anchor    = bodyText.search(/minimum qualifications|about the job|about this role|responsibilities|what you.ll do|job summary/i)
      const bodyDesc  = (anchor > -1 ? bodyText.slice(anchor) : bodyText).slice(0, 600)

      // Strip trailing " | Site" or " — Site" but NOT hyphens within the title (e.g. "Fixed-Term")
      const stripSuffix = s => s.replace(/\s+[|–—]\s+[^|–—]+$/, '').replace(/\s+-\s+\S.*$/, '').trim()

      // ── Resolve best title ─────────────────────────────────────────────────
      let bestTitle = ''
      if (ldTitle && !GENERIC.test(ldTitle)) bestTitle = ldTitle
      if (!bestTitle && ogTitle) bestTitle = stripSuffix(ogTitle)
      if (!bestTitle && pageTitle) bestTitle = stripSuffix(pageTitle)
      if (bestTitle && !GENERIC.test(bestTitle)) $('jobTitle').value = bestTitle

      // ── Resolve best company ───────────────────────────────────────────────
      if (ldCompany) $('jobCompany').value = ldCompany
      else if (ogSite && !BOARDS.some(b => url.includes(b))) $('jobCompany').value = ogSite

      // ── Description: set raw first, then summarize via Claude ────────────
      const rawDesc = ldDescription || bodyDesc
      $('jobDescription').value = rawDesc

      const titleForSummary   = $('jobTitle').value.trim()
      const companyForSummary = $('jobCompany').value.trim()

      statusEl.textContent = 'Details extracted — review and save.'
      btn.disabled = false

      // Kick off summarization in background — don't block the UI
      if (rawDesc || titleForSummary) {
        statusEl.textContent = 'Summarizing highlights…'
        try {
          const { summary } = await summarizeJob({
            rawText:  rawDesc,
            jobTitle: titleForSummary,
            company:  companyForSummary,
          })
          if (summary) $('jobDescription').value = summary
          statusEl.textContent = 'Details extracted — review and save.'
        } catch {
          statusEl.textContent = 'Details extracted — review and save.'
        }
      }

      return  // btn already re-enabled above
    } catch (e) {
      statusEl.textContent = preTitle ? 'Details extracted from URL — review and save.' : `Failed: ${e.message}`
    }
    btn.disabled = false
  })

  $('btnSaveJob').addEventListener('click', async () => {
    const title      = $('jobTitle').value.trim()
    const company    = $('jobCompany').value.trim()
    const highlights = $('jobDescription').value.trim()
    const jobUrl     = $('jobUrl').value.trim()
    const label      = $('jobLabel').value.trim() || (title ? `${title}${company ? ' — ' + company : ''}` : '')

    if (!label) { $('jobStatus').textContent = 'Add a role title or label first.'; $('jobStatus').style.color = '#dc2626'; return }

    const btn = $('btnSaveJob')
    btn.disabled = true
    $('jobStatus').textContent = 'Saving…'
    $('jobStatus').style.color = '#6b7280'

    try {
      const { job } = await saveJob({ label, jobUrl: jobUrl || null, roleTitle: title || null, company: company || null, highlights: highlights || null })

      // Persist locally so draft flow picks it up, and mark as last-used
      await setStorage({
        job_title:           title,
        job_company:         company,
        job_description:     highlights,
        job_url:             jobUrl,
        saved_job_last_id:   job?.id || null,
      })

      $('jobStatus').textContent = 'Job saved!'
      $('jobStatus').style.color = '#16a34a'
      setTimeout(() => { $('jobStatus').textContent = ''; $('jobStatus').style.color = '' }, 2500)
      await loadSavedJobs()
    } catch (e) {
      $('jobStatus').textContent = 'Could not save — try again.'
      $('jobStatus').style.color = '#dc2626'
    } finally {
      btn.disabled = false
    }
  })
}

// ── Settings tab ──────────────────────────────────────────────────────────────
async function setupSettingsTab(user) {
  if (user?.email) $('settingsEmail').textContent = user.email

  $('btnUpgrade').addEventListener('click', () => openUpgradePage())
  $('btnSignOut').addEventListener('click', async () => { await signOut(); showLoginScreen() })

  const prefs = await getStorage(['pref_theme','pref_name','pref_title'])
  applyTheme(prefs.pref_theme || 'system')
  if (prefs.pref_name)  $('prefName').value  = prefs.pref_name
  if (prefs.pref_title) $('prefTitle').value = prefs.pref_title

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => { await setStorage({ pref_theme: btn.dataset.theme }); applyTheme(btn.dataset.theme) })
  })

  $('btnSavePrefs').addEventListener('click', async () => {
    await setStorage({ pref_name: $('prefName').value.trim(), pref_title: $('prefTitle').value.trim() })
    $('prefsStatus').textContent = 'Saved!'
    setTimeout(() => { $('prefsStatus').textContent = '' }, 2000)
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) { showLoginScreen(); return }
  await showMainApp(await getUser())
}
init()
