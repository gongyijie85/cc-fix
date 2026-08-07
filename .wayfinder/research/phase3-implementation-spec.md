# Phase 3 实施规格：修复过程可视化

> 决策完备，可直接按此规格实施。本规格汇总地图 [#1](https://github.com/gongyijie85/cc-fix/issues/1) 的全部决议（12 条锁定决策 + [#2](https://github.com/gongyijie85/cc-fix/issues/2) UI 形态 + [#3](https://github.com/gongyijie85/cc-fix/issues/3) 协议设计）。

## 1. 统一事件层类型定义

新模块 `src/events/types.ts`：

```ts
import type { SignalResult, CheckResponse } from "../detection/types.js";

export type FixEvent =
  | { type: "step-start"; stepId: string; name: string; oldValue?: string; newValue?: string; rollback?: boolean }
  | { type: "step-ok";    stepId: string; rollback?: boolean }
  | { type: "step-fail";  stepId: string; error: string; rollback?: boolean }
  | { type: "summary";    ok: number; fail: number; rolledBack: boolean; fatal?: boolean }
  | { type: "recheck";    before: number; after: number };

export type DetectEvent =
  | { type: "phase";       label: string }
  | { type: "detect-start" }
  | { type: "detect-ok";   signal: SignalResult }
  | { type: "detect-done"; response: CheckResponse };

export type StreamEvent = FixEvent | DetectEvent;

export type EventConsumer = (event: StreamEvent) => void;
```

**导出**：`export * from "./events/types.js"` 在 `src/index.ts` 或需要消费事件的模块中引入。

**扩展方式**：新增事件种类（`type` 字段新值），不预留字段、不加时间戳。

---

## 2. 编排层：`src/fix/flow.ts`

新模块，导出两个编排函数，消除 `server.ts` 和 `index.ts` 的重复拼装逻辑。

### 2.1 `persistOnFlow`

```ts
export interface PersistOnOptions {
  regionCode: RegionCode;
  targetTimezone: string;
  targetLang: string;
}

export async function persistOnFlow(
  opts: PersistOnOptions,
  onEvent: EventConsumer
): Promise<void> {
  const envKeys = ["TZ", "LANG", "LC_ALL"];
  const changedKeys: string[] = [];

  // 步骤 1：备份
  onEvent({ type: "step-start", stepId: "backup", name: "创建环境变量备份" });
  const backup = createBackup(envKeys);
  onEvent({ type: "step-ok", stepId: "backup" });

  // 步骤 2-N：逐个设置环境变量
  const steps: Array<{ key: string; value: string; stepId: string; name: string }> = [
    { key: "TZ",     value: opts.targetTimezone, stepId: "tz",   name: "设置时区 TZ" },
    { key: "LANG",   value: opts.targetLang,     stepId: "lang", name: "设置语言 LANG" },
    { key: "LC_ALL", value: opts.targetLang,     stepId: "lc",   name: "设置 LC_ALL" },
  ];

  for (const step of steps) {
    const oldValue = getEnvVar(step.key) ?? "(未设置)";
    onEvent({ type: "step-start", stepId: step.stepId, name: step.name, oldValue, newValue: step.value });
    try {
      setEnvVar(step.key, step.value);
      changedKeys.push(step.key);
      onEvent({ type: "step-ok", stepId: step.stepId });
    } catch (err) {
      onEvent({ type: "step-fail", stepId: step.stepId, error: String(err) });
      // 回滚：只回滚已成功修改过的键
      await rollbackFlow(changedKeys, backup, onEvent);
      onEvent({ type: "summary", ok: changedKeys.length, fail: 1, rolledBack: true });
      return;
    }
  }

  onEvent({ type: "summary", ok: steps.length, fail: 0, rolledBack: false });
}
```

### 2.2 `persistOffFlow`

```ts
export async function persistOffFlow(onEvent: EventConsumer): Promise<void> {
  const status = getPersistStatus();
  if (!status.enabled || !status.backup) {
    onEvent({ type: "step-fail", stepId: "check", error: "持久化未开启" });
    onEvent({ type: "summary", ok: 0, fail: 1, rolledBack: false, fatal: true });
    return;
  }

  const backup = status.backup;
  const keys = Object.keys(backup.previous);

  for (const key of keys) {
    const oldValue = getEnvVar(key) ?? "(未设置)";
    const newValue = backup.previous[key] ?? "(未设置)";
    onEvent({ type: "step-start", stepId: `restore-${key}`, name: `恢复 ${key}`, oldValue, newValue });
    try {
      if (backup.previous[key] === null) {
        deleteEnvVar(key);
      } else {
        setEnvVar(key, backup.previous[key]!);
      }
      onEvent({ type: "step-ok", stepId: `restore-${key}` });
    } catch (err) {
      onEvent({ type: "step-fail", stepId: `restore-${key}`, error: String(err) });
      onEvent({ type: "summary", ok: keys.indexOf(key), fail: 1, rolledBack: false, fatal: true });
      return;
    }
  }

  // 删除备份文件
  onEvent({ type: "step-start", stepId: "delete-backup", name: "删除备份文件" });
  try {
    const backupFile = path.join(process.env.APPDATA || "", "cc-fix", "persist-backup.json");
    if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
    onEvent({ type: "step-ok", stepId: "delete-backup" });
  } catch (err) {
    onEvent({ type: "step-fail", stepId: "delete-backup", error: String(err) });
    onEvent({ type: "summary", ok: keys.length, fail: 1, rolledBack: false, fatal: true });
    return;
  }

  onEvent({ type: "summary", ok: keys.length + 1, fail: 0, rolledBack: false });
}
```

### 2.3 `rollbackFlow`（内部辅助）

```ts
async function rollbackFlow(
  changedKeys: string[],
  backup: BackupData,
  onEvent: EventConsumer
): Promise<void> {
  for (const key of changedKeys) {
    const oldValue = getEnvVar(key) ?? "(未设置)";
    const newValue = backup.previous[key] ?? "(未设置)";
    onEvent({ type: "step-start", stepId: `rollback-${key}`, name: `回滚 ${key}`, oldValue, newValue, rollback: true });
    try {
      if (backup.previous[key] === null) {
        deleteEnvVar(key);
      } else {
        setEnvVar(key, backup.previous[key]!);
      }
      onEvent({ type: "step-ok", stepId: `rollback-${key}`, rollback: true });
    } catch (err) {
      onEvent({ type: "step-fail", stepId: `rollback-${key}`, error: String(err), rollback: true });
      // fatal：回滚失败，需手动检查
      return;
    }
  }
}
```

### 2.4 `runDetection` 改造

`src/detection/runner.ts` 的 `runDetection` 加可选 `onEvent` 参数：

```ts
export async function runDetection(
  regionCode: RegionCode,
  targetTimezone: string,
  targetLang: string,
  ipIntel: IpIntelligence | null,
  onEvent?: EventConsumer  // 新增
): Promise<CheckResponse> {
  // 阶段：IP 情报
  if (onEvent) onEvent({ type: "phase", label: "正在获取 IP 情报…" });
  // （IP 情报已在调用前获取，此处只是占位）

  if (onEvent) onEvent({ type: "detect-start" });

  // 原有逻辑：Promise.all 并行跑插件
  const signals: SignalResult[] = await Promise.all(
    plugins.map(async (plugin) => {
      const result = await plugin.run(context);
      if (onEvent) onEvent({ type: "detect-ok", signal: result });
      return result;
    })
  );

  // IP 派生信号
  if (ipIntel) {
    if (ipIntel.ipType === "datacenter") {
      const sig = { id: "ip-datacenter", ... };
      signals.push(sig);
      if (onEvent) onEvent({ type: "detect-ok", signal: sig });
    }
    if (!ipIntel.multiSourceConsistent) {
      const sig = { id: "ip-multi-source", ... };
      signals.push(sig);
      if (onEvent) onEvent({ type: "detect-ok", signal: sig });
    }
  }

  const response = buildCheckResponse(signals, ipIntel, regionCode);
  if (onEvent) onEvent({ type: "detect-done", response });
  return response;
}
```

---

## 3. `src/gui/server.ts`：SSE 端点与锁

### 3.1 常驻通道

```ts
let busy = false;
const clients = new Set<http.ServerResponse>();

function broadcast(event: StreamEvent) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    res.write(data);
  }
}

// GET /api/events
if (method === "GET" && url.pathname === "/api/events") {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
  return;
}
```

### 3.2 触发端点

```ts
// POST /api/fix/on
if (method === "POST" && url.pathname === "/api/fix/on") {
  if (busy) { sendJson(res, { error: "操作进行中" }, 409); return; }
  busy = true;
  res.writeHead(202); res.end();
  const target = getTargetRegion(DEFAULT_REGION);
  await persistOnFlow({ regionCode: "auto", targetTimezone: target.timezone, targetLang: target.lang }, broadcast);
  busy = false;
  return;
}

// POST /api/fix/off
if (method === "POST" && url.pathname === "/api/fix/off") {
  if (busy) { sendJson(res, { error: "操作进行中" }, 409); return; }
  busy = true;
  res.writeHead(202); res.end();
  await persistOffFlow(broadcast);
  busy = false;
  return;
}

// POST /api/check/start
if (method === "POST" && url.pathname === "/api/check/start") {
  if (busy) { sendJson(res, { error: "操作进行中" }, 409); return; }
  busy = true;
  res.writeHead(202); res.end();
  const target = getTargetRegion(DEFAULT_REGION);
  const ipIntel = await fetchIpIntelligence();
  await runDetection("auto", target.timezone, target.lang, ipIntel, broadcast);
  busy = false;
  return;
}
```

### 3.3 删除旧端点

删除 `GET /api/check`、`POST /api/persist/on`、`POST /api/persist/off`。

---

## 4. `src/gui/index.html`：前端流渲染

按 [#2 决议](https://github.com/gongyijie85/cc-fix/issues/2) 采用变体 B（步骤清单卡片）。

### 4.1 EventSource 连接

```js
const evtSource = new EventSource("/api/events");
evtSource.onmessage = (e) => {
  const event = JSON.parse(e.data);
  handleEvent(event);
};
```

### 4.2 事件处理

```js
function handleEvent(event) {
  if (event.type === "step-start") {
    ensureFixCard();
    stepList.insertAdjacentHTML("beforeend", stepRow(event));
  }
  if (event.type === "step-ok") updateStep(event.stepId, "ok", event.rollback);
  if (event.type === "step-fail") updateStep(event.stepId, "fail", event.rollback, event.error);
  if (event.type === "summary") showSummary(event);
  if (event.type === "recheck") showScoreDelta(event);
  if (event.type === "detect-start") buildDetectTable();
  if (event.type === "detect-ok") fillDetectRow(event.signal);
  if (event.type === "detect-done") renderCheckResponse(event.response);
}
```

### 4.3 按钮禁用

```js
function setButtonsDisabled(d) {
  ["btnOn", "btnOff", "btnRefresh"].forEach(id => document.getElementById(id).disabled = d);
}

// 触发时禁用
async function persistOn() {
  setButtonsDisabled(true);
  await fetch("/api/fix/on", { method: "POST" });
  // 事件流驱动 UI 更新，按钮在 summary 事件后恢复
}
```

### 4.4 自动复测

`summary` 事件后（`fail === 0`），自动触发检测：

```js
if (event.type === "summary" && event.fail === 0) {
  setTimeout(() => fetch("/api/check/start", { method: "POST" }), 500);
}
```

---

## 5. CLI 端事件打印

`src/index.ts` 的 `persist on` 命令改为：

```ts
.action(async (options) => {
  const target = getTargetRegion(options.region);
  await persistOnFlow(
    { regionCode: options.region, targetTimezone: target.timezone, targetLang: target.lang },
    (event) => {
      if (event.type === "step-start") console.log(chalk.dim(`▶ ${event.name}…`));
      if (event.type === "step-ok")    console.log(chalk.green(`✓ ${event.stepId}`));
      if (event.type === "step-fail")  console.log(chalk.red(`✗ ${event.stepId}: ${event.error}`));
      if (event.type === "summary") {
        if (event.fatal) console.log(chalk.red.bold(`══ 致命错误，需手动检查 HKCU\\Environment ══`));
        else console.log(chalk.dim(`══ ${event.ok} 成功 · ${event.fail} 失败${event.rolledBack ? " · 已回滚" : ""} ══`));
        console.log(chalk.dim("运行 `cc-fix check` 验证效果"));
      }
    }
  );
});
```

`persist off` 和 `check` 同理。

---

## 6. 测试要点

### 6.1 事件 schema

- `src/events/types.test.ts`：类型断言，确保联合类型穷尽检查生效

### 6.2 编排层

- `src/fix/flow.test.ts`：
  - `persistOnFlow` 成功流程：mock `setEnvVar`，验证事件序列（step-start/ok × 4 + summary）
  - `persistOnFlow` 失败流程：mock `setEnvVar` 第二次抛异常，验证回滚步骤进流（rollback:true）+ summary rolledBack:true
  - `persistOffFlow`：mock `getPersistStatus` + `restoreBackup`，验证逐键恢复事件

### 6.3 SSE 端点

- `src/gui/server.test.ts`：
  - `GET /api/events` 返回 SSE 流
  - `POST /api/fix/on` 触发事件流，busy 时返回 409
  - 断连不中断修复（mock 客户端断开，验证服务端继续执行）

### 6.4 前端

- 手动测试（原型已验证变体 B 形态）

### 6.5 CLI

- `src/index.test.ts`：mock `persistOnFlow`，验证 chalk 输出格式

---

## 实施顺序建议

1. `src/events/types.ts`（类型定义，无运行时依赖）
2. `src/fix/flow.ts`（编排层，依赖 windows.ts 原子函数）
3. `src/detection/runner.ts` 改造（加 onEvent 参数）
4. `src/gui/server.ts` 改造（SSE + 触发端点 + 删旧端点）
5. `src/gui/index.html` 改造（EventSource + 变体 B 渲染）
6. `src/index.ts` 改造（CLI 消费事件）
7. 测试（按上述顺序逐项补测试）
