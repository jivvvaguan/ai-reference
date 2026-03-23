# SODEX Exchange API

> 分类: apis
> 适用场景: 接入 SODEX 去中心化衍生品交易所（永续合约），获取行情、下单、管理仓位
> 配套代码: `sodex-api-example.ts`
> 最后验证: 2026-03-23

## 核心概念

SODEX 是去中心化永续合约交易所，API 架构分三层：
1. **公开行情** — REST 获取 ticker/orderbook/symbols，无需鉴权
2. **账户查询** — REST 获取持仓/余额/历史，需传地址但无需签名
3. **交易操作** — REST 下单/撤单/改单，需 EIP-712 签名 + API Key

鉴权不是传统的 HMAC，而是 **EIP-712 Typed Data 签名**（链上钱包签名机制）。

## 关键决策

- 签名用 EIP-712 而非 HMAC → 链上可验证，与钱包体系一致
- Nonce 用 timestamp 递增 → 保证唯一且单调递增，服务端容忍 ±2 天偏差
- 价格/数量用 string 而非 number → 避免浮点精度丢失（Decimal String）
- Post-only 订单用 `timeInForce: GTX(4)` → 保证 maker，被 taker 则拒绝
- 改单(replace)优于撤单+下单 → 原子操作，减少裸露风险

## 常见坑

- ❌ 价格用 number → 必须用 string（"3500.1" 不是 3500.1）
- ❌ 签名 v 值直接用 → ethers 返回 27/28，SODEX 需要 0/1（减 27）
- ❌ 签名后直接发 → 需要 prepend `0x01`（交易操作）或 `0x02`（AddAPIKey）
- ❌ 永续和现货用同一个 domain.name → 永续用 "futures"，现货用 "spot"
- ❌ body 发完整 `{type, params}` → 实际 HTTP body 只发 params 部分
- ❌ 不处理 replace 失败 → replace 失败后必须回退到 cancel + place
- ❌ WebSocket 不发 ping → 60 秒无消息自动断开

## 快速集成步骤

1. 安装依赖: `bun add ethers`
2. 在 SODEX 创建 API Key: 参考 `sodex-docs/add-api-key.md`
3. 配置环境变量: `SODEX_PRIVATE_KEY`, `SODEX_API_KEY_NAME`
4. 复制 `sodex-api-example.ts` 的 Core Implementation 段到项目
5. 从 `getSymbols()` 获取 symbolID/tickSize/precision 后开始交易

## 网络与端点

| 网络 | REST | WebSocket | ChainID |
|------|------|-----------|---------|
| Mainnet | `https://mainnet-gw.sodex.dev/api/v1/perps` | `wss://mainnet-gw.sodex.dev/ws/perps` | 286623 |
| Testnet | `https://testnet-gw.sodex.dev/api/v1/perps` | `wss://testnet-gw.sodex.dev/ws/perps` | 138565 |

## API 速查

### 公开行情（无鉴权）

| Endpoint | 方法 | 用途 |
|----------|------|------|
| `/tickers` | GET | 全部/单个交易对实时价格 |
| `/tickers?symbol=ETH-USD` | GET | 指定交易对 ticker |
| `/symbols` | GET | 交易对元数据（tickSize/precision/symbolID） |
| `/markPrices` | GET | 标记价格 + 资金费率 |
| `/orderbook?symbol=ETH-USD&limit=10` | GET | 订单簿深度 |

### 账户查询（传地址，无签名）

| Endpoint | 方法 | 用途 |
|----------|------|------|
| `/openOrders?address=0x...` | GET | 当前挂单 |
| `/positions?address=0x...` | GET | 当前持仓 |
| `/accountState?address=0x...` | GET | 账户余额/保证金 |
| `/orderHistory?address=0x...&limit=50` | GET | 历史订单 |

### 交易操作（EIP-712 签名）

| Endpoint | 方法 | 签名 type | 用途 |
|----------|------|-----------|------|
| `/order` | POST | newOrder | 下单（支持批量） |
| `/cancel` | POST | cancelOrder | 撤单（支持批量） |
| `/replace` | POST | replaceOrder | 改单（原子撤+下） |
| `/scheduleCancel` | POST | scheduleCancel | 定时全撤（心跳保护） |
| `/leverage` | POST | updateLeverage | 调整杠杆 |

### 签名 Headers

```
X-API-Key:   {apiKeyName}
X-API-Sign:  {EIP-712 签名，0x01 前缀}
X-API-Nonce: {nonce string}
```

### 响应格式

```json
{ "code": 0, "timestamp": 1710000000000, "data": {...} }
{ "code": 1001, "timestamp": 1710000000000, "error": "invalid signature" }
```

## WebSocket 频道

| 频道 | 推送频率 | 数据 |
|------|---------|------|
| `l2Book` | 每块(≥0.5s) | 订单簿快照 bids/asks |
| `markPrice` | 每块(≥1s) | 标记价格/指数价格/资金费率 |
| `accountTrade` | 每块 | 成交回报 |
| `accountOrderUpdate` | 每块 | 订单状态变更 |
| `accountUpdate` | 每块 | 余额/保证金变更 |

## 枚举值

```
Side:          BUY=1, SELL=2
OrderType:     LIMIT=1, MARKET=2
TimeInForce:   GTC=1, FOK=2, IOC=3, GTX=4(Post-Only)
OrderModifier: NORMAL=1, STOP=2, BRACKET=3
PositionSide:  BOTH=1, LONG=2, SHORT=3
MarginMode:    ISOLATED=1, CROSS=2
```
