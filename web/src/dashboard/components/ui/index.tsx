import React from 'react'

type BadgeColor = 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate' | 'lime' | 'cyan'

export function Badge({ children, color = 'slate' }: { children: React.ReactNode; color?: BadgeColor }) {
  const colors: Record<BadgeColor, string> = {
    emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    red: 'bg-red-500/15 text-red-400 border-red-500/20',
    blue: 'bg-[var(--cc-cyan)]/15 text-[var(--cc-cyan)] border-[var(--cc-cyan)]/25',
    cyan: 'bg-[var(--cc-cyan)]/15 text-[var(--cc-cyan)] border-[var(--cc-cyan)]/25',
    // "violet" kept as a key for back-compat; renders in the signature lime.
    violet: 'bg-[var(--cc-lime)]/15 text-[var(--cc-lime)] border-[var(--cc-lime)]/25',
    lime: 'bg-[var(--cc-lime)]/15 text-[var(--cc-lime)] border-[var(--cc-lime)]/25',
    slate: 'bg-white/[0.05] text-[var(--cc-muted)] border-white/[0.08]',
  }
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider leading-none ${colors[color]}`}>
      {children}
    </span>
  )
}

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'green'

export function Btn({ children, onClick, variant = 'primary', disabled, loading, className = '', type = 'button' }: {
  children: React.ReactNode; onClick?: () => void; variant?: BtnVariant;
  disabled?: boolean; loading?: boolean; className?: string; type?: 'button' | 'submit' | 'reset'
}) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cc-lime)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cc-bg)] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100'
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-[var(--cc-lime)] text-[var(--cc-ink)] ring-1 ring-inset ring-white/10 hover:bg-[var(--cc-lime-bright)] hover:shadow-[0_0_22px_-2px_var(--cc-lime)]',
    green: 'bg-[var(--cc-lime)] text-[var(--cc-ink)] ring-1 ring-inset ring-white/10 hover:bg-[var(--cc-lime-bright)] hover:shadow-[0_0_22px_-2px_var(--cc-lime)]',
    secondary: 'border border-white/[0.07] bg-[var(--cc-surface)] text-[var(--cc-body)] hover:bg-[var(--cc-surface-2)] hover:text-[var(--cc-text)] hover:border-white/15',
    danger: 'border border-red-500/30 bg-red-600/10 text-red-300 hover:bg-red-600/20 hover:border-red-500/40',
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled ?? loading} className={`${base} ${variants[variant]} ${className}`}>
      {loading && <span className="h-3.5 w-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />}
      {children}
    </button>
  )
}

export function Card({ title, children, className = '' }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] overflow-hidden ${className}`}>
      {title && (
        <div className="px-5 py-3.5 border-b border-white/[0.07]">
          <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--cc-muted)]">{title}</h3>
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  )
}

export function FormInput({ label, value, onChange, placeholder, type = 'text', className = '', error, hint }: {
  label?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; className?: string; error?: string; hint?: string
}) {
  const borderCls = error
    ? 'border-red-500/60 focus:border-red-500/60 focus:ring-red-500/20'
    : 'border-white/[0.08] focus:border-[var(--cc-lime)]/50 focus:ring-[var(--cc-lime)]/25'
  return (
    <div className={className}>
      {label && <label className="block font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--cc-muted)] mb-1.5">{label}</label>}
      <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-lg border bg-[var(--cc-bg-sunken)] px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] focus:outline-none focus:ring-2 transition ${borderCls}`} />
      {error
        ? <p className="mt-1 text-xs text-red-400">{error}</p>
        : hint ? <p className="mt-1 text-xs text-[var(--cc-subtle)]">{hint}</p> : null}
    </div>
  )
}

export function FormSelect({ label, value, onChange, options, className = '' }: {
  label?: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; className?: string
}) {
  return (
    <div className={className}>
      {label && <label className="block font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--cc-muted)] mb-1.5">{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/[0.08] bg-[var(--cc-surface)] px-3 py-2.5 text-sm text-[var(--cc-text)] focus:border-[var(--cc-lime)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--cc-lime)]/25 transition">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

export function PageHeader({ title, description, actions, badge }: {
  title: string; description?: string; actions?: React.ReactNode; badge?: React.ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-xl font-semibold tracking-tight text-[var(--cc-text)]">{title}</h2>
          {badge}
        </div>
        {description && <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--cc-subtle)] mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({ title, description, action, onAction, icon }: {
  title: string; description?: string; action?: string; onAction?: () => void; icon?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-white/10 p-16 text-center">
      {icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-[var(--cc-lime)]/20 bg-[var(--cc-lime)]/[0.08] text-[var(--cc-lime)]">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-[var(--cc-body)] mb-1">{title}</p>
      {description && <p className="text-xs text-[var(--cc-subtle)] max-w-sm mx-auto">{description}</p>}
      {action && onAction && (
        <button onClick={onAction}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--cc-lime)] px-4 py-2 text-xs font-semibold text-[var(--cc-ink)] hover:bg-[var(--cc-lime-bright)] hover:shadow-[0_0_22px_-2px_var(--cc-lime)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cc-lime)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--cc-bg)] active:scale-[0.97]">
          + {action}
        </button>
      )}
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search...', className = '' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <svg
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--cc-subtle)]"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-white/[0.08] bg-[var(--cc-bg-sunken)] pl-10 pr-4 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] focus:border-[var(--cc-lime)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--cc-lime)]/25 transition"
      />
    </div>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-5 w-5 border-2 border-current border-t-transparent rounded-full animate-spin text-[var(--cc-lime)] ${className}`} />
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-lg border border-white/[0.1] bg-[var(--cc-surface)] shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.07]">
          <h2 className="text-base font-semibold text-[var(--cc-text)]">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--cc-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.06] transition">&#x2715;</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

export function TableContainer({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] overflow-hidden">{children}</div>
}

export function TableHead({ children }: { children: React.ReactNode }) {
  return <thead><tr className="border-b border-white/[0.07] bg-white/[0.02] text-left">{children}</tr></thead>
}

export function Th({ children, className = '', sticky, numeric, align }: {
  children?: React.ReactNode; className?: string
  sticky?: boolean; numeric?: boolean; align?: 'left' | 'right' | 'center'
}) {
  const alignCls = align === 'right' || numeric ? 'text-right' : align === 'center' ? 'text-center' : ''
  const stickyCls = sticky ? 'sticky top-0 z-10 bg-[var(--cc-bg)]' : ''
  return <th className={`px-5 py-3 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cc-muted)] ${alignCls} ${stickyCls} ${className}`}>{children}</th>
}

export function Td({ children, className = '', numeric, align }: {
  children?: React.ReactNode; className?: string; numeric?: boolean; align?: 'left' | 'right' | 'center'
}) {
  const alignCls = align === 'right' || numeric ? 'text-right' : align === 'center' ? 'text-center' : ''
  return <td className={`px-5 py-3 ${alignCls} ${className}`}>{children}</td>
}

/**
 * Inline "failed to load" indicator — distinguishes a real error from genuinely
 * empty data so broken endpoints are immediately visible.
 */
export function LoadError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-5 py-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5">
        <span className="text-red-400 text-base leading-none">&#9888;</span>
        <p className="text-xs text-red-300">{message ?? 'Failed to load data — check the API connection.'}</p>
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
