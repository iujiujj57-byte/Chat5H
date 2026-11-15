import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  browserLocalPersistence, setPersistence,
  onAuthStateChanged, signOut, updateProfile, deleteUser,
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, onSnapshot, addDoc, serverTimestamp,
  arrayUnion, arrayRemove, writeBatch, orderBy, limit, getDocs
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Keep users signed in when they refresh or reopen the site.
setPersistence(auth, browserLocalPersistence).catch(error => {
  console.error("Could not set sign-in persistence:", error);
});

const $ = id => document.getElementById(id);
const state = {
  user: null, servers: [], serverId: null, pendingServerId: null, server: null, channel: "general", defaultServerCreating: false,
  unsubServers: null, unsubMessages: null, unsubMembers: null, messages: [],
  signup: false, toastTimer: null,
  mode: "server", dmId: null, dmFriend: null, friends: [], incoming: [], outgoing: [], pendingImage: null,
  unsubFriends: null, unsubIncoming: null, unsubOutgoing: null, unsubCalls: null
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function safeName(value, fallback = "User") {
  const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
  return name || fallback;
}
function initials(name) {
  return safeName(name).slice(0, 1).toUpperCase();
}
function stopListeners() {
  for (const key of ["unsubServers", "unsubMessages", "unsubMembers", "unsubFriends", "unsubIncoming", "unsubOutgoing", "unsubCalls"]) {
    if (state[key]) state[key]();
    state[key] = null;
  }
}
function showAuth() {
  $("authScreen").hidden = false;
  $("chatApp").hidden = true;
}
function showApp() {
  $("authScreen").hidden = true;
  $("chatApp").hidden = false;
}
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

$("authModeToggle").addEventListener("click", () => {
  state.signup = !state.signup;
  $("displayNameWrap").hidden = !state.signup;
  $("authSubtitle").textContent = state.signup ? "Create your Chat5H account." : "Sign in to continue chatting.";
  $("authSubmit").textContent = state.signup ? "Create account" : "Sign in";
  $("authModeToggle").textContent = state.signup ? "Already have an account? Sign in" : "Need an account? Sign up";
  $("authError").textContent = "";
  $("passwordInput").autocomplete = state.signup ? "new-password" : "current-password";
});

$("authForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("authError").textContent = "";
  const email = $("emailInput").value.trim();
  const password = $("passwordInput").value;
  const displayName = safeName($("displayNameInput").value, "");
  try {
    $("authSubmit").disabled = true;
    if (state.signup) {
      if (!displayName) throw new Error("Please enter a display name.");
      const result = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(result.user, { displayName });
      await setDoc(doc(db, "users", result.user.uid), {
        displayName, email, createdAt: serverTimestamp()
      });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (error) {
    $("authError").textContent = friendlyError(error);
  } finally {
    $("authSubmit").disabled = false;
  }
});

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use": "That email already has an account.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/weak-password": "Your password needs at least 6 characters.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/user-not-found": "No account was found for that email.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "permission-denied": "Firebase blocked that action. Check that your Firestore rules are published."
  };
  if (messages[error.code]) return messages[error.code];
  if (error.code === "auth/unauthorized-domain") {
    return "This website address isn't authorised in Firebase. Add its domain in Firebase Authentication > Settings > Authorised domains.";
  }
  if (error.code === "auth/network-request-failed") {
    return "Network error. Check your internet connection and try again.";
  }
  return error.message || "Something went wrong.";
}

onAuthStateChanged(auth, async user => {
  stopListeners();
  state.user = user;
  state.servers = [];
  state.serverId = null;
  state.pendingServerId = null;
  state.hasChosenServerThisSession = false;
  state.defaultServerCreating = false;
  state.server = null;
  state.friends = []; state.incoming = []; state.outgoing = [];
  state.dmId = null; state.dmFriend = null;
  finishCall();
  setMode("server");

  if (!user) {
    showAuth();
    return;
  }

  // Show the chat immediately. A Firestore profile/rules problem should
  // never send a successfully signed-in user back to the login screen.
  showApp();
  renderProfile();

  try {
    const profileRef = doc(db, "users", user.uid);
    const profileSnap = await getDoc(profileRef);

    if (!profileSnap.exists()) {
      await setDoc(profileRef, {
        displayName: safeName(user.displayName),
        email: user.email || "",
        createdAt: serverTimestamp()
      }, { merge: true });
    }

    renderProfile();
    await ensureCommunityServer();
    listenForServers();
    listenSocial();
  } catch (error) {
    console.error("Chat5H startup error:", error);
    showNoServer();
    toast("You're signed in, but Chat5H couldn't load your profile/server data: " + friendlyError(error));
  }
}, error => {
  console.error("Firebase sign-in state error:", error);
  showAuth();
  $("authError").textContent = "Couldn't check your sign-in status: " + friendlyError(error);
});

// Surface script/runtime problems in the page instead of failing silently.
window.addEventListener("unhandledrejection", event => {
  console.error("Chat5H unhandled error:", event.reason);
  const message = event.reason?.message || String(event.reason || "Unknown error");
  if (state.user) toast("Chat5H error: " + message);
  else $("authError").textContent = "Chat5H error: " + message;
});

