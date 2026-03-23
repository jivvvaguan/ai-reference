/**
 * @reference apis/sodex-db
 * @description SODEX Analytics 数据库查询示例: StarRocks 连接 + 交易/留存/积分常用查询
 * @prerequisites bun, mysql2
 * @env STARROCKS_HOST, STARROCKS_USER, STARROCKS_PASSWORD
 * @runnable bun run apis/sodex-db-example.ts
 * @verified 2026-03-24
 */

import mysql from "mysql2/promise";

// ═══ 1. Setup & Config ═══

const CONFIG = {
  host: process.env.STARROCKS_HOST || "warehouse-analysis.valuechain.xyz",
  port: parseInt(process.env.STARROCKS_PORT || "9030"),
  user: process.env.STARROCKS_USER || "",
  password: process.env.STARROCKS_PASSWORD || "",
  database: process.env.STARROCKS_DATABASE || "mainnet_lens",
  connectionLimit: 10,
  waitForConnections: true,
  dateStrings: true,           // Return dates as strings, not Date objects
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
};

// ═══ 2. Types & Core Implementation ═══

// --- StarRocks does NOT support prepared statements ---
// Use mysql.format() for parameter interpolation instead of ? placeholders in pool.query()

let pool: mysql.Pool;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool(CONFIG);
  }
  return pool;
}

/** Standard query — returns rows */
async function query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const formatted = params ? mysql.format(sql, params) : sql;
  const [rows] = await getPool().query(formatted);
  return rows as T[];
}

/** Single row query */
async function queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Execute DML (INSERT/UPDATE/DELETE) — uses pool.query(), NOT pool.execute() */
async function execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }> {
  const formatted = params ? mysql.format(sql, params) : sql;
  // CRITICAL: Must use query(), not execute(). StarRocks doesn't support COM_STMT_PREPARE.
  const [result] = await getPool().query(formatted);
  return { affectedRows: (result as any).affectedRows ?? 0 };
}

/** Query with extended planner timeout (for complex queries with many CTEs) */
async function queryWithPlannerTimeout<T = Record<string, unknown>>(
  sql: string, params?: unknown[], timeoutMs = 10000
): Promise<T[]> {
  const conn = await getPool().getConnection();
  try {
    await conn.query(`SET new_planner_optimize_timeout = ${timeoutMs}`);
    const formatted = params ? mysql.format(sql, params) : sql;
    const [rows] = await conn.query(formatted);
    return rows as T[];
  } finally {
    conn.release();
  }
}

/** Run multiple SELECTs on one connection with extended planner timeout */
async function queryBatchWithPlannerTimeout<T = Record<string, unknown>>(
  sqls: { sql: string; params?: unknown[] }[], timeoutMs = 10000
): Promise<T[][]> {
  const conn = await getPool().getConnection();
  try {
    await conn.query(`SET new_planner_optimize_timeout = ${timeoutMs}`);
    const results: T[][] = [];
    for (const { sql, params } of sqls) {
      const formatted = params ? mysql.format(sql, params) : sql;
      const [rows] = await conn.query(formatted);
      results.push(rows as T[]);
    }
    return results;
  } finally {
    conn.release();
  }
}

/** Long-running SELECT with extended query_timeout (default 600s) */
async function queryLong<T = Record<string, unknown>>(
  sql: string, params?: unknown[], timeoutSec = 600
): Promise<T[]> {
  const conn = await getPool().getConnection();
  try {
    await conn.query(`SET query_timeout = ${timeoutSec}`);
    const formatted = params ? mysql.format(sql, params) : sql;
    const [rows] = await conn.query(formatted);
    return rows as T[];
  } finally {
    conn.release();
  }
}

/** Long-running DML with extended query_timeout (for INSERT...SELECT across large tables) */
async function executeLong(sql: string, params?: unknown[], timeoutSec = 600): Promise<{ affectedRows: number }> {
  const conn = await getPool().getConnection();
  try {
    await conn.query(`SET query_timeout = ${timeoutSec}`);
    const formatted = params ? mysql.format(sql, params) : sql;
    const [result] = await conn.query(formatted);
    return { affectedRows: (result as any).affectedRows ?? 0 };
  } finally {
    conn.release();
  }
}

// --- Exclusion helper (must apply to almost every user query) ---
// NOTE: This is a static SQL fragment (no user input), safe to concatenate.
// Do NOT put user-supplied values in SQL fragments — always use mysql.format().

const EXCLUDE_CLAUSE = `
  AND account_id NOT IN (SELECT account_id FROM mainnet_lens.market_maker_accounts)
  AND account_id NOT IN (SELECT account_id FROM mainnet_lens.special_accounts)
`;

