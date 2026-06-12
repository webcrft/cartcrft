import { Cartcrft } from '@cartcrft/sdk'
import { getToken, getApiKey } from './auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BASE_URL: string = (import.meta as any).env?.['VITE_API_URL'] ?? 'http://localhost:3000'

export function createSdk(): Cartcrft {
  const apiKey = getApiKey()
  const token = getToken()
  return new Cartcrft({
    baseUrl: BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    ...(token && !apiKey ? { token } : {}),
  })
}

let _sdk: Cartcrft | null = null

export function getSdk(): Cartcrft {
  if (!_sdk) _sdk = createSdk()
  return _sdk
}

export function resetSdk(): void { _sdk = null }
