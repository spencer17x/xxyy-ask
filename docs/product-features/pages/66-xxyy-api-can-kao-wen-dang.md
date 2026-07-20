---
title: "XXYY API 参考文档"
source_url: "https://docs.xxyy.io/xxyy-api-can-kao-wen-dang"
source_markdown_url: "https://docs.xxyy.io/xxyy-api-can-kao-wen-dang.md"
language: "zh"
category: "开发者文档"
section: "XXYY API"
lastmod: "2026-03-16T11:14:34.658Z"
retrieved_at: "2026-07-19T14:24:48.800Z"
content_state: "content"
ingest: true
---

# XXYY API 参考文档

XXYY 提供 RESTful API，用于在 **Solana**、**Ethereum**、**BSC** 和 **Base** 链上进行代币交易和数据查询。

本文档面向直接集成 XXYY Open API 的第三方开发者。

***

### 目录

* 快速开始
* 身份认证
* 频率限制
* API 接口
  * Ping（健康检查）
  * Swap（买入/卖出）
  * Query Trade（查询交易）
  * Feed（扫描代币）
  * Token Query（代币查询）
  * List Wallets（钱包列表）
  * Wallet Info（钱包信息）
* 数据类型与枚举
* 错误码
* 区块浏览器 URL
* 最佳实践
* 技术支持

***

### 快速开始

**基础 URL**

```
https://www.xxyy.io
```

本文档中的所有接口路径都是相对于此基础 URL。

**最小示例 — 检查连接**

```bash
curl -s "https://www.xxyy.io/api/trade/open/api/ping" \
  -H "Authorization: Bearer xxyy_ak_xxxx"
```

成功响应返回 `"pong"`。

***

### 身份认证

所有请求必须包含以下 HTTP 头：

```
Authorization: Bearer <XXYY_API_KEY>
```

| 项目        | 详情                           |
| --------- | ---------------------------- |
| Header 名称 | `Authorization`              |
| 认证方案      | `Bearer`                     |
| Key 格式    | `xxyy_ak_xxxx`               |
| 获取 Key    | <https://www.xxyy.io/apikey> |

#### 安全提醒

