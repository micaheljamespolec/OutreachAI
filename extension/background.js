// ─── background.js ────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { handleAuthCallback } from './core/auth.js'

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = tab.url ?? ''
  if (!url.includes('outreachai-auth')) return
  if (changeInfo.status !== 'complete') return

  const success = await handleAuthCallback(url)
  if (success) chrome.tabs.remove(tabId)
})