function renderProfile() {
  const name = safeName(state.user?.displayName);
  $("myName").textContent = name;
  $("myAvatar").textContent = initials(name);
  $("settingsUsername").value = name;
  $("settingsEmail").textContent = state.user?.email || "";
}

const COMMUNITY_SERVER_ID = "chat5h-community";

// Every signed-in account joins the same permanent Chat5H community server.
// The first account creates it; later accounts add themselves as members.
async function ensureCommunityServer() {
  const serverRef = doc(db, "servers", COMMUNITY_SERVER_ID);
  const channelRef = doc(db, "servers", COMMUNITY_SERVER_ID, "channels", "general");
  let serverSnap = await getDoc(serverRef);

  if (!serverSnap.exists()) {
    const batch = writeBatch(db);
    batch.set(serverRef, {
      name: "Chat5H", ownerId: state.user.uid, members: [state.user.uid],
      channels: ["general"], isCommunity: true, createdAt: serverTimestamp()
    });
    batch.set(channelRef, {
      name: "general", topic: "Welcome to the Chat5H community", createdAt: serverTimestamp()
    });
    try {
      await batch.commit();
    } catch (error) {
      // Another new account may have created the shared server at the same time.
      serverSnap = await getDoc(serverRef);
      if (!serverSnap.exists()) throw error;
    }
  }

  serverSnap = await getDoc(serverRef);
  if (!serverSnap.exists()) throw new Error("The shared Chat5H server could not be created.");
  const members = serverSnap.data().members || [];
  if (!members.includes(state.user.uid)) {
    await updateDoc(serverRef, { members: arrayUnion(state.user.uid) });
  }

  // Repair the default channel if the server document already existed but
  // its channel document or channel list was missing.
  const channelSnap = await getDoc(channelRef);
  if (!channelSnap.exists()) {
    await setDoc(channelRef, {
      name: "general", topic: "Welcome to the Chat5H community", createdAt: serverTimestamp()
    });
  }
  if (!(serverSnap.data().channels || []).includes("general")) {
    await updateDoc(serverRef, { channels: arrayUnion("general") });
  }
}

function listenForServers() {
  const q = query(collection(db, "servers"), where("members", "array-contains", state.user.uid));
  state.unsubServers = onSnapshot(q, async snapshot => {
    state.servers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderServers();
    if (state.pendingServerId && state.servers.some(s => s.id === state.pendingServerId)) {
      const pending = state.pendingServerId;
      state.pendingServerId = null;
      selectServer(pending);
      return;
    }
    if (!state.servers.length) {
      state.serverId = null;
      state.server = null;
      showNoServer();
      return;
    }
    // The shared community server has a fixed ID, so every account selects
    // the same server rather than a similarly named personal server.
    const mainServer = state.servers.find(s => s.id === COMMUNITY_SERVER_ID);
    if (!state.serverId || !state.servers.some(s => s.id === state.serverId)) {
      selectServer((mainServer || state.servers[0]).id);
    } else if (mainServer && state.serverId !== mainServer.id && !state.hasChosenServerThisSession) {
      selectServer(mainServer.id);
    } else {
      state.server = state.servers.find(s => s.id === state.serverId);
      renderChannels();
      renderInvite();
    }
  }, error => toast("Server list error: " + friendlyError(error)));
}

function renderServers() {
  const root = $("serverList");
  root.replaceChildren();
  for (const server of state.servers) {
    const button = document.createElement("button");
    button.className = "server" + (state.mode === "server" && server.id === state.serverId ? " active" : "");
    button.title = server.name || "Server";
    button.textContent = initials(server.name || "S");
    button.addEventListener("click", () => selectServer(server.id));
    root.append(button);
  }
}

function showNoServer() {
  $("workspaceName").textContent = "Chat5H";
  $("channelList").replaceChildren();
  $("currentChannel").textContent = "no-server";
  $("channelTopic").textContent = "Create or join a server to start chatting.";
  $("messages").innerHTML = '<div class="welcome"><div class="welcome-icon">✦</div><h2>No server selected</h2><p>Create a server or join one with an invite code.</p></div>';
  $("memberList").replaceChildren();
  $("memberCount").textContent = "0";
  $("copyInviteBtn").disabled = true;
  $("leaveServer").disabled = true;
  $("messageInput").disabled = true;
  $("emojiButton").disabled = true;
  $("gifButton").disabled = true;
  closePanels();
}

