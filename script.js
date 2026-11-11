import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
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

const $ = id => document.getElementById(id);
const state = {
  user: null, servers: [], serverId: null, pendingServerId: null, server: null, channel: "general",
  unsubServers: null, unsubMessages: null, unsubMembers: null, messages: [],
  signup: false, toastTimer: null
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
  for (const key of ["unsubServers", "unsubMessages", "unsubMembers"]) {
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
function makeCode() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
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
  return messages[error.code] || error.message || "Something went wrong.";
}

onAuthStateChanged(auth, async user => {
  stopListeners();
  state.user = user;
  state.servers = [];
  state.serverId = null;
  state.server = null;
  if (!user) {
    showAuth();
    return;
  }
  showApp();
  const profileRef = doc(db, "users", user.uid);
  const profileSnap = await getDoc(profileRef);
  if (!profileSnap.exists()) {
    await setDoc(profileRef, {
      displayName: safeName(user.displayName), email: user.email || "", createdAt: serverTimestamp()
    }, { merge: true });
  }
  renderProfile();
  listenForServers();
});

function renderProfile() {
  const name = safeName(state.user?.displayName);
  $("myName").textContent = name;
  $("myAvatar").textContent = initials(name);
  $("settingsUsername").value = name;
  $("settingsEmail").textContent = state.user?.email || "";
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
      try { await createServer("Welcome", true); }
      catch (error) { toast("Couldn't create Welcome server: " + friendlyError(error)); }
      return;
    }
    if (!state.serverId || !state.servers.some(s => s.id === state.serverId)) {
      selectServer(state.servers[0].id);
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
    button.className = "server" + (server.id === state.serverId ? " active" : "");
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
}

async function createServer(name, isWelcome = false) {
  const cleanName = safeName(name, "New Server");
  const code = makeCode();
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
  await batch.commit();
  state.pendingServerId = serverRef.id;
  toast(isWelcome ? "Your Welcome server is ready!" : "Server created!");
}

function selectServer(serverId) {
  stopChatListeners();
  state.serverId = serverId;
  state.server = state.servers.find(s => s.id === serverId) || null;
  if (!state.server) return;
  state.channel = (state.server.channels || ["general"])[0] || "general";
  renderServers();
  renderChannels();
  renderInvite();
  $("workspaceName").textContent = state.server.name || "Server";
  $("messageInput").disabled = false;
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
  $("currentChannel").textContent = state.channel;
  $("messageInput").placeholder = `Message #${state.channel}`;
  $("channelTopic").textContent = state.channel === "general" ? "Welcome to the conversation" : "Chat with your server";
}

function listenForMessages() {
  if (state.unsubMessages) state.unsubMessages();
  if (!state.serverId) return;
  const q = query(collection(db, "servers", state.serverId, "channels", state.channel, "messages"), orderBy("createdAt", "asc"), limit(150));
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
  intro.innerHTML = '<div class="welcome-icon">✦</div><h2>Welcome to #' + escapeHtml(state.channel) + '</h2><p>This is the beginning of this channel.</p>';
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
    body.append(meta, text);
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
  if (!text || !state.serverId || !state.user) return;
  $("messageInput").value = "";
  try {
    await addDoc(collection(db, "servers", state.serverId, "channels", state.channel, "messages"), {
      text, uid: state.user.uid, displayName: safeName(state.user.displayName),
      createdAt: serverTimestamp()
    });
  } catch (error) {
    $("messageInput").value = text;
    toast("Couldn't send message: " + friendlyError(error));
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
$("emojiButton").addEventListener("click", () => {
  const input = $("messageInput");
  input.value += " 🙂";
  input.focus();
});
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
