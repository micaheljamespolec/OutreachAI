// ─── batch.js ─────────────────────────────────────────────────────────────────
import {
  getCampaigns, getCampaignCandidates, importCampaign,
  enrichCampaignCandidate, draftCampaignCandidate,
  updateCandidateStatus, linkCampaignJob, deleteCampaign,
  getSavedJobs, openUpgradePage,
} from './core/api.js'

// ── State ──────────────────────────────────────────────────────────────────────
let _activeCampaignId = null
let _allCandidates = []
let _savedJobs = []
let _batchAbort = false

// ── DOM shorthand ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

// ── Drawer open / close ────────────────────────────────────────────────────────
export function openBatchDrawer() {
  const drawer = $('batchDrawer')
  if (!drawer) return
  drawer.classList.add('open')
  loadCampaignsList()
  loadJobsForSelector()
}

export function closeBatchDrawer() {
  const drawer = $('batchDrawer')
  if (!drawer) return
  drawer.classList.remove('open')
  _batchAbort = true
}

// ── Sub-panel navigation ───────────────────────────────────────────────────────
function showBatchPanel(name) {
  document.querySelectorAll('.batch-panel').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.batch-nav-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name))
  const panel = $(`batchPanel-${name}`)
  if (panel) panel.classList.add('active')
}

// ── CSV parser (RFC 4180, handles quoted fields and embedded newlines) ─────────
function parseCsv(text) {
  const rows = []
  let col = '', row = [], inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { col += '"'; i++ }
        else inQuotes = false
      } else {
        col += ch
      }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ',') { row.push(col); col = '' }
      else if (ch === '\n') { row.push(col); col = ''; rows.push(row); row = [] }
      else if (ch === '\r') { /* skip */ }
      else col += ch
    }
  }
  if (col || row.length) { row.push(col); rows.push(row) }
  return rows
}

function csvToObjects(rows) {
  if (rows.length < 2) return []
  const headers = rows[0].map(h => h.trim().toLowerCase())
  const get = (row, ...keys) => {
    for (const k of keys) {
      const idx = headers.indexOf(k)
      if (idx !== -1) return (row[idx] || '').trim()
    }
    return ''
  }
  return rows.slice(1).filter(r => r.some(c => c.trim())).map(row => ({
    first_name:      get(row, 'first name'),
    last_name:       get(row, 'last name'),
    headline:        get(row, 'headline'),
    location:        get(row, 'location'),
    current_title:   get(row, 'current title'),
    current_company: get(row, 'current company'),
    email:           get(row, 'email address', 'email'),
    phone:           get(row, 'phone number', 'phone'),
    linkedin_url:    get(row, 'profile url', 'linkedin url', 'linkedin'),
    active_project:  get(row, 'active project'),
    notes:           get(row, 'notes'),
    feedback:        get(row, 'feedback'),
  }))
}

// ── Load saved jobs for selectors ─────────────────────────────────────────────
async function loadJobsForSelector() {
  try {
    const { jobs } = await getSavedJobs()
    _savedJobs = jobs || []
    renderJobSelectors()
  } catch {}
}

function renderJobSelectors() {
  document.querySelectorAll('.batch-job-select').forEach(sel => {
    const current = sel.value
    sel.innerHTML = '<option value="">— Link a saved job —</option>'
    _savedJobs.forEach(j => {
      const opt = document.createElement('option')
      opt.value = j.id
      opt.textContent = j.label + (j.company ? ` — ${j.company}` : '')
      sel.appendChild(opt)
    })
    if (current) sel.value = current
  })
}

