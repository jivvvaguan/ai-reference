# SODEX API Key — 注册与使用

> 分类: apis
> 适用场景: 首次接入 SODEX 时注册 API Key，以及将 API Key 集成到交易系统中
> 配套代码: `sodex-api-key-example.ts` (后端/CLI), `sodex-api-key-ui.html` (前端界面)
> 最后验证: 2026-03-24

## 核心概念

SODEX 的 API Key 不是传统的 string token，而是一个 **EVM 地址**。
注册 API Key 本质上是告诉 SODEX："我授权这个地址代表我的账户签名交易"。

完整流程：
1. **生成密钥对** — 创建一个新的 EVM 钱包（地址 = API Key，私钥 = API Secret）
2. **注册到 SODEX** — 用主账户钱包签名 EIP-712 消息，将 API Key 地址绑定到账户
3. **使用 API Key** — 后续交易请求用 API Key 的私钥签名，Header 里传 API Key 的 name

## 关键决策

- 注册签名用 `domain.name: "universal"`（不是 "futures"/"spot"）→ AddAPIKey 是跨市场操作
- 签名前缀用 `0x02`（不是交易操作的 `0x01`）→ SODEX 用前缀区分操作类型
- API Key 的 `name` 字段在后续交易时作为 `X-API-Key` header → name 是标识符，不是密钥本身
- body 字段名是 `type`（整数），但 EIP-712 签名的字段名是 `keyType` → 两者不同，容易搞混

## 常见坑

- ❌ body 里用 `keyType` → body 用 `type`（整数 1=EVM），EIP-712 message 用 `keyType`
- ❌ 用 API Key 的私钥签名注册请求 → 必须用**主账户**的私钥签名
- ❌ name 用 "default" → "default" 是保留名，会报错
- ❌ 注册后直接交易 → 需要确认注册成功（查询 `/accounts/{addr}/api-keys`）
- ❌ 注册时没带 `X-API-Chain` header → 注册需要这个 header（交易不需要）
- ❌ 只注册到 perps → 如果也要用 spot，需要分别注册（endpoint 不同）

## 注册接口

| 字段 | REST body | EIP-712 message |
|------|-----------|-----------------|
| 账户 ID | `accountID` | `accountID` |
| 名称 | `name` | `name` |
| 类型 | **`type`** (整数) | **`keyType`** (整数) |
| 公钥 | `publicKey` | `publicKey` |
| 过期 | `expiresAt` | `expiresAt` |
| Nonce | — | `nonce` |

注册端点:
- Perps: `POST {PERPS_ENDPOINT}/accounts/api-keys`
- Spot: `POST {SPOT_ENDPOINT}/accounts/api-keys`

注册 Headers（比交易多一个 `X-API-Chain`）:
```
X-API-Sign:  {0x02 前缀的 EIP-712 签名}
X-API-Nonce: {nonce string}
X-API-Chain: {chainId string}
```

## 完整流程

```
1. 生成密钥对
   └→ ethers.Wallet.createRandom()
   └→ 保存: address (= API Key 地址), privateKey (= API Secret)

2. 注册 API Key
   └→ 用主账户私钥签名 EIP-712 (domain: "universal", prefix: 0x02)
   └→ POST /accounts/api-keys

3. 验证注册
   └→ GET /accounts/{masterAddress}/api-keys

4. 配置到交易系统
   └→ env: SODEX_API_KEY_NAME={name}, SODEX_PRIVATE_KEY={API Key 私钥}
   └→ 交易请求 Header: X-API-Key={name}
   └→ 交易请求签名: 用 API Key 私钥 + domain "futures" + prefix 0x01

5. 开始交易
   └→ 参考 sodex-api-example.ts
```

## 前端界面

`sodex-api-key-ui.html` 提供完整的浏览器端注册界面：
- 支持 MetaMask 和 WalletConnect 连接主账户钱包
- 自动获取 accountID
- 可生成新密钥对或输入已有地址
- 支持配置过期时间、网络、目标市场（perps/spot/both）
- 三步流程：连接钱包 → 配置 → 签名提交

直接用浏览器打开即可使用，零后端依赖。
