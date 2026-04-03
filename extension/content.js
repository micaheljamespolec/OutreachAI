// ─── content.js ──────────────────────────────────────────────────────────────

// Scroll down to force LinkedIn to lazy-load the Experience section, then scroll back
function ensureExperienceLoaded() {
  return new Promise(resolve => {
    // If Experience section already exists, nothing to do
    if (document.querySelector('#experience')) { resolve(); return }
    // Scroll down far enough to trigger lazy loading
    window.scrollTo(0, 1200)
    // Wait up to 3s for #experience to appear
    let waited = 0
    const interval = setInterval(() => {
      waited += 200
      if (document.querySelector('#experience') || waited >= 3000) {
        clearInterval(interval)
        // Scroll back to top so the user doesn't notice
        window.scrollTo(0, 0)
        resolve()
      }
    }, 200)
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false

  // Ensure Experience section is loaded before scraping, then do the work async
  ensureExperienceLoaded().then(() => doScrape(sendResponse))
  return true // keep message channel open for async response
})

function doScrape(sendResponse) {

  // ── Name ──────────────────────────────────────────────────────────────────
  const isRecruiter = window.location.href.includes('/talent/') || window.location.href.includes('/recruiter/')
  let h1 = document.querySelector('h1')

  if (isRecruiter) {
    // Recruiter DOM: name is in [data-anonymize="person-name"], h1 = "From public profile"
    h1 = document.querySelector('[data-anonymize="person-name"]') || null
  } else if (!h1) {
    // Regular LinkedIn: find the h2 that matches the name from the page title
    const titleName = document.title.split(' | ')[0].split(' - ')[0].trim()
    const h2s = document.querySelectorAll('h2')
    for (const el of h2s) {
      const text = el.innerText?.trim()
      if (text && text === titleName) { h1 = el; break }
    }
    if (!h1 && titleName) {
      for (const el of h2s) {
        const text = el.innerText?.trim()
        if (text && text.includes(titleName)) { h1 = el; break }
      }
    }
  }

  const fullName = h1?.innerText?.trim() || document.title.split(' | ')[0].split(' - ')[0].trim()
  const nameParts = (fullName || '').trim().split(/\s+/)

  // ── Headline: find the text just below the name ────────────────────────
  let headline = ''

  if (h1) {
    // Strategy 1: Look for the headline div right after the h1's container
    // LinkedIn puts the headline in a div.text-body-medium near the h1
    let container = h1.parentElement
    for (let depth = 0; depth < 8; depth++) {
      if (!container) break
      // Look for all text nodes in this container
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      let node
      const candidates = []
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim()
        if (
          text &&
          text.length > 10 &&
          text.length < 200 &&
          !text.includes('\n') &&
          text !== fullName &&
          !text.startsWith('http') &&
          !text.includes('follower') &&
          !text.includes('connection') &&
          !text.includes('Contact info') &&
          !text.includes('mutual')
        ) {
          candidates.push(text)
        }
      }
      // Prefer a candidate with " at " (most likely the headline)
      const atCandidate = candidates.find(c => c.includes(' at '))
      if (atCandidate) { headline = atCandidate; break }
      // Otherwise take the first candidate that looks like a headline
      if (candidates.length > 0 && !headline) {
        headline = candidates[0]
      }
      if (headline) break
      container = container.parentElement
    }
  }

  // ── Recruiter: headline lives in .artdeco-entity-lockup__subtitle ──────────
  if (isRecruiter) {
    headline = document.querySelector('.artdeco-entity-lockup__subtitle')?.innerText?.trim() || ''
  }

  // ── Fallback: parse from document title ────────────────────────────────────
  if (!headline) {
    const beforeLinkedIn = document.title.split(' | LinkedIn')[0] ?? document.title.split(' | ')[0] ?? ''
    const dashIdx = beforeLinkedIn.indexOf(' - ')
    if (dashIdx !== -1) headline = beforeLinkedIn.slice(dashIdx + 3).trim()
  }

  // ── Strategy 1: Parse title & company from document.title ──────────────────
  // LinkedIn's page title is always "Name - Title - Company | LinkedIn"
  // This is the most reliable source — always present, no lazy-loading issues.
  let titleFromPageTitle = ''
  let companyFromPageTitle = ''
  const pageTitleRaw = document.title.split(' | LinkedIn')[0].split(' | ')[0]
  const pageTitleParts = pageTitleRaw.split(' - ').map(s => s.trim()).filter(Boolean)
  // parts[0] = Name, parts[1] = Title, parts[2] = Company
  if (pageTitleParts.length >= 3) {
    titleFromPageTitle = pageTitleParts[1] || ''
    companyFromPageTitle = pageTitleParts[2] || ''
  } else if (pageTitleParts.length === 2 && pageTitleParts[0] === fullName) {
    titleFromPageTitle = pageTitleParts[1] || ''
  }

  // ── Extract title and company from headline (fallback only) ──────────────────
  let cleanHeadline = headline
  if (headline.includes(' | ')) {
    const segments = headline.split(' | ')
    const atSegment = segments.find(s => s.includes(' at '))
    if (atSegment) cleanHeadline = atSegment.trim()
    else cleanHeadline = segments[0].trim()
  }

  // title and company are determined after experience is scraped (below)
  // Priority: page title > experience section > headline fallback

  // ── Title: always use the headline ──────────────────────────────────────────
  // The headline is the most reliable source on both regular LinkedIn and Recruiter.
  // Experience section DOM layout varies too much between page types to parse reliably.
  // Headline examples:
  //   "Senior Recruiter at Sunrise Systems"  → title = "Senior Recruiter"
  //   "Strategic U.S. Talent Recruitment Leader | Results-Focused"  → title = full headline
  //   "Co-Founder"  → title = "Co-Founder"

  let title = ''
  let company = ''

  if (cleanHeadline.includes(' at ')) {
    // "Title at Company" format
    const atIdx = cleanHeadline.lastIndexOf(' at ')
    title   = cleanHeadline.slice(0, atIdx).trim()
    company = cleanHeadline.slice(atIdx + 4).trim()
  } else if (cleanHeadline.includes(' | ')) {
    // "Title | Tagline" — take the first segment as title
    title = cleanHeadline.split(' | ')[0].trim()
  } else {
    title = cleanHeadline
  }

  // ── About / Summary text ─────────────────────────────────────────────────
  let about = ''
  try {
    const aboutSection = [...document.querySelectorAll('section')].find(s =>
      s.innerText?.trim().startsWith('About')
    )
    if (aboutSection) {
      about = aboutSection.innerText.trim().replace(/^About\s*/i, '').trim().slice(0, 800)
    }
  } catch {}

  // ── Skills ────────────────────────────────────────────────────────────────
  const skills = []
  try {
    const skillsSection = [...document.querySelectorAll('section')].find(s =>
      /^Skills/.test(s.innerText?.trim())
    )
    if (skillsSection) {
      // LinkedIn renders skills as spans/divs with the skill name — grab unique text nodes
      const skillEls = skillsSection.querySelectorAll('a[href*="/skills/"], span[aria-hidden="true"]')
      const seen = new Set()
      for (const el of skillEls) {
        const text = el.innerText?.trim()
        if (text && text.length > 1 && text.length < 60 && !seen.has(text)
            && !text.includes('·') && !text.includes('endorsement')) {
          seen.add(text)
          skills.push(text)
          if (skills.length >= 20) break
        }
      }
      // Fallback: parse from raw section text if no skill elements found
      if (!skills.length) {
        const rawLines = skillsSection.innerText.split('\n').map(l => l.trim()).filter(Boolean).slice(1)
        for (const line of rawLines) {
          if (line.length > 1 && line.length < 60 && !line.includes('endorsement') && !/^\d+$/.test(line)) {
            skills.push(line)
            if (skills.length >= 20) break
          }
        }
      }
    }
  } catch {}

  // ── Experience (full, for match context) ──────────────────────────────────
  const experience = []

  // ── Also populate experience array from the same section ────────────────────
  try {
    const expSection2 = !isRecruiter && [...document.querySelectorAll('section')].find(s =>
      s.innerText?.trim().startsWith('Experience')
    )
    if (expSection2) {
      const lines = expSection2.innerText.split('\n').map(l => l.trim()).filter(Boolean).slice(1)
      let i = 0
      while (i < lines.length && experience.length < 6) {
        const dateIdx = lines.findIndex((l, idx) => idx >= i &&
          /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/.test(l))
        if (dateIdx === -1) break
        const roleTitle2 = dateIdx >= 2 ? lines[dateIdx - 2] : (dateIdx >= 1 ? lines[dateIdx - 1] : '')
        const roleCompany2 = dateIdx >= 1 ? lines[dateIdx - 1].split('·')[0].trim() : ''
        const isCurrent = lines[dateIdx].includes('Present')
        if (roleTitle2 && roleTitle2.length < 100 && roleTitle2 !== roleCompany2) {
          experience.push({ title: roleTitle2, company: roleCompany2, dates: lines[dateIdx], current: isCurrent })
        }
        i = dateIdx + 1
      }
    }
  } catch {}

  // ── Company fallback: read from Experience section text ─────────────────────
  // LinkedIn often renders the company as an image (alt text only), so /company/
  // link scanning is unreliable. Instead, parse the Experience section raw text
  // which always has "Title\n\nCompany\n\nDate" in plain text.
  if (!company) {
    try {
      const expSection = !isRecruiter && [...document.querySelectorAll('section')].find(s =>
        s.innerText?.trim().startsWith('Experience')
      )
      if (expSection) {
        const lines = expSection.innerText
          .split('\n').map(l => l.trim()).filter(Boolean).slice(1)
        // Find first date line — company is the line immediately before it
        const dateIdx = lines.findIndex(l => /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/.test(l))
        if (dateIdx >= 1) {
          // Strip employment type suffix: "UpToSpeed · Internship" → "UpToSpeed"
          let candidate = lines[dateIdx - 1].split('·')[0].trim()
          // Sanity check: not empty, not a location ("City, Country"), not a bare employment type
          if (candidate && candidate !== title && candidate.length > 1 && candidate.length < 80
              && !/,/.test(candidate)
              && !/^(Full.time|Part.time|Contract|Internship|Freelance|Self.employed)$/i.test(candidate)
          ) {
            company = candidate
          }
        }
      }
    } catch {}

    // Strategy 2: Parse from the page title ("Name - Title - Company | LinkedIn")
    if (!company) {
      const titleParts = document.title.split(' | LinkedIn')[0]?.split(' - ') ?? []
      if (titleParts.length >= 3) {
        const candidate = titleParts[titleParts.length - 1].trim()
        if (candidate && candidate !== fullName && candidate.length < 80
            && !/\b(University|College|School|Institute|Academy)\b/i.test(candidate)) {
          company = candidate
        }
      }
      if (!company && titleParts.length >= 3) {
        const candidate = titleParts[titleParts.length - 1].trim()
        if (candidate && candidate !== fullName && candidate.length < 80) {
          company = candidate
        }
      }
    }
  }

  // ── LinkedIn URL: prefer the public profile URL ─────────────────────────
  let linkedinUrl = window.location.href.split('?')[0]
  // On Recruiter/Talent pages, try to find the public profile link
  if (linkedinUrl.includes('/talent/') || linkedinUrl.includes('/recruiter/')) {
    const publicLink = document.querySelector('a[href*="linkedin.com/in/"]')
      ?? document.querySelector('a[href*="/pub/"]')
    if (publicLink) {
      linkedinUrl = publicLink.href.split('?')[0]
    } else {
      // Build a best-guess public URL from the name
      const slug = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      linkedinUrl = `https://www.linkedin.com/in/${slug}`
    }
  }

  sendResponse({
    fullName,
    firstName: nameParts[0] || '',
    lastName:  nameParts.slice(1).join(' ') || '',
    title,
    company,
    headline,
    about,
    skills,
    linkedinUrl,
    experience,
  })
}
