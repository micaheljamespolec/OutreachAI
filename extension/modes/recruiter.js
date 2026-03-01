// ─── recruiter.js ─────────────────────────────────────────────────────────
// Recruiter & Sourcer mode — the only mode in OutreachAI.
// All labels, prompts and email templates live here.

export const RECRUITER_MODE = {
  id:    'recruiter',
  label: 'Recruiter',
  icon:  '🎯',

  // ─── UI Labels ────────────────────────────────────────────────────────────
  ui: {
    campaignTab:         '📋 Job',
    campaignTitle:       'Job Opening',
    campaignPlaceholder: 'Paste the full job description here, or enter the URL to the job posting...',
    campaignSaved:       '✅ Job description saved!',
    campaignEmpty:       '⚠️ No job description saved. Go to the 📋 Job tab first.',
    toFieldLabel:        'Candidate Email',
    toFieldPlaceholder:  'candidate@email.com',
    generateBtn:         '✨ Generate Outreach Email',
    successMessage:      '✅ Recruiter outreach email generated!',
  },

  // ─── AI Prompt ────────────────────────────────────────────────────────────
  buildPrompt(profile, jobDescription) {
    return `You are an expert recruiter writing professional outreach emails to potential candidates.

Candidate LinkedIn Profile:
- Name: ${profile.fullName}
- Current Title: ${profile.title}
- Current Company: ${profile.company}
- Skills: ${(profile.skills || []).join(', ')}

Job Opening:
${jobDescription.substring(0, 3000)}

Write a concise, personalized recruiter outreach email. The email should:
1. Open with a warm, personalized reference to their current role or skills
2. Briefly introduce the opportunity without giving everything away
3. Highlight 1-2 reasons why they specifically are a great fit
4. Be conversational and respectful of their time
5. End with a soft call-to-action (e.g. open to a quick chat?)
6. Be 150-200 words maximum

Respond ONLY with a valid JSON object (no markdown, no backticks):
{"subject": "Email subject line here", "body": "Full email body here"}`
  }
}