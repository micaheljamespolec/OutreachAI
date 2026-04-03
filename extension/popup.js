// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCredits } from './core/credits.js'
import { createCheckout, lookupEmail, generateDraft as apiGenerateDraft, extractJob } from './core/api.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
function showStatus(el, msg, type = 'info') {
  el.textContent = msg
  el.className = `status ${type} show`
}
function hideStatus(el) {
  el.textContent = ''
  el.className = 'status'
}
function getStorage(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r))
}
function setStorage(obj) {
  return new Promise(r => chrome.storage.local.set(obj, r))
}
function initials(name) {
  return (name || '').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?'
}

// ── Theme ─────────────────────────────────────────────────────────────────────
// theme values: 'light' | 'dark' | 'system'
function resolveTheme(pref) {
  if (pref === 'dark') return 'dark'
  if (pref === 'light') return 'light'
  // system
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(pref) {
  const resolved = resolveTheme(pref || 'system')
  document.body.classList.toggle('dark', resolved === 'dark')
  // Update segmented control
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === (pref || 'system'))
  })
}

// Keep backward compat: applyDarkMode(bool) still works for old callers
function applyDarkMode(enabled) {
  applyTheme(enabled ? 'dark' : 'light')
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
      tab.classList.add('active')
      document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add('active')
    })
  })
}

// ── Login screen ─────────────────────────────────────────────────────────────
function showLoginScreen() {
  getStorage(['pref_theme', 'pref_dark_mode']).then(d => {
    applyTheme(d.pref_theme || (d.pref_dark_mode ? 'dark' : 'system'))
  })
  document.getElementById('login-screen').style.display = 'block'
  document.getElementById('main-app').style.display = 'none'
  const statusEl = document.getElementById('login-status')

  document.getElementById('btn-send-magic-link').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim()
    if (!email) { showStatus(statusEl, 'Please enter your email.', 'error'); return }
    showStatus(statusEl, 'Sending magic link…', 'info')
    const { error } = await sendMagicLink(email)
    if (error) { showStatus(statusEl, `Error: ${error.message}`, 'error'); return }
    showStatus(statusEl, 'Check your email for the magic link!', 'success')
  })

  document.getElementById('btn-google-signin').addEventListener('click', () => {
    signInWithGoogle()
  })
}

// ── Main app ──────────────────────────────────────────────────────────────────
async function showMainApp(user) {
  // Apply theme before rendering
  const prefs = await getStorage(['pref_theme', 'pref_dark_mode'])
  applyTheme(prefs.pref_theme || (prefs.pref_dark_mode ? 'dark' : 'system'))

  document.getElementById('login-screen').style.display = 'none'
  document.getElementById('main-app').style.display = 'block'

  setupTabs()
  await loadCreditsUI()

  // Scrape profile once and share across tabs
  const profile = await scrapeCurrentProfile()

  await setupEmailTab(profile)
  setupProfileTab(profile)
  setupJobTab()
  await setupSettingsTab(user)
}

// ── Credits header ────────────────────────────────────────────────────────────
async function loadCreditsUI() {
  try {
    const credits = await getCredits()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max = CONFIG.tiers[tier]?.lookups ?? 10
    document.getElementById('header-credits').textContent = `${used} / ${max}`
  } catch {
    document.getElementById('header-credits').textContent = '—'
  }
}

// ── Scrape profile ────────────────────────────────────────────────────────────
async function scrapeCurrentProfile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''
  const isLinkedIn = url.includes('linkedin.com/in/') ||
    url.includes('linkedin.com/talent/') ||
    url.includes('linkedin.com/recruiter/')
  if (!isLinkedIn) return null
  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: 'scrape' })
    return data?.fullName ? data : null
  } catch { return null }
}

// ── Email tab ─────────────────────────────────────────────────────────────────
function displayEmailResult(email, source) {
  document.getElementById('email-found-row').style.display = 'flex'
  document.getElementById('found-email').textContent = email
  const btn = document.getElementById('btn-find-email')
  if (source === 'cached' || source === 'cache') {
    document.getElementById('found-email-confidence').textContent = '✅ Previously found'
    btn.textContent = '🔄 Re-check Email (uses 1 lookup)'
    btn.classList.remove('btn-primary')
    btn.classList.add('btn-ghost')
  } else {
    document.getElementById('found-email-confidence').textContent = '✅ Found via FullEnrich'
  }
}

