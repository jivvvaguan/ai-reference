# SODEX Analytics Database (StarRocks)

> 分类: apis
> 适用场景: 查询 SODEX 用户行为数据、交易量、留存、积分分配
> 配套代码: `sodex-db-example.ts`
> 最后验证: 2026-03-24

## 核心概念

SODEX 数据层用 **StarRocks**（MySQL 协议兼容），分三个库：
- `mainnet_lens` — 交易数据 + 物化视图（只读）
- `mainnet_evm` — 链上数据：钱包、Vault、账户映射（只读）
- `mainnet_insights` — 应用数据：标签、积分、灰名单（读写）

数据从链上实时索引 → 物化视图每小时刷新 → 应用表手动写入。

## 关键决策

- StarRocks 不支持 prepared statements → 用 `mysql.format()` 插值参数
- 物化视图每小时刷新 → 实时性延迟 ≤1h，raw trades 表实时
- `account_id` 是主键 → 跨表 JOIN 用 account_id，不用 wallet_address
- 排除 MM/特殊账户 → 每个查询必须 `NOT IN (market_maker_accounts, special_accounts)`

## 常见坑

- ❌ 用 prepared statements → StarRocks 不支持 COM_STMT_PREPARE，用 `mysql.format(sql, params)` 替代
- ❌ `mv_spot_account_first_trade` 直接用 → 有重复行（最多 110 条），必须 `GROUP BY account_id` + `MIN(day_date)`
- ❌ integer 除法 → `100 * 3 / 7 = 42` 不是 42.857，至少一个操作数 CAST 为 DOUBLE
- ❌ `CAST(CASE...END AS DOUBLE)` → StarRocks 可能返回 NULL，包一层 `COALESCE(..., 0)`
- ❌ `primary_accounts` 做驱动表 JOIN 大表 → 50K 行驱动多个大 JOIN 会 OOM，先用 CTE 缩小驱动集
- ❌ wallet_address 大小写不一致 → StarRocks 区分大小写，用 `LOWER()` 统一
- ❌ maker_exec_count + taker_exec_count 当交易数 → 这是执行数（每笔成交两个执行），不是交易笔数
- ❌ body 里 filter bot 没加 `greylist_factor >= 0` → greylist_factor=-1 的用户会产生负分

## 数据库拓扑

```
mainnet_lens (只读，交易数据)
├─ spot_trades (15.8M rows)           — 现货成交明细
├─ perps_trades (29.9M rows)          — 永续成交明细
├─ mv_spot_user_daily_volume          — 现货日汇总(volume/fee/maker/taker)
├─ mv_perps_user_daily_volume         — 永续日汇总
├─ mv_spot_user_deposit_withdraw      — 充提记录(type=7存/8,9取)
├─ mv_user_first_deposit              — 首充日期
├─ mv_user_daily_active               — 日活(spot∪perps)
├─ mv_user_retention_cohort           — 留存(d1/d3/d7/d14/d30/d60)
├─ mv_user_lifecycle_stage            — 生命周期(new/active/declining/dormant/churned)
├─ mv_activation_funnel               — 激活漏斗(4阶段)
├─ vw_user_profile_wide               — 用户宽表(一行一用户)
├─ referral_relation_account          — 推荐关系(9,843对)
├─ market_maker_accounts              — MM排除表(5个)
└─ special_accounts                   — 特殊排除表(11个)

mainnet_evm (只读，链上数据)
├─ primary_accounts (50,445)          — account_id ↔ wallet_address 映射
├─ vault_flows (32,255)               — Vault 资金流水
└─ vw_vault_account_net_stake_*       — Vault 净值快照

mainnet_insights (读写，应用数据)
├─ tag_definitions                    — 标签定义
├─ user_tag_assignments               — 用户-标签关系
├─ points_alloc_config                — 积分配置模板
├─ points_alloc_draft                 — 积分分配草稿(状态机)
├─ points_alloc_draft_users           — 每用户积分明细
├─ points_wallet_weekly               — 每周最终积分
└─ points_greylist                    — Bot 折扣表
```

## 连接配置

```
Host:     warehouse-analysis.valuechain.xyz
Port:     9030
Protocol: MySQL (mysql2/promise)
Database: mainnet_lens (default)
```

## 物化视图刷新频率

| MV | 刷新 | 延迟 |
|----|------|------|
| mv_*_user_daily_volume | EVERY 1 HOUR | ≤1h |
| mv_user_daily_active | EVERY 1 HOUR | ≤1h |
| mv_user_retention_cohort | EVERY 1 HOUR | ≤1h |
| vw_user_profile_wide | VIEW (实时) | 0 |
| spot_trades / perps_trades | 链上索引 | 实时 |

## 性能参考

| 查询 | 数据量 | 延迟 |
|------|--------|------|
| 7天 spot volume (MV) | 42K rows | <50ms |
| Maker/taker 拆分 (raw trades, 7d) | 15M+ rows | 200-350ms |
| DAU 计算 (30d) | 85K rows | 100-200ms |
| 留存队列查询 | 40K users | 200-400ms |
| 用户宽表 (全量) | 50K users | 400-600ms |
| OI 快照 | 783K positions | 100-200ms |

超时设置: 标准 300s，14+ CTE 查询设 `new_planner_optimize_timeout=10000`。
