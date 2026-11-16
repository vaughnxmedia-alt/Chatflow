const app = document.querySelector("#app");
const PLATFORMS = [
  ["twitch", "Twitch"],
  ["youtube", "YouTube"],
  ["tiktok", "TikTok"],
  ["kick", "Kick"],
  ["facebook", "Facebook"],
  ["other", "Other"],
];

const state = {
  user: null,
  authMode: "login",
  dashboards: [],
  view: "home",
  selectedId: null,
  showForm: false,
  error: "",
  chat: [],
  socketStatus: "Not connected",
};

let socket;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child?.nodeType ? child : document.createTextNode(child ?? ""));
  }
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function platformLabel(id) {
  return PLATFORMS.find(([value]) => value === id)?.[1] || "Other";
}

function selected() {
  return state.dashboards.find((item) => item.id === state.selectedId) || null;
}

function closeSocket() {
  if (socket) {
    socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
    socket.close();
    socket = null;
  }
}

function connectChat(dashboard) {
  closeSocket();
  state.chat = [];
  state.socketStatus = "Connecting to Social Stream…";
  const url = `wss://io.socialstream.ninja/join/${encodeURIComponent(dashboard.sessionId)}/4`;
  socket = new WebSocket(url);
  socket.onopen = () => {
    state.socketStatus = "Listening for chat on this session.";
    render();
  };
  socket.onerror = () => {
    state.socketStatus = "Could not reach Social Stream. Check the session ID and that “Send chat messages to API server” is on.";
    render();
  };
  socket.onclose = () => {
    if (state.socketStatus.startsWith("Listening")) state.socketStatus = "Chat connection closed.";
    render();
  };
  socket.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || !data.chatname) return;
    state.chat.unshift({
      id: data.id || `${Date.now()}-${state.chat.length}`,
      type: data.type || "chat",
      name: data.chatname,
      text: data.chatmessage || data.donations || "",
      donation: data.hasDonation || "",
    });
    state.chat = state.chat.slice(0, 200);
    render();
  };
}

function renderAuth() {
  const login = state.authMode === "login";
  const form = el("form", {
    onsubmit: async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.target));
      try {
        const result = await api(login ? "/api/login" : "/api/register", { method: "POST", body: data });
        state.user = result.user;
        state.error = "";
        state.view = "home";
        await loadDashboards();
      } catch (error) {
        state.error = error.message;
        render();
      }
    },
  }, [
    !login && label("Name", el("input", { name: "name", required: true, maxlength: "80", autocomplete: "name" })),
    label("Email", el("input", { name: "email", type: "email", required: true, autocomplete: "username" })),
    label("Password", el("input", { name: "password", type: "password", required: true, minlength: login ? "1" : "8", autocomplete: login ? "current-password" : "new-password" })),
    el("p", { class: "error" }, [state.error]),
    el("button", { class: "primary", type: "submit" }, [login ? "Sign in" : "Create account"]),
  ].filter(Boolean));

  app.replaceChildren(el("div", { class: "auth-shell" }, [
    el("section", { class: "auth-copy" }, [
      el("div", { class: "mark" }, [el("i"), "Live Desk"]),
      el("h1", {}, ["Every live chat, one signed-in desk."]),
      el("p", { class: "lede" }, ["Social Stream Ninja still captures Twitch, YouTube, and TikTok. Live Desk is the private front door: each person signs in and only sees their own shows."]),
    ]),
    el("section", { class: "auth-card" }, [
      el("div", { class: "tabs" }, [
        el("button", { type: "button", class: login ? "active" : "", onclick: () => { state.authMode = "login"; state.error = ""; render(); } }, ["Sign in"]),
        el("button", { type: "button", class: login ? "" : "active", onclick: () => { state.authMode = "register"; state.error = ""; render(); } }, ["Create account"]),
      ]),
      form,
    ]),
  ]));
}

function label(text, field) {
  return el("label", {}, [text, field]);
}

function accountChips(dashboard) {
  return el("div", { class: "accounts" }, dashboard.accounts.map((account) => el("div", { class: "account" }, [
    el("strong", {}, [platformLabel(account.platform)]),
    el("span", {}, [account.live ? "Live" : "Offline", account.handle ? ` · ${account.handle}` : ""]),
  ])));
}

