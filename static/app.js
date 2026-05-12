const qs = new URLSearchParams(window.location.search);
const roomId = (qs.get("room") || "default").replace(/[^\w-]/g, "-").slice(0, 40) || "default";
const storageKey = `food-wheel:${roomId}`;

const palette = ["#e94f37", "#167f7a", "#f2b84b", "#4b78bd", "#5a9f5d", "#d66f9f", "#6f6bb8", "#ef8b45"];

const state = {
  visitor: null,
  room: null,
  ws: null,
  selectedStrategy: "single",
  spinning: false,
  pendingState: null,
  rotation: 0,
};

const els = {
  roomTitle: document.querySelector("#roomTitle"),
  connectionStatus: document.querySelector("#connectionStatus"),
  wheel: document.querySelector("#wheel"),
  spinButton: document.querySelector("#spinButton"),
  currentResult: document.querySelector("#currentResult"),
  resultStrip: document.querySelector("#resultStrip"),
  nicknameInput: document.querySelector("#nicknameInput"),
  saveNickname: document.querySelector("#saveNickname"),
  strategyButtons: [...document.querySelectorAll("[data-strategy]")],
  targetRow: document.querySelector("#targetRow"),
  targetWins: document.querySelector("#targetWins"),
  optionsInput: document.querySelector("#optionsInput"),
  applySettings: document.querySelector("#applySettings"),
  resetButton: document.querySelector("#resetButton"),
  shareButton: document.querySelector("#shareButton"),
  finalResult: document.querySelector("#finalResult"),
  strategySummary: document.querySelector("#strategySummary"),
  scoreList: document.querySelector("#scoreList"),
  visitorList: document.querySelector("#visitorList"),
  historyList: document.querySelector("#historyList"),
  macNote: document.querySelector("#macNote"),
  toast: document.querySelector("#toast"),
};

els.roomTitle.textContent = roomId === "default" ? "今天吃什么" : `房间 ${roomId}`;

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 1900);
}

function getSavedClient() {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    return {};
  }
}

function saveClient(visitor) {
  localStorage.setItem(storageKey, JSON.stringify({
    client_id: visitor.client_id,
    nickname: visitor.nickname,
  }));
}

function getFingerprint() {
  const pieces = [
    navigator.userAgent,
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    String(navigator.hardwareConcurrency || ""),
    String(navigator.maxTouchPoints || ""),
  ];
  let hash = 2166136261;
  for (const text of pieces.join("|")) {
    hash ^= text.charCodeAt(0);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.visitor?.client_id) {
    headers["X-Client-Id"] = state.visitor.client_id;
  }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || "请求失败");
  }
  return data;
}

async function identify() {
  const saved = getSavedClient();
  const payload = {
    client_id: saved.client_id,
    nickname: saved.nickname,
    fingerprint: getFingerprint(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width}x${screen.height}`,
  };
  const data = await api(`/api/identify?room=${encodeURIComponent(roomId)}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.visitor = data.visitor;
  saveClient(data.visitor);
  els.nicknameInput.value = data.visitor.nickname;
  applyState(data.state);
}

function setConnection(text, kind) {
  els.connectionStatus.textContent = text;
  els.connectionStatus.classList.toggle("online", kind === "online");
  els.connectionStatus.classList.toggle("offline", kind === "offline");
}

function connectWebSocket() {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${window.location.host}/ws/${encodeURIComponent(roomId)}?client_id=${encodeURIComponent(state.visitor.client_id)}`;
  state.ws = new WebSocket(url);

  state.ws.addEventListener("open", () => setConnection("已联机", "online"));
  state.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      handleRealtimeState(message.state);
    }
  });
  state.ws.addEventListener("close", () => {
    setConnection("重连中", "offline");
    setTimeout(connectWebSocket, 1200);
  });
}

function drawWheel(options) {
  const canvas = els.wheel;
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const radius = size / 2;
  const innerRadius = radius * 0.18;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(radius, radius);

  const count = Math.max(options.length, 1);
  const slice = (Math.PI * 2) / count;
  options.forEach((option, index) => {
    const start = -Math.PI / 2 + index * slice;
    const end = start + slice;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius - 10, start, end);
    ctx.closePath();
    ctx.fillStyle = palette[index % palette.length];
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.78)";
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.save();
    ctx.rotate(start + slice / 2);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${Math.max(22, Math.min(34, 280 / option.length))}px system-ui, sans-serif`;
    ctx.shadowColor = "rgba(0,0,0,0.24)";
    ctx.shadowBlur = 4;
    ctx.fillText(option, radius - 38, 0, radius * 0.58);
    ctx.restore();
  });

  ctx.beginPath();
  ctx.arc(0, 0, innerRadius, 0, Math.PI * 2);
  ctx.fillStyle = "#fffdf8";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = "rgba(32,36,34,0.14)";
  ctx.stroke();
  ctx.restore();
}

