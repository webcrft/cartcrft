import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, PageHeader, EmptyState, Spinner, TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

interface Review {
  id: string; product_id?: string; customer_id?: string; status: string;
  rating?: number; title?: string; body?: string;
  verified_purchase?: boolean; created_at: string; [k: string]: unknown
}

const REVIEW_STATUS: Record<string, { color: 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'; label: string }> = {
  pending: { color: 'amber', label: 'Pending' },
  approved: { color: 'emerald', label: 'Approved' },
  rejected: { color: 'red', label: 'Rejected' },
  spam: { color: 'slate', label: 'Spam' },
}

function Stars({ rating }: { rating?: number }) {
  if (!rating) return <span className="text-slate-500">—</span>
  return (
    <span className="text-amber-400 text-xs font-medium">
      {'★'.repeat(Math.min(5, Math.max(0, rating)))}{'☆'.repeat(Math.max(0, 5 - rating))}
    </span>
  )
}

export default function Reviews() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [reviews, setReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('pending')
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    try {
      const res = await getSdk().request<{ reviews: Review[] }>(
        `/commerce/stores/${activeStore.id}/reviews`,
        { query: filter ? { status: filter } : undefined },
      )
      setReviews((res as { reviews?: Review[] }).reviews ?? [])
    } catch { setReviews([]) }
    setLoading(false)
  }, [activeStore, filter])

  useEffect(() => { void load() }, [load])

  const moderate = async (reviewId: string, action: 'approve' | 'reject' | 'spam') => {
    if (!activeStore) return
    setActing(reviewId)
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/reviews/${reviewId}/${action}`, { method: 'POST', body: {} })
      toast(`Review ${action}d`, 'success')
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : `${action} failed`, 'error') }
    finally { setActing(null) }
  }

  const FILTERS = ['all', 'pending', 'approved', 'rejected', 'spam']

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader title="Reviews" description="Moderation queue — approve, reject, or mark spam" />

      <div className="flex gap-2">
        {FILTERS.map(f => (
          <Btn key={f} variant={filter === f || (f === 'all' && !filter) ? 'primary' : 'secondary'}
            onClick={() => setFilter(f === 'all' ? '' : f)} className="capitalize">{f}</Btn>
        ))}
      </div>

      {reviews.length === 0 ? (
        <EmptyState title="No reviews" description={`No ${filter || 'reviews'} to show`} />
      ) : (
        <div className="space-y-3">
          {reviews.map(r => {
            const st = REVIEW_STATUS[r.status] ?? { color: 'slate' as const, label: r.status }
            return (
              <div key={r.id} className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-4 space-y-2">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Badge color={st.color}>{st.label}</Badge>
                    {r.rating != null ? <Stars rating={r.rating} /> : <Stars />}
                    {r.verified_purchase && <Badge color="emerald">Verified</Badge>}
                    <span className="text-xs text-slate-500">{new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {r.status !== 'approved' && (
                      <Btn variant="green" loading={acting === r.id} onClick={() => void moderate(r.id, 'approve')}>Approve</Btn>
                    )}
                    {r.status !== 'rejected' && (
                      <Btn variant="danger" loading={acting === r.id} onClick={() => void moderate(r.id, 'reject')}>Reject</Btn>
                    )}
                    {r.status !== 'spam' && (
                      <Btn variant="secondary" loading={acting === r.id} onClick={() => void moderate(r.id, 'spam')}>Spam</Btn>
                    )}
                  </div>
                </div>
                {r.title && <p className="text-sm font-semibold text-white">{r.title}</p>}
                {r.body && <p className="text-sm text-slate-400">{r.body}</p>}
                <p className="text-xs text-slate-600">Product: {String(r.product_id ?? '—').slice(0, 8)} · Customer: {String(r.customer_id ?? '—').slice(0, 8)}</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
