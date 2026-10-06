# 懒标记段树后端（区间加 + 最左最小值）

仅后端（HTTP API + CLI），使用 TypeScript、Node.js 和内置 SQLite（`node:sqlite`）实现，
在 Windows 本地直接运行，**不需要 Docker、WSL、付费服务或任何在线 API**，除 TypeScript 类型包外零第三方运行时依赖。

## 1. 功能与边界

- 固定长度整数数组（长度 1 ～ 100000，空数组拒绝），创建后长度不变。
- 仅两种操作：
  - 半开区间 `[l, r)` 整体加一个整数；
  - 查询半开区间内的**最小值**和**最靠左**的取得位置（下标从 0 开始）。
- 元素与加量一律用**十进制整数字符串**输入输出，内部全程 `BigInt`，支持负数与超过
  `Number.MAX_SAFE_INTEGER` 的值，无浮点误差。
- 不支持插入、删除、区间赋值、其他聚合、时间窗口等。
- 核心数据结构为**自行实现的懒标记段树**，不调用任何现成区间结构库，
  更新/查询复杂度 `O(log n)`，不会逐元素改动区间或每次重建整棵树。

## 2. 半开区间与空区间语义

- 所有区间写作 `[l, r)`，覆盖下标 `l, l+1, …, r-1`，共 `r-l` 个元素。
- `l === r` 是空区间：
  - 空区间**更新**：合法，返回 `unchanged: true`，数组不变、**不产生新版本**；
  - 空区间**查询**：返回 `min: null, pos: null`（表示“无最小值”），
    不是 0，代码内部也不使用可被误用的数值无穷大。
- `l > r` 报 `L_GT_R`；越界报 `INDEX_OUT_OF_BOUNDS`；小数/负数下标报 `INVALID_INDEX`。

## 3. 懒标记含义（重要）

每个节点保存三个量：

| 字段 | 含义 |
| --- | --- |
| `mn[v]` | 该节点区间的当前最小值，**已经包含本节点的 `lazy[v]`**，读它时不要再加一遍 |
| `pos[v]` | 该最小值对应的最左下标；多个位置并列时始终靠左 |
| `lazy[v]` | 只作用于整段、**尚未传给孩子**的累计加量 |

关键规则：

- **整段覆盖**：`mn[v] += d; lazy[v] += d`。标记是**累加**的，重叠更新绝不会用新值覆盖旧值。
  最左来源下标不变（整段平移不改变谁最小）。
- **部分覆盖**：先 `push`（把 `lazy[v]` 累加给两个孩子并清零本节点标记，本节点 `mn` 不变），
  递归处理相交的孩子，再 `pull`（比较孩子：`mn` 较小者胜，相等取左孩子的 `pos`）。
- 孩子缓存 `mn[child]` **不含**父节点未下传的标记；必须先 push 才能用孩子合并。
- **查询是只读的**：部分覆盖时不下推、不改树，而是把孩子候选临时加上沿途未传标记再比较；
  因此即使根节点有全段标记，局部查询也正确，且树的持久化状态与逻辑数组都不变。

## 4. 持久化与版本

SQLite 文件默认在项目内 `./data/`（CLI 用 `data/cli-segment-tree.db`，服务用 `data/segment-tree.db`）。

- `arrays`：数组元信息与初始值；
- `snapshots`：**最新整棵树的序列化快照（含尚未下推的 lazy 标记）** + 当前版本号；
- `operations`：每次更新的参数与完整操作解释（访问轨迹），`(array_id, version)` 唯一。

语义：

- 更新必须带 `expectedVersion`，与当前版本不符返回 `VERSION_MISMATCH` 并拒绝；
  服务端用“条件 UPDATE + 事务”提交，版本不符时整笔（含整批）回滚。
- 批量 `batch-add`：先校验全部参数，任一非法（越界、颠倒、非法整数等）直接拒绝、零改动；
  内存应用成功后用**一次事务**提交，提交失败同样整体回滚。
