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
  chainId: parseInt(process.env.SODEX_CHAIN_ID || "138565"), // testnet=138565, mainnet=286623
  privateKey: process.env.SODEX_PRIVATE_KEY || "",
  apiKeyName: process.env.SODEX_API_KEY_NAME || "",
  requestTimeoutMs: 8_000,
};

// ═══ 2. Types & Core Implementation ═══

// --- Enums ---

const Side = { BUY: 1, SELL: 2 } as const;
const OrderType = { LIMIT: 1, MARKET: 2 } as const;
const TimeInForce = { GTC: 1, FOK: 2, IOC: 3, GTX: 4 } as const; // GTX = Post-Only
const OrderModifier = { NORMAL: 1, STOP: 2, BRACKET: 3, ATTACHED_STOP: 4 } as const;
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
  lastPx: string;           // last traded price
  bidPx: string;             // best bid
  askPx: string;             // best ask
  bidSz: string;             // best bid size
  askSz: string;             // best ask size
  volume: string;            // base volume 24h
  quoteVolume: string;       // quote volume 24h
  changePct: number;         // 24h change percent
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  openInterest: string;
}

interface SymbolData {
  id: number;                // symbol ID (use this for trading)
  name: string;              // e.g. "ETH-USD"
  displayName: string;
  baseCoin: string;
  quoteCoin: string;
  tickSize: string;
  stepSize: string;
  pricePrecision: number;
  quantityPrecision: number;
  minNotional: string;
  maxLeverage: number;
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
  modifier: number;      // OrderModifier enum
  side: number;           // Side enum
  type: number;           // OrderType enum
  timeInForce: number;    // TimeInForce enum
  price?: string;         // DecimalString, required for LIMIT
  quantity?: string;      // DecimalString, required if not using funds
  funds?: string;         // Alternative to quantity (market orders)
  stopPrice?: string;     // For STOP/BRACKET orders
  stopType?: number;      // Stop trigger type
  triggerType?: number;   // Trigger price source
  reduceOnly: boolean;
  positionSide: number;   // PositionSide enum
}

interface PerpsCancelItem {
  symbolID: number;
  orderID?: number;
  clOrdID?: string;
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
   *
   * Signing payload = Keccak256(JSON.stringify({ type, params }))
   * Returns signature with 0x01 prefix + nonce
   */
  async signAction(payload: { type: string; params: object }): Promise<{ signature: string; nonce: bigint }> {
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
  // Path pattern: /markets/{resource}

  async getTickers(symbol?: string): Promise<ApiResponse<TickerData[]>> {
    return this.publicGet("/markets/tickers", symbol ? { symbol } : undefined);
  }

  async getSymbols(symbol?: string): Promise<ApiResponse<SymbolData[]>> {
    return this.publicGet("/markets/symbols", symbol ? { symbol } : undefined);
  }

  async getMarkPrices(symbol?: string): Promise<ApiResponse<any[]>> {
    return this.publicGet("/markets/mark-prices", symbol ? { symbol } : undefined);
  }

  async getOrderbook(symbol: string, limit = 10): Promise<ApiResponse<OrderbookData>> {
    return this.publicGet(`/markets/${symbol}/orderbook`, { limit: limit.toString() });
  }

  // -- Account Queries (address in path, no signature) --
  // Path pattern: /accounts/{address}/{resource}

  async getOpenOrders(address: string, symbol?: string, accountID?: number): Promise<ApiResponse<OrderData[]>> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    if (accountID) params.accountID = accountID.toString();
    return this.publicGet(`/accounts/${address}/orders`, params);
  }

  async getPositions(address: string, accountID?: number): Promise<ApiResponse<PositionData[]>> {
    const params: Record<string, string> = {};
    if (accountID) params.accountID = accountID.toString();
    return this.publicGet(`/accounts/${address}/positions`, params);
  }

  async getAccountState(address: string, accountID?: number): Promise<ApiResponse<AccountStateData>> {
    const params: Record<string, string> = {};
    if (accountID) params.accountID = accountID.toString();
    return this.publicGet(`/accounts/${address}/state`, params);
  }

