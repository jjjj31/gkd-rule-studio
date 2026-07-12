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
