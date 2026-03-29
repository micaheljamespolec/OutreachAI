// ─── content.js ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false

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

  // ── Extract title and company from headline ────────────────────────────────
  // Clean up: if headline has pipes, take the first segment that contains " at "
  let cleanHeadline = headline
  if (headline.includes(' | ')) {
    const segments = headline.split(' | ')
    const atSegment = segments.find(s => s.includes(' at '))
    if (atSegment) cleanHeadline = atSegment.trim()
    else cleanHeadline = segments[0].trim()
  }

  const title = cleanHeadline.includes(' at ')
    ? cleanHeadline.split(' at ').slice(0, -1).join(' at ').trim()
    : cleanHeadline

  const company = cleanHeadline.includes(' at ')
    ? cleanHeadline.split(' at ').slice(-1)[0].trim()
    : ''

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
  })

  return true
})
