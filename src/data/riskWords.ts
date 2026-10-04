/** 评分用词表：高风险触发词（"升级"/"立即开通"/"抽奖"）、通用跳过词、正向 CTA 词、上下文提示词。被 riskScoring.ts 引用。 */
export const GENERIC_ACTION_TEXT = [
  "关闭",
  "取消",
  "确定",
  "知道了",
  "我知道了",
  "以后再说",
  "暂不",
  "否",
  "不了",
  "跳过",
];

export const NEGATIVE_ACTION_TEXT = [
  "关闭",
  "取消",
  "以后再说",
  "暂不",
  "否",
  "不了",
  "暂不开启",
  "下次再说",
];

export const POSITIVE_CTA_TEXT = [
  "允许",
  "立即升级",
  "立即更新",
  "更新",
  "升级",
  "开启",
  "去开启",
  "好评",
  "立即体验",
  "同意",
];

export const DANGEROUS_CLICK_WORDS = [
  "下载",
  "安装",
  "打开",
  "查看详情",
  "浏览",
  "去看看",
  "去微信看看",
  "立即下载",
  "立即打开",
  "去逛逛",
  "了解更多",
  "跳转",
  "第三方应用",
  "软件商店",
  "福利",
  "领取",
  "购买",
  "会员",
  "开通",
  "广告热区",
  "hotarea",
  "splashhotarea",
  "ptgsplashhotarea",
  // 广告 SDK 的容器/原生广告位资源名，点到即可能打开广告详情。
  "nativead",
  "ksad_container",
  "ad_area",
];

export const CONTEXT_HINT_WORDS = [
  "权限",
  "通知",
  "定位",
  "更新",
  "升级",
  "温馨提示",
  "提示",
  "公告",
  "广告",
  "青少年",
  "评分",
  "评价",
];

/**
 * 同义否定动作的变体组。
 * 不同 App 对同一个"拒绝"动作会用不同文案，把它们合并成一条 [text="否" || text="暂不"] selector，
 * 可以跨 App/跨版本复用同一条规则。研究报告 logicalOrVariantUnion 策略。
 * key 是任意一个组内词，查找时遍历所有组找 pickedNode.text 属于哪个组。
 */
export const NEGATIVE_ACTION_VARIANT_GROUPS: string[][] = [
  ["否", "暂不", "不了", "拒绝"],
  ["以后再说", "下次再说", "稍后", "以后"],
  ["暂不开启", "暂不开启通知", "暂不允许"],
];