// ── Campaigns list panel ───────────────────────────────────────────────────────
async function loadCampaignsList() {
  const list = $('batchCampaignList')
  if (!list) return
  list.innerHTML = '<div class="batch-loading">Loading campaigns…</div>'
  try {
    const { campaigns } = await getCampaigns()
    list.innerHTML = ''
    if (!campaigns || campaigns.length === 0) {
      list.innerHTML = '<div class="batch-empty">No campaigns yet. Import a CSV to get started.</div>'
      return
    }
    campaigns.forEach(c => {
      const row = document.createElement('div')
      row.className = 'batch-campaign-row'
      const job = c.saved_jobs
      const jobLabel = job ? `${job.label}${job.company ? ' — ' + job.company : ''}` : null
      const statusBadge = c.status === 'needs_job'
        ? '<span class="batch-badge warn">Needs job</span>'
        : `<span class="batch-badge ok">${c.status}</span>`
      row.innerHTML = `
        <div class="batch-campaign-info">
          <div class="batch-campaign-name">${_esc(c.name)}</div>
          <div class="batch-campaign-meta">
            ${jobLabel ? `<span class="batch-campaign-job">${_esc(jobLabel)}</span>` : '<span class="batch-campaign-job warn-text">No job linked</span>'}
            ${statusBadge}
          </div>
          <div class="batch-campaign-counts">
            ${c.enriched_count}/${c.total_count} enriched &nbsp;·&nbsp; ${c.drafted_count} drafted &nbsp;·&nbsp; ${c.approved_count} approved
          </div>
        </div>
        <div class="batch-campaign-actions">
          <button class="batch-btn batch-btn-sm" data-open="${c.id}">Open</button>
          <button class="batch-btn batch-btn-sm batch-btn-danger" data-delete="${c.id}">✕</button>
        </div>`
      row.querySelector('[data-open]').addEventListener('click', () => openCampaign(c.id, c))
      row.querySelector('[data-delete]').addEventListener('click', async e => {
        e.stopPropagation()
        if (!confirm(`Delete campaign "${c.name}" and all its candidates?`)) return
        try {
          await deleteCampaign({ campaignId: c.id })
          await loadCampaignsList()
        } catch { alert('Could not delete campaign.') }
      })
      list.appendChild(row)
    })
  } catch (e) {
    list.innerHTML = '<div class="batch-empty">Could not load campaigns.</div>'
  }
}

async function openCampaign(campaignId, campaignData) {
  _activeCampaignId = campaignId
  const sel = $('batchCampaignSelect')
  if (sel) sel.value = campaignId

  if (campaignData?.status === 'needs_job') {
    setBatchStatus('This campaign has no job linked yet. Link a job before enriching or drafting.', 'warn')
  }

  await loadCandidatePanel(campaignId)
  showBatchPanel('candidates')
}