async function createServer(name, isWelcome = false) {
  const cleanName = safeName(name, "New Server");
  let code = makeCode();
  for (let i = 0; i < 5 && (await getDoc(doc(db, "invites", code))).exists(); i++) code = makeCode();
  const serverRef = doc(collection(db, "servers"));
  const channelRef = doc(db, "servers", serverRef.id, "channels", "general");
  const inviteRef = doc(db, "invites", code);
  const batch = writeBatch(db);
  batch.set(serverRef, {
    name: cleanName, ownerId: state.user.uid, members: [state.user.uid],
    inviteCode: code, channels: ["general"], createdAt: serverTimestamp()
  });
  batch.set(channelRef, { name: "general", topic: isWelcome ? "Welcome to Chat5H" : "General discussion", createdAt: serverTimestamp() });
  batch.set(inviteRef, { serverId: serverRef.id, createdBy: state.user.uid, createdAt: serverTimestamp() });
  // Set this before committing so the live snapshot cannot arrive first.
  state.pendingServerId = serverRef.id;
  try {
    await batch.commit();
  } catch (error) {
    if (state.pendingServerId === serverRef.id) state.pendingServerId = null;
    throw error;
  }
  // Add the new server to the sidebar immediately instead of waiting
  // for the Firestore query listener to deliver its next snapshot.
  const newServer = {
    id: serverRef.id,
    name: cleanName,
    ownerId: state.user.uid,
    members: [state.user.uid],
    inviteCode: code,
    channels: ["general"]
  };
  state.servers = [
    ...state.servers.filter(server => server.id !== serverRef.id),
    newServer
  ];
  state.pendingServerId = null;
  renderServers();
  selectServer(serverRef.id);
  toast(isWelcome ? "Your Chat5H server is ready!" : "Server created!");
}

function selectServer(serverId) {
  stopChatListeners();
  setMode("server");
  state.serverId = serverId;
  state.hasChosenServerThisSession = true;
  state.server = state.servers.find(s => s.id === serverId) || null;
  if (!state.server) return;
  const availableChannels = state.server.channels || ["general"];
  state.channel = availableChannels.includes("general") ? "general" : (availableChannels[0] || "general");
  renderServers();
  renderChannels();
  renderInvite();
  $("workspaceName").textContent = state.server.name || "Server";
  $("messageInput").disabled = false;
  $("emojiButton").disabled = false;
  $("gifButton").disabled = false;
  listenForMessages();
  listenForMembers();
}
function stopChatListeners() {
  if (state.unsubMessages) state.unsubMessages();
  if (state.unsubMembers) state.unsubMembers();
  state.unsubMessages = null;
  state.unsubMembers = null;
}

function renderChannels() {
  const root = $("channelList");
  root.replaceChildren();
  const channels = state.server?.channels || ["general"];
  for (const channel of channels) {
    const button = document.createElement("button");
    button.className = "channel" + (channel === state.channel ? " active" : "");
    const hash = document.createElement("span");
    hash.className = "hash";
    hash.textContent = "#";
    const label = document.createElement("span");
    label.textContent = channel;
    button.append(hash, label);
    button.addEventListener("click", () => {
      state.channel = channel;
      renderChannels();
      listenForMessages();
    });
    root.append(button);
  }
  if (state.mode === "server") {
    $("currentChannel").textContent = state.channel;
    $("messageInput").placeholder = `Message #${state.channel}`;
    $("channelTopic").textContent = state.channel === "general" ? "Welcome to the conversation" : "Chat with your server";
  }
}

function listenForMessages() {
  if (state.unsubMessages) state.unsubMessages();
  const ref = messagesRef();
  if (!ref) return;
  const q = query(ref, orderBy("createdAt", "asc"), limit(150));
  state.unsubMessages = onSnapshot(q, snapshot => {
    state.messages = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMessages();
  }, error => toast("Messages error: " + friendlyError(error)));
}

function renderMessages() {
  const root = $("messages");
  const search = $("searchInput").value.trim().toLowerCase();
  root.replaceChildren();
  const intro = document.createElement("div");
  intro.className = "welcome";
  const dmName = state.mode === "dm" ? (state.dmFriend?.name || "friend") : null;
  intro.innerHTML = '<div class="welcome-icon">✦</div><h2>' + (dmName ? "Chat with " + escapeHtml(dmName) : "Welcome to #" + escapeHtml(state.channel)) + '</h2><p>' + (dmName ? "This is the start of your direct messages." : "This is the beginning of this channel.") + '</p>';
  root.append(intro);
  for (const message of state.messages) {
    const content = String(message.text || "");
    if (search && !content.toLowerCase().includes(search) && !String(message.displayName || "").toLowerCase().includes(search)) continue;
    const item = document.createElement("article");
    item.className = "message";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = initials(message.displayName);
    const body = document.createElement("div");
    body.className = "message-body";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("strong");
    name.textContent = safeName(message.displayName);
    const time = document.createElement("time");
    time.textContent = message.createdAt?.toDate ? message.createdAt.toDate().toLocaleString() : "Just now";
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = content;
    meta.append(name, time);
    body.append(meta);
    if (content) body.append(text);
    if (message.gif && isSafeGifUrl(message.gif)) {
      const img = document.createElement("img");
      img.className = "message-gif";
      img.src = message.gif;
      img.alt = "GIF";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      body.append(img);
    }
    if (message.image && String(message.image).startsWith("data:image/jpeg;base64,")) {
      const photo = document.createElement("img");
      photo.className = "message-image";
      photo.src = message.image;
      photo.alt = "Shared image";
      body.append(photo);
    }
    item.append(avatar, body);
    root.append(item);
  }
  root.scrollTop = root.scrollHeight;
}
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