  async getOrderHistory(address: string, symbol?: string, limit = 50): Promise<ApiResponse<OrderData[]>> {
    const params: Record<string, string> = { limit: limit.toString() };
    if (symbol) params.symbol = symbol;
    return this.publicGet(`/accounts/${address}/orders/history`, params);
  }

  // -- Trading (EIP-712 signed) --
  // Path pattern: /trade/{resource}

  /** Place one or more orders */
  async placeOrders(accountID: number, symbolID: number, orders: PerpsOrderItem[]): Promise<ApiResponse<null>> {
    const params = { accountID, symbolID, orders };
    return this.signedRequest("POST", "/trade/orders", "newOrder", params);
  }

  /** Cancel one or more orders (NOTE: uses DELETE method) */
  async cancelOrders(accountID: number, cancels: PerpsCancelItem[]): Promise<ApiResponse<null>> {
    const params = { accountID, cancels };
    return this.signedRequest("DELETE", "/trade/orders", "cancelOrder", params);
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
    return this.signedRequest("POST", "/trade/orders/replace", "replaceOrder", params);
  }

  /** Schedule auto-cancel at timestamp (heartbeat protection) */
  async scheduleCancel(accountID: number, scheduledTimestamp?: number): Promise<ApiResponse<null>> {
    const params: { accountID: number; scheduledTimestamp?: number } = { accountID };
    if (scheduledTimestamp !== undefined) params.scheduledTimestamp = scheduledTimestamp;
    return this.signedRequest("POST", "/trade/orders/schedule-cancel", "scheduleCancel", params);
  }

