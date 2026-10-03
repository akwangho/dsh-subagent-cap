# dsh-subagent-cap

限制**單一會話（session）**中「同時執行」的 subagent 總數，可由使用者在設定頁動態調整，**預設為 1**，並支援「拒絕」或「排隊等待」兩種達上限策略。設定是一般的 **volatile plugin Config**，由 DSH 寫回 profile 的 `cordis.patch.yml`，跨會話／重啟程序皆保留。

> 這是一個**可安裝的獨立 DSH plugin**（非動態外掛）。安裝後會掛載到你的 profile，重啟 `dsh web` 後生效。

## 功能與限制層次

| 層 | 機制 | 作用 |
| --- | --- | --- |
| 1 | `systemPrompt.context()` | 命令式引導：告知模型目前上限與已用數量 |
| 2 | `tools/pre-execute` waterfall | **真正的預先阻擋**：委派工具執行前檢查，達上限即 `deny`（拒絕）或排隊 |
| 3 | `subagent/start` | 安全網：觀察發布（主要門檻在層 2） |

- **拒絕模式（預設）**：達上限時，`subagent` / `subagent_fork` / `workflow` 委派會被 `deny`，並附原因文字。
- **排隊模式**：達上限時**真的把 `tools/pre-execute` 的 waterfall 決策掛住**（不 deny），等 `subagent/end` 或該次呼叫 settle 釋出名額後再依 FIFO 放行；等待期間若呼叫被 abort 則取消並 deny。
- **模式切換不會卡住**：把策略從 `queue` 切成 `reject` 時，**即使當下仍然滿載**，所有排隊中的委派也會立刻被 deny（模式檢查先於名額檢查），不會繼續懸著等到有名額才釋放。

## 設定項目

| 項目 | 說明 | 預設 |
| --- | --- | --- |
| 每個會話最大 subagent 數 | 同時執行上限（0–100，0＝禁止新委派） | 1 |
| 達上限策略 | `reject`（拒絕）或 `queue`（排隊） | reject |

## 設定如何儲存（volatile Config）

- `lib/config.js` 宣告 `Config`，兩個欄位（`maxSubagents`、`mode`）都是 `.volatile()`：
  - DSH 的 `settings` service **只**把 volatile 欄位投影成可編輯表單，所以設定頁才存得下。
  - Loader 把變更**寫進執行中的 reference**（`loader/volatile-update`）而**不重新掛載外掛**——這點對本外掛特別重要：重新掛載會清掉配額器的 `inFlight` 計數，讓所有被掛住的排隊委派永久懸空。
- 儲存位置是 profile 的 `cordis.patch.yml`（DSH 自己寫回），不是外掛的檔案。
- Host 半部只**讀取** config（`loader/volatile-update` / `settings/document-updated` 時重讀），並呼叫 `settings.configure({ auto: false }, ctx.fiber)` 告訴 DSH「這支外掛自帶設定頁」，避免重複自動產生一份。
- Browser 半部透過 `ctx.configForms.get('subagent-cap')` 讀寫，與第一方外掛同一套路徑。設定**不再**走本外掛自己的 Remote（`setMax` / `setMode` 已移除）；Remote 現在只帶執行狀態（queue 深度、in-flight、最近被拒絕的委派）。
- **namespace 必須等於 profile entry id**，也就是 `cordis.patch.yml` 裡的 `id: subagent-cap`。改了 id 的話設定頁會顯示紅色診斷，而不是安靜地存不進去。

## DSH 版本相容性

DSH 掛載 profile 外掛前會做**相容性預檢**：不執行外掛程式碼，只讀 `peerDependencies`，把 `@deepseek-ai/dsh*` 的 peer 跟目前 DSH 版本比對，**一個不符就整個停用**（stderr 印一行，UI 上外掛完全消失）：

```text
dsh: disabling profile plugin row "subagent-cap": Plugin
dsh-subagent-cap@1.2.2 is incompatible with dsh 0.2.0-rc.2: peerDependencies {...}
```

這正是 1.2.x 在 DSH 從 0.1.x 升到 0.2.x 之後「看不見」的原因：peer 寫成 `^0.1.2-rc.1` / `^0.1.0-rc.6`，而 0.x 的 caret 只允許同一個 minor。因此本外掛一律使用涵蓋整條 0.x 的明確範圍（`>=0.1.2-rc.1 <1.0.0`），`test/manifest.test.mjs` 會直接對 `package.json` 守住這條規則。