function setStrategy(strategy) {
  state.selectedStrategy = strategy;
  els.strategyButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.strategy === strategy);
  });
  els.targetRow.classList.toggle("visible", strategy === "first_to");
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function applyState(nextState) {
  const previousResult = state.room?.current_result;
  state.room = nextState;
  state.selectedStrategy = nextState.strategy;

  drawWheel(nextState.options);
  setStrategy(nextState.strategy);
  els.targetWins.value = nextState.target_wins;
  if (document.activeElement !== els.optionsInput) {
    els.optionsInput.value = nextState.options.join("\n");
  }

  els.currentResult.textContent = nextState.current_result || "待开转";
  els.finalResult.textContent = nextState.final_result || "还没有结论";
  els.strategySummary.textContent = `${nextState.strategy_label} · 第 ${nextState.round_no} 轮`;
  els.spinButton.disabled = Boolean(nextState.final_result) || state.spinning;
  els.macNote.textContent = nextState.mac_note;

  renderScores(nextState);
  renderVisitors(nextState.visitors);
  renderHistory(nextState.history);

  if (nextState.current_result && nextState.current_result !== previousResult && !state.spinning) {
    pulseResult();
  }
}

function handleRealtimeState(nextState) {
  const currentRound = state.room?.round_no || 0;
  const hasNewSpin = nextState.round_no > currentRound && nextState.current_result;

  if (!hasNewSpin) {
    applyState(nextState);
    return;
  }

  if (state.spinning) {
    state.pendingState = nextState;
    return;
  }

  playSpinAnimation(nextState);
}

function playSpinAnimation(nextState) {
  state.spinning = true;
  els.spinButton.disabled = true;
  els.spinButton.querySelector("span").textContent = "转动";
  animateToResult(nextState.current_result, nextState.options);
  setTimeout(() => {
    state.spinning = false;
    els.spinButton.querySelector("span").textContent = "开转";
    applyState(nextState);
    pulseResult();
    if (nextState.final_result) {
      toast(`最终决定：${nextState.final_result}`);
    }
  }, 2650);
}

function renderScores(room) {
  const entries = Object.entries(room.scores).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    els.scoreList.innerHTML = `<div class="meta">开转后会显示每个选项的胜场。</div>`;
    return;
  }
  els.scoreList.innerHTML = entries.map(([name, score]) => `
    <div class="score-item">
      <strong>${escapeHtml(name)}</strong>
      <span class="meta">${score}/${room.effective_target_wins}</span>
    </div>
  `).join("");
}

function renderVisitors(visitors) {
  if (!visitors.length) {
    els.visitorList.innerHTML = `<div class="meta">暂无在线设备。</div>`;
    return;
  }
  els.visitorList.innerHTML = visitors.map((visitor) => {
    const deviceLabel = visitor.device?.label || "未知设备";
    const screenInfo = visitor.screen ? ` · ${visitor.screen}` : "";
    const device = `${deviceLabel}${screenInfo}`;
    const network = visitor.mac ? `${visitor.ip} · ${visitor.mac}` : visitor.ip;
    return `
      <div class="visitor-item">
        <strong>${escapeHtml(visitor.nickname)}</strong>
        <span class="meta">${escapeHtml(device)}<br>${escapeHtml(network)}</span>
      </div>
    `;
  }).join("");
}

