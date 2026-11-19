"use strict";

const loginView = document.getElementById("loginView");
const appView = document.getElementById("appView");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const logoutButton = document.getElementById("logoutButton");
const feedbackList = document.getElementById("feedbackList");
const detailPanel = document.getElementById("detailPanel");
const listStatus = document.getElementById("listStatus");
const totalCount = document.getElementById("totalCount");
const filters = Array.from(document.querySelectorAll(".filter"));
const feedbackView = document.getElementById("feedbackView");
const announcementView = document.getElementById("announcementView");
const viewTabs = Array.from(document.querySelectorAll(".tab"));
const announcementStatus = document.getElementById("announcementStatus");
const announcementError = document.getElementById("announcementError");
const announcementHistoryList = document.getElementById("announcementHistory");

let csrfToken = "";
let currentFilter = "all";
let selectedId = "";
let currentPage = 1;
const pageSize = 50;
let announcementType = "notice";
let announcementHistory = [];
let announcementLoaded = false;
let announcementExists = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(seconds) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(seconds * 1000));
}

function categoryLabel(category) {
  if (category === "tool") return "工具反馈";
  if (category === "feature") return "功能建议";
  return "规则反馈";
}

function statusLabel(status) {
  return status === "resolved" ? "已解决" : "待处理";
}

