"""下載民航局無人機限制區（UAV_fs），存成網站用的 docs/data/caa_zones.geojson

民航局伺服器的跨網域（CORS）設定會讓瀏覽器擋下直接讀取，所以由 GitHub Actions
每天執行這支程式更新一次；也可以在本機手動執行：python3 scripts/update_caa_zones.py
只用 Python 標準函式庫，不需安裝套件。
"""

import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

QUERY_URL = 'https://dronegis.caa.gov.tw/server/rest/services/Hosted/UAV_fs/FeatureServer/3/query'
OUT_PATH = Path(__file__).resolve().parent.parent / 'docs' / 'data' / 'caa_zones.geojson'
HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
    'Referer': 'https://dronegis.caa.gov.tw/portal/apps/webappviewer/index.html?id=807bd21438ba4208b4a7e28569fe41aa',
    'Accept': 'application/json, text/plain, */*',
}


def fetch_all(page_size=2000, timeout=60):
    features, offset, context = [], 0, None
    while True:
        params = {
            'where': '1=1',
            'outFields': '空域名稱,空域類別名稱,空域顏色,有效日期起,有效日期迄,條件,主管機關名稱',
            'returnGeometry': 'true',
            'outSR': '4326',
            'f': 'geojson',
            'maxAllowableOffset': '0.0003',
            'geometryPrecision': '5',
            'resultOffset': str(offset),
            'resultRecordCount': str(page_size),
        }
        req = urllib.request.Request(QUERY_URL + '?' + urllib.parse.urlencode(params), headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=context) as resp:
                page = json.loads(resp.read().decode('utf-8'))
        except urllib.error.URLError as err:
            if context is not None or not isinstance(err.reason, ssl.SSLCertVerificationError):
                raise
            # 民航局憑證鏈的 TWCA 根憑證缺 SKI 欄位，部分 OpenSSL 會擋；公開圖資改不驗證重試
            context = ssl._create_unverified_context()
            continue
        feats = page.get('features', [])
        features.extend(feats)
        if len(feats) < page_size:
            return features
        offset += page_size


def main():
    features = fetch_all()
    if len(features) < 100:  # 異常的少，寧可保留舊檔
        sys.exit(f'只取得 {len(features)} 筆，疑似異常，不更新')
    if OUT_PATH.exists():
        old = json.loads(OUT_PATH.read_text(encoding='utf-8'))
        if old.get('features') == features:
            print(f'資料沒有變動（{len(features)} 筆）')
            return
    data = {
        'type': 'FeatureCollection',
        'source': 'live',
        'fetched_at': int(time.time()),
        'features': features,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'已更新 {len(features)} 筆限制區 → {OUT_PATH}')


if __name__ == '__main__':
    main()
