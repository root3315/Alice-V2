import { buildScriptGuide } from "../src/engine/act/index.js";

const opts = {
  hasTarget: true,
  hasBots: true,
  hasTTS: true,
  hasSystemThreads: true,
  hasPeripheral: true,
  preparedCategories: new Set(["social", "memory", "threads", "mood"]),
};

// Private chat
const privateGuide = buildScriptGuide({ ...opts, isGroup: false });
// Group chat
const groupGuide = buildScriptGuide({ ...opts, isGroup: true });

// Count scenes (```javascript blocks)
const countScenes = (text: string) => (text.match(/```javascript/g) || []).length;

console.log("=".repeat(80));
console.log("  PRIVATE CHAT GUIDE");
console.log("=".repeat(80));
console.log(privateGuide);
console.log();
console.log(`Scene count (private): ${countScenes(privateGuide)}`);

console.log();
console.log("=".repeat(80));
console.log("  GROUP CHAT GUIDE");
console.log("=".repeat(80));
console.log(groupGuide);
console.log();
console.log(`Scene count (group): ${countScenes(groupGuide)}`);