* **API Key = 钱包访问权限。** XXYY API Key 可以使用您的钱包余额执行真实的链上交易。
* **切勿**分享您的 Key、将其提交到版本控制系统，或在日志或公开渠道中暴露。
* **托管模式。** XXYY 是托管式交易平台。您只需API Key — 无需私钥或钱包签名。
* **无只读模式。** 同一个 API Key 用于数据查询和交易。目前没有单独的只读 Key。
* 如果怀疑泄露，**立即在** [**https://www.xxyy.io/apikey**](https://www.xxyy.io/apikey) **重新生成 Key**。

***

### 频率限制

频率限制按 **API Key** 执行。

#### 默认限制

| 接口组          | 默认 QPS |
| ------------ | ------ |
| Trade (Swap) | 1      |
| Trade Query  | 1      |
| Feed         | 1      |
| Token Query  | 1      |
| Wallets      | 1      |

#### 超出频率限制

当超出频率限制时，API 返回错误码 `8062`。建议的退避策略：

* **数据查询接口**（Feed、Token Query、Wallets）：等待 **1 秒**后重试。
* **交易接口**（Swap、Query Trade）：等待 **1 秒**后重试。例外：**不要**重试失败的 Swap 请求 — 应向用户显示错误。

#### 申请更高限制

要申请提高 QPS，请私信 Twitter 账号 [**@cryptopepace**](https://x.com/cryptopepace)，并提供：

1. 使用场景描述
2. 期望的 QPS

***

### API 接口

#### Ping（健康检查）

健康检查接口。如果 API Key 有效，返回 `"pong"`。

```
GET /api/trade/open/api/ping
```

**请求**

```bash
curl -s "https://www.xxyy.io/api/trade/open/api/ping" \
  -H "Authorization: Bearer $XXYY_API_KEY"
```

**响应**

```
pong
```

***

#### Swap（买入/卖出）

在任何支持的链上执行代币买入或卖出。

```
POST /api/trade/open/api/swap
```

**请求头**

| Header          | 值                       |
| --------------- | ----------------------- |
| `Authorization` | `Bearer <XXYY_API_KEY>` |
| `Content-Type`  | `application/json`      |

**请求体参数**

| 参数              | 必填 | 类型      | 有效值                                          | 描述                                                         |
| --------------- | -- | ------- | -------------------------------------------- | ---------------------------------------------------------- |
| `chain`         | 是  | string  | `sol` / `eth` / `bsc` / `base`               | 目标区块链                                                      |
| `walletAddress` | 是  | string  | SOL: Base58, 32-44 字符; EVM: `0x` + 40 十六进制字符 | 您在 XXYY 平台上的钱包地址（必须匹配 `chain`）                             |
| `tokenAddress`  | 是  | string  | 合约地址                                         | 要交易的代币合约地址                                                 |
| `isBuy`         | 是  | boolean | `true` / `false`                             | `true` = 买入, `false` = 卖出                                  |
| `amount`        | 是  | number  | 买入: > 0; 卖出: 1–100                           | **买入**: 原生币数量（SOL/ETH/BNB）。**卖出**: 持仓百分比（例如 `50` = 卖出 50%） |
| `tip`           | 是  | number  | SOL: 0.001–0.1 (SOL); EVM: 0.1–100 (Gwei)    | 优先费。参见 tip / priorityFee 规则                                |
| `slippage`      | 否  | number  | 0–100                                        | 滑点容差百分比。默认: `20`                                           |
| `model`         | 否  | number  | `1` 或 `2`                                    | `1` = 防夹子保护（默认）, `2` = 快速模式                                |
| `priorityFee`   | 否  | number  | >= 0                                         | **仅 Solana。** 在 `tip` 之外的额外优先费                             |

**tip / priorityFee 规则**

* **`tip`**（必填）— 适用于**所有**链的通用优先费。
  * **SOL 链**: 单位是 SOL。`1` = 1 SOL（非常昂贵）。推荐: `0.001` – `0.1`。
  * **EVM 链**（eth/bsc/base）: 单位是 Gwei。推荐: `0.1` – `100`。
  * 如果未提供 `tip`，API 会回退到 `priorityFee`。
* **`priorityFee`**（可选）— 仅在 **Solana** 上有效。Solana 支持同时使用 `tip` 和 `priorityFee`。

**示例 — 买入代币（Solana）**

```bash
curl -s -X POST "https://www.xxyy.io/api/trade/open/api/swap" \
  -H "Authorization: Bearer $XXYY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "sol",
    "walletAddress": "7xKXq1B...",
    "tokenAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "isBuy": true,
    "amount": 0.1,
    "tip": 0.001,
    "slippage": 20
  }'
```

**示例 — 卖出代币（BSC）**

```bash
curl -s -X POST "https://www.xxyy.io/api/trade/open/api/swap" \
  -H "Authorization: Bearer $XXYY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "chain": "bsc",
    "walletAddress": "0x1a2B3c4D5e6F...",
    "tokenAddress": "0xAbCdEf...",
    "isBuy": false,
    "amount": 50,
    "tip": 1
  }'
```

**响应**

Swap 接口返回交易 ID（`txId`）。使用 Query Trade 轮询交易状态。

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "txId": "5K2f...xyz"
  },
  "success": true
}
```

***

#### Query Trade（查询交易）

查询已提交交易的状态。

```
GET /api/trade/open/api/trade
```

**查询参数**

| 参数     | 必填 | 类型     | 描述              |
| ------ | -- | ------ | --------------- |
| `txId` | 是  | string | Swap 接口返回的交易 ID |

**请求**

```bash
curl -s "https://www.xxyy.io/api/trade/open/api/trade?txId=5K2f...xyz" \
  -H "Authorization: Bearer $XXYY_API_KEY"
```

**响应**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "txId": "5K2f...xyz",
    "status": "success",
    "statusDesc": "Transaction confirmed",
    "chain": "sol",
    "tokenAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "walletAddress": "7xKXq1B...",
    "isBuy": true,
    "baseAmount": 1000.50,
    "quoteAmount": 0.1
  },
  "success": true
}
```

**响应字段**

