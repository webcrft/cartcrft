import React from 'react'

type BadgeColor = 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'

export function Badge({ children, color = 'slate' }: { children: React.ReactNode; color?: BadgeColor }) {
  const colors: Record<BadgeColor, string> = {
    emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    red: 'bg-red-500/15 text-red-400 border-red-500/20',
    blue: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    violet: 'bg-violet-500/15 text-violet-400 border-violet-500/20',
    slate: 'bg-slate-500/15 text-slate-400 border-slate-500/20',
  }
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${colors[color]}`}>
      {children}
    </span>
  )
}

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'green'

export function Btn({ children, onClick, variant = 'primary', disabled, loading, className = '', type = 'button' }: {
  children: React.ReactNode; onClick?: () => void; variant?: BtnVariant;
  disabled?: boolean; loading?: boolean; className?: string; type?: 'button' | 'submit' | 'reset'
}) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition disabled:opacity-50'
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-violet-600 text-white hover:bg-violet-500',
    green: 'bg-emerald-600 text-white hover:bg-emerald-500',
    secondary: 'border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white',
    danger: 'border border-red-500/30 bg-red-600/10 text-red-300 hover:bg-red-600/20',
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
    <div className={`rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden ${className}`}>
      {title && <div className="px-5 py-4 border-b border-white/[0.06]"><h3 className="text-sm font-semibold text-white">{title}</h3></div>}
      <div className="p-5">{children}</div>
    </div>
  )
}

export function FormInput({ label, value, onChange, placeholder, type = 'text', className = '' }: {
  label?: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; className?: string
}) {
  return (
    <div className={className}>
      {label && <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>}
      <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-white/10 transition" />
    </div>
  )
}

export function FormSelect({ label, value, onChange, options, className = '' }: {
  label?: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; className?: string
}) {
  return (
    <div className={className}>
      {label && <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/[0.08] bg-slate-900 px-3 py-2.5 text-sm text-white focus:border-white/20 focus:outline-none transition">
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
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          {badge}
        </div>
        {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function EmptyState({ title, description, action, onAction }: {
  title: string; description?: string; action?: string; onAction?: () => void
}) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 p-16 text-center">
      <p className="text-sm font-medium text-slate-300 mb-1">{title}</p>
      {description && <p className="text-xs text-slate-500 max-w-sm mx-auto">{description}</p>}
      {action && onAction && (
        <button onClick={onAction}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-violet-600/20 px-4 py-2 text-xs font-medium text-violet-300 hover:bg-violet-600/30 transition">
          + {action}
        </button>
      )}
    </div>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-5 w-5 border-2 border-current border-t-transparent rounded-full animate-spin text-slate-500 ${className}`} />
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-white/[0.1] bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.07]">
          <h2 className="text-base font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:text-white hover:bg-white/[0.06] transition">&#x2715;</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

export function TableContainer({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">{children}</div>
}

export function TableHead({ children }: { children: React.ReactNode }) {
  return <thead><tr className="border-b border-white/[0.04] text-left">{children}</tr></thead>
}

export function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-5 py-2.5 text-xs font-medium text-slate-500 ${className}`}>{children}</th>
}

export function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-5 py-3 ${className}`}>{children}</td>
}

/**
 * Inline "failed to load" indicator — distinguishes a real error from genuinely
 * empty data so broken endpoints are immediately visible.
 */
export function LoadError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4 flex items-center justify-between gap-4">
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
