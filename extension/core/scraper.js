// ─── scraper.js ───────────────────────────────────────────────────────────
// Scrapes LinkedIn profile data from the current page.
// This file is injected directly into the LinkedIn page context.
// Keep this file focused — scraping only, no UI or API calls.

export function scrapeLinkedInProfile() {

  // ─── Helper: First Match ─────────────────────────────────────────────────
  // Tries multiple CSS selectors and returns the first match found.
  function firstMatch(selectors) {
    for (const selector of selectors) {
      const el   = document.querySelector(selector)
      const text = el?.innerText?.trim()
      if (text) return text
    }
    return ''
  }

  // ─── Name ────────────────────────────────────────────────────────────────
  const fullName = firstMatch([
    'h1.text-heading-xlarge',
    '.pv-top-card--list h1',
    'h1'
  ])

  const nameParts  = fullName.trim().split(' ')
  const firstName  = nameParts[0] || ''
  const lastName   = nameParts.slice(1).join(' ') || ''

  // ─── Title ───────────────────────────────────────────────────────────────
  const title = firstMatch([
    '.text-body-medium.break-words',
    '.pv-top-card--list .text-body-medium',
    '.ph5 .text-body-medium'
  ])

  // ─── Company ─────────────────────────────────────────────────────────────
  const company = firstMatch([
    '.pv-text-details__right-panel .hoverable-link-text',
    'button[aria-label*="Current company"] span',
    '.pv-top-card--experience-list li:first-child .t-bold'
  ])

  // ─── Domain ──────────────────────────────────────────────────────────────
  // Attempts to extract company domain from the page.
  function guessDomain(companyName) {
    if (!companyName) return ''
    return companyName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      + '.com'
  }

  const domain = guessDomain(company)

  // ─── Skills ──────────────────────────────────────────────────────────────
  const skills = []
  const seen   = new Set()

  function addSkill(text) {
    const t = text?.trim()
    if (t && t.length < 60 && !seen.has(t) && skills.length < 10) {
      seen.add(t)
      skills.push(t)
    }
  }

  // Multiple fallback strategies for skills
  document.querySelectorAll(
    '.pvs-list__item--line-separated .visually-hidden'
  ).forEach(el => addSkill(el.innerText))

  if (skills.length === 0) {
    document.querySelectorAll(
      '[data-field="skill_page_skill_topic"] span[aria-hidden="true"]'
    ).forEach(el => addSkill(el.innerText))
  }

  if (skills.length === 0) {
    document.querySelectorAll(
      '.pv-skill-category-entity__name'
    ).forEach(el => addSkill(el.innerText))
  }

  // ─── LinkedIn URL ─────────────────────────────────────────────────────────
  const linkedinUrl = window.location.href.split('?')[0]

  // ─── Profile Photo ────────────────────────────────────────────────────────
  const photoEl = document.querySelector(
    '.pv-top-card__photo img, .profile-photo-edit__preview'
  )
  const photoUrl = photoEl?.src || ''

  return {
    fullName,
    firstName,
    lastName,
    title,
    company,
    domain,
    skills,
    linkedinUrl,
    photoUrl,
    scrapedAt: new Date().toISOString()
  }
}

// ─── Validate Profile ─────────────────────────────────────────────────────
// Returns true if the scraped profile has minimum required fields.
export function isValidProfile(profile) {
  return !!(profile?.fullName && profile?.company)
}

// ─── Is LinkedIn Profile Page ─────────────────────────────────────────────
// Returns true if the current tab is a LinkedIn profile page.
export function isLinkedInProfilePage(url) {
  return url?.includes('linkedin.com/in/')
}