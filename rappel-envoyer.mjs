// Robot de rappel quotidien de pastel prime 🌟
// Lancé toutes les 15 minutes par GitHub Actions (.github/workflows/rappel.yml).
// Il se connecte avec le compte « robot » (qui ne peut lire QUE les réglages de rappel, pas le chat),
// regarde quels appareils doivent recevoir leur rappel maintenant, et leur envoie une notification push.
// Aucun secret n'est écrit ici : ils viennent des « Secrets » du dépôt GitHub.

import webpush from "web-push";

const API_KEY = process.env.FIREBASE_API_KEY;
const PROJECT = process.env.FIREBASE_PROJECT_ID;
const ROBOT_EMAIL = process.env.ROBOT_EMAIL;
const ROBOT_PASSWORD = process.env.ROBOT_PASSWORD;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const AUTH_URL = process.env.AUTH_URL || "https://identitytoolkit.googleapis.com";
const FS_URL = process.env.FIRESTORE_URL || "https://firestore.googleapis.com";
const NOW = process.env.FAKE_NOW ? new Date(Number(process.env.FAKE_NOW)) : new Date();

// Un rappel en retard (GitHub peut retarder le robot) part quand même s'il a moins de 3 h de retard.
const MAX_LATE_MIN = 180;
const TEST_WINDOW_MS = 3 * 3600 * 1000;

/* ---------- lecture des documents Firestore (format REST) ---------- */
export function decode(v) {
  if (!v || typeof v !== "object") return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  return undefined;
}
export function decodeFields(f) { const o = {}; for (const k of Object.keys(f || {})) o[k] = decode(f[k]); return o; }

/* ---------- heure locale de chaque appareil ---------- */
export function localParts(date, tz) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch (e) { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/* ---------- qui doit recevoir quoi maintenant ---------- */
export function decide(d, now) {
  const out = [];
  if (!d || !d.sub || !d.sub.endpoint || !d.sub.keys || d.dead) return out;
  // Rappel de test demandé depuis l'app
  if (typeof d.testAt === "number" && now.getTime() - d.testAt < TEST_WINDOW_MS && now.getTime() >= d.testAt && d.testSent !== d.testAt) {
    out.push({ kind: "test" });
  }
  // Rappel quotidien
  if (d.on === true && typeof d.time === "string" && /^\d{2}:\d{2}$/.test(d.time)) {
    const [h, m] = d.time.split(":").map(Number);
    const target = h * 60 + m;
    const { day, minutes } = localParts(now, d.tz);
    if (minutes >= target && minutes - target <= MAX_LATE_MIN && d.lastSent !== day) out.push({ kind: "daily", day });
  }
  return out;
}

export function payloadFor(kind) {
  if (kind === "test") return { title: "pastel prime 🌟", body: "Test réussi : ton rappel quotidien arrivera comme ceci, même app fermée.", tag: "pp-rappel-test", url: "./" };
  return { title: "pastel prime 🌟", body: "Petit rappel du jour : passe voir le chat du groupe !", tag: "pp-rappel", url: "./" };
}

async function http(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) { const err = new Error(`HTTP ${r.status} ${url.split("?")[0]} ${text.slice(0, 200)}`); err.status = r.status; throw err; }
  return json;
}

async function signIn() {
  const j = await http(`${AUTH_URL}/v1/accounts:signInWithPassword?key=${encodeURIComponent(API_KEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ROBOT_EMAIL, password: ROBOT_PASSWORD, returnSecureToken: true }),
  });
  return j.idToken;
}

async function listPush(token) {
  const docs = []; let pageToken = "";
  do {
    const url = `${FS_URL}/v1/projects/${PROJECT}/databases/(default)/documents/push?pageSize=300${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
    const j = await http(url, { headers: { Authorization: "Bearer " + token } });
    for (const d of (j && j.documents) || []) docs.push({ name: d.name, data: decodeFields(d.fields) });
    pageToken = (j && j.nextPageToken) || "";
  } while (pageToken);
  return docs;
}

async function patch(token, name, fields) {
  const mask = Object.keys(fields).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    body.fields[k] = typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? { integerValue: String(Math.round(v)) } : { stringValue: String(v) };
  }
  await http(`${FS_URL}/v1/${name}?${mask}&currentDocument.exists=true`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body),
  });
}

export async function main() {
  for (const [k, v] of Object.entries({ FIREBASE_API_KEY: API_KEY, FIREBASE_PROJECT_ID: PROJECT, ROBOT_EMAIL, ROBOT_PASSWORD, VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE })) {
    if (!v) { console.error(`Réglage manquant : ${k}. Ajoute-le dans Settings → Secrets and variables → Actions.`); process.exit(1); }
  }
  webpush.setVapidDetails("mailto:rappel@pastelprime.invalid", VAPID_PUBLIC, VAPID_PRIVATE);
  const token = await signIn();
  const docs = await listPush(token);
  let sent = 0, dead = 0, failed = 0;
  for (const { name, data } of docs) {
    for (const job of decide(data, NOW)) {
      try {
        await webpush.sendNotification(data.sub, JSON.stringify(payloadFor(job.kind)), { TTL: 4 * 3600, urgency: "normal", topic: job.kind === "test" ? "pp-test" : "pp-rappel" });
        sent++;
        if (job.kind === "test") await patch(token, name, { testSent: data.testAt });
        else await patch(token, name, { lastSent: job.day });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          // L'appareil n'accepte plus les notifications (désinstallé, autorisation retirée…). L'app se réabonnera à sa prochaine ouverture.
          dead++; await patch(token, name, { dead: true }).catch(() => {});
        } else { failed++; console.error("Envoi échoué :", e.statusCode || "", (e.body || e.message || "").toString().slice(0, 200)); }
      }
    }
  }
  console.log(`Rappels : ${docs.length} appareil(s) inscrit(s), ${sent} envoyé(s), ${dead} désinscrit(s), ${failed} échec(s).`);
  if (failed && !sent) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch(e => { console.error("Le robot de rappel a échoué :", e.message); process.exit(1); });
}
