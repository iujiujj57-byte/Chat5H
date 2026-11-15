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
