// ─── core/auth.js ─────────────────────────────────────────────────────────────
import { CONFIG } from '../config.js'

const BASE = `${CONFIG.supabaseUrl}/auth/v1`
const HEADERS = {
  'Content-Type': 'application/json',
  'apikey':       CONFIG.supabaseKey,
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
  if (Date.now() / 1000 > (session.expires_at ?? 0)) {
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
  return session?.access_token ?? null
}

async function refreshSession(refreshToken) {
  try {
    const res  = await fetch(`${BASE}/token?grant_type=refresh_token`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    const data = await res.json()
    if (data.access_token) {
      await saveSession({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_at:    Math.floor(Date.now() / 1000) + data.expires_in,
        user:          data.user,
      })
      return data
    }
    return null
  } catch { return null }
}

export async function sendMagicLink(email) {
  try {
    const res = await fetch(`${BASE}/otp`, {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({
        email,
        options: {         emailRedirectTo: 'https://micaheljamespolec.github.io/outreachai-auth' }
      }),
    })
    if (!res.ok) {
      const err = await res.json()
      return { error: { message: err.msg ?? 'Failed to send magic link' } }
    }
    return { error: null }
  } catch (e) { return { error: { message: e.message } } }
}

export async function signInWithGoogle() {
  const redirectTo = encodeURIComponent('https://micaheljamespolec.github.io/outreachai-auth')
  await chrome.tabs.create({ url: `${BASE}/authorize?provider=google&redirect_to=${redirectTo}` })
}

export async function handleAuthCallback(url) {
  try {
    const hash    = new URL(url).hash.substring(1)
    const params  = new URLSearchParams(hash)
    const token   = params.get('access_token')
    const refresh = params.get('refresh_token')
    const expiresIn = parseInt(params.get('expires_in') ?? '3600')
    if (!token) return false
    const res  = await fetch(`${BASE}/user`, {
      headers: { ...HEADERS, 'Authorization': `Bearer ${token}` }
    })
    const user = await res.json()
    await saveSession({
      access_token:  token,
      refresh_token: refresh,
      expires_at:    Math.floor(Date.now() / 1000) + expiresIn,
      user,
    })
    return true
  } catch { return false }
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