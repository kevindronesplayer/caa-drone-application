# 民航局無人機申請資料填寫系統

網頁工具：畫空域 → 案名與作業概述（AI 擴寫）→ 自動找起飛點 → 輸出 Word / KML。

**線上使用：<https://kevindronesplayer.github.io/caa-drone-application/>**

## 流程

1. **繪製空域**：多邊形（最多 6 點）或圓形，可畫多個。選取後拖曳頂點、點虛線圓點新增頂點、點頂點刪除；圓形可拖曳圓心／半徑把手或直接輸入半徑。會自動標出與民航局公告限制區重疊的情形。可隨時輸出 KML。
2. **案名與作業概述**：輸入大致內容，按「AI 擴充生成」產生正式作業概述（缺的資訊以【待確認】標示）。
3. **預計起飛地點**：每個空域自動產生 2 個起飛點，優先選空域內相距最遠的公園或戶外停車場（OpenStreetMap 資料），找不到就用空域對角線位置。點起飛點後點地圖新位置或候選點即可修改，也能拖曳、新增、刪除。「貼到作業概述」會插入／更新【預計起飛地點】段落。
4. **確認與輸出**：所有欄位都能修改，輸出 Word（案名＋作業概述，標楷體）與 KML（空域，可選擇含起飛點）。

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
| 公園／停車場 | OpenStreetMap Overpass API |
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
