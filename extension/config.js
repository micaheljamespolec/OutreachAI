// ─── config.js ────────────────────────────────────────────────────────────────
export const CONFIG = {
  supabaseUrl: 'https://szxjcitbjcpkhxtjztay.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6eGpjaXRiamNwa2h4dGp6dGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3ODc2MDgsImV4cCI6MjA4NzM2MzYwOH0.9sgQhrNY8GGeMWIHPTnNehrM8eGD0tMHM6FCKDf-k08',

  fullenrichUrl: 'https://app.fullenrich.com/api/v1',

  appName:    'OutreachAI',
  version:    '1.0.0',
  pricingUrl: 'https://placeholder.com/pricing',

  stripe: {
    sourcer: {
      monthly: 'Monthly: price_1T3k99HBH8to4gGBHlNU3ewA',
      yearly:  'Yearly: price_1T3kAOHBH8to4gGBQvWk4fiF',
    },
    pro: {
      monthly: 'price_1T3kIDHBH8to4gGBnW3QoNBz',
      yearly:  'price_1T3kIvHBH8to4gGBV7WWfsD4',
    },
  },

  tiers: {
    free:    { lookups: 10,  emails: 10,   label: 'Free'    },
    sourcer: { lookups: 50,  emails: 100,  label: 'Sourcer' },
    pro:     { lookups: 200, emails: 9999, label: 'Pro'     },
  },

  bonusActivities: {
    verifyEmail:        3,
    generateFirstDraft: 5,
    rateExtension:      10,
  },

  features: {
    phoneNumberLookup: false,
    bulkExport:        false,
    crmIntegration:    false,
    teamAccounts:      false,
    emailSequences:    false,
  },
}