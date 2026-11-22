/** 内置 AI 和外部 AI 共用的 GKD 输出契约，避免两套 prompt 漂移。 */

export const AI_RULE_OUTPUT_CONTRACT = [
  "字段类型硬约束（违反任何一条都视为非法输出）：",
  "- app.id 必须是非空字符串，且等于上下文给出的 appId。",
  "- app.groups 必须是非空数组；groups[].key 必须是整数，name 必须是非空字符串，rules 必须是非空数组。",
  "- rules[].matches、anyMatches、excludeMatches、excludeAllMatches 必须是选择器字符串数组，不能是对象、布尔值或数字。",
  "- activityIds 和 excludeActivityIds 必须是字符串或字符串数组。",
  "- fastQuery、enable、matchRoot 必须是布尔值 true/false。matchRoot 不是选择器，不能写 'content_container' 这类字符串。",
  "- fastQuery: true 严苛适用条件：仅当规则中每条 selector 最右侧匹配单元都包含精确 id=\"...\" / vid=\"...\" 或非正则 text（= / ^= / $= / *=），且 id/vid/text 必须位于最右侧节点首个独立 [...] 中，不与其它属性用 && 混写（如 [vid=\"x\"][clickable=true] 支持，但 [clickable=true][vid=\"x\"] 和 [vid=\"x\" && clickable=true] 均不支持 fastQuery），且目标不在 WebView 内时才允许开启 fastQuery: true；纯 desc、纯类名/宽高结构、正则 ~=，或最右侧节点无 id/vid/text（如 [text=\"广告\"] + @ImageView、FrameLayout > @ImageView[width<120]）必须省略 fastQuery 或设为 false。",
  "- action 只能是 click、clickNode、clickCenter、longClick、longClickNode、longClickCenter、back、swipe、none。",
  "- resetMatch 只能是 app、activity 或 match。",
  "- actionDelay、actionCd、forcedTime、matchTime、actionMaximum 均为非负整数（其中 actionMaximum >= 1）。",
  "- 不要新增或拼错字段名；字段名和值类型必须与下面示例一致。",
  "- 所有 selector 只能出现在 matches/anyMatches/excludeMatches/excludeAllMatches 的字符串元素中，并且必须是合法 GKD selector。",
].join("\n");

export const AI_RULE_OUTPUT_EXAMPLE = `{
  candidates: [{
    id: 'candidate-a',
    title: '测试版 A',
    summary: '用稳定 vid 立即点击关闭按钮，满足 fastQuery 条件',
    risk: '若同页复用该 vid 可能误触',
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
  }, {
    id: 'candidate-b',
    title: '测试版 B',
    summary: '无 ID 图标用业务文案多段锚点配合 clickCenter 立即点击，不开 fastQuery',
    risk: '若弹窗文案变动则无法触发',
    app: {
      id: 'com.example.app',
      name: '示例应用',
      groups: [{
        key: 0,
        name: '全屏广告',
        matchTime: 10000,
        actionMaximum: 1,
        resetMatch: 'activity',
        rules: [{
          key: 0,
          matches: ['[text="会员限时特惠"]', '[desc="关闭"][visibleToUser=true]'],
          action: 'clickCenter',
        }],
      }],
    },
  }],
}`;
