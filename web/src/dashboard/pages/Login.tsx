import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { setApiKey } from '../lib/auth'
import { accountLogin, getSdk, resetSdk } from '../lib/sdk'
import { Btn } from '../components/ui/index'

/**
 * Login — the org dashboard sign-in (P3 / audit item 1).
 *
 * Primary flow: email + password → POST /account/login. The backend returns a
 * SHORT-LIVED access JWT (held in memory, see lib/auth) and sets an httpOnly
 * refresh cookie (unreadable by JS) for persistence across reloads.
 *
 * Advanced (CI) flow: a cc_prv_ API key, kept ONLY in memory by default (opt-in
 * tab-scoped sessionStorage), clearly labelled as powerful.
 */

/** Rotating value lines shown in the artwork panel. */
const VALUE_LINES = [
  'Commerce infrastructure for the agentic era',
  'Headless. Composable. Production-ready.',
  'Ship your store in hours, not months.',
  'One SDK — every commerce primitive.',
  'Built for builders. Priced for growth.',
]

/** Hexagon + cart mark SVG — cartcrft brand icon */
function HexCartMark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Hexagon outline */}
      <polygon
        points="32,4 58,18 58,46 32,60 6,46 6,18"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinejoin="round"
        opacity="0.35"
      />
      {/* Cart body */}
      <path
        d="M20 22h4l3 14h14l3-10H24"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Wheels */}
      <circle cx="28" cy="39" r="2" fill="currentColor" opacity="0.8" />
      <circle cx="38" cy="39" r="2" fill="currentColor" opacity="0.8" />
    </svg>
  )
}

/** Animated technical grid lines */
function GridLines() {
  return (
    <svg
      viewBox="0 0 400 600"
      xmlns="http://www.w3.org/2000/svg"
      className="absolute inset-0 w-full h-full"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <pattern id="login-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(181,255,46,0.06)" strokeWidth="0.5" />
        </pattern>
        <radialGradient id="login-grid-mask" cx="60%" cy="30%" r="60%">
          <stop offset="0%" stopColor="white" stopOpacity="1" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id="login-grid-fade">
          <rect width="100%" height="100%" fill="url(#login-grid-mask)" />
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="url(#login-grid)" mask="url(#login-grid-fade)" />
    </svg>
  )
}

/** Flow-diagram motif — three nodes with animated connecting paths */
function FlowMotif() {
  return (
    <svg
      viewBox="0 0 280 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="w-full max-w-[280px]"
      aria-hidden="true"
    >
      <defs>
        <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L6,3 z" fill="rgba(181,255,46,0.5)" />
        </marker>
      </defs>
      {/* Connector lines */}
      <path
        d="M 72 60 L 108 60"
        stroke="rgba(181,255,46,0.4)"
        strokeWidth="1"
        strokeDasharray="4 3"
        markerEnd="url(#arrowhead)"
        className="login-dash-flow"
      />
      <path
        d="M 172 60 L 208 60"
        stroke="rgba(181,255,46,0.4)"
        strokeWidth="1"
        strokeDasharray="4 3"
        markerEnd="url(#arrowhead)"
        className="login-dash-flow"
      />
      {/* Node A: Checkout */}
      <rect x="8" y="40" width="64" height="40" rx="6" fill="rgba(181,255,46,0.06)" stroke="rgba(181,255,46,0.25)" strokeWidth="1" />
      <text x="40" y="56" textAnchor="middle" fill="rgba(181,255,46,0.9)" fontSize="7" fontFamily="var(--cc-font-mono)" letterSpacing="0.05em">CHECKOUT</text>
      <text x="40" y="68" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="6" fontFamily="var(--cc-font-mono)">cart → order</text>
      {/* Node B: Commerce Engine */}
      <rect x="108" y="32" width="64" height="56" rx="6" fill="rgba(181,255,46,0.1)" stroke="rgba(181,255,46,0.4)" strokeWidth="1" />
      <text x="140" y="56" textAnchor="middle" fill="rgba(181,255,46,1)" fontSize="7" fontFamily="var(--cc-font-mono)" letterSpacing="0.05em" fontWeight="600">CARTCRFT</text>
      <text x="140" y="68" textAnchor="middle" fill="rgba(181,255,46,0.6)" fontSize="6" fontFamily="var(--cc-font-mono)">commerce API</text>
      {/* Lime glow on center node */}
      <rect x="108" y="32" width="64" height="56" rx="6" fill="none" stroke="rgba(181,255,46,0.15)" strokeWidth="8" />
      {/* Node C: Storefront */}
      <rect x="208" y="40" width="64" height="40" rx="6" fill="rgba(181,255,46,0.06)" stroke="rgba(181,255,46,0.25)" strokeWidth="1" />
      <text x="240" y="56" textAnchor="middle" fill="rgba(181,255,46,0.9)" fontSize="7" fontFamily="var(--cc-font-mono)" letterSpacing="0.05em">STOREFRONT</text>
      <text x="240" y="68" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="6" fontFamily="var(--cc-font-mono)">headless</text>
    </svg>
  )
}

