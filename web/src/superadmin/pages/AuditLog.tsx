/**
 * Audit Log — paginated + filterable view of the operator action trail.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  listAuditLog,
  type AuditEntry,
  SuperAdminApiError,
} from '../lib/api'
import {
  PageHeader,
  Spinner,
  LoadError,
  EmptyState,
  Badge,
  TableContainer,
  TableHead,
  Th,
  Td,
  Btn,
} from '../components/ui/index'

const ACTION_COLORS: Record<string, 'red' | 'amber' | 'emerald' | 'slate'> = {
  takedown: 'red',
  suspend: 'amber',
  restore: 'emerald',
  login: 'slate',
  logout: 'slate',
}

function actionColor(action: string): 'red' | 'amber' | 'emerald' | 'slate' {
  const key = Object.keys(ACTION_COLORS).find(k => action.toLowerCase().includes(k))
  return key ? ACTION_COLORS[key] : 'slate'
}

/** Compact, locale-stable timestamp — e.g. "Jun 12, 14:03". */
function fmtTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export default function AuditLog() {
  const { token, handle401 } = useAuth()
  const { toast } = useToast()

  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [actionFilter, setActionFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const LIMIT = 50

  const load = useCallback(async (p: number, action: string) => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const res = await listAuditLog(token, p, LIMIT, action || undefined)
      setEntries(res.entries ?? [])
      setTotal(res.total ?? 0)
    } catch (err) {
      if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
      const msg = err instanceof SuperAdminApiError ? err.message : 'Failed to load audit log'
      setError(msg)
      toast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }, [token, handle401, toast])

  useEffect(() => { void load(page, actionFilter) }, [load, page, actionFilter])

  const totalPages = Math.ceil(total / LIMIT)

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="Permanent record of all operator actions"
        actions={<Btn variant="secondary" onClick={() => void load(page, actionFilter)}>Refresh</Btn>}
      />

      <div className="flex gap-3 mb-4">
        <input
          type="text"
          value={actionFilter}
          onChange={e => { setActionFilter(e.target.value); setPage(1) }}
          placeholder="Filter by action (e.g. takedown, login)..."
          className="flex-1 rounded-lg border border-white/[0.08] bg-slate-800/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-white/20 focus:outline-none transition"
        />
        <div className="text-xs text-slate-500 self-center whitespace-nowrap">
          {total.toLocaleString()} entries
        </div>
      </div>

      {loading && <div className="flex justify-center py-16"><Spinner /></div>}
      {error && !loading && <LoadError message={error} onRetry={() => void load(page, actionFilter)} />}
      {!loading && !error && entries.length === 0 && (
        <EmptyState title="No audit entries" description={actionFilter ? `No entries match "${actionFilter}".` : 'No actions have been logged yet.'} />
      )}

      {!loading && !error && entries.length > 0 && (
        <>
          <TableContainer>
            <TableHead>
              <Th>Time</Th>
              <Th>Admin</Th>
              <Th>Action</Th>
              <Th>Target</Th>
              <Th>IP</Th>
              <Th></Th>
            </TableHead>
            <tbody>
              {entries.map(entry => (
                <React.Fragment key={entry.id}>
                  <tr className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                    <Td>
                      <span
                        className="text-[11px] text-slate-500 whitespace-nowrap"
                        title={new Date(entry.created_at).toLocaleString()}
                      >
                        {fmtTimestamp(entry.created_at)}
                      </span>
                    </Td>
                    <Td>
                      <p className="text-xs text-slate-300">{entry.admin_email}</p>
                      <p className="text-[11px] text-slate-600 font-mono">{entry.admin_id?.slice(0, 8)}</p>
                    </Td>
                    <Td>
                      <Badge color={actionColor(entry.action)}>{entry.action}</Badge>
                    </Td>
                    <Td>
                      {entry.target_type && (
                        <p className="text-xs text-slate-400">{entry.target_type}</p>
                      )}
                      {entry.target_id && (
                        <p className="text-[11px] text-slate-600 font-mono">{entry.target_id?.slice(0, 16)}</p>
                      )}
                    </Td>
                    <Td>
                      <span className="text-[11px] text-slate-600 font-mono">{entry.ip || '—'}</span>
                    </Td>
                    <Td>
                      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                        <button
                          onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                          className="text-[11px] text-slate-500 hover:text-slate-300 transition"
                        >
                          {expandedId === entry.id ? 'hide' : 'details'}
                        </button>
                      )}
                    </Td>
                  </tr>
                  {expandedId === entry.id && entry.metadata && (
                    <tr className="border-t border-white/[0.03] bg-slate-900/40">
                      <td colSpan={6} className="px-5 py-3">
                        <pre className="text-[11px] text-slate-400 bg-slate-950/60 rounded-lg p-3 max-h-96 overflow-auto font-mono leading-relaxed">
                          {JSON.stringify(entry.metadata, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </TableContainer>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <Btn
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
              >
                Previous
              </Btn>
              <span className="text-xs text-slate-500">
                Page {page} of {totalPages}
              </span>
              <Btn
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              >
                Next
              </Btn>
            </div>
          )}
        </>
      )}
    </div>
  )
}
