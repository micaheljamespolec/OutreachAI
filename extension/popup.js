// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCreditsData, enrichAndDraft, openUpgradePage, parseErrorMessage, isAuthError } from './core/api.js'

// ── State machine ─────────────────────────────────────────────────────────────
// States: IDLE | PREFILLED | SUBMITTING | ENRICHING | DRAFTING | SUCCESS | PARTIAL_SUCCESS | EMPTY_RESULT | AUTH_ERROR | GENERIC_ERROR
let _state = 'IDLE'
let _lastResult = null
let _linkedinUrl = null

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
        UNKNOWN_ERROR:           'Something went wrong. Please try again.',
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
        setStatus('LinkedIn profile detected — ready to generate draft.', 'info')
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
}

// ── Job tab ───────────────────────────────────────────────────────────────────
function setupJobTab() {
  getStorage(['job_title','job_company','job_description','job_url']).then(d => {
    if (d.job_title)       $('jobTitle').value       = d.job_title
    if (d.job_company)     $('jobCompany').value     = d.job_company
    if (d.job_description) $('jobDescription').value = d.job_description
    if (d.job_url)         $('jobUrl').value         = d.job_url
  })

  $('btnExtractJob').addEventListener('click', async () => {
    const url = $('jobUrl').value.trim()
    const statusEl = $('extractStatus')
    if (!url || !url.startsWith('http')) { statusEl.textContent = 'Enter a valid URL.'; return }
    const btn = $('btnExtractJob')
    btn.disabled = true
    statusEl.textContent = 'Loading job page…'
    try {
      const jobTab = await chrome.tabs.create({ url, active: false })
      // Wait for page load
      await new Promise(resolve => {
        const l = (tabId, info) => { if (tabId === jobTab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(l); resolve(null) } }
        chrome.tabs.onUpdated.addListener(l)
        setTimeout(resolve, 15000)
      })
      // Extra wait for JS-rendered content (Google Careers, Greenhouse, Lever, etc.)
      await new Promise(r => setTimeout(r, 3000))
      statusEl.textContent = 'Reading job details…'

      let scraped = null
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: jobTab.id },
          func: () => {
            // ── 1. JSON-LD structured data (most reliable — used by Google Careers, Greenhouse, Lever, etc.)
            let ldTitle = '', ldCompany = '', ldDescription = ''
            try {
              const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
              for (const s of scripts) {
                let data
                try { data = JSON.parse(s.textContent) } catch { continue }
                // Handle both direct objects and @graph arrays
                const nodes = data?.['@graph'] ? data['@graph'] : [data]
                const job = nodes.find(n => n?.['@type'] === 'JobPosting')
                if (job) {
                  ldTitle   = job.title || ''
                  ldCompany = job.hiringOrganization?.name || ''
                  // Strip HTML tags from description
                  const raw = job.description || ''
                  const tmp = document.createElement('div')
                  tmp.innerHTML = raw
                  ldDescription = (tmp.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500)
                  break
                }
              }
            } catch {}

            // ── 2. Fallback meta signals
            const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || ''
            const ogSite  = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() || ''
            const pageTitle = document.title?.trim() || ''

            // ── 3. Fallback body text (main content area only)
            const mainEl = document.querySelector('main, article, [role="main"], #main-content')
            const sourceEl = mainEl || document.body
            const NAV = /^(home|menu|skip|search|sign in|sign up|login|log in|careers|jobs|apply|share|back|next|prev|navigation|cookie|privacy|terms|©|\d{4}|related jobs?|more jobs?|similar jobs?|you may also)$/i
            const bodyLines = (sourceEl?.innerText || '').split('\n')
              .map(l => l.trim()).filter(l => l.length > 30 && !NAV.test(l))
            const bodyText = bodyLines.join('\n')
            const descAnchor = bodyText.search(/minimum qualifications|about the job|about this role|responsibilities|what you.ll do|the role|job summary/i)
            const bodyDesc = (descAnchor > -1 ? bodyText.slice(descAnchor) : bodyText).slice(0, 500)

            return { ldTitle, ldCompany, ldDescription, ogTitle, ogSite, pageTitle, bodyDesc, url: location.href }
          }
        })
        scraped = res?.[0]?.result ?? null
      } catch {}
      chrome.tabs.remove(jobTab.id).catch(() => {})

      if (!scraped) { statusEl.textContent = 'Could not read that page.'; btn.disabled = false; return }

      const { ldTitle, ldCompany, ldDescription, ogTitle, ogSite, pageTitle, bodyDesc, url: pageUrl } = scraped

      // ── Title priority: JSON-LD → og:title → page title → URL slug ────────
      const GENERIC = /^(job details?|job description|apply( now)?|about this role|overview|position|open role|career opportunity|careers|current opening|job posting|view job)$/i
      let jobTitle = ''
      if (ldTitle && !GENERIC.test(ldTitle.trim())) jobTitle = ldTitle.trim()
      if (!jobTitle && ogTitle) jobTitle = ogTitle.split(/\s*[|\-–—]\s*/)[0].trim()
      if (!jobTitle && pageTitle) jobTitle = pageTitle.split(/\s*[|\-–—]\s*/)[0].trim()
      if (!jobTitle) {
        const slug = [...pageUrl.split('/')].reverse().find(p => /[a-z]/.test(p) && p.includes('-'))
        if (slug) jobTitle = slug.replace(/[-_]/g, ' ').replace(/\d+/g, '').trim().replace(/\b\w/g, c => c.toUpperCase())
      }

      // ── Company priority: JSON-LD → og:site_name → hostname map ───────────
      const BOARDS = { 'greenhouse.io': '', 'lever.co': '', 'workday.com': '', 'myworkdayjobs.com': '', 'jobvite.com': '', 'smartrecruiters.com': '', 'linkedin.com': '' }
      const DIRECTS = { 'google.com': 'Google', 'amazon.jobs': 'Amazon', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple', 'meta.com': 'Meta' }
      let company = ''
      if (ldCompany) company = ldCompany
      if (!company && ogSite) company = ogSite
      if (!company) {
        const host = new URL(pageUrl).hostname.replace(/^www\./, '')
        for (const [d, n] of Object.entries(DIRECTS)) { if (host.includes(d)) { company = n; break } }
        if (!company) for (const [d] of Object.entries(BOARDS)) { if (host.includes(d)) { company = ''; break } }
        if (!company) company = host.split('.')[0].replace(/\b\w/g, c => c.toUpperCase())
      }

      // ── Description: JSON-LD best, then body ──────────────────────────────
      const description = ldDescription || bodyDesc

      if (jobTitle)   $('jobTitle').value = jobTitle
      if (company)    $('jobCompany').value = company
      $('jobDescription').value = description

      statusEl.textContent = 'Details extracted — review and save.'
    } catch (e) { statusEl.textContent = `Failed: ${e.message}` }
    btn.disabled = false
  })

  $('btnSaveJob').addEventListener('click', async () => {
    const title = $('jobTitle').value.trim()
    if (!title) { $('jobStatus').textContent = 'Add a role title first.'; return }
    await setStorage({ job_title: title, job_company: $('jobCompany').value.trim(), job_description: $('jobDescription').value.trim(), job_url: $('jobUrl').value.trim() })
    $('jobStatus').textContent = 'Saved!'
    setTimeout(() => { $('jobStatus').textContent = '' }, 2000)
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
