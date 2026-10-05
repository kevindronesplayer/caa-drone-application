# 民航局無人機申請資料填寫系統

本機網頁工具：畫空域 → 案名與作業概述（AI 擴寫）→ 自動找起飛點 → 輸出 Word / KML。

## 下載安裝

需要 Python 3.10 以上。

```bash
git clone https://github.com/kevindronesplayer/caa-drone-application.git
cd caa-drone-application
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

## 啟動

macOS 可雙擊 `啟動系統.command`（第一次會自動安裝套件），瀏覽器會開啟 <http://127.0.0.1:8765>。

或在終端機：

```bash
.venv/bin/python app.py
```

## AI 擴寫設定

編輯專案資料夾的 `.env`，填入 Claude API 金鑰後重新啟動：

```
ANTHROPIC_API_KEY=sk-ant-...
```

沒有金鑰時其他功能都能用，只是作業概述要手動撰寫。

## 流程

1. **繪製空域**：多邊形（最多 6 點）或圓形，可畫多個。選取後拖曳頂點、點虛線圓點新增頂點、點頂點刪除；圓形可拖曳圓心／半徑把手或直接輸入半徑。會自動標出與民航局公告限制區重疊的情形。可隨時輸出 KML。
2. **案名與作業概述**：輸入大致內容，按「AI 擴充生成」產生正式作業概述（缺的資訊以【待確認】標示）。
3. **預計起飛地點**：每個空域自動產生 2 個起飛點，優先選空域內相距最遠的公園或戶外停車場（OpenStreetMap 資料），找不到就用空域對角線位置。點起飛點後點地圖新位置或候選點即可修改，也能拖曳、新增、刪除。「貼到作業概述」會插入／更新【預計起飛地點】段落。
4. **確認與輸出**：所有欄位都能修改，輸出 Word（案名＋作業概述，標楷體）與 KML（空域，可選擇含起飛點）。

資料會自動存在瀏覽器；「儲存專案」可下載 .json，之後用「開啟專案」繼續編輯。

## 資料來源

- 底圖：OpenStreetMap、內政部國土測繪中心
- 限制區：民航局 dronegis UAV_fs 公開圖資（與 dronemap 筆記本相同來源，連不上時改用內建 RCR 離線快照）；僅供參考，以民航局公告為準
- 公園／停車場：OpenStreetMap Overpass API
- 地名：OpenStreetMap Nominatim
