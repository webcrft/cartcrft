import React from 'react'
import { ChevronLeft, ChevronRight, AlertTriangle, RefreshCw } from 'lucide-react'

// ── Shared design tokens (inline, so Tailwind purge-safe) ────────────────────
// All colours come from CSS vars; radius = rounded-lg (8px) / rounded-xl (12px)

type BadgeColor = 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate' | 'lime' | 'cyan'

export function Badge({ children, color = 'slate' }: { children: React.ReactNode; color?: BadgeColor }) {
  const colors: Record<BadgeColor, string> = {
    emerald: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
    amber: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
    red: 'bg-red-500/12 text-red-300 border-red-500/25',
    blue: 'bg-[var(--cc-cyan)]/12 text-[var(--cc-cyan)] border-[var(--cc-cyan)]/25',
    cyan: 'bg-[var(--cc-cyan)]/12 text-[var(--cc-cyan)] border-[var(--cc-cyan)]/25',
    violet: 'bg-[var(--cc-lime)]/14 text-[var(--cc-lime)] border-[var(--cc-lime)]/25',
    lime: 'bg-[var(--cc-lime)]/14 text-[var(--cc-lime)] border-[var(--cc-lime)]/25',
    slate: 'bg-white/[0.05] text-[var(--cc-body)] border-white/[0.09]',
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-[1.4] ${colors[color]}`}>
      {children}
    </span>
  )
}

// ── Button ───────────────────────────────────────────────────────────────────

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'green' | 'ghost'
type BtnSize = 'sm' | 'md' | 'lg'

export function Btn({
  children, onClick, variant = 'primary', size = 'md',
  disabled, loading, className = '', type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: BtnVariant
  size?: BtnSize
  disabled?: boolean
  loading?: boolean
  className?: string
  type?: 'button' | 'submit' | 'reset'
}) {
  const sizes: Record<BtnSize, string> = {
    sm: 'px-3 py-1.5 text-[12px] gap-1.5',
    md: 'px-4 py-2 text-[13px] gap-1.5',
    lg: 'px-5 py-2.5 text-sm gap-2',
  }
  const base = `inline-flex items-center justify-center rounded-lg font-semibold transition-all duration-150
    active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cc-lime)]/50
    focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cc-bg)]
    disabled:opacity-45 disabled:cursor-not-allowed disabled:active:scale-100`
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-[var(--cc-lime)] text-[var(--cc-ink)] ring-1 ring-inset ring-black/10 hover:bg-[var(--cc-lime-bright)]',
    green: 'bg-[var(--cc-lime)] text-[var(--cc-ink)] ring-1 ring-inset ring-black/10 hover:bg-[var(--cc-lime-bright)]',
    secondary: 'border border-white/[0.1] bg-[var(--cc-surface-2)] text-[var(--cc-body)] hover:bg-[var(--cc-surface-3)] hover:text-[var(--cc-text)] hover:border-white/[0.16]',
    danger: 'border border-red-500/30 bg-red-600/10 text-red-300 hover:bg-red-600/18 hover:border-red-500/45',
    ghost: 'text-[var(--cc-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.05]',
  }
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled ?? loading}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {loading && <span className="h-3.5 w-3.5 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />}
      {children}
    </button>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────

export function Card({
  title, children, className = '', actions, description,
}: {
  title?: string
  children: React.ReactNode
  className?: string
  actions?: React.ReactNode
  description?: string
}) {
  return (
    <div className={`rounded-xl border border-white/[0.08] bg-[var(--cc-surface)] overflow-hidden ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-white/[0.07]">
          <div>
            <h3 className="text-[14px] font-semibold text-[var(--cc-text)] tracking-[-0.01em]">{title}</h3>
            {description && <p className="text-[13px] text-[var(--cc-muted)] mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  )
}

// ── FormInput ────────────────────────────────────────────────────────────────

