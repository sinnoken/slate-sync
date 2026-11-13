# 文件索引

每種規格只寫在一份文件，其他地方連結過去。

| 文件 | 負責的規格 |
|---|---|
| [waveform-code.md](waveform-code.md) | 音訊波形碼：每秒結構、載波、解讀規則、產生端與解碼端計時 |
| [visual-code.md](visual-code.md) | 畫面碼（AprilTag）：碼表與繪製、ID 對應、切換時序、版面、畫面解讀流程、聲畫同步檢查的欄位與選項 |
| [start-time.md](start-time.md) | 循環長度與跨檔案比對範圍、用檔案建立時間推定起點時鐘 |
| [ltc.md](ltc.md) | 場記板的 LTC 輸出與分析器的 LTC 解讀 |
| [testing.md](testing.md) | 驗證方式（各測試的比對對象、測試產生器的選項）、測試條件與實測結果、尚未驗證的項目 |

架構決策紀錄（ADR）放在 [adr/](adr/)：[0001 分析器只保留一份 JS 分析核心](adr/0001-shared-analysis-core.md)。

使用方式、命令列選項與精度摘要見專案的 [README](../README.md)（[繁體中文](../README.zh-TW.md)）；版本變更見 [CHANGELOG](../CHANGELOG.md)；第三方授權見 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。