async function api(path, options) {
  const requestOptions = Object.assign({ credentials: "same-origin" }, options || {});
  requestOptions.headers = Object.assign(
    { "Accept": "application/json" },
    requestOptions.headers || {}
  );
  if (requestOptions.body && typeof requestOptions.body !== "string") {
    requestOptions.headers["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(requestOptions.body);
  }
  const response = await fetch(path, requestOptions);
  let data = null;
  if (response.status !== 204) {
    const contentType = response.headers.get("content-type") || "";
    data = contentType.includes("application/json") ? await response.json() : null;
  }
  if (response.status === 401) {
    showLogin();
  }
  if (!response.ok) {
    throw new Error(data && data.detail ? data.detail : "请求失败");
  }
  return data;
}

function showLogin() {
  csrfToken = "";
  selectedId = "";
  announcementLoaded = false;
  appView.hidden = true;
  logoutButton.hidden = true;
  loginView.hidden = false;
  document.getElementById("password").value = "";
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  logoutButton.hidden = false;
  api("healthz").then(function (status) {
    document.getElementById("mailStatus").textContent = status.smtp_configured
      ? "邮件提醒已配置" : "邮件提醒待配置，反馈会正常保存在收件箱。";
  }).catch(function () {
    document.getElementById("mailStatus").textContent = "邮件状态暂时无法读取。";
  });
}

function renderList(data) {
  feedbackList.replaceChildren();
  totalCount.textContent = String(data.total);
  document.getElementById("pageInfo").textContent = "第 " + currentPage + " / " + Math.max(1, Math.ceil(data.total / pageSize)) + " 页";
  document.getElementById("previousPage").disabled = currentPage <= 1;
  document.getElementById("nextPage").disabled = currentPage * pageSize >= data.total;
  listStatus.textContent = data.items.length ? "" : "暂无反馈";
  for (const item of data.items) {
    const button = element("button", "feedback-item");
    button.type = "button";
    button.dataset.id = item.id;
    button.dataset.id = item.id;
    if (item.id === selectedId) button.classList.add("active");
    const meta = element("div", "feedback-meta");
    const status = element("span", "pill " + (item.status === "resolved" ? "resolved" : ""), statusLabel(item.status));
    meta.append(
      status,
      element("span", "", categoryLabel(item.category)),
      element("span", "", formatDate(item.createdAt))
    );
    if (item.attachmentCount) {
      meta.append(element("span", "", "附件 " + item.attachmentCount));
    }
    if (item.hasContact) {
      meta.append(element("span", "", "含联系方式"));
    }
    button.append(meta, element("p", "", item.description || "（空描述）"));
    button.addEventListener("click", function () {
      loadDetail(item.id);
    });
    feedbackList.append(button);
  }
}

async function loadList() {
  listStatus.textContent = "加载中…";
  try {
    const data = await api("admin/api/feedback?status=" + encodeURIComponent(currentFilter) + "&page=" + currentPage + "&limit=" + pageSize);
    if (!data.items.length && currentPage > 1) { currentPage -= 1; return loadList(); }
    renderList(data);
    if (selectedId) {
      await loadDetail(selectedId);
    }
  } catch (error) {
    listStatus.textContent = error.message;
  }
}

function appendContext(container, key, value) {
  const row = element("div", "context-row");
  row.append(element("strong", "", key), element("p", "context-value", value || "（空）"));
  container.append(row);
}

function renderDetail(feedback) {
  detailPanel.replaceChildren();
  const heading = element("div", "detail-heading");
  const headingText = element("div");
  const title = element("h2", "", categoryLabel(feedback.category));
  headingText.append(
    element("p", "eyebrow", feedback.id),
    title,
    element("p", "muted", formatDate(feedback.createdAt) + " · " + statusLabel(feedback.status))
  );

  const actions = element("div", "detail-actions");
  const statusButton = element(
    "button",
    "button",
    feedback.status === "resolved" ? "标为待处理" : "标为已解决"
  );
  statusButton.type = "button";
  statusButton.addEventListener("click", async function () {
    statusButton.disabled = true;
    const nextStatus = feedback.status === "resolved" ? "pending" : "resolved";
    try {
      await api("admin/api/feedback/" + encodeURIComponent(feedback.id), {
        method: "PATCH",
        headers: { "X-CSRF-Token": csrfToken },
        body: { status: nextStatus }
      });
      await loadList();
    } catch (error) {
      window.alert(error.message);
      statusButton.disabled = false;
    }
  });
  const deleteButton = element("button", "button danger", "彻底删除");
  deleteButton.type = "button";
  deleteButton.addEventListener("click", async function () {
    if (!window.confirm("将永久删除反馈、联系方式和全部附件，确定吗？")) return;
    deleteButton.disabled = true;
    try {
      await api("admin/api/feedback/" + encodeURIComponent(feedback.id), {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrfToken }
      });
      selectedId = "";
      renderEmptyDetail();
      await loadList();
    } catch (error) {
      window.alert(error.message);
      deleteButton.disabled = false;
    }
  });
  actions.append(statusButton, deleteButton);
  heading.append(headingText, actions);

  const descriptionBlock = element("section", "detail-block");
  descriptionBlock.append(
    element("h3", "", "反馈正文"),
    element("p", "description", feedback.description || "（空）")
  );

  const contactBlock = element("section", "detail-block");
  contactBlock.append(
    element("h3", "", "联系方式"),
    element("p", "description", feedback.contact || "未填写")
  );

  const contextBlock = element("section", "detail-block");
  contextBlock.append(element("h3", "", "环境上下文"));
  const contextGrid = element("div", "context-grid");
  const contextLabels = {
    appVersion: "应用版本",
    systemVersion: "系统版本",
    gkdChannel: "GKD 版本类型",
    gkdVersion: "GKD 版本号",
    page: "页面",
    error: "错误"
  };
  for (const key of ["appVersion", "systemVersion", "gkdChannel", "gkdVersion", "page", "error"]) {
    appendContext(contextGrid, contextLabels[key], feedback.context[key]);
  }
  contextBlock.append(contextGrid);

  const attachmentBlock = element("section", "detail-block");
  attachmentBlock.append(element("h3", "", "附件"));
  if (!feedback.attachments.length) {
    attachmentBlock.append(element("p", "muted", "无附件"));
  } else {
    const attachmentList = element("div", "attachment-list");
    for (const attachment of feedback.attachments) {
      const row = element("div", "attachment-row");
      const link = element("a", "", attachment.name || "未命名附件");
      link.href = "admin/api/feedback/"
        + encodeURIComponent(feedback.id)
        + "/attachments/"
        + encodeURIComponent(attachment.id);
      row.append(link, element("span", "muted", attachment.mimeType + " · " + attachment.size + " bytes"));
      attachmentList.append(row);
      if (attachment.mimeType === "image/png") {
        const previewButton = element("button", "button ghost", "预览图片");
        previewButton.type = "button";
        previewButton.addEventListener("click", function () {
          for (const oldImage of attachmentList.querySelectorAll(".attachment-preview")) oldImage.remove();
          const image = element("img", "attachment-preview");
          image.alt = "用户确认发送的脱敏截图";
          image.decoding = "async";
          image.src = link.href;
          row.after(image);
        });
        row.append(previewButton);
      }
    }
    attachmentBlock.append(attachmentList);
  }
  detailPanel.append(heading, descriptionBlock, contactBlock, contextBlock, attachmentBlock);
}

