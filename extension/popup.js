// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCredits } from './core/credits.js'
import { createCheckout, lookupEmail, generateDraft as apiGenerateDraft, extractJob } from './core/api.js'

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

function displayEmailResult(email, source) {
  document.getElementById('email-found').style.display = 'block'
  document.getElementById('found-email').textContent = email
  const btn = document.getElementById('btn-find-email')
  if (source === 'cached' || source === 'cache') {
    document.getElementById('found-email-confidence').textContent = '✅ Previously found'
    // Keep button clickable for re-check, but make it secondary
    btn.textContent = '🔄 Re-check Email (uses 1 lookup)'
    btn.classList.remove('btn-primary')
    btn.classList.add('btn-secondary')
  } else {
    document.getElementById('found-email-confidence').textContent = '✅ Found via FullEnrich'
  }
}

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

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'block'
  document.getElementById('main-app').style.display = 'none'
  const statusEl = document.getElementById('login-status')
  document.getElementById('btn-send-magic-link').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim()
    if (!email) { showStatus(statusEl, 'Please enter your email.', 'error'); return }
    showStatus(statusEl, 'Sending magic link...', 'info')
    const { error } = await sendMagicLink(email)
    if (error) { showStatus(statusEl, `Error: ${error.message}`, 'error'); return }
    showStatus(statusEl, 'Check your email for the magic link!', 'success')
  })
  document.getElementById('btn-google-signin').addEventListener('click', () => {
    signInWithGoogle()
  })
}

async function showMainApp(user) {
  document.getElementById('login-screen').style.display = 'none'
  document.getElementById('main-app').style.display = 'block'
  setupTabs()
  await loadCreditsUI()
  await setupEmailTab()
  setupJobTab()
  await setupSettingsTab(user)
}

async function loadCreditsUI() {
  try {
    const credits = await getCredits()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max = CONFIG.tiers[tier]?.lookups ?? 10
    document.getElementById('header-credits').textContent = `${used} / ${max} lookups`
  } catch {
    document.getElementById('header-credits').textContent = '- / - lookups'
  }
}