/** Mini terminal block */
function TerminalBlock() {
  return (
    <div
      className="rounded-lg border overflow-hidden text-left"
      style={{
        borderColor: 'rgba(181,255,46,0.2)',
        background: 'linear-gradient(180deg,rgba(12,13,10,0.9) 0%,rgba(8,9,6,0.95) 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(181,255,46,0.08), inset 0 40px 60px -40px rgba(181,255,46,0.12)',
      }}
    >
      {/* Title bar */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b" style={{ borderColor: 'rgba(181,255,46,0.08)', background: 'rgba(255,255,255,0.015)' }}>
        <span className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
        <span className="w-2.5 h-2.5 rounded-full bg-amber-400/60" />
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/60" />
        <span className="ml-2 font-mono text-[10px] text-[var(--cc-muted)]">cartcrft — admin sdk</span>
        <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-[var(--cc-lime)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--cc-lime)] login-pulse-dot" />
          LIVE
        </span>
      </div>
      {/* Code */}
      <pre className="px-4 py-3 font-mono text-[11px] leading-[1.9] overflow-x-auto">
        <code>
          <span className="login-ln login-delay-1 block"><span style={{ color: 'rgba(133,134,122,0.7)' }}>{'//'} initialize store</span></span>
          <span className="login-ln login-delay-2 block"><span style={{ color: 'rgba(181,255,46,0.9)' }}>const</span> <span style={{ color: 'rgba(236,234,224,0.9)' }}>sdk</span> <span style={{ color: 'rgba(133,134,122,0.7)' }}>=</span> <span style={{ color: 'rgba(87,224,255,0.85)' }}>new</span> <span style={{ color: 'rgba(181,255,46,1)' }}>CartCrft</span><span style={{ color: 'rgba(236,234,224,0.6)' }}>{'({ baseUrl })'}</span></span>
          <span className="login-ln login-delay-3 block"><span style={{ color: 'rgba(181,255,46,0.9)' }}>const</span> <span style={{ color: 'rgba(236,234,224,0.9)' }}>order</span> <span style={{ color: 'rgba(133,134,122,0.7)' }}>=</span> <span style={{ color: 'rgba(181,255,46,0.7)' }}>await</span> <span style={{ color: 'rgba(236,234,224,0.7)' }}>sdk.orders.</span><span style={{ color: 'rgba(181,255,46,0.9)' }}>create</span><span style={{ color: 'rgba(236,234,224,0.6)' }}>{'(cart)'}</span></span>
          <span className="login-ln login-delay-4 block"><span style={{ color: 'rgba(181,255,46,1)', fontWeight: 600 }}>{'// ✓'}</span> <span style={{ color: 'rgba(181,255,46,0.7)' }}>order created in 42ms</span></span>
          <span className="login-ln login-delay-5 block"><span style={{ color: 'rgba(236,234,224,0.9)' }}>_</span><span className="login-caret" /></span>
        </code>
      </pre>
    </div>
  )
}

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

  // Rotating value line
  const [lineIdx, setLineIdx] = useState(0)
  const [fadeIn, setFadeIn] = useState(true)
  useEffect(() => {
    const id = setInterval(() => {
      setFadeIn(false)
      setTimeout(() => {
        setLineIdx(i => (i + 1) % VALUE_LINES.length)
        setFadeIn(true)
      }, 350)
    }, 3800)
    return () => clearInterval(id)
  }, [])

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
    <>
      {/* Inline styles for login-specific animations */}
      <style>{`
        @keyframes login-glow-drift {
          0%,100% { transform: translate(0,0) scale(1); }
          50% { transform: translate(-30px,25px) scale(1.05); }
        }
        @keyframes login-glow-drift-2 {
          0%,100% { transform: translate(0,0) scale(1); }
          50% { transform: translate(20px,-20px) scale(0.97); }
        }
        @keyframes login-grain-drift {
          0%,100% { transform: translate(0,0); }
          25% { transform: translate(-1%,-1%); }
          50% { transform: translate(1%,1%); }
          75% { transform: translate(-0.5%,0.5%); }
        }
        @keyframes login-dash-flow {
          to { stroke-dashoffset: -14; }
        }
        @keyframes login-blink { 0%,60%{opacity:1} 61%,100%{opacity:0.25} }
        @keyframes login-ln-in { from{opacity:0;transform:translateY(3px)} to{opacity:1;transform:none} }
        @keyframes login-pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes login-caret-blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }
        @keyframes login-value-fade-in { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
        @keyframes login-hex-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
        @keyframes login-float-1 { 0%,100%{transform:translate(0,0) rotate(0deg)} 50%{transform:translate(4px,-8px) rotate(3deg)} }
        @keyframes login-float-2 { 0%,100%{transform:translate(0,0) rotate(0deg)} 50%{transform:translate(-5px,6px) rotate(-2deg)} }

        .login-dash-flow { animation: login-dash-flow 1.1s linear infinite; }
        .login-blink-dot { animation: login-blink 1.8s steps(1) infinite; }
        .login-ln { opacity: 0; animation: login-ln-in 0.4s ease forwards; }
        .login-delay-1 { animation-delay: 0.6s; }
        .login-delay-2 { animation-delay: 0.9s; }
        .login-delay-3 { animation-delay: 1.2s; }
        .login-delay-4 { animation-delay: 1.5s; }
        .login-delay-5 { animation-delay: 1.8s; }
        .login-pulse-dot { animation: login-pulse-dot 1.4s ease-in-out infinite; }
        .login-caret {
          display: inline-block; width: 6px; height: 0.9em;
          background: var(--cc-lime); vertical-align: -1px; margin-left: 1px;
          animation: login-caret-blink 1s steps(1) infinite;
        }
        .login-hex-bob { animation: login-hex-bob 5s ease-in-out infinite; }
        .login-float-1 { animation: login-float-1 7s ease-in-out infinite; }
        .login-float-2 { animation: login-float-2 9s ease-in-out 0.5s infinite; }
        .login-value-text { transition: opacity 0.35s ease, transform 0.35s ease; }
        .login-value-text.in { opacity: 1; transform: none; }
        .login-value-text.out { opacity: 0; transform: translateY(6px); }

        @media (prefers-reduced-motion: reduce) {
          .login-dash-flow, .login-blink-dot, .login-ln, .login-pulse-dot,
          .login-caret, .login-hex-bob, .login-float-1, .login-float-2 {
            animation: none !important; opacity: 1 !important;
          }
          .login-value-text { transition: none !important; }
        }
      `}</style>

      <div className="relative min-h-screen bg-[var(--cc-bg)] flex overflow-hidden">

        {/* ── LEFT: Form panel ─────────────────────────────────────────── */}
        <div className="relative z-10 flex flex-col justify-center w-full lg:w-[46%] xl:w-[44%] px-8 sm:px-12 lg:px-16 py-12">
          {/* Subtle ambient glow behind form */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(36rem 30rem at 0% 50%,rgba(181,255,46,0.06),transparent)' }}
          />

          <div className="relative w-full max-w-sm mx-auto lg:mx-0">
            {/* Logo + brand */}
            <div className="flex items-center gap-3 mb-10">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-xl border text-[var(--cc-lime)]"
                style={{ borderColor: 'rgba(181,255,46,0.25)', background: 'rgba(181,255,46,0.08)' }}
              >
                <HexCartMark className="h-6 w-6" />
              </div>
              <div>
                <div
                  style={{ fontFamily: 'var(--cc-font-display)' }}
                  className="text-lg font-bold tracking-[-0.04em] text-[var(--cc-text)] leading-none"
                >
                  cart<span className="text-[var(--cc-lime)]">crft</span>
                </div>
                <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--cc-subtle)] leading-none mt-0.5">
                  <span style={{ color: 'var(--cc-subtle)' }}>[</span>{' '}
                  admin console{' '}
                  <span style={{ color: 'var(--cc-subtle)' }}>]</span>
                </div>
              </div>
            </div>

            <h1 className="text-2xl font-bold tracking-tight text-[var(--cc-text)] mb-1.5">Sign in</h1>
            <p className="text-sm text-[var(--cc-muted)] mb-8">Manage your store, orders, and customers.</p>

            {/* Mode tabs */}
            <div
              className="flex rounded-lg p-1 mb-6"
              style={{ background: 'var(--cc-bg-sunken)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              {([
                ['password', 'Email & Password'],
                ['advanced', 'Advanced / CI'],
              ] as const).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setMode(m); setError('') }}
                  className={`flex-1 rounded-md py-2 text-xs font-semibold transition-all ${
                    mode === m
                      ? 'bg-[var(--cc-lime)] text-[var(--cc-ink)] shadow-sm'
                      : 'text-[var(--cc-muted)] hover:text-[var(--cc-text)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Form card */}
            <div
              className="rounded-xl p-6"
              style={{
                background: 'var(--cc-surface)',
                border: '1px solid rgba(255,255,255,0.07)',
                boxShadow: '0 20px 60px -20px rgba(0,0,0,0.5)',
              }}
            >
              {mode === 'password' ? (
                <form onSubmit={handlePassword} className="space-y-4">
                  <div>
                    <label className="block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cc-muted)] mb-1.5">Email</label>
                    <input
                      type="email"
                      autoComplete="username"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="you@company.com"
                      className="w-full rounded-lg px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] transition focus:outline-none focus:ring-2"
                      style={{
                        background: 'var(--cc-bg-sunken)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        '--tw-ring-color': 'rgba(181,255,46,0.25)',
                      } as React.CSSProperties}
                      onFocus={e => { e.currentTarget.style.borderColor = 'rgba(181,255,46,0.45)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cc-muted)]">Password</label>
                    </div>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-lg px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] transition focus:outline-none focus:ring-2"
                      style={{
                        background: 'var(--cc-bg-sunken)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        '--tw-ring-color': 'rgba(181,255,46,0.25)',
                      } as React.CSSProperties}
                      onFocus={e => { e.currentTarget.style.borderColor = 'rgba(181,255,46,0.45)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                    />
                  </div>
                  {error && (
                    <div className="rounded-lg px-3 py-2.5 text-xs text-red-300" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                      {error}
                    </div>
                  )}
                  <Btn type="submit" loading={loading} className="w-full justify-center mt-1">
                    Sign in
                  </Btn>
                </form>
              ) : (
                <form onSubmit={handleAdvanced} className="space-y-4">
                  <div className="rounded-lg px-3 py-2.5" style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
                    <p className="text-[11px] leading-relaxed text-amber-300/90">
                      <strong>Powerful credential.</strong> A cc_prv_ key carries full
                      commerce:admin access. Use it only for CI / automation. It is held
                      in memory and never written to localStorage.
                    </p>
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cc-muted)] mb-1.5">Private API Key</label>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={e => setApiKeyValue(e.target.value)}
                      placeholder="cc_prv_..."
                      style={{
                        fontFamily: 'var(--cc-font-mono)',
                        background: 'var(--cc-bg-sunken)',
                        border: '1px solid rgba(255,255,255,0.08)',
                      }}
                      className="w-full rounded-lg px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] transition focus:outline-none focus:ring-2"
                      onFocus={e => { e.currentTarget.style.borderColor = 'rgba(181,255,46,0.45)' }}
                      onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-[var(--cc-muted)] select-none cursor-pointer">
                    <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="rounded" />
                    Remember on this tab only (sessionStorage, cleared on close)
                  </label>
                  {error && (
                    <div className="rounded-lg px-3 py-2.5 text-xs text-red-300" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                      {error}
                    </div>
                  )}
                  <Btn type="submit" loading={loading} className="w-full justify-center mt-1">
                    Use API key
                  </Btn>
                </form>
              )}
            </div>

            {/* Footer note */}
            <p className="mt-6 text-center text-[11px] text-[var(--cc-subtle)]">
              CartCrft Admin — headless commerce infrastructure
            </p>
          </div>
        </div>

        {/* ── RIGHT: Artwork panel (hidden on mobile/tablet) ───────────── */}
        <div
          className="hidden lg:flex lg:w-[54%] xl:w-[56%] relative overflow-hidden flex-col items-center justify-center p-12"
          style={{ background: 'var(--cc-bg-subtle)', borderLeft: '1px solid rgba(255,255,255,0.05)' }}
          aria-hidden="true"
        >
          {/* Grid lines */}
          <GridLines />

          {/* Primary lime glow */}
          <div
            className="absolute pointer-events-none"
            style={{
              top: '-15%',
              right: '-10%',
              width: '55%',
              paddingBottom: '55%',
              borderRadius: '50%',
              background: 'radial-gradient(circle,rgba(181,255,46,0.2),transparent 65%)',
              filter: 'blur(40px)',
              animation: 'login-glow-drift 18s ease-in-out infinite',
            }}
          />
          {/* Secondary cyan glow */}
          <div
            className="absolute pointer-events-none"
            style={{
              bottom: '-20%',
              left: '-10%',
              width: '45%',
              paddingBottom: '45%',
              borderRadius: '50%',
              background: 'radial-gradient(circle,rgba(87,224,255,0.12),transparent 65%)',
              filter: 'blur(35px)',
              animation: 'login-glow-drift-2 22s ease-in-out 1s infinite',
            }}
          />

          {/* Grain overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              opacity: 0.035,
              backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\'/%3E%3C/svg%3E")',
              backgroundRepeat: 'repeat',
              backgroundSize: '192px',
              animation: 'login-grain-drift 8s steps(4) infinite',
            }}
          />

          {/* Content */}
          <div className="relative z-10 w-full max-w-md space-y-10">
            {/* Brand mark */}
            <div className="flex items-center gap-4">
              <div className="login-hex-bob text-[var(--cc-lime)]">
                <HexCartMark className="w-14 h-14" />
              </div>
              <div>
                <div
                  style={{ fontFamily: 'var(--cc-font-display)' }}
                  className="text-3xl font-bold tracking-[-0.05em] text-[var(--cc-text)] leading-none"
                >
                  cart<span className="text-[var(--cc-lime)]">crft</span>
                </div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--cc-subtle)] mt-1">
                  <span className="text-[var(--cc-subtle)]">[</span>
                  <span className="text-[var(--cc-lime)]">
                    <span className="login-blink-dot inline-block w-1.5 h-1.5 rounded-full bg-[var(--cc-lime)] align-middle mr-1" />
                    agentic commerce
                  </span>
                  <span className="text-[var(--cc-subtle)]">]</span>
                </div>
              </div>
            </div>

            {/* Rotating value line */}
            <div className="min-h-[2.5rem] flex items-center">
              <p
                className={`login-value-text text-xl font-semibold tracking-tight text-[var(--cc-text)] ${fadeIn ? 'in' : 'out'}`}
                style={{ fontFamily: 'var(--cc-font-display)', letterSpacing: '-0.03em' }}
              >
                {VALUE_LINES[lineIdx]}
              </p>
            </div>

            {/* Terminal block */}
            <div className="login-float-1">
              <TerminalBlock />
            </div>

            {/* Flow diagram */}
            <div className="login-float-2">
              <FlowMotif />
            </div>

            {/* Spec strip */}
            <div
              className="grid grid-cols-3 gap-4 pt-6"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
            >
              {[
                { label: 'API Resources', value: '40+' },
                { label: 'SDKs', value: 'TS / Go' },
                { label: 'Uptime SLA', value: '99.9%' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <dt className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--cc-subtle)]">{label}</dt>
                  <dd
                    className="text-base font-semibold text-[var(--cc-text)] mt-0.5"
                    style={{ fontFamily: 'var(--cc-font-display)', letterSpacing: '-0.02em' }}
                  >
                    <span className="text-[var(--cc-lime)]">{value}</span>
                  </dd>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </>
  )
}
