import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Badge, Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner, Modal, TableContainer, TableHead, Th, Td } from '../components/ui/index'
import { PRODUCT_STATUS_MAP, statusBadgeProps } from '../lib/statusMaps'
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
      // Load variants
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
      // Save/update default variant if price provided
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
    <Modal title={product ? 'Edit Product' : 'New Product'} onClose={onClose}>
      <div className="space-y-4">
        <FormInput label="Title *" value={form.title} onChange={set('title')} placeholder="Product name" />
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={e => set('description')(e.target.value)}
            rows={3}
            placeholder="Product description..."
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-white/20 focus:outline-none resize-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormSelect label="Type" value={form.product_type} onChange={set('product_type')} options={PRODUCT_TYPES} />
          <FormSelect label="Status" value={form.status} onChange={set('status')} options={STATUS_OPTIONS} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormInput label="Vendor" value={form.vendor} onChange={set('vendor')} placeholder="Brand name" />
          <FormInput label="Tags (comma-separated)" value={form.tags} onChange={set('tags')} placeholder="tag1, tag2" />
        </div>

        <div className="border-t border-white/[0.06] pt-4">
          <p className="text-xs font-semibold text-slate-400 mb-3">Default Variant Pricing</p>
          {loadingVariants ? <Spinner /> : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="Price *" value={form.price} onChange={set('price')} placeholder="0.00" type="number" />
                <FormInput label="Compare at Price" value={form.compare_at_price} onChange={set('compare_at_price')} placeholder="0.00" type="number" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormInput label="SKU" value={form.sku} onChange={set('sku')} placeholder="SKU-001" />
                <FormInput label="Weight (g)" value={form.weight_g} onChange={set('weight_g')} placeholder="0" type="number" />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input type="checkbox" checked={form.track_inventory} onChange={e => set('track_inventory')(e.target.checked)}
                  className="rounded" />
                Track inventory
              </label>
            </div>
          )}
        </div>

        {variants.length > 1 && (
          <div className="border-t border-white/[0.06] pt-4">
            <p className="text-xs font-semibold text-slate-400 mb-3">All Variants ({variants.length})</p>
            <div className="space-y-1">
              {variants.map(v => (
                <div key={v.id} className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2">
                  <span className="text-xs text-slate-300">{v.title}</span>
                  <span className="text-xs font-mono text-slate-400">{v.price}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
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

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const hasPrev = offset > 0
  const hasNext = offset + PAGE_SIZE < total

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
    <div className="space-y-4">
      <PageHeader
        title="Products"
        description={`${total} product${total !== 1 ? 's' : ''}`}
        actions={<Btn onClick={() => setEditProduct(null)}>+ New Product</Btn>}
      />

      <div>
        <input
          value={search}
          onChange={e => handleSearch(e.target.value)}
          placeholder="Search products..."
          className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500/40 focus:outline-none"
        />
      </div>

      {products.length === 0 ? (
        <EmptyState
          title="No products yet"
          description="Create your first product to start selling"
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
                <Th>Price</Th>
                <Th></Th>
              </TableHead>
              <tbody>
                {products.map(product => {
                  const st = statusBadgeProps(product.status, PRODUCT_STATUS_MAP)
                  return (
                    <tr key={product.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                      <Td>
                        <div>
                          <span className="font-medium text-white">{product.title}</span>
                          {product.variants_count != null && product.variants_count > 0 && (
                            <span className="ml-2 text-[11px] text-slate-500">{product.variants_count} variant{product.variants_count !== 1 ? 's' : ''}</span>
                          )}
                        </div>
                      </Td>
                      <Td><Badge color="slate">{product.product_type}</Badge></Td>
                      <Td><Badge color={st.color}>{st.label}</Badge></Td>
                      <Td className="text-slate-300 font-mono">{product.price_min ? `${product.price_min}` : '—'}</Td>
                      <Td>
                        <div className="flex items-center gap-2 justify-end">
                          <Btn variant="secondary" onClick={() => setEditProduct(product)}>Edit</Btn>
                          <Btn variant="danger" loading={deleting === product.id} onClick={() => handleDelete(product.id)}>Del</Btn>
                        </div>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableContainer>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-1">
              <span className="text-xs text-slate-500">
                Page {currentPage} of {totalPages} &middot; {total} products
              </span>
              <div className="flex items-center gap-2">
                <Btn
                  variant="secondary"
                  disabled={!hasPrev}
                  onClick={() => goToPage(offset - PAGE_SIZE)}
                >
                  &#8592; Prev
                </Btn>
                <Btn
                  variant="secondary"
                  disabled={!hasNext}
                  onClick={() => goToPage(offset + PAGE_SIZE)}
                >
                  Next &#8594;
                </Btn>
              </div>
            </div>
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