| 字段              | 类型      | 描述                               |
| --------------- | ------- | -------------------------------- |
| `txId`          | string  | 交易 ID                            |
| `status`        | string  | `pending` / `success` / `failed` |
| `statusDesc`    | string  | 人类可读的状态描述                        |
| `chain`         | string  | 区块链标识符                           |
| `tokenAddress`  | string  | 代币合约地址                           |
| `walletAddress` | string  | 使用的钱包地址                          |
| `isBuy`         | boolean | `true` = 买入, `false` = 卖出        |
| `baseAmount`    | number  | 代币数量（交易的代币）                      |
| `quoteAmount`   | number  | 原生币数量（SOL/ETH/BNB）               |

**轮询建议**

提交 Swap 后，以 **5 秒间隔**轮询交易状态，**最多 3 次**。

***

#### Feed（扫描代币）

检索 Meme 代币列表：新上线、即将毕业或已毕业。

```
POST /api/trade/open/api/feed/{type}
```

> **支持的链:** 仅 `sol` 和 `bsc`。

**路径与查询参数**

| 参数      | 必填 | 类型    | 有效值                            | 描述                                              |
| ------- | -- | ----- | ------------------------------ | ----------------------------------------------- |
| `type`  | 是  | path  | `NEW` / `ALMOST` / `COMPLETED` | `NEW` = 新上线, `ALMOST` = 即将毕业, `COMPLETED` = 已毕业 |
| `chain` | 否  | query | `sol` / `bsc`                  | 默认: `sol`。仅支持这 2 条链                             |

**请求体（筛选参数）**

所有筛选器都是**可选的**。发送 JSON 请求体以缩小结果范围。

范围参数使用逗号分隔的字符串格式 `"min,max"`。留空一侧表示开放式范围（例如 `"100,"` = 最小 100，`",50"` = 最大 50）。

| 参数            | 类型        | 描述                          | 示例                 |
| ------------- | --------- | --------------------------- | ------------------ |
| `dex`         | string\[] | DEX 平台筛选（参见 DEX 枚举）         | `["pump","bonk"]`  |
| `quoteTokens` | string\[] | 报价代币筛选（参见 quoteTokens 枚举）   | `["sol","usdc"]`   |
| `link`        | string\[] | 社交媒体链接筛选                    | `["x","tg","web"]` |
| `keywords`    | string\[] | 代币名称/符号关键词匹配                | `["pepe","doge"]`  |
| `ignoreWords` | string\[] | 排除匹配这些关键词的代币                | `["scam"]`         |
| `mc`          | string    | 市值范围（USD）                   | `"10000,500000"`   |
| `liq`         | string    | 流动性范围（USD）                  | `"1000,"`          |
| `vol`         | string    | 交易量范围（USD）                  | `"5000,100000"`    |
| `holder`      | string    | 持币地址数范围                     | `"50,"`            |
| `createTime`  | string    | 创建时间范围（距现在的分钟数）             | `"1,20"`           |
| `tradeCount`  | string    | 交易次数范围                      | `"100,"`           |
| `buyCount`    | string    | 买入次数范围                      | `"50,"`            |
| `sellCount`   | string    | 卖出次数范围                      | `"10,"`            |
| `devBuy`      | string    | 开发者买入金额范围（原生代币）             | `"0.001,"`         |
| `devSell`     | string    | 开发者卖出金额范围（原生代币）             | `"0.001,"`         |
| `devHp`       | string    | 开发者持仓百分比范围                  | `",60"`            |
| `topHp`       | string    | Top-10 持仓百分比范围              | `",60"`            |
| `insiderHp`   | string    | 内部人持仓百分比范围                  | `",50"`            |
| `bundleHp`    | string    | Bundle 持仓百分比范围              | `",60"`            |
| `newWalletHp` | string    | 新钱包持仓百分比范围                  | `",30"`            |
| `progress`    | string    | 毕业进度百分比范围（仅 `NEW`/`ALMOST`） | `"1,90"`           |
| `snipers`     | string    | 狙击手数量范围                     | `",5"`             |
| `xnameCount`  | string    | Twitter 改名次数范围              | `",3"`             |
| `tagHolder`   | string    | 关注钱包买入数量范围                  | `"1,2"`            |
| `kol`         | string    | KOL 买入数量范围                  | `"1,2"`            |
| `dexPay`      | int       | 仅 DexScreener 付费（`1` = 启用）  | `1`                |
| `oneLink`     | int       | 至少一个社交链接（`1` = 启用）          | `1`                |
| `live`        | int       | 当前正在直播（`1` = 启用）            | `1`                |

