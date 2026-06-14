/**
 * Super-admin UI primitives.
 *
 * Visually distinct from the org dashboard — uses a zinc/neutral palette with
 * red/amber accents to signal "operator console / high-stakes environment".
 * No violet; this is intentionally different.
 */

import React from 'react'

// ── Badge ─────────────────────────────────────────────────────────────────────

type BadgeColor = 'emerald' | 'amber' | 'red' | 'blue' | 'zinc' | 'orange'

export function Badge({
  children,
  color = 'zinc',
}: {
  children: React.ReactNode
  color?: BadgeColor
}) {
  const colors: Record<BadgeColor, string> = {
    emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    red: 'bg-red-500/15 text-red-400 border-red-500/20',
    blue: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    orange: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
    zinc: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/20',
  }
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${colors[color]}`}
    >
      {children}
    </span>
  )
}

// ── Btn ───────────────────────────────────────────────────────────────────────

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'warning'

export function Btn({
  children,
  onClick,
  variant = 'primary',
  disabled,
  loading,
  className = '',
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: BtnVariant
  disabled?: boolean
  loading?: boolean
  className?: string
  type?: 'button' | 'submit' | 'reset'
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition disabled:opacity-50'
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-zinc-100 text-zinc-900 hover:bg-white',
    warning: 'bg-amber-600 text-white hover:bg-amber-500',
    secondary: 'border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:text-white',
    danger: 'border border-red-500/30 bg-red-600/10 text-red-300 hover:bg-red-600/20',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled ?? loading}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {loading && (
        <span className="h-3.5 w-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
      )}
      {children}
    </button>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────

export function Card({
  title,
  children,
  className = '',
}: {
  title?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-xl border border-white/[0.07] bg-zinc-900/60 overflow-hidden ${className}`}
    >
      {title && (
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  )
}

// ── FormInput ─────────────────────────────────────────────────────────────────

export function FormInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  className = '',
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  className?: string
}) {
  return (
    <div className={className}>
      {label && (
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">{label}</label>
      )}
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/[0.08] bg-zinc-800/60 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-white/10 transition"
      />
    </div>
  )
}

// ── PageHeader ────────────────────────────────────────────────────────────────

export function PageHeader({
  title,
  description,
  actions,
  badge,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  badge?: React.ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
          {badge}
        </div>
        {description && <p className="text-xs text-zinc-500 mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

// ── EmptyState ────────────────────────────────────────────────────────────────

export function EmptyState({
  title,
  description,
}: {
  title: string
  description?: string
}) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 p-16 text-center">
      <p className="text-sm font-medium text-zinc-300 mb-1">{title}</p>
      {description && (
        <p className="text-xs text-zinc-500 max-w-sm mx-auto">{description}</p>
      )}
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-5 w-5 border-2 border-current border-t-transparent rounded-full animate-spin text-zinc-500 ${className}`}
    />
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-white/[0.1] bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.07]">
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-100 hover:bg-white/[0.06] transition"
          >
            &#x2715;
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

// ── Table ─────────────────────────────────────────────────────────────────────

export function TableContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-zinc-900/40 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">{children}</table>
      </div>
    </div>
  )
}

export function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-white/[0.04] text-left">{children}</tr>
    </thead>
  )
}

export function Th({
  children,
  className = '',
}: {
  children?: React.ReactNode
  className?: string
}) {
  return (
    <th className={`px-5 py-2.5 text-xs font-medium text-zinc-500 ${className}`}>
      {children}
    </th>
  )
}

export function Td({
  children,
  className = '',
}: {
  children?: React.ReactNode
  className?: string
}) {
  return <td className={`px-5 py-3.5 ${className}`}>{children}</td>
}

// ── LoadError ─────────────────────────────────────────────────────────────────

export function LoadError({
  message,
  onRetry,
}: {
  message?: string
  onRetry?: () => void
}) {
  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5">
        <span className="text-red-400 text-base leading-none">&#9888;</span>
        <p className="text-xs text-red-300">
          {message ?? 'Failed to load — check API connection.'}
        </p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex-shrink-0 text-xs text-red-400 hover:text-red-300 underline underline-offset-2 transition"
        >
          Retry
        </button>
      )}
    </div>
  )
}

// ── StatCard ─────────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
  color = 'default',
}: {
  label: string
  value: string | number
  sub?: string
  color?: 'default' | 'green' | 'amber' | 'red'
}) {
  const valueColors = {
    default: 'text-zinc-100',
    green: 'text-emerald-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
  }
  return (
    <div className="rounded-xl border border-white/[0.07] bg-zinc-900/60 px-5 py-4">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${valueColors[color]}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-600 mt-1">{sub}</p>}
    </div>
  )
}
