import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, doc, setDoc, deleteDoc, collection, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";

const ROLES = ["Developer", "Admin"];
const $ = (id) => document.getElementById(id);
const configured = !String(firebaseConfig.apiKey || "").startsWith("PASTE");

let auth = null, db = null;
let user = null, isOwner = false, mode = "up", picked = "Developer";
let roles = {}, myRequest = null, requests = {}, users = {};
let unsubs = [];

/* ---------- small helpers ---------- */
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function say(text, isErr) {
  const m = $("msg");
  m.textContent = text || "";
  m.classList.toggle("err", !!isErr);
}
function btn(label, cls, fn) {
  const b = h("button", "sm " + (cls || ""), label);
  b.type = "button";
  b.addEventListener("click", fn);
  return b;
}
const validRole = (r) => ROLES.includes(r);
function safePhoto(url) { return typeof url === "string" && url.startsWith("https://") ? url : ""; }
function avatar(name, photo, small) {
  const cls = "av" + (small ? " s" : "");
  const src = safePhoto(photo);
  if (src) {
    const img = h("img", cls);
    img.alt = ""; img.referrerPolicy = "no-referrer"; img.src = src;
    return img;
  }
  return h("span", cls, (String(name || "?").trim()[0] || "?").toUpperCase());
}
function badge(role, owner) { return h("span", "badge" + (owner ? " owner" : role === "Admin" ? " admin" : ""), role); }
function friendly(err) {
  const c = err && err.code ? String(err.code) : "";
  if (c.includes("invalid-email")) return "That email address does not look right.";
  if (c.includes("email-already-in-use")) return "That email already has an account. Use Sign in instead.";
  if (c.includes("weak-password")) return "Choose a password with at least 6 characters.";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Email or password is not right.";
  if (c.includes("popup-closed") || c.includes("cancelled-popup")) return "";
  if (c.includes("popup-blocked")) return "Your browser blocked the Google window. Allow pop-ups for this site and try again.";
  if (c.includes("unauthorized-domain")) return "This site's address is not allowed yet. Add it under Authentication > Settings > Authorized domains in Firebase.";
  if (c.includes("operation-not-allowed")) return "This sign-in method is not turned on in Firebase yet.";
  if (c.includes("too-many-requests")) return "Too many tries. Wait a minute and try again.";
  if (c.includes("permission-denied")) return "That was not allowed. Check your sign-in and try again.";
  if (c.includes("network")) return "Cannot reach the network. Check your connection.";
  return "Something went wrong. Try again.";
}
async function run(fn, ok) {
  say("");
  try { await fn(); if (ok) say(ok); }
  catch (e) { const t = friendly(e); if (t) say(t, true); }
}

/* ---------- drawer ---------- */
const tab = $("adminTab"), panel = $("adminPanel"), scrim = $("scrim");
function setOpen(open) {
  panel.classList.toggle("open", open);
  scrim.classList.toggle("open", open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  tab.setAttribute("aria-expanded", open ? "true" : "false");
  (open ? $("adminClose") : tab).focus();
}
tab.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
$("heroSignup").addEventListener("click", () => setOpen(true));
$("sideSignup").addEventListener("click", () => setOpen(true));
$("adminClose").addEventListener("click", () => setOpen(false));
scrim.addEventListener("click", () => setOpen(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panel.classList.contains("open")) setOpen(false); });

/* ---------- sign up / sign in forms ---------- */
function setMode(m) {
  mode = m;
  $("modeUp").classList.toggle("on", m === "up");
  $("modeIn").classList.toggle("on", m === "in");
  $("modeUp").setAttribute("aria-selected", String(m === "up"));
  $("modeIn").setAttribute("aria-selected", String(m === "in"));
  $("nameWrap").hidden = m !== "up";
  $("resetBtn").hidden = m !== "in";
  $("submitBtn").textContent = m === "up" ? "Create account" : "Sign in";
  $("fPass").autocomplete = m === "up" ? "new-password" : "current-password";
  say("");
}
$("modeUp").addEventListener("click", () => setMode("up"));
$("modeIn").addEventListener("click", () => setMode("in"));

$("googleBtn").addEventListener("click", () => {
  if (!auth) return;
  run(() => signInWithPopup(auth, new GoogleAuthProvider()));
});

