"""產生台灣機場跑道頭座標 docs/data/tw_runways.json（網站計算「距跑道頭幾海里」用）

資料來源：OurAirports runways.csv（公眾領域）。其中 le/he 座標是跑道「實體端點」，
若有內移跑道頭（displaced threshold），沿跑道方向往內移，得到真正的跑道頭位置。
用法：python3 scripts/build_runways.py [已下載的 runways.csv]
"""

import csv
import io
import json
import math
import sys
import urllib.request
from pathlib import Path

RUNWAYS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv'
OUT_PATH = Path(__file__).resolve().parent.parent / 'docs' / 'data' / 'tw_runways.json'

NAMES = {
    'RCSS': '臺北松山機場', 'RCTP': '桃園國際機場', 'RCMQ': '臺中清泉崗機場', 'RCKU': '嘉義機場',
    'RCNN': '臺南機場', 'RCKH': '高雄國際機場', 'RCSQ': '屏東北機場', 'RCDC': '屏東南機場',
    'RCKW': '恆春機場', 'RCFN': '臺東豐年機場', 'RCQS': '志航基地', 'RCYU': '花蓮機場',
    'RCQC': '澎湖馬公機場', 'RCWA': '望安機場', 'RCCM': '七美機場', 'RCBS': '金門尚義機場',
    'RCFG': '馬祖南竿機場', 'RCMT': '馬祖北竿機場', 'RCGI': '綠島機場', 'RCLY': '蘭嶼機場',
    'RCPO': '新竹空軍基地', 'RCAY': '岡山空軍基地', 'RCDI': '龍潭陸軍基地', 'RCLM': '東沙機場',
    'RCSP': '太平島機場',
}


def destination(lat, lng, bearing_deg, dist_m):
    r = 6371008.8
    b, p1, l1 = map(math.radians, (bearing_deg, lat, lng))
    d = dist_m / r
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def bearing(lat1, lng1, lat2, lng2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x))


def threshold(lat, lng, other_lat, other_lng, displaced_ft):
    ft = float(displaced_ft or 0)
    if ft <= 0:
        return lat, lng
    return destination(lat, lng, bearing(lat, lng, other_lat, other_lng), ft * 0.3048)


def main():
    if len(sys.argv) > 1:
        text = Path(sys.argv[1]).read_text(encoding='utf-8')
    else:
        with urllib.request.urlopen(RUNWAYS_URL, timeout=120) as resp:
            text = resp.read().decode('utf-8')

    airports = {}
    for r in csv.DictReader(io.StringIO(text)):
        icao = r['airport_ident']
        if icao not in NAMES or r['closed'] == '1':
            continue
        if not all(r[k] for k in ('le_latitude_deg', 'le_longitude_deg', 'he_latitude_deg', 'he_longitude_deg')):
            continue
        le = float(r['le_latitude_deg']), float(r['le_longitude_deg'])
        he = float(r['he_latitude_deg']), float(r['he_longitude_deg'])
        ap = airports.setdefault(icao, {'icao': icao, 'name': NAMES[icao], 'thresholds': []})
        for ident, end, other, disp in ((r['le_ident'], le, he, r['le_displaced_threshold_ft']),
                                        (r['he_ident'], he, le, r['he_displaced_threshold_ft'])):
            lat, lng = threshold(*end, *other, disp)
            ap['thresholds'].append({'rwy': ident, 'lat': round(lat, 6), 'lng': round(lng, 6)})

    if len(airports) < 10:
        sys.exit(f'只找到 {len(airports)} 座機場，疑似資料異常，不更新')
    data = {'source': 'OurAirports', 'airports': sorted(airports.values(), key=lambda a: a['icao'])}
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'已寫入 {len(airports)} 座機場、{sum(len(a["thresholds"]) for a in airports.values())} 個跑道頭 → {OUT_PATH}')


if __name__ == '__main__':
    main()