$("messageForm").addEventListener("submit", async event => {
  event.preventDefault();
  const text = $("messageInput").value.trim();
  const image = state.pendingImage;
  if ((!text && !image) || !messagesRef()) return;
  $("messageInput").value = "";
  clearPendingImage();
  const fields = { text };
  if (image) fields.image = image;
  if (!(await sendMessage(fields))) {
    $("messageInput").value = text;
    if (image) showPendingImage(image);
  }
});

function listenForMembers() {
  if (state.unsubMembers) state.unsubMembers();
  if (!state.serverId) return;
  state.unsubMembers = onSnapshot(doc(db, "servers", state.serverId), async snap => {
    if (!snap.exists()) return;
    const server = snap.data();
    state.server = { ...state.server, ...server, id: state.serverId };
    const ids = server.members || [];
    $("memberCount").textContent = String(ids.length);
    const profiles = await Promise.all(ids.map(async uid => {
      const p = await getDoc(doc(db, "users", uid));
      return { uid, displayName: p.exists() ? p.data().displayName : "Member" };
    }));
    const root = $("memberList");
    root.replaceChildren();
    for (const profile of profiles) {
      const row = document.createElement("div");
      row.className = "member";
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = initials(profile.displayName);
      const info = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = safeName(profile.displayName);
      const small = document.createElement("small");
      small.textContent = profile.uid === state.user.uid ? "You" : "Member";
      info.append(strong, small);
      row.append(avatar, info);
      if (profile.uid !== state.user.uid && !state.friends.some(f => f.uid === profile.uid)) {
        const add = document.createElement("button");
        add.className = "mini-btn";
        add.type = "button";
        add.textContent = "+ Friend";
        add.title = "Send a friend request";
        add.addEventListener("click", () => sendFriendRequest(profile.uid, profile.displayName));
        row.append(add);
      }
      root.append(row);
    }
  }, error => toast("Members error: " + friendlyError(error)));
}

function renderInvite() {
  $("copyInviteBtn").disabled = !state.server?.inviteCode;
  $("leaveServer").disabled = !state.server;
}

$("addServer").addEventListener("click", async () => {
  const name = prompt("What should your server be called?");
  if (!name?.trim()) return;
  try { await createServer(name); } catch (error) { toast(friendlyError(error)); }
});
$("addChannel").addEventListener("click", async () => {
  if (!state.server) return toast("Select a server first.");
  const raw = prompt("Channel name (letters, numbers and hyphens):");
  if (!raw?.trim()) return;
  const channel = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  if (!channel) return toast("That channel name isn't valid.");
  if ((state.server.channels || []).includes(channel)) return toast("That channel already exists.");
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "servers", state.serverId), { channels: arrayUnion(channel) });
    batch.set(doc(db, "servers", state.serverId, "channels", channel), { name: channel, topic: "Server discussion", createdAt: serverTimestamp() });
    await batch.commit();
    state.channel = channel;
    renderChannels();
    listenForMessages();
  } catch (error) { toast("Couldn't create channel: " + friendlyError(error)); }
});

$("joinServer").addEventListener("click", async () => {
  const code = prompt("Enter the server invite code:");
  if (!code?.trim()) return;
  try {
    const inviteSnap = await getDoc(doc(db, "invites", code.trim().toUpperCase()));
    if (!inviteSnap.exists()) return toast("That invite code wasn't found.");
    const invite = inviteSnap.data();
    const serverRef = doc(db, "servers", invite.serverId);
    await updateDoc(serverRef, { members: arrayUnion(state.user.uid), joinCodeUsed: code.trim().toUpperCase() });
    toast("Joined server!");
  } catch (error) { toast("Couldn't join: " + friendlyError(error)); }
});

$("copyInviteBtn").addEventListener("click", async () => {
  const code = state.server?.inviteCode;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast("Invite code copied: " + code);
  } catch {
    prompt("Copy this invite code:", code);
  }
});

$("leaveServer").addEventListener("click", async () => {
  if (!state.server) return;
  const isOwner = state.server.ownerId === state.user.uid;
  const members = state.server.members || [];
  if (isOwner && members.length > 1) {
    return toast("The server owner must transfer ownership before leaving.");
  }
  if (isOwner && members.length === 1) {
    return toast("You own this server. Delete it or invite someone before leaving.");
  }
  if (!confirm(`Leave ${state.server.name}? The server will remain for its other members.`)) return;
  try {
    await updateDoc(doc(db, "servers", state.serverId), { members: arrayRemove(state.user.uid) });
    state.serverId = null;
    state.server = null;
    stopChatListeners();
    toast("You left the server.");
  } catch (error) { toast("Couldn't leave: " + friendlyError(error)); }
});

$("searchInput").addEventListener("input", renderMessages);
$("toggleMembers").addEventListener("click", () => $("membersPanel").classList.toggle("open"));

// ---------- Emoji & GIF pickers ----------
// Get a free key at https://developers.giphy.com (create an app, choose "API").
const GIPHY_API_KEY = "9v2QQptBySxCvCV3rLuxcUMvDne8RLs8";

// Only ever display GIFs hosted by GIPHY, so nobody can post arbitrary image URLs.
function isSafeGifUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /^(media\d*|i)\.giphy\.com$/.test(url.hostname);
  } catch { return false; }
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(text, start, end, "end");
  input.focus();
}