function dashboardCard(dashboard) {
  return el("article", { class: dashboard.live ? "card live" : "card" }, [
    el("div", { class: "card-top" }, [
      el("h2", {}, [dashboard.name]),
      el("span", { class: dashboard.live ? "pill live" : "pill" }, [dashboard.live ? "Live" : "Offline"]),
    ]),
    accountChips(dashboard),
    el("p", { class: "hint" }, [`Session ${dashboard.sessionId}`]),
    el("button", { class: "primary", type: "button", onclick: () => openDashboard(dashboard.id) }, ["Open chat"]),
  ]);
}

function renderHome() {
  const live = state.dashboards.filter((item) => item.live);
  const offline = state.dashboards.filter((item) => !item.live);
  const list = el("div", {}, [
    live.length ? el("p", { class: "section-label" }, ["Live now"]) : "",
    live.length ? el("div", { class: "grid" }, live.map(dashboardCard)) : "",
    offline.length ? el("p", { class: "section-label" }, [live.length ? "Not live" : "Your shows"]) : "",
    offline.length ? el("div", { class: "grid" }, offline.map(dashboardCard)) : "",
    !state.dashboards.length ? el("div", { class: "empty card" }, [
      el("h2", {}, ["No shows yet"]),
      el("p", {}, ["Add a Social Stream session and the accounts that belong to it. When you mark an account live, that show moves to the top of this desk."]),
    ]) : "",
  ].filter(Boolean));

  app.replaceChildren(shell([
    el("div", { class: "top" }, [
      el("div", {}, [
        el("h1", {}, ["Shows"]),
        el("p", { class: "hint" }, ["Live shows stay at the top. Open one to manage the combined chat."]),
      ]),
      el("button", { class: "primary", type: "button", onclick: () => { state.showForm = !state.showForm; state.error = ""; render(); } }, [state.showForm ? "Close" : "Add show"]),
    ]),
    state.showForm ? showForm() : "",
    list,
  ].filter(Boolean)));
}

function accountEditor(existing = [{ platform: "twitch", handle: "", live: false }]) {
  const wrap = el("div", { class: "account-editor" });
  const rows = existing.map((account) => ({ ...account }));
  const draw = () => {
    wrap.replaceChildren(...rows.map((account, index) => el("div", { class: "account-row" }, [
      el("select", { name: `platform-${index}`, onchange: (event) => { account.platform = event.target.value; } }, PLATFORMS.map(([value, name]) => {
        const option = el("option", { value }, [name]);
        if (value === account.platform) option.selected = true;
        return option;
      })),
      el("input", { name: `handle-${index}`, placeholder: "account name", value: account.handle, oninput: (event) => { account.handle = event.target.value; } }),
      el("button", { type: "button", class: "ghost", onclick: () => { rows.splice(index, 1); draw(); } }, ["Remove"]),
    ])));
  };
  draw();
  return { wrap, rows, draw, add() { rows.push({ platform: "youtube", handle: "", live: false }); draw(); } };
}

function showForm() {
  const editor = accountEditor();
  return el("form", { class: "panel", onsubmit: async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    try {
      await api("/api/dashboards", {
        method: "POST",
        body: {
          name: data.get("name"),
          sessionId: data.get("sessionId"),
          accounts: editor.rows,
        },
      });
      state.showForm = false;
      state.error = "";
      await loadDashboards();
    } catch (error) {
      state.error = error.message;
      render();
    }
  } }, [
    label("Show name", el("input", { name: "name", required: true, placeholder: "Sunday night" })),
    label("Social Stream session ID", el("input", { name: "sessionId", required: true, placeholder: "from your dock link" })),
    el("p", { class: "hint" }, ["In Social Stream, turn on remote API control and “Send chat messages to API server”. Use the same session ID here."]),
    editor.wrap,
    el("div", { class: "account-row" }, [
      el("button", { type: "button", class: "ghost", onclick: () => editor.add() }, ["Add account"]),
      el("button", { class: "primary", type: "submit" }, ["Save show"]),
    ]),
    el("p", { class: "error" }, [state.error]),
  ]);
}