$("emailForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!auth) return;
  const email = $("fEmail").value.trim().toLowerCase();
  const pass = $("fPass").value;
  const name = $("fName").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say("Enter a valid email address, such as name@icloud.com.", true); return; }
  if (pass.length < 6) { say("Choose a password with at least 6 characters.", true); return; }
  if (mode === "up") {
    run(async () => {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      if (name) await updateProfile(cred.user, { displayName: name });
      await saveProfile(cred.user);
      try { await sendEmailVerification(cred.user); } catch (err) { /* the account still works */ }
      render();
    }, "Account created. Check your inbox to verify your email.");
  } else {
    run(() => signInWithEmailAndPassword(auth, email, pass));
  }
});
$("resetBtn").addEventListener("click", () => {
  const email = $("fEmail").value.trim().toLowerCase();
  if (!email) { say("Type your email above first.", true); return; }
  run(() => sendPasswordResetEmail(auth, email), "If that email has an account, a reset link is on its way.");
});
$("signOutBtn").addEventListener("click", () => { if (auth) run(() => signOut(auth)); });

/* ---------- profile and data ---------- */
async function saveProfile(u) {
  await setDoc(doc(db, "users", u.uid), {
    displayName: u.displayName || "",
    email: u.email,
    photoURL: u.photoURL || "",
    provider: (u.providerData[0] && u.providerData[0].providerId) || "password",
    lastSeen: serverTimestamp()
  }, { merge: true });
}
function stopListening() { unsubs.forEach((f) => f()); unsubs = []; roles = {}; myRequest = null; requests = {}; users = {}; }
function listen(ref, fn) {
  unsubs.push(onSnapshot(ref, fn, (err) => { const t = friendly(err); if (t) say(t, true); }));
}
function startListening(u) {
  listen(collection(db, "roles"), (snap) => {
    roles = {}; snap.forEach((d) => { roles[d.id] = d.data(); }); render();
  });
  listen(doc(db, "roleRequests", u.uid), (snap) => { myRequest = snap.exists() ? snap.data() : null; render(); });
  if (isOwner) {
    listen(collection(db, "roleRequests"), (snap) => {
      requests = {}; snap.forEach((d) => { requests[d.id] = d.data(); }); render();
    });
    listen(collection(db, "users"), (snap) => {
      users = {}; snap.forEach((d) => { users[d.id] = d.data(); }); render();
    });
  }
}

function requestRole(role) {
  if (!validRole(role) || !user) return;
  run(() => setDoc(doc(db, "roleRequests", user.uid), {
    role, name: user.displayName || "", email: user.email, photoURL: user.photoURL || "", at: serverTimestamp()
  }), "Request sent.");
}
function approve(uid, role, req) {
  if (!validRole(role)) return;
  run(async () => {
    await setDoc(doc(db, "roles", uid), { role, name: String(req.name || ""), photoURL: safePhoto(req.photoURL), at: serverTimestamp() });
    await deleteDoc(doc(db, "roleRequests", uid));
  }, "Role approved.");
}

/* ---------- rendering ---------- */
function personRow(name, photo, sub, right) {
  const row = h("div", "prow");
  row.appendChild(avatar(name, photo, true));
  const info = h("div", "pinfo");
  info.appendChild(h("div", "pname", name || "Someone"));
  if (sub) info.appendChild(h("div", "psub", sub));
  row.appendChild(info);
  if (right) row.appendChild(right);
  return row;
}

