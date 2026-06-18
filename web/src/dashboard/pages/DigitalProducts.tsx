import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Badge, Btn, Card, FormInput, PageHeader,
  EmptyState, Spinner, Modal, LoadError,
  TableContainer, TableHead, Th, Td,
} from '../components/ui/index'
import { ChevronDown, ChevronRight, FileDown, Plus } from 'lucide-react'
import type { Product } from '@cartcrft/sdk'

interface DigitalFile {
  id: string
  name: string
  url?: string
  size_bytes?: number
  [key: string]: unknown
}

interface DownloadLink {
  url: string
  token: string
}

function DigitalFileRow({
  storeId,
  file,
}: {
  storeId: string
  file: DigitalFile
}) {
  const { toast } = useToast()
  const [link, setLink] = useState<DownloadLink | null>(null)
  const [generating, setGenerating] = useState(false)

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      const sdk = getSdk()
      const res = await sdk.digital.createDownloadLink(storeId, file.id, {
        max_downloads: 5,
        expires_in_hours: 24,
      })
      setLink(res)
      toast('Download link generated (24 h, 5 downloads)', 'success')
    } catch {
      toast('Failed to generate download link', 'error')
    } finally {
      setGenerating(false)
    }
  }

  const sizeLabel = file.size_bytes != null
    ? file.size_bytes >= 1_000_000
      ? `${(file.size_bytes / 1_000_000).toFixed(1)} MB`
      : `${Math.round(file.size_bytes / 1024)} KB`
    : null

  return (
    <tr
      className="transition-colors"
      style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.02)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}
    >
      <Td className="font-medium text-[var(--cc-text)]">{file.name}</Td>
      <Td>
        {sizeLabel
          ? <span className="font-mono text-[12px] text-[var(--cc-muted)]">{sizeLabel}</span>
          : <span className="text-[var(--cc-subtle)]">—</span>}
      </Td>
      <Td>
        {link ? (
          <div className="flex items-center gap-2">
            <code className="font-mono text-[12px] text-[var(--cc-body)] truncate max-w-[220px]">{link.url}</code>
            <Btn
              size="sm"
              variant="secondary"
              onClick={() => { void navigator.clipboard.writeText(link.url); toast('Copied!', 'success') }}
            >
              Copy
            </Btn>
          </div>
        ) : (
          <Btn variant="secondary" loading={generating} onClick={handleGenerate}>
            Generate link
          </Btn>
        )}
      </Td>
    </tr>
  )
}

interface ProductFiles {
  product: Product
  files: DigitalFile[]
  open: boolean
}