// ── Import panel ───────────────────────────────────────────────────────────────
function setupImportPanel() {
  const fileInput = $('batchCsvFile')
  const campaignNameInput = $('batchCampaignName')
  const previewEl = $('batchCsvPreview')
  const jobSel = $('batchImportJobSelect')
  const jobUrlWrap = $('batchJobUrlWrap')
  const jobUrlToggle = $('batchJobUrlToggle')
  const jobUrlInput = $('batchJobUrlInput')
  const jobUrlBtn = $('batchJobUrlFetch')
  const importBtn = $('batchImportBtn')

  let _parsedCandidates = []
  let _selectedJobId = null
  let _urlValidated = false

  if (!fileInput) return

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      const rows = parseCsv(e.target.result)
      _parsedCandidates = csvToObjects(rows)
      const firstProject = _parsedCandidates.find(c => c.active_project)?.active_project || ''
      if (campaignNameInput && !campaignNameInput.value.trim() && firstProject) {
        campaignNameInput.value = firstProject
      }
      if (previewEl) previewEl.textContent = `${_parsedCandidates.length} candidate${_parsedCandidates.length !== 1 ? 's' : ''} detected`
      checkImportReady()
    }
    reader.readAsText(file)
  })

  if (jobSel) {
    jobSel.addEventListener('change', () => {
      _selectedJobId = jobSel.value || null
      _urlValidated = false
      if (jobUrlWrap) jobUrlWrap.style.display = 'none'
      checkImportReady()
    })
  }

  if (jobUrlToggle) {
    jobUrlToggle.addEventListener('click', () => {
      const show = jobUrlWrap.style.display === 'none' || !jobUrlWrap.style.display
      jobUrlWrap.style.display = show ? 'block' : 'none'
      if (show && jobSel) { jobSel.value = ''; _selectedJobId = null }
    })
  }

  if (jobUrlBtn) {
    jobUrlBtn.addEventListener('click', async () => {
      const url = (jobUrlInput?.value || '').trim()
      if (!url || !url.startsWith('http')) { setBatchStatus('Enter a valid job URL.', 'error'); return }
      jobUrlBtn.disabled = true
      jobUrlBtn.textContent = 'Checking…'
      setBatchStatus('Validating job URL…', 'info')
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15000)
        const resp = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'text/html' } })
        clearTimeout(timer)
        const html = await resp.text()
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const bodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ').slice(0, 1000)
        const EXPIRED = /this (job|position|role|posting) (is |has been )?(no longer available|closed|filled|expired|removed)|no longer accepting applications/i
        if (EXPIRED.test(bodyText)) {
          setBatchStatus('This job posting appears to be expired or unavailable. Please use a live URL.', 'error')
          jobUrlBtn.disabled = false; jobUrlBtn.textContent = 'Validate URL'
          return
        }
        const ldTitle = (() => {
          for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
            try {
              const d = JSON.parse(s.textContent)
              const nodes = d?.['@graph'] ? d['@graph'] : [d]
              const job = nodes.find(n => n?.['@type'] === 'JobPosting')
              if (job?.title) return job.title
            } catch {}
          }
          return ''
        })()
        const title = ldTitle || doc.querySelector('h1')?.textContent?.trim() || 'Linked job'
        _selectedJobId = null
        _urlValidated = true
        $('batchUrlJobLabel').textContent = title.slice(0, 60)
        $('batchUrlJobConfirm').style.display = 'block'
        setBatchStatus(`Job URL validated: "${title.slice(0, 50)}"`, 'success')
        checkImportReady()
      } catch (err) {
        const msg = err?.name === 'AbortError' ? 'URL timed out — try a direct job board link.' : 'Could not load the job URL. Check it and try again.'
        setBatchStatus(msg, 'error')
      } finally {
        jobUrlBtn.disabled = false; jobUrlBtn.textContent = 'Validate URL'
      }
    })
  }

  if (campaignNameInput) {
    campaignNameInput.addEventListener('input', checkImportReady)
  }

  function checkImportReady() {
    if (!importBtn) return
    const hasName = (campaignNameInput?.value || '').trim().length > 0
    const hasCandidates = _parsedCandidates.length > 0
    const hasJob = !!_selectedJobId || _urlValidated
    importBtn.disabled = !(hasName && hasCandidates && hasJob)
  }

  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      const name = (campaignNameInput?.value || '').trim()
      if (!name || _parsedCandidates.length === 0) return
      if (!_selectedJobId && !_urlValidated) {
        setBatchStatus('Please link a valid saved job or validate a job URL before importing.', 'error')
        return
      }

      importBtn.disabled = true
      importBtn.textContent = 'Importing…'
      setBatchStatus('', '')
      try {
        const result = await importCampaign({
          campaignName: name,
          jobId: _selectedJobId || null,
          candidates: _parsedCandidates,
        })

        if (result.creditWarning) {
          const w = result.creditWarning
          showCreditWarning(w.message, w.available)
        }

        fileInput.value = ''
        if (campaignNameInput) campaignNameInput.value = ''
        if (previewEl) previewEl.textContent = ''
        _parsedCandidates = []
        _selectedJobId = null
        _urlValidated = false
        if ($('batchUrlJobConfirm')) $('batchUrlJobConfirm').style.display = 'none'

        await loadCampaignsList()
        if (result.campaign?.id) {
          await openCampaign(result.campaign.id, result.campaign)
        } else {
          showBatchPanel('campaigns')
        }
      } catch (e) {
        setBatchStatus(e.message || 'Import failed. Try again.', 'error')
        importBtn.disabled = false
        importBtn.textContent = 'Import campaign'
      }
    })
  }
}

// ── Candidates panel ───────────────────────────────────────────────────────────
async function loadCandidatePanel(campaignId) {
  if (!campaignId) return
  const list = $('batchCandidateList')
  if (!list) return
  list.innerHTML = '<div class="batch-loading">Loading candidates…</div>'

  // Build campaign selector if needed
  const sel = $('batchCampaignSelect')
  if (sel && !sel.querySelector(`option[value="${campaignId}"]`)) {
    await refreshCampaignSelect()
  }
  if (sel) sel.value = campaignId

  try {
    const { candidates } = await getCampaignCandidates({ campaignId })
    _allCandidates = candidates || []
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
  } catch {
    list.innerHTML = '<div class="batch-empty">Could not load candidates.</div>'
  }
}

async function refreshCampaignSelect() {
  try {
    const { campaigns } = await getCampaigns()
    const sel = $('batchCampaignSelect')
    if (!sel || !campaigns) return
    sel.innerHTML = '<option value="">— Select campaign —</option>'
    campaigns.forEach(c => {
      const opt = document.createElement('option')
      opt.value = c.id
      opt.textContent = c.name + (c.status === 'needs_job' ? ' ⚠' : '')
      sel.appendChild(opt)
    })
  } catch {}
}