export function FormInput({
  label, value, onChange, placeholder, type = 'text',
  className = '', error, hint, required,
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  className?: string
  error?: string
  hint?: string
  required?: boolean
}) {
  return (
    <div className={className}>
      {label && (
        <label className="flex items-center gap-1 text-[13px] font-medium text-[var(--cc-body)] mb-1.5">
          {label}
          {required && <span className="text-[var(--cc-lime)] leading-none">*</span>}
        </label>
      )}
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-lg px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] focus:outline-none focus:ring-2 transition ${
          error
            ? 'border-red-500/50 focus:border-red-500/60 focus:ring-red-500/20'
            : 'border-white/[0.08] focus:border-[var(--cc-lime)]/45 focus:ring-[var(--cc-lime)]/20'
        }`}
        style={{ background: 'var(--cc-bg-sunken)', borderWidth: '1px', borderStyle: 'solid' }}
      />
      {error
        ? <p className="mt-1.5 text-[11px] text-red-400">{error}</p>
        : hint
        ? <p className="mt-1.5 text-[11px] text-[var(--cc-subtle)]">{hint}</p>
        : null}
    </div>
  )
}

// ── FormSelect ───────────────────────────────────────────────────────────────

export function FormSelect({
  label, value, onChange, options, className = '', hint,
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  className?: string
  hint?: string
}) {
  return (
    <div className={className}>
      {label && (
        <label className="block text-[13px] font-medium text-[var(--cc-body)] mb-1.5">
          {label}
        </label>
      )}
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/[0.08] px-3 py-2.5 text-sm text-[var(--cc-text)] focus:border-[var(--cc-lime)]/45 focus:outline-none focus:ring-2 focus:ring-[var(--cc-lime)]/20 transition appearance-none cursor-pointer"
        style={{ background: 'var(--cc-bg-sunken)' }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <p className="mt-1.5 text-[11px] text-[var(--cc-subtle)]">{hint}</p>}
    </div>
  )
}

// ── PageHeader ───────────────────────────────────────────────────────────────

export function PageHeader({
  title, description, actions, badge, breadcrumb,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  badge?: React.ReactNode
  breadcrumb?: React.ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-1">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1.5">{breadcrumb}</div>}
        <div className="flex items-center gap-2.5 flex-wrap">
          <h2
            className="text-[1.6rem] font-bold text-[var(--cc-text)]"
            style={{ fontFamily: 'var(--cc-font-display)', letterSpacing: '-0.025em' }}
          >
            {title}
          </h2>
          {badge}
        </div>
        {description && (
          <p className="text-[13px] text-[var(--cc-muted)] mt-1">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}

// ── EmptyState ───────────────────────────────────────────────────────────────

export function EmptyState({
  title, description, action, onAction, icon,
}: {
  title: string
  description?: string
  action?: string
  onAction?: () => void
  icon?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-white/[0.1] py-16 px-6 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--cc-lime)]/20 bg-[var(--cc-lime)]/[0.07] text-[var(--cc-lime)]">
          {icon}
        </div>
      )}
      <p className="text-[15px] font-semibold text-[var(--cc-text)] mb-1.5">{title}</p>
      {description && (
        <p className="text-[13px] text-[var(--cc-muted)] max-w-sm mx-auto leading-relaxed">{description}</p>
      )}
      {action && onAction && (
        <button
          onClick={onAction}
          className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--cc-lime)] px-4 py-2 text-[13px] font-semibold text-[var(--cc-ink)] ring-1 ring-inset ring-black/10 hover:bg-[var(--cc-lime-bright)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cc-lime)]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cc-bg)] active:scale-[0.98]"
        >
          + {action}
        </button>
      )}
    </div>
  )
}

// ── SearchInput ───────────────────────────────────────────────────────────────

export function SearchInput({
  value, onChange, placeholder = 'Search...', className = '',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <svg
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--cc-subtle)]"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/[0.08] pl-9 pr-4 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] focus:border-[var(--cc-lime)]/45 focus:outline-none focus:ring-1 focus:ring-[var(--cc-lime)]/20 transition"
        style={{ background: 'var(--cc-bg-sunken)' }}
      />
    </div>
  )
}

// ── Spinner ───────────────────────────────────────────────────────────────────

export function Spinner({ className = '', size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'h-4 w-4 border-[1.5px]', md: 'h-5 w-5 border-2', lg: 'h-7 w-7 border-2' }
  return (
    <span className={`inline-block rounded-full border-current border-t-transparent animate-spin text-[var(--cc-lime)] ${sizes[size]} ${className}`} />
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function Modal({
  title, onClose, children, size = 'md',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  const maxW = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative w-full ${maxW[size]} max-h-[90vh] overflow-y-auto rounded-xl shadow-2xl`}
        style={{
          background: 'var(--cc-surface)',
          border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 32px 80px -16px rgba(0,0,0,0.7), 0 0 0 1px rgba(181,255,46,0.04)',
        }}
      >
        <div
          className="flex items-center justify-between px-6 py-4 border-b"
          style={{ borderColor: 'rgba(255,255,255,0.07)' }}
        >
          <h2
            className="text-base font-semibold text-[var(--cc-text)]"
            style={{ fontFamily: 'var(--cc-font-display)', letterSpacing: '-0.02em' }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            className="flex items-center justify-center h-7 w-7 rounded-lg text-[var(--cc-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.06] transition text-sm font-medium"
          >
            ×
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

// ── Table primitives ──────────────────────────────────────────────────────────

export function TableContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'var(--cc-surface)' }}>
      {children}
    </div>
  )
}

