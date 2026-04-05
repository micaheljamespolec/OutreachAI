;(async () => {
  const SUPABASE_URL     = 'https://szxjcitbjcpkhxtjztay.supabase.co'
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6eGpjaXRiamNwa2h4dGp6dGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3ODc2MDgsImV4cCI6MjA4NzM2MzYwOH0.9sgQhrNY8GGeMWIHPTnNehrM8eGD0tMHM6FCKDf-k08'

  const box = document.getElementById('box')

  function showSuccess () {
    box.innerHTML = '<div class="icon">✅</div><h2>Signed in successfully</h2><p>This tab will close automatically…</p>'
  }
  function showError (msg) {
    box.innerHTML = '<div class="icon">❌</div><h2>Sign-in failed</h2><p>' + msg + '</p>'
  }

  try {
    const hash        = window.location.hash.substring(1)
    const params      = new URLSearchParams(hash)
    const accessToken  = params.get('access_token')
    const refreshToken = params.get('refresh_token')
    const expiresIn    = parseInt(params.get('expires_in') || '3600', 10)

    if (!accessToken) {
      showError('No token found. Please try signing in again.')
      return
    }

    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'apikey':        SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + accessToken,
      },
    })

    if (!res.ok) {
      showError('Token validation failed. Please try again.')
      return
    }

    const user = await res.json()

    await chrome.storage.local.set({
      outreachai_session: {
        access_token:  accessToken,
        refresh_token: refreshToken,
        expires_at:    Math.floor(Date.now() / 1000) + expiresIn,
        user,
      },
    })

    console.log('[OutreachAI] Session saved for:', user.email)
    showSuccess()
    setTimeout(() => window.close(), 1500)

  } catch (e) {
    console.error('[OutreachAI] Auth error:', e)
    showError('Something went wrong. Please try again.')
  }
})()