function closePanels() {
  $("emojiPanel").hidden = true;
  $("gifPanel").hidden = true;
}

async function togglePanel(name) {
  const wasOpen = !$(name + "Panel").hidden;
  closePanels();
  if (wasOpen) return;
  $(name + "Panel").hidden = false;
  if (name === "emoji") await loadEmojiPicker();
  else { $("gifSearch").focus(); if (!$("gifResults").children.length) loadGifs(""); }
}

let emojiPickerReady = false;
async function loadEmojiPicker() {
  if (emojiPickerReady) return;
  try {
    await import("https://cdn.jsdelivr.net/npm/emoji-picker-element@1/index.js");
  } catch (error) {
    console.error(error);
    closePanels();
    return toast("Couldn't load the emoji picker.");
  }
  const picker = document.createElement("emoji-picker");
  picker.addEventListener("emoji-click", event => {
    if (event.detail.unicode) insertAtCursor($("messageInput"), event.detail.unicode);
  });
  $("emojiPanel").append(picker);
  emojiPickerReady = true;
}

let gifRequestId = 0;
async function loadGifs(query) {
  const results = $("gifResults");
  if (!GIPHY_API_KEY || GIPHY_API_KEY.startsWith("YOUR_")) {
    results.textContent = "Add your GIPHY API key in script.js to turn on GIFs.";
    return;
  }
  const requestId = ++gifRequestId;
  results.textContent = "Loading...";
  const params = new URLSearchParams({ api_key: GIPHY_API_KEY, limit: "24", rating: "pg" });
  if (query) params.set("q", query);
  try {
    const res = await fetch(`https://api.giphy.com/v1/gifs/${query ? "search" : "trending"}?${params}`);
    if (!res.ok) throw new Error("GIPHY returned " + res.status);
    const { data } = await res.json();
    if (requestId !== gifRequestId) return; // a newer search replaced this one
    results.replaceChildren();
    for (const gif of data) {
      const preview = gif.images?.fixed_height_small?.url;
      const full = gif.images?.fixed_height?.url;
      if (!isSafeGifUrl(preview) || !isSafeGifUrl(full)) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gif-item";
      button.title = gif.title || "GIF";
      const img = document.createElement("img");
      img.src = preview;
      img.alt = gif.title || "GIF";
      img.loading = "lazy";
      button.append(img);
      button.addEventListener("click", () => sendGif(full));
      results.append(button);
    }
    if (!results.children.length) results.textContent = "No GIFs found.";
  } catch (error) {
    console.error("GIF search error:", error);
    if (requestId === gifRequestId) results.textContent = "Couldn't load GIFs. Try again.";
  }
}

async function sendGif(url) {
  if (!isSafeGifUrl(url)) return;
  closePanels();
  await sendMessage({ gif: url });
}

let gifTimer;
$("gifSearch").addEventListener("input", () => {
  clearTimeout(gifTimer);
  gifTimer = setTimeout(() => loadGifs($("gifSearch").value.trim()), 350);
});
$("emojiButton").addEventListener("click", () => togglePanel("emoji"));
$("gifButton").addEventListener("click", () => togglePanel("gif"));
document.addEventListener("click", event => {
  if (!event.target.closest(".picker-panel, #emojiButton, #gifButton")) closePanels();
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closePanels(); });
$("openSettings").addEventListener("click", () => {
  renderProfile();
  $("settingsModal").hidden = false;
});
$("closeSettings").addEventListener("click", () => $("settingsModal").hidden = true);
$("settingsModal").addEventListener("click", event => {
  if (event.target === $("settingsModal")) $("settingsModal").hidden = true;
});
$("saveUsername").addEventListener("click", async () => {
  const name = safeName($("settingsUsername").value, "");
  if (!name) return toast("Enter a username first.");
  try {
    await updateProfile(state.user, { displayName: name });
    await setDoc(doc(db, "users", state.user.uid), { displayName: name, email: state.user.email || "" }, { merge: true });
    renderProfile();
    $("settingsModal").hidden = true;
    toast("Username updated.");
  } catch (error) { toast("Couldn't update username: " + friendlyError(error)); }
});
$("switchAccount").addEventListener("click", async () => {
  try { await signOut(auth); $("settingsModal").hidden = true; } catch (error) { toast(friendlyError(error)); }
});
$("deleteAccount").addEventListener("click", async () => {
  if (!confirm("Permanently delete this login and profile? This will not automatically delete your servers or messages.")) return;
  const password = prompt("For security, enter your account password to confirm:");
  if (!password) return;
  try {
    const credential = EmailAuthProvider.credential(state.user.email, password);
    await reauthenticateWithCredential(state.user, credential);
    await deleteDoc(doc(db, "users", state.user.uid));
    await deleteUser(state.user);
    $("settingsModal").hidden = true;
    toast("Account deleted.");
  } catch (error) { toast("Couldn't delete account: " + friendlyError(error)); }
});


// ================= Sending messages (channels + DMs) =================
function messagesRef() {
  if (state.mode === "dm") return state.dmId ? collection(db, "friendships", state.dmId, "messages") : null;
  return state.serverId ? collection(db, "servers", state.serverId, "channels", state.channel, "messages") : null;
}

