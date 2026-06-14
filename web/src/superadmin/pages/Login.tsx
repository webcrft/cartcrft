/**
 * Super-admin login page.
 *
 * - Email + password always shown.
 * - TOTP field appears conditionally when the backend returns MFA_REQUIRED.
 * - Handles LOCKED (423) and IP_BLOCKED (403) with distinct messaging.
 * - On success: token is stored IN MEMORY via AuthContext (never localStorage).
 */

import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, SuperAdminApiError } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { Shield, AlertTriangle, Lock } from 'lucide-react'

export default function Login() {
  const navigate = useNavigate()
  const { setAuth } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [mfaRequired, setMfaRequired] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ type: 'locked' | 'blocked' | 'mfa_invalid' | 'generic'; message: string } | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    if (mfaRequired && !totpCode.trim()) return

    setError(null)
    setLoading(true)

    try {
      const result = await login(
        email.trim(),
        password,
        mfaRequired ? totpCode.trim() : undefined,
      )

      if ('mfa_required' in result && result.mfa_required) {
        setMfaRequired(true)
        setLoading(false)
        return
      }

      // Successful login — result is LoginResult at this point
      const loginResult = result as import('../lib/api').LoginResult
      setAuth(loginResult.token, loginResult.expires_at, loginResult.super_admin)
      void navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof SuperAdminApiError) {
        if (err.status === 423 || err.code === 'ACCOUNT_LOCKED') {
          setError({ type: 'locked', message: 'Account locked due to too many failed attempts. Please try again in 15 minutes.' })
        } else if (err.status === 403 && err.code === 'IP_BLOCKED') {
          setError({ type: 'blocked', message: 'Access denied. Your IP address is not in the allowlist for this console.' })
        } else if (err.code === 'MFA_INVALID') {
          setError({ type: 'mfa_invalid', message: 'Invalid authenticator code. Please check the time on your device and try again.' })
        } else if (err.status === 401 || err.code === 'INVALID_CREDENTIALS') {
          setError({ type: 'generic', message: 'Invalid email or password.' })
        } else {
          setError({ type: 'generic', message: err.message || 'Sign in failed. Check your credentials and try again.' })
        }
      } else {
        setError({ type: 'generic', message: 'Cannot reach the API. Check your connection.' })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#080a0f] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Subtle grid pattern overlay for "ops" feel */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />
      {/* Brand glow */}
      <div
        className="absolute top-1/4 left-1/2 -translate-x-1/2 h-64 w-64 rounded-full bg-violet-600/15 blur-[100px] pointer-events-none"
        aria-hidden="true"
      />

      <div className="relative w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg shadow-violet-950/50 ring-1 ring-white/10 mb-4">
            <Shield size={22} className="text-white" strokeWidth={2.25} />
          </div>
          <div className="flex items-center justify-center gap-2 mb-1">
            <h1 className="text-xl font-bold text-slate-100 tracking-tight">Operator Console</h1>
          </div>
          <p className="text-xs text-slate-500">
            Cartcrft Super-Admin
            <span className="mx-1.5 text-slate-700">&middot;</span>
            <span className="text-amber-400/90 font-medium">restricted access</span>
          </p>
        </div>

        {/* Warning */}
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 flex gap-2.5 items-start">
          <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-300/80 leading-relaxed">
            This console has operator-level access to all tenant data. All actions are permanently
            audited. Unauthorized access is prohibited.
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/[0.08] bg-slate-900/70 backdrop-blur-xl shadow-2xl shadow-black/40 p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="admin@example.com"
                autoComplete="username"
                required
                disabled={mfaRequired}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30 transition disabled:opacity-50"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                disabled={mfaRequired}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30 transition disabled:opacity-50"
              />
            </div>

            {/* TOTP — shown only after MFA_REQUIRED */}
            {mfaRequired && (
              <div>
                <label className="block text-xs font-medium text-amber-400 mb-1.5">
                  Authenticator code
                </label>
                <p className="text-[11px] text-slate-500 mb-2">
                  Enter the 6-digit code from your authenticator app.
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={totpCode}
                  onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  autoFocus
                  className="w-full rounded-lg border border-amber-500/30 bg-white/[0.03] px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30 transition font-mono tracking-[0.3em] text-center"
                />
              </div>
            )}

            {/* Error states */}
            {error && (
              <div
                className={`rounded-lg px-3 py-2.5 text-xs border ${
                  error.type === 'locked'
                    ? 'bg-orange-500/10 border-orange-500/20 text-orange-300'
                    : error.type === 'blocked'
                    ? 'bg-red-600/10 border-red-500/20 text-red-300'
                    : 'bg-red-500/10 border-red-500/20 text-red-300'
                }`}
              >
                {error.message}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || error?.type === 'locked' || error?.type === 'blocked'}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-violet-600 text-white px-4 py-2.5 text-sm font-semibold shadow-sm shadow-violet-950/40 hover:bg-violet-500 transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              {loading && (
                <span className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              )}
              {mfaRequired ? 'Verify code' : 'Sign in'}
            </button>

            {mfaRequired && (
              <button
                type="button"
                onClick={() => { setMfaRequired(false); setTotpCode(''); setError(null) }}
                className="w-full text-xs text-slate-500 hover:text-slate-300 transition py-1"
              >
                Back to password
              </button>
            )}
          </form>
        </div>

        <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-slate-600 mt-4">
          <Lock size={10} />
          Cartcrft Operator Console &middot; Access is logged
        </p>
      </div>
    </div>
  )
}