function renderHistory(history) {
  if (!history.length) {
    els.historyList.innerHTML = `<div class="meta">暂无历史记录。</div>`;
    return;
  }
  els.historyList.innerHTML = history.slice(0, 8).map((item) => `
    <div class="history-item">
      <strong>${item.final ? "定了：" : ""}${escapeHtml(item.result)}</strong>
      <span class="meta">#${item.round} · ${escapeHtml(item.spinner)} · ${formatTime(item.created_at)}</span>
    </div>
  `).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pulseResult() {
  els.resultStrip.animate(
    [
      { transform: "scale(1)", background: "transparent" },
      { transform: "scale(1.018)", background: "rgba(242, 184, 75, 0.22)" },
      { transform: "scale(1)", background: "transparent" },
    ],
    { duration: 620, easing: "ease-out" },
  );
}

function animateToResult(result, optionsOverride) {
  const options = optionsOverride || state.room.options;
  const index = options.indexOf(result);
  const count = Math.max(options.length, 1);
  const slice = 360 / count;
  const targetCenter = index >= 0 ? index * slice + slice / 2 : 0;
  const turns = 5 + Math.floor(Math.random() * 3);
  state.rotation += turns * 360 + (360 - targetCenter) - (state.rotation % 360);
  document.documentElement.style.setProperty("--spin-duration", "2600ms");
  document.documentElement.style.setProperty("--wheel-rotation", `${state.rotation}deg`);
}

async function spin() {
  if (state.spinning || !state.room) {
    return;
  }
  state.spinning = true;
  els.spinButton.disabled = true;
  els.spinButton.querySelector("span").textContent = "转动";
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/spin`, { method: "POST", body: "{}" });
    animateToResult(data.record.result);
    setTimeout(() => {
      state.spinning = false;
      els.spinButton.querySelector("span").textContent = "开转";
      applyState(data.state);
      state.pendingState = null;
      pulseResult();
      if (data.state.final_result) {
        toast(`最终决定：${data.state.final_result}`);
      }
    }, 2650);
  } catch (error) {
    state.spinning = false;
    els.spinButton.querySelector("span").textContent = "开转";
    els.spinButton.disabled = Boolean(state.room?.final_result);
    toast(error.message);
  }
}

async function applySettings() {
  const options = els.optionsInput.value
    .split(/\n|,|，/)
    .map((item) => item.trim())
    .filter(Boolean);
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/settings`, {
      method: "POST",
      body: JSON.stringify({
        options,
        strategy: state.selectedStrategy,
        target_wins: Number(els.targetWins.value || 1),
      }),
    });
    applyState(data);
    toast("设置已应用");
  } catch (error) {
    toast(error.message);
  }
}

async function saveNickname() {
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/nickname`, {
      method: "POST",
      body: JSON.stringify({ nickname: els.nicknameInput.value }),
    });
    state.visitor = data.visitor;
    saveClient(data.visitor);
    toast("昵称已保存");
  } catch (error) {
    toast(error.message);
  }
}

async function resetGame() {
  const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/reset`, { method: "POST", body: "{}" });
  applyState(data);
  toast("对局已重置");
}

async function shareRoom() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  await navigator.clipboard.writeText(url.toString());
  toast("房间链接已复制");
}

els.spinButton.addEventListener("click", spin);
els.applySettings.addEventListener("click", applySettings);
els.saveNickname.addEventListener("click", saveNickname);
els.resetButton.addEventListener("click", resetGame);
els.shareButton.addEventListener("click", shareRoom);
els.strategyButtons.forEach((button) => {
  button.addEventListener("click", () => setStrategy(button.dataset.strategy));
});

identify()
  .then(connectWebSocket)
  .catch((error) => {
    setConnection("连接失败", "offline");
    toast(error.message);
  });
