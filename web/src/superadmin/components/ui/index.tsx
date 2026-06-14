/**
 * Super-admin UI primitives — "Agentic Terminal" operator variant.
 *
 * Same electric-lime signature as the rest of the product, but on a cooler /
 * darker steel chrome so the god-mode console stays subtly distinct from the
 * merchant dashboard. The everyday accent is the brand lime (#b5ff2e) with ink
 * text on lime fills; lime focus rings; mono uppercase headers; small radii and
 * hairline borders. Red is reserved strictly for destructive operations and
 * amber strictly for warnings (LOCKED / IP_BLOCKED / operator banner).
 */

import React from 'react'

// ── Badge ─────────────────────────────────────────────────────────────────────

type BadgeColor = 'lime' | 'emerald' | 'amber' | 'red' | 'blue' | 'slate' | 'orange'

export function Badge({
  children,
  color = 'slate',
}: {
  children: React.ReactNode
  color?: BadgeColor
}) {
  const colors: Record<BadgeColor, string> = {
    lime: 'bg-[var(--cc-lime)]/12 text-[var(--cc-lime)] border-[var(--cc-lime)]/30',
    emerald: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
    amber: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
    red: 'bg-red-500/12 text-red-300 border-red-500/25',
    blue: 'bg-sky-500/12 text-sky-300 border-sky-500/25',
    orange: 'bg-orange-500/12 text-orange-300 border-orange-500/25',
    slate: 'bg-white/[0.05] text-[var(--cc-text-muted)] border-white/10',
  }
  return (
    <span
      className={`inline-flex items-center rounded-[5px] border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider leading-none ${colors[color]}`}
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
    'inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-2 text-xs font-semibold transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cc-lime)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cc-ink)] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100'
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-[var(--cc-lime)] text-[var(--cc-lime-ink)] hover:bg-[var(--cc-lime-bright)] shadow-[0_0_0_1px_rgba(181,255,46,0.2),0_8px_24px_-12px_rgba(181,255,46,0.5)]',
    warning: 'bg-amber-500 text-[var(--cc-ink)] hover:bg-amber-400',
    secondary: 'border border-white/10 bg-white/[0.04] text-[var(--cc-text-body)] hover:bg-white/[0.08] hover:text-[var(--cc-text)]',
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
      className={`rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] shadow-sm shadow-black/30 overflow-hidden ${className}`}
    >
      {title && (
        <div className="px-5 py-3.5 border-b border-white/[0.07] bg-white/[0.015]">
          <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--cc-text-muted)]">{title}</h3>
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
        <label className="block font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--cc-text-muted)] mb-1.5">{label}</label>
      )}
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-text-subtle)] focus:border-[var(--cc-lime)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--cc-lime)]/40 transition"
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
          <h2 className="text-xl font-bold text-[var(--cc-text)] tracking-tight">{title}</h2>
          {badge}
        </div>
        {description && <p className="text-xs text-[var(--cc-text-muted)] mt-1">{description}</p>}
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
    <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.01] p-16 text-center">
      <p className="text-sm font-medium text-[var(--cc-text-body)] mb-1">{title}</p>
      {description && (
        <p className="text-xs text-[var(--cc-text-muted)] max-w-sm mx-auto">{description}</p>
      )}
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-5 w-5 border-2 border-current border-t-transparent rounded-full animate-spin text-[var(--cc-lime)]/70 ${className}`}
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
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-white/[0.1] bg-[var(--cc-surface-steel)] shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.07]">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-[var(--cc-text)]">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-[var(--cc-text-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.06] transition"
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
    <div className="rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] shadow-sm shadow-black/30 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">{children}</table>
      </div>
    </div>
  )
}

export function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-white/[0.07] bg-white/[0.02] text-left">{children}</tr>
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
    <th className={`px-5 py-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cc-text-subtle)] ${className}`}>
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
    <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-5 py-4 flex items-center justify-between gap-4">
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
    default: 'text-[var(--cc-text)]',
    green: 'text-[var(--cc-lime)]',
    amber: 'text-amber-400',
    red: 'text-red-400',
  }
  return (
    <div className="group relative rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] shadow-sm shadow-black/30 px-5 py-4 transition hover:border-white/[0.14]">
      <p className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--cc-text-subtle)] mb-1.5">{label}</p>
      <p className={`font-display text-[1.7rem] font-bold tabular-nums leading-none tracking-tight ${valueColors[color]}`}>{value}</p>
      {sub && <p className="text-xs text-[var(--cc-text-muted)] mt-1.5">{sub}</p>}
    </div>
  )
}
