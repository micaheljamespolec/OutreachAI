// ─── content.js ───────────────────────────────────────────────────────────────
// Runs in the LinkedIn page context as a content script.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'scrape') return false

  const h1 = document.querySelector('h1')
  const fullName = h1?.innerText?.trim() || document.title.split(' | ')[0].trim()
  const nameParts = (fullName || '').trim().split(/\s+/)

  // Try multiple approaches for headline
  let headline = ''

  // Approach 1: look for any element in main that contains ' at ' and is short
  const mainEl = document.querySelector('main')
  if (mainEl) {
    const walker = document.createTreeWalker(mainEl, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim()
      if (text && text.includes(' at ') && text.length > 5 && text.length < 100 && !text.includes('·') && !text.includes('\n')) {
        headline = text
        break
      }
    }
  }

  // Approach 2: fallback to document title parsing
  if (!headline) {
    const titleParts = document.title.split(' | ')
    if (titleParts.length > 1) headline = titleParts[1].split(' - ')[0].trim()
  }

  const title = headline.includes(' at ')
    ? headline.split(' at ').slice(0, -1).join(' at ').trim()
    : headline
  const company = headline.includes(' at ')
    ? headline.split(' at ').slice(-1)[0].trim()
    : ''

  sendResponse({
    fullName,
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' ') || '',
    title,
    company,
    linkedinUrl: window.location.href.split('?')[0],
  })

  return true
})
