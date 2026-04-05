// ─── core/auth.js ─────────────────────────────────────────────────────────────
import { CONFIG } from '../config.js'

const BASE = `${CONFIG.supabaseUrl}/auth/v1`
const HEADERS = {
  'Content-Type': 'application/json',
  'apikey':       CONFIG.supabaseKey,
}

// Extension-native redirect: lives inside the extension, always available.
// No external GitHub Pages required.
function getRedirectUrl() {
  return chrome.runtime.getURL('auth.html')
}

function saveSession(session) {
  return new Promise(r => chrome.storage.local.set({ outreachai_session: session }, r))
}
function loadSession() {
  return new Promise(r => chrome.storage.local.get('outreachai_session', d => r(d.outreachai_session ?? null)))
}
function clearSession() {
  return new Promise(r => chrome.storage.local.remove('outreachai_session', r))
}

export async function isLoggedIn() {
  const session = await loadSession()
  if (!session?.access_token) return false
  // Refresh if expired (or within 5 min of expiry)
  if ((Date.now() / 1000) + 300 > (session.expires_at ?? 0)) {
    if (!session.refresh_token) return false
    const refreshed = await refreshSession(session.refresh_token)
    return !!refreshed
  }
  return true
}

export async function getUser() {
  const session = await loadSession()
  return session?.user ?? null
}

export async function getAccessToken() {
  const session = await loadSession()
  if (!session?.access_token) return null
  // Refresh proactively if within 5 min of expiry
  if ((Date.now() / 1000) + 300 > (session.expires_at ?? 0)) {
    if (!session.refresh_token) return null
    const refreshed = await refreshSession(session.refresh_token)
    if (!refreshed) return null
    const updated = await loadSession()
    return updated?.access_token ?? null
  }
  return session.access_token
}

export async function refreshSession(refreshToken) {
  if (!refreshToken) return null
  try {
    const res  = await fetch(`${BASE}/token?grant_type=refresh_token`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    const data = await res.json()
    if (data.access_token) {
      const session = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token ?? refreshToken,
        expires_at:    Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
        user:          data.user,
      }
      await saveSession(session)
      return session
    }
    // Refresh token itself expired — clear session
    if (res.status === 400 || res.status === 401) await clearSession()
    return null
  } catch { return null }
}

export async function sendMagicLink(email) {
  try {
    const res = await fetch(`${BASE}/otp`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({
        email,
        options: { emailRedirectTo: getRedirectUrl() }
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return { error: { message: err.msg ?? err.message ?? 'Failed to send magic link' } }
    }
    return { error: null }
  } catch (e) { return { error: { message: e.message } } }
}

export async function signInWithGoogle() {
  const redirectTo = encodeURIComponent(getRedirectUrl())
  await chrome.tabs.create({
    url: `${BASE}/authorize?provider=google&redirect_to=${redirectTo}`
  })
}

export async function handleAuthCallback(url) {
  try {
    // Tokens come in the URL hash: #access_token=...&refresh_token=...
    const hash   = url.includes('#') ? url.split('#')[1] : ''
    const params = new URLSearchParams(hash)
    const token  = params.get('access_token')
    const refresh = params.get('refresh_token')
    const expiresIn = parseInt(params.get('expires_in') ?? '3600', 10)

    if (!token) return false

    // Verify the token by fetching user info
    const res  = await fetch(`${BASE}/user`, {
      headers: { ...HEADERS, 'Authorization': `Bearer ${token}` }
    })
    if (!res.ok) return false
    const user = await res.json()

    await saveSession({
      access_token:  token,
      refresh_token: refresh,
      expires_at:    Math.floor(Date.now() / 1000) + expiresIn,
      user,
    })
    return true
  } catch (e) {
    console.error('handleAuthCallback error:', e)
    return false
  }
}

export async function signOut() {
  const session = await loadSession()
  if (session?.access_token) {
    await fetch(`${BASE}/logout`, {
      method: 'POST',
      headers: { ...HEADERS, 'Authorization': `Bearer ${session.access_token}` },
    }).catch(() => {})
  }
  await clearSession()
}
