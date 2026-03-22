// ─── content.js ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false

  // ── Name ──────────────────────────────────────────────────────────────────
  const h1 = document.querySelector('h1')
  const fullName = h1?.innerText?.trim() || document.title.split(' | ')[0].trim()
  const nameParts = (fullName || '').trim().split(/\s+/)

  // ── Headline: search only near the h1, not all of <main> ──────────────────
  let headline = ''

  if (h1) {
    // Walk up from h1 up to 6 levels to find a container that holds the headline
    let container = h1.parentElement
    for (let depth = 0; depth < 6; depth++) {
      if (!container) break
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim()
        if (
          text &&
          text.includes(' at ') &&
          text.length > 5 &&
          text.length < 120 &&
          !text.includes('·') &&
          !text.includes('\n') &&
          text !== fullName  // skip if it somehow matches the name
        ) {
          headline = text
          break
        }
      }
      if (headline) break
      container = container.parentElement
    }
  }

  // ── Fallback: parse from document title ──────────────────────────────────────
  // LinkedIn title format: "Firstname Lastname - Title at Company | LinkedIn"
  if (!headline) {
    const beforePipe = document.title.split(' | ')[0] ?? ''
    const dashIdx = beforePipe.indexOf(' - ')
    if (dashIdx !== -1) headline = beforePipe.slice(dashIdx + 3).trim()
  }

  // ── Split "Title at Company" ───────────────────────────────────────────────
  const title = headline.includes(' at ')
    ? headline.split(' at ').slice(0, -1).join(' at ').trim()
    : headline

  const company = headline.includes(' at ')
    ? headline.split(' at ').slice(-1)[0].trim()
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