async function sendMessage(fields) {
  const ref = messagesRef();
  if (!ref || !state.user) return false;
  try {
    await addDoc(ref, {
      text: "", ...fields, uid: state.user.uid,
      displayName: safeName(state.user.displayName), createdAt: serverTimestamp()
    });
    return true;
  } catch (error) {
    toast("Couldn't send: " + friendlyError(error));
    return false;
  }
}

// ================= Paste photos =================
// Photos are shrunk to a small JPEG and stored inside the message itself,
// so no extra Firebase service (Storage) is needed.
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 720 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.8, 0.65, 0.5, 0.35]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length < 380000) return url;
  }
  throw new Error("That image is too large to share.");
}
function showPendingImage(url) {
  state.pendingImage = url;
  $("imagePreviewImg").src = url;
  $("imagePreview").hidden = false;
}
function clearPendingImage() {
  state.pendingImage = null;
  $("imagePreview").hidden = true;
  $("imagePreviewImg").removeAttribute("src");
}
$("imageCancel").addEventListener("click", clearPendingImage);
$("messageInput").addEventListener("paste", async event => {
  const item = [...(event.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (!file) return;
  event.preventDefault();
  try { showPendingImage(await shrinkImage(file)); }
  catch (error) { toast(error.message || "Couldn't read that image."); }
});

// ================= Friends & direct messages =================
function setMode(mode) {
  state.mode = mode;
  const dm = mode === "dm";
  $("chatApp").classList.toggle("dm-mode", dm);
  $("serverScroll").hidden = dm;
  $("dmScroll").hidden = !dm;
  $("homeButton").classList.toggle("active", dm);
  $("callButton").hidden = !(dm && state.dmId);
  closePanels();
}

function openHome() {
  stopChatListeners();
  setMode("dm");
  $("workspaceName").textContent = "Friends";
  renderServers();
  if (state.dmFriend) openDm(state.dmFriend); else showDmEmpty();
}

function showDmEmpty() {
  state.dmId = null;
  state.dmFriend = null;
  state.messages = [];
  $("currentChannel").textContent = "friends";
  $("channelTopic").textContent = "Add a friend, then message or call them.";
  $("messageInput").placeholder = "Pick a friend to message";
  $("messages").innerHTML = '<div class="welcome"><div class="welcome-icon">💬</div><h2>Friends</h2><p>Pick a friend on the left to message or call them.</p></div>';
  for (const id of ["messageInput", "emojiButton", "gifButton"]) $(id).disabled = true;
  $("callButton").hidden = true;
  renderFriends();
}

function openDm(friend) {
  stopChatListeners();
  setMode("dm");
  state.dmId = friend.pairId;
  state.dmFriend = friend;
  $("workspaceName").textContent = "Friends";
  $("currentChannel").textContent = friend.name;
  $("channelTopic").textContent = "Direct message";
  $("messageInput").placeholder = "Message " + friend.name;
  for (const id of ["messageInput", "emojiButton", "gifButton"]) $(id).disabled = false;
  $("callButton").hidden = false;
  renderServers();
  renderFriends();
  listenForMessages();
}

function note(text) {
  const p = document.createElement("p");
  p.className = "empty-note";
  p.textContent = text;
  return p;
}

function friendRow(name, active, actions = []) {
  const row = document.createElement("div");
  row.className = "friend" + (active ? " active" : "");
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initials(name);
  const label = document.createElement("span");
  label.className = "friend-name";
  label.textContent = name;
  row.append(avatar, label);
  for (const [text, handler, cls] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini-btn " + (cls || "");
    button.textContent = text;
    button.addEventListener("click", event => { event.stopPropagation(); handler(); });
    row.append(button);
  }
  return row;
}

function renderFriends() {
  const requests = $("requestList");
  const friends = $("friendList");
  requests.replaceChildren();
  friends.replaceChildren();
  $("requestCount").textContent = state.incoming.length ? `(${state.incoming.length})` : "";
  for (const r of state.incoming) {
    requests.append(friendRow(r.fromName || "Someone", false, [
      ["Accept", () => acceptRequest(r)],
      ["Decline", () => deleteRequest(r), "danger"]
    ]));
  }
  for (const r of state.outgoing) {
    requests.append(friendRow("Sent to " + (r.toName || "friend"), false, [["Cancel", () => deleteRequest(r), "danger"]]));
  }
  if (!state.incoming.length && !state.outgoing.length) requests.append(note("No pending requests."));
  if (!state.friends.length) friends.append(note("No friends yet. Add someone from a server's member list or by email."));
  for (const f of state.friends) {
    const row = friendRow(f.name, state.mode === "dm" && f.pairId === state.dmId, [
      ["📞", () => startCall(f)],
      ["✕", () => removeFriend(f), "danger"]
    ]);
    row.addEventListener("click", () => openDm(f));
    friends.append(row);
  }
}

function listenSocial() {
  const uid = state.user.uid;
  state.unsubFriends = onSnapshot(query(collection(db, "friendships"), where("members", "array-contains", uid)), snap => {
    state.friends = snap.docs.map(d => {
      const data = d.data();
      const other = data.members.find(m => m !== uid);
      return { pairId: d.id, uid: other, name: data.names?.[other] || "Friend" };
    });
    if (state.dmId && !state.friends.some(f => f.pairId === state.dmId)) {
      const wasDm = state.mode === "dm";
      state.dmId = null;
      state.dmFriend = null;
      if (wasDm) { stopChatListeners(); showDmEmpty(); }
    }
    renderFriends();
    // Names can change after the friendship was created, so refresh them.
    for (const f of state.friends) {
      getDoc(doc(db, "users", f.uid)).then(p => {
        const name = p.exists() ? p.data().displayName : "";
        if (name && name !== f.name) { f.name = name; renderFriends(); }
      }).catch(() => {});
    }
  }, error => toast("Friends error: " + friendlyError(error)));

  let ready = false;
  state.unsubIncoming = onSnapshot(query(collection(db, "friendRequests"), where("to", "==", uid)), snap => {
    if (ready) snap.docChanges().forEach(c => {
      if (c.type === "added") toast((c.doc.data().fromName || "Someone") + " sent you a friend request");
    });
    ready = true;
    state.incoming = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFriends();
  }, error => toast("Requests error: " + friendlyError(error)));

  state.unsubOutgoing = onSnapshot(query(collection(db, "friendRequests"), where("from", "==", uid)), snap => {
    state.outgoing = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFriends();
  }, error => toast("Requests error: " + friendlyError(error)));

  state.unsubCalls = onSnapshot(query(collection(db, "calls"), where("to", "==", uid), where("status", "==", "ringing")), snap => {
    snap.docChanges().forEach(c => {
      if (c.type === "added") handleIncomingCall(c.doc);
      if (c.type === "removed" && call?.incoming && !call.accepted && call.id === c.doc.id) finishCall("Missed call");
    });
  }, error => console.error("Calls listener error:", error));
}

async function sendFriendRequest(uid, name) {
  if (uid === state.user.uid) return toast("That's you!");
  if (state.friends.some(f => f.uid === uid)) return toast("You're already friends.");
  if (state.outgoing.some(r => r.to === uid)) return toast("Request already sent.");
  const theirs = state.incoming.find(r => r.from === uid);
  if (theirs) return acceptRequest(theirs);
  try {
    await setDoc(doc(db, "friendRequests", state.user.uid + "_" + uid), {
      from: state.user.uid, to: uid,
      fromName: safeName(state.user.displayName), toName: safeName(name, "Friend"),
      createdAt: serverTimestamp()
    });
    toast("Friend request sent!");
  } catch (error) { toast("Couldn't send request: " + friendlyError(error)); }
}

async function acceptRequest(r) {
  const me = state.user.uid;
  const members = [me, r.from].sort();
  const batch = writeBatch(db);
  batch.set(doc(db, "friendships", members.join("_")), {
    members,
    names: { [me]: safeName(state.user.displayName), [r.from]: safeName(r.fromName, "Friend") },
    createdAt: serverTimestamp()
  });
  batch.delete(doc(db, "friendRequests", r.id));
  try { await batch.commit(); toast("You and " + safeName(r.fromName, "your friend") + " are now friends!"); }
  catch (error) { toast("Couldn't accept: " + friendlyError(error)); }
}

async function deleteRequest(r) {
  try { await deleteDoc(doc(db, "friendRequests", r.id)); }
  catch (error) { toast("Couldn't update request: " + friendlyError(error)); }
}

async function removeFriend(f) {
  if (!confirm(`Remove ${f.name} from your friends?`)) return;
  try { await deleteDoc(doc(db, "friendships", f.pairId)); toast("Friend removed."); }
  catch (error) { toast("Couldn't remove friend: " + friendlyError(error)); }
}

$("homeButton").addEventListener("click", openHome);
$("addFriendBtn").addEventListener("click", async () => {
  const email = prompt("Enter your friend's email address:")?.trim().toLowerCase();
  if (!email) return;
  try {
    const snap = await getDocs(query(collection(db, "users"), where("email", "==", email), limit(1)));
    if (snap.empty) return toast("No Chat5H account uses that email.");
    await sendFriendRequest(snap.docs[0].id, snap.docs[0].data().displayName);
  } catch (error) { toast("Couldn't find that person: " + friendlyError(error)); }
});

// ================= Voice calls (WebRTC, signalled through Firestore) =================
// STUN only: calls work on most home/mobile networks. Strict corporate/school
// networks may need a TURN server added to iceServers below.
const RTC_CONFIG = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] };
let call = null;

