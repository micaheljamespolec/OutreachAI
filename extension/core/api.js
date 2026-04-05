// ─── core/api.js ──────────────────────────────────────────────────────────────
import { CONFIG } from '../config.js'
import { getAccessToken, refreshSession } from './auth.js'

const DB = `${CONFIG.supabaseUrl}/rest/v1`

// ── Error normalization ───────────────────────────────────────────────────────
// Converts any raw error (string, JSON, object) into { code, message }
export function parseErrorMessage(raw) {
  if (!raw) return { code: 'UNKNOWN_ERROR', message: 'Something went wrong.' }
  if (typeof raw === 'object' && raw.code && raw.message) return raw
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw)
      if (j.error?.code) return j.error
      if (j.message)     return { code: j.code || 'API_ERROR', message: j.message }
      if (j.error)       return { code: 'API_ERROR', message: j.error }
      if (j.msg)         return { code: 'API_ERROR', message: j.msg }
    } catch {}
    return { code: 'API_ERROR', message: raw }
  }
  return { code: 'UNKNOWN_ERROR', message: String(raw) }
}

export function isAuthError(err) {
  if (!err) return false
  const msg = (err.message || err.msg || String(err)).toLowerCase()
  const code = String(err.code || '').toLowerCase()
  return code === 'auth_expired' || msg.includes('invalid jwt') || msg.includes('jwt expired') ||
         msg.includes('session expired') || msg.includes('unauthorized') || err.status === 401
}

// ── Core fetch wrapper with 401 refresh-and-retry ─────────────────────────────
async function apiRequest(url, options = {}) {
  const makeRequest = async () => {
    const token = await getAccessToken()
    const headers = {
      'Content-Type': 'application/json',
      'apikey': CONFIG.supabaseKey,
      ...(options.headers || {}),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    return fetch(url, { ...options, headers })
  }

  let res = await makeRequest()

  // On 401, attempt one refresh then retry
  if (res.status === 401) {
    const session = await new Promise(r => chrome.storage.local.get('outreachai_session', d => r(d.outreachai_session ?? null)))
    if (session?.refresh_token) {
      const refreshed = await refreshSession(session.refresh_token)
      if (refreshed) {
        res = await makeRequest()
      } else {
        throw { code: 'AUTH_EXPIRED', message: 'Session expired — please sign out and sign in again.' }
      }
    } else {
      throw { code: 'AUTH_EXPIRED', message: 'Session expired — please sign out and sign in again.' }
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw parseErrorMessage(text)
  }

  return res.json()
}

// ── Main API: enrich-and-draft ────────────────────────────────────────────────
export async function enrichAndDraft({ linkedinUrl, companyHint, userContext, fullNameHint }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ linkedinUrl, companyHint, userContext, fullNameHint }),
  })
}

// ── Summarize raw job posting text into recruiter-friendly bullet points ──────
export async function summarizeJob({ rawText, jobTitle, company }) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/enrich-and-draft`, {
    method: 'POST',
    body: JSON.stringify({ action: 'summarize-job', rawText, jobTitle, company }),
  })
}

// ── Credits ───────────────────────────────────────────────────────────────────
export async function getCreditsData() {
  const token = await getAccessToken()
  if (!token) return null
  const res = await fetch(`${DB}/credits?select=*`, {
    headers: { 'apikey': CONFIG.supabaseKey, 'Authorization': `Bearer ${token}` }
  })
  if (!res.ok) return null
  const rows = await res.json()
  return rows?.[0] || null
}

// ── Job context (stored locally in chrome.storage) ────────────────────────────
export async function extractJob(pageText) {
  return apiRequest(`${CONFIG.supabaseUrl}/functions/v1/extract-job`, {
    method: 'POST',
    body: JSON.stringify({ text: pageText }),
  })
}

// ── Pricing / upgrade ─────────────────────────────────────────────────────────
export function openUpgradePage() {
  chrome.tabs.create({ url: CONFIG.pricingUrl })
}

// ── Legacy exports (kept for backward compatibility with Job tab) ──────────────
export const createCheckout = openUpgradePage
export const lookupEmail = () => { throw new Error('Use enrichAndDraft instead') }
export const generateDraft = () => { throw new Error('Use enrichAndDraft instead') }
export const bootstrapCandidate = () => { throw new Error('Use enrichAndDraft instead') }
export const pollJob = () => { throw new Error('Use enrichAndDraft instead') }
export const getOutreachPackage = () => { throw new Error('Use enrichAndDraft instead') }
export const requirementsMatch = () => { throw new Error('Analyze Fit removed') }
