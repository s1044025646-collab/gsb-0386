# 懒标记段树：区间加法与最小值来源解释后端

纯后端项目（TypeScript + Node.js + SQLite），实现固定长度整数数组的
区间加法与区间最小值（含最左来源下标）查询，提供 HTTP API 与 CLI，
并对每次操作给出节点级解释（哪些区间被访问、直接命中、下推、合并）。

- 不依赖 Docker / WSL / 付费服务 / 外部在线 API，Windows 本地直接运行。
- SQLite 使用 Node 内置 `node:sqlite`（Node 22.5+），无需原生编译。
- 所有元素与加量以十进制整数字符串输入，内部用 BigInt 精确运算，
  负数与超过 `Number.MAX_SAFE_INTEGER` 的值均可正确处理。

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认自动选择空闲端口）
npm run demo       # 运行内置演示（含节点变化表）
```

CLI 直接用法（先 `npm run build`）：

```powershell
node dist/src/cli.js serve --port 8080 --data data
node dist/src/cli.js create --values "5,1,4,1"
node dist/src/cli.js add --id 1 --expect 0 --l 0 --r 3 --delta 2
node dist/src/cli.js add --id 1 --expect 1 --l 1 --r 4 --delta "-3"
node dist/src/cli.js query --id 1 --l 0 --r 4 --trace
node dist/src/cli.js explain --id 1 --version 2
node dist/src/cli.js export --id 1 --version 2
node dist/src/cli.js verify --id 1
```

## 核心概念

### 半开区间

所有区间均为半开 `[l, r)`：包含下标 `l`，不包含 `r`。`l === r` 为空区间：
空区间更新返回“未改变”，空区间查询返回“无最小值”（`null`，不是 0 或无穷大）。

### 懒标记含义

每个节点维护三个量：

- `min`：所代表区间的最小值，已经包含本节点自己的标记（解释中不会重复加）；
- `idx`：取得该最小值的最左下标（并列时永远取最左）；
- `tag`：已作用于本节点、但尚未下推给孩子的累计加量。

整段覆盖时直接 `min += delta; tag += delta`（标记累加，绝不覆盖旧标记）；
部分覆盖时先把 `tag` 下推给两个孩子再递归，返回时由孩子合并（同值取左）。
因此孩子的缓存值是“尚未包含祖先标记”的中间值，与最终逻辑值不同；
导出逻辑数组时会沿路径把未下推标记一并结算。

### 真实复杂度

- 区间更新 / 区间查询：每次最多访问 O(log n) 个节点；
- 导出整个逻辑数组：O(n)；
- 结构核验：O(n)（诊断入口，不是正常查询的替代实现）；
- 历史版本读取：回放前 v 条操作，O(v log n)。

### 结构核验

`verify` 递归展开到叶子，用“孩子缓存 + 路径累计标记”重新计算每个区间的
最小值与最左下标，逐节点核对树内缓存（不只比较根节点）。

## HTTP API

默认监听 `127.0.0.1`，`--port 0`（默认）自动选择空闲端口，启动时打印实际端口。
所有整数参数（元素、加量）均为十进制字符串；下标与版本为非负整数。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/arrays` | 创建数组 `{values: ["5","1","4","1"]}` 得到 `{id, version, n}` |
| POST | `/arrays/:id/updates` | 单次/批量区间加 `{expectedVersion, ops:[{l,r,delta}]}` |
| GET | `/arrays/:id/query?l=&r=&version=` | 查询最小值与最左下标（version 可省略=当前） |
| GET | `/arrays/:id/export?version=` | 导出指定版本逻辑数组 |
| GET | `/arrays/:id/operations/:version/explain` | 查看某次更新的节点级解释 |
| POST | `/arrays/:id/verify` | 结构核验 `{version?}` |

- 更新携带 `expectedVersion`，不符返回 409 拒绝；
- 批量更新先整体校验再整体应用，任一非法操作使整批回滚（版本与数据不变）；
- 查询与导出通过同一 `version` 参数定位同一个版本；
- 查询不创建业务版本，内部下推不改变逻辑数组。

### 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `EMPTY_ARRAY` | 400 | 空数组拒绝创建（长度限 1 到 100000） |
| `ARRAY_TOO_LARGE` | 400 | 超过长度上限 |
| `INVALID_INTEGER` | 400 | 非十进制整数字符串 |
| `INVALID_INDEX` | 400 | 下标/版本非法（含小数下标） |
| `OUT_OF_RANGE` | 400 | 区间越界 |
| `INVERTED_RANGE` | 400 | 左端点大于右端点 |
| `VERSION_MISMATCH` | 409 | 期望版本与当前版本不符 |
| `VERSION_NOT_FOUND` | 404 | 历史版本不存在 |
| `NOT_FOUND` | 404 | 数组/操作/路由不存在 |
| `EMPTY_BATCH` | 400 | 批量操作为空 |

## 持久化与重启

SQLite（项目内 `data/` 目录，可用 `--data` 更换）保存每个数组的初始快照与
操作日志（含每次操作的解释）。重启后通过确定性回放恢复段树状态——
包括尚未下推的懒标记效果——继续操作与不中断执行完全一致。
历史版本通过回放前 v 条操作恢复，未实现另一套持久化树算法。

## 演示

`npm run demo` 展示：

1. `[5,1,4,1]` 先 `[0,3)+2` 再 `[1,4)-3`，最终 `[7, 0, 3, -2]`，
   并打印每次更新的节点变化表（覆盖命中 / 下推 / 合并、标记与最小值前后值、来源下标）；
2. 并列最小值时取最左下标；
3. 全段更新后标记留在根未下推，局部查询触发下推的过程。

## 测试

`npm test` 覆盖：非二次幂长度、单元素、全段与窄段交错、负加量、
超过安全整数的大整数、空区间、版本不符与失败回滚、重启恢复、
解释内容、结构核验；并以普通数组逐元素操作作为独立基准做随机小样本对照
（每步比较多个区间的最小值与最左下标），验证“先加 a 再加 b 等价于加 a+b”。

## 目录结构

```
src/segtree.ts   懒标记段树核心（BigInt、解释追踪、结构核验）
src/store.ts     SQLite 持久化（快照 + 操作日志）
src/service.ts   业务层：校验、错误码、版本控制、批量原子性、回放
src/server.ts    HTTP API
src/cli.ts       命令行与演示
test/            node:test 测试
```

## 限制

- 仅支持区间加法与最小值查询，不支持插入/删除/区间赋值/其他聚合；
- 数组创建后长度固定，上限 100000；
- 历史版本通过回放恢复，版本极多时读取旧版本较慢；
- 服务为单进程本地服务，未做鉴权，请勿暴露到公网；
- `node:sqlite` 在 Node 25 仍标记为 experimental（会打印一条警告，不影响功能）。
