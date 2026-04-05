// ─── background.js ────────────────────────────────────────────────────────────
import { handleAuthCallback } from './core/auth.js'

// Listen for the extension-native auth callback page (auth.html)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = tab.url ?? ''
  const authPageUrl = chrome.runtime.getURL('auth.html')

  if (!url.startsWith(authPageUrl)) return
  if (changeInfo.status !== 'complete') return

  try {
    // Get the full URL including hash from the tab's page
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.location.href,
    })
    const fullUrl = results?.[0]?.result ?? url
    console.log('[OutreachAI] Auth callback received:', fullUrl.split('#')[0])

    const success = await handleAuthCallback(fullUrl)
    console.log('[OutreachAI] Auth callback success:', success)

    if (success) {
      // Close the auth tab after a brief delay so user sees the success message
      setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500)
    }
  } catch (e) {
    console.error('[OutreachAI] Auth callback error:', e)
  }
})
