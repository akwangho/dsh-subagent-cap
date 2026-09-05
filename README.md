# dsh-subagent-cap

限制**單一會話（session）**中「同時執行」的 subagent 總數，可由使用者在設定頁動態調整，**預設為 1**，並支援「拒絕」或「排隊等待」兩種達上限策略。設定透過 DSH 的 settings 機制寫入 `~/.dsh/settings.yaml`，跨會話／重啟程序皆保留。

> 這是一個**可安裝的獨立 DSH plugin**（非動態外掛）。安裝後會掛載到你的 profile，重啟 `dsh web` 後生效。

## 功能與限制層次

| 層 | 機制 | 作用 |
| --- | --- | --- |
| 1 | `systemPrompt.context()` | 命令式引導：告知模型目前上限與已用數量 |
| 2 | `tools/pre-execute` waterfall | **真正的預先阻擋**：委派工具執行前檢查，達上限即 `deny`（拒絕）或排隊 |
| 3 | `subagent/start` | 安全網：觀察發布（主要門檻在層 2） |

- **拒絕模式（預設）**：達上限時，`subagent` / `subagent_fork` / `workflow` 委派會被 `deny`，並附原因文字。
- **排隊模式**：達上限時回傳 `deny` + 說明「請等現有 subagent 完成後重試」；模型依照引導在空位釋出後自行重試。

## 設定項目

| 項目 | 說明 | 預設 |
| --- | --- | --- |
| 每個會話最大 subagent 數 | 同時執行上限（0–100，0＝禁止新委派） | 1 |
| 達上限策略 | `reject`（拒絕）或 `queue`（排隊） | reject |

## 檔案結構

```
dsh-subagent-cap/
├── package.json        # name/exports/dsh.bundle.patch/dsh.client + peerDeps
├── cordis.patch.yml    # loader insert entry (id + name)
├── tsconfig.json       # TypeScript 建置設定（src -> lib）
├── LICENSE
├── README.md
├── src/
│   ├── index.ts        # Host 半部（TypeScript 源碼）
│   └── client.ts       # Client 半部（TypeScript 源碼）
└── lib/
    ├── index.js        # Host 半部（編譯後，runtime 載入）
    └── client.js       # Client 半部（編譯後，runtime 載入）
```

## 安裝

1. 把這個 package 放進 profile 的 `node_modules`：
   ```sh
   ln -s /path/to/dsh-subagent-cap ~/.dsh/profiles/web/node_modules/dsh-subagent-cap
   ```
2. 在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 加入 `"dsh-subagent-cap"`。
3. `cordis.patch.yml`（package 內建）會被 bundle 層套用，注入 loader entry。
4. 重啟 `dsh web`。

## Host⇄Client 通訊

Host 註冊一個 Typert Remote service（namespace `subagentCap`），暴露 `getState` / `setMax` / `setMode`；Client 透過 Connection RPC（`/api`）呼叫。

## 運作原理（數量檢查邏輯）

```
模型即將執行 subagent / subagent_fork / workflow
   └─> tools/pre-execute waterfall（在 dispatch 之前）
         └─> 判斷 exec.name 是否為委派工具
               └─> subagents.listChildren(parentId) 計算 running 數
                     ├─ running < 上限  → next() 放行
                     └─ running >= 上限 → 依模式：
                          ├─ reject → deny(reason)           （拒絕）
                          └─ queue  → deny(排隊提示)          （模型稍後重試）
```

## 備註

- `tools/pre-execute` 是 scope-filtered 的 waterfall，最後一個參數是 `next`；只攔截委派工具，其餘工具一律回傳 `next()`，不影響其他功能。
- `listChildren` 的 `activity === 'running'` 才是「同時執行中」；已結束的 child 不佔名額。