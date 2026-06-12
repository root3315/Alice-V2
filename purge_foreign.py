# -*- coding: utf-8 -*-
"""Удаляет из памяти Alice следы НЕодобренных чатов (групп, куда она заглядывала).
Удаляются строки, где встречаются конкретные foreign-id (уникальные, без риска задеть
личку/одобренную группу). Делает бэкап. Идемпотентен.
"""
import sqlite3, sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")

DB = r"C:\Users\sozda\Desktop\Astracore\_study\Alice\runtime\alice.db"
BACKUP = r"C:\Users\sozda\Desktop\Astracore\_study\Alice\runtime\alice.backup-pre-purge.db"

# Неодобренные чаты, которые надо забыть (уникальные числовые id групп).
FOREIGN = ["-1001646630873", "-1003543324668"]
# FTS-backed таблицы пропускаем (в них групп нет — message_log чист); системные тоже.
SKIP = {"sqlite_sequence", "__drizzle_migrations"}


def main() -> None:
    src = sqlite3.connect(DB)
    src.execute("PRAGMA busy_timeout=8000")
    dst = sqlite3.connect(BACKUP)
    src.backup(dst)
    dst.close()
    print("backup ->", BACKUP)

    cur = src.cursor()
    tabs = [r[0] for r in cur.execute("select name from sqlite_master where type='table'").fetchall()]
    total = 0
    for t in tabs:
        if "_fts" in t or t in SKIP:
            continue
        try:
            cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})").fetchall()]
        except sqlite3.Error:
            continue
        text_cols = [c for c in cols]
        for col in text_cols:
            for tok in FOREIGN:
                try:
                    n = cur.execute(
                        f"delete from {t} where {col} like ?", (f"%{tok}%",)
                    ).rowcount
                except sqlite3.Error:
                    continue
                if n:
                    print(f"  {t}.{col}: -{n}")
                    total += n
    src.commit()
    print("удалено строк:", total)
    # контроль
    left = 0
    for t in tabs:
        if "_fts" in t or t in SKIP:
            continue
        try:
            cols = [c[1] for c in cur.execute(f"PRAGMA table_info({t})").fetchall()]
        except sqlite3.Error:
            continue
        for col in cols:
            for tok in FOREIGN:
                try:
                    left += cur.execute(
                        f"select count(*) from {t} where {col} like ?", (f"%{tok}%",)
                    ).fetchone()[0]
                except sqlite3.Error:
                    pass
    print("осталось упоминаний неодобренных групп:", left)
    src.close()


if __name__ == "__main__":
    main()
