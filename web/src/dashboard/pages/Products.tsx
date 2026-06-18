import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Badge, Btn, Card, FormInput, FormSelect, PageHeader, EmptyState,
  SearchInput, Spinner, Modal, TableContainer, TableHead, Th, Td, Pagination,
  SectionDivider,
} from '../components/ui/index'
import { PRODUCT_STATUS_MAP, statusBadgeProps } from '../lib/statusMaps'
import { Package, Plus } from 'lucide-react'
import type { Product, Variant } from '@cartcrft/sdk'

const PRODUCT_TYPES = [
  { value: 'simple', label: 'Simple' },
  { value: 'bundle', label: 'Bundle' },
  { value: 'configurable', label: 'Configurable' },
  { value: 'digital', label: 'Digital' },
  { value: 'service', label: 'Service' },
  { value: 'subscription', label: 'Subscription' },
]

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'active', label: 'Active' },
  { value: 'archived', label: 'Archived' },
]

interface ProductForm {
  title: string
  description: string
  product_type: string
  status: string
  vendor: string
  tags: string
  price: string
  compare_at_price: string
  sku: string
  weight_g: string
  track_inventory: boolean
}

const defaultForm: ProductForm = {
  title: '',
  description: '',
  product_type: 'simple',
  status: 'draft',
  vendor: '',
  tags: '',
  price: '',
  compare_at_price: '',
  sku: '',
  weight_g: '',
  track_inventory: false,
}

/** Best-effort thumbnail URL from a product's media/images (list payloads may omit these). */
function productThumbUrl(p: Product): string | null {
  const media = (p as { media?: Array<{ url?: string; cdn_url?: string | null }> }).media
  if (Array.isArray(media) && media.length > 0) {
    const m = media[0]
    return m?.cdn_url ?? m?.url ?? null
  }
  const images = (p as { images?: unknown }).images
  if (Array.isArray(images) && typeof images[0] === 'string') return images[0]
  return null
}

function ProductThumb({ product }: { product: Product }) {
  const url = productThumbUrl(product)
  const [errored, setErrored] = useState(false)
  if (url && !errored) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setErrored(true)}
        className="h-10 w-10 flex-shrink-0 rounded-lg object-cover"
        style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'var(--cc-bg-sunken)' }}
      />
    )
  }
  return (
    <div
      className="h-10 w-10 flex-shrink-0 rounded-lg flex items-center justify-center text-[var(--cc-subtle)]"
      style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'var(--cc-bg-sunken)' }}
      aria-hidden="true"
    >
      <Package size={15} />
    </div>
  )
}

