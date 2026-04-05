// ─── content.js — LinkedIn profile scraper ────────────────────────────────────
// Captures: full_name, company, headline from the active LinkedIn profile page.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false
  sendResponse(captureProfile())
  return false
})

function captureProfile() {
  const url = window.location.href
  const isRecruiter = url.includes('/talent/') || url.includes('/recruiter/')
  const source_surface = isRecruiter ? 'linkedin_recruiter' : 'linkedin_profile'

  // ── Name ──────────────────────────────────────────────────────────────────
  let full_name = ''

  if (isRecruiter) {
    full_name = document.querySelector('[data-anonymize="person-name"]')?.innerText?.trim() || ''
  }
  if (!full_name) {
    full_name = document.querySelector('h1')?.innerText?.trim() || ''
  }
  if (!full_name) {
    full_name = document.title.split(' | ')[0].split(' - ')[0].trim()
  }
  full_name = full_name.replace(/\s+/g, ' ').trim()

  // ── Headline (title) ──────────────────────────────────────────────────────
  let headline = ''

  if (isRecruiter) {
    headline = document.querySelector('[data-anonymize="job-title"]')?.innerText?.trim() || ''
  }
  if (!headline) {
    headline = (
      document.querySelector('.text-body-medium.break-words')?.innerText?.trim() ||
      document.querySelector('h2.top-card-layout__headline')?.innerText?.trim() ||
      document.querySelector('.pv-top-card-section__headline')?.innerText?.trim() ||
      ''
    )
  }

  // ── Company ──────────────────────────────────────────────────────────────
  let company = ''

  if (isRecruiter) {
    company = document.querySelector('[data-anonymize="company-name"]')?.innerText?.trim() || ''
  }

  // Standard profile: try several selectors in order of reliability
  if (!company) {
    // Top card company button / link (varies by LinkedIn version)
    const topCardCandidates = [
      'a.top-card-layout__company-url',
      'button.top-card-layout__entity-info',
      '.pv-top-card--list-bullet:first-child span',
      '.top-card-layout__first-subline span',
    ]
    for (const sel of topCardCandidates) {
      const text = document.querySelector(sel)?.innerText?.trim()
      if (text && text.length > 1 && text.length < 80) { company = text; break }
    }
  }

  if (!company) {
    // Experience section: first item company name
    // LinkedIn 2024+ structure: #experience section, then pvs-list items
    const expAnchor = document.getElementById('experience') ||
                      document.querySelector('[id*="experience"]')
    if (expAnchor) {
      let container = expAnchor.closest('section') || expAnchor.nextElementSibling
      if (container) {
        // Bold span (title) followed by a normal span (company · type)
        const boldSpans = container.querySelectorAll('span[aria-hidden="true"]')
        for (const span of boldSpans) {
          const text = span.innerText?.trim() || ''
          // Company names typically appear right after the title
          // They contain "·" or appear as a separate line
          if (text && text.includes('·')) {
            company = text.split('·')[0].trim()
            break
          }
        }
        // Fallback: second bold span in experience section
        if (!company && boldSpans.length >= 2) {
          company = boldSpans[1]?.innerText?.trim() || ''
        }
      }
    }
  }

  if (!company && headline) {
    // Parse "Role at Company" pattern from headline
    const atMatch = headline.match(/\bat\s+([A-Z][A-Za-z0-9 &,.'()-]{2,60}?)(?:\s*[|,]|$)/)
    if (atMatch) company = atMatch[1].trim()
  }

  // Sanitize company — strip LinkedIn-injected copy
  company = company.replace(/\s+/g, ' ').trim()
  if (company.toLowerCase().includes('linkedin') || company.length > 100) company = ''

  return {
    full_name,
    headline,
    company,
    source_surface,
    source_url: url.split('?')[0],
  }
}