export default function DigitalProducts() {
  const { activeStore } = useStore()
  const { toast } = useToast()

  const [productFiles, setProductFiles] = useState<ProductFiles[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [addingFile, setAddingFile] = useState<string | null>(null) // productId
  const [fileForm, setFileForm] = useState({ name: '', url: '', size_bytes: '' })
  const [savingFile, setSavingFile] = useState(false)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    try {
      const sdk = getSdk()
      const res = await sdk.catalog.listProducts(activeStore.id, { product_type: 'digital', limit: 100 })
      const products = res.products ?? []

      const withFiles = await Promise.all(
        products.map(async product => {
          try {
            const filesRes = await sdk.digital.listFiles(activeStore.id, product.id)
            return {
              product,
              files: (filesRes.files ?? []) as DigitalFile[],
              open: true,
            }
          } catch {
            return { product, files: [], open: true }
          }
        })
      )
      setProductFiles(withFiles)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load digital products'
      setLoadError(msg)
    } finally {
      setLoading(false)
    }
  }, [activeStore])

  useEffect(() => { void load() }, [load])

  const toggleOpen = (productId: string) => {
    setProductFiles(pf =>
      pf.map(p => p.product.id === productId ? { ...p, open: !p.open } : p)
    )
  }

  const handleAddFile = async (productId: string) => {
    if (!activeStore) return
    if (!fileForm.name.trim() || !fileForm.url.trim()) {
      toast('Name and URL are required', 'error'); return
    }
    setSavingFile(true)
    try {
      const sdk = getSdk()
      const body: { name: string; url: string; size_bytes?: number } = {
        name: fileForm.name.trim(),
        url: fileForm.url.trim(),
      }
      if (fileForm.size_bytes) body.size_bytes = Number(fileForm.size_bytes)
      await sdk.digital.createFile(activeStore.id, productId, body)
      setFileForm({ name: '', url: '', size_bytes: '' })
      setAddingFile(null)
      toast('File attached', 'success')
      void load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to attach file', 'error')
    } finally {
      setSavingFile(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Digital products"
        description="Files attached to products of type “digital”. Generate download links to share with customers."
      />

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : productFiles.length === 0 && !loadError ? (
        <EmptyState
          icon={<FileDown size={22} />}
          title="No digital products yet"
          description="Create a product with type “digital” on the Products page, then attach files here."
        />
      ) : (
        <div className="space-y-4">
          {productFiles.map(({ product, files, open }) => (
            <Card key={product.id}>
              {/* Product header row */}
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <button
                    onClick={() => toggleOpen(product.id)}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-[var(--cc-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.05] transition"
                    aria-label={open ? 'Collapse' : 'Expand'}
                  >
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                  <span className="font-medium text-[15px] text-[var(--cc-text)] truncate">{product.title}</span>
                  <Badge color="lime">Digital</Badge>
                  <Badge color={product.status === 'active' ? 'emerald' : 'slate'}>
                    <span className="capitalize">{product.status}</span>
                  </Badge>
                </div>
                <Btn
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setAddingFile(product.id)
                    setFileForm({ name: '', url: '', size_bytes: '' })
                  }}
                >
                  <Plus size={13} />
                  Attach file
                </Btn>
              </div>

              {open && (
                <>
                  {files.length === 0 ? (
                    <p className="text-[13px] text-[var(--cc-muted)] py-2">No files attached yet. Use “Attach file” to add a download.</p>
                  ) : (
                    <TableContainer>
                      <table className="w-full text-sm">
                        <TableHead>
                          <Th>File name</Th>
                          <Th>Size</Th>
                          <Th>Download link</Th>
                        </TableHead>
                        <tbody>
                          {files.map(file => (
                            <DigitalFileRow
                              key={file.id}
                              storeId={activeStore?.id ?? ''}
                              file={file}
                            />
                          ))}
                        </tbody>
                      </table>
                    </TableContainer>
                  )}
                </>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Attach File Modal */}
      {addingFile && (
        <Modal title="Attach digital file" onClose={() => setAddingFile(null)}>
          <div className="space-y-4">
            <FormInput
              label="File name"
              required
              value={fileForm.name}
              onChange={v => setFileForm(f => ({ ...f, name: v }))}
              placeholder="e.g. course-materials.zip"
            />
            <FormInput
              label="File URL"
              required
              value={fileForm.url}
              onChange={v => setFileForm(f => ({ ...f, url: v }))}
              placeholder="https://your-storage.example.com/file.zip"
            />
            <FormInput
              label="File size"
              value={fileForm.size_bytes}
              onChange={v => setFileForm(f => ({ ...f, size_bytes: v }))}
              placeholder="10485760"
              type="number"
              hint="In bytes, optional"
            />
            <p className="text-[13px] text-[var(--cc-muted)] leading-relaxed">
              The URL should be a direct link to your file (e.g. S3, Cloudflare R2, or any public or pre-signed URL). CartCrft wraps it with a time-limited download token.
            </p>
            <div className="flex gap-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              <Btn onClick={() => handleAddFile(addingFile)} loading={savingFile}>Attach file</Btn>
              <Btn variant="secondary" onClick={() => setAddingFile(null)}>Cancel</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