function ProductEditor({ storeId, product, onClose, onSaved }: {
  storeId: string
  product: Product | null
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState<ProductForm>(defaultForm)
  const [variants, setVariants] = useState<Variant[]>([])
  const [saving, setSaving] = useState(false)
  const [loadingVariants, setLoadingVariants] = useState(false)

  useEffect(() => {
    if (product) {
      setForm({
        title: product.title ?? '',
        description: (product.description as string | undefined) ?? '',
        product_type: product.product_type ?? 'simple',
        status: product.status ?? 'draft',
        vendor: (product.vendor as string | undefined) ?? '',
        tags: Array.isArray(product.tags) ? (product.tags as string[]).join(', ') : ((product.tags as string | undefined) ?? ''),
        price: (product.price_min as string | undefined) ?? '',
        compare_at_price: '',
        sku: '',
        weight_g: '',
        track_inventory: false,
      })
      setLoadingVariants(true)
      const sdk = getSdk()
      void sdk.catalog.listVariants(storeId, product.id).then(res => {
        setVariants(res.variants ?? [])
        const defaultVariant = res.variants?.[0]
        if (defaultVariant) {
          setForm(f => ({
            ...f,
            price: defaultVariant.price ?? '',
            compare_at_price: (defaultVariant.compare_at_price as string | undefined) ?? '',
            sku: defaultVariant.sku ?? '',
            weight_g: String(defaultVariant.weight_g ?? ''),
            track_inventory: defaultVariant.track_inventory ?? false,
          }))
        }
      }).catch(() => {}).finally(() => setLoadingVariants(false))
    }
  }, [product, storeId])

  const set = (k: keyof ProductForm) => (v: string | boolean) =>
    setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    if (!form.title.trim()) { toast('Title is required', 'error'); return }
    setSaving(true)
    try {
      const sdk = getSdk()
      type ProductBodyType = Parameters<typeof sdk.catalog.createProduct>[1]
      const body: ProductBodyType = { title: form.title.trim(), product_type: form.product_type, status: form.status }
      if (form.description) body.description = form.description
      if (form.vendor) body.vendor = form.vendor
      if (form.tags) body.tags = form.tags.split(',').map(t => t.trim()).filter(Boolean)

      let savedProduct: Product
      if (product) {
        const res = await sdk.catalog.updateProduct(storeId, product.id, body)
        savedProduct = res.product
      } else {
        const res = await sdk.catalog.createProduct(storeId, body)
        savedProduct = res.product
      }
      if (form.price) {
        type VariantBodyType = Parameters<typeof sdk.catalog.createVariant>[2]
        const variantBody: VariantBodyType = { title: 'Default', price: form.price, track_inventory: form.track_inventory }
        if (form.compare_at_price) variantBody.compare_at_price = form.compare_at_price
        if (form.sku) variantBody.sku = form.sku
        if (form.weight_g) variantBody.weight_g = Number(form.weight_g)
        if (variants.length > 0 && variants[0]) {
          await sdk.catalog.updateVariant(storeId, savedProduct.id, variants[0].id, variantBody)
        } else {
          await sdk.catalog.createVariant(storeId, savedProduct.id, variantBody)
        }
      }
      toast(product ? 'Product updated' : 'Product created', 'success')
      onSaved()
      onClose()
    } catch (err) {
      toast((err instanceof Error ? err.message : 'Save failed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={product ? 'Edit Product' : 'New Product'} onClose={onClose} size="md">
      <div className="space-y-4">
        <FormInput label="Title" required value={form.title} onChange={set('title')} placeholder="Product name" />
        <div>
          <label className="block text-[13px] font-medium text-[var(--cc-body)] mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={e => set('description')(e.target.value)}
            rows={3}
            placeholder="Product description..."
            className="w-full rounded-lg px-3 py-2.5 text-sm text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--cc-lime)]/20 transition resize-none"
            style={{ background: 'var(--cc-bg-sunken)', border: '1px solid rgba(255,255,255,0.08)' }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormSelect label="Type" value={form.product_type} onChange={set('product_type')} options={PRODUCT_TYPES} />
          <FormSelect label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTIONS} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormInput label="Vendor" value={form.vendor} onChange={set('vendor')} placeholder="Brand name" />
          <FormInput label="Tags" value={form.tags} onChange={set('tags')} placeholder="tag1, tag2" hint="Comma-separated" />
        </div>

        <SectionDivider label="Default Variant" />

        {loadingVariants ? (
          <div className="flex items-center gap-2 py-2">
            <Spinner size="sm" />
            <span className="text-xs text-[var(--cc-muted)]">Loading variants…</span>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <FormInput label="Price" required value={form.price} onChange={set('price')} placeholder="0.00" type="number" />
              <FormInput label="Compare at Price" value={form.compare_at_price} onChange={set('compare_at_price')} placeholder="0.00" type="number" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormInput label="SKU" value={form.sku} onChange={set('sku')} placeholder="SKU-001" />
              <FormInput label="Weight (g)" value={form.weight_g} onChange={set('weight_g')} placeholder="0" type="number" />
            </div>
            <label className="flex items-center gap-2.5 text-xs text-[var(--cc-muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.track_inventory}
                onChange={e => set('track_inventory')(e.target.checked)}
                className="rounded"
              />
              Track inventory for this product
            </label>
          </div>
        )}

        {variants.length > 1 && (
          <>
            <SectionDivider label={`All Variants (${variants.length})`} />
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {variants.map(v => (
                <div
                  key={v.id}
                  className="flex items-center justify-between rounded-lg px-3 py-2"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
                >
                  <span className="text-xs text-[var(--cc-body)]">{v.title}</span>
                  <span className="text-xs font-mono text-[var(--cc-muted)]">{v.price}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="flex gap-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <Btn onClick={handleSave} loading={saving}>{product ? 'Save Changes' : 'Create Product'}</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

const PAGE_SIZE = 25

export default function Products() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [products, setProducts] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editProduct, setEditProduct] = useState<Product | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)

  const load = useCallback((off: number, q?: string) => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    const query: { limit: number; offset: number; q?: string } = { limit: PAGE_SIZE, offset: off }
    if (q?.trim()) query.q = q.trim()
    void sdk.catalog.listProducts(activeStore.id, query)
      .then(res => { setProducts(res.products ?? []); setTotal(res.total ?? 0) })
      .catch(() => toast('Failed to load products', 'error'))
      .finally(() => setLoading(false))
  }, [activeStore, toast])

  useEffect(() => { setOffset(0); load(0) }, [load])

  const handleDelete = async (productId: string) => {
    if (!activeStore) return
    if (!confirm('Delete this product?')) return
    setDeleting(productId)
    try {
      const sdk = getSdk()
      await sdk.catalog.deleteProduct(activeStore.id, productId)
      toast('Product deleted', 'success')
      load(offset, search)
    } catch {
      toast('Delete failed', 'error')
    } finally {
      setDeleting(null)
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  const handleSearch = (q: string) => {
    setSearch(q)
    setOffset(0)
    load(0, q)
  }

  const goToPage = (newOffset: number) => {
    setOffset(newOffset)
    load(newOffset, search)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products"
        description={loading ? undefined : `${total.toLocaleString()} product${total !== 1 ? 's' : ''}`}
        actions={
          <Btn onClick={() => setEditProduct(null)}>
            <Plus size={13} />
            New Product
          </Btn>
        }
      />

      <SearchInput value={search} onChange={handleSearch} placeholder="Search products by title, SKU…" />

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : products.length === 0 ? (
        <EmptyState
          icon={<Package size={22} />}
          title="No products yet"
          description="Create your first product to start selling."
          action="New Product"
          onAction={() => setEditProduct(null)}
        />
      ) : (
        <>
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead>
                <Th>Product</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th align="right">Price</Th>
                <Th></Th>
              </TableHead>
              <tbody>
                {products.map(product => {
                  const st = statusBadgeProps(product.status, PRODUCT_STATUS_MAP)
                  return (
                    <tr
                      key={product.id}
                      className="transition-colors"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.02)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}
                    >
                      <Td>
                        <div className="flex items-center gap-3 min-w-0">
                          <ProductThumb product={product} />
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="font-medium text-[var(--cc-text)] truncate">{product.title}</span>
                            {product.variants_count != null && product.variants_count > 0 && (
                              <span className="text-[12px] text-[var(--cc-subtle)]">
                                {product.variants_count} variant{product.variants_count !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                        </div>
                      </Td>
                      <Td><Badge color="slate"><span className="capitalize">{product.product_type}</span></Badge></Td>
                      <Td><Badge color={st.color}>{st.label}</Badge></Td>
                      <Td align="right" className="font-mono text-[var(--cc-body)]">
                        {product.price_min ? product.price_min : <span className="text-[var(--cc-subtle)]">—</span>}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1.5 justify-end">
                          <Btn size="sm" variant="secondary" onClick={() => setEditProduct(product)}>Edit</Btn>
                          <Btn size="sm" variant="danger" loading={deleting === product.id} onClick={() => handleDelete(product.id)}>Delete</Btn>
                        </div>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableContainer>

          {totalPages > 1 && (
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              total={total}
              unit="products"
              onPrev={() => goToPage(offset - PAGE_SIZE)}
              onNext={() => goToPage(offset + PAGE_SIZE)}
            />
          )}
        </>
      )}

      {editProduct !== undefined && (
        <ProductEditor
          storeId={activeStore?.id ?? ''}
          product={editProduct}
          onClose={() => setEditProduct(undefined)}
          onSaved={() => load(offset, search)}
        />
      )}
    </div>
  )
}
