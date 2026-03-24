/**
 * @reference web3/privy-nextjs
 * @description Privy + Next.js App Router 完整集成: Provider 配置 / 自定义登录 / Auth Hook / Onboarding
 * @prerequisites next@14+, @privy-io/react-auth, viem
 * @env NEXT_PUBLIC_PRIVY_APP_ID
 * @runnable 复制各 section 到对应文件，npm run dev 启动
 * @verified 2026-03-24
 */

// ═══ 1. Setup & Config ═══
// File: app/privy-provider.tsx

'use client'

import { PrivyProvider } from '@privy-io/react-auth'
import { base } from 'viem/chains'

// Custom chain example (SoDEX ValueChain)
const valueChain = {
  id: 286623,
  name: 'ValueChain',
  nativeCurrency: { decimals: 18, name: 'SOSO', symbol: 'SOSO' },
  rpcUrls: { default: { http: ['https://mainnet.valuechain.xyz/'] } },
}

export default function PrivyProviderWrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID || "your-privy-app-id"}
      config={{
        loginMethods: ['email', 'google', 'apple', 'wallet'],
        appearance: {
          theme: 'light',
          accentColor: '#171717',
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets', // Auto-create for new users
          },
        },
        defaultChain: base,
        supportedChains: [base, valueChain as any],
      }}
    >
      {children}
    </PrivyProvider>
  )
}

// ═══ 1b. Providers wrapper (SSR-safe) ═══
// File: app/providers.tsx
// CRITICAL: PrivyProvider must be loaded with ssr: false

// 'use client'
// import { Buffer } from 'buffer'
// if (typeof globalThis.Buffer === 'undefined') {
//   globalThis.Buffer = Buffer  // WalletConnect needs Buffer polyfill
// }
// import dynamic from 'next/dynamic'
//
// const PrivyProviderWrapper = dynamic(
//   () => import('./privy-provider'),
//   { ssr: false, loading: () => <LoadingSpinner /> }
// )
//
// export default function Providers({ children }) {
//   return <PrivyProviderWrapper>{children}</PrivyProviderWrapper>
// }

// ═══ 2. Types & Core Implementation ═══

// --- Auth Hook ---
// File: lib/auth.ts

import { usePrivy, useWallets, useLogout } from '@privy-io/react-auth'
import { useRouter } from 'next/navigation'

export function useAuth() {
  const { ready, authenticated, user, getAccessToken } = usePrivy()
  const { wallets } = useWallets()
  const router = useRouter()
  const { logout: privyLogout } = useLogout({
    onSuccess: () => router.push('/login'),
  })

  // Find the Privy-managed embedded wallet
  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy')

  return {
    ready,
    authenticated,
    user,
    walletAddress: embeddedWallet?.address ?? null,
    logout: privyLogout,
    getAccessToken,
  }
}

// --- Onboarding Hook (SoDEX API Key registration via Privy signTypedData) ---
// File: lib/onboarding.ts

import { useState, useCallback, useRef } from 'react'
import { useSignTypedData } from '@privy-io/react-auth'

const LS_KEY_PRIVATE_KEY = 'sodex_api_private_key'
const LS_KEY_ACCOUNT_ID = 'sodex_account_id'

export type OnboardingStatus =
  | 'checking' | 'needs-setup' | 'fetching-account'
  | 'registering-key' | 'creating-deposits' | 'ready' | 'error'

/** Check if onboarding is complete (synchronous, for auth guard) */
export function isOnboardingComplete(): boolean {
  if (typeof window === 'undefined') return false
  return !!(localStorage.getItem(LS_KEY_ACCOUNT_ID) && localStorage.getItem(LS_KEY_PRIVATE_KEY))
}

/**
 * Adapter: wraps Privy's signTypedData to match external SDK's expected interface.
 *
 * Privy's signTypedData returns string | { signature: string } depending on context.
 * External SDKs typically expect { signature: string }.
 */
function createSignAdapter(
  privySignTypedData: ReturnType<typeof useSignTypedData>['signTypedData']
) {
  return async (
    input: { domain: any; types: any; primaryType: string; message: any },
    options: { address: string }
  ) => {
    const signature = await privySignTypedData(
      {
        domain: input.domain,
        types: input.types,
        primaryType: input.primaryType,
        message: input.message,
      },
      {
        address: options.address,
        uiOptions: { showPrompt: false }, // Don't show Privy's approval modal
      } as any
    )

    // Normalize return value — Privy may return string or { signature }
    if (typeof signature === 'string') {
      return { signature }
    }
    return signature as { signature: string }
  }
}

export function useOnboarding() {
  const { signTypedData } = useSignTypedData()
  const [status, setStatus] = useState<OnboardingStatus>('checking')
  const [error, setError] = useState<string | null>(null)
  const runningRef = useRef(false)

  const startSetup = useCallback(
    async (walletAddress: string) => {
      if (runningRef.current) return
      runningRef.current = true
      setError(null)

      try {
        // Step 1: Fetch AccountID from chain/API
        setStatus('fetching-account')
        // const accountId = await fetchAccountID(walletAddress)
        // localStorage.setItem(LS_KEY_ACCOUNT_ID, String(accountId))

        // Step 2: Generate + register API key (requires Privy wallet signature)
        setStatus('registering-key')
        const signAdapter = createSignAdapter(signTypedData)
        // const keyResult = await addAPIKey(accountId, walletAddress, signAdapter)
        // localStorage.setItem(LS_KEY_PRIVATE_KEY, keyResult.privateKey)

        // Step 3: Create deposit addresses (if applicable)
        setStatus('creating-deposits')
        // const deposits = await createAllDepositAddresses(walletAddress)

        // Step 4: Sync to server
        // await fetch('/api/users/register', { method: 'POST', body: JSON.stringify({...}) })

        setStatus('ready')
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Setup failed')
        setStatus('error')
      } finally {
        runningRef.current = false
      }
    },
    [signTypedData]
  )

  return { status, error, startSetup, retry: () => { setError(null); setStatus('needs-setup'); runningRef.current = false } }
}

