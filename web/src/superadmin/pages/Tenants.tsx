/**
 * Tenant Actions — takedown / suspend / restore a store.
 *
 * Destructive actions require:
 *   1. Selecting a store by ID (or typing an ID directly)
 *   2. Selecting the action
 *   3. Entering a mandatory reason
 *   4. Confirming in a hard confirmation modal
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  listStores,
  takedownStore,
  suspendStore,
  restoreStore,
  type StoreItem,
  SuperAdminApiError,
} from '../lib/api'
import {
  PageHeader,
  Spinner,
  LoadError,
  FormInput,
  Badge,
  Btn,
  Modal,
} from '../components/ui/index'
import { AlertTriangle, ShieldX, ShieldOff, ShieldCheck } from 'lucide-react'

type ActionType = 'takedown' | 'suspend' | 'restore'

const ACTION_META: Record<ActionType, { label: string; description: string; color: string; icon: React.ReactNode; btnVariant: 'danger' | 'warning' | 'primary' }> = {
  takedown: {
    label: 'Takedown',
    description: 'Immediately disables the store and all its operations. Customers cannot access the storefront.',
    color: 'text-red-400',
    icon: <ShieldX size={14} className="text-red-400" />,
    btnVariant: 'danger',
  },
  suspend: {
    label: 'Suspend',
    description: 'Temporarily suspends store operations. Less severe than a takedown.',
    color: 'text-amber-400',
    icon: <ShieldOff size={14} className="text-amber-400" />,
    btnVariant: 'warning',
  },
  restore: {
    label: 'Restore',
    description: 'Re-enables a previously taken-down or suspended store.',
    color: 'text-emerald-400',
    icon: <ShieldCheck size={14} className="text-emerald-400" />,
    btnVariant: 'primary',
  },
}

export default function Tenants() {
  const { token, handle401 } = useAuth()
  const { toast } = useToast()

  const [stores, setStores] = useState<StoreItem[]>([])
  const [storesLoading, setStoresLoading] = useState(true)
  const [storesError, setStoresError] = useState<string | null>(null)

  const [storeSearch, setStoreSearch] = useState('')
  const [selectedStore, setSelectedStore] = useState<StoreItem | null>(null)
  const [selectedAction, setSelectedAction] = useState<ActionType | null>(null)
  const [reason, setReason] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [executing, setExecuting] = useState(false)

  const loadStores = useCallback(async () => {
    if (!token) return
    setStoresLoading(true)
    setStoresError(null)
    try {
      const res = await listStores(token)
      setStores(res.stores ?? [])
    } catch (err) {
      if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
      const msg = err instanceof SuperAdminApiError ? err.message : 'Failed to load stores'
      setStoresError(msg)
    } finally {
      setStoresLoading(false)
    }
  }, [token, handle401])

  useEffect(() => { void loadStores() }, [loadStores])

  const filteredStores = stores.filter(s =>
    !storeSearch || s.name?.toLowerCase().includes(storeSearch.toLowerCase()) || s.id.includes(storeSearch),
  )

  const handleExecute = async () => {
    if (!token || !selectedStore || !selectedAction || !reason.trim()) return
    setExecuting(true)
    try {
      if (selectedAction === 'takedown') await takedownStore(token, selectedStore.id, reason)
      else if (selectedAction === 'suspend') await suspendStore(token, selectedStore.id, reason)
      else await restoreStore(token, selectedStore.id, reason)
      toast(`Store ${selectedAction === 'restore' ? 'restored' : selectedAction === 'suspend' ? 'suspended' : 'taken down'} successfully`, 'success')
      setShowConfirm(false)
      setSelectedStore(null)
      setSelectedAction(null)
      setReason('')
      setConfirmText('')
      void loadStores()
    } catch (err) {
      if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
      const msg = err instanceof SuperAdminApiError ? err.message : 'Action failed'
      toast(msg, 'error')
    } finally {
      setExecuting(false)
    }
  }

  const confirmRequired = `${selectedAction?.toUpperCase()} ${selectedStore?.id?.slice(0, 8)}`
  const confirmOk = confirmText === confirmRequired

  return (
    <div>
      <PageHeader
        title="Tenant Actions"
        description="Takedown, suspend, or restore stores. All actions are audited."
      />

      {/* Warning banner */}
      <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/5 px-5 py-4 flex gap-3 items-start">
        <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-red-300 mb-1">Destructive operations</p>
          <p className="text-xs text-red-400/70 leading-relaxed">
            Takedown and suspend actions immediately affect live tenant stores and their customers.
            Every action is permanently recorded in the audit log with your identity, IP address,
            and the provided reason. There is no undo — use restore to re-enable a store.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Step 1: Select store */}
        <div className="rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] p-5">
          <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--cc-text-muted)] mb-4">1. Select store</h3>
          <FormInput
            value={storeSearch}
            onChange={setStoreSearch}
            placeholder="Search store by name or ID..."
            className="mb-3"
          />
          {storesLoading && <div className="flex justify-center py-6"><Spinner /></div>}
          {storesError && <LoadError message={storesError} onRetry={() => void loadStores()} />}
          {!storesLoading && !storesError && (
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filteredStores.slice(0, 50).map(s => (
                <button
                  key={s.id}
                  onClick={() => setSelectedStore(s)}
                  className={`w-full text-left rounded-md px-3 py-2.5 transition ${
                    selectedStore?.id === s.id
                      ? 'bg-[var(--cc-lime)]/12 border border-[var(--cc-lime)]/30'
                      : 'hover:bg-white/[0.03] border border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium text-[var(--cc-text-body)]">{s.name}</p>
                      <p className="text-[11px] text-[var(--cc-text-subtle)] font-mono">{s.id}</p>
                    </div>
                    <Badge color={s.status === 'active' ? 'emerald' : s.status === 'suspended' ? 'amber' : 'red'}>
                      {s.status}
                    </Badge>
                  </div>
                </button>
              ))}
              {filteredStores.length === 0 && (
                <p className="text-xs text-[var(--cc-text-muted)] text-center py-4">No stores found</p>
              )}
            </div>
          )}
        </div>

        {/* Step 2: Choose action + reason */}
        <div className="rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] p-5">
          <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--cc-text-muted)] mb-4">2. Choose action</h3>

          {!selectedStore ? (
            <p className="text-xs text-[var(--cc-text-muted)] py-4 text-center">Select a store first</p>
          ) : (
            <div className="space-y-4">
              <div className="rounded-md bg-white/[0.03] border border-white/[0.06] px-3 py-2.5">
                <p className="text-xs font-medium text-[var(--cc-text-body)]">{selectedStore.name}</p>
                <p className="text-[11px] text-[var(--cc-text-muted)] font-mono">{selectedStore.id}</p>
              </div>

              {/* Action selector */}
              <div className="space-y-2">
                {(Object.keys(ACTION_META) as ActionType[]).map(action => {
                  const meta = ACTION_META[action]
                  return (
                    <button
                      key={action}
                      onClick={() => setSelectedAction(action)}
                      className={`w-full text-left rounded-md px-3 py-3 border transition ${
                        selectedAction === action
                          ? 'border-white/20 bg-white/[0.05]'
                          : 'border-transparent hover:border-white/10 hover:bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        {meta.icon}
                        <span className={`text-xs font-semibold ${meta.color}`}>{meta.label}</span>
                      </div>
                      <p className="text-[11px] text-[var(--cc-text-muted)]">{meta.description}</p>
                    </button>
                  )
                })}
              </div>

              {selectedAction && (
                <div>
                  <FormInput
                    label="Reason (required)"
                    value={reason}
                    onChange={setReason}
                    placeholder="Explain why this action is being taken..."
                  />
                  {!reason.trim() ? (
                    <p className="text-[11px] text-red-400 mt-1 flex items-center gap-1">
                      <AlertTriangle size={11} className="flex-shrink-0" />
                      A reason is required before you can continue.
                    </p>
                  ) : (
                    <p className="text-[11px] text-[var(--cc-text-muted)] mt-1">
                      This reason is permanently recorded in the audit log.
                    </p>
                  )}
                </div>
              )}

              {selectedAction && (
                <Btn
                  variant={ACTION_META[selectedAction].btnVariant as 'danger' | 'warning' | 'primary'}
                  disabled={!reason.trim()}
                  onClick={() => setShowConfirm(true)}
                  className="w-full justify-center"
                >
                  {ACTION_META[selectedAction].label} store
                </Btn>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Confirmation modal */}
      {showConfirm && selectedStore && selectedAction && (
        <Modal
          title={`Confirm: ${ACTION_META[selectedAction].label} store`}
          onClose={() => { setShowConfirm(false); setConfirmText('') }}
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
              <p className="text-sm font-semibold text-red-300 mb-1">
                {ACTION_META[selectedAction].label}: {selectedStore.name}
              </p>
              <p className="text-xs text-red-400/70">{ACTION_META[selectedAction].description}</p>
            </div>

            <div className="text-xs text-[var(--cc-text-body)] space-y-1">
              <p><span className="text-[var(--cc-text-muted)]">Store:</span> {selectedStore.name}</p>
              <p className="font-mono"><span className="text-[var(--cc-text-muted)]">ID:</span> {selectedStore.id}</p>
              <p><span className="text-[var(--cc-text-muted)]">Reason:</span> {reason}</p>
            </div>

            <div>
              <label className="block font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--cc-text-muted)] mb-1.5">
                To confirm, type the exact phrase below:
              </label>
              <div className="mb-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 select-all">
                <code className="text-sm font-mono font-semibold text-red-300 tracking-wide">
                  {confirmRequired}
                </code>
              </div>
              <input
                type="text"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={confirmRequired}
                aria-label={`Type ${confirmRequired} to confirm`}
                className={`w-full rounded-md border bg-white/[0.02] px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-text-subtle)] focus:outline-none focus:ring-2 transition font-mono ${
                  confirmOk
                    ? 'border-emerald-500/40 focus:ring-emerald-400/40'
                    : 'border-red-500/30 focus:border-red-400 focus:ring-red-400/40'
                }`}
              />
              {!confirmOk && (
                <p className="text-[11px] text-red-400 mt-1.5">
                  The phrase must match exactly to enable the {ACTION_META[selectedAction].label.toLowerCase()} button.
                </p>
              )}
            </div>

            <div className="flex gap-3 justify-end">
              <Btn variant="secondary" onClick={() => { setShowConfirm(false); setConfirmText('') }}>
                Cancel
              </Btn>
              <Btn
                variant={ACTION_META[selectedAction].btnVariant as 'danger' | 'warning' | 'primary'}
                disabled={!confirmOk}
                loading={executing}
                onClick={() => void handleExecute()}
              >
                Confirm {ACTION_META[selectedAction].label}
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
