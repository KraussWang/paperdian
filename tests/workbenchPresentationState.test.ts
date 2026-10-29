import { describe, expect, it } from "vitest";
import {
  finalizeToolActivities,
  getSkillPopoverLayout,
  getWorkbenchLayoutMode,
  getWeChatPreviewBlockState,
  removeSelectedDocument,
  resetDocumentSelection,
  takeSelectedSkillIds,
  updateDocumentSelection,
  type ToolActivity
} from "../src/ui/WorkbenchPresentationState";

describe("Workbench presentation state", () => {
  it("keeps the skill popover inside a compact workbench", () => {
    expect(getSkillPopoverLayout({
      rootWidth: 320,
      rootHeight: 800,
      anchorLeft: 248,
      anchorTop: 730
    })).toEqual({
      left: 8,
      bottom: 78,
      width: 304,
      maxHeight: 420
    });
  });

  it("keeps the skill popover anchored to the trigger when space permits", () => {
    expect(getSkillPopoverLayout({
      rootWidth: 800,
      rootHeight: 800,
      anchorLeft: 220,
      anchorTop: 730
    })).toEqual({
      left: 220,
      bottom: 78,
      width: 360,
      maxHeight: 420
    });
  });

  it("uses the responsive conversation sidebar at the 600px boundary", () => {
    expect(getWorkbenchLayoutMode(599)).toBe("compact");
    expect(getWorkbenchLayoutMode(600)).toBe("wide");
  });

  it("preserves a best-effort preview for publication blockers and clears it for fatal failures", () => {
    expect(getWeChatPreviewBlockState(true)).toEqual({ clearPreview: false, publishDisabled: true, recreateDisabled: true });
    expect(getWeChatPreviewBlockState(false)).toEqual({ clearPreview: true, publishDisabled: true, recreateDisabled: true });
  });

  it("consumes one-turn skill selection and finalizes live tool activities", () => {
    const selected = new Set(["skill-a", "skill-b"]);
    expect(takeSelectedSkillIds(selected)).toEqual(["skill-a", "skill-b"]);
    expect([...selected]).toEqual([]);

    const activities: ToolActivity[] = [{ name: "Read", input: { file: "paper.md" }, status: "running" }];
    expect(finalizeToolActivities(activities, "stopped")).toEqual([
      { name: "Read", input: { file: "paper.md" }, status: "stopped" }
    ]);
  });

  it("keeps a removed document detached until the active file changes", () => {
    const initial = resetDocumentSelection("papers/one.md", true);
    expect(initial.selectedNotePath).toBe("papers/one.md");

    const removed = removeSelectedDocument(initial);
    expect(removed.selectedNotePath).toBeUndefined();
    expect(updateDocumentSelection(removed, "papers/one.md", true)).toBe(removed);

    const switched = updateDocumentSelection(removed, "papers/two.md", true);
    expect(switched).toEqual({ observedFilePath: "papers/two.md", selectedNotePath: "papers/two.md" });
  });

  it("clears non-Markdown files and resets from the current file when a conversation opens", () => {
    const selected = resetDocumentSelection("papers/one.md", true);
    const nonMarkdown = updateDocumentSelection(selected, "papers/figure.png", false);
    expect(nonMarkdown).toEqual({ observedFilePath: "papers/figure.png", selectedNotePath: undefined });

    expect(resetDocumentSelection("papers/one.md", true)).toEqual({
      observedFilePath: "papers/one.md",
      selectedNotePath: "papers/one.md"
    });
    expect(resetDocumentSelection("papers/figure.png", false).selectedNotePath).toBeUndefined();
  });
});
