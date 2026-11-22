/**
 * 倒计时文本与动态 Activity 识别的共享纯函数。
 * 供策略生成、动作计划、风险评分与 AI 校验复用，避免各模块正则漂移。
 */

/** 匹配带空格或分隔符（｜/|/·/•/:/：/-/()/秒）的动态跳过倒计时文案。 */
export function isDynamicCountdownText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return (
    /^跳过[\s|｜·•:：\-/()（）]*\d+\s*(?:s|秒)?[)）]?$/i.test(normalized) ||
    /^\(?（?\d+\s*(?:s|秒)?[)）]?[\s|｜·•:：\-/]*后?\s*跳过$/i.test(normalized) ||
    /^skip[\s|｜·•:：\-/()（）]*\d+\s*(?:s|秒)?[)）]?$/i.test(normalized) ||
    /^\(?（?\d+\s*(?:s|秒)?[)）]?[\s|｜·•:：\-/]*skip$/i.test(normalized)
  );
}

/** 文本是否属于开屏/广告“跳过”控件。 */
export function isSkipLikeText(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized === "跳过" ||
    isDynamicCountdownText(normalized) ||
    /^skip\b/i.test(normalized)
  );
}

/**
 * 判断 activityId 是否带有运行期/SDK 版本的动态后缀（如 InterstitialView_4012003、Foo$1、Foo$1$2、AdActivity_a1b2c3d4）。
 * 这类名称不能自动锁死进 rules[].activityIds，否则换实例或 SDK 升级后立即失配。
 */
export function isDynamicActivityId(activityId: string | null | undefined): boolean {
  const trimmed = (activityId ?? "").trim();
  if (!trimmed) return false;
  return (
    /_\d{4,}$/.test(trimmed) ||
    /\$\d+(?:\$[A-Za-z0-9_]+)*$/.test(trimmed) ||
    /[_$](?:(?=[0-9a-f]{6,}$)[0-9a-f]*\d[0-9a-f]*|[0-9a-f]{8,})$/i.test(trimmed)
  );
}