**请求**

```bash
curl -s -X POST "https://www.xxyy.io/api/trade/open/api/feed/NEW?chain=sol" \
  -H "Authorization: Bearer $XXYY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"mc":"10000,500000","holder":"50,","insiderHp":",50"}'
```

**响应**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "items": [
      {
        "tokenAddress": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "symbol": "TOKEN",
        "name": "Token Name",
        "createTime": 1773140232851,
        "dexName": "PUMPFUN",
        "launchPlatform": {
          "name": "PUMPFUN",
          "progress": "12.89",
          "completed": false
        },
        "holders": 3,
        "priceUSD": 0.000003046,
        "marketCapUSD": 3046.80,
        "devHoldPercent": 12.48,
        "hasLink": false,
        "snipers": 0,
        "quoteToken": "sol"
      }
    ]
  },
  "success": true
}
```

**响应字段**

| 字段                         | 类型      | 描述            |
| -------------------------- | ------- | ------------- |
| `tokenAddress`             | string  | 代币合约地址        |
| `symbol`                   | string  | 代币符号          |
| `name`                     | string  | 代币名称          |
| `createTime`               | number  | 创建时间戳（毫秒）     |
| `dexName`                  | string  | DEX 平台名称      |
| `launchPlatform.name`      | string  | 发射平台名称        |
| `launchPlatform.progress`  | string  | 毕业进度百分比       |
| `launchPlatform.completed` | boolean | 是否已完成毕业       |
| `holders`                  | number  | 持币地址数         |
| `priceUSD`                 | number  | 当前价格（USD）     |
| `marketCapUSD`             | number  | 市值（USD）       |
| `devHoldPercent`           | number  | 开发者持仓百分比      |
| `hasLink`                  | boolean | 是否有社交链接       |
| `snipers`                  | number  | 狙击手数量         |
| `quoteToken`               | string  | 报价代币符号        |
| `volume`                   | number  | 交易量           |
| `tradeCount`               | number  | 总交易次数         |
| `buyCount`                 | number  | 买入交易次数        |
| `sellCount`                | number  | 卖出交易次数        |
| `topHolderPercent`         | number  | Top-10 持币者百分比 |
| `insiderHp`                | number  | 内部人持仓百分比      |
| `bundleHp`                 | number  | Bundle 持仓百分比  |

***

#### Token Query（代币查询）

查询代币详情，包括价格、安全检查、税率和持币者分布。

```
GET /api/trade/open/api/query
```

**查询参数**

| 参数      | 必填 | 类型     | 有效值                            | 描述                  |
| ------- | -- | ------ | ------------------------------ | ------------------- |
| `ca`    | 是  | string | 合约地址                           | 代币合约地址              |
| `chain` | 否  | string | `sol` / `eth` / `bsc` / `base` | 默认: `sol`。支持所有 4 条链 |

**请求**

```bash
curl -s "https://www.xxyy.io/api/trade/open/api/query?ca=TOKEN_ADDRESS&chain=sol" \
  -H "Authorization: Bearer $XXYY_API_KEY"
```

**响应**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "chainId": "bsc",
    "tokenAddress": "0x...",
    "baseSymbol": "TOKEN",
    "tradeInfo": {
      "marketCapUsd": 15464629.87,
      "price": 0.01546,
      "holder": 7596,
      "hourTradeNum": 20611,
      "hourTradeVolume": 2564705.05
    },
    "pairInfo": {
      "pairAddress": "0x...",
      "pair": "TOKEN - WBNB",
      "liquidateUsd": 581750.57,
      "createTime": 1772182240000
    },
    "securityInfo": {
      "honeyPot": false,
      "openSource": true,
      "noOwner": true,
      "locked": true
    },
    "taxInfo": {
      "buy": "0",
      "sell": "0"
    },
    "linkInfo": {
      "tg": "",
      "x": "",
      "web": ""
    },
    "dev": {
      "address": "0x...",
      "pct": 0.0
    },
    "topHolderPct": 25.14,
    "topHolderList": [
      {
        "address": "0x...",
        "balance": 98665702.34,
        "pct": 9.86
      }
    ]
  },
  "success": true
}
```

