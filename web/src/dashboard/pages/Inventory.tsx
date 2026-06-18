import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Badge, Btn, FormInput, FormSelect, LoadError, PageHeader, EmptyState, Spinner, Modal, TableContainer, TableHead, Th, Td } from '../components/ui/index'
import type { Warehouse, InventoryLevel } from '@cartcrft/sdk'

interface AdjustForm {
  variant_id: string
  warehouse_id: string
  delta: string
  reason: string
}

interface Lot {
  id?: string
  lot_number?: string
  variant_id?: string
  quantity?: number
  expiry_date?: string
  [key: string]: unknown
}

interface Serial {
  id?: string
  serial_number?: string
  variant_id?: string
  status?: string
  [key: string]: unknown
}

type Tab = 'levels' | 'lots' | 'serials'

function AdjustModal({ storeId, level, warehouses, onClose, onSaved }: {
  storeId: string
  level: InventoryLevel | null
  warehouses: Warehouse[]
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState<AdjustForm>({
    variant_id: level?.variant_id ?? '',
    warehouse_id: level?.warehouse_id ?? warehouses[0]?.id ?? '',
    delta: '',
    reason: '',
  })
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!form.variant_id || !form.warehouse_id || !form.delta) {
      toast('All fields required', 'error')
      return
    }
    setSaving(true)
    try {
      const sdk = getSdk()
      type AdjustBody = Parameters<typeof sdk.inventory.adjustLevel>[1]
      const adjustBody: AdjustBody = { variant_id: form.variant_id, warehouse_id: form.warehouse_id, delta: Number(form.delta) }
      if (form.reason) adjustBody.reason = form.reason
      await sdk.inventory.adjustLevel(storeId, adjustBody)
      toast('Inventory adjusted', 'success')
      onSaved()
      onClose()
    } catch (err) {
      toast((err instanceof Error ? err.message : 'Adjust failed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const warehouseOptions = warehouses.map(w => ({ value: w.id, label: `${w.name}${w.is_default ? ' (default)' : ''}` }))
  const set = (k: keyof AdjustForm) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  return (
    <Modal title="Adjust Inventory" onClose={onClose}>
      <div className="space-y-4">
        <FormInput label="Variant ID" value={form.variant_id} onChange={set('variant_id')} placeholder="variant_id" />
        <FormSelect label="Warehouse" value={form.warehouse_id} onChange={set('warehouse_id')} options={warehouseOptions} />
        <FormInput label="Delta (+ to add, - to remove)" value={form.delta} onChange={set('delta')} placeholder="+10 or -5" type="number" />
        <FormInput label="Reason (optional)" value={form.reason} onChange={set('reason')} placeholder="Restock, damage, etc." />
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving}>Adjust</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function Inventory() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('levels')
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [selectedWarehouseId, setSelectedWarehouseId] = useState('')
  const [levels, setLevels] = useState<InventoryLevel[]>([])
  const [lots, setLots] = useState<Lot[]>([])
  const [serials, setSerials] = useState<Serial[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [adjustLevel, setAdjustLevel] = useState<InventoryLevel | null | undefined>(undefined)

  const loadWarehouses = useCallback(async () => {
    if (!activeStore) return
    const sdk = getSdk()
    setLoadError(null)
    try {
      const res = await sdk.inventory.listWarehouses(activeStore.id)
      const whs = res.warehouses ?? []
      setWarehouses(whs)
      const def = whs.find(w => w.is_default) ?? whs[0]
      if (def) setSelectedWarehouseId(def.id)
      return whs
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load warehouses'
      setLoadError(msg)
      toast(msg, 'error')
      return []
    }
  }, [activeStore, toast])

  const loadLevels = useCallback(async (warehouseId: string) => {
    if (!activeStore || !warehouseId) return
    const sdk = getSdk()
    try {
      const res = await sdk.inventory.listLevels(activeStore.id, { warehouse_id: warehouseId })
      setLevels(res.levels ?? [])
    } catch { toast('Failed to load inventory levels', 'error') }
  }, [activeStore, toast])

  const loadLots = useCallback(async () => {
    if (!activeStore) return
    const sdk = getSdk()
    try {
      const res = await sdk.request<{ lots: Lot[] }>(`/commerce/stores/${activeStore.id}/inventory/lots`)
      setLots((res as { lots?: Lot[] }).lots ?? [])
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load lots', 'error')
      setLots([])
    }
  }, [activeStore, toast])

  const loadSerials = useCallback(async () => {
    if (!activeStore) return
    const sdk = getSdk()
    try {
      const res = await sdk.request<{ serials: Serial[] }>(`/commerce/stores/${activeStore.id}/inventory/serials`)
      setSerials((res as { serials?: Serial[] }).serials ?? [])
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load serials', 'error')
      setSerials([])
    }
  }, [activeStore, toast])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const whs = await loadWarehouses() as Warehouse[] | undefined
      const defId = whs?.find(w => w.is_default)?.id ?? whs?.[0]?.id
      if (defId) await loadLevels(defId)
      setLoading(false)
    })()
  }, [loadWarehouses, loadLevels])

  useEffect(() => {
    if (tab === 'lots') void loadLots()
    if (tab === 'serials') void loadSerials()
  }, [tab, loadLots, loadSerials])

  useEffect(() => {
    if (selectedWarehouseId) void loadLevels(selectedWarehouseId)
  }, [selectedWarehouseId, loadLevels])

  const warehouseOptions = warehouses.map(w => ({ value: w.id, label: `${w.name}${w.is_default ? ' (default)' : ''}` }))

  const TABS: { key: Tab; label: string }[] = [
    { key: 'levels', label: 'Levels' },
    { key: 'lots', label: 'Lots' },
    { key: 'serials', label: 'Serials' },
  ]

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inventory"
        description="Track stock levels across warehouses"
        actions={tab === 'levels' ? <Btn onClick={() => setAdjustLevel(null)}>+ Adjust</Btn> : undefined}
      />

      {loadError && <LoadError message={loadError} onRetry={() => { void (async () => { setLoading(true); const whs = await loadWarehouses() as Warehouse[] | undefined; const defId = whs?.find(w => w.is_default)?.id ?? whs?.[0]?.id; if (defId) await loadLevels(defId); setLoading(false) })() }} />}

      {/* Tabs */}
      <div className="flex border-b border-white/[0.07]">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-[13px] font-medium border-b-2 transition -mb-px ${
              tab === t.key
                ? 'border-[var(--cc-lime)] text-[var(--cc-text)]'
                : 'border-transparent text-[var(--cc-muted)] hover:text-[var(--cc-text)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'levels' && (
        <div className="space-y-4">
          {warehouses.length > 1 && (
            <FormSelect
              label="Warehouse"
              value={selectedWarehouseId}
              onChange={setSelectedWarehouseId}
              options={warehouseOptions}
            />
          )}
          {warehouses.length === 0 ? (
            <EmptyState title="No warehouses" description="Create a warehouse to start tracking inventory" />
          ) : levels.length === 0 ? (
            <EmptyState title="No inventory levels" description="Add products and adjust their inventory to see levels here" action="Adjust Inventory" onAction={() => setAdjustLevel(null)} />
          ) : (
            <TableContainer>
              <table className="w-full text-sm">
                <TableHead>
                  <Th>Variant ID</Th>
                  <Th align="right">On hand</Th>
                  <Th align="right">Committed</Th>
                  <Th align="right">Available</Th>
                  <Th></Th>
                </TableHead>
                <tbody>
                  {levels.map(level => (
                    <tr
                      key={`${level.variant_id}-${level.warehouse_id}`}
                      className="transition-colors"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.02)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}
                    >
                      <Td><span className="font-mono text-[12px] text-[var(--cc-muted)]">{level.variant_id}</span></Td>
                      <Td align="right" className="font-mono text-[var(--cc-text)]">{level.on_hand}</Td>
                      <Td align="right" className="font-mono text-[var(--cc-muted)]">{level.committed}</Td>
                      <Td align="right" className={`font-mono font-medium ${level.available <= 0 ? 'text-red-300' : level.available < 5 ? 'text-amber-300' : 'text-emerald-300'}`}>
                        {level.available}
                      </Td>
                      <Td>
                        <div className="flex justify-end">
                          <Btn size="sm" variant="secondary" onClick={() => setAdjustLevel(level)}>Adjust</Btn>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          )}
        </div>
      )}

      {tab === 'lots' && (
        lots.length === 0 ? (
          <EmptyState title="No lots" description="Lot tracking will appear here when lots are created" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead>
                <Th>Lot number</Th>
                <Th>Variant ID</Th>
                <Th>Expiry date</Th>
                <Th align="right">Quantity</Th>
              </TableHead>
              <tbody>
                {lots.map((lot, i) => (
                  <tr key={String(lot.id ?? i)} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <Td className="font-mono text-[var(--cc-body)]">{lot.lot_number ?? '—'}</Td>
                    <Td className="font-mono text-[12px] text-[var(--cc-muted)]">{lot.variant_id ?? '—'}</Td>
                    <Td muted>{lot.expiry_date ? new Date(String(lot.expiry_date)).toLocaleDateString() : '—'}</Td>
                    <Td align="right" className="font-mono text-[var(--cc-text)]">{lot.quantity ?? 0}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {tab === 'serials' && (
        serials.length === 0 ? (
          <EmptyState title="No serial numbers" description="Serial number tracking will appear here" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead>
                <Th>Serial number</Th>
                <Th>Variant ID</Th>
                <Th>Status</Th>
              </TableHead>
              <tbody>
                {serials.map((serial, i) => (
                  <tr key={String(serial.id ?? i)} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <Td className="font-mono text-[var(--cc-body)]">{serial.serial_number ?? '—'}</Td>
                    <Td className="font-mono text-[12px] text-[var(--cc-muted)]">{serial.variant_id ?? '—'}</Td>
                    <Td>
                      <Badge color={serial.status === 'available' ? 'emerald' : serial.status === 'sold' ? 'slate' : 'amber'}>
                        <span className="capitalize">{serial.status ?? 'unknown'}</span>
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {adjustLevel !== undefined && (
        <AdjustModal
          storeId={activeStore?.id ?? ''}
          level={adjustLevel}
          warehouses={warehouses}
          onClose={() => setAdjustLevel(undefined)}
          onSaved={() => { if (selectedWarehouseId) void loadLevels(selectedWarehouseId) }}
        />
      )}
    </div>
  )
}
