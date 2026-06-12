type BadgeColor = 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'

interface StatusEntry { color: BadgeColor; label: string }
type StatusMap = Record<string, StatusEntry>

export const FINANCIAL_STATUS_MAP: StatusMap = {
  paid: { color: 'emerald', label: 'Paid' },
  pending: { color: 'amber', label: 'Pending' },
  refunded: { color: 'red', label: 'Refunded' },
  authorized: { color: 'blue', label: 'Authorized' },
  partially_paid: { color: 'amber', label: 'Partial' },
  partially_refunded: { color: 'amber', label: 'Part. Refunded' },
  voided: { color: 'slate', label: 'Voided' },
}

export const FULFILLMENT_MAP: StatusMap = {
  fulfilled: { color: 'emerald', label: 'Fulfilled' },
  partial: { color: 'amber', label: 'Partial' },
  unfulfilled: { color: 'slate', label: 'Unfulfilled' },
  returned: { color: 'red', label: 'Returned' },
}

export const ORDER_STATUS_MAP: StatusMap = {
  open: { color: 'blue', label: 'Open' },
  closed: { color: 'slate', label: 'Closed' },
  cancelled: { color: 'red', label: 'Cancelled' },
}

export const PRODUCT_STATUS_MAP: StatusMap = {
  active: { color: 'emerald', label: 'Active' },
  draft: { color: 'amber', label: 'Draft' },
  archived: { color: 'slate', label: 'Archived' },
}

export function statusBadgeProps(status: string, map: StatusMap): { color: BadgeColor; label: string } {
  return map[status] ?? { color: 'slate', label: status.replace(/_/g, ' ') }
}
