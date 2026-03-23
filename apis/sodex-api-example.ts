/**
 * @reference apis/sodex-api
 * @description SODEX 永续合约 API 完整集成示例: EIP-712 签名 + REST 行情/交易 + WebSocket 实时数据
 * @prerequisites bun, ethers@6
 * @env SODEX_PRIVATE_KEY, SODEX_API_KEY_NAME
 * @runnable bun run apis/sodex-api-example.ts
 * @verified 2026-03-23
 */

import { Wallet, keccak256, toUtf8Bytes } from "ethers";

// ═══ 1. Setup & Config ═══

const CONFIG = {
  restEndpoint: process.env.SODEX_REST_ENDPOINT || "https://testnet-gw.sodex.dev/api/v1/perps",
  wsEndpoint: process.env.SODEX_WS_ENDPOINT || "wss://testnet-gw.sodex.dev/ws/perps",
  chainId: parseInt(process.env.SODEX_CHAIN_ID || "138565"), // testnet
  privateKey: process.env.SODEX_PRIVATE_KEY || "",
  apiKeyName: process.env.SODEX_API_KEY_NAME || "",
  requestTimeoutMs: 8_000,
};

// ═══ 2. Types & Core Implementation ═══

// --- Enums ---

const Side = { BUY: 1, SELL: 2 } as const;
const OrderType = { LIMIT: 1, MARKET: 2 } as const;
const TimeInForce = { GTC: 1, FOK: 2, IOC: 3, GTX: 4 } as const; // GTX = Post-Only
const OrderModifier = { NORMAL: 1, STOP: 2, BRACKET: 3 } as const;
const PositionSide = { BOTH: 1, LONG: 2, SHORT: 3 } as const;
const MarginMode = { ISOLATED: 1, CROSS: 2 } as const;

// --- Response Types ---

interface ApiResponse<T> {
  code: number;      // 0 = success
  timestamp: number;
  error?: string;
  data?: T;
}

interface TickerData {
  symbol: string;
  symbolID: number;
  lastPrice: string;
  markPrice: string;
  bestBidPrice: string;
  bestAskPrice: string;
  volume24h: string;
  priceChangePercent: string;
}

interface SymbolData {
  symbol: string;
  symbolID: number;
  tickSize: string;
  stepSize: string;
  pricePrecision: number;
  quantityPrecision: number;
  minNotional: string;
}

interface OrderbookData {
  symbol: string;
  bids: [string, string][]; // [price, quantity]
  asks: [string, string][];
  updateId: number;
}

interface OrderData {
  orderID: number;
  clOrdID: string;
  symbol: string;
  symbolID: number;
  side: number;
  type: number;
  price: string;
  quantity: string;
  status: string;
  filledQty: string;
}

interface PositionData {
  symbol: string;
  symbolID: number;
  side: string;
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  leverage: number;
}

interface AccountStateData {
  accountID: number;
  totalBalance: string;
  availableBalance: string;
  marginUsed: string;
}

interface PerpsOrderItem {
  clOrdID: string;
  modifier: number;
  side: number;
  type: number;
  timeInForce: number;
  price?: string;
  quantity?: string;
  reduceOnly: boolean;
  positionSide: number;
}

// --- Nonce Manager ---

class NonceManager {
  private counter: bigint;

  constructor() {
    this.counter = BigInt(Date.now());
  }

  next(): bigint {
    const now = BigInt(Date.now());
    if (now > this.counter) {
      this.counter = now;
    } else {
      this.counter++;
    }
    return this.counter;
  }
}

// --- EIP-712 Signer ---

class SodexSigner {
  private wallet: Wallet;
  private chainId: number;
  private nonceManager = new NonceManager();

  constructor(privateKey: string, chainId: number) {
    this.wallet = new Wallet(privateKey);
    this.chainId = chainId;
  }

  get address(): string {
    return this.wallet.address;
  }

