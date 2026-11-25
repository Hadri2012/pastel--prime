// Service worker de pastel prime : affiche les notifications (y compris le rappel quotidien envoyé quand l'app est fermée)
// et rouvre le chat quand on les touche.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  // iOS exige qu'un message push affiche toujours une notification.
  e.waitUntil(self.registration.showNotification(d.title || "pastel prime 🌟", {
    body: d.body || "Petit rappel du jour : passe voir le chat du groupe !",
    icon: "icon-192.png", badge: "icon-192.png",
    tag: d.tag || "pp-rappel", renotify: true,
    data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
