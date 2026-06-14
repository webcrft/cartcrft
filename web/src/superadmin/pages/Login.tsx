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
import { AlertTriangle, Lock } from 'lucide-react'

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
    <div className="min-h-screen bg-[var(--cc-ink)] flex items-center justify-center p-4 relative overflow-hidden">
      {/* Technical grid pattern overlay for the "terminal" feel */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
          backgroundSize: '52px 52px',
          maskImage: 'radial-gradient(ellipse 80% 70% at 50% 35%, #000 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 70% at 50% 35%, #000 20%, transparent 75%)',
        }}
      />
      {/* Lime brand glow */}
      <div
        className="absolute top-1/4 left-1/2 -translate-x-1/2 h-64 w-72 rounded-full bg-[var(--cc-lime)]/12 blur-[110px] pointer-events-none"
        aria-hidden="true"
      />

      <div className="relative w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-7">
          <img
            src="/logo-wordmark-dark.svg"
            alt="Cartcrft"
            className="h-8 w-auto mx-auto mb-5"
          />
          <h1 className="text-2xl font-bold text-[var(--cc-text)] tracking-tight">Operator Console</h1>
          <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--cc-text-muted)]">
            Super-Admin
            <span className="mx-1.5 text-[var(--cc-text-subtle)]">&middot;</span>
            <span className="text-amber-400/90">restricted access</span>
          </p>
        </div>

        {/* Warning — amber */}
        <div className="mb-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 flex gap-2.5 items-start">
          <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-300/85 leading-relaxed">
            This console has operator-level access to all tenant data. All actions are permanently
            audited. Unauthorized access is prohibited.
          </p>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-white/[0.08] bg-[var(--cc-surface-steel)]/80 backdrop-blur-xl shadow-2xl shadow-black/50 p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email */}
            <div>
              <label className="block font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--cc-text-muted)] mb-1.5">
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
                className="w-full rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-text-subtle)] focus:border-[var(--cc-lime)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--cc-lime)]/40 transition disabled:opacity-50"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--cc-text-muted)] mb-1.5">
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
                className="w-full rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-text-subtle)] focus:border-[var(--cc-lime)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--cc-lime)]/40 transition disabled:opacity-50"
              />
            </div>

            {/* TOTP — shown only after MFA_REQUIRED */}
            {mfaRequired && (
              <div>
                <label className="block font-mono text-[10px] font-medium uppercase tracking-wider text-amber-400 mb-1.5">
                  Authenticator code
                </label>
                <p className="text-[11px] text-[var(--cc-text-muted)] mb-2">
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
                  className="w-full rounded-md border border-amber-500/30 bg-white/[0.02] px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-text-subtle)] focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/30 transition font-mono tracking-[0.3em] text-center"
                />
              </div>
            )}

            {/* Error states — amber for lockout warnings, red for blocked/denied */}
            {error && (
              <div
                className={`rounded-md px-3 py-2.5 text-xs border ${
                  error.type === 'locked'
                    ? 'bg-amber-500/10 border-amber-500/25 text-amber-300'
                    : error.type === 'blocked'
                    ? 'bg-red-600/10 border-red-500/25 text-red-300'
                    : 'bg-red-500/10 border-red-500/25 text-red-300'
                }`}
              >
                {error.message}
              </div>
            )}

            {/* Submit — lime primary, ink text */}
            <button
              type="submit"
              disabled={loading || error?.type === 'locked' || error?.type === 'blocked'}
              className="w-full flex items-center justify-center gap-2 rounded-md bg-[var(--cc-lime)] text-[var(--cc-lime-ink)] px-4 py-2.5 text-sm font-semibold shadow-[0_0_0_1px_rgba(181,255,46,0.2),0_10px_28px_-12px_rgba(181,255,46,0.55)] hover:bg-[var(--cc-lime-bright)] transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cc-lime)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cc-ink)] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
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
                className="w-full text-xs text-[var(--cc-text-muted)] hover:text-[var(--cc-text-body)] transition py-1"
              >
                Back to password
              </button>
            )}
          </form>
        </div>

        <p className="flex items-center justify-center gap-1.5 text-center font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--cc-text-subtle)] mt-4">
          <Lock size={10} />
          Cartcrft Operator Console &middot; Access is logged
        </p>
      </div>
    </div>
  )
}