async function setAccountLive(dashboard, accountId, live) {
  const accounts = dashboard.accounts.map((account) => account.id === accountId ? { ...account, live } : account);
  await api(`/api/dashboards/${dashboard.id}`, { method: "PATCH", body: { accounts } });
  await loadDashboards(false);
  if (state.view === "room") render();
}

function renderRoom() {
  const dashboard = selected();
  if (!dashboard) {
    state.view = "home";
    renderHome();
    return;
  }
  app.replaceChildren(shell([
    el("div", { class: "room-head" }, [
      el("div", {}, [
        el("button", { class: "text-btn", type: "button", onclick: () => { state.view = "home"; closeSocket(); render(); } }, ["All shows"]),
        el("h1", {}, [dashboard.name]),
      ]),
      el("span", { class: dashboard.live ? "pill live" : "pill" }, [dashboard.live ? "Live" : "Offline"]),
    ]),
    el("div", { class: "room" }, [
      el("aside", { class: "panel" }, [
        el("h2", {}, ["Accounts"]),
        ...dashboard.accounts.map((account) => el("div", { class: "account", style: "margin-top:10px" }, [
          el("strong", {}, [platformLabel(account.platform)]),
          el("span", {}, [account.handle]),
          el("button", {
            class: account.live ? "primary" : "ghost",
            type: "button",
            style: "margin-top:8px",
            onclick: () => setAccountLive(dashboard, account.id, !account.live),
          }, [account.live ? "Mark offline" : "Mark live"]),
        ])),
        el("p", { class: "hint" }, [
          el("a", { href: `https://socialstream.ninja/dock.html?session=${encodeURIComponent(dashboard.sessionId)}&server`, target: "_blank", rel: "noreferrer" }, ["Open Social Stream dock"]),
        ]),
        el("button", { class: "text-btn danger", type: "button", onclick: () => removeDashboard(dashboard.id) }, ["Delete show"]),
      ]),
      el("section", { class: "chat" }, [
        el("div", { class: "status-line" }, [state.socketStatus]),
        el("div", { class: "messages" }, state.chat.length ? state.chat.map((message) => el("article", { class: "message" }, [
          el("b", {}, [message.type]),
          el("div", {}, [
            el("strong", {}, [message.name]),
            message.donation ? el("span", { class: "hint" }, [` · ${message.donation}`]) : "",
            el("div", {}, [message.text]),
          ]),
        ])) : [el("p", { class: "hint" }, ["Messages show up here once Social Stream publishes chat for this session."])]),
      ]),
    ]),
  ]));
}

function shell(children) {
  return el("div", { class: "desk" }, [
    el("aside", { class: "rail" }, [
      el("div", { class: "mark" }, [el("i"), "Live Desk"]),
      el("div", { class: "who" }, [
        el("strong", {}, [state.user.name]),
        el("span", {}, [state.user.email]),
        el("button", { class: "ghost", type: "button", onclick: logout }, ["Sign out"]),
      ]),
    ]),
    el("main", { class: "main" }, children),
  ]);
}

async function removeDashboard(id) {
  if (!confirm("Delete this show?")) return;
  await api(`/api/dashboards/${id}`, { method: "DELETE" });
  state.view = "home";
  closeSocket();
  await loadDashboards();
}

async function logout() {
  closeSocket();
  await api("/api/logout", { method: "POST" });
  state.user = null;
  state.dashboards = [];
  state.view = "home";
  render();
}

async function loadDashboards(paint = true) {
  const result = await api("/api/dashboards");
  state.dashboards = result.dashboards;
  if (paint) render();
}

function openDashboard(id) {
  state.selectedId = id;
  state.view = "room";
  const dashboard = selected();
  render();
  if (dashboard) connectChat(dashboard);
}

function render() {
  if (!state.user) renderAuth();
  else if (state.view === "room") renderRoom();
  else renderHome();
}

const me = await api("/api/me");
state.user = me.user;
if (state.user) await loadDashboards(false);
render();
