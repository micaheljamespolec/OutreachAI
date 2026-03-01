// ─── core/credits.js ──────────────────────────────────────────────────────────
import { CONFIG } from '../config.js'
import { getAccessToken, getUser } from './auth.js'

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

export async function getCredits() {
  try {
    const user = await getUser()
    if (!user) return null
    const headers = await getHeaders()
    const res = await fetch(`${DB}/credits?user_id=eq.${user.id}&limit=1`, { headers })
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0] ?? null
  } catch { return null }
}

export async function deductCredit() {
  try {
    const user = await getUser()
    if (!user) return false
    const credits = await getCredits()
    if (!credits) return false
    const tier  = credits.tier ?? 'free'
    const limit = CONFIG.tiers[tier]?.lookups ?? 10
    const used  = credits.lookups_used ?? 0
    if (used >= limit) return false
    const headers = await getHeaders()
    await fetch(`${DB}/credits?user_id=eq.${user.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ lookups_used: used + 1 }),
    })
    return true
  } catch { return false }
}

export async function completeBonusActivity(activity) {
  try {
    const user = await getUser()
    if (!user) return false
    const bonus = CONFIG.bonusActivities?.[activity] ?? 0
    if (!bonus) return false
    const credits = await getCredits()
    if (!credits) return false
    const headers = await getHeaders()
    await fetch(`${DB}/credits?user_id=eq.${user.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ lookups_used: Math.max(0, (credits.lookups_used ?? 0) - bonus) }),
    })
    return true
  } catch { return false }
}