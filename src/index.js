import { sendPush } from "./webpush.js";

export { Radar };


// ---------------------------------------------------------------------------
// Entry point. Static files (the PWA) are served from ./public.
// /api/config is public (just the push public key); everything else under /api/
// needs  Authorization: Bearer <APP_TOKEN>  and is handled by the Durable Object.
// ---------------------------------------------------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/config") {
      return Response.json({ vapidPublic: env.VAPID_PUBLIC });
    }
    if (url.pathname.startsWith("/api/")) {
      const auth = req.headers.get("Authorization") || "";
      if (!env.APP_TOKEN || auth !== `Bearer ${env.APP_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const stub = env.RADAR.get(env.RADAR.idFromName("main"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};

// One Durable Object ("main") does everything: it keeps its own alarm firing every
// POLL_SECONDS, polls Apple, remembers what was in stock last time, and sends push
// notifications. Cron triggers can't run faster than 1/min, so an alarm loop is used.
class Radar {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.parts = env.PARTS.split(",").map((p) => {
      const [part, label] = p.split(":");
      return { part, label };
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const s = this.state.storage;
    // make sure the polling loop is alive
    if ((await s.getAlarm()) == null) await s.setAlarm(Date.now() + 500);

    if (url.pathname === "/api/subscribe" && req.method === "POST") {
      const sub = await req.json();
      const subs = (await s.get("subs")) || {};
      subs[sub.endpoint] = sub;
      await s.put("subs", subs);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/unsubscribe" && req.method === "POST") {
      const { endpoint } = await req.json();
      const subs = (await s.get("subs")) || {};
      delete subs[endpoint];
      await s.put("subs", subs);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/test" && req.method === "POST") {
      const n = await this.notifyAll({ title: `${this.env.PRODUCT_NAME} radar test`, body: "Push notifications are working.", url: this.env.BUY_URL });
      return Response.json({ sent: n });
    }
    if (url.pathname === "/api/status") {
      const subs = (await s.get("subs")) || {};
      return Response.json({
        lastCheck: await s.get("lastCheck"),
        lastError: await s.get("lastError"),
        checks: (await s.get("checks")) || 0,
        stores: (await s.get("stores")) || [],
        inStock: (await s.get("inStock")) || [],
        subscribers: Object.keys(subs).length,
        productName: this.env.PRODUCT_NAME,
        buyUrl: this.env.BUY_URL,
        parts: this.parts.map((p) => p.label),
        zip: this.env.ZIP,
        radius: Number(this.env.RADIUS_MILES),
        pollSeconds: Number(this.env.POLL_SECONDS),
      });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const s = this.state.storage;
    let delay = Number(this.env.POLL_SECONDS) * 1000;
    try {
      await this.check();
      await s.delete("lastError");
      await s.put("failStreak", 0);
      if (await s.get("errorNotified")) {
        await s.delete("errorNotified");
        await this.notifyAll({ title: "Stock radar recovered", body: "Apple checks are working again.", url: this.env.BUY_URL });
      }
    } catch (e) {
      const message = String(e.message || e);
      await s.put("lastError", { at: Date.now(), message });
      const streak = ((await s.get("failStreak")) || 0) + 1;
      await s.put("failStreak", streak);
      delay = 60_000; // back off if Apple is unhappy
      // 3 failures in a row (~2 min) -> tell the phone once, until it recovers
      if (streak >= 3 && !(await s.get("errorNotified"))) {
        await s.put("errorNotified", true);
        await this.notifyAll({ title: "Stock radar is failing", body: `${message.slice(0, 120)}\nCheck stock manually.`, url: this.env.BUY_URL });
      }
    }
    await s.setAlarm(Date.now() + delay);
  }

  // Ask Apple's pickup endpoint about one part near ZIP. Unofficial, public, no key.
  // Returns Apple's list of nearby stores; each has partsAvailability[part].pickupDisplay.
  async fetchPart(part) {
    const q = new URLSearchParams({
      "mts.0": "regular",
      "mts.1": "compact",
      cppart: this.env.CPPART,
      product: part,
      location: this.env.ZIP,
    });
    const r = await fetch(`https://www.apple.com/shop/pickup-message-recommendations?${q}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15", Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`Apple HTTP ${r.status} ${(await r.text()).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
    const j = await r.json().catch(() => null);
    if (!j?.body?.PickupMessage) throw new Error("unexpected Apple response");
    return j.body.PickupMessage.stores || [];
  }

  // One polling pass. CUSTOMIZE HERE:
  //  - radius filter:      `st.storedistance <= radius`
  //  - what counts as stock: `pa.pickupDisplay === "available"`
  //  - which stores: filter on st.storeNumber (e.g. only R077) if you want specific ones
  async check() {
    const s = this.state.storage;
    const radius = Number(this.env.RADIUS_MILES);
    const results = await Promise.all(this.parts.map((p) => this.fetchPart(p.part)));

    const nearby = new Map();
    const inStock = new Map(); // key -> info
    results.forEach((stores) => {
      for (const st of stores) {
        if (!(st.storedistance <= radius)) continue;
        nearby.set(st.storeNumber, { name: st.storeName, miles: st.storedistance });
        for (const { part, label } of this.parts) {
          const pa = st.partsAvailability?.[part];
          if (pa && pa.pickupDisplay === "available") {
            inStock.set(`${st.storeNumber}|${part}`, {
              store: st.storeName, storeNumber: st.storeNumber, miles: st.storedistance, part, label,
              title: pa.storePickupProductTitle || `${this.env.PRODUCT_NAME} ${label}`,
            });
          }
        }
      }
    });

    // Notify only for store+part combos that were NOT in stock on the previous pass,
    // so you get one alert per restock instead of one every few seconds.
    const prev = new Set(((await s.get("inStock")) || []).map((x) => `${x.storeNumber}|${x.part}`));
    const fresh = [...inStock.entries()].filter(([k]) => !prev.has(k)).map(([, v]) => v);

    await s.put("inStock", [...inStock.values()]);
    await s.put("stores", [...nearby.values()]);
    await s.put("lastCheck", Date.now());
    await s.put("checks", (((await s.get("checks")) || 0) + 1));

    if (fresh.length) {
      const lines = fresh.map((f) => `${f.label} @ ${f.store} (${f.miles} mi)`);
      await this.notifyAll({ title: `${this.env.PRODUCT_NAME} in stock!`, body: lines.join("\n"), url: this.env.BUY_URL });
    }
  }

  async notifyAll(payload) {
    const s = this.state.storage;
    const subs = (await s.get("subs")) || {};
    let sent = 0;
    for (const [endpoint, sub] of Object.entries(subs)) {
      try {
        const r = await sendPush(sub, payload, this.env);
        if (r.status === 404 || r.status === 410) delete subs[endpoint];
        else if (r.ok) sent++;
      } catch (_) {}
    }
    await s.put("subs", subs);
    return sent;
  }
}