- 查询/导出不创建版本；`?version=k` 或 CLI 的版本参数可读取**历史版本**：
  从初始数组按操作日志**回放**恢复（历史版本不另存一套持久化树算法）。
- 重启后直接加载最新快照，**未下推的标记效果完整保留**，继续操作与从未中断一致。

## 5. 结构核验（诊断入口）

`POST /api/arrays/:id/verify` 或 `npm run cli -- verify <id>` 会递归展开全部节点到叶子，
独立重算每个区间的最小值与最左下标，逐节点核对缓存的 `mn`、`pos` 与累计 `lazy` 是否一致
（而不是只比根节点）。它是诊断手段，不是正常查询的替代实现；正常查询仍是 `O(log n)`。

## 6. 环境要求

- Node.js **22.5+**（开发与验证使用 Node v25.5.0，内置 `node:sqlite` 与 TypeScript 类型擦除）。
- Windows PowerShell；网络只用于 `npm install` 拉取 TypeScript 类型包。

## 7. 构建、测试、启动、演示

```powershell
npm install        # 仅安装 typescript 与 @types/node
npm run build      # tsc 类型检查并输出到 dist/
npm test           # node:test，12 个测试文件用例
npm run demo       # CLI 内置演示（见下）
npm start          # 启动 HTTP 服务，默认端口 0 = 自动选择空闲端口
npm run cli -- --help
```

可选环境变量：`PORT`（默认 `0` 空闲端口）、`HOST`（默认 `127.0.0.1`）、`DATA_DIR`（默认 `./data`）。
启动后第一行输出 JSON，其中 `port` 即实际端口。

## 8. HTTP API

统一返回 `{ "data": ... }`；错误返回 HTTP 400 与
`{ "error": { "code", "message", "details" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/arrays` | 创建：`{id,length,values?}`，`values` 为等长十进制字符串数组，省略则全 0 |
| GET | `/api/arrays/:id` | 元信息（含当前版本） |
| POST | `/api/arrays/:id/add` | 单次加：`{expectedVersion,l,r,delta}` |
| POST | `/api/arrays/:id/batch-add` | 批量：`{expectedVersion,ops:[{l,r,delta},…]}`，一个事务 |
| GET | `/api/arrays/:id/query?l=&r=&version=` | 查最小值与最左位置；`version` 省略=最新 |
| GET | `/api/arrays/:id/operations/:version` | 查看某次更新的解释轨迹 |
| GET | `/api/arrays/:id/versions` | 列出历史版本 |
| GET | `/api/arrays/:id/export?version=` | 导出逻辑数组 |
| POST | `/api/arrays/:id/verify` | 独立结构核验 |
| GET | `/health` | 健康检查 |

PowerShell 调用示例：

```powershell
npm start                       # 记下输出里的 port，例如 50240
$b = "http://127.0.0.1:50240"
Invoke-RestMethod -Method Post "$b/api/arrays" -ContentType 'application/json' `
  -Body '{"id":"demo","length":4,"values":["5","1","4","1"]}'
Invoke-RestMethod -Method Post "$b/api/arrays/demo/add" -ContentType 'application/json' `
  -Body '{"expectedVersion":0,"l":0,"r":3,"delta":"2"}'
Invoke-RestMethod -Method Post "$b/api/arrays/demo/add" -ContentType 'application/json' `
  -Body '{"expectedVersion":1,"l":1,"r":4,"delta":"-3"}'
