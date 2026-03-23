/**
 * @reference apis/sodex-api-key
 * @description SODEX API Key 完整生命周期: 生成密钥对 → 注册 → 验证 → 使用交易
 * @prerequisites bun, ethers@6
 * @env SODEX_MASTER_PRIVATE_KEY (主账户私钥，用于签名注册)
 * @runnable bun run apis/sodex-api-key-example.ts
 * @verified 2026-03-24
 */

import { Wallet, ethers } from "ethers";

// ═══ 1. Setup & Config ═══

const CONFIG = {
  network: (process.env.SODEX_NETWORK || "testnet") as "testnet" | "mainnet",
  masterPrivateKey: process.env.SODEX_MASTER_PRIVATE_KEY || "",
  // Derived
  get chainId() { return this.network === "mainnet" ? 286623 : 138565; },
  get perpsEndpoint() { return `https://${this.network === "mainnet" ? "mainnet" : "testnet"}-gw.sodex.dev/api/v1/perps`; },
  get spotEndpoint() { return `https://${this.network === "mainnet" ? "mainnet" : "testnet"}-gw.sodex.dev/api/v1/spot`; },
};

// ═══ 2. Types & Core Implementation ═══

interface ApiResponse<T = unknown> {
  code: number;
  timestamp: number;
  error?: string;
  data?: T;
}

/**
 * Step 1: Generate a new API Key keypair.
 * The address becomes the API Key, the private key is the API Secret.
 */
