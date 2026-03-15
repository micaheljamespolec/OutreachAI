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

export async function lookupEmail(firstName, lastName, linkedinUrl, company) {
  const token = await getAccessToken()
  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/lookup-email`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ firstName, lastName, linkedinUrl, company }),
  })
  if (!res.ok) throw new Error(`lookup-email failed: ${res.status}`)
  return res.json()
}

// Opens pricing page — Stripe checkout handled via website, not extension
export function createCheckout() {
  chrome.tabs.create({ url: CONFIG.pricingUrl })
}