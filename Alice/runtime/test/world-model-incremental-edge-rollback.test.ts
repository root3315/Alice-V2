/**
 * M2 (incremental snapshot edge-rollback) regression test.
 *
 * Before the fix:
 *  - snapshotIncremental() captured snap.edges ONLY when dirtyEdgesRebuild was already
 *    true at snapshot time, and captured ONLY dirty node entries. So:
 *      1. An op that ADDED edges after a clean-edge snapshot left phantom edges that
 *         survived rollback (snap.edges was undefined → restore skipped edge rebuild).
 *      2. removeEntity() that cascade-deleted a CLEAN neighbour (e.g. a conversation
 *         referencing a removed channel) could not be undone — the neighbour was never
 *         captured, so it returned missing (or edge-less) after rollback.
 *
 * The fix populates snap.edges unconditionally and captures full node entries, so
 * rollback fully reconstructs nodes + edges to the snapshot state.
 *
 * NOTE: this is a NEW test file (does not edit existing tests). Owns world-model.ts only.
 */
import { describe, expect, it } from "vitest";
import { WorldModel } from "../src/graph/world-model.js";

describe("WorldModel M2 — incremental snapshot edge-rollback", () => {
  it("rolls back phantom edges added after a clean-edge snapshot", () => {
    const G = new WorldModel();
    G.addContact("a", { display_name: "A" });
    G.addContact("b", { display_name: "B" });
    G.addRelation("a", "knows", "b");

    // Make the snapshot baseline clean so dirtyEdgesRebuild === false at snapshot time.
    G.clearDirty();
    expect(G.needsEdgeRebuild()).toBe(false);
    const edgesBefore = Array.from(G.allEdges()).length;

    const snap = G.snapshotIncremental();

    // Op under rollback: add a phantom edge.
    G.addRelation("b", "knows", "a");
    expect(Array.from(G.allEdges()).length).toBe(edgesBefore + 1);

    G.restoreFromIncremental(snap);

    // Phantom edge must be gone; original edge must survive.
    expect(Array.from(G.allEdges()).length).toBe(edgesBefore);
    expect(G.getNeighbors("a", "knows")).toEqual(["b"]);
    expect(G.getNeighbors("b", "knows")).toEqual([]);
  });

  it("restores a cascade-deleted CLEAN neighbour and its edges on rollback", () => {
    const G = new WorldModel();
    G.addChannel("ch1", { chat_type: "private" });
    G.addConversation("conv1", { channel: "ch1" });
    G.addRelation("conv1", "in_channel", "ch1");

    // Clean baseline: conv1 is NOT dirty and edges are NOT pending rebuild at snapshot.
    G.clearDirty();
    expect(G.needsEdgeRebuild()).toBe(false);

    const snap = G.snapshotIncremental();

    // Op under rollback: removing the channel cascade-deletes the clean conversation.
    G.removeEntity("ch1");
    expect(G.has("ch1")).toBe(false);
    expect(G.has("conv1")).toBe(false);

    G.restoreFromIncremental(snap);

    // Both nodes restored...
    expect(G.has("ch1")).toBe(true);
    expect(G.has("conv1")).toBe(true);
    // ...with their attributes...
    expect(G.getConversation("conv1").channel).toBe("ch1");
    // ...and the cascade-deleted neighbour's edge restored (not edge-less).
    expect(G.getNeighbors("conv1", "in_channel")).toEqual(["ch1"]);
    expect(G.getPredecessors("ch1", "in_channel")).toEqual(["conv1"]);
  });
});
