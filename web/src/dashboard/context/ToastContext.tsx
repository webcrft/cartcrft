import React, { createContext, useContext, useState, useCallback } from 'react'

interface Toast { id: number; message: string; type: 'success' | 'error' | 'info' }
interface ToastContextValue { toast: (msg: string, type?: Toast['type']) => void }

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  let nextId = 0
  const dismiss = useCallback((id: number) => {
    setToasts(t => t.filter(x => x.id !== id))
  }, [])

  const toast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = ++nextId
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000)
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`flex items-start gap-3 pl-4 pr-2.5 py-2.5 rounded-xl text-sm font-medium shadow-xl border pointer-events-auto
            ${t.type === 'success' ? 'bg-emerald-900/90 text-emerald-100 border-emerald-700/50' :
              t.type === 'error' ? 'bg-red-900/90 text-red-100 border-red-700/50' :
              'bg-slate-800/90 text-slate-100 border-white/10'}`}>
            <span className="flex-1">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="-mr-0.5 mt-0.5 flex-shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 hover:bg-white/10 transition leading-none"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast outside ToastProvider')
  return ctx
}