function showCall(name, status, ringing = false) {
  $("callOverlay").hidden = false;
  $("callName").textContent = name;
  $("callAvatar").textContent = initials(name);
  $("callStatus").textContent = status;
  $("callAccept").hidden = !ringing;
  $("callMute").hidden = ringing;
  $("callHangup").textContent = ringing ? "Decline" : "Hang up";
}

async function makePeer(callRef, role) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  call.pc = pc;
  call.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  call.stream.getTracks().forEach(track => pc.addTrack(track, call.stream));
  pc.ontrack = event => { $("remoteAudio").srcObject = event.streams[0]; };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    if (pc.connectionState === "connected") $("callStatus").textContent = "Connected";
    if (pc.connectionState === "failed") hangUp("The call couldn't connect. Your network may block calls.");
  };
  const mine = collection(callRef, role + "Candidates");
  const theirs = collection(callRef, (role === "caller" ? "callee" : "caller") + "Candidates");
  pc.onicecandidate = event => {
    if (!event.candidate) return;
    const data = event.candidate.toJSON();
    if (call?.ready) addDoc(mine, data).catch(console.error);
    else call?.queued.push(data);
  };
  call.mine = mine;
  call.unsubs.push(onSnapshot(theirs, snap => {
    snap.docChanges().forEach(c => { if (c.type === "added") remoteCandidate(c.doc.data()); });
  }));
}

