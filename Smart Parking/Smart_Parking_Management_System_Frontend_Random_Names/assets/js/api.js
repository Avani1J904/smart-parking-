/*
 * api.js — Live Backend API Helper for ParkEase Smart Parking Management System
 *
 * Automatically connects to:
 *  - Same origin when served by Flask / Render / PythonAnywhere
 *  - Your live Render backend by default when opened locally or on Netlify
 *  - Or any custom backend URL configured in the Backend & Database Dashboard
 */
const SPMS = (() => {
  const DEFAULT_CLOUD_API = "https://smart-parking-system-4-5gmh.onrender.com";
  const TOKEN_KEY = "spms_token";
  const USER_KEY = "spms_user";
  const API_BASE_KEY = "spms_api_base";

  let memoryToken = null;

  function detectDefaultApiBase() {
    try {
      const saved = localStorage.getItem(API_BASE_KEY);
      if (saved) return saved.replace(/\/+$/, "");
    } catch (e) {}

    if (typeof window !== "undefined" && window.location) {
      const origin = window.location.origin || "";
      const host = window.location.hostname || "";
      const port = window.location.port || "";
      if (
        origin.startsWith("http") &&
        (host.endsWith("onrender.com") ||
          host.endsWith("pythonanywhere.com") ||
          port === "5000")
      ) {
        return origin.replace(/\/+$/, "");
      }
    }
    return DEFAULT_CLOUD_API;
  }

  let currentApiBase = detectDefaultApiBase();

  const getApiBase = () => currentApiBase;
  const setApiBase = (url) => {
    currentApiBase = (url || "").trim().replace(/\/+$/, "") || DEFAULT_CLOUD_API;
    try {
      localStorage.setItem(API_BASE_KEY, currentApiBase);
    } catch (e) {}
    return currentApiBase;
  };

  const getToken = () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch (e) {
      return memoryToken;
    }
  };

  const setToken = (t) => {
    memoryToken = t;
    try {
      t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  };

  const getUser = () => {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  };

  const setUser = (u) => {
    try {
      u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY);
    } catch (e) {}
  };

  async function rawRequest(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers.Authorization = "Bearer " + token;

    const cleanPath = path.startsWith("/") ? path : "/" + path;
    const url = currentApiBase + cleanPath;
    const t0 = performance.now();

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    });
    const latencyMs = Math.round(performance.now() - t0);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, latencyMs, url, data };
  }

  async function request(method, path, body) {
    const result = await rawRequest(method, path, body);
    if (!result.ok) {
      const e = result.data.error || {};
      const err = new Error(e.message || `Request failed (${result.status})`);
      err.code = e.code;
      err.status = result.status;
      err.details = e.details;
      if (result.status === 401 && e.code !== "INVALID_CREDENTIALS") {
        setToken(null);
        setUser(null);
      }
      throw err;
    }
    return result.data;
  }

  const qs = (params) => {
    const clean = Object.fromEntries(
      Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "")
    );
    const text = new URLSearchParams(clean).toString();
    return text ? "?" + text : "";
  };

  return {
    DEFAULT_CLOUD_API,
    getApiBase,
    setApiBase,
    getToken,
    getUser,
    isLoggedIn: () => !!getToken(),
    rawRequest,

    // --- Health ---
    health: () => rawRequest("GET", "/api/health"),

    // --- Auth ---
    async login(email, password) {
      const d = await request("POST", "/api/auth/login", { email, password });
      setToken(d.token);
      setUser(d.user);
      return d.user;
    },
    async register(full_name, email, mobile, password, saveSession = true) {
      const d = await request("POST", "/api/auth/register", { full_name, email, mobile, password });
      if (saveSession) {
        setToken(d.token);
        setUser(d.user);
      }
      return d;
    },
    async logout() {
      try {
        await request("POST", "/api/auth/logout");
      } catch (e) {
      } finally {
        setToken(null);
        setUser(null);
      }
    },
    me: () => request("GET", "/api/auth/me").then((d) => { setUser(d.user); return d.user; }),

    // --- Public Parking ---
    locations: () => request("GET", "/api/parking/locations").then((d) => d.locations),
    slots: (filters) => request("GET", "/api/parking/slots" + qs(filters)),
    quote: (slot_id, duration_hours) => request("GET", "/api/bookings/quote" + qs({ slot_id, duration_hours })),

    // --- Bookings & Payments ---
    createBooking: (form) => request("POST", "/api/bookings", form),
    startPayment: (booking_id, method) => request("POST", "/api/payments/create", { booking_id, method }),
    verifyPayment: (payment_id, extra) => request("POST", "/api/payments/verify", { payment_id, ...extra }),
    dashboard: () => request("GET", "/api/dashboard"),
    history: (filters) => request("GET", "/api/bookings/history" + qs(filters)),
    booking: (id) => request("GET", "/api/bookings/" + encodeURIComponent(id)),
    cancelBooking: (id) => request("DELETE", "/api/bookings/" + encodeURIComponent(id)),
    receipt: (id) => request("GET", "/api/bookings/" + encodeURIComponent(id) + "/receipt"),
    profile: () => request("GET", "/api/profile"),
    updateProfile: (changes) => request("PUT", "/api/profile", changes),

    // --- Admin & Database ---
    adminSummary: (filters) => request("GET", "/api/admin/summary" + qs(filters)),
    adminBookings: (filters) => request("GET", "/api/admin/bookings" + qs(filters)),
    adminUsers: (filters) => request("GET", "/api/admin/users" + qs(filters)),
    adminDatabase: () => request("GET", "/api/admin/database"),
    adminUpdateSlot: (slot_id, changes) => request("PUT", `/api/admin/slots/${slot_id}`, changes),
    adminCreateLocation: (payload) => request("POST", "/api/admin/locations", payload),
    adminCreateSlot: (payload) => request("POST", "/api/admin/slots", payload),
  };
})();

if (typeof module !== "undefined") module.exports = SPMS;