function renderEmptyDetail() {
  detailPanel.replaceChildren();
  const empty = element("div", "empty-state");
  empty.append(
    element("p", "eyebrow", "DETAILS"),
    element("h2", "", "选择一条反馈"),
    element("p", "muted", "正文、联系方式和附件只在这里向已登录管理员显示。")
  );
  detailPanel.append(empty);
}

function switchView(view) {
  for (const tab of viewTabs) {
    tab.classList.toggle("active", tab.dataset.view === view);
  }
  feedbackView.hidden = view !== "feedback";
  announcementView.hidden = view !== "announcement";
  if (view === "announcement") {
    if (!announcementLoaded) {
      loadAnnouncement(true);
    } else {
      loadAnnouncementStatus();
    }
  }
}

function setAnnouncementType(type) {
  announcementType = type === "update" ? "update" : "notice";
  document.getElementById("typeNotice").classList.toggle("active", announcementType === "notice");
  document.getElementById("typeUpdate").classList.toggle("active", announcementType === "update");
  document.getElementById("updateFields").hidden = announcementType !== "update";
  renderAnnouncementPreview();
}

function announcementFormValue() {
  return {
    enabled: document.getElementById("announcementEnabled").checked,
    type: announcementType,
    title: document.getElementById("announcementTitle").value,
    content: document.getElementById("announcementContent").value,
    forced: document.getElementById("announcementForced").checked,
    versionName: document.getElementById("announcementVersionName").value,
    versionCode: document.getElementById("announcementVersionCode").value,
    apkUrl: document.getElementById("announcementApkUrl").value,
    sha256: document.getElementById("announcementSha256").value,
    actionText: document.getElementById("announcementActionText").value,
    actionUrl: document.getElementById("announcementActionUrl").value
  };
}

function renderAnnouncementPreview() {
  const value = announcementFormValue();
  const isUpdate = value.type === "update";
  document.getElementById("previewTitleText").textContent =
    value.title.trim() || "公告标题";
  document.getElementById("previewContent").textContent =
    value.content.trim() || "在此处输入想传达给用户的内容…";
  const badge = document.getElementById("previewBadge");
  badge.textContent = isUpdate ? "🚀" : "📢";
  badge.className = "phone-badge " + (isUpdate ? "update" : "notice");
  const typeTag = document.getElementById("previewTypeTag");
  typeTag.textContent = isUpdate
    ? (value.versionName.trim() ? "v" + value.versionName.trim() : "版本更新")
    : "普通公告";
  typeTag.className = "tag" + (isUpdate ? " update" : "");
  document.getElementById("previewForcedTag").hidden = !value.forced;
  const action = document.getElementById("previewAction");
  action.hidden = !value.actionText.trim();
  action.textContent = (value.actionText.trim() || "查看详情") + " ↗";
  document.getElementById("previewLater").hidden = !isUpdate || value.forced;
  document.getElementById("previewMain").textContent = isUpdate ? "立即更新" : "我知道了";
}

