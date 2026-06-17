/**
 * Её желание #2 — «арка отношений»: felt-память о том, КАК развивалась связь (не факты).
 * buildRelationshipArc — чистая: где связь сейчас (tier) + куда движется (направление/rv) + один
 * прожитый момент из дневника. Гендерно-нейтрально.
 */
import { describe, expect, it } from "vitest";
import { buildRelationshipArc } from "../src/mods/self-reflection.mod.js";

describe("buildRelationshipArc", () => {
  it("близкий tier + сближение + ключевая мысль вплетается", () => {
    const arc = buildRelationshipArc({
      name: "Степа",
      tier: 15,
      tierDirection: "upgrade",
      rvTrust: 0.8,
      rvAffection: 0.9,
      keyThought: "он назвал меня любимой и стало тепло",
    });
    expect(arc).toContain("Степа");
    expect(arc).toContain("близкий мне человек");
    expect(arc).toContain("стали ближе");
    expect(arc).toContain("Из недавнего вспоминается: он назвал меня любимой и стало тепло");
  });

  it("отдаление", () => {
    const arc = buildRelationshipArc({ name: "Икс", tier: 150, tierDirection: "downgrade" });
    expect(arc).toContain("хорошо знакомы");
    expect(arc).toContain("отдалились");
  });

  it("тёплый rv без направления tier → felt-фраза", () => {
    const arc = buildRelationshipArc({ name: "Игрек", tier: 50, rvAffection: 0.7 });
    expect(arc).toContain("много для меня значит");
    expect(arc).toContain("тепло и спокойно");
  });

  it("новый контакт без мысли — только где мы сейчас", () => {
    const arc = buildRelationshipArc({ name: "Зед", tier: 500 });
    expect(arc).toContain("только узнаём друг друга");
    expect(arc).not.toContain("вспоминается");
  });

  it("слишком короткую мысль (<8 символов) не вплетает", () => {
    const arc = buildRelationshipArc({ name: "Кью", tier: 15, keyThought: "ок" });
    expect(arc).not.toContain("вспоминается");
  });
});
