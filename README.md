# 民航局無人機申請資料填寫系統

網頁工具：畫空域 → 案名與作業概述（AI 擴寫）→ 自動找起飛點 → 輸出 Word / KML。

**線上使用：<https://kevindronesplayer.github.io/caa-drone-application/>**

## 流程

1. **繪製空域**：多邊形（最多 6 點）或圓形，可畫多個，也可以匯入 KML／KMZ（按鈕或直接拖到地圖上）。選取後拖曳頂點、點虛線圓點新增頂點、點頂點刪除；圓形可拖曳圓心／半徑把手或直接輸入半徑。每個空域會自動顯示：
   - 與民航局公告限制區重疊的情形
   - 空域內最大地表高度（英尺，無條件進位），地圖上以 ▲ 標出最高點；以及最低可申請高度 = 最大地表高度 + 400 ft
   - 若在機場 10 公里內：空域最近點到最近跑道頭的距離（海里／公里），地圖上以紅色虛線標示；3 海里以內另顯示「受○○機場近離場影響」

   空域名稱「空域N」的 N 就是排列順序：把空域3 改名為空域1 會移到最前面，其他依序重新編號。

   匯入 KML 時：本系統輸出的圓形會還原成可調整的圓；看起來是圓的多邊形也會轉成圓；超過 6 點的多邊形會自動簡化成 6 點（會提示請確認）。
2. **案名與作業概述**：輸入大致內容，按「AI 擴充生成」產生正式作業概述（缺的資訊以【待確認】標示）。
3. **預計起飛地點**：每個空域自動產生 2 個起飛點，優先選空域內相距最遠的公園或戶外停車場，不足時用廟宇（OpenStreetMap 資料），再不足才用空域對角線位置。點起飛點後點地圖新位置或候選點即可修改，也能拖曳、新增、刪除。「貼到作業概述」會插入／更新【預計起飛地點】段落。
4. **確認與輸出**：所有欄位都能修改，輸出 Word（案名＋作業概述，標楷體）與 KML。KML 每個空域一個檔案，檔名為「地點_空域N.kml」（例：宜蘭縣宜蘭市_空域1.kml），可選擇含起飛點。

資料會自動存在瀏覽器；「儲存專案」可下載 .json，之後用「開啟專案」繼續編輯。

## AI 擴寫

需要使用者自己的 Claude API 金鑰（<https://console.anthropic.com/settings/keys>），在步驟 2 輸入一次即可。
金鑰只存在使用者自己的瀏覽器，直接傳給 Claude API，不會存進專案檔或上傳到其他地方。沒有金鑰也能手動撰寫作業概述。

## 架構

純靜態網頁（`docs/`），由 GitHub Pages 提供，不需要伺服器：

| 功能 | 做法 |
|---|---|
| 底圖 | OpenStreetMap、內政部國土測繪中心 |
| 民航局限制區 | 民航局 dronegis UAV_fs 公開圖資。民航局伺服器不允許瀏覽器直接讀取，所以由 GitHub Actions（`.github/workflows/update-caa-zones.yml`）每天下載一次存成 `docs/data/caa_zones.geojson`；讀不到時改用內建 RCR 離線快照。僅供參考，以民航局公告為準 |
| 地表高度 | AWS Terrain Tiles（Terrarium，約 30 公尺解析度），掃描空域內每個像素取最大值；僅供參考 |
| 機場跑道頭 | OurAirports 跑道資料，依內移跑道頭（displaced threshold）修正，由 `scripts/build_runways.py` 產生 `docs/data/tw_runways.json`，GitHub Actions 每天更新 |
| 公園／停車場／廟宇 | OpenStreetMap Overpass API |
| 地名、地點搜尋 | OpenStreetMap Nominatim |
| AI 擴寫 | Claude API（Anthropic TypeScript SDK，瀏覽器直接呼叫） |
| Word | docx 函式庫，在瀏覽器產生 |

## 本機執行

macOS 可雙擊 `啟動系統.command`，或：

```bash
cd docs && python3 -m http.server 8765
```

手動更新限制區資料：

```bash
python3 scripts/update_caa_zones.py
```