Invoke-RestMethod "$b/api/arrays/demo/query?l=0&r=4"
Invoke-RestMethod "$b/api/arrays/demo/export"
Invoke-RestMethod -Method Post "$b/api/arrays/demo/verify"
Invoke-RestMethod "$b/api/arrays/demo/operations/2"
```

## 9. CLI

```powershell
npm run cli -- create a 4 5,1,4,1
npm run cli -- add a 0 0 3 2          # id expectedVersion l r delta
npm run cli -- add a 1 1 4 -3
npm run cli -- query a 0 4
npm run cli -- batch a 2 "[{\"l\":0,\"r\":2,\"delta\":\"1\"},{\"l\":3,\"r\":4,\"delta\":\"-5\"}]"
npm run cli -- explain a 1            # 打印该次操作的节点变化表
npm run cli -- export a 1             # 导出指定版本
npm run cli -- verify a
npm run cli -- versions a
npm run demo                          # 内置 6 组演示
```

CLI 的 `add` / `explain` 会打印**节点变化表**：每行是一个访问事件
（`enter` 进入、`full-cover` 整段命中、`push` 下推、`recurse-left/right` 递归、`merge` 合并、
`query-hit/miss` 查询命中/空区间），并显示该节点 `lazy`、`min`、`pos` 的前后值与中文说明。

## 10. 内置演示与测试覆盖

`npm run demo` 演示：

1. `[5,1,4,1]` → `[0,3)+2` → `[1,4)-3` ⇒ 最终 `[7,0,3,-2]`，最小 `-2@3`；
2. `[3,1,1,1,2]` 并列最小选最左（`1@1`）；
3. 全段 `+10` 标记停在根节点未下推时，只查 `[0,2)` 仍得 `10@0`，且查询前后核验均通过；
4. 历史版本回放（v0/v1/v2 导出对比）；
5. 批量中含左右颠倒操作时整批回滚，版本与数组不变；
6. 超过安全整数的大整数精确运算。

`npm test` 覆盖：非二次幂长度（1,2,3,5,6,7,9,10,100）、单元素、全段与窄段交错、
负加量、大整数、空区间、失败回滚、重启后未下推效果保留与历史版本回放；
并用**普通数组逐元素操作作为独立基准**，200 步随机更新中每步对多个区间比较最小值与最左下标，
同时每步运行全树结构核验；另外验证“先加 a 再加 b”与“加 a+b”完全等价。

## 11. 错误码

| code | 触发场景 |
| --- | --- |
| `ARRAY_NOT_FOUND` / `ARRAY_ALREADY_EXISTS` | 数组不存在 / id 已存在 |
| `EMPTY_ARRAY` / `LENGTH_OUT_OF_RANGE` | 长度 0 或超出 1～100000 |
| `INVALID_INTEGER` | 十进制整数字符串非法（小数、科学计数法、空串等） |
| `INVALID_INDEX` | 下标不是非负安全整数（含小数） |
| `INDEX_OUT_OF_BOUNDS` | `l`/`r` 超出 `[0,length]` |
| `L_GT_R` | 半开区间左右颠倒 |
| `EMPTY_INTERVAL_UPDATE` / `EMPTY_INTERVAL_QUERY` | 空区间语义（当前实现以 `unchanged`/`null` 表达） |
| `VERSION_MISMATCH` | 更新期望版本与当前版本不一致（含批量整体回滚） |
| `OP_NOT_FOUND` / `VERSION_NOT_FOUND` | 操作或历史版本不存在 |
| `BATCH_REJECTED` | 批量参数非法 |
| `VALIDATION_ERROR` | JSON、id、请求体等通用校验失败 |
| `VERIFY_FAILED` | 独立结构核验发现树内缓存/标记不一致 |

## 12. 复杂度与已知限制

- 更新、区间查询：`O(log n)`；导出逻辑数组：`O(n)`；结构核验：`O(n)`；历史版本回放：`O(k log n)`（`k` 为操作数，批量按子操作计）。
- 树快照含约 `4n` 个节点的三个数组，随每次更新整体序列化一次；对 10 万元素与学习/诊断场景足够，
  超高频写入或更大规模可改为脏节点增量持久化（本项目刻意保持实现直白可读）。
- 仅监听本机回环地址，无鉴权、无并发多写队列（SQLite 写事务本身串行；高并发写调用方应按版本重试）。
- Node 运行时会打印 `node:sqlite` / transform-types 的实验性警告，属正常现象。
