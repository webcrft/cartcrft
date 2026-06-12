import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner, Modal,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'
import type { Agent, Mandate } from '@cartcrft/sdk'

type Tab = 'registry' | 'mandates' | 'audit'

const AGENT_SCOPES = [
  'catalog:read', 'catalog:write',
  'cart:read', 'cart:write',
  'checkout:read', 'checkout:write',
  'orders:read', 'orders:write',
  'customers:read', 'customers:write',
  'payments:read', 'payments:write',
  'inventory:read', 'inventory:write',
]

const AGENT_TYPES = [
  { value: 'mcp', label: 'MCP (Model Context Protocol)' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'internal', label: 'Internal' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'event_driven', label: 'Event-Driven' },
]

const MANDATE_STATUS: Record<string, { color: 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'; label: string }> = {
  active: { color: 'emerald', label: 'Active' },
  revoked: { color: 'red', label: 'Revoked' },
  expired: { color: 'amber', label: 'Expired' },
  fulfilled: { color: 'blue', label: 'Fulfilled' },
}

function PrivateKeyModal({ agentName, privateKey, onClose }: {
  agentName: string; privateKey: string; onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(privateKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Modal title="Private Key — Save Now" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">This is the only time this key will be shown.</p>
          <p className="text-xs text-amber-400/70 mt-1">Copy and store it securely. You cannot retrieve it again.</p>
        </div>
        <div>
          <p className="text-xs font-medium text-slate-400 mb-1.5">Agent: <span className="text-white">{agentName}</span></p>
          <div className="flex items-start gap-2">
            <pre className="flex-1 rounded-lg bg-black/40 border border-white/[0.06] p-3 text-xs text-emerald-300 font-mono break-all whitespace-pre-wrap overflow-auto max-h-40">
              {privateKey}
            </pre>
            <Btn variant="secondary" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</Btn>
          </div>
        </div>
        <div className="pt-2 border-t border-white/[0.06]">
          <Btn variant="primary" onClick={onClose}>I have saved this key</Btn>
        </div>
      </div>
    </Modal>
  )
}

function CreateAgentModal({ storeId, onClose, onCreated }: {
  storeId: string; onClose: () => void; onCreated: (agent: Agent, privateKey: string) => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({ name: '', type: 'mcp', spend_limit: '', spend_window: 'day' })
  const [selectedScopes, setSelectedScopes] = useState<string[]>(['catalog:read', 'cart:write', 'checkout:write'])
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const toggleScope = (s: string) =>
    setSelectedScopes(sc => sc.includes(s) ? sc.filter(x => x !== s) : [...sc, s])

  const handleCreate = async () => {
    if (!form.name) { toast('Name required', 'error'); return }
    setSaving(true)
    try {
      const sdk = getSdk()
      const body: Parameters<typeof sdk.agents.create>[1] = {
        name: form.name, type: form.type,
        scopes: selectedScopes,
      }
      if (form.spend_limit) (body as Record<string, unknown>).spend_limit = form.spend_limit
      const res = await sdk.agents.create(storeId, body)
      toast('Agent created', 'success')
      onCreated(res.agent, res.private_key)
    } catch (err) { toast(err instanceof Error ? err.message : 'Create failed', 'error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="New Agent" onClose={onClose}>
      <div className="space-y-4">
        <FormInput label="Name" value={form.name} onChange={set('name')} placeholder="checkout-bot" />
        <FormSelect label="Type" value={form.type} onChange={set('type')} options={AGENT_TYPES} />
        <div className="grid grid-cols-2 gap-3">
          <FormInput label="Spend Limit (optional)" value={form.spend_limit} onChange={set('spend_limit')} placeholder="500.00" type="number" />
          <FormSelect label="Spend Window" value={form.spend_window} onChange={set('spend_window')}
            options={[{ value: 'hour', label: 'Per Hour' }, { value: 'day', label: 'Per Day' }, { value: 'week', label: 'Per Week' }, { value: 'month', label: 'Per Month' }]} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-2">Scopes</label>
          <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
            {AGENT_SCOPES.map(scope => (
              <label key={scope} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedScopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  className="rounded border-white/20 bg-white/5 text-violet-500"
                />
                <span className="text-xs text-slate-300 font-mono">{scope}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleCreate} loading={saving} variant="green">Create Agent</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

function MandateChainModal({ storeId, agentId, mandate, onClose }: {
  storeId: string; agentId: string; mandate: Mandate; onClose: () => void
}) {
  const [chain, setChain] = useState<Mandate[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Load the chain: this mandate + children (intent→cart→payment)
    void (async () => {
      try {
        const res = await getSdk().request<{ chain: Mandate[] }>(
          `/commerce/stores/${storeId}/agents/${agentId}/mandates/${mandate.id}/chain`
        )
        setChain((res as { chain?: Mandate[] }).chain ?? [mandate])
      } catch { setChain([mandate]) }
      setLoading(false)
    })()
  }, [storeId, agentId, mandate])

  return (
    <Modal title="Mandate Chain" onClose={onClose}>
      {loading ? <div className="flex justify-center py-8"><Spinner /></div> : (
        <div className="space-y-3">
          {chain.map((m, i) => {
            const st = MANDATE_STATUS[String(m.status ?? 'active')] ?? { color: 'slate' as const, label: String(m.status ?? '') }
            return (
              <div key={String(m.id ?? i)} className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-400">{i + 1}.</span>
                    <Badge color="violet">{String(m.intent ?? 'intent')}</Badge>
                    <Badge color={st.color}>{st.label}</Badge>
                  </div>
                  <span className="text-xs text-slate-500 font-mono">{String(m.id ?? '').slice(0, 8)}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 text-xs text-slate-500">
                  {(m as Record<string, unknown>).valid_until ? (
                    <span>Expires: {new Date(String((m as Record<string, unknown>).valid_until)).toLocaleDateString()}</span>
                  ) : null}
                  {(m as Record<string, unknown>).resource_type ? (
                    <span>Resource: {String((m as Record<string, unknown>).resource_type)}</span>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

export default function Agents() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('registry')
  const [agents, setAgents] = useState<Agent[]>([])
  const [mandates, setMandates] = useState<Mandate[]>([])
  const [auditLog, setAuditLog] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [privateKeyResult, setPrivateKeyResult] = useState<{ agent: Agent; key: string } | null>(null)
  const [selectedMandate, setSelectedMandate] = useState<{ agentId: string; mandate: Mandate } | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [revoking, setRevoking] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    try {
      const res = await sdk.agents.list(activeStore.id)
      const agentList = res.agents ?? []
      setAgents(agentList)
      if (!selectedAgentId && agentList.length > 0) setSelectedAgentId(agentList[0].id)
    } catch { setAgents([]) }
    try {
      const res = await sdk.request<{ entries: Record<string, unknown>[] }>(
        `/commerce/stores/${activeStore.id}/agents/audit-log`
      )
      setAuditLog((res as { entries?: Record<string, unknown>[] }).entries ?? [])
    } catch { setAuditLog([]) }
    setLoading(false)
  }, [activeStore, selectedAgentId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (tab === 'mandates' && selectedAgentId && activeStore) {
      void (async () => {
        try {
          const sdk = getSdk()
          const res = await sdk.agents.listMandates(activeStore.id, selectedAgentId)
          setMandates(res.mandates ?? [])
        } catch { setMandates([]) }
      })()
    }
  }, [tab, selectedAgentId, activeStore])

  const revokeAgent = async (agentId: string) => {
    if (!activeStore || !confirm('Revoke this agent? It will lose API access immediately.')) return
    setRevoking(agentId)
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/agents/${agentId}/revoke`, { method: 'POST', body: {} })
      toast('Agent revoked', 'success')
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Revoke failed', 'error') }
    finally { setRevoking(null) }
  }

  const TABS = [
    { key: 'registry' as Tab, label: 'Registry' },
    { key: 'mandates' as Tab, label: 'Mandates' },
    { key: 'audit' as Tab, label: 'Audit Log' },
  ]

  const agentOptions = agents.map(a => ({ value: a.id, label: `${a.name} (${a.type})` }))

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agents"
        description="Agent registry, signed mandates, spend limits, and audit trail"
        actions={tab === 'registry' ? <Btn onClick={() => setShowCreate(true)}>+ New Agent</Btn> : undefined}
        badge={<Badge color="violet">Agent-Native</Badge>}
      />

      <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.05] px-4 py-3 text-xs text-slate-400 leading-relaxed">
        <span className="font-semibold text-slate-200">Agent-native trust layer.</span>{' '}
        Agents hold ed25519 keypairs and sign mandates proving consent for each action. The chain
        intent → cart → payment is cryptographically verifiable. Spend limits enforce budget caps per window.
      </div>

      <div className="flex border-b border-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${tab === t.key ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'registry' && (
        agents.length === 0 ? (
          <EmptyState
            title="No agents registered"
            description="Create an agent to enable AI/automation access with scoped permissions and spend limits"
            action="New Agent"
            onAction={() => setShowCreate(true)}
          />
        ) : (
          <div className="space-y-3">
            {agents.map(agent => (
              <div key={agent.id} className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="text-sm font-semibold text-white">{agent.name}</p>
                    <Badge color="violet">{agent.type}</Badge>
                    {(agent as Record<string, unknown>).is_active === false && <Badge color="red">Revoked</Badge>}
                    {(agent as Record<string, unknown>).is_active !== false && <Badge color="emerald">Active</Badge>}
                  </div>
                  <div className="flex gap-2">
                    {(agent as Record<string, unknown>).is_active !== false && (
                      <Btn variant="danger" loading={revoking === agent.id} onClick={() => void revokeAgent(agent.id)}>
                        Revoke
                      </Btn>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <p className="text-slate-500 mb-0.5">Agent ID</p>
                    <p className="text-slate-300 font-mono">{agent.id.slice(0, 12)}</p>
                  </div>
                  <div>
                    <p className="text-slate-500 mb-0.5">Scopes</p>
                    <p className="text-slate-300">
                      {Array.isArray((agent as Record<string, unknown>).scopes)
                        ? ((agent as Record<string, unknown>).scopes as string[]).length
                        : '—'} scopes
                    </p>
                  </div>
                  {(agent as Record<string, unknown>).spend_limit ? (
                    <div>
                      <p className="text-slate-500 mb-0.5">Spend Limit</p>
                      <p className="text-slate-300 font-mono">{String((agent as Record<string, unknown>).spend_limit)}</p>
                    </div>
                  ) : null}
                  <div>
                    <p className="text-slate-500 mb-0.5">Created</p>
                    <p className="text-slate-300">{new Date(agent.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Public Key</p>
                  <pre className="text-[10px] text-slate-500 font-mono bg-black/20 rounded px-2 py-1 overflow-hidden overflow-ellipsis whitespace-nowrap max-w-full">
                    {String(agent.public_key ?? '').slice(0, 80)}...
                  </pre>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'mandates' && (
        <div className="space-y-4">
          {agentOptions.length > 0 && (
            <div className="max-w-xs">
              <FormSelect
                label="Agent"
                value={selectedAgentId}
                onChange={id => { setSelectedAgentId(id); setMandates([]) }}
                options={agentOptions}
              />
            </div>
          )}
          {mandates.length === 0 ? (
            <EmptyState title="No mandates" description="Signed mandates issued by this agent appear here. Each mandate chains intent → cart → payment." />
          ) : (
            <TableContainer>
              <table className="w-full text-sm">
                <TableHead><Th>ID</Th><Th>Intent</Th><Th>Status</Th><Th>Expires</Th><Th></Th></TableHead>
                <tbody>
                  {mandates.map(m => {
                    const st = MANDATE_STATUS[String(m.status ?? 'active')] ?? { color: 'slate' as const, label: String(m.status ?? '') }
                    return (
                      <tr key={String(m.id)} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                        <Td className="font-mono text-xs text-slate-400">{String(m.id).slice(0, 8)}</Td>
                        <Td><Badge color="violet">{m.intent}</Badge></Td>
                        <Td><Badge color={st.color}>{st.label}</Badge></Td>
                        <Td className="text-slate-500 text-xs">
                          {(m as Record<string, unknown>).valid_until
                            ? new Date(String((m as Record<string, unknown>).valid_until)).toLocaleDateString()
                            : '—'}
                        </Td>
                        <Td>
                          <Btn variant="secondary" onClick={() => setSelectedMandate({ agentId: selectedAgentId, mandate: m })}>
                            View Chain
                          </Btn>
                        </Td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TableContainer>
          )}
        </div>
      )}

      {tab === 'audit' && (
        auditLog.length === 0 ? (
          <EmptyState title="No audit log entries" description="Agent actions are logged here — create, revoke, mandate issue/verify events" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Action</Th><Th>Agent</Th><Th>Resource</Th><Th>Correlation</Th><Th>Date</Th></TableHead>
              <tbody>
                {auditLog.map((entry, i) => (
                  <tr key={String(entry.id ?? i)} className="border-t border-white/[0.04]">
                    <Td><Badge color="slate">{String(entry.action ?? '—')}</Badge></Td>
                    <Td className="font-mono text-xs text-slate-400">{String(entry.agent_id ?? '—').slice(0, 8)}</Td>
                    <Td className="text-slate-400 text-xs">
                      {String(entry.resource_type ?? '')} {String(entry.resource_id ?? '').slice(0, 8)}
                    </Td>
                    <Td className="font-mono text-xs text-slate-500">{String(entry.correlation_id ?? '—').slice(0, 10)}</Td>
                    <Td className="text-slate-500 text-xs">
                      {entry.created_at ? new Date(String(entry.created_at)).toLocaleString() : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {showCreate && activeStore && (
        <CreateAgentModal
          storeId={activeStore.id}
          onClose={() => setShowCreate(false)}
          onCreated={(agent, key) => {
            setShowCreate(false)
            setPrivateKeyResult({ agent, key })
            void load()
          }}
        />
      )}

      {privateKeyResult && (
        <PrivateKeyModal
          agentName={privateKeyResult.agent.name}
          privateKey={privateKeyResult.key}
          onClose={() => setPrivateKeyResult(null)}
        />
      )}

      {selectedMandate && activeStore && (
        <MandateChainModal
          storeId={activeStore.id}
          agentId={selectedMandate.agentId}
          mandate={selectedMandate.mandate}
          onClose={() => setSelectedMandate(null)}
        />
      )}
    </div>
  )
}