// ═══ 3. Usage Examples ═══

/** Trading volume for a date range (spot + perps combined) */
async function example_tradingVolume(from: string, to: string) {
  console.log(`\n--- Trading Volume (${from} ~ ${to}) ---`);

  const rows = await query<{
    day_date: string;
    spot_volume: number;
    perps_volume: number;
    total_volume: number;
    unique_traders: number;
  }>(`
    WITH spot AS (
      SELECT day_date, SUM(quote_volume) as vol, COUNT(DISTINCT account_id) as traders
      FROM mainnet_lens.mv_spot_user_daily_volume
      WHERE day_date BETWEEN ? AND ? ${EXCLUDE_CLAUSE}
      GROUP BY day_date
    ),
    perps AS (
      SELECT day_date, SUM(quote_volume) as vol, COUNT(DISTINCT account_id) as traders
      FROM mainnet_lens.mv_perps_user_daily_volume
      WHERE day_date BETWEEN ? AND ? ${EXCLUDE_CLAUSE}
      GROUP BY day_date
    )
    SELECT
      COALESCE(s.day_date, p.day_date) as day_date,
      COALESCE(s.vol, 0) as spot_volume,
      COALESCE(p.vol, 0) as perps_volume,
      COALESCE(s.vol, 0) + COALESCE(p.vol, 0) as total_volume,
      GREATEST(COALESCE(s.traders, 0), COALESCE(p.traders, 0)) as unique_traders
    FROM spot s FULL OUTER JOIN perps p ON s.day_date = p.day_date
    ORDER BY day_date DESC
    LIMIT 7
  `, [from, to, from, to]);

  for (const r of rows) {
    console.log(`  ${r.day_date}: vol=$${Number(r.total_volume).toLocaleString()} traders=${r.unique_traders}`);
  }
}

/** DAU / WAU / stickiness */
async function example_dauWau(from: string, to: string) {
  console.log(`\n--- DAU / WAU (${from} ~ ${to}) ---`);

  const rows = await query<{ day_date: string; dau: number }>(`
    SELECT day_date, COUNT(DISTINCT account_id) as dau
    FROM mainnet_lens.mv_user_daily_active
    WHERE day_date BETWEEN ? AND ? ${EXCLUDE_CLAUSE}
    GROUP BY day_date
    ORDER BY day_date DESC LIMIT 7
  `, [from, to]);

  for (const r of rows) {
    console.log(`  ${r.day_date}: DAU=${r.dau}`);
  }
}

/** User lifecycle distribution */
async function example_lifecycle() {
  console.log("\n--- User Lifecycle Distribution ---");

  const rows = await query<{ stage: string; count: number }>(`
    SELECT stage, COUNT(*) as count
    FROM mainnet_lens.mv_user_lifecycle_stage
    GROUP BY stage
    ORDER BY count DESC
  `);

  for (const r of rows) {
    console.log(`  ${r.stage}: ${r.count}`);
  }
}

/** Retention cohort for a specific date range */
async function example_retention(from: string, to: string) {
  console.log(`\n--- Retention Cohorts (${from} ~ ${to}) ---`);

  const rows = await query<{
    cohort_date: string;
    cohort_size: number;
    d1_active: number;
    d7_active: number;
    d30_active: number;
  }>(`
    SELECT cohort_date, cohort_size, d1_active, d7_active, d30_active
    FROM mainnet_lens.mv_user_retention_cohort
    WHERE cohort_date BETWEEN ? AND ?
    ORDER BY cohort_date DESC LIMIT 7
  `, [from, to]);

  for (const r of rows) {
    const d1pct = r.cohort_size > 0 ? (r.d1_active / r.cohort_size * 100).toFixed(1) : "0";
    const d7pct = r.cohort_size > 0 ? (r.d7_active / r.cohort_size * 100).toFixed(1) : "0";
    console.log(`  ${r.cohort_date}: size=${r.cohort_size} d1=${d1pct}% d7=${d7pct}%`);
  }
}

/** Activation funnel */
async function example_funnel(from: string, to: string) {
  console.log(`\n--- Activation Funnel (${from} ~ ${to}) ---`);

  const row = await queryOne<{
    wallets_created: number;
    new_users: number;
    first_traders: number;
    activated_within_7d: number;
  }>(`
    SELECT
      SUM(wallets_created) as wallets_created,
      SUM(new_users) as new_users,
      SUM(first_traders) as first_traders,
      SUM(activated_within_7d) as activated_within_7d
    FROM mainnet_lens.mv_activation_funnel
    WHERE day_date BETWEEN ? AND ?
  `, [from, to]);

  if (row) {
    console.log(`  Wallets Created:     ${row.wallets_created}`);
    console.log(`  First Deposits:      ${row.new_users}`);
    console.log(`  First Trades:        ${row.first_traders}`);
    console.log(`  Activated (7d):      ${row.activated_within_7d}`);
    if (row.new_users > 0) {
      console.log(`  Activation Rate:     ${(row.activated_within_7d / row.new_users * 100).toFixed(1)}%`);
    }
  }
}

