import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setToken, setApiKey } from '../lib/auth'
import { getSdk, resetSdk } from '../lib/sdk'
import { Btn } from '../components/ui/index'

export default function Login() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'jwt' | 'apikey'>('jwt')
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    setError('')
    setLoading(true)
    try {
      if (mode === 'apikey') {
        if (!value.startsWith('cc_prv_') && !value.startsWith('cc_pub_')) {
          setError('API key must start with cc_prv_ or cc_pub_')
          setLoading(false)
          return
        }
        setApiKey(value.trim())
      } else {
        setToken(value.trim())
      }
      resetSdk()
      const sdk = getSdk()
      await sdk.stores.list()
      void navigate('/')
    } catch {
      setError('Invalid credentials or cannot reach API.')
      if (mode === 'apikey') { localStorage.removeItem('cc_admin_apikey') }
      else { localStorage.removeItem('cc_admin_token') }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">Cartcrft Admin</h1>
          <p className="text-sm text-slate-500">Sign in to manage your store</p>
        </div>
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6">
          <div className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-1 mb-5">
            {(['jwt', 'apikey'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md py-2 text-xs font-medium transition ${mode === m ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                {m === 'jwt' ? 'Staff JWT' : 'API Key (cc_prv_)'}
              </button>
            ))}
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                {mode === 'jwt' ? 'Bearer Token' : 'Private API Key'}
              </label>
              <input
                type="password"
                value={value}
                onChange={e => setValue(e.target.value)}
                placeholder={mode === 'jwt' ? 'eyJ...' : 'cc_prv_...'}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500/40 focus:outline-none focus:ring-1 focus:ring-violet-500/20 transition font-mono"
              />
              <p className="mt-1 text-[11px] text-slate-600">
                {mode === 'jwt' ? 'Paste a management JWT from your backend.' : 'Use a cc_prv_ key with commerce:admin scope.'}
              </p>
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <Btn type="submit" loading={loading} className="w-full justify-center">
              Sign in
            </Btn>
          </form>
        </div>
      </div>
    </div>
  )
}
