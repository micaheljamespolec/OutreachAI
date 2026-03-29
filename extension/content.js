// ─── content.js ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false

  // ── Name ──────────────────────────────────────────────────────────────────
  const h1 = document.querySelector('h1')
  const fullName = h1?.innerText?.trim() || document.title.split(' | ')[0].trim()
  const nameParts = (fullName || '').trim().split(/\s+/)

  // ── Headline: search near the h1 using TreeWalker ─────────────────────────
  let headline = ''

  if (h1) {
    let container = h1.parentElement
    for (let depth = 0; depth < 6; depth++) {
      if (!container) break
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim()
        if (
          text &&
          text.length > 5 &&
          text.length < 200 &&
          !text.includes('·') &&
          !text.includes('\n') &&
          text !== fullName &&
          // Match headline patterns: "X at Y", or any professional-looking text
          (text.includes(' at ') || text.includes(' | ') || text.includes(' - '))
        ) {
          headline = text
          break
        }
      }
      if (headline) break
      container = container.parentElement
    }
  }

  // ── Fallback: parse from document title ────────────────────────────────────
  // LinkedIn title format: "Firstname Lastname - Title at Company | LinkedIn"
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

  sendResponse({
    fullName,
    firstName: nameParts[0] || '',
    lastName:  nameParts.slice(1).join(' ') || '',
    title,
    company,
    linkedinUrl: window.location.href.split('?')[0],
  })

  return true
})
