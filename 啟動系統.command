#!/bin/bash
# 雙擊即可啟動：建立虛擬環境、安裝套件、開啟瀏覽器
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
# 若不是從專案資料夾執行（例如把內容貼到終端機），改用固定路徑
if [ ! -f "$APP_DIR/app.py" ]; then
  APP_DIR="$HOME/Documents/claude code/民航局申請系統"
fi
cd "$APP_DIR" || { echo "找不到專案資料夾：$APP_DIR"; exit 1; }

if [ ! -x .venv/bin/python ]; then
  echo "第一次啟動，安裝套件中…"
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
[ -f .env ] || cp .env.example .env

if lsof -ti:8765 >/dev/null 2>&1; then
  echo "系統已在執行中，直接開啟瀏覽器"
  open "http://127.0.0.1:8765"
  exit 0
fi
(sleep 2 && open "http://127.0.0.1:8765") &
echo "關閉這個視窗或按 Ctrl+C 即可停止系統"
.venv/bin/python app.py
