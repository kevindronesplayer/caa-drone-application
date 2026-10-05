#!/bin/bash
# 在本機開啟（不想用網路版時）：雙擊即可，只需要 macOS 內建的 python3
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
# 若不是從專案資料夾執行（例如把內容貼到終端機），改用預設路徑
if [ ! -f "$APP_DIR/docs/index.html" ]; then
  APP_DIR="$HOME/Documents/claude code/民航局申請系統"
fi
cd "$APP_DIR/docs" || { echo "找不到專案資料夾：$APP_DIR"; exit 1; }

if lsof -ti:8765 >/dev/null 2>&1; then
  echo "系統已在執行中，直接開啟瀏覽器"
  open "http://127.0.0.1:8765"
  exit 0
fi
(sleep 1 && open "http://127.0.0.1:8765") &
echo "關閉這個視窗或按 Ctrl+C 即可停止系統"
python3 -m http.server 8765 --bind 127.0.0.1