function remoteCandidate(data) {
  if (!call?.pc) return;
  if (call.pc.remoteDescription) call.pc.addIceCandidate(new RTCIceCandidate(data)).catch(console.error);
  else call.held.push(data);
}
async function setRemote(description) {
  await call.pc.setRemoteDescription(new RTCSessionDescription(description));
  for (const data of call.held.splice(0)) remoteCandidate(data);
}

async function startCall(friend) {
  if (call) return toast("You're already in a call.");
  if (!navigator.mediaDevices?.getUserMedia) return toast("Calls need a secure (https) page and a microphone.");
  const callRef = doc(collection(db, "calls"));
  call = { id: callRef.id, incoming: false, accepted: true, held: [], queued: [], ready: false, unsubs: [] };
  showCall(friend.name, "Calling...");
  try {
    await makePeer(callRef, "caller");
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    await setDoc(callRef, {
      from: state.user.uid, to: friend.uid, fromName: safeName(state.user.displayName),
      status: "ringing", offer: { type: offer.type, sdp: offer.sdp }, createdAt: serverTimestamp()
    });
    call.ready = true;
    for (const data of call.queued.splice(0)) addDoc(call.mine, data).catch(console.error);
    call.unsubs.push(onSnapshot(callRef, async snap => {
      const data = snap.data();
      if (!data || !call || call.id !== snap.id) return;
      if (data.answer && !call.pc.remoteDescription) {
        $("callStatus").textContent = "Connecting...";
        clearTimeout(call.timer);
        await setRemote(data.answer);
      }
      if (data.status === "declined") finishCall(friend.name + " declined the call.");
      if (data.status === "ended") finishCall("Call ended.");
    }));
    call.timer = setTimeout(() => { if (call && !call.pc.remoteDescription) hangUp("No answer."); }, 45000);
  } catch (error) {
    finishCall(error.name === "NotAllowedError" ? "Microphone access was blocked." : "Couldn't start the call: " + friendlyError(error));
  }
}

function handleIncomingCall(snap) {
  const data = snap.data();
  const age = data.createdAt?.toMillis ? Date.now() - data.createdAt.toMillis() : 0;
  if (age > 40000) return; // stale ring from a caller who left
  if (call) { updateDoc(snap.ref, { status: "declined" }).catch(() => {}); return; }
  call = { id: snap.id, ref: snap.ref, data, incoming: true, accepted: false, held: [], queued: [], ready: true, unsubs: [] };
  showCall(data.fromName || "Someone", "Incoming voice call...", true);
}

$("callAccept").addEventListener("click", async () => {
  if (!call?.incoming || call.accepted) return;
  call.accepted = true;
  const ref = call.ref;
  showCall($("callName").textContent, "Connecting...");
  try {
    await makePeer(ref, "callee");
    await setRemote(call.data.offer);
    const answer = await call.pc.createAnswer();
    await call.pc.setLocalDescription(answer);
    await updateDoc(ref, { answer: { type: answer.type, sdp: answer.sdp }, status: "accepted" });
    call.unsubs.push(onSnapshot(ref, snap => {
      if (call && snap.data()?.status === "ended") finishCall("Call ended.");
    }));
  } catch (error) {
    hangUp(error.name === "NotAllowedError" ? "Microphone access was blocked." : "Couldn't answer: " + friendlyError(error));
  }
});

function hangUp(message = "") {
  if (!call) return;
  const status = call.incoming && !call.accepted ? "declined" : "ended";
  updateDoc(doc(db, "calls", call.id), { status }).catch(() => {});
  finishCall(message);
}
function finishCall(message = "") {
  const c = call;
  if (!c) return;
  call = null;
  clearTimeout(c.timer);
  c.unsubs.forEach(unsub => unsub());
  c.stream?.getTracks().forEach(track => track.stop());
  c.pc?.close();
  $("remoteAudio").srcObject = null;
  $("callOverlay").hidden = true;
  $("callMute").textContent = "Mute";
  if (message) toast(message);
}

$("callHangup").addEventListener("click", () => hangUp());
$("callMute").addEventListener("click", () => {
  const track = call?.stream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("callMute").textContent = track.enabled ? "Mute" : "Unmute";
});
$("callButton").addEventListener("click", () => { if (state.dmFriend) startCall(state.dmFriend); });
window.addEventListener("beforeunload", () => {
  if (call) updateDoc(doc(db, "calls", call.id), { status: "ended" }).catch(() => {});
});