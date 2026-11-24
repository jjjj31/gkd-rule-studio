(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================= 导航 ================= */
  const nav = document.getElementById("nav");
  const navToggle = document.getElementById("navToggle");
  const navDrawer = document.getElementById("navDrawer");

  const onScrollNav = () => nav?.classList.toggle("scrolled", window.scrollY > 8);
  onScrollNav();
  window.addEventListener("scroll", onScrollNav, { passive: true });

  const setDrawer = (open) => {
    navToggle?.setAttribute("aria-expanded", String(open));
    navToggle?.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
    if (navDrawer) navDrawer.hidden = !open;
    nav?.classList.toggle("scrolled", open || window.scrollY > 8);
  };
  navToggle?.addEventListener("click", () => setDrawer(navToggle.getAttribute("aria-expanded") !== "true"));
  navDrawer?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setDrawer(false)));

  /* ================= 气泡提示（可关闭、不占布局） ================= */
  const toastRegion = document.getElementById("toastRegion");
  function showToast(message, type = "success") {
    if (!toastRegion) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const text = document.createElement("span");
    text.textContent = message;
    const close = document.createElement("button");
    close.className = "toast-close";
    close.type = "button";
    close.setAttribute("aria-label", "关闭提示");
    close.textContent = "×";
    toast.append(text, close);
    const remove = () => toast.remove();
    close.addEventListener("click", remove);
    toastRegion.appendChild(toast);
    while (toastRegion.children.length > 2) toastRegion.firstElementChild?.remove();
    window.setTimeout(remove, 3200);
  }

  /* ================= 数字滚动 ================= */
  function formatNum(el, value) {
    const decimals = Number(el.dataset.decimals || 0);
    let str = value.toFixed(decimals);
    if (el.dataset.group === "true") str = Number(str).toLocaleString("en-US");
    return str + (el.dataset.suffix || "");
  }

  function countUp(el) {
    const target = Number(el.dataset.count);
    if (!Number.isFinite(target) || reduceMotion) return;
    const duration = 680;
    const base = target * 0.72;
    const span = target - base;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = formatNum(el, base + span * eased);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = formatNum(el, target);
    };
    requestAnimationFrame(tick);
  }

  /* ================= 滚动入场 ================= */
  const revealTargets = document.querySelectorAll(".reveal, .chart");
  if ("IntersectionObserver" in window && !reduceMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          // 同一父容器中的兄弟依次延迟，形成层次感
          const siblings = el.parentElement ? [...el.parentElement.children].filter((c) => c.classList.contains("reveal")) : [];
          const idx = Math.max(0, siblings.indexOf(el));
          el.style.transitionDelay = `${Math.min(idx, 5) * 60}ms`;
          el.classList.add("in");
          el.querySelectorAll("[data-count]").forEach(countUp);
          io.unobserve(el);
        });
      },
      { threshold: 0.06, rootMargin: "0px 0px -20px 0px" }
    );
    revealTargets.forEach((el) => io.observe(el));
  } else {
    revealTargets.forEach((el) => el.classList.add("in"));
  }

  /* ================= Hero 样机视差 ================= */
  const heroStage = document.getElementById("heroStage");
  /* ================= 宣言逐字点亮 ================= */
  const statement = document.getElementById("statementText");
  let statementChars = [];
  if (statement) {
    const raw = statement.textContent.trim();
    const accentFrom = raw.indexOf("现在，");
    statement.textContent = "";
    const frag = document.createDocumentFragment();
    [...raw].forEach((ch, i) => {
      const span = document.createElement("span");
      span.className = "ch" + (accentFrom >= 0 && i >= accentFrom ? " accent" : "");
      span.textContent = ch;
      frag.appendChild(span);
    });
    statement.appendChild(frag);
    statement.setAttribute("aria-label", raw);
    statementChars = [...statement.querySelectorAll(".ch")];
    if (reduceMotion) statementChars.forEach((c) => c.classList.add("lit"));
  }

  let ticking = false;
  function onScrollFx() {
    ticking = false;
    const vh = window.innerHeight;

    if (heroStage && !reduceMotion) {
      const r = heroStage.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, 1 - r.top / vh));
      heroStage.style.setProperty("--hp", p.toFixed(3));
    }

    if (statement && statementChars.length && !reduceMotion) {
      const r = statement.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, (vh * 0.8 - r.top) / (r.height + vh * 0.3)));
      const litCount = Math.round(progress * statementChars.length);
      statementChars.forEach((c, i) => c.classList.toggle("lit", i < litCount));
    }
  }
  const requestFx = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(onScrollFx);
    }
  };
  window.addEventListener("scroll", requestFx, { passive: true });
  window.addEventListener("resize", requestFx);
  onScrollFx();

  /* ================= 在线体验 ================= */
  const SCENES = {
    splash: {
      title: "开屏广告 · 跳过按钮",
      preset: "开屏广告",
      target: '[data-target="splash-skip"]',
      node: "LinearLayout[clickable=true]",
      check: "唯一命中 1/1 · 已避开摇一摇热区",
      appId: "com.example.app",
      groupName: "开屏广告",
      fields: { matchTime: 10000, actionMaximum: 1, resetMatch: "app" },
      candidates: [
        { name: "Top-1 · 文本前缀 + 长度约束", score: "稳定 · 1/1", selector: '[text^="跳过"][text.length<10][visibleToUser=true]' },
        { name: "候选 2 · vid 精确定位", score: "较稳 · 1/1", selector: 'LinearLayout[vid="tt_splash_skip_btn"][clickable=true]' },
        { name: "候选 3 · 文本 + 尺寸上限", score: "稳定 · 1/1", selector: '[text*="跳过"][width<500][height<300]' },
      ],
    },
    popup: {
      title: "入页弹窗 · 关闭按钮",
      preset: "进入页面弹窗",
      target: '[data-target="popup-close"]',
      node: "ImageView[clickable=true]",
      check: "唯一命中 1/1 · 祖先文本收窄",
      appId: "com.example.shop",
      groupName: "局部广告-新人礼包弹窗",
      fields: { activityIds: [".MainActivity"], matchTime: 10000, actionMaximum: 1, resetMatch: "activity" },
      candidates: [
        { name: "Top-1 · 文案锚点 + 关闭图标", score: "稳定 · 1/1", selector: '[text*="大礼包"] <<2 FrameLayout > ImageView[clickable=true][width<140]' },
        { name: "候选 2 · 匿名结构收窄", score: "较稳 · 1/1", selector: "FrameLayout[childCount=2] > ImageView[clickable=true][width=height]" },
      ],
    },
    feed: {
      title: "信息流 · 卡片关闭",
      preset: "信息流广告",
      target: '[data-target="feed-close"]',
      node: "FrameLayout[clickable=true]",
      check: "唯一命中 1/1 · 绑定「广告」角标",
      appId: "com.example.news",
      groupName: "分段广告-信息流卡片",
      fields: { activityIds: [".FeedActivity"], actionCd: 1500 },
      candidates: [
        { name: "Top-1 · 广告角标上下文", score: "稳定 · 1/1", selector: '[text="广告"] <<3 ViewGroup >2 [text="✕"][clickable=true]' },
        { name: "候选 2 · 推广文案相邻兄弟", score: "较稳 · 1/1", selector: '[text^="推广"] + FrameLayout[clickable=true][width<110]' },
      ],
    },
  };

  const canvas = document.getElementById("demoCanvas");
  const magnifier = document.getElementById("magnifier");
  const badge = document.getElementById("magnifierBadge");
  const statusEl = document.getElementById("inspectorStatus");
  const titleEl = document.getElementById("inspectorTitle");
  const presetEl = document.getElementById("inspectorPreset");
  const nodeEl = document.getElementById("metaNode");
  const checkEl = document.getElementById("metaCheck");
  const listEl = document.getElementById("candidateList");
  const codeEl = document.getElementById("ruleCodeOutput");
  const segIndicator = document.querySelector(".seg-indicator");
  const segButtons = [...document.querySelectorAll(".seg-btn")];

  let sceneKey = "splash";
  let candIdx = 0;
  let locked = false;
  let ruleText = "";

  function buildRule(scene, cand) {
    const f = scene.fields;
    const lines = ["{", `  id: '${scene.appId}',`, "  groups: [", "    {", "      key: 1,", `      name: '${scene.groupName}',`];
    if (f.activityIds) lines.push(`      activityIds: [${f.activityIds.map((a) => `'${a}'`).join(", ")}],`);
    if (f.matchTime) lines.push(`      matchTime: ${f.matchTime},`);
    if (f.actionMaximum) lines.push(`      actionMaximum: ${f.actionMaximum},`);
    if (f.actionCd) lines.push(`      actionCd: ${f.actionCd},`);
    if (f.resetMatch) lines.push(`      resetMatch: '${f.resetMatch}',`);
    lines.push("      rules: [", `        { matches: '${cand.selector}' },`, "      ],", "    },", "  ],", "}");
    return lines.join("\n");
  }

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function highlight(src) {
    return src
      .split("\n")
      .map((line) =>
        esc(line).replace(/('(?:[^'\\]|\\.)*')|(^\s*[A-Za-z]+(?=:))|(\b\d+\b)/g, (m, str, key, num) => {
          if (str) return `<span class="tk-s">${str}</span>`;
          if (key) return `<span class="tk-k">${key}</span>`;
          if (num) return `<span class="tk-n">${num}</span>`;
          return m;
        })
      )
      .join("\n");
  }

  function renderInspector() {
    const scene = SCENES[sceneKey];
    const cand = scene.candidates[candIdx] || scene.candidates[0];
    if (titleEl) titleEl.textContent = scene.title;
    if (presetEl) presetEl.textContent = scene.preset;
    if (nodeEl) nodeEl.textContent = scene.node;
    if (checkEl) checkEl.textContent = scene.check;

    if (listEl) {
      listEl.textContent = "";
      scene.candidates.forEach((c, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cand-item" + (i === candIdx ? " active" : "");
        btn.setAttribute("aria-pressed", String(i === candIdx));
        const top = document.createElement("div");
        top.className = "cand-top";
        const name = document.createElement("span");
        name.className = "cand-name";
        name.textContent = c.name;
        const score = document.createElement("span");
        score.className = "cand-score";
        score.textContent = c.score;
        top.append(name, score);
        const sel = document.createElement("code");
        sel.className = "cand-sel";
        sel.textContent = c.selector;
        btn.append(top, sel);
        btn.addEventListener("click", () => {
          candIdx = i;
          renderInspector();
        });
        listEl.appendChild(btn);
      });
    }

    ruleText = buildRule(scene, cand);
    if (codeEl) codeEl.innerHTML = highlight(ruleText);
  }

  const activeTarget = () => canvas?.querySelector(SCENES[sceneKey].target) || null;

  function targetCenter() {
    const t = activeTarget();
    if (!canvas || !t) return null;
    const c = canvas.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
  }

  function setLocked(on) {
    locked = on;
    canvas?.querySelectorAll(".demo-target").forEach((el) => el.classList.remove("is-locked"));
    if (on) activeTarget()?.classList.add("is-locked");
    magnifier?.classList.toggle("is-locked", on);
    if (badge) badge.textContent = on ? "已命中" : "对准按钮";
    if (statusEl) {
      statusEl.classList.toggle("idle", !on);
      statusEl.lastChild.textContent = on ? "已锁定目标控件" : "拖动放大镜，对准关闭按钮";
    }
  }

  function placeMagnifier(x, y) {
    if (!magnifier) return;
    magnifier.style.left = `${x}px`;
    magnifier.style.top = `${y}px`;
  }

  function parkMagnifier() {
    if (!canvas) return;
    const c = canvas.getBoundingClientRect();
    placeMagnifier(c.width * 0.42, c.height * 0.58);
    setLocked(false);
    if (badge) badge.textContent = "拖我";
  }

  function snapToTarget() {
    const p = targetCenter();
    if (!p) return;
    placeMagnifier(p.x, p.y);
    setLocked(true);
  }

  function switchScene(key) {
    if (!SCENES[key]) return;
    sceneKey = key;
    candIdx = 0;
    segButtons.forEach((b, i) => {
      const on = b.dataset.scene === key;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      if (on && segIndicator) segIndicator.style.transform = `translateX(${i * 100}%)`;
    });
    document.querySelectorAll(".mock-scene").forEach((p) => p.classList.toggle("active", p.dataset.scenePanel === key));
    renderInspector();
    requestAnimationFrame(parkMagnifier);
  }

  segButtons.forEach((b) => b.addEventListener("click", () => switchScene(b.dataset.scene)));

  canvas?.querySelectorAll(".demo-target").forEach((t) => {
    const pick = () => {
      snapToTarget();
      showToast("已锁定目标控件，候选规则已在本地生成");
    };
    t.addEventListener("click", pick);
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
  });

  let dragging = false;
  function dragTo(clientX, clientY) {
    if (!canvas) return;
    const c = canvas.getBoundingClientRect();
    const x = Math.max(30, Math.min(c.width - 30, clientX - c.left));
    const y = Math.max(30, Math.min(c.height - 30, clientY - c.top));
    placeMagnifier(x, y);
    const p = targetCenter();
    if (p) setLocked(Math.hypot(x - p.x, y - p.y) < 50);
  }

  magnifier?.addEventListener("pointerdown", (e) => {
    dragging = true;
    magnifier.classList.add("dragging");
    magnifier.setPointerCapture(e.pointerId);
    dragTo(e.clientX, e.clientY);
  });
  magnifier?.addEventListener("pointermove", (e) => dragging && dragTo(e.clientX, e.clientY));
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    magnifier?.classList.remove("dragging");
    if (locked) {
      snapToTarget();
      showToast("松手完成选点：候选规则已按稳定性排序");
    }
  };
  magnifier?.addEventListener("pointerup", endDrag);
  magnifier?.addEventListener("pointercancel", endDrag);

  // 键盘可达：方向键移动放大镜，回车吸附
  magnifier?.addEventListener("keydown", (e) => {
    if (!canvas) return;
    const step = e.shiftKey ? 30 : 12;
    const x = parseFloat(magnifier.style.left) || 0;
    const y = parseFloat(magnifier.style.top) || 0;
    const c = canvas.getBoundingClientRect();
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      dragTo(c.left + x + moves[e.key][0], c.top + y + moves[e.key][1]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      snapToTarget();
    }
  });

  document.getElementById("btnCopyRule")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ruleText);
      showToast("已复制规则 JSON5");
    } catch {
      showToast("浏览器阻止了自动复制，请手动选中代码复制", "warn");
    }
  });

  document.getElementById("btnSimulateTest")?.addEventListener("click", () => {
    if (!locked) {
      showToast("请先把放大镜拖到关闭按钮上，再推入测试", "warn");
      return;
    }
    showToast(`已推入 GKD 内存订阅：「${SCENES[sceneKey].groupName}」（模拟）`);
  });

  switchScene("splash");
  window.addEventListener("resize", () => (locked ? snapToTarget() : parkMagnifier()));

  /* ================= 灯箱 ================= */
  const lightbox = document.getElementById("lightbox");
  const lbImg = document.getElementById("lightboxImg");
  const lbCap = document.getElementById("lightboxCaption");
  const lbClose = document.getElementById("lightboxClose");
  let lastFocus = null;

  const closeLightbox = () => {
    if (!lightbox || lightbox.hidden) return;
    lightbox.hidden = true;
    document.body.style.overflow = "";
    lastFocus?.focus();
  };

  document.querySelectorAll("[data-lightbox]").forEach((btn) => {
    btn.addEventListener("click", () => {
      lastFocus = btn;
      if (lbImg) {
        lbImg.src = btn.dataset.lightbox || "";
        lbImg.alt = btn.dataset.caption || "";
      }
      if (lbCap) lbCap.textContent = btn.dataset.caption || "";
      if (lightbox) lightbox.hidden = false;
      document.body.style.overflow = "hidden";
      lbClose?.focus();
    });
  });
  lbClose?.addEventListener("click", closeLightbox);
  lightbox?.addEventListener("click", (e) => e.target === lightbox && closeLightbox());
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeLightbox());
})();