**响应字段**

**tradeInfo（交易信息）**

| 字段                | 类型     | 描述             |
| ----------------- | ------ | -------------- |
| `marketCapUsd`    | number | 市值（USD）        |
| `price`           | number | 当前代币价格（USD）    |
| `holder`          | number | 持币地址数          |
| `hourTradeNum`    | number | 过去一小时的交易次数     |
| `hourTradeVolume` | number | 过去一小时的交易量（USD） |

**pairInfo（交易对信息）**

| 字段             | 类型     | 描述                       |
| -------------- | ------ | ------------------------ |
| `pairAddress`  | string | 交易对合约地址                  |
| `pair`         | string | 交易对名称（例如 `TOKEN - WBNB`） |
| `liquidateUsd` | number | 流动性（USD）                 |
| `createTime`   | number | 交易对创建时间戳（毫秒）             |

**securityInfo（安全信息）**

| 字段           | 类型      | 描述                  |
| ------------ | ------- | ------------------- |
| `honeyPot`   | boolean | `true` = 检测到蜜罐（高风险） |
| `openSource` | boolean | `true` = 合约源代码已验证   |
| `noOwner`    | boolean | `true` = 已放弃所有权     |
| `locked`     | boolean | `true` = 流动性已锁定     |

**taxInfo（税率信息）**

| 字段     | 类型     | 描述      |
| ------ | ------ | ------- |
| `buy`  | string | 买入税率百分比 |
| `sell` | string | 卖出税率百分比 |

**linkInfo（链接信息）**

| 字段    | 类型     | 描述             |
| ----- | ------ | -------------- |
| `tg`  | string | Telegram 链接    |
| `x`   | string | Twitter / X 链接 |
| `web` | string | 网站 URL         |

**dev（开发者信息）**

| 字段        | 类型     | 描述       |
| --------- | ------ | -------- |
| `address` | string | 开发者钱包地址  |
| `pct`     | number | 开发者持仓百分比 |

**topHolderPct** — `number` — Top-10 持币者总百分比。

**topHolderList\[]（Top 持币者列表）**

| 字段        | 类型     | 描述      |
| --------- | ------ | ------- |
| `address` | string | 持币者钱包地址 |
| `balance` | number | 代币余额    |
| `pct`     | number | 持仓百分比   |

***

#### List Wallets（钱包列表）

查询当前用户在特定链上的钱包列表（含余额）。

```
GET /api/trade/open/api/wallets
```

**查询参数**

| 参数             | 必填 | 类型     | 有效值                            | 描述              |
| -------------- | -- | ------ | ------------------------------ | --------------- |
| `chain`        | 否  | string | `sol` / `eth` / `bsc` / `base` | 默认: `sol`       |
| `pageNum`      | 否  | int    | >= 1                           | 页码。默认: `1`      |
| `pageSize`     | 否  | int    | 1–20                           | 每页数量。默认: `20`   |
| `tokenAddress` | 否  | string | 合约地址                           | 提供时，包含每个钱包的代币持仓 |

**请求**

```bash
curl -s "https://www.xxyy.io/api/trade/open/api/wallets?chain=sol" \
  -H "Authorization: Bearer $XXYY_API_KEY"
```

**带代币余额的请求**

```bash
curl -s "https://www.xxyy.io/api/trade/open/api/wallets?chain=sol&tokenAddress=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" \
  -H "Authorization: Bearer $XXYY_API_KEY"
```