async function setupEmailTab(profile) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ?? ''
  const isLinkedIn = url.includes('linkedin.com/in/') ||
    url.includes('linkedin.com/talent/') ||
    url.includes('linkedin.com/recruiter/')

  if (!isLinkedIn) {
    document.getElementById('state-not-linkedin').style.display = 'block'
    document.getElementById('state-email').style.display = 'none'
    return
  }

  document.getElementById('state-not-linkedin').style.display = 'none'
  document.getElementById('state-email').style.display = 'block'

  // ── Job context ────────────────────────────────────────────────────────────
  const jobData = await getStorage(['job_title', 'job_company', 'job_description'])
  if (jobData.job_title) {
    document.getElementById('email-job-context').style.display = 'block'
    document.getElementById('active-job-title').textContent = jobData.job_title
    document.getElementById('active-job-company').textContent = jobData.job_company || ''
  } else {
    document.getElementById('email-no-job').style.display = 'block'
  }
  document.getElementById('link-change-job')?.addEventListener('click', e => {
    e.preventDefault()
    document.querySelector('.tab[data-tab="job"]').click()
  })
  document.getElementById('link-add-job')?.addEventListener('click', e => {
    e.preventDefault()
    document.querySelector('.tab[data-tab="job"]').click()
  })

  // ── Candidate summary row ──────────────────────────────────────────────────
  const loadingEl = document.getElementById('email-profile-loading')
  const candidateRow = document.getElementById('email-candidate-row')
  const errorEl = document.getElementById('email-profile-error')

  loadingEl.style.display = 'block'
  loadingEl.classList.add('show')

  if (!profile?.fullName) {
    loadingEl.style.display = 'none'
    errorEl.style.display = 'block'
    return
  }

  loadingEl.style.display = 'none'
  candidateRow.style.display = 'flex'
  document.getElementById('email-avatar').textContent = initials(profile.fullName)
  document.getElementById('email-cand-name').textContent = profile.fullName
  const meta = [profile.title, profile.company].filter(Boolean).join(' · ')
  document.getElementById('email-cand-meta').textContent = meta || '—'

  // "View →" switches to Profile tab
  document.getElementById('btn-view-profile')?.addEventListener('click', () => {
    document.querySelector('.tab[data-tab="profile"]').click()
  })

  if (!await isLoggedIn()) {
    const btn = document.getElementById('btn-find-email')
    btn.textContent = 'Sign in to look up emails'
    btn.disabled = true
    return
  }

  // ── Cache check ────────────────────────────────────────────────────────────
  const cacheKey = `email_cache_${profile.linkedinUrl}`
  const draftKey = `draft_cache_${profile.linkedinUrl}`
  const cached = await getStorage([cacheKey])
  const cachedResult = cached[cacheKey]

  if (cachedResult?.email) {
    displayEmailResult(cachedResult.email, 'cached')
    const draftCached = await getStorage([draftKey])
    if (draftCached[draftKey]?.draft) {
      showDraft(draftCached[draftKey].draft, draftCached[draftKey].subject)
    } else {
      await generateDraft(profile)
    }
  } else if (profile.linkedinUrl) {
    const statusEl = document.getElementById('email-status')
    showStatus(statusEl, 'Checking for previous lookup…', 'info')
    try {
      const serverResult = await lookupEmail(
        profile.firstName, profile.lastName, profile.linkedinUrl, profile.company, true
      )
      if (serverResult.found && serverResult.email) {
        displayEmailResult(serverResult.email, 'cached')
        await setStorage({ [cacheKey]: { email: serverResult.email, source: 'cache', timestamp: Date.now() } })
        hideStatus(statusEl)
        await generateDraft(profile)
      } else {
        hideStatus(statusEl)
      }
    } catch { hideStatus(statusEl) }
  }

  // ── Find email button ──────────────────────────────────────────────────────
  document.getElementById('btn-find-email').addEventListener('click', async () => {
    const btn = document.getElementById('btn-find-email')
    const statusEl = document.getElementById('email-status')
    btn.disabled = true
    showStatus(statusEl, 'Looking up email…', 'info')
    try {
      const result = await lookupEmail(
        profile.firstName, profile.lastName, profile.linkedinUrl, profile.company
      )
      if (result.found && result.email) {
        displayEmailResult(result.email, result.source)
        await setStorage({ [cacheKey]: { email: result.email, source: result.source, timestamp: Date.now() } })
        hideStatus(statusEl)
        await generateDraft(profile)
      } else {
        document.getElementById('email-not-found').style.display = 'block'
        showStatus(statusEl, 'Not found — enter email manually.', 'info')
      }
    } catch (e) {
      let msg = 'Lookup failed. Try again.'
      if (e.message === 'Not signed in') msg = 'Please sign in first.'
      else if (e.message?.includes('Credit limit') || e.message?.includes('402'))
        msg = 'Credit limit reached. Upgrade your plan.'
      showStatus(statusEl, msg, 'error')
    }
    btn.disabled = false
    await loadCreditsUI()
  })

  document.getElementById('btn-regenerate')?.addEventListener('click', () => generateDraft(profile))

  document.getElementById('btn-open-gmail')?.addEventListener('click', () => {
    const draft = document.getElementById('email-draft').value.trim()
    const toEmail = document.getElementById('found-email')?.textContent?.trim()
    const to = (toEmail && toEmail !== '—') ? toEmail : ''
    const subject = encodeURIComponent(
      document.getElementById('email-draft')?.dataset?.subject ||
      `Exciting opportunity for ${profile?.firstName || 'you'}`
    )
    chrome.tabs.create({
      url: `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${encodeURIComponent(draft)}`
    })
  })
}

