"""Поиск термина по всей БД Алисы (readonly). Запуск: python query_alice.py [term]"""
import sqlite3
import sys

DB = r"C:\Users\sozda\Desktop\Astracore\_study\Alice\runtime\alice.db"
term = sys.argv[1] if len(sys.argv) > 1 else "экзам"

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
con.text_factory = lambda b: b.decode("utf-8", "replace")
tables = [r[0] for r in con.execute(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%'")]

hits = 0
for t in tables:
    try:
        cols = [r[1] for r in con.execute(f"PRAGMA table_info('{t}')")]
    except Exception:
        continue
    for c in cols:
        try:
            rows = con.execute(
                f"select substr(CAST({c} AS TEXT),1,240) from \"{t}\" "
                f"where CAST({c} AS TEXT) like ? limit 6", (f"%{term}%",)).fetchall()
        except Exception:
            continue
        for (val,) in rows:
            if val and term.lower() in val.lower():
                hits += 1
                print(f"[{t}.{c}] {val.strip()[:220]}")

print(f"\n=== ВСЕГО совпадений по '{term}': {hits} ===")
