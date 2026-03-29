// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCredits } from './core/credits.js'
import { createCheckout, lookupEmail, generateDraft as apiGenerateDraft } from './core/api.js'

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

  document.getElementById('btn-find-email').addEventListener('click', async () => {
    const btn = document.getElementById('btn-find-email')
    const statusEl = document.getElementById('email-status')
    btn.disabled = true
    showStatus(statusEl, 'Looking up email...', 'info')

    try {
      const result = await lookupEmail(profile.firstName, profile.lastName, profile.linkedinUrl, profile.company)

      if (result.found && result.email) {
        document.getElementById('email-found').style.display = 'block'
        document.getElementById('found-email').textContent = result.email
        const sourceLabel = result.source === 'cache' ? '✅ Cached (no credit used)' : '✅ via FullEnrich'
        document.getElementById('found-email-confidence').textContent = sourceLabel
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
      showStatus(statusEl, 'Draft generated!', 'success')
      setTimeout(() => hideStatus(statusEl), 3000)
    } else {
      showStatus(statusEl, 'No draft returned. Try again.', 'error')
    }
  } catch (e) {
    console.error('generate-draft error:', e)
    const errMsg = e.message?.includes('503') || e.message?.includes('not configured')
      ? 'AI service not configured. Set GEMINI_API_KEY in Supabase secrets.'
      : 'Failed to generate draft. Try again.'
    showStatus(statusEl, errMsg, 'error')
  }
}

function setupJobTab() {
  getStorage(['job_title', 'job_company', 'job_description']).then(d => {
    if (d.job_title) document.getElementById('job-title').value = d.job_title
    if (d.job_company) document.getElementById('job-company').value = d.job_company
    if (d.job_description) document.getElementById('job-description').value = d.job_description
  })
  document.getElementById('btn-save-job').addEventListener('click', async () => {
    const statusEl = document.getElementById('job-status')
    await setStorage({
      job_title: document.getElementById('job-title').value.trim(),
      job_company: document.getElementById('job-company').value.trim(),
      job_description: document.getElementById('job-description').value.trim(),
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