function showDraft(draftText, subject) {
  document.getElementById('card-draft').style.display = 'block'
  document.getElementById('email-draft').value = draftText
  if (subject) document.getElementById('email-draft').dataset.subject = subject
}

async function generateDraft(profile) {
  const statusEl = document.getElementById('draft-status')
  document.getElementById('card-draft').style.display = 'block'
  showStatus(statusEl, 'Generating personalized email…', 'info')

  try {
    const storage = await getStorage(['job_title', 'job_company', 'job_description', 'pref_your_name', 'pref_your_title'])
    const job = {
      title: storage.job_title || '',
      company: storage.job_company || '',
      description: storage.job_description || '',
    }
    const recruiter = {
      name: storage.pref_your_name || '',
      title: storage.pref_your_title || '',
    }
    const result = await apiGenerateDraft(profile, job, recruiter)
    if (result.draft) {
      showDraft(result.draft, result.subject)
      if (profile.linkedinUrl) {
        await setStorage({
          [`draft_cache_${profile.linkedinUrl}`]: {
            draft: result.draft, subject: result.subject || '', timestamp: Date.now()
          }
        })
      }
      showStatus(statusEl, 'Draft ready!', 'success')
      setTimeout(() => hideStatus(statusEl), 2500)
    } else {
      showStatus(statusEl, 'No draft returned. Try regenerating.', 'error')
    }
  } catch (e) {
    let msg = 'Failed to generate draft.'
    if (e.message?.includes('503') || e.message?.includes('not configured'))
      msg = 'AI service not configured.'
    else if (e.message?.includes('429') || e.message?.includes('rate limit'))
      msg = 'AI rate limit hit. Wait a moment and regenerate.'
    showStatus(statusEl, msg, 'error')
  }
}

// ── Profile tab ───────────────────────────────────────────────────────────────
function setupProfileTab(profile) {
  const [tab] = [document.querySelector('.tab[data-tab="profile"]')]

  const showNotLinkedIn = () => {
    document.getElementById('profile-not-linkedin').style.display = 'block'
    document.getElementById('profile-data-view').style.display = 'none'
    document.getElementById('profile-loading-state').style.display = 'none'
    document.getElementById('profile-error-state').style.display = 'none'
  }
  const showError = () => {
    document.getElementById('profile-not-linkedin').style.display = 'none'
    document.getElementById('profile-data-view').style.display = 'none'
    document.getElementById('profile-loading-state').style.display = 'none'
    document.getElementById('profile-error-state').style.display = 'block'
  }
  const showData = (p) => {
    document.getElementById('profile-not-linkedin').style.display = 'none'
    document.getElementById('profile-error-state').style.display = 'none'
    document.getElementById('profile-loading-state').style.display = 'none'
    document.getElementById('profile-data-view').style.display = 'block'

    document.getElementById('prof-name').textContent = p.fullName || '—'
    document.getElementById('prof-title').textContent = p.title || '—'
    document.getElementById('prof-company').textContent = p.company || '—'
    const urlEl = document.getElementById('prof-url')
    if (p.linkedinUrl) {
      urlEl.innerHTML = `<a href="${p.linkedinUrl}" target="_blank">${p.linkedinUrl.replace('https://', '')}</a>`
    } else {
      urlEl.textContent = '—'
    }

    // Experience list
    if (p.experience?.length) {
      const card = document.getElementById('prof-experience-card')
      const list = document.getElementById('prof-experience-list')
      list.innerHTML = p.experience.map(exp => `
        <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #f3f4f6;">
          <div style="font-size:13px;font-weight:600;color:#111827;">${exp.title || ''}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:1px;">${exp.company || ''}${exp.dates ? ' · ' + exp.dates : ''}</div>
        </div>
      `).join('')
      // Remove last border
      const items = list.querySelectorAll('div')
      if (items.length) items[items.length - 1].style.borderBottom = 'none'
      card.style.display = 'block'
    }
  }

  // Check if we're on LinkedIn
  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    const url = activeTab?.url ?? ''
    const isLinkedIn = url.includes('linkedin.com/in/') ||
      url.includes('linkedin.com/talent/') ||
      url.includes('linkedin.com/recruiter/')
    if (!isLinkedIn) { showNotLinkedIn(); return }
    if (!profile) { showError(); return }
    showData(profile)
  })

  // Re-scrape button
  document.getElementById('btn-rescrape')?.addEventListener('click', async () => {
    document.getElementById('profile-loading-state').style.display = 'block'
    document.getElementById('profile-data-view').style.display = 'none'
    const fresh = await scrapeCurrentProfile()
    if (fresh) showData(fresh)
    else showError()
  })
}

