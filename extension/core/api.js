// ─── core/api.js ──────────────────────────────────────────────────────────────
import { CONFIG } from '../config.js'
import { getAccessToken } from './auth.js'

const DB = `${CONFIG.supabaseUrl}/rest/v1`

async function getHeaders() {
  const token = await getAccessToken()
  return {
    'Content-Type':  'application/json',
    'apikey':        CONFIG.supabaseKey,
    'Authorization': `Bearer ${token}`,
    'Prefer':        'return=representation',
  }
}

export async function dbGet(table, query = '') {
  const headers = await getHeaders()
  const res = await fetch(`${DB}/${table}?${query}`, { headers })
  if (!res.ok) throw new Error(`DB GET failed: ${res.status}`)
  return res.json()
}

export async function dbPost(table, body) {
  const headers = await getHeaders()
  const res = await fetch(`${DB}/${table}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`DB POST failed: ${res.status}`)
  return res.json()
}

export async function dbPatch(table, query, body) {
  const headers = await getHeaders()
  const res = await fetch(`${DB}/${table}?${query}`, {
    method: 'PATCH', headers, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`DB PATCH failed: ${res.status}`)
  return res.json()
}

export async function lookupEmail(firstName, lastName, linkedinUrl, company, cacheOnly = false) {
  const token = await getAccessToken()
  const headers = {
    'Content-Type': 'application/json',
    'apikey':       CONFIG.supabaseKey,
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/lookup-email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ firstName, lastName, linkedinUrl, company, cacheOnly }),
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error('lookup-email error:', res.status, errText)
    throw new Error(errText || `lookup-email failed: ${res.status}`)
  }
  return res.json()
}

export async function generateDraft(profile, job, recruiter) {
  const token = await getAccessToken()
  const headers = {
    'Content-Type': 'application/json',
    'apikey':       CONFIG.supabaseKey,
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/generate-draft`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ profile, job, recruiter }),
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error('generate-draft error:', res.status, errText)
    throw new Error(errText || `generate-draft failed: ${res.status}`)
  }
  return res.json()
}

export async function extractJob(pageText) {
  // Send already-extracted page text to the AI for parsing
  const token = await getAccessToken()
  const headers = {
    'Content-Type': 'application/json',
    'apikey':       CONFIG.supabaseKey,
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/extract-job`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pageText }),
  })
  if (!res.ok) {
    const errText = await res.text()
    console.error('extract-job error:', res.status, errText)
    throw new Error(errText || `extract-job failed: ${res.status}`)
  }
  return res.json()
}

// Opens pricing page — Stripe checkout handled via website, not extension
export function createCheckout() {
  chrome.tabs.create({ url: CONFIG.pricingUrl })
}