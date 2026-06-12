// Перевод китайского в таблицах с FTS-триггерами (нужен токенизатор better_trigram,
// который живёт как Node-расширение Alice). Идемпотентен.
// Запуск: node russify_db_fts.cjs
const RT = "C:/Users/sozda/Desktop/Astracore/_study/Alice/runtime";
const Database = require(RT + "/node_modules/better-sqlite3");
const { load } = require(RT + "/node_modules/sqlite-better-trigram");

const PAIRS = [
  ["嗯……我在。隔着一层那种感觉，比难过还难描述——不是哪里坏了，就是什么都钝钝的",
   "ну… я тут. такое чувство, будто всё через плёнку — это сложнее описать, чем грусть: ничего не сломалось, просто всё какое-то приглушённое"],
  ["诶 这个验证码是？有人试着登你的号？", "эй, это что за код? кто-то пытается зайти в твой аккаунт?"],
  ["好累呢 怎么了", "так устала… а что случилось?"],
  ["привет... 什么事", "привет... ты чего?"],
].sort((a, b) => b[0].length - a[0].length);

const HAN = /[一-鿿]/;
const TABLES = ["message_log", "diary_entries", "narrative_threads", "album_photos"];

const db = new Database(RT + "/alice.db");
db.pragma("busy_timeout = 8000");
load(db);

let updated = 0;
const leftovers = [];
for (const t of TABLES) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const col of cols) {
    let rows;
    try {
      rows = db.prepare(`select rowid as rid, ${col} as v from ${t} where ${col} is not null`).all();
    } catch {
      continue;
    }
    for (const { rid, v } of rows) {
      if (typeof v !== "string" || !HAN.test(v)) continue;
      let nv = v;
      for (const [k, ru] of PAIRS) nv = nv.split(k).join(ru);
      if (nv !== v) {
        db.prepare(`update ${t} set ${col} = ? where rowid = ?`).run(nv, rid);
        updated++;
      }
      if (HAN.test(nv)) leftovers.push(`${t}.${col}[${rid}]: ${nv.slice(0, 120)}`);
    }
  }
}
console.log(`updated rows (fts-backed): ${updated}`);
if (leftovers.length) {
  console.log("ОСТАЛСЯ китайский:");
  for (const l of leftovers) console.log("  !", l);
} else {
  console.log("в fts-таблицах китайского не осталось ✓");
}
db.close();
