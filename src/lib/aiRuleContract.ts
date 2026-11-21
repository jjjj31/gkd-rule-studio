/** 内置 AI 和外部 AI 共用的 GKD 输出契约，避免两套 prompt 漂移。 */

export const AI_RULE_OUTPUT_CONTRACT = [
  "字段类型硬约束（违反任何一条都视为非法输出）：",
  "- app.id 必须是非空字符串，且等于上下文给出的 appId。",
  "- app.groups 必须是非空数组；groups[].key 必须是整数，name 必须是非空字符串，rules 必须是非空数组。",
  "- rules[].matches、anyMatches、excludeMatches、excludeAllMatches 必须是选择器字符串数组，不能是对象、布尔值或数字。",
  "- activityIds 和 excludeActivityIds 必须是字符串或字符串数组。",
  "- fastQuery、enable、matchRoot 必须是布尔值 true/false。matchRoot 不是选择器，不能写 'content_container' 这类字符串。",
  "- action 只能是 click、clickNode、clickCenter、longClick、longClickNode、longClickCenter、back、swipe、none。",
  "- resetMatch 只能是 app、activity 或 match。",
  "- actionDelay、actionCd、forcedTime、matchTime、actionMaximum 必须是数字；其中 actionMaximum 必须是整数。",
  "- 不要新增或拼错字段名；字段名和值类型必须与下面示例一致。",
  "- 所有 selector 只能出现在 matches/anyMatches/excludeMatches/excludeAllMatches 的字符串元素中，并且必须是合法 GKD selector。",
].join("\n");

export const AI_RULE_OUTPUT_EXAMPLE = `{
  candidates: [{
    id: 'candidate-a',
    title: '测试版 A',
    summary: '用稳定资源 id 立即点击关闭按钮',
    risk: '可能误点同类关闭控件',
    app: {
      id: 'com.example.app',
      name: '示例应用',
      groups: [{
        key: 0,
        name: '开屏广告',
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: 'app',
        rules: [{
          key: 0,
          matches: ['[vid="ad_close"][visibleToUser=true]'],
          activityIds: ['com.example.app.SplashActivity'],
          fastQuery: true,
        }],
      }],
    },
  }],
}`;