function renderCandidateList(candidates, filterStatus) {
  const list = $('batchCandidateList')
  if (!list) return
  list.innerHTML = ''
  const filtered = filterStatus ? candidates.filter(c => {
    if (filterStatus === 'needs_enrichment') return ['imported','failed'].includes(c.status)
    if (filterStatus === 'needs_draft') return c.status === 'enriched'
    if (filterStatus === 'ready') return c.status === 'drafted'
    return true
  }) : candidates

  if (filtered.length === 0) {
    list.innerHTML = '<div class="batch-empty">No candidates match this filter.</div>'
    return
  }

  filtered.forEach(c => {
    const row = document.createElement('div')
    row.className = 'batch-candidate-row'
    row.dataset.id = c.id
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
    const titleLine = [c.enriched_title || c.current_title, c.enriched_company || c.current_company].filter(Boolean).join(' · ')
    const email = c.work_email || c.personal_email || c.csv_email || null
    const emailBadge = email
      ? `<span class="batch-badge ok-sm">${_esc(email)}</span>`
      : `<span class="batch-badge gray-sm">No email</span>`

    row.innerHTML = `
      <div class="batch-candidate-info">
        <div class="batch-candidate-name">${_esc(name)}</div>
        <div class="batch-candidate-meta">${_esc(titleLine)}</div>
        <div class="batch-candidate-email">${emailBadge} ${_statusBadge(c.status)}</div>
      </div>
      <div class="batch-candidate-actions">
        ${c.linkedin_url ? `<a href="${_esc(c.linkedin_url)}" target="_blank" class="batch-link-btn" title="Open LinkedIn">↗</a>` : ''}
        ${['imported','failed'].includes(c.status) ? `<button class="batch-btn batch-btn-xs" data-enrich="${c.id}">Enrich</button>` : ''}
        ${c.status === 'enriched' ? `<button class="batch-btn batch-btn-xs" data-draft="${c.id}">Draft</button>` : ''}
      </div>`

    const detailWrap = document.createElement('div')
    detailWrap.className = 'batch-candidate-detail'
    detailWrap.style.display = 'none'
    if (c.draft_body) {
      detailWrap.innerHTML = `
        <div class="batch-detail-subject">${_esc(c.draft_subject || '')}</div>
        <div class="batch-detail-body">${_esc(c.draft_body)}</div>`
    } else if (c.headline) {
      detailWrap.innerHTML = `<div class="batch-detail-body">${_esc(c.headline)}</div>`
    }

    row.querySelector('.batch-candidate-info').addEventListener('click', () => {
      const open = detailWrap.style.display !== 'none'
      detailWrap.style.display = open ? 'none' : 'block'
    })

    row.querySelector('[data-enrich]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await runSingleEnrich(c.id, row)
    })
    row.querySelector('[data-draft]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await runSingleDraft(c.id, row)
    })

    list.appendChild(row)
    list.appendChild(detailWrap)
  })
}

function updateBatchActionButtons() {
  const needsEnrich = _allCandidates.filter(c => ['imported','failed'].includes(c.status)).length
  const needsDraft  = _allCandidates.filter(c => c.status === 'enriched').length
  const enrichBtn = $('batchEnrichAllBtn')
  const draftBtn  = $('batchDraftAllBtn')
  if (enrichBtn) {
    enrichBtn.disabled = needsEnrich === 0
    enrichBtn.textContent = needsEnrich > 0 ? `Enrich ${needsEnrich} candidates` : 'All enriched'
  }
  if (draftBtn) {
    draftBtn.disabled = needsDraft === 0
    draftBtn.textContent = needsDraft > 0 ? `Draft ${needsDraft} candidates` : 'All drafted'
  }
}

// ── Single enrich/draft ────────────────────────────────────────────────────────
async function runSingleEnrich(candidateId, rowEl) {
  if (rowEl) rowEl.classList.add('batch-row-processing')
  try {
    const result = await enrichCampaignCandidate({ candidateId })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) {
      _allCandidates[idx].status = result.status || 'enriched'
      _allCandidates[idx].work_email = result.email || _allCandidates[idx].work_email
    }
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    const activeFilter = document.querySelector('.batch-filter-tab.active')?.dataset.filter
    renderCandidateList(_allCandidates, activeFilter)
    updateBatchActionButtons()
  } catch (e) {
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    if (e.code === 'CREDIT_LIMIT_REACHED') {
      showCreditWarning('Credit limit reached. Upgrade to continue enriching.', 0)
    }
  }
}

