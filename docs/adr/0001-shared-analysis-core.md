# ADR-0001：分析器只保留一份 JS 分析核心

**狀態：** 已採用
**決策者：** 專案維護者

## 背景

分析器有兩份實作：`web/sync-analyzer.html`（瀏覽器，WebCodecs 解碼）與 `python/slate_sync.py`（命令列，ffmpeg 解碼）。兩者的演算法相同——波形碼解讀、畫面碼邊緣、擬合與誤差估計、聲畫同步檢查、起點時鐘、跨檔案比對——但各寫一次：

- 每個功能要寫兩次，再交叉比對兩邊一致。畫面碼與聲畫同步檢查花了兩個實作 agent 加兩輪審查；這次的音高循環、建立時間、LTC 又是兩份。
- 兩邊仍有不一致：例如偵測器不同（pupil-apriltags 與 js-aruco2），H.265 開頭一個轉換格的判讀就不同。
- 網頁不得有建置步驟的限制已取消，可以把程式拆成模組、建置時再組成頁面。

## 決定

演算法只用 JS 寫一份「分析核心」，網頁與命令列共用；兩者只各自負責「讀檔與解碼」：

```
src/core/      純計算：輸入取樣值或灰階影格與時間戳，輸出結果（無 DOM、無檔案存取）
src/web/       瀏覽器：MP4 解析、WebCodecs、介面與報告呈現 → 建置成 web/sync-analyzer.html
cli/           Node 命令列：ffmpeg／ffprobe 解碼成 PCM 與灰階影格，交給同一個核心
```

- 建置用 esbuild（單一執行檔、無設定），GitHub Pages 的 workflow 先建置再部署；建置結果維持離線可用（PWA）。
- 命令列改為 `node cli/slate-sync.mjs`，選項與 `--json` 欄位與現行 Python 版相同。偵測器統一為 js-aruco2，不再需要 pupil-apriltags。
- 測試產生器（`tests/make_test_media.py`）與以 ffmpeg 為主的測試工具維持 Python：它們是產生測試資料的工具，不是要和網頁一致的分析邏輯。

## 考慮過的選項

| 選項 | 複雜度 | 以後每個功能 | 兩邊一致 | 使用者安裝 |
|---|---|---|---|---|
| A. 維持兩份（現況） | 低（已存在） | 寫兩次＋交叉比對 | 靠測試，仍有偵測器差異 | Python＋numpy＋ffmpeg（＋pupil-apriltags） |
| **B. 一份 JS 核心＋Node 命令列** | 中：一次性搬移 | 寫一次 | 結構上一致 | Node＋ffmpeg |
| C. 一份 Python 核心，網頁用 Pyodide（WASM） | 高 | 寫一次 | 結構上一致 | 網頁需下載十多 MB 的執行環境，載入慢，不適合離線 PWA |
| D. 一份 Rust／C 核心，編成 WASM 與原生程式 | 很高 | 寫一次 | 結構上一致 | 需要建置原生程式與 WASM，維護成本最高 |

B 的取捨：網頁已經是最完整的實作（WebCodecs、js-aruco2、四種語言），以它為核心，搬移量最小；命令列從 Python 換成 Node，使用者要改裝 Node，但 ffmpeg 仍是必要條件。

## 影響

- 變容易：新功能只寫一次；網頁與命令列的結果由同一份程式產生；`tests/web/` 的測試工具與 `tests/fixtures/` 同時驗證兩者。
- 變困難：網頁需要建置（本機改 `src/` 後要跑建置才看得到）；Python 使用者要改用 Node。
- 要另外處理：現行 Python 版的命令列行為（`--full`、`--probe`、硬體解碼 `-hwaccel`、AAC 精確讀取）要在 Node 版重現並驗證；README 的安裝說明與命令列選項更新。

## 實施計畫

1. **建置與目錄**：建立 `src/`、esbuild 建置與 Pages 部署，建置出的三個網頁與現行版本行為相同（`tests/web/` 的報告快照與場記板逐像素比對都不變）。
2. **抽出核心**：把 `web/sync-analyzer.html` 的純計算部分搬到 `src/core/`（含這次的音高循環、建立時間、LTC），網頁改由建置引用；網頁測試快照不變。
3. **Node 命令列**：`cli/slate-sync.mjs` 以 ffmpeg 解碼後呼叫核心；在 `tests/fixtures/` 與現有測試情境上，`--json` 結果與現行 Python 版一致（容許值與差異寫入 `docs/testing.md`）。
4. **退場**：`python/slate_sync.py` 移除；README、CHANGELOG 說明改用 Node 版與安裝方式；CI 的回歸測試改跑 Node 版。

## 驗收

- 建置後三個網頁的行為不變（報告快照、場記板逐像素比對）。
- Node 命令列與網頁對同一批測試檔的結果完全相同（同一份核心，差異只能來自解碼：ffmpeg 與 WebCodecs）；與現行 Python 版的差異在預估誤差內。
- CI 跑建置、網頁測試與 Node 命令列測試，全部通過。
