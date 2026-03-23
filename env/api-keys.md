# API Keys & Environment Variables

> 分类: env
> 适用场景: 新项目初始化、配置开发环境、CI/CD 环境变量设置
> 最后验证: 2026-03-23

## 命名约定

```
{SERVICE}_{TYPE}
```

- SERVICE: 全大写，如 `SODEX`, `COINGECKO`, `WALLETCONNECT`
- TYPE: `API_KEY`, `API_SECRET`, `BASE_URL`, `PROJECT_ID`

客户端可见变量加 `NEXT_PUBLIC_` 前缀（Next.js 约定）。

## 服务清单

### SODEX
```env
SODEX_API_KEY=
SODEX_API_SECRET=
SODEX_BASE_URL=https://api-staging.sodex.com/v1
# Production: https://api.sodex.com/v1
```

### WalletConnect
```env
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=
# 获取: https://cloud.walletconnect.com → 创建项目
```

### CoinGecko
```env
# 免费 tier 无需 key，限 30 req/min
# Pro tier:
COINGECKO_API_KEY=
COINGECKO_BASE_URL=https://pro-api.coingecko.com/api/v3
# 免费 tier: https://api.coingecko.com/api/v3
```

## .env.example 模板

每个项目根目录应有 `.env.example`（提交到 git）：

```env
# SODEX
SODEX_API_KEY=your_key_here
SODEX_API_SECRET=your_secret_here
SODEX_BASE_URL=https://api-staging.sodex.com/v1

# WalletConnect
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id_here

# CoinGecko (optional, free tier works without key)
# COINGECKO_API_KEY=
```

## 常见坑

- ❌ 把 API key 硬编码在代码里 → 用 `process.env.XXX`
- ❌ `.env` 提交到 git → `.gitignore` 必须包含 `.env*`（除 `.env.example`）
- ❌ 客户端代码用不了 env → Next.js 需要 `NEXT_PUBLIC_` 前缀
- ❌ staging 和 production 用同一个 key → 分别配置 `_BASE_URL`