async function runSingleDraft(candidateId, rowEl) {
  if (rowEl) rowEl.classList.add('batch-row-processing')
  try {
    const result = await draftCampaignCandidate({ candidateId })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) {
      _allCandidates[idx].status = 'drafted'
      _allCandidates[idx].draft_subject = result.draft?.subject || ''
      _allCandidates[idx].draft_body = result.draft?.body || ''
    }
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    const activeFilter = document.querySelector('.batch-filter-tab.active')?.dataset.filter
    renderCandidateList(_allCandidates, activeFilter)
    updateBatchActionButtons()
  } catch {
    if (rowEl) rowEl.classList.remove('batch-row-processing')
  }
}

// ── Batch enrich all ──────────────────────────────────────────────────────────
async function runEnrichAll() {
  if (!_activeCampaignId) return
  const toEnrich = _allCandidates.filter(c => ['imported','failed'].includes(c.status))
  if (toEnrich.length === 0) return
  _batchAbort = false

  const enrichBtn = $('batchEnrichAllBtn')
  const progressEl = $('batchEnrichProgress')
  if (enrichBtn) { enrichBtn.disabled = true; enrichBtn.textContent = 'Enriching…' }

  let done = 0
  for (const candidate of toEnrich) {
    if (_batchAbort) break
    if (progressEl) progressEl.textContent = `${done} / ${toEnrich.length} enriched…`
    try {
      const result = await enrichCampaignCandidate({ candidateId: candidate.id })
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) {
        _allCandidates[idx].status = result.status || 'enriched'
        _allCandidates[idx].work_email = result.email || _allCandidates[idx].work_email
      }
    } catch (e) {
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) _allCandidates[idx].status = 'failed'
      if (e.code === 'CREDIT_LIMIT_REACHED') {
        showCreditWarning('Credit limit reached. Upgrade to continue enriching.', 0)
        break
      }
    }
    done++
    const activeFilter = document.querySelector('.batch-filter-tab.active')?.dataset.filter
    renderCandidateList(_allCandidates, activeFilter)
  }

  if (progressEl) progressEl.textContent = `${done} / ${toEnrich.length} enriched`
  updateBatchActionButtons()
  if (enrichBtn) enrichBtn.disabled = false
  setTimeout(() => { if (progressEl) progressEl.textContent = '' }, 3000)
}

// ── Batch draft all ────────────────────────────────────────────────────────────
async function runDraftAll() {
  if (!_activeCampaignId) return
  const toDraft = _allCandidates.filter(c => c.status === 'enriched')
  if (toDraft.length === 0) return
  _batchAbort = false

  const draftBtn = $('batchDraftAllBtn')
  const progressEl = $('batchDraftProgress')
  if (draftBtn) { draftBtn.disabled = true; draftBtn.textContent = 'Drafting…' }

  let done = 0
  for (const candidate of toDraft) {
    if (_batchAbort) break
    if (progressEl) progressEl.textContent = `${done} / ${toDraft.length} drafted…`
    try {
      const result = await draftCampaignCandidate({ candidateId: candidate.id })
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) {
        _allCandidates[idx].status = 'drafted'
        _allCandidates[idx].draft_subject = result.draft?.subject || ''
        _allCandidates[idx].draft_body = result.draft?.body || ''
      }
    } catch {
      // skip failed drafts, don't abort
    }
    done++
    const activeFilter = document.querySelector('.batch-filter-tab.active')?.dataset.filter
    renderCandidateList(_allCandidates, activeFilter)
  }

  if (progressEl) progressEl.textContent = `${done} / ${toDraft.length} drafted`
  updateBatchActionButtons()
  if (draftBtn) draftBtn.disabled = false
  setTimeout(() => { if (progressEl) progressEl.textContent = '' }, 3000)

  // Switch to review panel automatically if drafts completed
  if (done > 0) {
    await loadReviewPanel()
    showBatchPanel('review')
  }
}