function fillAnnouncementForm(current) {
  const data = current || {};
  const isPlaceholder = data.id === "init";
  document.getElementById("announcementEnabled").checked = Boolean(data.enabled);
  document.getElementById("announcementTitle").value = isPlaceholder ? "" : data.title || "";
  document.getElementById("announcementContent").value = isPlaceholder ? "" : data.content || "";
  document.getElementById("announcementForced").checked = Boolean(data.forced);
  document.getElementById("announcementVersionName").value = data.versionName || "";
  document.getElementById("announcementVersionCode").value =
    data.versionCode === undefined || data.versionCode === null ? "" : String(data.versionCode);
  document.getElementById("announcementApkUrl").value = data.apkUrl || "";
  document.getElementById("announcementSha256").value = data.sha256 || "";
  document.getElementById("announcementActionText").value = data.actionText || "";
  document.getElementById("announcementActionUrl").value = data.actionUrl || "";
  setAnnouncementType(data.type === "update" ? "update" : "notice");
}

function renderAnnouncementHistory() {
  announcementHistoryList.replaceChildren();
  if (!announcementHistory.length) {
    announcementHistoryList.append(element("p", "muted", "还没有历史记录。"));
    return;
  }
  announcementHistory.forEach(function (item, index) {
    const row = element("div", "history-row");
    const meta = element("div", "history-meta");
    meta.append(
      element("strong", "", item.title || "未命名公告"),
      element(
        "span",
        "muted",
        (item.updatedAt || "") + " · " + (item.type === "update" ? "版本更新" : "普通公告")
      )
    );
    const loadButton = element("button", "button ghost small", "载入");
    loadButton.type = "button";
    loadButton.addEventListener("click", function () {
      fillAnnouncementForm(item);
      announcementError.textContent = "";
      announcementStatus.textContent = "已载入历史内容，点击【立即发布到全网】才会生效。";
    });
    row.append(meta, loadButton);
    announcementHistoryList.append(row);
  });
}

function describeAnnouncementStatus(current) {
  if (!current || current.id === "init") {
    return "还没有发布过公告，用户端不会出现弹窗。";
  }
  if (!current.enabled) {
    return "当前状态：已停用，全网用户看不到弹窗。";
  }
  if (current.forced) {
    return "当前状态：已启用（紧急强提醒），用户每次启动都会看到。";
  }
  return "当前状态：已启用，用户读过后不再重复弹窗。";
}

async function loadAnnouncementStatus() {
  try {
    const data = await api("admin/api/announcement");
    announcementHistory = data.history || [];
    announcementExists = Boolean(data.current && data.current.id !== "init");
    renderAnnouncementHistory();
    announcementStatus.textContent = describeAnnouncementStatus(data.current);
    return data;
  } catch (error) {
    announcementStatus.textContent = error.message;
    return null;
  }
}

async function loadAnnouncement(fillForm) {
  announcementStatus.textContent = "加载中…";
  const data = await loadAnnouncementStatus();
  announcementLoaded = true;
  if (data && fillForm) {
    fillAnnouncementForm(data.current);
    renderAnnouncementPreview();
  }
}

async function publishAnnouncement() {
  announcementError.textContent = "";
  const value = announcementFormValue();
  if (!value.title.trim() || !value.content.trim()) {
    announcementError.textContent = "标题和正文都不能为空。";
    return;
  }
  if (value.type === "update" && (!value.versionName.trim() || !value.apkUrl.trim())) {
    announcementError.textContent = "版本更新必须填写版本号和 APK 下载链接。";
    return;
  }
  if (value.sha256.trim() && !/^[0-9a-fA-F]{64}$/.test(value.sha256.trim())) {
    announcementError.textContent = "SHA-256 必须是 64 位十六进制字符。";
    return;
  }
  const button = document.getElementById("publishAnnouncement");
  button.disabled = true;
  try {
    await api("admin/api/announcement", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: value
    });
    announcementStatus.textContent = "发布成功，用户端下次打开软件即可看到。";
    await loadAnnouncement(true);
  } catch (error) {
    announcementError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function toggleAnnouncement(enabled) {
  announcementError.textContent = "";
  try {
    await api("admin/api/announcement/toggle", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      body: { enabled: enabled }
    });
    await loadAnnouncementStatus();
  } catch (error) {
    document.getElementById("announcementEnabled").checked = !enabled;
    announcementError.textContent = error.message;
  }
}