/** Look up a user by wallet address */
async function example_userLookup(walletAddress: string) {
  console.log(`\n--- User Lookup: ${walletAddress.slice(0, 10)}... ---`);

  const user = await queryOne<{
    account_id: number;
    wallet_address: string;
    first_deposit_date: string;
    total_spot_volume: number;
    total_perps_volume: number;
    lifecycle_stage: string;
  }>(`
    SELECT
      pa.account_id,
      pa.wallet_address,
      fd.first_deposit_date,
      COALESCE(sv.vol, 0) as total_spot_volume,
      COALESCE(pv.vol, 0) as total_perps_volume,
      lc.stage as lifecycle_stage
    FROM mainnet_evm.primary_accounts pa
    LEFT JOIN mainnet_lens.mv_user_first_deposit fd ON pa.account_id = fd.account_id
    LEFT JOIN (
      SELECT account_id, SUM(quote_volume) as vol
      FROM mainnet_lens.mv_spot_user_daily_volume GROUP BY account_id
    ) sv ON pa.account_id = sv.account_id
    LEFT JOIN (
      SELECT account_id, SUM(quote_volume) as vol
      FROM mainnet_lens.mv_perps_user_daily_volume GROUP BY account_id
    ) pv ON pa.account_id = pv.account_id
    LEFT JOIN mainnet_lens.mv_user_lifecycle_stage lc ON pa.account_id = lc.account_id
    WHERE LOWER(pa.wallet_address) = LOWER(?)
  `, [walletAddress]);

  if (user) {
    console.log(`  Account ID:      ${user.account_id}`);
    console.log(`  First Deposit:   ${user.first_deposit_date || "none"}`);
    console.log(`  Spot Volume:     $${Number(user.total_spot_volume).toLocaleString()}`);
    console.log(`  Perps Volume:    $${Number(user.total_perps_volume).toLocaleString()}`);
    console.log(`  Lifecycle:       ${user.lifecycle_stage || "unknown"}`);
  } else {
    console.log("  User not found");
  }
}

/** Weekly points allocation summary */
async function example_pointsSummary() {
  console.log("\n--- Points Allocation (Recent Weeks) ---");

  const rows = await query<{
    week_id: string;
    total_points: number;
    total_users: number;
    status: string;
  }>(`
    SELECT week_id, total_users,
      COALESCE((SELECT SUM(final_points) FROM mainnet_insights.points_alloc_draft_users WHERE draft_id = d.draft_id), 0) as total_points,
      status
    FROM mainnet_insights.points_alloc_draft d
    ORDER BY week_id DESC LIMIT 5
  `);

  for (const r of rows) {
    console.log(`  ${r.week_id}: ${Number(r.total_points).toLocaleString()} pts, ${r.total_users} users [${r.status}]`);
  }
}

// ═══ 4. Main (直接运行验证) ═══

async function main() {
  console.log("=== SODEX Analytics Database Example ===");
  console.log(`Host: ${CONFIG.host}:${CONFIG.port}`);

  if (!CONFIG.user || !CONFIG.password) {
    console.log("\nNo STARROCKS_USER/PASSWORD set.\n");
    console.log("Usage:");
    console.log("  STARROCKS_USER=xxx STARROCKS_PASSWORD=xxx bun run apis/sodex-db-example.ts");
    console.log("\nKey tables:");
    console.log("  mainnet_lens.mv_spot_user_daily_volume   — 现货日交易量");
    console.log("  mainnet_lens.mv_user_daily_active        — 日活");
    console.log("  mainnet_lens.mv_user_retention_cohort    — 留存队列");
    console.log("  mainnet_lens.mv_activation_funnel        — 激活漏斗");
    console.log("  mainnet_evm.primary_accounts             — 账户↔钱包映射");
    console.log("  mainnet_insights.points_alloc_draft_users — 积分明细");
    return;
  }

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  try {
    await example_tradingVolume(from, to);
    await example_dauWau(from, to);
    await example_lifecycle();
    await example_retention(from, to);
    await example_funnel(from, to);
    await example_pointsSummary();

    // User lookup demo (uncomment with a real address to test cross-db JOIN)
    // await example_userLookup("0x..your_wallet_address..");
  } catch (err: any) {
    console.error("Query failed:", err.message);
  } finally {
    await getPool().end();
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
