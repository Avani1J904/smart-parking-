/*
 * backend-dashboard.js — Live Backend & Database Console Controller
 */
(() => {
  const state = {
    tables: {
      users: [],
      bookings: [],
      parking_slots: [],
      parking_locations: [],
      parking_zones: [],
      payments: [],
    },
    activeTable: "bookings",
    summary: null,
    chart: null,
    hasFullDbEndpoint: false,
  };

  const ENDPOINTS_TO_TEST = [
    { method: "GET", path: "/api/health", label: "Health Check" },
    { method: "GET", path: "/api/parking/locations", label: "Parking Locations" },
    { method: "GET", path: "/api/parking/slots?location_id=1", label: "Live Slot Grid" },
    { method: "GET", path: "/api/admin/summary", label: "Admin KPI Summary" },
    { method: "GET", path: "/api/admin/users", label: "Users Table" },
    { method: "GET", path: "/api/admin/bookings", label: "Bookings Table" },
    { method: "GET", path: "/api/admin/database", label: "Full SQLite Snapshot" },
  ];

  const $ = (id) => document.getElementById(id);

  function showToast(message, isError = false) {
    const toastEl = $("consoleToast");
    const bodyEl = $("consoleToastBody");
    bodyEl.textContent = message;
    toastEl.classList.remove("text-bg-danger", "text-bg-success");
    toastEl.classList.add(isError ? "text-bg-danger" : "text-bg-success");
    bootstrap.Toast.getOrCreateInstance(toastEl, { delay: 3500 }).show();
  }

  function escapeHtml(val) {
    if (val === null || val === undefined) return '<span class="text-muted">—</span>';
    return String(val)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatCell(key, value) {
    if (value === null || value === undefined || value === "") {
      return '<span class="text-muted">—</span>';
    }
    const upper = String(value).toUpperCase();
    if (key === "status" || key === "payment_status") {
      let cls = "bg-secondary-subtle text-secondary";
      if (["AVAILABLE", "CONFIRMED", "COMPLETED", "SUCCESS"].includes(upper)) cls = "badge-available";
      else if (["OCCUPIED", "CANCELLED", "FAILED", "OUT_OF_SERVICE"].includes(upper)) cls = "badge-occupied";
      else if (["RESERVED", "PENDING", "ACTIVE"].includes(upper)) cls = "badge-reserved";
      return `<span class="badge badge-soft ${cls}">${escapeHtml(value)}</span>`;
    }
    if (key === "role") {
      const cls = upper === "ADMIN" ? "bg-primary-subtle text-primary" : "bg-light text-dark border";
      return `<span class="badge badge-soft ${cls}">${escapeHtml(value)}</span>`;
    }
    if (key === "total_amount" || key === "amount" || key === "rate_per_hour") {
      return `<span class="fw-semibold">₹${escapeHtml(value)}</span>`;
    }
    if (key === "has_charger" || key === "notifications_enabled") {
      return value ? '<i class="bi bi-check-circle-fill text-success"></i> Yes' : '<span class="text-muted">No</span>';
    }
    if (["booking_id", "booking_code", "slot_no", "vehicle_no", "transaction_ref", "qr_token"].includes(key)) {
      return `<span class="mono fw-semibold">${escapeHtml(value)}</span>`;
    }
    return escapeHtml(value);
  }

  function updateAuthUI() {
    const user = SPMS.getUser();
    const loggedIn = SPMS.isLoggedIn() && user;
    $("authLoggedOut").classList.toggle("d-none", !!loggedIn);
    $("authLoggedIn").classList.toggle("d-none", !loggedIn);
    if (loggedIn) {
      $("sessionUserName").textContent = user.full_name || "User";
      $("sessionUserRole").textContent = user.role || "USER";
      $("sessionUserEmail").textContent = user.email || "";
    }
  }

  function setStatusBadge(online, text) {
    const badge = $("navStatusBadge");
    if (online === true) {
      badge.style.background = "#dcfce7";
      badge.style.color = "#166534";
      badge.innerHTML = `<span class="status-dot online me-1"></span> ${escapeHtml(text)}`;
    } else if (online === false) {
      badge.style.background = "#fee2e2";
      badge.style.color = "#991b1b";
      badge.innerHTML = `<span class="status-dot offline me-1"></span> ${escapeHtml(text)}`;
    } else {
      badge.style.background = "#fef3c7";
      badge.style.color = "#92400e";
      badge.innerHTML = `<span class="status-dot checking me-1"></span> ${escapeHtml(text)}`;
    }
  }

  function setConnectionAlert(msg, type = "warning") {
    const el = $("connectionAlert");
    if (!msg) {
      el.classList.add("d-none");
      return;
    }
    el.className = `alert alert-${type} mt-3 mb-0 py-2 small`;
    el.innerHTML = msg;
    el.classList.remove("d-none");
  }

  async function checkHealth() {
    setStatusBadge(null, "Connecting...");
    try {
      const res = await SPMS.health();
      if (res.ok && res.data.status === "ok") {
        setStatusBadge(true, `Backend Online (${res.latencyMs}ms)`);
        $("kpiHealth").textContent = "Online";
        $("kpiHealth").className = "stat-value fs-4 text-success";
        $("kpiLatency").textContent = `${res.latencyMs} ms response`;
        if (res.data.time) {
          $("kpiServerDate").textContent = res.data.time.replace("T", " ").slice(0, 19);
        }
        setConnectionAlert("");
        return true;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setStatusBadge(false, "Backend Offline");
      $("kpiHealth").textContent = "Offline";
      $("kpiHealth").className = "stat-value fs-4 text-danger";
      $("kpiLatency").textContent = "Unreachable";
      setConnectionAlert(
        `<strong>Cannot reach backend at <span class="mono">${escapeHtml(SPMS.getApiBase())}</span>.</strong> ` +
          `If using Render free tier, wait 30–50 seconds for cold start and click <b>Refresh</b>, or switch to <b>Localhost (:5000)</b>.`,
        "danger"
      );
      return false;
    }
  }

  async function loadPublicData() {
    try {
      const locs = await SPMS.locations();
      state.tables.parking_locations = locs.map((l) => ({
        location_id: l.location_id,
        name: l.name,
        address: l.address,
        total_slots: l.total_slots,
        available_slots: l.available_slots,
      }));

      // Fetch slots across all locations
      const allSlots = [];
      const zonesMap = new Map();
      for (const loc of locs) {
        const res = await SPMS.slots({ location_id: loc.location_id });
        (res.slots || []).forEach((s) => {
          allSlots.push({
            slot_id: s.slot_id,
            slot_no: s.slot_no,
            location_name: s.location_name,
            zone_name: s.zone_name,
            vehicle_type: s.vehicle_type,
            status: s.status,
            rate_per_hour: s.rate_per_hour,
            has_charger: s.has_charger,
            description: s.description,
          });
          if (!zonesMap.has(s.zone_id)) {
            zonesMap.set(s.zone_id, {
              zone_id: s.zone_id,
              location_id: s.location_id,
              location_name: s.location_name,
              zone_name: s.zone_name,
              floor: s.floor,
            });
          }
        });
      }
      state.tables.parking_slots = allSlots;
      state.tables.parking_zones = Array.from(zonesMap.values());

      const avail = allSlots.filter((s) => s.status === "AVAILABLE").length;
      $("kpiSlots").textContent = `${avail} / ${allSlots.length}`;
      $("kpiSlotsFree").textContent = `${avail} available right now`;
      populateFormSelects();
    } catch (e) {
      console.warn("Public data load failed:", e);
    }
  }

  async function loadAdminAndDatabaseData() {
    const user = SPMS.getUser();
    if (!SPMS.isLoggedIn()) {
      $("dbModeSubtitle").innerHTML =
        `Viewing public tables (<span class="mono">parking_slots</span>, <span class="mono">parking_locations</span>). ` +
        `<strong>Click "Login" above as Admin</strong> to view <span class="mono">users</span>, <span class="mono">bookings</span>, and <span class="mono">payments</span>.`;
      if (!["parking_slots", "parking_locations", "parking_zones"].includes(state.activeTable)) {
        state.activeTable = "parking_slots";
      }
      renderTableSelector();
      renderActiveTable();
      return;
    }

    if (user && user.role !== "ADMIN") {
      $("dbModeSubtitle").textContent = "Logged in as Driver. Log in as Admin (admin@parkease.com) to inspect all database tables.";
      return;
    }

    // 1. Try the full /api/admin/database endpoint first
    try {
      const dbData = await SPMS.adminDatabase();
      state.hasFullDbEndpoint = true;
      state.tables = dbData.tables;
      $("kpiDbEngine").textContent = dbData.engine || "SQLite";
      $("kpiDbMeta").textContent = `${dbData.database_file} (${dbData.size_kb} KB)`;
      $("kpiUsers").textContent = dbData.counts.users;
      $("kpiBookings").textContent = dbData.counts.bookings;
      $("dbModeSubtitle").innerHTML =
        `Connected live to <strong>${escapeHtml(dbData.engine)}</strong> (<span class="mono">${escapeHtml(dbData.database_file)}</span>, ${dbData.size_kb} KB) — showing all 6 database tables.`;
    } catch (err) {
      state.hasFullDbEndpoint = false;
      // Graceful fallback using existing admin endpoints (works even before redeploying backend!)
      try {
        const [usersRes, bookingsRes] = await Promise.all([
          SPMS.adminUsers({ per_page: 100 }),
          SPMS.adminBookings({ per_page: 100 }),
        ]);
        state.tables.users = usersRes.users || [];
        state.tables.bookings = (bookingsRes.bookings || []).map((b) => ({
          booking_id: b.booking_id,
          user_name: b.user_name,
          location: b.location,
          slot_no: b.slot_no,
          vehicle_no: b.vehicle_no,
          start_time: b.start_time,
          duration_hours: b.duration_hours,
          total_amount: b.total_amount,
          status: b.status,
          payment_status: b.payment_status,
        }));
        state.tables.payments = (bookingsRes.bookings || [])
          .filter((b) => b.payment_method)
          .map((b) => ({
            booking_id: b.booking_id,
            method: b.payment_method,
            amount: b.total_amount,
            status: b.payment_status,
            created_at: b.created_at,
          }));
        $("kpiUsers").textContent = usersRes.pagination?.total ?? state.tables.users.length;
        $("kpiBookings").textContent = bookingsRes.pagination?.total ?? state.tables.bookings.length;
        $("dbModeSubtitle").innerHTML =
          `Live Admin API connected. <em>Tip: Push the latest backend update to enable raw SQLite file size & full payments table.</em>`;
      } catch (innerErr) {
        showToast(innerErr.message, true);
      }
    }

    // 2. Load Admin Summary (KPIs + Chart + Zones)
    try {
      const summary = await SPMS.adminSummary();
      state.summary = summary;
      $("kpiSlots").textContent = `${summary.available_slots} / ${summary.total_slots}`;
      $("kpiSlotsFree").textContent = `${summary.occupied_slots} occupied • ${summary.reserved_slots} reserved`;
      $("kpiDailyBookings").textContent = `${summary.daily_bookings} booked today`;
      $("kpiRevenue").textContent = `₹${summary.daily_revenue}`;
      $("analyticsDateBadge").textContent = summary.date;
      renderAnalytics(summary);
    } catch (e) {
      console.warn("Summary error:", e);
    }

    populateFormSelects();
    renderTableSelector();
    renderActiveTable();
  }

  function populateFormSelects() {
    const slotSelect = $("bookingSlotSelect");
    if (slotSelect) {
      const slots = state.tables.parking_slots || [];
      slotSelect.innerHTML = slots
        .map(
          (s) =>
            `<option value="${s.slot_id}">${escapeHtml(s.slot_no)} — ${escapeHtml(s.location_name || "")} (${escapeHtml(s.vehicle_type)}, ₹${s.rate_per_hour}/hr) [${s.status}]</option>`
        )
        .join("");
    }

    const zoneSelect = $("slotZoneSelect");
    if (zoneSelect) {
      const zones = state.tables.parking_zones || [];
      zoneSelect.innerHTML = zones
        .map((z) => `<option value="${z.zone_id}">${escapeHtml(z.zone_name)} — ${escapeHtml(z.location_name || "Loc " + z.location_id)}</option>`)
        .join("");
    }
  }

  function renderTableSelector() {
    const bar = $("tableSelectorBar");
    const order = ["bookings", "users", "parking_slots", "parking_locations", "parking_zones", "payments"];
    bar.innerHTML = order
      .map((name) => {
        const count = (state.tables[name] || []).length;
        const active = state.activeTable === name ? "active" : "";
        return `
          <button type="button" class="table-pill ${active}" data-table="${name}">
            <i class="bi bi-table me-1"></i><span class="mono">${name}</span>
            <span class="badge rounded-pill bg-secondary-subtle text-dark ms-1">${count}</span>
          </button>`;
      })
      .join("");

    bar.querySelectorAll(".table-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeTable = btn.dataset.table;
        renderTableSelector();
        renderActiveTable();
      });
    });
  }

  function renderActiveTable() {
    const rows = state.tables[state.activeTable] || [];
    const q = ($("dbSearchInput").value || "").trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q)))
      : rows;

    const head = $("dbTableHead");
    const body = $("dbTableBody");
    const isAdmin = SPMS.isLoggedIn() && SPMS.getUser()?.role === "ADMIN";
    const showSlotAction = state.activeTable === "parking_slots" && isAdmin;

    if (!filtered.length) {
      head.innerHTML = "";
      body.innerHTML = `<tr><td class="text-center py-5 text-muted-custom">No rows found in <span class="mono fw-semibold">${escapeHtml(state.activeTable)}</span>.${
        !SPMS.isLoggedIn() && ["users", "bookings", "payments"].includes(state.activeTable)
          ? '<br><span class="small">Log in as Admin above to inspect this table.</span>'
          : ""
      }</td></tr>`;
      $("dbRowSummary").textContent = `0 of ${rows.length} rows shown in ${state.activeTable}`;
      return;
    }

    const cols = Object.keys(filtered[0]);
    head.innerHTML =
      "<tr>" +
      cols.map((c) => `<th class="mono text-uppercase small text-muted">${escapeHtml(c)}</th>`).join("") +
      (showSlotAction ? '<th class="small text-muted">Quick Update</th>' : "") +
      "</tr>";

    body.innerHTML = filtered
      .map((row) => {
        const tds = cols.map((c) => `<td>${formatCell(c, row[c])}</td>`).join("");
        const actionTd = showSlotAction
          ? `<td>
              <select class="form-select form-select-sm slot-status-select" data-slot-id="${row.slot_id}" style="min-height:30px;width:145px;font-size:.78rem">
                ${["AVAILABLE", "OCCUPIED", "RESERVED", "OUT_OF_SERVICE"]
                  .map((st) => `<option value="${st}" ${row.status === st ? "selected" : ""}>${st}</option>`)
                  .join("")}
              </select>
            </td>`
          : "";
        return `<tr>${tds}${actionTd}</tr>`;
      })
      .join("");

    if (showSlotAction) {
      body.querySelectorAll(".slot-status-select").forEach((sel) => {
        sel.addEventListener("change", async () => {
          const slotId = Number(sel.dataset.slotId);
          const status = sel.value;
          try {
            await SPMS.adminUpdateSlot(slotId, { status });
            showToast(`Slot #${slotId} updated to ${status}`);
            await refreshAll();
          } catch (err) {
            showToast(err.message, true);
          }
        });
      });
    }

    $("dbRowSummary").textContent = `Showing ${filtered.length} of ${rows.length} rows in ${state.activeTable}`;
    $("dbLastUpdated").textContent = `Last synced: ${new Date().toLocaleTimeString()}`;
  }

  function renderAnalytics(summary) {
    const ctx = $("liveOccupancyChart");
    if (ctx && window.Chart && summary.occupancy_trend) {
      if (state.chart) state.chart.destroy();
      state.chart = new Chart(ctx, {
        type: "line",
        data: {
          labels: summary.occupancy_trend.labels,
          datasets: [
            {
              label: "Active / Booked Slots",
              data: summary.occupancy_trend.values,
              borderColor: "#2563eb",
              backgroundColor: "rgba(37, 99, 235, 0.12)",
              tension: 0.35,
              fill: true,
              borderWidth: 2.5,
            },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
      });
    }

    const zoneList = $("liveZoneList");
    if (zoneList && summary.zones) {
      zoneList.innerHTML = summary.zones
        .map((z) => {
          const used = z.total_slots - z.free_slots;
          const pct = z.total_slots ? Math.round((used / z.total_slots) * 100) : 0;
          const badgeCls = z.free_slots > 5 ? "badge-available" : z.free_slots > 0 ? "badge-reserved" : "badge-occupied";
          return `
            <div class="p-3 rounded-3 border bg-light">
              <div class="d-flex justify-content-between align-items-center mb-1">
                <div>
                  <div class="fw-bold small">${escapeHtml(z.zone_name)}</div>
                  <div class="text-muted-custom" style="font-size:.75rem">${escapeHtml(z.location_name)}</div>
                </div>
                <span class="badge badge-soft ${badgeCls}">${z.free_slots} / ${z.total_slots} free</span>
              </div>
              <div class="progress" style="height:6px">
                <div class="progress-bar" style="width:${pct}%"></div>
              </div>
            </div>`;
        })
        .join("");
    }
  }

  async function runEndpointHealthChecks() {
    const tbody = $("endpointHealthBody");
    tbody.innerHTML = ENDPOINTS_TO_TEST.map(
      (ep, i) => `
      <tr id="ep-row-${i}">
        <td>
          <span class="badge bg-primary-subtle text-primary mono me-1">${ep.method}</span>
          <span class="mono small">${escapeHtml(ep.path)}</span>
          <div class="text-muted-custom" style="font-size:.74rem">${ep.label}</div>
        </td>
        <td class="ep-status"><span class="badge bg-light text-muted border">Testing...</span></td>
        <td class="ep-latency mono small">—</td>
        <td><button class="btn btn-sm btn-outline-secondary py-0 px-2 ep-inspect" data-path="${ep.path}">Inspect</button></td>
      </tr>`
    ).join("");

    tbody.querySelectorAll(".ep-inspect").forEach((btn) => {
      btn.addEventListener("click", () => {
        $("testerMethod").value = "GET";
        $("testerPath").value = btn.dataset.path;
        $("testerBody").value = "";
        $("apiTesterForm").requestSubmit();
      });
    });

    await Promise.all(
      ENDPOINTS_TO_TEST.map(async (ep, i) => {
        const row = $(`ep-row-${i}`);
        try {
          const res = await SPMS.rawRequest(ep.method, ep.path);
          const badgeCls = res.ok ? "badge-available" : res.status === 401 ? "badge-reserved" : "badge-occupied";
          row.querySelector(".ep-status").innerHTML = `<span class="badge badge-soft ${badgeCls}">${res.status} ${res.ok ? "OK" : ""}</span>`;
          row.querySelector(".ep-latency").textContent = `${res.latencyMs}ms`;
        } catch (err) {
          row.querySelector(".ep-status").innerHTML = `<span class="badge badge-soft badge-occupied">ERR</span>`;
          row.querySelector(".ep-latency").textContent = "—";
        }
      })
    );
  }

  function exportActiveTableCsv() {
    const rows = state.tables[state.activeTable] || [];
    if (!rows.length) {
      showToast("No rows to export.", true);
      return;
    }
    const cols = Object.keys(rows[0]);
    const csv = [
      cols.join(","),
      ...rows.map((r) =>
        cols
          .map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `parkease_${state.activeTable}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    showToast(`Exported ${rows.length} rows from ${state.activeTable}.`);
  }

  async function refreshAll() {
    updateAuthUI();
    const ok = await checkHealth();
    if (!ok) return;
    await loadPublicData();
    await loadAdminAndDatabaseData();
  }

  function bindEvents() {
    // Set default date = tomorrow
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    if ($("bookingDateInput")) $("bookingDateInput").value = tomorrow;

    // API base input & presets
    $("apiBaseInput").value = SPMS.getApiBase();
    $("connectBtn").addEventListener("click", () => {
      SPMS.setApiBase($("apiBaseInput").value);
      showToast(`Connected target set to ${SPMS.getApiBase()}`);
      refreshAll();
    });

    document.querySelectorAll(".preset-url").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target =
          btn.dataset.url === "SAME_ORIGIN"
            ? window.location.origin.startsWith("http")
              ? window.location.origin
              : "http://localhost:5000"
            : btn.dataset.url;
        $("apiBaseInput").value = target;
        SPMS.setApiBase(target);
        refreshAll();
      });
    });

    $("refreshAllBtn").addEventListener("click", refreshAll);
    $("dbSearchInput").addEventListener("input", renderActiveTable);
    $("exportCsvBtn").addEventListener("click", exportActiveTableCsv);
    $("runEndpointsBtn").addEventListener("click", runEndpointHealthChecks);

    // Admin login
    $("adminLoginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const user = await SPMS.login($("loginEmail").value.trim(), $("loginPassword").value);
        showToast(`Logged in as ${user.full_name} (${user.role})`);
        state.activeTable = "bookings";
        await refreshAll();
        runEndpointHealthChecks();
      } catch (err) {
        showToast(err.message, true);
      }
    });

    // Logout
    $("logoutBtn").addEventListener("click", async () => {
      await SPMS.logout();
      showToast("Logged out");
      refreshAll();
    });

    // Add User Form (does not overwrite current Admin session!)
    $("addUserForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const res = await SPMS.register(
          fd.get("full_name"),
          fd.get("email"),
          fd.get("mobile"),
          fd.get("password"),
          false
        );
        showToast(`User "${res.user.full_name}" inserted into database!`);
        e.target.reset();
        state.activeTable = "users";
        await refreshAll();
      } catch (err) {
        showToast(err.message, true);
      }
    });

    // Add Booking Form
    $("addBookingForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!SPMS.isLoggedIn()) {
        showToast("Please log in first to create a booking.", true);
        return;
      }
      const fd = new FormData(e.target);
      try {
        const created = await SPMS.createBooking({
          slot_id: Number(fd.get("slot_id")),
          vehicle_type: fd.get("vehicle_type"),
          vehicle_no: fd.get("vehicle_no"),
          date: fd.get("date"),
          start_time: fd.get("start_time"),
          duration_hours: Number(fd.get("duration_hours")),
        });
        const bookingCode = created.booking.booking_id;

        if ($("autoPayCheck").checked) {
          const pay = await SPMS.startPayment(bookingCode, "UPI");
          await SPMS.verifyPayment(pay.payment.payment_id, { upi_id: "demo@upi" });
          showToast(`Booking ${bookingCode} created & CONFIRMED via UPI!`);
        } else {
          showToast(`Booking ${bookingCode} created (PENDING hold).`);
        }

        state.activeTable = "bookings";
        await refreshAll();
      } catch (err) {
        showToast(err.message, true);
      }
    });

    // Add Location Form
    $("addLocationForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const res = await SPMS.adminCreateLocation({
          name: fd.get("name"),
          address: fd.get("address"),
        });
        showToast(`Location "${res.location.name}" added to database!`);
        e.target.reset();
        state.activeTable = "parking_locations";
        await refreshAll();
      } catch (err) {
        showToast(err.status === 404 ? "Redeploy updated backend to enable Add Location endpoint." : err.message, true);
      }
    });

    // Add Slot Form
    $("addSlotForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const res = await SPMS.adminCreateSlot({
          zone_id: Number(fd.get("zone_id")),
          slot_no: fd.get("slot_no"),
          vehicle_type: fd.get("vehicle_type"),
          rate_per_hour: Number(fd.get("rate_per_hour")),
        });
        showToast(`Slot "${res.slot.slot_no}" added to database!`);
        e.target.reset();
        state.activeTable = "parking_slots";
        await refreshAll();
      } catch (err) {
        showToast(err.status === 404 ? "Redeploy updated backend to enable Add Slot endpoint." : err.message, true);
      }
    });

    // API Playground Form
    $("apiTesterForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const method = $("testerMethod").value;
      const path = $("testerPath").value.trim();
      const rawBody = $("testerBody").value.trim();
      let parsedBody;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (err) {
          showToast("Invalid JSON in request body.", true);
          return;
        }
      }
      $("testerStatusMeta").textContent = "Sending...";
      try {
        const res = await SPMS.rawRequest(method, path, parsedBody);
        $("testerStatusMeta").textContent = `HTTP ${res.status} • ${res.latencyMs}ms • ${res.url}`;
        $("testerOutput").textContent = JSON.stringify(res.data, null, 2);
      } catch (err) {
        $("testerStatusMeta").textContent = "Network Error";
        $("testerOutput").textContent = String(err);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await refreshAll();
    runEndpointHealthChecks();
  });
})();