  /**
   * Sign an exchange action (newOrder, cancelOrder, replaceOrder, etc.)
   * Returns signature with 0x01 prefix + nonce
   */
  async signAction(payload: object): Promise<{ signature: string; nonce: bigint }> {
    const nonce = this.nonceManager.next();
    const payloadHash = keccak256(toUtf8Bytes(JSON.stringify(payload)));

    const domain = {
      name: "futures", // "spot" for spot markets
      version: "1",
      chainId: this.chainId,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };

    const types = {
      ExchangeAction: [
        { name: "payloadHash", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    };

    const sig = await this.wallet.signTypedData(domain, types, { payloadHash, nonce });

    // Convert v from 27/28 to 0/1 (Go crypto.Sign format)
    const vByte = parseInt(sig.slice(-2), 16);
    const v01 = (vByte >= 27 ? vByte - 27 : vByte).toString(16).padStart(2, "0");
    const sigV01 = sig.slice(0, -2) + v01;

    // Prepend 0x01 for exchange actions
    return { signature: "0x01" + sigV01.slice(2), nonce };
  }
}

// --- REST API Client ---

class SodexClient {
  private endpoint: string;
  private signer: SodexSigner;
  private apiKeyName: string;

  constructor(endpoint: string, signer: SodexSigner, apiKeyName: string) {
    this.endpoint = endpoint;
    this.signer = signer;
    this.apiKeyName = apiKeyName;
  }

  // -- Public Market Data (no auth) --

  async getTickers(symbol?: string): Promise<ApiResponse<TickerData[]>> {
    const qs = symbol ? `?symbol=${symbol}` : "";
    return this.get(`/tickers${qs}`);
  }

  async getSymbols(symbol?: string): Promise<ApiResponse<SymbolData[]>> {
    const qs = symbol ? `?symbol=${symbol}` : "";
    return this.get(`/symbols${qs}`);
  }

  async getMarkPrices(symbol?: string): Promise<ApiResponse<any[]>> {
    const qs = symbol ? `?symbol=${symbol}` : "";
    return this.get(`/markPrices${qs}`);
  }

  async getOrderbook(symbol: string, limit = 10): Promise<ApiResponse<OrderbookData>> {
    return this.get(`/orderbook?symbol=${symbol}&limit=${limit}`);
  }

  // -- Account Queries (address required, no signature) --

  async getOpenOrders(address: string, symbol?: string): Promise<ApiResponse<OrderData[]>> {
    const qs = symbol ? `&symbol=${symbol}` : "";
    return this.get(`/openOrders?address=${address}${qs}`);
  }

  async getPositions(address: string): Promise<ApiResponse<PositionData[]>> {
    return this.get(`/positions?address=${address}`);
  }

  async getAccountState(address: string): Promise<ApiResponse<AccountStateData>> {
    return this.get(`/accountState?address=${address}`);
  }

  async getOrderHistory(address: string, symbol?: string, limit = 50): Promise<ApiResponse<OrderData[]>> {
    const qs = symbol ? `&symbol=${symbol}` : "";
    return this.get(`/orderHistory?address=${address}&limit=${limit}${qs}`);
  }

  // -- Trading (EIP-712 signed) --

  /** Place one or more orders */
  async placeOrders(accountID: number, symbolID: number, orders: PerpsOrderItem[]): Promise<ApiResponse<null>> {
    const params = { accountID, symbolID, orders };
    return this.signedPost("/order", { type: "newOrder", params });
  }

  /** Cancel one or more orders */
  async cancelOrders(accountID: number, cancels: { symbolID: number; orderID?: number; clOrdID?: string }[]): Promise<ApiResponse<null>> {
    const params = { accountID, cancels };
    return this.signedPost("/cancel", { type: "cancelOrder", params });
  }

  /** Replace orders (atomic cancel + place) */
  async replaceOrders(accountID: number, orders: {
    symbolID: number;
    clOrdID: string;
    origOrderID?: number;
    origClOrdID?: string;
    price?: string;
    quantity?: string;
  }[]): Promise<ApiResponse<null>> {
    const params = { accountID, orders };
    return this.signedPost("/replace", { type: "replaceOrder", params });
  }

  /** Schedule auto-cancel at timestamp (heartbeat protection) */
  async scheduleCancel(accountID: number, scheduledTimestamp?: number): Promise<ApiResponse<null>> {
    const params = scheduledTimestamp
      ? { accountID, scheduledTimestamp }
      : { accountID };
    return this.signedPost("/scheduleCancel", { type: "scheduleCancel", params });
  }

  /** Update leverage for a symbol */
  async updateLeverage(accountID: number, symbolID: number, leverage: number, marginMode = MarginMode.CROSS): Promise<ApiResponse<null>> {
    const params = { accountID, symbolID, leverage, marginMode };
    return this.signedPost("/leverage", { type: "updateLeverage", params });
  }

  // -- Helpers --

  /** Create a standard limit post-only order */
  static makeOrder(clOrdID: string, side: number, price: string, quantity: string): PerpsOrderItem {
    return {
      clOrdID,
      modifier: OrderModifier.NORMAL,
      side,
      type: OrderType.LIMIT,
      timeInForce: TimeInForce.GTX, // Post-only
      price,
      quantity,
      reduceOnly: false,
      positionSide: PositionSide.BOTH,
    };
  }

  private async get<T>(path: string): Promise<ApiResponse<T>> {
    const resp = await fetch(`${this.endpoint}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
    });
    return resp.json() as Promise<ApiResponse<T>>;
  }

  private async signedPost<T>(path: string, payload: { type: string; params: object }): Promise<ApiResponse<T>> {
    const { signature, nonce } = await this.signer.signAction(payload);

    const resp = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": this.apiKeyName,
        "X-API-Sign": signature,
        "X-API-Nonce": nonce.toString(),
      },
      body: JSON.stringify(payload.params), // Note: only params, not full payload
      signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
    });
    return resp.json() as Promise<ApiResponse<T>>;
  }
}

// --- WebSocket Client ---

interface WsBookData {
  s: string;                   // symbol
  u: number;                   // update ID
  E: number;                   // event time (ms)
  b: [string, string][];      // bids [price, qty]
  a: [string, string][];      // asks [price, qty]
}

interface WsTradeData {
  E: number;                   // event time
  s: string;                   // symbol
  i: number;                   // order ID
  c: string;                   // client order ID
  S: string;                   // side "BUY" | "SELL"
  p: string;                   // price
  q: string;                   // quantity
  f: string;                   // fee
  m: boolean;                  // is maker
}

interface WsOrderUpdate {
  E: number;                   // event time
  s: string;                   // symbol
  i: number;                   // order ID
  c: string;                   // client order ID
  S: string;                   // side
  o: string;                   // order type
  p: string;                   // price
  q: string;                   // quantity
  X: string;                   // status: NEW | PARTIALLY_FILLED | FILLED | CANCELED
  x: string;                   // execution type: NEW | TRADE | CANCELED | REPLACED
}

interface WsMarkPrice {
  s: string;                   // symbol
  p: string;                   // mark price
  i: string;                   // index price
  r: string;                   // funding rate
  T: number;                   // next funding time
}

type WsHandler = {
  l2Book?: (data: WsBookData) => void;
  accountTrade?: (data: WsTradeData[]) => void;
  accountOrderUpdate?: (data: WsOrderUpdate[]) => void;
  markPrice?: (data: WsMarkPrice[]) => void;
  connected?: () => void;
  disconnected?: () => void;
};

class SodexWebSocket {
  private ws: WebSocket | null = null;
  private endpoint: string;
  private masterAddress: string;
  private symbols: string[];
  private tickSizes: Record<string, string>;
  private handlers: WsHandler;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(
    endpoint: string,
    masterAddress: string,
    symbols: string[],
    tickSizes: Record<string, string>,
    handlers: WsHandler,
  ) {
    this.endpoint = endpoint;
    this.masterAddress = masterAddress;
    this.symbols = symbols;
    this.tickSizes = tickSizes;
    this.handlers = handlers;
  }

  connect(): void {
    this.ws = new WebSocket(this.endpoint);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.subscribe();
      this.startPing();
      this.handlers.connected?.();
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.op === "pong") {
        if (this.pongTimeout) clearTimeout(this.pongTimeout);
        return;
      }
      this.dispatch(msg);
    };

    this.ws.onclose = () => {
      this.stopPing();
      this.handlers.disconnected?.();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  close(): void {
    this.reconnectAttempt = -1; // Prevent reconnect
    this.stopPing();
    this.ws?.close();
  }

  private subscribe(): void {
    // L2 orderbook per symbol
    for (const symbol of this.symbols) {
      this.send({ op: "subscribe", params: { channel: "l2Book", symbol, tickSize: this.tickSizes[symbol] || "0.1" } });
    }
    // Mark prices
    this.send({ op: "subscribe", params: { channel: "markPrice", symbols: this.symbols } });
    // Account channels
    this.send({ op: "subscribe", params: { channel: "accountTrade", user: this.masterAddress, symbols: this.symbols } });
    this.send({ op: "subscribe", params: { channel: "accountOrderUpdate", user: this.masterAddress, symbols: this.symbols } });
    this.send({ op: "subscribe", params: { channel: "accountUpdate", user: this.masterAddress } });
  }

  private dispatch(msg: any): void {
    const channel = msg.channel as string;
    const data = msg.data;
    if (!channel || !data) return;

    switch (channel) {
      case "l2Book":
        this.handlers.l2Book?.(data);
        break;
      case "accountTrade":
        this.handlers.accountTrade?.(Array.isArray(data) ? data : [data]);
        break;
      case "accountOrderUpdate":
        this.handlers.accountOrderUpdate?.(Array.isArray(data) ? data : [data]);
        break;
      case "markPrice":
        this.handlers.markPrice?.(Array.isArray(data) ? data : [data]);
        break;
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ op: "ping" });
      this.pongTimeout = setTimeout(() => {
        console.warn("[ws] Pong timeout, reconnecting...");
        this.ws?.close();
      }, 10_000);
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimeout) clearTimeout(this.pongTimeout);
    this.pingTimer = null;
    this.pongTimeout = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt < 0) return; // close() was called
    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 30_000);
    console.log(`[ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    setTimeout(() => this.connect(), delay);
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

// ═══ 3. Usage Examples ═══

async function example_marketData(client: SodexClient) {
  console.log("\n--- Market Data ---");

  // Tickers
  const tickers = await client.getTickers("ETH-USD");
  if (tickers.code === 0 && tickers.data) {
    const t = tickers.data[0];
    console.log(`ETH-USD: last=${t.lastPrice} bid=${t.bestBidPrice} ask=${t.bestAskPrice} vol=${t.volume24h}`);
  }

  // Symbol metadata (needed for price/qty formatting)
  const symbols = await client.getSymbols("ETH-USD");
  if (symbols.code === 0 && symbols.data) {
    const s = symbols.data[0];
    console.log(`ETH-USD: symbolID=${s.symbolID} tickSize=${s.tickSize} pricePrecision=${s.pricePrecision}`);
  }

  // Orderbook
  const ob = await client.getOrderbook("ETH-USD", 5);
  if (ob.code === 0 && ob.data) {
    console.log(`Orderbook: ${ob.data.bids.length} bids, ${ob.data.asks.length} asks`);
    console.log(`  Best bid: ${ob.data.bids[0]?.[0]} @ ${ob.data.bids[0]?.[1]}`);
    console.log(`  Best ask: ${ob.data.asks[0]?.[0]} @ ${ob.data.asks[0]?.[1]}`);
  }

  // Mark prices + funding
  const marks = await client.getMarkPrices("ETH-USD");
  if (marks.code === 0 && marks.data?.[0]) {
    console.log(`Mark: ${marks.data[0].markPrice} Funding: ${marks.data[0].fundingRate}`);
  }
}

async function example_accountQueries(client: SodexClient, address: string) {
  console.log("\n--- Account Data ---");

  const state = await client.getAccountState(address);
  if (state.code === 0 && state.data) {
    console.log(`Account #${state.data.accountID}: balance=${state.data.totalBalance} available=${state.data.availableBalance}`);
  }

  const positions = await client.getPositions(address);
  if (positions.code === 0 && positions.data) {
    for (const p of positions.data) {
      console.log(`Position ${p.symbol}: size=${p.size} entry=${p.entryPrice} pnl=${p.unrealizedPnl}`);
    }
  }

  const orders = await client.getOpenOrders(address);
  if (orders.code === 0 && orders.data) {
    console.log(`Open orders: ${orders.data.length}`);
    for (const o of orders.data.slice(0, 3)) {
      console.log(`  #${o.orderID} ${o.side === 1 ? "BUY" : "SELL"} ${o.price} x ${o.quantity} [${o.status}]`);
    }
  }
}

async function example_tradingFlow(client: SodexClient, address: string) {
  console.log("\n--- Trading Flow ---");

  // 1. Get account ID and symbol ID
  const stateResp = await client.getAccountState(address);
  if (stateResp.code !== 0 || !stateResp.data) {
    console.error("Failed to get account state:", stateResp.error);
    return;
  }
  const accountID = stateResp.data.accountID;

  const symbolsResp = await client.getSymbols("ETH-USD");
  if (symbolsResp.code !== 0 || !symbolsResp.data?.[0]) {
    console.error("Failed to get symbol info:", symbolsResp.error);
    return;
  }
  const symbolID = symbolsResp.data[0].symbolID;

  // 2. Place a limit buy order (post-only)
  const clOrdID = `EXAMPLE-BUY-${Date.now()}`;
  const order = SodexClient.makeOrder(clOrdID, Side.BUY, "2000.0", "0.01");

  console.log(`Placing order: ${clOrdID} BUY 0.01 ETH @ 2000.0`);
  const placeRes = await client.placeOrders(accountID, symbolID, [order]);
  if (placeRes.code !== 0) {
    console.error("Place failed:", placeRes.error);
    return;
  }
  console.log("Order placed successfully");

  // 3. Replace the order (change price)
  const newClOrdID = `EXAMPLE-BUY-${Date.now()}`;
  console.log(`Replacing order: ${clOrdID} → ${newClOrdID} @ 1999.0`);
  const replaceRes = await client.replaceOrders(accountID, [{
    symbolID,
    clOrdID: newClOrdID,
    origClOrdID: clOrdID,
    price: "1999.0",
    quantity: "0.01",
  }]);
  if (replaceRes.code !== 0) {
    console.error("Replace failed, falling back to cancel + place:", replaceRes.error);
    // Fallback: cancel original, then place new
    await client.cancelOrders(accountID, [{ symbolID, clOrdID }]);
    await client.placeOrders(accountID, symbolID, [
      SodexClient.makeOrder(newClOrdID, Side.BUY, "1999.0", "0.01"),
    ]);
  }

  // 4. Cancel the order
  console.log(`Canceling order: ${newClOrdID}`);
  const cancelRes = await client.cancelOrders(accountID, [{ symbolID, clOrdID: newClOrdID }]);
  console.log(`Cancel result: code=${cancelRes.code}`);

  // 5. Schedule cancel heartbeat (auto-cancel in 5 min if client dies)
  const expiryMs = Date.now() + 5 * 60 * 1000;
  console.log(`Setting schedule cancel: ${new Date(expiryMs).toISOString()}`);
  await client.scheduleCancel(accountID, expiryMs);

  // 6. Clear schedule cancel
  await client.scheduleCancel(accountID);
  console.log("Schedule cancel cleared");
}

async function example_websocket() {
  console.log("\n--- WebSocket ---");

  if (!CONFIG.privateKey) {
    console.log("Skipping WebSocket example (no SODEX_PRIVATE_KEY)");
    return;
  }

  const signer = new SodexSigner(CONFIG.privateKey, CONFIG.chainId);

  const ws = new SodexWebSocket(
    CONFIG.wsEndpoint,
    signer.address,
    ["ETH-USD"],
    { "ETH-USD": "0.1" },
    {
      connected: () => console.log("[ws] Connected, subscriptions sent"),
      disconnected: () => console.log("[ws] Disconnected"),
      l2Book: (data) => {
        console.log(`[ws] L2Book ${data.s}: ${data.b.length} bids, ${data.a.length} asks`);
        console.log(`  Best bid: ${data.b[0]?.[0]} Best ask: ${data.a[0]?.[0]}`);
      },
      accountTrade: (trades) => {
        for (const t of trades) {
          console.log(`[ws] Trade: ${t.S} ${t.q} ${t.s} @ ${t.p} (maker=${t.m})`);
        }
      },
      accountOrderUpdate: (updates) => {
        for (const u of updates) {
          console.log(`[ws] Order #${u.i}: ${u.X} (${u.x}) ${u.S} ${u.q} @ ${u.p}`);
        }
      },
      markPrice: (prices) => {
        for (const p of prices) {
          console.log(`[ws] Mark ${p.s}: ${parseFloat(p.p).toFixed(2)} funding=${p.r}`);
        }
      },
    },
  );

  ws.connect();

  // Run for 10 seconds then close
  await new Promise(r => setTimeout(r, 10_000));
  ws.close();
  console.log("[ws] Closed");
}

// ═══ 4. Main (直接运行验证) ═══

async function main() {
  console.log("=== SODEX API Integration Example ===");
  console.log(`Endpoint: ${CONFIG.restEndpoint}`);
  console.log(`Chain ID: ${CONFIG.chainId}`);

  if (!CONFIG.privateKey) {
    console.log("\nNo SODEX_PRIVATE_KEY set — running market data examples only (no signing)\n");

    // Market data works without auth
    const dummySigner = { address: "0x0000000000000000000000000000000000000000" } as SodexSigner;
    const client = new SodexClient(CONFIG.restEndpoint, dummySigner, "");
    await example_marketData(client);
    return;
  }

  const signer = new SodexSigner(CONFIG.privateKey, CONFIG.chainId);
  const client = new SodexClient(CONFIG.restEndpoint, signer, CONFIG.apiKeyName);
  console.log(`Address: ${signer.address}`);

  await example_marketData(client);
  await example_accountQueries(client, signer.address);
  await example_tradingFlow(client, signer.address);
  await example_websocket();

  console.log("\n=== Done ===");
}

main().catch(console.error);