export function TableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead>
      <tr
        className="border-b text-left"
        style={{ borderColor: 'rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}
      >
        {children}
      </tr>
    </thead>
  )
}

export function Th({
  children, className = '', sticky, numeric, align,
}: {
  children?: React.ReactNode
  className?: string
  sticky?: boolean
  numeric?: boolean
  align?: 'left' | 'right' | 'center'
}) {
  const alignCls = align === 'right' || numeric ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  const stickyCls = sticky ? 'sticky top-0 z-10' : ''
  return (
    <th
      className={`px-4 py-3 text-[12px] font-medium text-[var(--cc-muted)] ${alignCls} ${stickyCls} ${className}`}
      style={sticky ? { background: 'var(--cc-surface)' } : undefined}
    >
      {children}
    </th>
  )
}

export function Td({
  children, className = '', numeric, align, muted,
}: {
  children?: React.ReactNode
  className?: string
  numeric?: boolean
  align?: 'left' | 'right' | 'center'
  muted?: boolean
}) {
  const alignCls = align === 'right' || numeric ? 'text-right' : align === 'center' ? 'text-center' : ''
  const mutedCls = muted ? 'text-[var(--cc-muted)]' : ''
  return (
    <td className={`px-4 py-3.5 text-sm ${alignCls} ${mutedCls} ${className}`}>{children}</td>
  )
}

// ── Pagination ───────────────────────────────────────────────────────────────

export function Pagination({
  page, totalPages, total, unit = 'items',
  onPrev, onNext,
}: {
  page: number
  totalPages: number
  total: number
  unit?: string
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <div className="flex items-center justify-between px-1 py-1">
      <span className="text-[11px] text-[var(--cc-muted)] font-mono">
        Page {page} of {totalPages}
        <span className="text-[var(--cc-subtle)] mx-1.5">·</span>
        {total.toLocaleString()} {unit}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={onPrev}
          disabled={page <= 1}
          className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[var(--cc-surface-2)] px-3 py-1.5 text-[11px] font-medium text-[var(--cc-body)] hover:bg-white/[0.06] hover:text-[var(--cc-text)] transition disabled:opacity-35 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={12} />
          Prev
        </button>
        <button
          onClick={onNext}
          disabled={page >= totalPages}
          className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[var(--cc-surface-2)] px-3 py-1.5 text-[11px] font-medium text-[var(--cc-body)] hover:bg-white/[0.06] hover:text-[var(--cc-text)] transition disabled:opacity-35 disabled:cursor-not-allowed"
        >
          Next
          <ChevronRight size={12} />
        </button>
      </div>
    </div>
  )
}

// ── LoadError ─────────────────────────────────────────────────────────────────

export function LoadError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div
      className="rounded-xl px-5 py-4 flex items-center justify-between gap-4"
      style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)' }}
    >
      <div className="flex items-center gap-2.5">
        <AlertTriangle size={15} className="text-red-400 flex-shrink-0" />
        <p className="text-xs text-red-300">{message ?? 'Failed to load data — check the API connection.'}</p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex-shrink-0 inline-flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition"
        >
          <RefreshCw size={11} />
          Retry
        </button>
      )}
    </div>
  )
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded animate-pulse ${className}`}
      style={{ background: 'rgba(255,255,255,0.05)' }}
    />
  )
}

export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-3.5 w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  )
}

// ── InfoRow (for detail panels / cards) ──────────────────────────────────────

export function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm py-0.5">
      <span className="text-[var(--cc-muted)] text-xs flex-shrink-0">{label}</span>
      <span className="text-[var(--cc-body)] text-right">{children}</span>
    </div>
  )
}

// ── SectionDivider ────────────────────────────────────────────────────────────

export function SectionDivider({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1" style={{ background: 'rgba(255,255,255,0.06)' }} />
      {label && <span className="text-[12px] font-medium text-[var(--cc-muted)] flex-shrink-0">{label}</span>}
      <div className="h-px flex-1" style={{ background: 'rgba(255,255,255,0.06)' }} />
    </div>
  )
}
