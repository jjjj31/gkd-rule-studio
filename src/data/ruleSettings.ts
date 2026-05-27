import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { RuleSettings } from "../types/ruleDraft";

export const DEFAULT_RULE_SETTINGS: RuleSettings = {
  groupName: "开屏广告",
  activityIds: "",
  matchTime: 30000,
  actionMaximum: 1,
  actionCd: null,
  resetMatch: "app",
};

export interface RuleSettingsPreset {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  detail: string;
  build: (snapshot: ParsedGkdSnapshot | null) => RuleSettings;
}

export const RULE_SETTINGS_PRESETS: RuleSettingsPreset[] = [
  {
    id: "splash",
    label: "开屏广告",
    shortLabel: "开屏",
    description: "打开应用后一段时间内出现，推荐 30 秒窗口，点一次后停止。",
    detail:
      "适合刚打开应用时出现的跳过、关闭、进入应用等广告。通常不写 activityIds，靠 matchTime 限制前 30 秒，actionMaximum=1 防止重复点击，resetMatch=app 表示下次重新打开应用再触发。",
    build: () => ({
      groupName: "开屏广告",
      activityIds: "",
      matchTime: 30000,
      actionMaximum: 1,
      actionCd: null,
      resetMatch: "app",
    }),
  },
  {
    id: "page-modal",
    label: "进入页面弹窗",
    shortLabel: "入页弹窗",
    description: "进入某页面后短时间出现的广告/公告，推荐限制当前 Activity。",
    detail:
      "适合进入首页、详情页、播放页后立刻出现的公告、全屏广告、运营弹窗。通常填当前 activityIds，matchTime=10000，actionMaximum=1。resetMatch=activity 表示重新进入该页面后可以再处理。",
    build: (snapshot) => ({
      groupName: "全屏广告",
      activityIds: snapshot?.activityId ?? "",
      matchTime: 10000,
      actionMaximum: 1,
      actionCd: null,
      resetMatch: "activity",
    }),
  },
  {
    id: "periodic-video",
    label: "视频播放中周期弹窗",
    shortLabel: "播放中弹窗",
    description: "播放过程中反复出现，不推荐 matchTime，靠 match 重置和 actionCd 防连点。",
    detail:
      "适合看视频、直播、阅读过程中每隔一段时间弹出的广告。不要默认填 matchTime，因为广告不是只在进入页面前几秒出现。通常填当前 activityIds、actionMaximum=1、actionCd=3000、resetMatch=match。",
    build: (snapshot) => ({
      groupName: "全屏广告",
      activityIds: snapshot?.activityId ?? "",
      matchTime: null,
      actionMaximum: 1,
      actionCd: 3000,
      resetMatch: "match",
    }),
  },
  {
    id: "random-interstitial",
    label: "随机插屏广告",
    shortLabel: "随机插屏",
    description: "不知道什么时候会跳出来的全屏/半屏广告弹窗，不推荐短 matchTime。",
    detail:
      "适合使用应用过程中随机弹出的插屏、半屏、广告 SDK 弹窗。通常填当前 activityIds，不要填 matchTime，因为它不是进入应用或页面后固定几秒出现。建议 actionMaximum=1、actionCd=3000、resetMatch=match，目标消失后下次再出现可以重新处理，同时避免连续误点。",
    build: (snapshot) => ({
      groupName: "插屏广告",
      activityIds: snapshot?.activityId ?? "",
      matchTime: null,
      actionMaximum: 1,
      actionCd: 3000,
      resetMatch: "match",
    }),
  },
  {
    id: "feed-ad",
    label: "局部/信息流广告",
    shortLabel: "局部广告",
    description: "页面内可能多次出现，推荐限制当前 Activity，不设 actionMaximum。",
    detail:
      "适合列表、信息流、卡片里的关闭按钮。不建议 actionMaximum=1，否则同一页面后续广告可能不再处理。建议填 activityIds 和 actionCd=3000，selector 本身必须足够窄。",
    build: (snapshot) => ({
      groupName: "局部广告",
      activityIds: snapshot?.activityId ?? "",
      matchTime: null,
      actionMaximum: null,
      actionCd: 3000,
      resetMatch: "",
    }),
  },
  {
    id: "update",
    label: "更新提示",
    shortLabel: "更新",
    description: "通常只需点一次，推荐 10 秒窗口并按 app 重置。",
    detail:
      "适合版本更新、升级提醒。通常填当前 activityIds，matchTime=10000，actionMaximum=1，resetMatch=app。按钮文本如取消、以后再说时要配合标题上下文。",
    build: (snapshot) => ({
      groupName: "更新提示",
      activityIds: snapshot?.activityId ?? "",
      matchTime: 10000,
      actionMaximum: 1,
      actionCd: null,
      resetMatch: "app",
    }),
  },
  {
    id: "permission",
    label: "权限/通知/评价提示",
    shortLabel: "权限/评价",
    description: "通常只需点一次，推荐限制当前 Activity，10 秒窗口。",
    detail:
      "适合通知权限、定位权限、好评评分、青少年模式等引导弹窗。通常填当前 activityIds，matchTime=10000，actionMaximum=1，resetMatch=app。",
    build: (snapshot) => ({
      groupName: "权限提示",
      activityIds: snapshot?.activityId ?? "",
      matchTime: 10000,
      actionMaximum: 1,
      actionCd: null,
      resetMatch: "app",
    }),
  },
  {
    id: "function",
    label: "功能类自动确认",
    shortLabel: "功能",
    description: "用户主动流程，推荐限制当前 Activity，不默认设置短窗口。",
    detail:
      "适合扫码登录确认、展开订单、勾选选项等用户主动操作流程。通常填 activityIds，不默认设置 matchTime/actionMaximum，避免正常流程中失效。",
    build: (snapshot) => ({
      groupName: "功能类-自动生成",
      activityIds: snapshot?.activityId ?? "",
      matchTime: null,
      actionMaximum: null,
      actionCd: null,
      resetMatch: "",
    }),
  },
];
