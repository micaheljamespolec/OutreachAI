// ─── content.js — minimal name capture only ───────────────────────────────────
// Captures ONLY: full_name (from visible page heading) and source_surface.
// No company, title, skills, experience, about, or deep DOM traversal.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false
  sendResponse(captureMinimal())
  return false
})

function captureMinimal() {
  const url = window.location.href
  const isRecruiter = url.includes('/talent/') || url.includes('/recruiter/')
  const source_surface = isRecruiter ? 'linkedin_recruiter' : 'linkedin_profile'

  // Name: smallest reliable selector chain
  let full_name = ''

  if (isRecruiter) {
    // Recruiter DOM uses data-anonymize attribute
    full_name = document.querySelector('[data-anonymize="person-name"]')?.innerText?.trim() || ''
  }

  if (!full_name) {
    // Standard profile: h1 is the candidate name
    full_name = document.querySelector('h1')?.innerText?.trim() || ''
  }

  if (!full_name) {
    // Last resort: page title "Name | LinkedIn"
    full_name = document.title.split(' | ')[0].split(' - ')[0].trim()
  }

  // Sanitize: collapse whitespace, strip non-name characters
  full_name = full_name.replace(/\s+/g, ' ').trim()

  return {
    full_name,
    source_surface,
    source_url: url.split('?')[0], // strip query params
  }
}
