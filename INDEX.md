# AI Reference Library Index

> 标准: 见 `STANDARD.md`
> 每个条目 = `.ts` (可运行代码案例) + `.md` (说明文档)
> AI 开发时 Read 此索引，按需查阅具体参考

---

## APIs
- `apis/sodex-api-example.ts` + `sodex-api.md` — SODEX 永续合约 API: EIP-712 签名、行情/交易 REST、WebSocket 实时数据
- `apis/sodex-api-key-example.ts` + `sodex-api-key.md` + `sodex-api-key-ui.html` — SODEX API Key 注册与使用: 生成密钥对→注册→验证→配置，含前端 UI
- `apis/sodex-db-example.ts` + `sodex-db.md` — SODEX Analytics 数据库(StarRocks): 连接配置、Schema 拓扑、交易/留存/积分查询、8 条常见坑
<!-- - `apis/coingecko-example.ts` + `.md` — CoinGecko 价格 API: 免费 tier 用法 -->

## Web3
<!-- - `web3/walletconnect-example.tsx` + `.md` — WalletConnect v2: React 组件连接钱包 -->
<!-- - `web3/wagmi-example.tsx` + `.md` — wagmi hooks: useAccount/useConnect/useContractRead -->
<!-- - `web3/ethers-v6-example.ts` + `.md` — ethers.js v6: Provider/Signer/Contract 模式 -->

## Patterns
<!-- - `patterns/api-error-handling-example.ts` + `.md` — 统一错误处理 + HTTP 响应格式 -->

## Env
- `env/api-keys.md` — 环境变量命名约定 + 开发环境 endpoint 清单

<!--
条目添加规则:
1. 取消对应行的注释
2. 确保 .ts 和 .md 文件都已创建
3. .ts 文件 bun run 验证通过
-->
