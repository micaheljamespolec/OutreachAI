// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, getUser, signOut } from './core/auth.js'
import { getCredits, deductCredit, completeBonusActivity } from './core/credits.js'
import { createCheckout } from './core/api.js'

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(el, msg, type = 'info') {
  el.textContent  = msg
  el.className    = `status ${type} show`
}
function hideStatus(el) {
  el.textContent = ''
  el.className   = 'status'
}
function getStorage(keys) {
  return new Promise(r => chrome.storage.local.get(keys, r))
}
function setStorage(obj) {
  return new Promise(r => chrome.storage.local.set(obj, r))
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
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

// ── Login ─────────────────────────────────────────────────────────────────────
function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'block'
  document.getElementById('main-app').style.display     = 'none'

  const statusEl = document.getElementById('login-status')

  document.getElementById('btn-send-magic-link').addEventListener('click', async () => {
    const email = document.getElementById('login-email').value.trim()
    if (!email) { showStatus(statusEl, 'Please enter your email.', 'error'); return }
    showStatus(statusEl, 'Sending magic link…', 'info')
    const { error } = await sendMagicLink(email)
    if (error) { showStatus(statusEl, `Error: ${error.message}`, 'error'); return }
    showStatus(statusEl, '✅ Check your email for the magic link!', 'success')
  })
}

// ── Main App ──────────────────────────────────────────────────────────────────
async function showMainApp(user) {
  document.getElementById('login-screen').style.display = 'none'
  document.getElementById('main-app').style.display     = 'block'
  setupTabs()
  await loadCreditsUI()
  await setupEmailTab()
  setupJobTab()
  await setupSettingsTab(user)
}

// ── Credits UI ────────────────────────────────────────────────────────────────
async function loadCreditsUI() {
  try {
    const credits = await getCredits()
    const tier    = credits?.tier ?? 'free'
    const used    = credits?.lookups_used ?? 0
    const max     = CONFIG.tiers[tier]?.lookups ?? 10
    document.getElementById('header-credits').textContent = `${used} / ${max} lookups`
  } catch {
    document.getElementById('header-credits').textContent = '— / — lookups'
  }
}

