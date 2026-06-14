import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, PageHeader, EmptyState, LoadError, Spinner, TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

interface AbandonedCart {
  id: string; customer_id?: string; email?: string; total?: string;
  currency?: string; status?: string; recovered_at?: string;
  created_at: string; [k: string]: unknown
}

export default function AbandonedCarts() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [carts, setCarts] = useState<AbandonedCart[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [recovering, setRecovering] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    try {
      const res = await getSdk().engagement.listAbandonedCarts(activeStore.id)
      setCarts((res as { carts?: AbandonedCart[] }).carts ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load abandoned carts'
      setLoadError(msg)
      toast(msg, 'error')
      setCarts([])
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  const markRecovered = async (cartId: string) => {
    if (!activeStore) return
    setRecovering(cartId)
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/abandoned-carts/${cartId}/recover`, { method: 'POST', body: {} })
      toast('Cart marked as recovered', 'success')
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Failed', 'error') }
    finally { setRecovering(null) }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Abandoned Carts"
        description={`${carts.length} abandoned cart${carts.length !== 1 ? 's' : ''}`}
      />

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      {!loadError && carts.length === 0 ? (
        <EmptyState title="No abandoned carts" description="Carts that weren't checked out will appear here" />
      ) : !loadError ? (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>Customer / Email</Th><Th>Total</Th><Th>Status</Th><Th>Abandoned</Th><Th></Th>
            </TableHead>
            <tbody>
              {carts.map(cart => (
                <tr key={cart.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                  <Td className="text-slate-300">{cart.email ?? String(cart.customer_id ?? '—').slice(0, 12)}</Td>
                  <Td className="font-mono text-white">
                    {cart.currency} {cart.total ?? '—'}
                  </Td>
                  <Td>
                    {cart.recovered_at
                      ? <Badge color="emerald">Recovered</Badge>
                      : <Badge color="amber">Abandoned</Badge>}
                  </Td>
                  <Td className="text-slate-500 text-xs">{new Date(cart.created_at).toLocaleDateString()}</Td>
                  <Td>
                    {!cart.recovered_at && (
                      <Btn
                        variant="green"
                        loading={recovering === cart.id}
                        onClick={() => void markRecovered(cart.id)}
                      >
                        Mark Recovered
                      </Btn>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      ) : null}
    </div>
  )
}