  /** Update leverage for a symbol */
  async updateLeverage(accountID: number, symbolID: number, leverage: number, marginMode = MarginMode.CROSS): Promise<ApiResponse<null>> {
    const params = { accountID, symbolID, leverage, marginMode };
    return this.signedRequest("POST", "/trade/leverage", "updateLeverage", params);
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

  private async publicGet<T>(path: string, params?: Record<string, string>): Promise<ApiResponse<T>> {
    const url = new URL(`${this.endpoint}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const resp = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
    });
    return resp.json() as Promise<ApiResponse<T>>;
  }

  /**
   * Signed request for trading operations.
   *
   * CRITICAL: Signing payload is { type, params } but HTTP body is params only.
   */
  private async signedRequest<T>(
    method: string,
    path: string,
    actionType: string,
    params: object,
  ): Promise<ApiResponse<T>> {
    // Sign the FULL payload { type, params }
    const signingPayload = { type: actionType, params };
    const { signature, nonce } = await this.signer.signAction(signingPayload);

    // Send only params as body (not the full {type, params})
    const resp = await fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": this.apiKeyName,
        "X-API-Sign": signature,
        "X-API-Nonce": nonce.toString(),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
    });
    return resp.json() as Promise<ApiResponse<T>>;
  }
}

// --- WebSocket Client ---
// NOTE: Uses Bun's built-in WebSocket (browser-compatible API: onopen/onmessage/onclose).
// For Node.js, use `import WebSocket from "ws"` with `ws.on("open", ...)` event style instead.

interface WsBookData {
  s: string;                   // symbol
  u: number;                   // update ID
  E: number;                   // event time (ms)
  b: [string, string][];      // bids [price, qty]
  a: [string, string][];      // asks [price, qty]
}

interface WsTradeData {
  E: number; s: string; i: number; c: string;
  S: string; p: string; q: string; f: string; m: boolean;
}

interface WsOrderUpdate {
  E: number; s: string; i: number; c: string;
  S: string; o: string; p: string; q: string;
  X: string; x: string; // X=status, x=execution type
}

interface WsMarkPrice {
  s: string; p: string; i: string; r: string; T: number;
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

  constructor(endpoint: string, masterAddress: string, symbols: string[],
    tickSizes: Record<string, string>, handlers: WsHandler) {
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
      if (msg.op === "pong") { if (this.pongTimeout) clearTimeout(this.pongTimeout); return; }
      this.dispatch(msg);
    };
    this.ws.onclose = () => { this.stopPing(); this.handlers.disconnected?.(); this.scheduleReconnect(); };
    this.ws.onerror = () => { this.ws?.close(); };
  }

  close(): void {
    this.reconnectAttempt = -1;
    this.stopPing();
    this.ws?.close();
  }

  private subscribe(): void {
    for (const symbol of this.symbols) {
      this.send({ op: "subscribe", params: { channel: "l2Book", symbol, tickSize: this.tickSizes[symbol] || "0.1" } });
    }
    this.send({ op: "subscribe", params: { channel: "markPrice", symbols: this.symbols } });
    this.send({ op: "subscribe", params: { channel: "accountTrade", user: this.masterAddress, symbols: this.symbols } });
    this.send({ op: "subscribe", params: { channel: "accountOrderUpdate", user: this.masterAddress, symbols: this.symbols } });
    this.send({ op: "subscribe", params: { channel: "accountUpdate", user: this.masterAddress } });
  }

  private dispatch(msg: { channel?: string; data?: any }): void {
    const { channel, data } = msg;
    if (!channel || !data) return;
    switch (channel) {
      case "l2Book": this.handlers.l2Book?.(data); break;
      case "accountTrade": this.handlers.accountTrade?.(Array.isArray(data) ? data : [data]); break;
      case "accountOrderUpdate": this.handlers.accountOrderUpdate?.(Array.isArray(data) ? data : [data]); break;
      case "markPrice": this.handlers.markPrice?.(Array.isArray(data) ? data : [data]); break;
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      this.send({ op: "ping" });
      this.pongTimeout = setTimeout(() => { this.ws?.close(); }, 10_000);
    }, 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimeout) clearTimeout(this.pongTimeout);
    this.pingTimer = null; this.pongTimeout = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt < 0) return;
    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 30_000);
    setTimeout(() => this.connect(), delay);
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

// ═══ 3. Usage Examples ═══

async function example_marketData(client: SodexClient) {
  console.log("\n--- Market Data ---");

  const tickers = await client.getTickers("ETH-USD");
  if (tickers.code === 0 && tickers.data?.[0]) {
    const t = tickers.data[0];
    console.log(`ETH-USD: last=${t.lastPx} bid=${t.bidPx} ask=${t.askPx} vol=${t.volume} funding=${t.fundingRate}`);
  } else {
    console.log(`getTickers: code=${tickers.code} error=${tickers.error}`);
  }

  // Symbol metadata — needed for symbolID, tickSize, precision
  const symbols = await client.getSymbols("ETH-USD");
  if (symbols.code === 0 && symbols.data?.[0]) {
    const s = symbols.data[0];
    console.log(`Symbol: id=${s.id} tick=${s.tickSize} step=${s.stepSize} pricePrecision=${s.pricePrecision} maxLeverage=${s.maxLeverage}`);
  }

  const ob = await client.getOrderbook("ETH-USD", 5);
  if (ob.code === 0 && ob.data) {
    console.log(`Orderbook: best bid=${ob.data.bids[0]?.[0]} best ask=${ob.data.asks[0]?.[0]}`);
  }

  const marks = await client.getMarkPrices("ETH-USD") as ApiResponse<{ symbol: string; markPrice: string; indexPrice: string; fundingRate: string }[]>;
  if (marks.code === 0 && marks.data?.[0]) {
    const m = marks.data[0];
    console.log(`Mark: ${m.markPrice} Index: ${m.indexPrice} Funding: ${m.fundingRate}`);
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
    if (positions.data.length === 0) console.log("No open positions");
  }

  const orders = await client.getOpenOrders(address);
  if (orders.code === 0 && orders.data) {
    console.log(`Open orders: ${orders.data.length}`);
    for (const o of orders.data.slice(0, 3)) {
      console.log(`  #${o.orderID} ${o.side === 1 ? "BUY" : "SELL"} ${o.price} x ${o.quantity}`);
    }
  }
}

async function example_tradingFlow(client: SodexClient, address: string) {
  console.log("\n--- Trading Flow ---");

  // 1. Get account ID and symbol ID
  const stateResp = await client.getAccountState(address);
  if (stateResp.code !== 0 || !stateResp.data) {
    console.error("Failed to get account state:", stateResp.error); return;
  }
  const accountID = stateResp.data.accountID;

  const symbolsResp = await client.getSymbols("ETH-USD");
  if (symbolsResp.code !== 0 || !symbolsResp.data?.[0]) {
    console.error("Failed to get symbol info:", symbolsResp.error); return;
  }
  const symbolID = symbolsResp.data[0].id;

  // 2. Place a limit buy order (post-only, far from market to avoid fill)
  const clOrdID = `EXAMPLE-BUY-${Date.now()}`;
  const order = SodexClient.makeOrder(clOrdID, Side.BUY, "1000.0", "0.01");

  console.log(`Placing order: BUY 0.01 ETH @ 1000.0 (clOrdID=${clOrdID})`);
  const placeRes = await client.placeOrders(accountID, symbolID, [order]);
  if (placeRes.code !== 0) { console.error("Place failed:", placeRes.error); return; }
  console.log("Order placed");

  // 3. Replace the order (change price)
  const newClOrdID = `EXAMPLE-BUY-${Date.now()}`;
  console.log(`Replacing: ${clOrdID} → ${newClOrdID} @ 999.0`);
  const replaceRes = await client.replaceOrders(accountID, [{
    symbolID, clOrdID: newClOrdID, origClOrdID: clOrdID, price: "999.0", quantity: "0.01",
  }]);
  if (replaceRes.code !== 0) {
    // Replace failed — fallback to cancel + place
    console.warn("Replace failed, falling back to cancel + place:", replaceRes.error);
    await client.cancelOrders(accountID, [{ symbolID, clOrdID }]);
    await client.placeOrders(accountID, symbolID, [
      SodexClient.makeOrder(newClOrdID, Side.BUY, "999.0", "0.01"),
    ]);
  }

  // 4. Cancel the order
  const cancelRes = await client.cancelOrders(accountID, [{ symbolID, clOrdID: newClOrdID }]);
  console.log(`Cancel: code=${cancelRes.code}`);

  // 5. Schedule cancel heartbeat (auto-cancel in 5 min)
  await client.scheduleCancel(accountID, Date.now() + 5 * 60_000);
  console.log("Schedule cancel set (5 min)");

  // 6. Clear schedule cancel
  await client.scheduleCancel(accountID);
  console.log("Schedule cancel cleared");
}

async function example_websocket(signer: SodexSigner) {
  console.log("\n--- WebSocket (10s) ---");

  const ws = new SodexWebSocket(CONFIG.wsEndpoint, signer.address, ["ETH-USD"],
    { "ETH-USD": "0.1" }, {
      connected: () => console.log("[ws] Connected"),
      disconnected: () => console.log("[ws] Disconnected"),
      l2Book: (d) => console.log(`[ws] Book ${d.s}: ${d.b.length} bids, ${d.a.length} asks, best=${d.b[0]?.[0]}/${d.a[0]?.[0]}`),
      accountTrade: (ts) => ts.forEach(t => console.log(`[ws] Fill: ${t.S} ${t.q} ${t.s} @ ${t.p}`)),
      accountOrderUpdate: (us) => us.forEach(u => console.log(`[ws] Order #${u.i}: ${u.X} ${u.S} ${u.q} @ ${u.p}`)),
      markPrice: (ps) => ps.forEach(p => console.log(`[ws] Mark ${p.s}: ${parseFloat(p.p).toFixed(2)}`)),
    });

  ws.connect();
  await new Promise(r => setTimeout(r, 10_000));
  ws.close();
}

// ═══ 4. Main (直接运行验证) ═══

async function main() {
  console.log("=== SODEX API Example ===");
  console.log(`Endpoint: ${CONFIG.restEndpoint}`);

  if (!CONFIG.privateKey) {
    console.log("No SODEX_PRIVATE_KEY — market data only\n");
    // Market data works without auth, use dummy signer
    const client = new SodexClient(CONFIG.restEndpoint, {} as SodexSigner, "");
    await example_marketData(client);
    return;
  }

  const signer = new SodexSigner(CONFIG.privateKey, CONFIG.chainId);
  const client = new SodexClient(CONFIG.restEndpoint, signer, CONFIG.apiKeyName);
  console.log(`Address: ${signer.address}\n`);

  await example_marketData(client);
  await example_accountQueries(client, signer.address);
  await example_tradingFlow(client, signer.address);
  await example_websocket(signer);

  console.log("\n=== Done ===");
}

main().catch(console.error);
