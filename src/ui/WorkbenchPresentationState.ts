export const WORKBENCH_WIDE_BREAKPOINT = 600;

export type WorkbenchLayoutMode = "compact" | "wide";
export type ToolActivityStatus = "running" | "complete" | "stopped" | "error";

export interface WorkbenchDocumentSelection {
  observedFilePath?: string;
  selectedNotePath?: string;
}

export interface ToolActivity {
  name: string;
  input?: unknown;
  status: ToolActivityStatus;
}

export interface WeChatPreviewBlockState {
  clearPreview: boolean;
  publishDisabled: true;
  recreateDisabled: true;
}

export interface SkillPopoverLayoutInput {
  rootWidth: number;
  rootHeight: number;
  anchorLeft: number;
  anchorTop: number;
}

export interface SkillPopoverLayout {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

const SKILL_POPOVER_GAP = 8;
const SKILL_POPOVER_INSET = 8;
const SKILL_POPOVER_MAX_WIDTH = 360;
const SKILL_POPOVER_MAX_HEIGHT = 420;

export function getWorkbenchLayoutMode(width: number): WorkbenchLayoutMode {
  return width >= WORKBENCH_WIDE_BREAKPOINT ? "wide" : "compact";
}

export function getSkillPopoverLayout(input: SkillPopoverLayoutInput): SkillPopoverLayout {
  const width = Math.max(0, Math.min(SKILL_POPOVER_MAX_WIDTH, input.rootWidth - SKILL_POPOVER_INSET * 2));
  const maxLeft = Math.max(SKILL_POPOVER_INSET, input.rootWidth - SKILL_POPOVER_INSET - width);
  const left = Math.min(Math.max(input.anchorLeft, SKILL_POPOVER_INSET), maxLeft);
  const bottom = Math.max(SKILL_POPOVER_INSET, input.rootHeight - input.anchorTop + SKILL_POPOVER_GAP);
  const maxHeight = Math.max(0, Math.min(
    SKILL_POPOVER_MAX_HEIGHT,
    input.anchorTop - SKILL_POPOVER_GAP - SKILL_POPOVER_INSET
  ));
  return { left, bottom, width, maxHeight };
}

export function getWeChatPreviewBlockState(previewAvailable: boolean): WeChatPreviewBlockState {
  return { clearPreview: !previewAvailable, publishDisabled: true, recreateDisabled: true };
}

export function resetDocumentSelection(filePath?: string, isMarkdown = false): WorkbenchDocumentSelection {
  return {
    observedFilePath: filePath,
    selectedNotePath: isMarkdown ? filePath : undefined
  };
}

export function updateDocumentSelection(
  selection: WorkbenchDocumentSelection,
  filePath?: string,
  isMarkdown = false
): WorkbenchDocumentSelection {
  if (filePath === selection.observedFilePath) return selection;
  return resetDocumentSelection(filePath, isMarkdown);
}

export function removeSelectedDocument(selection: WorkbenchDocumentSelection): WorkbenchDocumentSelection {
  return { ...selection, selectedNotePath: undefined };
}

export function takeSelectedSkillIds(selected: Set<string>): string[] {
  const ids = [...selected];
  selected.clear();
  return ids;
}

export function finalizeToolActivities(activities: ToolActivity[], status: Exclude<ToolActivityStatus, "running">): ToolActivity[] {
  return activities.map(activity => activity.status === "running" ? { ...activity, status } : activity);
}