// ═══ 3. Usage Examples ═══

// --- Login Page ---
// File: app/login/page.tsx

// 'use client'
import { usePrivy as _usePrivy, useLoginWithEmail, useLoginWithOAuth } from '@privy-io/react-auth'

export function LoginPage() {
  const router = { push: (p: string) => console.log('navigate:', p) } // placeholder
  const { ready, authenticated, login } = _usePrivy()
  const { sendCode, loginWithCode, state: emailState } = useLoginWithEmail({
    onComplete: () => router.push('/chat'),
  })
  const { initOAuth } = useLoginWithOAuth({
    onComplete: () => router.push('/chat'),
  })

  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')

  // Redirect if already logged in
  // useEffect(() => { if (ready && authenticated) router.push('/chat') }, [ready, authenticated])

  const showCodeInput = emailState.status === 'awaiting-code-input'

  return (
    <div>
      {showCodeInput ? (
        // OTP verification step
        <div>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Enter verification code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loginWithCode({ code })}
          />
          <button onClick={() => loginWithCode({ code })}>Verify</button>
        </div>
      ) : (
        // Login options
        <div>
          {/* Email OTP */}
          <input
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendCode({ email })}
          />
          <button onClick={() => sendCode({ email })}>Continue with Email</button>

          {/* OAuth */}
          <button onClick={() => initOAuth({ provider: 'google' })}>Continue with Google</button>
          <button onClick={() => initOAuth({ provider: 'apple' })}>Continue with Apple</button>

          {/* Wallet (uses Privy's built-in modal) */}
          <button onClick={() => login()}>Connect Wallet</button>
        </div>
      )}
    </div>
  )
}

// --- Dashboard Auth Guard ---
// File: app/(dashboard)/layout.tsx

// 'use client'
import { useEffect, useMemo } from 'react'
// import { usePrivy } from '@privy-io/react-auth'
// import { isOnboardingComplete } from '@/lib/onboarding'

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated } = _usePrivy()
  const router = { push: (p: string) => console.log('navigate:', p), replace: (p: string) => console.log('replace:', p) }
  const pathname = '/dashboard' // placeholder

  // Synchronous check — no flicker
  const onboarded = useMemo(() => {
    if (typeof window === 'undefined') return false
    return isOnboardingComplete()
  }, [pathname])

  // Auth redirect
  useEffect(() => {
    if (ready && !authenticated) router.push('/login')
  }, [ready, authenticated])

  // Onboarding redirect
  useEffect(() => {
    if (!ready || !authenticated) return
    if (onboarded && pathname === '/onboarding') router.replace('/chat')
    else if (!onboarded && pathname !== '/onboarding') router.replace('/onboarding')
  }, [ready, authenticated, onboarded, pathname])

  if (!ready || !authenticated) return null
  if (!onboarded && pathname !== '/onboarding') return null

  return <div>{children}</div>
}

// --- Server-side: User Registration ---
// File: apps/server/src/routes/users.ts (Hono example)

// import { Hono } from 'hono'
// import { encrypt } from '../lib/crypto'
//
// app.post('/register', async (c) => {
//   const { privyId, walletAddress, email, sodexAccountId, apiKeyPrivateKey } = await c.req.json()
//
//   // Encrypt API key before storing
//   const apiKeyEncrypted = apiKeyPrivateKey ? encrypt(apiKeyPrivateKey, ENCRYPTION_SECRET) : null
//
//   // Upsert user (conflict on walletAddress)
//   const [user] = await db.insert(users).values({
//     id: privyId,
//     walletAddress,
//     email,
//     sodexAccountId,
//     apiKeyEncrypted,
//     onboardingCompleted: true,
//   }).onConflictDoUpdate({
//     target: users.walletAddress,
//     set: { apiKeyEncrypted, sodexAccountId, updatedAt: new Date() },
//   }).returning()
//
//   // Never return encrypted key to client
//   const { apiKeyEncrypted: _, ...safeUser } = user
//   return c.json(safeUser)
// })

// ═══ 4. Main (展示用，非可运行) ═══

console.log("=== Privy + Next.js Integration Reference ===")
console.log("")
console.log("This file is a reference — copy sections to your Next.js project:")
console.log("  Section 1 → app/privy-provider.tsx + app/providers.tsx")
console.log("  Section 2 → lib/auth.ts + lib/onboarding.ts")
console.log("  Section 3 → app/login/page.tsx + app/(dashboard)/layout.tsx")
console.log("")
console.log("Install: npm install @privy-io/react-auth viem")
console.log("Env:     NEXT_PUBLIC_PRIVY_APP_ID=... (from console.privy.io)")
