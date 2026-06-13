import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, LoadError, PageHeader, EmptyState, Spinner, Modal, TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

interface Wishlist {
  id: string; customer_id?: string; name?: string; share_token?: string;
  items_count?: number; created_at: string; [k: string]: unknown
}

interface WishlistItem {
  id: string; product_id?: string; variant_id?: string;
  added_at?: string; [k: string]: unknown
}

function WishlistItemsModal({ storeId, wishlist, onClose }: {
  storeId: string; wishlist: Wishlist; onClose: () => void
}) {
  const [items, setItems] = useState<WishlistItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const res = await getSdk().request<{ items: WishlistItem[] }>(
          `/commerce/stores/${storeId}/wishlists/${wishlist.id}/items`
        )
        setItems((res as { items?: WishlistItem[] }).items ?? [])
      } catch { setItems([]) }
      setLoading(false)
    })()
  }, [storeId, wishlist.id])

  return (
    <Modal title={`Wishlist — ${wishlist.name ?? wishlist.id.slice(0, 8)}`} onClose={onClose}>
      {loading ? <div className="flex justify-center py-8"><Spinner /></div> : items.length === 0 ? (
        <p className="text-sm text-slate-400">No items in this wishlist.</p>
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead><Th>Product</Th><Th>Variant</Th><Th>Added</Th></TableHead>
            <tbody>
              {items.map((item, i) => (
                <tr key={String(item.id ?? i)} className="border-t border-white/[0.04]">
                  <Td className="font-mono text-xs text-slate-400">{String(item.product_id ?? '—').slice(0, 8)}</Td>
                  <Td className="font-mono text-xs text-slate-400">{String(item.variant_id ?? '—').slice(0, 8)}</Td>
                  <Td className="text-slate-500 text-xs">
                    {item.added_at ? new Date(String(item.added_at)).toLocaleDateString() : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}
    </Modal>
  )
}

export default function Wishlists() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [wishlists, setWishlists] = useState<Wishlist[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Wishlist | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    try {
      const res = await getSdk().engagement.listWishlists(activeStore.id)
      setWishlists((res as { wishlists?: Wishlist[] }).wishlists ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load wishlists'
      setLoadError(msg)
      toast(msg, 'error')
      setWishlists([])
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader title="Wishlists" description="Customer wishlists and saved items" />

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      {!loadError && wishlists.length === 0 ? (
        <EmptyState title="No wishlists" description="Customer wishlists will appear here once created via the storefront" />
      ) : !loadError ? (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>Name</Th><Th>Customer</Th><Th>Items</Th><Th>Share Token</Th><Th>Created</Th><Th></Th>
            </TableHead>
            <tbody>
              {wishlists.map(w => (
                <tr key={w.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                  <Td className="text-white">{w.name ?? 'My Wishlist'}</Td>
                  <Td className="font-mono text-xs text-slate-400">{String(w.customer_id ?? '—').slice(0, 8)}</Td>
                  <Td className="text-slate-300">{w.items_count ?? 0}</Td>
                  <Td>
                    {w.share_token
                      ? <Badge color="blue">Shared</Badge>
                      : <span className="text-slate-600 text-xs">Private</span>}
                  </Td>
                  <Td className="text-slate-500 text-xs">{new Date(w.created_at).toLocaleDateString()}</Td>
                  <Td><Btn variant="secondary" onClick={() => setSelected(w)}>View Items</Btn></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      ) : null}

      {selected && activeStore && (
        <WishlistItemsModal
          storeId={activeStore.id}
          wishlist={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
