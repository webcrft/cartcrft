import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, PageHeader, EmptyState, Spinner,
  TableContainer, TableHead, Th, Td,
} from '../components/ui/index'

interface Group {
  id: string; name: string; description?: string;
  members_count?: number; [k: string]: unknown
}

interface GroupMember {
  customer_id: string; email?: string;
  first_name?: string; last_name?: string; [k: string]: unknown
}

export default function CustomerGroups() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [groups, setGroups] = useState<Group[]>([])
  const [members, setMembers] = useState<Record<string, GroupMember[]>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [saving, setSaving] = useState(false)
  const [addMemberId, setAddMemberId] = useState('')
  const [addingMember, setAddingMember] = useState(false)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    try {
      const res = await getSdk().request<{ groups: Group[] }>(`/commerce/stores/${activeStore.id}/customer-groups`)
      setGroups((res as { groups?: Group[] }).groups ?? [])
    } catch { setGroups([]) }
    setLoading(false)
  }, [activeStore])

  useEffect(() => { void load() }, [load])

  const loadMembers = async (groupId: string) => {
    if (!activeStore) return
    try {
      const res = await getSdk().request<{ members: GroupMember[] }>(`/commerce/stores/${activeStore.id}/customer-groups/${groupId}/members`)
      setMembers(m => ({ ...m, [groupId]: (res as { members?: GroupMember[] }).members ?? [] }))
    } catch {}
  }

  const toggle = (id: string) => {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    if (!members[id]) void loadMembers(id)
  }

  const create = async () => {
    if (!activeStore || !form.name) { toast('Name required', 'error'); return }
    setSaving(true)
    try {
      const body: Record<string, unknown> = { name: form.name }
      if (form.description) body.description = form.description
      await getSdk().request(`/commerce/stores/${activeStore.id}/customer-groups`, { method: 'POST', body })
      toast('Group created', 'success')
      setShowCreate(false); setForm({ name: '', description: '' })
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Create failed', 'error') }
    finally { setSaving(false) }
  }

  const deleteGroup = async (id: string) => {
    if (!activeStore || !confirm('Delete this group?')) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/customer-groups/${id}`, { method: 'DELETE' })
      setGroups(g => g.filter(x => x.id !== id))
      toast('Deleted', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Delete failed', 'error') }
  }

  const addMember = async (groupId: string) => {
    if (!activeStore || !addMemberId.trim()) { toast('Customer ID required', 'error'); return }
    setAddingMember(true)
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/customer-groups/${groupId}/members`, {
        method: 'POST', body: { customer_id: addMemberId.trim() },
      })
      toast('Member added', 'success')
      setAddMemberId('')
      void loadMembers(groupId)
    } catch (err) { toast(err instanceof Error ? err.message : 'Add failed', 'error') }
    finally { setAddingMember(false) }
  }

  const removeMember = async (groupId: string, customerId: string) => {
    if (!activeStore) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/customer-groups/${groupId}/members/${customerId}`, { method: 'DELETE' })
      setMembers(m => ({ ...m, [groupId]: (m[groupId] ?? []).filter(x => x.customer_id !== customerId) }))
      toast('Member removed', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Remove failed', 'error') }
  }

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer Groups"
        description="Segment customers into groups for targeted pricing and offers"
        actions={<Btn onClick={() => setShowCreate(v => !v)}>+ New Group</Btn>}
      />

      {showCreate && (
        <Card>
          <div className="space-y-3">
            <p className="text-sm font-semibold text-white">New Customer Group</p>
            <div className="grid grid-cols-2 gap-3">
              <FormInput label="Name" value={form.name} onChange={set('name')} placeholder="VIP Customers" />
              <FormInput label="Description (optional)" value={form.description} onChange={set('description')} placeholder="High-value customers" />
            </div>
            <div className="flex gap-2">
              <Btn onClick={create} loading={saving} variant="green">Create</Btn>
              <Btn variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Btn>
            </div>
          </div>
        </Card>
      )}

      {groups.length === 0 ? (
        <EmptyState title="No customer groups" description="Create groups to segment customers for pricing and offers" action="New Group" onAction={() => setShowCreate(true)} />
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.id} className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-white/[0.02] transition" onClick={() => toggle(g.id)}>
                <div>
                  <p className="text-sm font-semibold text-white">{g.name}</p>
                  {g.description && <p className="text-xs text-slate-500">{g.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">{g.members_count ?? 0} members</span>
                  <span onClick={e => e.stopPropagation()}><Btn variant="danger" onClick={() => void deleteGroup(g.id)}>Delete</Btn></span>
                  <span className="text-slate-500 text-xs">{expanded === g.id ? '▲' : '▼'}</span>
                </div>
              </div>

              {expanded === g.id && (
                <div className="border-t border-white/[0.06] px-5 py-4 space-y-3">
                  <div className="flex gap-2 items-end">
                    <FormInput label="Add Customer by ID" value={addMemberId} onChange={setAddMemberId} placeholder="cust_..." />
                    <Btn onClick={() => void addMember(g.id)} loading={addingMember} variant="green">Add</Btn>
                  </div>
                  {members[g.id] && members[g.id].length > 0 ? (
                    <TableContainer>
                      <table className="w-full text-sm">
                        <TableHead><Th>Customer</Th><Th>Email</Th><Th></Th></TableHead>
                        <tbody>
                          {members[g.id].map((m, i) => (
                            <tr key={String(m.customer_id ?? i)} className="border-t border-white/[0.04]">
                              <Td className="text-white">{m.first_name ?? ''} {m.last_name ?? ''}</Td>
                              <Td className="text-slate-400">{m.email ?? m.customer_id}</Td>
                              <Td><Btn variant="danger" onClick={() => void removeMember(g.id, m.customer_id)}>Remove</Btn></Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableContainer>
                  ) : (
                    <p className="text-xs text-slate-500">No members yet.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