// ── Review panel ───────────────────────────────────────────────────────────────
async function loadReviewPanel() {
  if (!_activeCampaignId) return
  const list = $('batchReviewList')
  if (!list) return

  const drafted = _allCandidates.filter(c => c.status === 'drafted')
  list.innerHTML = ''

  if (drafted.length === 0) {
    list.innerHTML = '<div class="batch-empty">No drafted candidates yet. Run "Draft all" first.</div>'
    updateReviewSummary()
    return
  }

  const sortedByConf = [...drafted].sort((a, b) => (b.draft_confidence || 0) - (a.draft_confidence || 0))
  sortedByConf.forEach(c => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
    const email = c.work_email || c.personal_email || c.csv_email || ''
    const card = document.createElement('div')
    card.className = 'batch-review-card'
    card.dataset.id = c.id
    const confPct = Math.round((c.draft_confidence || 0) * 100)
    card.innerHTML = `
      <div class="batch-review-header">
        <div>
          <div class="batch-review-name">${_esc(name)}</div>
          <div class="batch-review-meta">${_esc(email)} ${confPct > 0 ? `<span class="batch-conf-badge ${confPct >= 80 ? 'high' : confPct >= 60 ? 'mid' : 'low'}">${confPct}%</span>` : ''}</div>
        </div>
        <div class="batch-review-btns">
          <button class="batch-btn batch-btn-approve" data-approve="${c.id}">Approve</button>
          <button class="batch-btn batch-btn-skip" data-skip="${c.id}">Skip</button>
        </div>
      </div>
      <div class="batch-review-subject">${_esc(c.draft_subject || '')}</div>
      <textarea class="batch-review-body" data-cid="${c.id}">${_esc(c.draft_body || '')}</textarea>`

    card.querySelector('[data-approve]').addEventListener('click', () => approveCandidate(c.id, email, c, card))
    card.querySelector('[data-skip]').addEventListener('click', () => skipCandidate(c.id, card))
    list.appendChild(card)
  })

  updateReviewSummary()
}