function render() {
  $("sideSignup").textContent = user ? "My profile" : "Sign up";
  $("setupNote").hidden = configured;
  $("googleBtn").disabled = !configured;
  $("signedOut").hidden = !!user;
  $("signedIn").hidden = !user;
  $("pendingBlk").hidden = !isOwner;
  $("usersBlk").hidden = !isOwner;
  $("teamBlk").hidden = !user;

  const reqIds = Object.keys(requests).filter((id) => !roles[id]);
  $("tabCount").hidden = !(isOwner && reqIds.length);
  $("tabCount").textContent = String(reqIds.length);
  if (!user) return;

  /* profile */
  const prof = $("profile"); prof.textContent = "";
  const me = h("div", "prow");
  me.appendChild(avatar(user.displayName || user.email, user.photoURL, false));
  const info = h("div", "pinfo");
  info.appendChild(h("div", "pname", user.displayName || "Your account"));
  info.appendChild(h("div", "psub", user.email || ""));
  me.appendChild(info);
  if (isOwner) me.appendChild(badge("Owner", true));
  else if (roles[user.uid] && validRole(roles[user.uid].role)) me.appendChild(badge(roles[user.uid].role));
  prof.appendChild(me);

  /* role area */
  const area = $("roleArea"); area.textContent = "";
  if (!user.emailVerified) {
    area.appendChild(h("p", "note small", "Your email is not verified yet. Open the link we sent you."));
    area.appendChild(btn("Resend verification email", "quiet", () => run(() => sendEmailVerification(user), "Verification email sent.")));
  }
  if (isOwner) {
    area.appendChild(h("p", "note small", "You are the owner. Every role on this site is approved by you."));
  } else if (roles[user.uid]) {
    area.appendChild(h("p", "note small", "Your role was approved by the owner."));
  } else if (myRequest) {
    area.appendChild(h("p", "note small", "Your request for " + (validRole(myRequest.role) ? myRequest.role : "a role") + " is waiting for the owner."));
    area.appendChild(btn("Cancel request", "quiet", () => run(() => deleteDoc(doc(db, "roleRequests", user.uid)), "Request cancelled.")));
  } else {
    area.appendChild(h("p", "note small", "Ask the owner for a role. Nothing changes until they approve it."));
    const fr = h("div", "formrow");
    const sel = h("select", "inp"); sel.id = "reqRole";
    ROLES.forEach((r) => { const o = h("option", null, r); o.value = r; sel.appendChild(o); });
    sel.value = picked;
    sel.addEventListener("change", () => { picked = sel.value; });
    fr.appendChild(sel);
    fr.appendChild(btn("Request role", "solid", () => requestRole(picked)));
    area.appendChild(fr);
  }

  /* owner: pending requests */
  const pend = $("pending"); pend.textContent = "";
  if (isOwner) {
    if (!reqIds.length) pend.appendChild(h("p", "note", "No requests right now."));
    reqIds.forEach((id) => {
      const r = requests[id];
      const want = validRole(r.role) ? r.role : "Developer";
      const acts = h("div", "acts");
      acts.appendChild(btn("Approve", "solid", () => approve(id, want, r)));
      acts.appendChild(btn("Deny", "quiet", () => run(() => deleteDoc(doc(db, "roleRequests", id)), "Request denied.")));
      pend.appendChild(personRow(String(r.name || r.email || "Someone"), r.photoURL, "Wants " + want + " · " + String(r.email || ""), acts));
    });
  }

  /* owner: everyone who signed up */
  const ul = $("users"); ul.textContent = "";
  if (isOwner) {
    const ids = Object.keys(users);
    if (!ids.length) ul.appendChild(h("p", "note", "No one has signed up yet."));
    ids.forEach((id) => {
      const u = users[id];
      ul.appendChild(personRow(String(u.displayName || u.email || "Someone"), u.photoURL, String(u.email || ""), null));
    });
  }

  /* team */
  const mem = $("members"); mem.textContent = "";
  const roleIds = Object.keys(roles).filter((id) => validRole(roles[id].role));
  if (!roleIds.length) mem.appendChild(h("p", "note", "No roles approved yet."));
  roleIds.forEach((id) => {
    const r = roles[id];
    const right = h("div", "acts");
    right.appendChild(badge(r.role));
    if (isOwner) right.appendChild(btn("Revoke", "quiet", () => run(() => deleteDoc(doc(db, "roles", id)), "Role revoked.")));
    mem.appendChild(personRow(String(r.name || "Someone"), r.photoURL, null, right));
  });
}

/* ---------- start ---------- */
if (!configured) {
  render();
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  onAuthStateChanged(auth, async (u) => {
    stopListening();
    user = u;
    isOwner = !!(u && u.email && u.emailVerified && u.email.toLowerCase() === String(OWNER_EMAIL).toLowerCase());
    render();
    if (u) {
      try { await saveProfile(u); } catch (e) { /* profile saves again on next visit */ }
      startListening(u);
      $("fPass").value = "";
      render();
    }
  });
  render();
}