- 已驗證可載入：`0.1.2-rc.1`、`0.1.2-rc.8`、`0.2.0-rc.2`、`0.2.0`、`0.3.0-rc.1`、`0.9.9`。
- DSH `1.x` 刻意不相容：那時需要重新稽核 API。
- `@deepseek-ai/dsh-client-runtime` 在 0.2 已移除，已從 `dsh.client.inject` 移除。
- Browser 半部的 `inject` 現在包含 `remote` 與 `configForms`（由 `@deepseek-ai/dsh-client-ui-settings` 提供）。這與第一方外掛（如 `dsh-client-ui-theme`）一致：**沒有設定服務就沒有地方持久化**，所以整個 client 半部不會啟動。若你的 profile 刻意不含設定 UI 套件，設定頁會整個消失（此時 Cordis 不會啟動 fiber，連診斷框都畫不出來）。標準 `web` profile 都含這個套件。

## 自我診斷

外掛若載入失敗不會再無聲消失：設定頁會列出紅色診斷（缺少 `configForms` / `slots`、namespace 對不上、Host RPC 失敗等）；連設定頁都註冊不起來時，畫面左下角會出現固定的小紅框。各個 UI 註冊彼此獨立，一項失敗不會連帶讓其他項消失。

## 檔案結構

```
dsh-subagent-cap/
├── package.json        # name/exports/dsh.client + peerDeps
├── tsconfig.json       # TypeScript 建置設定（src -> lib）
├── LICENSE
├── README.md
├── locale/             # 在「設定 → 外掛」清單中的顯示名稱／說明
│   ├── en.json
│   └── zh.json
├── src/
│   ├── index.ts        # Host 半部（TypeScript 源碼）
│   └── client.ts       # Client 半部（TypeScript 源碼）
└── lib/
    ├── index.js        # Host 半部（runtime 載入）：Remote 服務 + 配額器
    ├── config.js       # volatile Config schema 與 settings namespace
    ├── pure.js         # 純函式（sanitize/canAdmit/denyReason/isDelegateTool）
    └── client.js       # Client 半部：設定 section
```

## 安裝

1. 把編譯好的 `lib/`、`package.json`、`README.md`、`LICENSE` 複製進 profile 的 `node_modules`：
   ```sh
   PKG=~/.dsh/profiles/web/node_modules/dsh-subagent-cap
   mkdir -p "$PKG/lib"
   cp lib/index.js lib/client.js "$PKG/lib/"
   cp package.json README.md LICENSE "$PKG/"
   ```
   > 不要用 `ln -s` 把整個 repo 連進 `node_modules`：Node ESM 會從 symlink 的真實路徑去解析 bare import（如 `@deepseek-ai/dsh-typert-protocol`），而 repo 內沒有 `node_modules`，`dsh web` 啟動時會 `plugin tree failed to load`。複製進 `node_modules` 的檔案則會沿 `~/.dsh/profiles/node_modules` 解析到與 Host 相同的模組實例。
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 註冊 loader entry：
   ```yaml
   - insert:
       - id: subagent-cap
         name: 'dsh-subagent-cap'
   ```
3. 重啟 `dsh web`。（設定頁會出現「Subagent 上限」卡片；預設每會話 1 個、拒絕模式。）

## Host⇄Client 通訊

兩條通道，刻意分開：

- **執行狀態**：Host 註冊 Typert Remote service（namespace `subagentCap`），只暴露 `getState`（queue 深度、in-flight、最近被拒絕的委派、版本）。Client 透過 Connection RPC（`/api`）讀取，並以 1 秒輪詢保持 live。
- **設定**：`maxSubagents` / `mode` **不走**這條通道。它們是 Host 的 volatile Config，Client 透過 `ctx.configForms.get('subagent-cap')` 讀寫，由 DSH 寫回 profile patch。

`setMax` / `setMode` 已移除：設定的所有權只有一份，就是 Host 的 Config；再留一條外掛自己的寫入通道只會產生兩個真相來源。

## 運作原理（數量檢查邏輯）

