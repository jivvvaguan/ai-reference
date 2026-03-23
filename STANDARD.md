# Reference Library Content Standard

> 本文件定义参考资源库的内容标准。
> AI 可以根据此标准，从成熟的生产代码自动生成参考条目。

---

## 结构

每个参考条目由**一对文件**组成：

```
{topic}.ts       ← 独立可运行的代码案例（bun run 直接跑）
{topic}.md       ← 配套说明文档（上下文、决策、常见坑）
```

放在对应分类目录下：

```
apis/            ← API 集成（SODEX、CoinGecko、链上数据源等）
web3/            ← Web3 接入（WalletConnect、wagmi、ethers.js 等）
patterns/        ← 通用开发模式（错误处理、表单验证、状态管理等）
env/             ← 环境配置（API Key 约定、链配置、RPC 节点等）
```

---

## 代码案例标准（`.ts` 文件）

### 文件头注释（必须）

```typescript
/**
 * @reference {分类}/{名称}
 * @description 一句话描述这个案例做什么
 * @prerequisites bun, ethers@6
 * @env SODEX_API_KEY, SODEX_API_SECRET
 * @runnable bun run apis/sodex-api-example.ts
 * @verified 2026-03-23
 */
```

### 代码结构（必须分 4 段）

```typescript
// ═══ 1. Setup & Config ═══
// 集中所有配置项，复用时只改这里

const CONFIG = {
  baseUrl: process.env.XXX_BASE_URL || "https://api.example.com/v1",
  apiKey: process.env.XXX_API_KEY || "",
};

// ═══ 2. Types & Core Implementation ═══
// 类型定义 + 核心逻辑，可直接复制到项目中

interface TickerData {
  symbol: string;
  last: string;
  change24h: string;
}

async function fetchTickers(): Promise<TickerData[]> {
  // 完整实现...
}

// ═══ 3. Usage Examples ═══
// 展示 2-3 个典型使用场景，每个场景一个函数

async function example_basicUsage() {
  const tickers = await fetchTickers();
  console.log("Top 3 tickers:", tickers.slice(0, 3));
}

async function example_errorHandling() {
  try {
    const data = await fetchTickers();
  } catch (err) {
    console.error("Failed:", err instanceof Error ? err.message : err);
  }
}

// ═══ 4. Main (直接运行验证) ═══

async function main() {
  console.log(`--- ${CONFIG.baseUrl} ---`);
  await example_basicUsage();
  await example_errorHandling();
  console.log("--- Done ---");
}

main().catch(console.error);
```

### 质量规则

| # | 规则 | 理由 |
|---|------|------|
| 1 | `bun run {file}` 直接可执行 | AI 生成后能立即验证 |
| 2 | 零 `any` 类型，所有数据结构有 interface | 类型即文档 |
| 3 | 密钥用 `process.env`，不硬编码 | 安全 |
| 4 | CONFIG 对象集中配置 | 复用时只改一处 |
| 5 | 代码分 4 段，每段用 `═══` 注释分隔 | 结构可预测，AI 能精准定位 |
| 6 | 核心函数有 JSDoc（参数、返回值、异常） | AI 理解意图后能正确适配 |
| 7 | 不依赖项目内其他文件 | 独立可运行 |
| 8 | 单文件不超过 300 行 | 太长 AI 不会读完 |
| 9 | 包含错误处理的示例 | 防止 AI 只抄 happy path |

---

## 说明文档标准（`.md` 文件）

### 结构

```markdown
# {名称}

> 分类: {apis/web3/patterns/env}
> 适用场景: 一句话说明什么时候该用这个参考
> 配套代码: `{topic}.ts`
> 最后验证: 2026-03-23 (bun run 通过)

## 核心概念

3-5 句话解释核心思路。不是 API 文档的复制粘贴，
而是"为什么这样做"和"关键设计决策"。

## 关键决策

- 选择 X 而非 Y → 因为...
- 用这种模式 → 因为...

## 常见坑

- ❌ 错误做法 → 正确做法（一句话说明原因）
- ❌ 错误做法 → 正确做法

## 快速集成步骤

1. 安装依赖: `bun add xxx`
2. 配置环境变量: 设置 `XXX_API_KEY`
3. 复制 `{topic}.ts` 的 Core Implementation 段到项目
4. 按 Usage Examples 调用

## API 速查（如适用）

| Endpoint | 方法 | 用途 | 限频 |
|----------|------|------|------|
| /path    | GET  | 描述 | 10/s |
```

### 质量规则

| # | 规则 | 理由 |
|---|------|------|
| 1 | 必须有"最后验证"日期 | 判断是否过时 |
| 2 | 必须有"常见坑"段 | 参考库最高价值部分 |
| 3 | 不超过 150 行 | 信息密度要高 |
| 4 | 集成步骤用数字列表 | AI 能直接按步骤执行 |
| 5 | 不重复代码案例中已有的内容 | .md 讲 why，.ts 讲 how |

---

## AI 生成 Prompt

当你有一份成熟的生产代码，想生成参考条目时，使用以下 prompt：

```
根据 STANDARD.md 中的参考资源库标准，从以下生产代码生成参考条目。

输入代码:
[粘贴你的生产代码]

要求:
1. 生成 {topic}.ts — 独立可运行的代码案例
   - 从输入代码提炼核心逻辑，去掉项目特定依赖
   - 保留完整类型定义
   - 分 4 段: Setup & Config / Types & Core / Usage Examples / Main
   - bun run 可直接执行

2. 生成 {topic}.md — 配套说明文档
   - 从代码注释和实现逻辑中提取"核心概念"和"关键决策"
   - 从错误处理代码和边界条件中提取"常见坑"
   - 写"快速集成步骤"

两个文件一起输出。
```

---

## 维护规则

- 参考条目过时时（API 版本升级、库大版本更新），更新代码 + 修改"最后验证"日期
- 删除不再使用的参考（比如从 ethers v5 迁移到 v6 后，删除 v5 的参考）
- INDEX.md 保持和实际文件同步
