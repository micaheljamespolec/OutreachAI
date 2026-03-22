// ─── background.js ────────────────────────────────────────────────────────────
import { handleAuthCallback } from './core/auth.js'

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = tab.url ?? ''
  if (!url.includes('outreachai-auth')) return
  if (changeInfo.status !== 'complete') return

  // tab.url strips the hash fragment — inject into the tab to get the full URL
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.location.href,
    })
    const fullUrl = results?.[0]?.result ?? url
    console.log('Auth callback full URL:', fullUrl)
    const success = await handleAuthCallback(fullUrl)
    console.log('Auth callback success:', success)
    if (success) {
      setTimeout(() => chrome.tabs.remove(tabId), 1500)
    }
  } catch (e) {
    console.error('Auth callback error:', e)
  }
})