import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setApiKey } from '../lib/auth'
import { accountLogin, getSdk, resetSdk } from '../lib/sdk'
import { Btn } from '../components/ui/index'

/**
 * Login — the org dashboard sign-in (P3 / audit item 1).
 *
 * Primary flow: email + password → POST /account/login. The backend returns a
 * SHORT-LIVED access JWT (held in memory, see lib/auth) and sets an httpOnly
 * refresh cookie (unreadable by JS) for persistence across reloads. This
 * replaces the old "paste a JWT / cc_prv_ key into localStorage" model the
 * audit flagged (XSS could exfiltrate full commerce:admin creds).
 *
 * Advanced (CI) flow: a cc_prv_ API key, kept ONLY in memory by default (opt-in
 * tab-scoped sessionStorage), clearly labelled as powerful. Not the default.
 */
export default function Login() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'password' | 'advanced'>('password')

  // password mode
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // advanced (cc_prv_) mode
  const [apiKey, setApiKeyValue] = useState('')
  const [remember, setRemember] = useState(false)

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    setError('')
    setLoading(true)
    try {
      await accountLogin(email.trim(), password)
      void navigate('/')
    } catch {
      setError('Invalid email or password, or cannot reach the API.')
    } finally {
      setLoading(false)
    }
  }

  const handleAdvanced = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!apiKey.trim()) return
    setError('')
    if (!apiKey.startsWith('cc_prv_')) {
      setError('Advanced login requires a cc_prv_ (server-side) key.')
      return
    }
    setLoading(true)
    try {
      setApiKey(apiKey.trim(), { remember })
      resetSdk()
      await getSdk().stores.list()
      void navigate('/')
    } catch {
      setError('Invalid API key or cannot reach the API.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen bg-slate-950 flex items-center justify-center p-4 overflow-hidden">
      {/* Ambient brand glow */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(40rem_30rem_at_50%_-5%,rgba(91,89,230,0.18),transparent)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(30rem_30rem_at_80%_110%,rgba(79,70,229,0.10),transparent)]" />
      <div className="relative w-full max-w-md">
        <div className="flex flex-col items-center text-center mb-8">
          <img src="/logo.svg" alt="Cartcrft" className="h-12 w-12 rounded-xl shadow-lg shadow-violet-950/50 ring-1 ring-white/10 mb-4" />
          <h1 className="text-2xl font-bold tracking-tight text-white mb-1">Cartcrft Admin</h1>
          <p className="text-sm text-slate-500">Sign in to manage your store</p>
        </div>
        <div className="rounded-2xl border border-white/[0.08] bg-slate-900/60 backdrop-blur-sm shadow-xl shadow-black/40 p-6">
          <div className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-1 mb-5">
            {([
              ['password', 'Email & Password'],
              ['advanced', 'Advanced / CI'],
            ] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setError('') }}
                className={`flex-1 rounded-md py-2 text-xs font-semibold transition ${mode === m ? 'bg-gradient-to-b from-violet-500 to-violet-600 text-white shadow-sm ring-1 ring-inset ring-white/10' : 'text-slate-400 hover:text-white'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'password' ? (
            <form onSubmit={handlePassword} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500/40 focus:outline-none focus:ring-1 focus:ring-violet-500/20 transition"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500/40 focus:outline-none focus:ring-1 focus:ring-violet-500/20 transition"
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <Btn type="submit" loading={loading} className="w-full justify-center">
                Sign in
              </Btn>
            </form>
          ) : (
            <form onSubmit={handleAdvanced} className="space-y-4">
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5">
                <p className="text-[11px] leading-relaxed text-amber-300/90">
                  <strong>Powerful credential.</strong> A cc_prv_ key carries full
                  commerce:admin access. Use it only for CI / automation. It is held
                  in memory and never written to localStorage.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">Private API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={e => setApiKeyValue(e.target.value)}
                  placeholder="cc_prv_..."
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500/40 focus:outline-none focus:ring-1 focus:ring-violet-500/20 transition font-mono"
                />
              </div>
              <label className="flex items-center gap-2 text-[11px] text-slate-500 select-none">
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                Remember on this tab only (sessionStorage, cleared on close)
              </label>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <Btn type="submit" loading={loading} className="w-full justify-center">
                Use API key
              </Btn>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