function generateApiKeyPair(): { address: string; privateKey: string } {
  const wallet = Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

/**
 * Step 2: Sign the AddAPIKey request with the MASTER account's private key.
 *
 * CRITICAL differences from trading signatures:
 * - domain.name = "universal" (not "futures" or "spot")
 * - Signature prefix = 0x02 (not 0x01)
 * - EIP-712 message field = "keyType", REST body field = "type"
 * - Must sign with MASTER private key (not the API key's private key)
 */
async function signAddApiKey(
  masterPrivateKey: string,
  params: {
    accountID: number;
    name: string;
    publicKey: string;  // The API key address
    expiresAt: number;  // ms timestamp, 0 = never
  },
  chainId: number,
): Promise<{ signature: string; nonce: number }> {
  const masterWallet = new Wallet(masterPrivateKey);
  const nonce = Date.now();

  const domain = {
    name: "universal",  // NOT "futures" or "spot"
    version: "1",
    chainId,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };

  const types = {
    AddAPIKey: [
      { name: "accountID", type: "uint64" },
      { name: "name", type: "string" },
      { name: "keyType", type: "uint8" },   // EIP-712 uses "keyType"
      { name: "publicKey", type: "bytes" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "uint64" },
    ],
  };

  const message = {
    accountID: params.accountID,
    name: params.name,
    keyType: 1,                // 1 = EVM
    publicKey: params.publicKey,
    expiresAt: params.expiresAt,
    nonce,
  };

  const sig = await masterWallet.signTypedData(domain, types, message);

  // Convert v from 27/28 to 0/1
  const vByte = parseInt(sig.slice(-2), 16);
  const v01 = (vByte >= 27 ? vByte - 27 : vByte).toString(16).padStart(2, "0");
  const sigV01 = sig.slice(0, -2) + v01;

  // Prepend 0x02 for AddAPIKey (not 0x01)
  return {
    signature: "0x02" + sigV01.slice(2),
    nonce,
  };
}

/**
 * Step 3: Submit the AddAPIKey request to SODEX.
 *
 * NOTE: REST body uses "type" (not "keyType"), and does NOT include "nonce".
 * NOTE: Registration requires X-API-Chain header (trading does not).
 */
async function registerApiKey(
  endpoint: string,
  params: {
    accountID: number;
    name: string;
    publicKey: string;
    expiresAt: number;
  },
  signature: string,
  nonce: number,
  chainId: number,
): Promise<ApiResponse> {
  const body = {
    accountID: params.accountID,
    name: params.name,
    type: 1,                    // REST body uses "type" (not "keyType")
    publicKey: params.publicKey,
    expiresAt: params.expiresAt,
  };

  const resp = await fetch(`${endpoint}/accounts/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-API-Sign": signature,
      "X-API-Nonce": nonce.toString(),
      "X-API-Chain": chainId.toString(),  // Registration needs this (trading doesn't)
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  return resp.json() as Promise<ApiResponse>;
}

/**
 * Step 4: Verify the API Key was registered successfully.
 */
async function queryApiKeys(
  endpoint: string,
  masterAddress: string,
  accountID?: number,
): Promise<ApiResponse<any[]>> {
  const params = new URLSearchParams();
  if (accountID) params.set("accountID", accountID.toString());
  const qs = params.toString() ? `?${params}` : "";

  const resp = await fetch(`${endpoint}/accounts/${masterAddress}/api-keys${qs}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  return resp.json() as Promise<ApiResponse<any[]>>;
}

/**
 * Get account ID from SODEX.
 */
async function getAccountID(endpoint: string, address: string): Promise<number | null> {
  try {
    const resp = await fetch(`${endpoint}/accounts/${address}/state`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json() as ApiResponse<{ aid?: number; accountID?: number }>;
    return data.data?.aid ?? data.data?.accountID ?? null;
  } catch {
    return null;
  }
}

// ═══ 3. Usage Examples ═══

/**
 * Complete flow: generate → register → verify → show .env config
 */
async function example_fullRegistrationFlow(masterPrivateKey: string) {
  const masterWallet = new Wallet(masterPrivateKey);
  const masterAddress = masterWallet.address;
  console.log(`Master address: ${masterAddress}`);
  console.log(`Network: ${CONFIG.network} (chainId: ${CONFIG.chainId})`);

  // 1. Get accountID
  console.log("\n[1/5] Getting account ID...");
  const accountID = await getAccountID(CONFIG.perpsEndpoint, masterAddress);
  if (!accountID) {
    console.error("Account not found. Activate your SODEX account first (deposit >= 1 vUSDC).");
    return;
  }
  console.log(`  Account ID: ${accountID}`);

  // 2. Generate API Key keypair
  console.log("\n[2/5] Generating API Key keypair...");
  const { address: apiKeyAddress, privateKey: apiKeyPrivateKey } = generateApiKeyPair();
  console.log(`  API Key Address:     ${apiKeyAddress}`);
  console.log(`  API Key Private Key: ${apiKeyPrivateKey}`);
  console.log(`  ⚠️  Save the private key! It cannot be recovered.`);

  // 3. Sign AddAPIKey with master account
  const keyName = `api-key-${Date.now().toString(36)}`;
  const expiresAt = Date.now() + 360 * 24 * 60 * 60 * 1000; // 360 days

  console.log(`\n[3/5] Signing AddAPIKey (name: ${keyName})...`);
  const { signature, nonce } = await signAddApiKey(
    masterPrivateKey,
    { accountID, name: keyName, publicKey: apiKeyAddress, expiresAt },
    CONFIG.chainId,
  );
  console.log(`  Signature: ${signature.slice(0, 20)}... (prefix: ${signature.slice(0, 4)})`);

  // 4. Register to Perps
  console.log("\n[4/5] Registering API Key to Perps...");
  const perpsResult = await registerApiKey(
    CONFIG.perpsEndpoint,
    { accountID, name: keyName, publicKey: apiKeyAddress, expiresAt },
    signature, nonce, CONFIG.chainId,
  );
  if (perpsResult.code === 0) {
    console.log("  Perps: ✅ Success");
  } else {
    console.error(`  Perps: ❌ Failed — ${perpsResult.error}`);
    return;
  }

  // 5. Verify registration
  console.log("\n[5/5] Verifying registration...");
  const keys = await queryApiKeys(CONFIG.perpsEndpoint, masterAddress, accountID);
  if (keys.code === 0 && keys.data) {
    const found = keys.data.find((k: any) => k.name === keyName);
    if (found) {
      console.log(`  Verified: ✅ Key "${keyName}" found`);
    } else {
      console.log(`  Keys found: ${keys.data.map((k: any) => k.name).join(", ")}`);
    }
  }

  // Output .env config
  console.log("\n" + "═".repeat(60));
  console.log("Add to your .env file:");
  console.log("═".repeat(60));
  console.log(`SODEX_API_KEY_NAME=${keyName}`);
  console.log(`SODEX_PRIVATE_KEY=${apiKeyPrivateKey}`);
  console.log(`SODEX_NETWORK=${CONFIG.network}`);
  console.log("═".repeat(60));
  console.log("\nThen use sodex-api-example.ts to start trading.");
}

/**
 * Query existing API Keys for an account.
 */
async function example_queryExistingKeys(masterPrivateKey: string) {
  const masterWallet = new Wallet(masterPrivateKey);
  const masterAddress = masterWallet.address;

  console.log("\n--- Existing API Keys ---");
  const keys = await queryApiKeys(CONFIG.perpsEndpoint, masterAddress);
  if (keys.code === 0 && keys.data) {
    if (keys.data.length === 0) {
      console.log("No API keys registered.");
    } else {
      for (const k of keys.data) {
        const expires = k.expiresAt === 0 ? "never" : new Date(k.expiresAt).toISOString();
        console.log(`  ${k.name}: address=${k.publicKey?.slice(0, 10)}... expires=${expires}`);
      }
    }
  } else {
    console.log(`Query failed: ${keys.error}`);
  }
}

// ═══ 4. Main (直接运行验证) ═══

async function main() {
  console.log("=== SODEX API Key Registration ===\n");

  if (!CONFIG.masterPrivateKey) {
    console.log("No SODEX_MASTER_PRIVATE_KEY set.\n");
    console.log("Usage:");
    console.log("  SODEX_MASTER_PRIVATE_KEY=0x... bun run apis/sodex-api-key-example.ts");
    console.log("  SODEX_MASTER_PRIVATE_KEY=0x... SODEX_NETWORK=mainnet bun run apis/sodex-api-key-example.ts");
    console.log("\nFor browser-based registration with MetaMask/WalletConnect:");
    console.log("  Open apis/sodex-api-key-ui.html in a browser");

    // Demo: show what a generated keypair looks like
    console.log("\n--- Demo: Generated Keypair ---");
    const demo = generateApiKeyPair();
    console.log(`  Address (API Key):     ${demo.address}`);
    console.log(`  Private Key (Secret):  ${demo.privateKey}`);
    return;
  }

  await example_fullRegistrationFlow(CONFIG.masterPrivateKey);
  await example_queryExistingKeys(CONFIG.masterPrivateKey);

  console.log("\n=== Done ===");
}

main().catch(console.error);