async function loadDetail(id) {
  selectedId = id;
  try {
    const feedback = await api("admin/api/feedback/" + encodeURIComponent(id));
    renderDetail(feedback);
    for (const item of feedbackList.querySelectorAll(".feedback-item")) {
      item.classList.toggle("active", item.dataset.id === id);
    }
  } catch (error) {
    detailPanel.replaceChildren(element("p", "error", error.message));
  }
}

async function boot() {
  try {
    const session = await api("admin/api/session");
    csrfToken = session.csrfToken;
    showApp();
    await loadList();
    await loadAnnouncementStatus();
    const requestedId = new URLSearchParams(window.location.search).get("feedback");
    if (requestedId) await loadDetail(requestedId);
  } catch (error) {
    if (!loginView.hidden) return;
    loginError.textContent = error.message;
  }
}

loginForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  loginError.textContent = "";
  const submit = loginForm.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    await api("admin/api/login", {
      method: "POST",
      body: {
        username: document.getElementById("username").value,
        password: document.getElementById("password").value
      }
    });
    const session = await api("admin/api/session");
    csrfToken = session.csrfToken;
    loginForm.reset();
    showApp();
    await loadList();
    const requestedId = new URLSearchParams(window.location.search).get("feedback");
    if (requestedId) await loadDetail(requestedId);
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

logoutButton.addEventListener("click", async function () {
  logoutButton.disabled = true;
  try {
    await api("admin/api/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken }
    });
    feedbackList.replaceChildren();
    renderEmptyDetail();
    showLogin();
  } catch (error) {
    window.alert(error.message);
  } finally {
    logoutButton.disabled = false;
  }
});

for (const filter of filters) {
  filter.addEventListener("click", function () {
    currentFilter = filter.dataset.status;
    currentPage = 1;
    selectedId = "";
    renderEmptyDetail();
    for (const item of filters) item.classList.toggle("active", item === filter);
    loadList();
  });
}

for (const entry of [["previousPage", -1], ["nextPage", 1]]) {
  document.getElementById(entry[0]).addEventListener("click", function () {
    currentPage = Math.max(1, currentPage + entry[1]);
    selectedId = "";
    renderEmptyDetail();
    loadList();
  });
}

for (const tab of viewTabs) {
  tab.addEventListener("click", function () {
    switchView(tab.dataset.view);
  });
}

for (const typeButton of [document.getElementById("typeNotice"), document.getElementById("typeUpdate")]) {
  typeButton.addEventListener("click", function () {
    setAnnouncementType(typeButton.dataset.type);
  });
}

for (const inputId of [
  "announcementTitle",
  "announcementContent",
  "announcementVersionName",
  "announcementApkUrl",
  "announcementActionText"
]) {
  document.getElementById(inputId).addEventListener("input", renderAnnouncementPreview);
}
document.getElementById("announcementForced").addEventListener("change", renderAnnouncementPreview);
document.getElementById("publishAnnouncement").addEventListener("click", publishAnnouncement);
document.getElementById("reloadAnnouncement").addEventListener("click", function () {
  announcementError.textContent = "";
  loadAnnouncement(true);
});
document.getElementById("announcementEnabled").addEventListener("change", function (event) {
  if (announcementExists) {
    toggleAnnouncement(event.target.checked);
  }
});

boot();