**响应**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "totalCount": 3,
    "pageSize": 20,
    "totalPage": 1,
    "currPage": 1,
    "list": [
      {
        "userId": 12345,
        "chain": 1,
        "name": "Wallet-1",
        "address": "5xYz...abc",
        "balance": 1.523456789,
        "topUp": 1,
        "tokenBalance": null,
        "createTime": "2025-01-01 00:00:00",
        "updateTime": "2025-06-01 12:00:00",
        "isImport": false
      }
    ]
  },
  "success": true
}
```

**响应字段**

| 字段                                   | 类型             | 描述                            |
| ------------------------------------ | -------------- | ----------------------------- |
| `totalCount`                         | number         | 钱包总数                          |
| `pageSize`                           | number         | 每页数量                          |
| `totalPage`                          | number         | 总页数                           |
| `currPage`                           | number         | 当前页码                          |
| `list[].userId`                      | number         | 用户 ID                         |
| `list[].chain`                       | number         | 链代码（参见 链代码）                   |
| `list[].name`                        | string         | 钱包显示名称                        |
| `list[].address`                     | string         | 钱包地址                          |
| `list[].balance`                     | number         | 原生代币余额（SOL/ETH/BNB）           |
| `list[].topUp`                       | number         | `1` = 置顶, `0` = 普通            |
| `list[].tokenBalance`                | object \| null | 代币持仓（仅在提供 `tokenAddress` 时存在） |
| `list[].tokenBalance.amount`         | string         | 原始代币数量                        |
| `list[].tokenBalance.decimals`       | number         | 代币精度                          |
| `list[].tokenBalance.uiAmount`       | number         | 人类可读的代币数量                     |
| `list[].tokenBalance.uiAmountString` | string         | 人类可读的代币数量（字符串）                |
| `list[].createTime`                  | string         | 钱包创建时间                        |
| `list[].updateTime`                  | string         | 最后更新时间                        |
| `list[].isImport`                    | boolean        | 是否为导入的钱包                      |

***

#### Wallet Info（钱包信息）

查询单个钱包的详情，包括原生币余额和可选的代币余额。

```
GET /api/trade/open/api/wallet/info
```

**查询参数**

| 参数              | 必填 | 类型     | 有效值                            | 描述          |
| --------------- | -- | ------ | ------------------------------ | ----------- |
| `walletAddress` | 是  | string | 钱包地址                           | EVM 链不区分大小写 |
| `chain`         | 否  | string | `sol` / `eth` / `bsc` / `base` | 默认: `sol`   |
| `tokenAddress`  | 否  | string | 合约地址                           | 提供时，包含代币持仓  |

**请求**

```bash
curl -s "https://www.xxyy.io/api/trade/open/api/wallet/info?walletAddress=YOUR_WALLET&chain=sol" \
  -H "Authorization: Bearer $XXYY_API_KEY"
```

**带代币余额的请求**

```bash
curl -s "https://www.xxyy.io/api/trade/open/api/wallet/info?walletAddress=YOUR_WALLET&chain=sol&tokenAddress=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" \
  -H "Authorization: Bearer $XXYY_API_KEY"
