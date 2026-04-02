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
  // LinkedIn uses h1 or h2 for the profile name — find the right one
  const isRecruiter = window.location.href.includes('/talent/') || window.location.href.includes('/recruiter/')
  let h1 = document.querySelector('h1')

  // On Recruiter pages, the page title IS the person's name — use it directly
  if (isRecruiter) {
    h1 = null // don't trust h1/h2 on Recruiter pages
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

  // ── Recruiter fallback: scan the whole page for headline-like text ────────
  if (!headline && isRecruiter) {
    // On Recruiter pages, look for any text containing " at " near the top
    const allText = document.querySelectorAll('span, div, p')
    for (const el of allText) {
      const text = el.textContent?.trim()
      if (
        text &&
        text.includes(' at ') &&
        text.length > 15 &&
        text.length < 200 &&
        text !== fullName &&
        !text.includes('\n')
      ) {
        headline = text
        break
      }
    }
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

  // ── Experience: gather current roles for richer context ─────────────────────
  const experience = []
  try {
    const expSection = document.querySelector('#experience')
      ?? document.querySelector('[id="experience"]')
    if (expSection) {
      // Walk up to the containing <section>
      const section = expSection.closest('section') ?? expSection.parentElement
      if (section) {
        // Each role is typically in a list item with a company link
        const items = section.querySelectorAll('li')
        for (const item of items) {
          if (experience.length >= 5) break  // cap at 5 roles
          const lines = item.innerText?.trim()?.split('\n').map(l => l.trim()).filter(Boolean) ?? []
          if (lines.length >= 2) {
            // Check if this entry mentions "Present" (current role)
            const isCurrent = lines.some(l => l.includes('Present'))
            const roleTitle = lines[0] || ''
            // Find company name from a link
            const compLink = item.querySelector('a[href*="/company/"]')
            const roleCompany = compLink?.innerText?.trim()?.split('\n')[0]?.trim() || ''
            // Find date range
            const dateLine = lines.find(l => /\b(20\d{2}|Present)\b/.test(l)) || ''
            if (roleTitle && roleTitle.length < 100) {
              experience.push({
                title: roleTitle,
                company: roleCompany,
                dates: dateLine,
                current: isCurrent,
              })
            }
          }
        }
      }
    }
  } catch (e) {
    // Experience extraction is best-effort
  }

  // ── Derive title & company from experience (preferred) or headline ────────
  // Prefer title from current experience entry; fall back to headline-parsed title
  // Priority 1: document.title ("Name - Title - Company | LinkedIn") - always reliable
  // Priority 2: Experience section current role (if lazy-loaded in DOM)
  // Priority 3: Headline text fallback
  const currentExp = experience.find(e => e.current) || experience[0]

  const title = titleFromPageTitle
    || currentExp?.title
    || (cleanHeadline.includes(' at ')
      ? cleanHeadline.split(' at ').slice(0, -1).join(' at ').trim()
      : cleanHeadline)

  let company = companyFromPageTitle
    || currentExp?.company
    || (cleanHeadline.includes(' at ')
      ? cleanHeadline.split(' at ').slice(-1)[0].trim()
      : '')

  // ── Company fallback: extract from profile page DOM if not in headline ────
  if (!company) {
    // Strategy 1: Find the company logo/link in the profile header card
    const profileCard = h1?.closest('main') ?? h1?.closest('section') ?? document.querySelector('main')
    if (profileCard) {
      const expAnchor = document.querySelector('#experience')
      const companyLinks = profileCard.querySelectorAll('a[href*="/company/"]')
      for (const link of companyLinks) {
        if (expAnchor && link.compareDocumentPosition(expAnchor) & Node.DOCUMENT_POSITION_PRECEDING) continue
        const text = link.innerText?.trim()?.split('\n')[0]?.trim()
        if (!text || text.length < 2 || text.length > 80) continue
        if (text.includes('Follow') || text.includes('follower')) continue
        if (/\b(University|College|School|Institute|Academy)\b/i.test(text)) continue
        company = text
        break
      }
    }

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
    linkedinUrl,
    experience,
  })
}