async function setupEmailTab() {
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

  // ── Show active job context on Email tab ────────────────────────────────
  const jobData = await getStorage(['job_title', 'job_company', 'job_description'])
  if (jobData.job_title) {
    document.getElementById('card-active-job').style.display = 'block'
    document.getElementById('active-job-title').textContent = jobData.job_title
    document.getElementById('active-job-company').textContent = jobData.job_company || ''
    const desc = jobData.job_description || ''
    document.getElementById('active-job-desc').textContent = desc.length > 120 ? desc.slice(0, 120) + '...' : desc
  } else {
    document.getElementById('card-no-job').style.display = 'block'
  }
  // "Change job" and "Go to Job tab" links switch to the Job tab
  document.getElementById('link-change-job')?.addEventListener('click', (e) => {
    e.preventDefault()
    document.querySelector('.tab[data-tab="job"]').click()
  })
  document.getElementById('link-add-job')?.addEventListener('click', (e) => {
    e.preventDefault()
    document.querySelector('.tab[data-tab="job"]').click()
  })

  if (!await isLoggedIn()) {
    document.getElementById('profile-loading').classList.remove('show')
    const errEl = document.getElementById('profile-error')
    errEl.textContent = 'Sign in to look up emails'
    errEl.style.display = 'block'
    return
  }

  const profileLoading = document.getElementById('profile-loading')
  const profileData = document.getElementById('profile-data')
  const profileError = document.getElementById('profile-error')

  let profile = null

  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: 'scrape' })
    if (data?.fullName) profile = data
  } catch(e) {}

  profileLoading.classList.remove('show')

  if (!profile?.fullName) {
    profileError.style.display = 'block'
    return
  }

  profileData.style.display = 'block'
  document.getElementById('p-name').textContent = profile.fullName || '-'
  document.getElementById('p-title').textContent = profile.title || '-'
  document.getElementById('p-company').textContent = profile.company || '-'

  // ── Check for previously looked-up email ──────────────────────────────
  const cacheKey = `email_cache_${profile.linkedinUrl}`
  const draftKey = `draft_cache_${profile.linkedinUrl}`
  const cached = await getStorage([cacheKey])
  const cachedResult = cached[cacheKey]

  if (cachedResult?.email) {
    // Local cache hit — show instantly
    displayEmailResult(cachedResult.email, 'cached')
    const draftCached = await getStorage([draftKey])
    if (draftCached[draftKey]?.draft) {
      document.getElementById('card-draft').style.display = 'block'
      document.getElementById('email-draft').value = draftCached[draftKey].draft
      if (draftCached[draftKey].subject) {
        document.getElementById('email-draft').dataset.subject = draftCached[draftKey].subject
      }
    } else {
      // Email cached but no draft yet — auto-generate
      await generateDraft(profile)
    }
  } else if (profile.linkedinUrl) {
    // No local cache — check server cache only (no FullEnrich call, no credit used)
    const statusEl = document.getElementById('email-status')
    showStatus(statusEl, 'Checking for previous lookup...', 'info')
    try {
      const serverResult = await lookupEmail(profile.firstName, profile.lastName, profile.linkedinUrl, profile.company, true)
      if (serverResult.found && serverResult.email) {
        displayEmailResult(serverResult.email, 'cached')
        await setStorage({ [cacheKey]: { email: serverResult.email, source: 'cache', timestamp: Date.now() } })
        hideStatus(statusEl)
        // Auto-generate draft for cached email
        await generateDraft(profile)
      } else {
        hideStatus(statusEl)
      }
    } catch (e) {
      hideStatus(statusEl)
    }
  }

  document.getElementById('btn-find-email').addEventListener('click', async () => {
    const btn = document.getElementById('btn-find-email')
    const statusEl = document.getElementById('email-status')
    btn.disabled = true
    showStatus(statusEl, 'Looking up email...', 'info')

    try {
      const result = await lookupEmail(profile.firstName, profile.lastName, profile.linkedinUrl, profile.company)

      if (result.found && result.email) {
        displayEmailResult(result.email, result.source)
        // Save to local cache so popup remembers on reopen
        await setStorage({ [cacheKey]: { email: result.email, source: result.source, timestamp: Date.now() } })
        hideStatus(statusEl)
        // Auto-generate a draft after successful email lookup
        await generateDraft(profile)
      } else {
        document.getElementById('email-not-found').style.display = 'block'
        const manualInput = document.createElement('input')
        manualInput.type = 'email'
        manualInput.id = 'manual-email'
        manualInput.placeholder = 'Enter email manually'
        manualInput.style.marginTop = '8px'
        document.getElementById('email-not-found').after(manualInput)
        showStatus(statusEl, 'Not found — enter manually above.', 'info')
      }
    } catch(e) {
      let msg = 'Lookup failed. Try again.'
      if (e.message === 'Not signed in') msg = 'Please sign in first'
      else if (e.message?.includes('Credit limit')) msg = 'Credit limit reached. Upgrade your plan for more lookups.'
      else if (e.message?.includes('402')) msg = 'Credit limit reached. Upgrade your plan for more lookups.'
      showStatus(statusEl, msg, 'error')
    }

    btn.disabled = false
    await loadCreditsUI()
  })

  document.getElementById('btn-regenerate')?.addEventListener('click', () => generateDraft(profile))

  document.getElementById('btn-open-gmail')?.addEventListener('click', () => {
    const draft = document.getElementById('email-draft').value.trim()
    const toEmail = document.getElementById('found-email')?.textContent?.trim()
    const manualEmail = document.getElementById('manual-email')?.value?.trim()
    const to = (toEmail && toEmail !== '-') ? toEmail : (manualEmail || '')
    const aiSubject = document.getElementById('email-draft')?.dataset?.subject
    const subject = encodeURIComponent(aiSubject || `Exciting opportunity for ${profile?.firstName || 'you'}`)
    const body = encodeURIComponent(draft)
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${body}` })
  })
}

async function generateDraft(profile) {
  const statusEl = document.getElementById('draft-status')
  document.getElementById('card-draft').style.display = 'block'
  showStatus(statusEl, 'Generating personalized email...', 'info')

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
      document.getElementById('email-draft').value = result.draft
      if (result.subject) {
        document.getElementById('email-draft').dataset.subject = result.subject
      }
      // Cache the draft locally so it survives popup close/reopen
      if (profile.linkedinUrl) {
        const draftKey = `draft_cache_${profile.linkedinUrl}`
        await setStorage({ [draftKey]: { draft: result.draft, subject: result.subject || '', timestamp: Date.now() } })
      }
      showStatus(statusEl, 'Draft generated!', 'success')
      setTimeout(() => hideStatus(statusEl), 3000)
    } else {
      showStatus(statusEl, 'No draft returned. Try again.', 'error')
    }
  } catch (e) {
    console.error('generate-draft error:', e)
    let errMsg = 'Failed to generate draft. Try again.'
    if (e.message?.includes('503') || e.message?.includes('not configured')) {
      errMsg = 'AI service not configured. Set GEMINI_API_KEY in Supabase secrets.'
    } else if (e.message?.includes('429') || e.message?.includes('rate limit')) {
      errMsg = 'AI rate limit reached. Wait a moment and click Regenerate.'
    }
    showStatus(statusEl, errMsg, 'error')
  }
}

function setupJobTab() {
  getStorage(['job_title', 'job_company', 'job_description', 'job_url']).then(d => {
    if (d.job_title) document.getElementById('job-title').value = d.job_title
    if (d.job_company) document.getElementById('job-company').value = d.job_company
    if (d.job_description) document.getElementById('job-description').value = d.job_description
    if (d.job_url) document.getElementById('job-url').value = d.job_url
  })

  // Extract job details from URL
  document.getElementById('btn-extract-job').addEventListener('click', async () => {
    const url = document.getElementById('job-url').value.trim()
    const statusEl = document.getElementById('extract-status')
    if (!url) { showStatus(statusEl, 'Paste a job posting URL first.', 'error'); return }
    if (!url.startsWith('http')) { showStatus(statusEl, 'Please enter a valid URL starting with http.', 'error'); return }

    const btn = document.getElementById('btn-extract-job')
    btn.disabled = true
    showStatus(statusEl, 'Opening job page and extracting...', 'info')

    try {
      // Open the URL in a background tab and extract the rendered text
      const tab = await chrome.tabs.create({ url, active: false })
      
      // Wait for the page to load (JS-rendered pages need time)
      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener)
            resolve()
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
        // Timeout after 15s
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve() }, 15000)
      })

      // Give JS-rendered pages a bit more time to populate content
      await new Promise(r => setTimeout(r, 3000))

      // Extract text from the tab
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body.innerText?.slice(0, 8000) || '',
      })
      const pageText = results?.[0]?.result || ''

      // Close the background tab
      chrome.tabs.remove(tab.id).catch(() => {})

      if (!pageText || pageText.length < 50) {
        showStatus(statusEl, 'Could not read page content. Try entering manually.', 'error')
        btn.disabled = false
        return
      }

      showStatus(statusEl, 'Analyzing job posting with AI...', 'info')

      const result = await extractJob(pageText)
      if (result.title) document.getElementById('job-title').value = result.title
      if (result.company) document.getElementById('job-company').value = result.company
      if (result.description) document.getElementById('job-description').value = result.description

      // Auto-save
      await setStorage({
        job_title: result.title || '',
        job_company: result.company || '',
        job_description: result.description || '',
        job_url: url,
      })

      showStatus(statusEl, 'Job details extracted and saved!', 'success')
      setTimeout(() => hideStatus(statusEl), 3000)
    } catch (e) {
      let msg = 'Could not extract job details. Try entering manually.'
      try {
        const parsed = JSON.parse(e.message)
        if (parsed.error) msg = parsed.error
      } catch {}
      showStatus(statusEl, msg, 'error')
    }
    btn.disabled = false
  })

  // Save job manually
  document.getElementById('btn-save-job').addEventListener('click', async () => {
    const statusEl = document.getElementById('job-status')
    await setStorage({
      job_title: document.getElementById('job-title').value.trim(),
      job_company: document.getElementById('job-company').value.trim(),
      job_description: document.getElementById('job-description').value.trim(),
      job_url: document.getElementById('job-url').value.trim(),
    })
    showStatus(statusEl, 'Job saved!', 'success')
    setTimeout(() => hideStatus(statusEl), 2000)
  })
}

async function setupSettingsTab(user) {
  document.getElementById('settings-email').textContent = user?.email ?? '-'
  try {
    const credits = await getCredits()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max = CONFIG.tiers[tier]?.lookups ?? 10
    document.getElementById('settings-plan').textContent = CONFIG.tiers[tier]?.label ?? 'Free'
    document.getElementById('settings-plan-badge').textContent = CONFIG.tiers[tier]?.label ?? 'Free'
    document.getElementById('settings-lookups').textContent = `${used} / ${max}`
  } catch {}

  const prefs = await getStorage(['pref_your_name', 'pref_your_title'])
  if (prefs.pref_your_name) document.getElementById('pref-your-name').value = prefs.pref_your_name
  if (prefs.pref_your_title) document.getElementById('pref-your-title').value = prefs.pref_your_title

  document.getElementById('btn-save-prefs').addEventListener('click', async () => {
    const statusEl = document.getElementById('prefs-status')
    await setStorage({
      pref_your_name: document.getElementById('pref-your-name').value.trim(),
      pref_your_title: document.getElementById('pref-your-title').value.trim(),
    })
    showStatus(statusEl, 'Saved!', 'success')
    setTimeout(() => hideStatus(statusEl), 2000)
  })

  document.getElementById('btn-upgrade').addEventListener('click', () => createCheckout())
  document.getElementById('btn-sign-out').addEventListener('click', async () => {
    await signOut()
    document.getElementById('main-app').style.display = 'none'
    document.getElementById('login-screen').style.display = 'block'
    showLoginScreen()
  })
}

document.addEventListener('DOMContentLoaded', async () => {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) { showLoginScreen(); return }
  const user = await getUser()
  await showMainApp(user)
})