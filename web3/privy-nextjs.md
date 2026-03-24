# Privy + Next.js 认证集成

> 分类: web3
> 适用场景: Next.js App Router 项目接入 Privy 认证（Email OTP / Google / Apple / 钱包登录 + 嵌入式钱包）
> 配套代码: `privy-nextjs-example.tsx`
> 最后验证: 2026-03-24

## 核心概念

Privy 提供统一身份认证 + 嵌入式钱包，一次登录同时获得：
- **用户身份** — Email/Google/Apple/Twitter 登录
- **EVM 钱包** — 自动创建嵌入式钱包，用户无需安装 MetaMask
- **跨应用身份** — 同一个 Privy appId 下的多个应用共享用户身份
- **EIP-712 签名** — 嵌入式钱包可直接签名链上交易

## 关键决策

- PrivyProvider 必须用 `dynamic(() => import(...), { ssr: false })` 包裹 → Privy 依赖浏览器 API，SSR 会报错
- 需要 `globalThis.Buffer` polyfill → WalletConnect 内部依赖 Node.js Buffer
- 嵌入式钱包用 `createOnLogin: 'users-without-wallets'` → 首次登录自动创建，不打扰已有钱包的用户
- Login 页面自建 UI 而非用 Privy 默认 modal → 更好的品牌控制和 UX
- `useSignTypedData` 需要适配器包装 → Privy 的签名接口和 SoDEX SDK 格式不同

## 常见坑

- ❌ PrivyProvider 直接放 layout.tsx → SSR 报错，必须 `dynamic` + `{ ssr: false }`
- ❌ 不加 Buffer polyfill → WalletConnect 初始化崩溃 `Buffer is not defined`
- ❌ `usePrivy()` 在 `ready=false` 时读 `user` → 返回 undefined，必须先检查 `ready && authenticated`
- ❌ `useLoginWithEmail` 的 `sendCode` 多次调用 → 会触发 rate limit，按钮要加 loading 状态禁用
- ❌ `signTypedData` 返回值格式不统一 → 有时返回 string，有时返回 `{ signature: string }`，必须兼容两种
- ❌ onboarding 状态存 React state → 刷新页面丢失，必须用 localStorage 持久化
- ❌ auth guard 用 `useEffect` redirect 导致闪烁 → 用 `useMemo` 同步检查 localStorage，再用 `useEffect` 异步 redirect

## 文件结构

```
app/
├── layout.tsx              — Root layout（引入 Providers）
├── providers.tsx            — dynamic(() => import('./privy-provider'), { ssr: false })
├── privy-provider.tsx       — PrivyProvider 配置（loginMethods/chains/embeddedWallets）
├── login/page.tsx           — 自定义登录页（Email OTP + Google + Apple + Wallet）
├── (dashboard)/
│   ├── layout.tsx           — Auth guard + onboarding redirect
│   ├── onboarding/page.tsx  — SoDEX 账户设置（API Key 注册）
│   └── ...                  — 受保护页面
lib/
├── auth.ts                  — useAuth() hook（封装 usePrivy + useWallets + useLogout）
└── onboarding.ts            — useOnboarding() hook（SoDEX API Key + signTypedData 适配）
```

## Privy 配置

```typescript
{
  appId: "cmgn8067h000ll50co5cu7pen",  // 从 console.privy.io 获取
  config: {
    loginMethods: ['email', 'google', 'apple', 'wallet'],
    appearance: { theme: 'light', accentColor: '#171717' },
    embeddedWallets: {
      ethereum: { createOnLogin: 'users-without-wallets' }
    },
    defaultChain: base,                 // viem chain 对象
    supportedChains: [base, valueChain],
  }
}
```

## 核心 Hooks

| Hook | 来源 | 用途 |
|------|------|------|
| `usePrivy()` | `@privy-io/react-auth` | ready/authenticated/user/login/getAccessToken |
| `useLoginWithEmail()` | `@privy-io/react-auth` | sendCode/loginWithCode/state |
| `useLoginWithOAuth()` | `@privy-io/react-auth` | initOAuth({ provider: 'google' }) |
| `useWallets()` | `@privy-io/react-auth` | 获取嵌入式钱包地址 |
| `useLogout()` | `@privy-io/react-auth` | logout + onSuccess 回调 |
| `useSignTypedData()` | `@privy-io/react-auth` | EIP-712 签名（用于 SoDEX API Key 注册） |

## signTypedData 适配器

Privy 的 `signTypedData` 和外部 SDK 的签名函数接口不同，需要适配：

```typescript
function createSignAdapter(privySign) {
  return async (input, options) => {
    const sig = await privySign(
      { domain, types, primaryType, message },
      { address: options.address, uiOptions: { showPrompt: false } }
    );
    // 兼容两种返回格式
    return typeof sig === 'string' ? { signature: sig } : sig;
  };
}
```

## 环境变量

```bash
NEXT_PUBLIC_PRIVY_APP_ID=cmgn8067h000ll50co5cu7pen  # 从 console.privy.io
# 服务端验证（可选）:
# PRIVY_APP_SECRET=...
```

## 安装

```bash
npm install @privy-io/react-auth
# 如果需要服务端验证:
npm install @privy-io/server-auth
```
