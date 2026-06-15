/**
 * Super-admin login page.
 *
 * - Email + password always shown.
 * - TOTP field appears conditionally when the backend returns MFA_REQUIRED.
 * - Handles LOCKED (423) and IP_BLOCKED (403) with distinct messaging.
 * - On success: token is stored IN MEMORY via AuthContext (never localStorage).
 *
 * Layout: split-screen on ≥768 px (form left, art panel right).
 * Art panel is hidden on mobile — form is always the primary focus.
 */

import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, SuperAdminApiError } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { AlertTriangle, Lock } from 'lucide-react'
import LoginArtPanel from './LoginArtPanel'

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
    /* ── Outer shell ──────────────────────────────────────────────────────── */
    <div
      className="min-h-screen bg-[var(--cc-steel)] flex"
      style={{ fontFamily: 'var(--cc-font-sans)' }}
    >

      {/* ── LEFT — form pane ─────────────────────────────────────────────── */}
      <div
        className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-hidden"
        style={{ background: 'linear-gradient(160deg, var(--cc-steel-2) 0%, var(--cc-steel) 100%)' }}
      >
        {/* Subtle lime glow behind the form */}
        <div
          className="absolute top-1/4 left-1/2 -translate-x-1/2 h-48 w-56 rounded-full pointer-events-none"
          style={{ background: 'var(--cc-lime)', opacity: 0.04, filter: 'blur(90px)' }}
          aria-hidden="true"
        />

        {/* Fine grid overlay on form side */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),' +
              'linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, #000 20%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, #000 20%, transparent 75%)',
            opacity: 0.6,
          }}
          aria-hidden="true"
        />

        <div className="relative w-full max-w-sm">
          {/* Header */}
          <div className="text-center mb-7">
            <div className="flex items-center justify-center gap-2.5 mb-5">
              <img src="/logo.svg" alt="" className="h-9 w-9" />
              <span
                className="text-[1.5rem] font-bold tracking-[-0.04em] text-[var(--cc-text)]"
                style={{ fontFamily: 'var(--cc-font-display)' }}
              >
                cart<span style={{ color: 'var(--cc-lime)' }}>crft</span>
              </span>
            </div>
            <h1 className="text-2xl font-bold text-[var(--cc-text)] tracking-tight">Operator Console</h1>
            <p
              className="mt-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--cc-text-muted)]"
              style={{ fontFamily: 'var(--cc-font-mono)' }}
            >
              Super-Admin
              <span className="mx-1.5 text-[var(--cc-text-subtle)]">&middot;</span>
              <span style={{ color: 'var(--cc-amber)', opacity: 0.9 }}>restricted access</span>
            </p>
          </div>

          {/* Security warning — amber */}
          <div
            className="mb-4 rounded-lg px-4 py-3 flex gap-2.5 items-start"
            style={{
              border: '1px solid rgba(245,184,66,0.22)',
              background: 'rgba(245,184,66,0.05)',
            }}
          >
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--cc-amber)' }} />
            <p
              className="text-[11px] leading-relaxed"
              style={{ color: 'rgba(245,184,66,0.82)' }}
            >
              This console has operator-level access to all tenant data. All actions are permanently
              audited. Unauthorized access is prohibited.
            </p>
          </div>

          {/* Card */}
          <div
            className="rounded-xl p-6 shadow-2xl"
            style={{
              border: '1px solid rgba(255,255,255,0.07)',
              background: 'rgba(17,19,26,0.85)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              boxShadow: '0 24px 64px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.05)',
            }}
          >
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Email */}
              <div>
                <label
                  className="block text-[10px] font-medium uppercase tracking-wider text-[var(--cc-text-muted)] mb-1.5"
                  style={{ fontFamily: 'var(--cc-font-mono)' }}
                >
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
                  className="w-full rounded-md px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-text-subtle)] transition disabled:opacity-50 focus:outline-none"
                  style={{
                    border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.025)',
                  }}
                  onFocus={e => {
                    e.currentTarget.style.borderColor = 'rgba(181,255,46,0.45)'
                    e.currentTarget.style.boxShadow = '0 0 0 2px rgba(181,255,46,0.15)'
                  }}
                  onBlur={e => {
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                    e.currentTarget.style.boxShadow = 'none'
                  }}
                />
              </div>

              {/* Password */}
              <div>
                <label
                  className="block text-[10px] font-medium uppercase tracking-wider text-[var(--cc-text-muted)] mb-1.5"
                  style={{ fontFamily: 'var(--cc-font-mono)' }}
                >
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
                  className="w-full rounded-md px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-text-subtle)] transition disabled:opacity-50 focus:outline-none"
                  style={{
                    border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.025)',
                  }}
                  onFocus={e => {
                    e.currentTarget.style.borderColor = 'rgba(181,255,46,0.45)'
                    e.currentTarget.style.boxShadow = '0 0 0 2px rgba(181,255,46,0.15)'
                  }}
                  onBlur={e => {
                    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
                    e.currentTarget.style.boxShadow = 'none'
                  }}
                />
              </div>

              {/* TOTP — shown only after MFA_REQUIRED */}
              {mfaRequired && (
                <div>
                  <label
                    className="block text-[10px] font-medium uppercase tracking-wider mb-1.5"
                    style={{ fontFamily: 'var(--cc-font-mono)', color: 'var(--cc-amber)' }}
                  >
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
                    className="w-full rounded-md px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-text-subtle)] text-center tracking-[0.3em] focus:outline-none"
                    style={{
                      fontFamily: 'var(--cc-font-mono)',
                      border: '1px solid rgba(245,184,66,0.3)',
                      background: 'rgba(255,255,255,0.025)',
                    }}
                    onFocus={e => {
                      e.currentTarget.style.borderColor = 'rgba(245,184,66,0.7)'
                      e.currentTarget.style.boxShadow = '0 0 0 2px rgba(245,184,66,0.2)'
                    }}
                    onBlur={e => {
                      e.currentTarget.style.borderColor = 'rgba(245,184,66,0.3)'
                      e.currentTarget.style.boxShadow = 'none'
                    }}
                  />
                </div>
              )}

              {/* Error states — amber for lockout warnings, red for blocked/denied */}
              {error && (
                <div
                  className="rounded-md px-3 py-2.5 text-xs"
                  style={
                    error.type === 'locked'
                      ? {
                          background: 'rgba(245,184,66,0.08)',
                          border: '1px solid rgba(245,184,66,0.25)',
                          color: 'rgba(245,184,66,0.9)',
                        }
                      : {
                          background: 'rgba(255,90,82,0.08)',
                          border: '1px solid rgba(255,90,82,0.25)',
                          color: 'rgba(255,90,82,0.9)',
                        }
                  }
                >
                  {error.message}
                </div>
              )}

              {/* Submit — lime primary, ink text */}
              <button
                type="submit"
                disabled={loading || error?.type === 'locked' || error?.type === 'blocked'}
                className="w-full flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition active:scale-[0.99] focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                style={{
                  background: 'var(--cc-lime)',
                  color: 'var(--cc-lime-ink)',
                  boxShadow: '0 0 0 1px rgba(181,255,46,0.2), 0 10px 28px -12px rgba(181,255,46,0.5)',
                }}
                onMouseEnter={e => {
                  if (!e.currentTarget.disabled)
                    e.currentTarget.style.background = 'var(--cc-lime-bright)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'var(--cc-lime)'
                }}
              >
                {loading && (
                  <span
                    className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin"
                  />
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

          {/* Footer badge */}
          <p
            className="flex items-center justify-center gap-1.5 text-center text-[10px] uppercase tracking-[0.1em] text-[var(--cc-text-subtle)] mt-4"
            style={{ fontFamily: 'var(--cc-font-mono)' }}
          >
            <Lock size={10} />
            Cartcrft Operator Console &middot; Access is logged
          </p>
        </div>
      </div>

      {/* ── RIGHT — art panel (hidden on mobile) ────────────────────────── */}
      <div
        className="hidden md:block"
        style={{
          width: '46%',
          maxWidth: '560px',
          flexShrink: 0,
          borderLeft: '1px solid rgba(255,255,255,0.055)',
        }}
      >
        <LoginArtPanel />
      </div>
    </div>
  )
}
