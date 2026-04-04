// ─── content.js — lightweight scraper ────────────────────────────────────────
// Only captures: fullName, title, company, linkedinUrl, and a small about snippet.
// No Experience history, Skills, Activity, or Highlights parsing.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false
  sendResponse(doScrape())
  return false
})

function doScrape() {
  const isRecruiter = window.location.href.includes('/talent/') || window.location.href.includes('/recruiter/')

  // ── Name ──────────────────────────────────────────────────────────────────
  let nameEl = null
  if (isRecruiter) {
    nameEl = document.querySelector('[data-anonymize="person-name"]')
  } else {
    nameEl = document.querySelector('h1')
    if (!nameEl) {
      // Fallback: find h2 matching page title name
      const titleName = document.title.split(' | ')[0].split(' - ')[0].trim()
      for (const el of document.querySelectorAll('h2')) {
        if (el.innerText?.trim() === titleName) { nameEl = el; break }
      }
    }
  }

  const fullName = nameEl?.innerText?.trim()
    || document.title.split(' | ')[0].split(' - ')[0].trim()
    || ''
  const nameParts = fullName.trim().split(/\s+/)

  // ── Headline ──────────────────────────────────────────────────────────────
  let headline = ''

  if (isRecruiter) {
    headline = document.querySelector('.artdeco-entity-lockup__subtitle')?.innerText?.trim() || ''
  } else if (nameEl) {
    // Walk up from the name element looking for a subtitle div
    let container = nameEl.parentElement
    for (let depth = 0; depth < 8 && container; depth++) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      let node
      const candidates = []
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim()
        if (text && text.length > 10 && text.length < 200
            && !text.includes('\n') && text !== fullName
            && !text.startsWith('http') && !text.includes('follower')
            && !text.includes('connection') && !text.includes('Contact info')
            && !text.includes('mutual')) {
          candidates.push(text)
        }
      }
      const atCandidate = candidates.find(c => c.includes(' at '))
      if (atCandidate) { headline = atCandidate; break }
      if (candidates.length && !headline) headline = candidates[0]
      if (headline) break
      container = container.parentElement
    }
  }

  // Fallback: parse from document title
  if (!headline) {
    const beforeLinkedIn = document.title.split(' | LinkedIn')[0]?.split(' | ')[0] || ''
    const dashIdx = beforeLinkedIn.indexOf(' - ')
    if (dashIdx !== -1) headline = beforeLinkedIn.slice(dashIdx + 3).trim()
  }

  // ── Title & Company from headline ─────────────────────────────────────────
  // Clean up pipe-separated headlines: take the " at " segment or first segment
  let cleanHeadline = headline
  if (headline.includes(' | ')) {
    const segments = headline.split(' | ')
    cleanHeadline = segments.find(s => s.includes(' at '))?.trim() || segments[0].trim()
  }

  let title = ''
  let company = ''

  if (cleanHeadline.includes(' at ')) {
    const atIdx = cleanHeadline.lastIndexOf(' at ')
    title   = cleanHeadline.slice(0, atIdx).trim()
    company = cleanHeadline.slice(atIdx + 4).trim()
  } else {
    title = cleanHeadline
  }

  // ── Company fallback: Experience section raw text (first entry only) ───────
  // Light parse — just grab the first company name from the Experience section.
  // No full history, no skills, no activity.
  if (!company && !isRecruiter) {
    try {
      const expSection = [...document.querySelectorAll('section')].find(s =>
        s.innerText?.trim().startsWith('Experience')
      )
      if (expSection) {
        const lines = expSection.innerText.split('\n').map(l => l.trim()).filter(Boolean).slice(1)
        const dateIdx = lines.findIndex(l => /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/.test(l))
        if (dateIdx >= 1) {
          const candidate = lines[dateIdx - 1].split('·')[0].trim()
          if (candidate && candidate !== title && candidate.length > 1 && candidate.length < 80
              && !/,/.test(candidate)
              && !/^(Full.time|Part.time|Contract|Internship|Freelance|Self.employed)$/i.test(candidate)) {
            company = candidate
          }
        }
      }
    } catch {}
  }

  // Final company fallback: document.title "Name - Title - Company | LinkedIn"
  if (!company) {
    const parts = document.title.split(' | LinkedIn')[0]?.split(' - ') ?? []
    if (parts.length >= 3) {
      const candidate = parts[parts.length - 1].trim()
      if (candidate && candidate !== fullName && candidate.length < 80
          && !/\b(University|College|School|Institute|Academy)\b/i.test(candidate)) {
        company = candidate
      }
    }
  }

  // ── About — tiny optional snippet (first 200 chars only) ─────────────────
  let about = ''
  try {
    const aboutSection = [...document.querySelectorAll('section')].find(s =>
      s.innerText?.trim().startsWith('About')
    )
    if (aboutSection) {
      about = aboutSection.innerText.trim().replace(/^About\s*/i, '').trim().slice(0, 200)
    }
  } catch {}

  // ── LinkedIn URL ──────────────────────────────────────────────────────────
  let linkedinUrl = window.location.href.split('?')[0]
  if (isRecruiter) {
    const publicLink = document.querySelector('a[href*="linkedin.com/in/"]')
                    ?? document.querySelector('a[href*="/pub/"]')
    if (publicLink) {
      linkedinUrl = publicLink.href.split('?')[0]
    } else {
      const slug = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      linkedinUrl = `https://www.linkedin.com/in/${slug}`
    }
  }

  return {
    fullName,
    firstName: nameParts[0] || '',
    lastName:  nameParts.slice(1).join(' ') || '',
    title,
    company,
    about,
    linkedinUrl,
  }
}