```
模型即將執行 subagent / subagent_fork / workflow
   └─> tools/pre-execute waterfall（在 dispatch 之前）
         └─> 判斷 exec.name 是否為委派工具
               └─> subagents.listChildren(parentId) 計算 running 數
                     └─> 佔用 = running + inFlight（已放行但尚未 settle）
                           ├─ 佔用 < 上限 → acquire() 後 next() 放行
                           └─ 佔用 >= 上限 → 依模式：
                                ├─ reject → deny(reason)      （拒絕）
                                └─ queue  → 掛住 waterfall 決策進 FIFO 隊列，
                                              等 subagent/end 或該次呼叫 settle
                                              釋出名額後依序放行
```

## 註冊在兩個 settings slot

設定頁**同時**註冊在兩個 slot：

1. **`settings.plugins.tab`** — 這個是關鍵。Plugins 設定區段是用
   `renderSlot("settings.plugins.tab", {}, { only: single.id })` 來畫「你選的那個外掛」的頁面，
   也就是它**用外掛的 profile entry id 去查**。只註冊 `settings.section` 的話，
   在「設定 → 外掛」點進這個外掛會**什麼都沒有**。
   而且因為我們宣告了 `settings.configure({ auto: false })`，DSH 明確**不會**自動產生一個頁面來補這個洞。
2. **`settings.section`** — 主要的設定導覽列，讓你不經過 Plugins 也能調整上限。

兩者用**同一個** component（同一份輪詢、同一份草稿）。
`test/client-slots.test.mjs` 直接鎖住這個註冊形狀，因為這個錯誤在行為上完全看不出來——頁面確實註冊了，只是註冊在沒人看的 surface 上。

## ⚠️ 絕對不要有 default export

這個模組**只能**用具名 export（`apply` / `inject` / `name` / `Config`）。Loader 的正規化是：

```js
exports = exports.default ?? exports
```

一旦有 `export default apply`，整個 runtime 就會被換成那個裸函式，namespace 上的 `Config` / `inject` / `name` 全部**看不見**。症狀非常安靜：DSH 把這個 entry 的 config 解析成 `unknownConfig`，volatile 表單不會產生，設定頁什麼都存不進去——但外掛看起來一切正常。

（1.3.0 就踩過這個坑，是靠 `dsh --dump-config-schema` 顯示 `unknownConfig` 才抓到的，不是靠單元測試。`test/rpc.test.mjs` 現在直接守住「沒有 default export」這個形狀。）

## ⚠️ `src/` 已經過期

`src/index.ts` / `src/client.ts` 停留在 2026-09-06 的狀態，**沒有**跟上 1.3.0 的變更（仍含已移除的 `settings.installSection`，也沒有 volatile Config）。

- `package.json` 沒有 `build` script，`files` 只打包 `lib/`，所以 `tsc` **不會**自動被執行。
- 但若有人手動跑 `tsc`（`tsconfig.json` 是 `src/` → `lib/`），會**直接覆蓋掉 1.3.0 的修正**，把外掛退回壞掉且會被 DSH 停用的狀態。
- 本專案實際上與兄弟外掛（`dsh-fallback-continue`、`dsh-plugin-rpm-limiter`）一致：`lib/` 才是唯一真實來源，`src/` 沒有存在的必要。建議刪除 `src/` 與 `tsconfig.json`；在那之前，請不要執行 `tsc`。

## 備註

- `tools/pre-execute` 是 scope-filtered 的 waterfall，最後一個參數是 `next`；只攔截委派工具，其餘工具一律回傳 `next()`，不影響其他功能。
- `listChildren` 的 `activity === 'running'` 才是「同時執行中」；已結束的 child 不佔名額。
- 為什麼需要 `inFlight`：只看 `running` 會 race——兩個平行委派可能在任一 spawn 落地前都看到「還有名額」。所以已放行但尚未 settle 的呼叫另外計數，並以 tool `callId` 精確對應，在 `tools/result`、呼叫 abort、或 waterfall 拒絕三條路徑上各自釋放（`inFlight` 若洩漏會永久佔住名額）。
- 已放行 ≠ 已執行：`inFlight` 名額由 `tools/result` 釋放，「執行中」名額由 `subagent/end` 釋放。兩者不可混用，否則會把尚未 spawn 的委派誤當成已結束。