```

**响应**

```json
{
  "code": 200,
  "msg": "success",
  "data": {
    "address": "5xY...abc",
    "name": "MyWallet",
    "chain": 1,
    "isImport": false,
    "topUp": 0,
    "balance": 1.234567,
    "tokenBalance": {
      "amount": "1000000",
      "uiAmount": 1.0,
      "decimals": 6
    }
  },
  "success": true
}
```

**响应字段**

| 字段                      | 类型             | 描述                      |
| ----------------------- | -------------- | ----------------------- |
| `address`               | string         | 钱包地址                    |
| `name`                  | string         | 钱包显示名称                  |
| `chain`                 | number         | 链代码（参见 链代码）             |
| `isImport`              | boolean        | 是否为导入的钱包                |
| `topUp`                 | number         | `1` = 置顶, `0` = 普通      |
| `balance`               | number         | 原生代币余额                  |
| `tokenBalance`          | object \| null | 仅在提供 `tokenAddress` 时存在 |
| `tokenBalance.amount`   | string         | 原始代币数量                  |
| `tokenBalance.uiAmount` | number         | 人类可读的代币数量               |
| `tokenBalance.decimals` | number         | 代币精度                    |

***

### 数据类型与枚举

#### 支持的链

| 链               | 标识符    | 原生币 |
| --------------- | ------ | --- |
| Solana          | `sol`  | SOL |
| Ethereum        | `eth`  | ETH |
| BNB Smart Chain | `bsc`  | BNB |
| Base            | `base` | ETH |

#### 链代码

钱包相关响应中使用的数字链代码：

| 代码 | 链    |
| -- | ---- |
| 1  | SOL  |
| 2  | BSC  |
| 3  | ETH  |
| 6  | BASE |

#### 钱包地址格式

| 链                | 格式               | 示例模式        |
| ---------------- | ---------------- | ----------- |
| SOL              | Base58, 32–44 字符 | `7xKX...`   |
| ETH / BSC / Base | `0x` + 40 十六进制字符 | `0x1a2B...` |

#### 各链 DEX 值

用于 Feed 接口的 `dex` 筛选参数。

**SOL:** `pump`, `pumpmayhem`, `bonk`, `heaven`, `believe`, `daosfun`, `launchlab`, `mdbc`, `jupstudio`, `mdbcbags`, `trends`, `moonshotn`, `boop`, `moon`, `time`

**BSC:** `four`, `four_agent`, `bnonly`, `flap`

#### 各链 quoteTokens 值

用于 Feed 接口的 `quoteTokens` 筛选参数。

**SOL:** `sol`, `usdc`, `usd1`

**BSC:** `bnb`, `usdt`, `usdc`, `usd1`, `aster`, `u`

***

### 错误码

| 代码     | 含义          | 范围                                 | 建议操作                                                       |
| ------ | ----------- | ---------------------------------- | ---------------------------------------------------------- |
| `200`  | 成功          | 所有 API                             | —                                                          |
| `300`  | 服务器错误       | 数据查询 API（Feed、Token Query、Wallets） | 通知用户；稍后重试                                                  |
| `8060` | API Key 无效  | 所有 API                             | 在 [xxyy.io/apikey](https://www.xxyy.io/apikey) 检查并重新生成 Key |
| `8061` | API Key 已禁用 | 所有 API                             | 在 [xxyy.io/apikey](https://www.xxyy.io/apikey) 重新生成 Key    |
| `8062` | 频率限制        | 所有 API                             | 数据查询：等待 2 秒后重试。交易查询：等待 1 秒后重试。**不要重试失败的 Swap 请求**          |

***

### 区块浏览器 URL

使用这些 URL 模板从 `txId` 构建交易链接：

| 链    | URL 模板                           |
| ---- | -------------------------------- |
| SOL  | `https://solscan.io/tx/{txId}`   |
| ETH  | `https://etherscan.io/tx/{txId}` |
| BSC  | `https://bscscan.com/tx/{txId}`  |
| BASE | `https://basescan.org/tx/{txId}` |

***

### 最佳实践

#### 交易轮询

提交 Swap 后，以 **5 秒间隔**轮询 Query Trade 接口，**最多 3 次**以检查最终状态。不要无限轮询。

#### 错误处理

* **切勿**自动重试失败的 Swap 请求。向用户显示错误。
* 对于数据查询错误（`code: 300`），通知用户并建议稍后重试。
* 对于频率限制（`code: 8062`），从建议的等待时间开始实施指数退避。

#### 链-钱包验证

始终确保 `walletAddress` 与目标 `chain` 匹配。Solana（Base58）钱包不能用于 EVM 链交易，反之亦然。提交请求前验证地址格式。

#### 参数验证

调用 Swap 接口前，验证所有参数：

* `chain` 必须是 `sol`/`eth`/`bsc`/`base` 之一
* `isBuy` 必须是布尔值
* `amount` 买入时必须 > 0；卖出时必须在 1–100 之间
* `tip` 必须在目标链的推荐范围内
* `model`（如果提供）必须是 `1` 或 `2`
* `priorityFee`（如果提供）仅适用于 Solana

#### 安全性

* 将 API Key 存储在环境变量中；切勿硬编码。
* 如果怀疑任何泄露，请轮换 Key。
* 请注意，同一个 Key 同时控制读取和写入 — 像对待私钥一样谨慎对待它。

#### Feed 扫描

* Feed 仅支持 `sol` 和 `bsc` 链。
* 使用筛选参数缩小结果范围并减少响应大小。
* 构建持续监控时，在轮询轮次之间通过 `tokenAddress` 去重结果。

***

### 技术支持

* **API Key 管理**: <https://www.xxyy.io/apikey>
* **技术支持**: 私信 Twitter [@cryptopepace](https://x.com/cryptopepace)
