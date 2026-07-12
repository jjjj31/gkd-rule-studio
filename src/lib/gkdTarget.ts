/** GKD 目标版本管理：官方版（生产） vs Debug/Beta 版（魔改）。
 * Beta 版支持 localRules/append API 直接导入规则，正式版只能复制 JSON5 让用户手动粘。
 * 选择持久化到 localStorage，影响 deviceApi 的 appendLocalRules 和测试后的"导入"按钮行为。 */

export const OFFICIAL_GKD_PACKAGE = "li.songe.gkd";
export const DEBUG_GKD_PACKAGE = "li.songe.gkd.debug";
export const GKD_TARGET_STORAGE_KEY = "gkd-rule-studio-target-package";

export type GkdTargetPackage =
  | typeof OFFICIAL_GKD_PACKAGE
  | typeof DEBUG_GKD_PACKAGE;

export function readStoredTargetPackage(): GkdTargetPackage {
  const stored = localStorage.getItem(GKD_TARGET_STORAGE_KEY);
  return stored === OFFICIAL_GKD_PACKAGE || stored === DEBUG_GKD_PACKAGE
    ? stored
    : DEBUG_GKD_PACKAGE;
}

export function storeTargetPackage(packageId: GkdTargetPackage): void {
  localStorage.setItem(GKD_TARGET_STORAGE_KEY, packageId);
}

export function targetPackageLabel(packageId: GkdTargetPackage): string {
  return packageId === DEBUG_GKD_PACKAGE ? "GKD Debug/Beta" : "GKD 正式版";
}

export function isDebugTarget(packageId: GkdTargetPackage): boolean {
  return packageId === DEBUG_GKD_PACKAGE;
}

export function matchesTargetPackage(
  actualPackageId: string | undefined,
  targetPackageId: GkdTargetPackage,
): boolean {
  return !actualPackageId || actualPackageId === targetPackageId;
}