// ── Job tab ───────────────────────────────────────────────────────────────────
function setupJobTab() {
  getStorage(['job_title', 'job_company', 'job_description', 'job_url']).then(d => {
    if (d.job_title) document.getElementById('job-title').value = d.job_title
    if (d.job_company) document.getElementById('job-company').value = d.job_company
    if (d.job_description) document.getElementById('job-description').value = d.job_description
    if (d.job_url) document.getElementById('job-url').value = d.job_url
  })

  document.getElementById('btn-extract-job').addEventListener('click', async () => {
    const url = document.getElementById('job-url').value.trim()
    const statusEl = document.getElementById('extract-status')
    if (!url) { showStatus(statusEl, 'Paste a job posting URL first.', 'error'); return }
    if (!url.startsWith('http')) { showStatus(statusEl, 'Please enter a valid URL starting with http.', 'error'); return }
    const btn = document.getElementById('btn-extract-job')
    btn.disabled = true
    showStatus(statusEl, 'Opening job page and extracting…', 'info')
    try {
      const jobTab = await chrome.tabs.create({ url, active: false })
      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === jobTab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener)
            resolve()
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
        setTimeout(resolve, 15000)
      })
      await new Promise(r => setTimeout(r, 1500))
      let pageText = ''
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: jobTab.id },
          func: () => document.body?.innerText ?? '',
        })
        pageText = results?.[0]?.result ?? ''
      } catch {}
      chrome.tabs.remove(jobTab.id).catch(() => {})
      if (!pageText) { showStatus(statusEl, 'Could not read that page. Try pasting details manually.', 'error'); btn.disabled = false; return }
      const jobData = await extractJob(pageText.slice(0, 12000))
      if (jobData?.title) document.getElementById('job-title').value = jobData.title
      if (jobData?.company) document.getElementById('job-company').value = jobData.company
      if (jobData?.description) document.getElementById('job-description').value = jobData.description
      showStatus(statusEl, 'Job details extracted!', 'success')
    } catch (e) {
      showStatus(statusEl, `Extraction failed: ${e.message}`, 'error')
    }
    btn.disabled = false
  })

  document.getElementById('btn-save-job').addEventListener('click', async () => {
    const statusEl = document.getElementById('job-status')
    const title = document.getElementById('job-title').value.trim()
    const company = document.getElementById('job-company').value.trim()
    const desc = document.getElementById('job-description').value.trim()
    const url = document.getElementById('job-url').value.trim()
    if (!title) { showStatus(statusEl, 'Add a role title first.', 'error'); return }
    await setStorage({ job_title: title, job_company: company, job_description: desc, job_url: url })
    showStatus(statusEl, 'Job saved!', 'success')
    setTimeout(() => hideStatus(statusEl), 2000)
  })
}

// ── Settings tab ──────────────────────────────────────────────────────────────
async function setupSettingsTab(user) {
  if (user?.email) document.getElementById('settings-email').textContent = user.email

  try {
    const credits = await getCredits()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max = CONFIG.tiers[tier]?.lookups ?? 10
    const badge = document.getElementById('settings-plan-badge')
    badge.textContent = CONFIG.tiers[tier]?.label ?? 'Free'
    badge.className = `plan-badge${tier === 'free' ? ' free' : ''}`
    document.getElementById('settings-lookups').textContent = `${used} / ${max}`
  } catch {}

  document.getElementById('btn-upgrade').addEventListener('click', () => createCheckout())
  document.getElementById('btn-sign-out').addEventListener('click', async () => {
    await signOut()
    showLoginScreen()
  })

  // ── Theme control ──────────────────────────────────────────────────────────
  const prefs = await getStorage(['pref_theme', 'pref_dark_mode'])
  const savedTheme = prefs.pref_theme || (prefs.pref_dark_mode ? 'dark' : 'system')
  applyTheme(savedTheme)

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.theme
      await setStorage({ pref_theme: theme })
      applyTheme(theme)
    })
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) { showLoginScreen(); return }
  const user = await getUser()
  await showMainApp(user)
}

init()