async function approveCandidate(candidateId, email, candidate, cardEl) {
  try {
    await updateCandidateStatus({ candidateId, status: 'approved' })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'approved'

    const bodyEl = cardEl.querySelector(`textarea[data-cid="${candidateId}"]`)
    const body = bodyEl?.value || candidate.draft_body || ''
    const subject = candidate.draft_subject || `Reaching out — ${[candidate.first_name, candidate.last_name].filter(Boolean).join(' ')}`

    cardEl.classList.add('batch-card-approved')
    cardEl.querySelector('.batch-review-btns').innerHTML = `
      <button class="batch-btn batch-btn-gmail" data-gmail="${candidateId}">Gmail</button>
      <button class="batch-btn batch-btn-outlook" data-outlook="${candidateId}">Outlook</button>`

    cardEl.querySelector(`[data-gmail="${candidateId}"]`).addEventListener('click', () => {
      chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
    })
    cardEl.querySelector(`[data-outlook="${candidateId}"]`).addEventListener('click', () => {
      chrome.tabs.create({ url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
    })

    updateReviewSummary()
  } catch { alert('Could not approve candidate.') }
}

async function skipCandidate(candidateId, cardEl) {
  try {
    await updateCandidateStatus({ candidateId, status: 'skipped' })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'skipped'
    cardEl.classList.add('batch-card-skipped')
    cardEl.querySelector('.batch-review-btns').innerHTML = '<span class="batch-badge gray-sm">Skipped</span>'
    updateReviewSummary()
  } catch { alert('Could not skip candidate.') }
}

function updateReviewSummary() {
  const approved = _allCandidates.filter(c => c.status === 'approved').length
  const skipped  = _allCandidates.filter(c => c.status === 'skipped').length
  const drafted  = _allCandidates.filter(c => c.status === 'drafted').length
  const summaryEl = $('batchReviewSummary')
  if (summaryEl) summaryEl.textContent = `${approved} approved · ${skipped} skipped · ${drafted} remaining`

  const openAllBtn = $('batchOpenAllGmail')
  const openAllOutlookBtn = $('batchOpenAllOutlook')
  const approvedCount = _allCandidates.filter(c => c.status === 'approved').length
  if (openAllBtn) openAllBtn.disabled = approvedCount === 0
  if (openAllOutlookBtn) openAllOutlookBtn.disabled = approvedCount === 0
}

// ── Open all approved in email client (staggered) ─────────────────────────────
function openAllApproved(client) {
  const approvedCandidates = _allCandidates.filter(c => c.status === 'approved')
  approvedCandidates.forEach((c, i) => {
    const email = c.work_email || c.personal_email || c.csv_email || ''
    if (!email) return
    const bodyEl = document.querySelector(`textarea[data-cid="${c.id}"]`)
    const body = bodyEl?.value || c.draft_body || ''
    const subject = c.draft_subject || `Reaching out — ${[c.first_name, c.last_name].filter(Boolean).join(' ')}`
    setTimeout(() => {
      if (client === 'gmail') {
        chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
      } else {
        chrome.tabs.create({ url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
      }
    }, i * 400)
  })
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _statusBadge(status) {
  const map = {
    imported:  ['gray-sm', 'Imported'],
    enriching: ['info-sm', 'Enriching…'],
    enriched:  ['ok-sm', 'Enriched'],
    no_email:  ['warn-sm', 'No email'],
    drafting:  ['info-sm', 'Drafting…'],
    drafted:   ['ok-sm', 'Drafted'],
    approved:  ['green-sm', 'Approved'],
    skipped:   ['gray-sm', 'Skipped'],
    failed:    ['err-sm', 'Failed'],
  }
  const [cls, label] = map[status] || ['gray-sm', status]
  return `<span class="batch-badge ${cls}">${label}</span>`
}

function setBatchStatus(msg, type) {
  const el = $('batchStatus')
  if (!el) return
  el.textContent = msg
  el.className = `batch-status-bar${msg ? ' ' + type : ''}`
}

function showCreditWarning(message, available) {
  const el = $('batchCreditWarning')
  const msgEl = $('batchCreditWarningMsg')
  if (!el || !msgEl) return
  msgEl.textContent = message
  el.style.display = 'block'
  $('batchCreditUpgradeBtn')?.addEventListener('click', () => openUpgradePage(), { once: true })
  setTimeout(() => { el.style.display = 'none' }, 12000)
}

// ── Init ───────────────────────────────────────────────────────────────────────
export function initBatch() {
  const drawerCloseBtn = $('batchDrawerClose')
  drawerCloseBtn?.addEventListener('click', closeBatchDrawer)

  document.querySelectorAll('.batch-nav-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      showBatchPanel(tab.dataset.panel)
      if (tab.dataset.panel === 'candidates' && _activeCampaignId) {
        await loadCandidatePanel(_activeCampaignId)
      }
      if (tab.dataset.panel === 'review') {
        await loadReviewPanel()
      }
    })
  })

  const campaignSel = $('batchCampaignSelect')
  if (campaignSel) {
    campaignSel.addEventListener('change', async () => {
      _activeCampaignId = campaignSel.value || null
      if (_activeCampaignId) await loadCandidatePanel(_activeCampaignId)
    })
  }

  document.querySelectorAll('.batch-filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.batch-filter-tab').forEach(t => t.classList.remove('active'))
      tab.classList.add('active')
      renderCandidateList(_allCandidates, tab.dataset.filter)
    })
  })

  $('batchEnrichAllBtn')?.addEventListener('click', async () => {
    if (!_activeCampaignId) { setBatchStatus('Select a campaign first.', 'warn'); return }
    await runEnrichAll()
  })

  $('batchDraftAllBtn')?.addEventListener('click', async () => {
    if (!_activeCampaignId) { setBatchStatus('Select a campaign first.', 'warn'); return }
    await runDraftAll()
  })

  $('batchOpenAllGmail')?.addEventListener('click', () => openAllApproved('gmail'))
  $('batchOpenAllOutlook')?.addEventListener('click', () => openAllApproved('outlook'))

  $('batchNewCampaignBtn')?.addEventListener('click', () => showBatchPanel('import'))

  const linkJobSel = $('batchLinkJobSelect')
  const linkJobBtn = $('batchLinkJobBtn')
  if (linkJobSel && linkJobBtn) {
    linkJobBtn.addEventListener('click', async () => {
      const jobId = linkJobSel.value
      if (!jobId || !_activeCampaignId) return
      try {
        await linkCampaignJob({ campaignId: _activeCampaignId, jobId })
        setBatchStatus('Job linked. You can now enrich and draft candidates.', 'success')
        linkJobSel.value = ''
        $('batchLinkJobRow').style.display = 'none'
        await loadCandidatePanel(_activeCampaignId)
      } catch { setBatchStatus('Could not link job.', 'error') }
    })
  }

  setupImportPanel()
}