// ── Email Tab ─────────────────────────────────────────────────────────────────
async function setupEmailTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url   = tab?.url ?? ''

  const isLinkedIn = url.includes('linkedin.com/in/') ||
                     url.includes('linkedin.com/talent/') ||
                     url.includes('linkedin.com/recruiter/')

  if (!isLinkedIn) {
    document.getElementById('state-not-linkedin').style.display = 'block'
    document.getElementById('state-email').style.display        = 'none'
    return
  }

  document.getElementById('state-not-linkedin').style.display = 'none'
  document.getElementById('state-email').style.display        = 'block'

  const profileLoading = document.getElementById('profile-loading')
  const profileData    = document.getElementById('profile-data')
  const profileError   = document.getElementById('profile-error')

  let profile = null
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Wait for an element to appear, then scrape
        return new Promise(resolve => {
          let attempts = 0

          function scrape() {
            attempts++

            function getText(selectors) {
              for (const sel of selectors) {
                try {
                  const els = document.querySelectorAll(sel)
                  for (const el of els) {
                    const text = el?.innerText?.trim()
                    // Skip empty, very short, or navigation text
                    if (text && text.length > 1 && text.length < 200) return text
                  }
                } catch {}
              }
              return ''
            }

            // Name — h1 is always present on LinkedIn profiles
            const fullName = getText(['h1'])
            const nameParts = (fullName || '').trim().split(/\s+/)
            const firstName = nameParts[0] || ''
            const lastName  = nameParts.slice(1).join(' ') || ''

            // Title — the headline below the name
            const title = getText([
              '.text-body-medium.break-words',
              '.text-body-medium',
            ])

            // Company — from right panel details
            const company = getText([
              '.pv-text-details__right-panel .hoverable-link-text span',
              'button[aria-label*="Current company"] span',
              '[aria-label*="Current company"]',
              '.pv-top-card--experience-list-item',
            ])

            // If name found, return result
            if (fullName) {
              resolve({ fullName, firstName, lastName, title, company, linkedinUrl: window.location.href.split('?')[0] })
            } else if (attempts < 5) {
              // Retry after 800ms if page not ready yet
              setTimeout(scrape, 800)
            } else {
              resolve({ fullName: '', firstName: '', lastName: '', title: '', company: '', linkedinUrl: window.location.href.split('?')[0] })
            }
          }

          scrape()
        })
      }
    })

    profile = results?.[0]?.result
    if (!profile?.fullName) throw new Error('No name found')

    profileLoading.classList.remove('show')
    profileData.style.display = 'block'
    document.getElementById('p-name').textContent    = profile.fullName || '—'
    document.getElementById('p-title').textContent   = profile.title   || '—'
    document.getElementById('p-company').textContent = profile.company  || '—'
  } catch {
    profileLoading.classList.remove('show')
    profileError.style.display = 'block'
  }

  // Find email button
  document.getElementById('btn-find-email').addEventListener('click', async () => {
    const btn      = document.getElementById('btn-find-email')
    const statusEl = document.getElementById('email-status')
    if (!profile) { showStatus(statusEl, 'No profile loaded.', 'error'); return }
    btn.disabled = true
    showStatus(statusEl, 'Looking up email…', 'info')
    const ok = await deductCredit()
    if (!ok) {
      showStatus(statusEl, 'No lookups remaining. Please upgrade.', 'error')
      btn.disabled = false
      return
    }
    showStatus(statusEl, '⚠️ Email API not yet configured.', 'error')
    btn.disabled = false
    await loadCreditsUI()
  })

  document.getElementById('btn-regenerate')?.addEventListener('click', () => generateDraft(profile))

  document.getElementById('btn-open-gmail')?.addEventListener('click', () => {
    const draft   = document.getElementById('email-draft').value.trim()
    const toEmail = document.getElementById('found-email')?.textContent?.trim()
    const to      = (toEmail && toEmail !== '—') ? toEmail : ''
    const subject = encodeURIComponent(`Exciting opportunity for ${profile?.firstName || 'you'}`)
    const body    = encodeURIComponent(draft)
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${to}&su=${subject}&body=${body}` })
  })
}

// ── AI Draft ──────────────────────────────────────────────────────────────────
async function generateDraft(profile) {
  const statusEl = document.getElementById('draft-status')
  document.getElementById('card-draft').style.display = 'block'
  showStatus(statusEl, '⚠️ AI not yet configured — add your API key in Settings.', 'error')
}

// ── Job Tab ───────────────────────────────────────────────────────────────────
function setupJobTab() {
  getStorage(['job_title', 'job_company', 'job_description']).then(d => {
    if (d.job_title)       document.getElementById('job-title').value       = d.job_title
    if (d.job_company)     document.getElementById('job-company').value     = d.job_company
    if (d.job_description) document.getElementById('job-description').value = d.job_description
  })
  document.getElementById('btn-save-job').addEventListener('click', async () => {
    const statusEl = document.getElementById('job-status')
    await setStorage({
      job_title:       document.getElementById('job-title').value.trim(),
      job_company:     document.getElementById('job-company').value.trim(),
      job_description: document.getElementById('job-description').value.trim(),
    })
    showStatus(statusEl, '✅ Job saved!', 'success')
    setTimeout(() => hideStatus(statusEl), 2000)
  })
}

// ── Settings Tab ──────────────────────────────────────────────────────────────
async function setupSettingsTab(user) {
  document.getElementById('settings-email').textContent = user?.email ?? '—'

  try {
    const credits = await getCredits()
    const tier    = credits?.tier ?? 'free'
    const used    = credits?.lookups_used ?? 0
    const max     = CONFIG.tiers[tier]?.lookups ?? 10
    document.getElementById('settings-plan').textContent       = CONFIG.tiers[tier]?.label ?? 'Free'
    document.getElementById('settings-plan-badge').textContent = CONFIG.tiers[tier]?.label ?? 'Free'
    document.getElementById('settings-lookups').textContent    = `${used} / ${max}`
  } catch {}

  const prefs = await getStorage(['pref_your_name', 'pref_your_title'])
  if (prefs.pref_your_name)  document.getElementById('pref-your-name').value  = prefs.pref_your_name
  if (prefs.pref_your_title) document.getElementById('pref-your-title').value = prefs.pref_your_title

  document.getElementById('btn-save-prefs').addEventListener('click', async () => {
    const statusEl = document.getElementById('prefs-status')
    await setStorage({
      pref_your_name:  document.getElementById('pref-your-name').value.trim(),
      pref_your_title: document.getElementById('pref-your-title').value.trim(),
    })
    showStatus(statusEl, '✅ Saved!', 'success')
    setTimeout(() => hideStatus(statusEl), 2000)
  })

  document.getElementById('btn-upgrade').addEventListener('click', () => createCheckout())
  document.getElementById('btn-sign-out').addEventListener('click', async () => {
    await signOut()
    document.getElementById('main-app').style.display     = 'none'
    document.getElementById('login-screen').style.display = 'block'
    showLoginScreen()
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) { showLoginScreen(); return }
  const user = await getUser()
  await showMainApp(user)
})