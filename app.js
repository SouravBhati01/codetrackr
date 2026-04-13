/**
 * CodeTrackr — Multi-Platform Coding Stats Tracker
 * Author: Sourav Rajput | 2026
 *
 * Supports: LeetCode, Codeforces, HackerRank
 * Features: Live stats, caching, leaderboards, coder comparison
 */

/* ═══ Service Worker Registration ═══ */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
}

/* ═══ Global Error Boundary ═══ */
window.addEventListener('error', function (event) {
    console.error('[CodeTrackr] Unhandled error:', event.error);
});
window.addEventListener('unhandledrejection', function (event) {
    console.error('[CodeTrackr] Unhandled promise rejection:', event.reason);
});

document.addEventListener("DOMContentLoaded", function () {

    /* ═══ DOM References ═══ */
    var el = function (id) { return document.getElementById(id); };
    var searchBtn     = el("search-btn");
    var userInput     = el("user-input");
    var skeletonEl    = el("skeleton-section");
    var errorBanner   = el("error-banner");
    var errorText     = el("error-text");
    var errorHint     = el("error-hint");
    var recentEl      = el("recent-searches");
    var heroEl        = el("hero-section");
    var searchEl      = el("search-section");
    var statsEl       = el("stats-section");
    var searchLabel   = el("search-label");
    var offlineBanner = el("offline-banner");

    /* ═══ Constants ═══ */
    var RING_CIRCUMFERENCE = 2 * Math.PI * 48;
    var CACHE_TTL          = 30 * 60 * 1000;       // 30 minutes
    var MAX_RECENT         = 5;
    var TOTAL_LC_USERS     = 4500000;
    var USERNAME_REGEX     = /^[a-zA-Z0-9_.\-]{1,40}$/;

    /* ═══ State ═══ */
    var currentPlatform   = null;
    var currentData       = {};
    var activeController  = null;

    /* ═══ Offline Detection ═══ */
    function updateOnlineStatus() {
        if (offlineBanner) {
            if (!navigator.onLine) {
                offlineBanner.classList.add("visible");
            } else {
                offlineBanner.classList.remove("visible");
            }
        }
    }
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();

    /* ═══ Utility Functions ═══ */

    /** Sanitize a string for safe HTML insertion (prevents XSS) */
    function sanitize(str) {
        if (str == null) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** Show error banner with message and optional hint */
    function showError(message, hint) {
        errorText.textContent = message;
        errorHint.innerHTML = hint || "";
        errorBanner.classList.add("visible");
    }

    /** Hide error banner */
    function hideError() {
        errorBanner.classList.remove("visible");
    }

    /** Toggle loading state on search button and skeleton */
    function setLoading(isLoading) {
        if (isLoading) {
            searchBtn.classList.add("loading");
            searchBtn.disabled = true;
            searchBtn.setAttribute("aria-busy", "true");
            statsEl.classList.add("hidden");
            skeletonEl.classList.remove("hidden");
        } else {
            searchBtn.classList.remove("loading");
            searchBtn.disabled = false;
            searchBtn.removeAttribute("aria-busy");
            skeletonEl.classList.add("hidden");
        }
    }

    /** Format large numbers (e.g., 1500 → "1.5K", 2000000 → "2.0M") */
    function formatNumber(num) {
        if (num == null || num === 0) return "0";
        if (num >= 1e6) return (num / 1e6).toFixed(1) + "M";
        if (num >= 1e3) return (num / 1e3).toFixed(1) + "K";
        return num.toLocaleString();
    }

    /** Calculate percentage string */
    function percent(solved, total) {
        return total > 0 ? ((solved / total) * 100).toFixed(1) + "%" : "0%";
    }

    /** Animate a number counting up in an element */
    function animateCount(element, target) {
        if (!element) return;
        var duration = 800;
        var start = performance.now();
        (function frame(now) {
            var progress = Math.min((now - start) / duration, 1);
            element.textContent = Math.round(target * (1 - Math.pow(1 - progress, 3)));
            if (progress < 1) requestAnimationFrame(frame);
        })(start);
    }

    /** Create an inline SVG icon string */
    function svgIcon(pathContent) {
        return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' + pathContent + "</svg>";
    }

    /* ═══ Cache Helpers ═══ */

    /** Get cached data for a platform/username combo */
    function getCache(platform, username) {
        try {
            var raw = localStorage.getItem("v5_" + platform + "_" + username.toLowerCase());
            if (!raw) return null;
            var obj = JSON.parse(raw);
            if (Date.now() - obj.t > CACHE_TTL) return null;
            return obj.d;
        } catch (e) { return null; }
    }

    /** Save data to cache */
    function setCache(platform, username, data) {
        try {
            localStorage.setItem("v5_" + platform + "_" + username.toLowerCase(), JSON.stringify({ d: data, t: Date.now() }));
        } catch (e) {}
    }

    /** Get recent searches for current platform */
    function getRecentSearches() {
        try { return JSON.parse(localStorage.getItem("v5_r_" + (currentPlatform || "")) || "[]"); }
        catch (e) { return []; }
    }

    /** Add a username to recent searches (localStorage + MongoDB) */
    function addRecentSearch(username) {
        var list = getRecentSearches().filter(function (x) { return x.toLowerCase() !== username.toLowerCase(); });
        list.unshift(username);
        if (list.length > MAX_RECENT) list.length = MAX_RECENT;
        try { localStorage.setItem("v5_r_" + (currentPlatform || ""), JSON.stringify(list)); } catch (e) {}
        renderRecentSearches();
        // Persist to MongoDB (fire-and-forget)
        dbSaveHistory(currentPlatform, username);
    }

    /* ═══ MongoDB Backend Helpers (non-blocking) ═══ */

    /** Save stats to MongoDB backend */
    function dbSaveStats(platform, username, data) {
        try {
            fetch("/api/stats", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ platform: platform, username: username, data: data })
            }).catch(function () {});
        } catch (e) {}
    }

    /** Save search history to MongoDB backend */
    function dbSaveHistory(platform, username) {
        try {
            fetch("/api/history", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ platform: platform, username: username })
            }).catch(function () {});
        } catch (e) {}
    }

    /** Try to get cached stats from MongoDB backend (returns promise) */
    function dbGetStats(platform, username) {
        return fetch("/api/stats?platform=" + encodeURIComponent(platform) + "&username=" + encodeURIComponent(username))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { return j && j.data ? j.data : null; })
            .catch(function () { return null; });
    }

    /** Render the recent searches chips */
    function renderRecentSearches() {
        var list = getRecentSearches();
        recentEl.innerHTML = list.length
            ? '<span class="recent-label">Recent:</span>' + list.map(function (u) {
                return '<button class="recent-chip" data-u="' + sanitize(u) + '" aria-label="Search for ' + sanitize(u) + '">' + sanitize(u) + '</button>';
            }).join("")
            : "";
    }

    recentEl.addEventListener("click", function (e) {
        var chip = e.target.closest("[data-u]");
        if (chip) { userInput.value = chip.dataset.u; doSearch(); }
    });

    /* ═══ Platform Selection ═══ */
    var PLATFORM_NAMES = { leetcode: "LeetCode", codeforces: "Codeforces", hackerrank: "HackerRank" };

    document.querySelectorAll(".platform-card:not(.disabled)").forEach(function (card) {
        card.addEventListener("click", function () {
            currentPlatform = card.dataset.platform;
            document.querySelectorAll(".platform-card").forEach(function (c) { c.classList.remove("selected"); });
            card.classList.add("selected");
            heroEl.classList.add("hidden");
            searchEl.classList.remove("hidden");
            statsEl.classList.add("hidden");
            searchLabel.innerHTML = 'Search <span style="color:var(--accent)">' + PLATFORM_NAMES[currentPlatform] + "</span>";
            userInput.placeholder = "Enter " + PLATFORM_NAMES[currentPlatform] + " username...";
            userInput.value = "";
            hideError();
            renderRecentSearches();
            userInput.focus();
        });
    });

    /** Navigate back to hero/home */
    function goHome() {
        searchEl.classList.add("hidden");
        statsEl.classList.add("hidden");
        heroEl.classList.remove("hidden");
        document.querySelectorAll(".platform-card").forEach(function (c) { c.classList.remove("selected"); });
        currentPlatform = null;
    }

    el("search-back").addEventListener("click", goHome);
    el("logo-home").addEventListener("click", goHome);
    el("logo-home").addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); }
    });

    /* ═══ Codeforces Rank Color Helper ═══ */
    function cfRankColor(rank) {
        if (!rank) return "#808080";
        var r = rank.toLowerCase();
        if (r.includes("legendary") || r.includes("international grandmaster") || r.includes("grandmaster")) return "#ff0000";
        if (r.includes("international master") || r.includes("master")) return "#ff8c00";
        if (r.includes("candidate")) return "#aa00aa";
        if (r.includes("expert")) return "#0000ff";
        if (r.includes("specialist")) return "#03a89e";
        if (r.includes("pupil")) return "#008000";
        return "#808080";
    }

    /* ═══════════════════════════════════════
       LEADERBOARD HELPERS
       ═══════════════════════════════════════ */

    /** Render Codeforces leaderboard table from user array */
    function renderCFLeaderboard(users) {
        return '<div style="overflow-x:auto"><table class="lb-table"><thead><tr><th>#</th><th>Coder</th><th>Country</th><th>Rating</th><th>Max</th><th>Rank</th></tr></thead><tbody>' +
            users.map(function (u, i) {
                var color = cfRankColor(u.rank);
                var avatar = u.avatar ? (u.avatar.startsWith("//") ? ("https:" + u.avatar) : u.avatar) : "";
                return '<tr><td class="lb-num' + (i === 0 ? " g" : i < 3 ? " s" : "") + '">' + (i + 1) +
                    '</td><td class="lb-handle"><img src="' + sanitize(avatar) + '" onerror="this.style.display=\'none\'" alt="" loading="lazy"><span style="color:' + color + '">' + sanitize(u.handle) +
                    '</span></td><td style="color:var(--t3);font-size:.8rem">' + sanitize(u.country || "\u2014") +
                    '</td><td style="color:' + color + ';font-weight:800">' + (u.rating || 0) +
                    '</td><td style="color:var(--t3)">' + (u.maxRating || 0) +
                    '</td><td><span class="lb-rank-tag" style="color:' + color + ';background:' + color + '1a">' + sanitize(u.rank || "unrated") + '</span></td></tr>';
            }).join("") + '</tbody></table></div>';
    }
    window._renderCFLB = renderCFLeaderboard;

    var CF_TOP_HANDLES = "ecnerwala;tourist;jiangly;Benq;ksun48;Petr;maroonrk;Um_nik;jqdai0815;Radewoosh;heno239;orzdevinwang;244mhq;hos.lyric;scott_wu;Errichto;mnbvmar;rainboy;neal;Stonefeang;TLEwpdus;rng_58;Geothermal;adamant;ko_osaga";

    /** Fetch CF leaderboard (cached 1hr) */
    async function getCFLeaderboard() {
        try {
            var raw = localStorage.getItem("v5_cflb");
            if (raw) { var obj = JSON.parse(raw); if (Date.now() - obj.t < 3600000) return obj.d; }
        } catch (e) {}
        var resp = await fetch("/api/cf?handles=" + encodeURIComponent(CF_TOP_HANDLES));
        var json = await resp.json();
        if (!json || json.status !== "OK") throw new Error("fail");
        var users = json.result.sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); });
        try { localStorage.setItem("v5_cflb", JSON.stringify({ d: users, t: Date.now() })); } catch (e) {}
        return users;
    }
    window._getCFLB = getCFLeaderboard;

    var LC_NOTABLE_HANDLES = ["neal", "lee215", "votrubac", "DBabichev", "StefanPochmann", "uwi", "Errichto", "tourist"];

    /** Fetch LC leaderboard (cached 1hr) */
    async function getLCLeaderboard() {
        try {
            var raw = localStorage.getItem("v5_lclb");
            if (raw) { var obj = JSON.parse(raw); if (Date.now() - obj.t < 3600000) return obj.d; }
        } catch (e) {}
        var results = await Promise.allSettled(LC_NOTABLE_HANDLES.map(function (handle) {
            return fetch("/api/lc?u=" + encodeURIComponent(handle)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
        }));
        var users = results.map(function (r, i) {
            if (r.status === "fulfilled" && r.value && !r.value.error) {
                var d = r.value;
                return { user: d.user || LC_NOTABLE_HANDLES[i], solved: d.solved || 0, easy: d.easy || 0, med: d.med || 0, hard: d.hard || 0, ranking: d.ranking || 0 };
            }
            return null;
        }).filter(Boolean).sort(function (a, b) { return b.solved - a.solved; });
        if (users.length) try { localStorage.setItem("v5_lclb", JSON.stringify({ d: users, t: Date.now() })); } catch (e) {}
        return users;
    }

    /** Render LC leaderboard table */
    function renderLCLeaderboard(users) {
        return '<div style="overflow-x:auto"><table class="lb-table"><thead><tr><th>#</th><th>Coder</th><th>Solved</th><th>Easy</th><th>Medium</th><th>Hard</th></tr></thead><tbody>' +
            users.map(function (u, i) {
                return '<tr><td class="lb-num' + (i === 0 ? " g" : i < 3 ? " s" : "") + '">' + (i + 1) +
                    '</td><td class="lb-handle"><span style="color:var(--lc);font-weight:700">' + sanitize(u.user) +
                    '</span></td><td style="font-weight:800">' + u.solved +
                    '</td><td style="color:var(--easy)">' + u.easy +
                    '</td><td style="color:var(--med)">' + u.med +
                    '</td><td style="color:var(--hard)">' + u.hard + '</td></tr>';
            }).join("") + '</tbody></table></div>';
    }
    window._renderLCLB = renderLCLeaderboard;

    var HR_NOTABLE_HANDLES = ["gennady", "uwi", "tmwilliamlin168", "ecnerwala"];

    /** Fetch HR leaderboard (cached 1hr) */
    async function getHRLeaderboard() {
        try {
            var raw = localStorage.getItem("v5_hrlb");
            if (raw) { var obj = JSON.parse(raw); if (Date.now() - obj.t < 3600000) return obj.d; }
        } catch (e) {}
        var results = await Promise.allSettled(HR_NOTABLE_HANDLES.map(function (handle) {
            return fetch("/api/hr?u=" + encodeURIComponent(handle)).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
                if (!d) return null;
                var tracks = d.scores.filter(function (t) { return t.practice && t.practice.score > 0; });
                var topScore = tracks.length ? Math.max.apply(null, tracks.map(function (t) { return t.practice.score; })) : 0;
                return { user: handle, tracks: tracks.length, topScore: Math.round(topScore), badges: d.badges.length };
            }).catch(function () { return null; });
        }));
        var users = results.map(function (r) { return r.status === "fulfilled" ? r.value : null; }).filter(Boolean).sort(function (a, b) { return b.topScore - a.topScore; });
        if (users.length) try { localStorage.setItem("v5_hrlb", JSON.stringify({ d: users, t: Date.now() })); } catch (e) {}
        return users;
    }

    /** Render HR leaderboard table */
    function renderHRLeaderboard(users) {
        return '<div style="overflow-x:auto"><table class="lb-table"><thead><tr><th>#</th><th>Coder</th><th>Tracks</th><th>Top Score</th><th>Badges</th></tr></thead><tbody>' +
            users.map(function (u, i) {
                return '<tr><td class="lb-num' + (i === 0 ? " g" : i < 3 ? " s" : "") + '">' + (i + 1) +
                    '</td><td class="lb-handle"><span style="color:var(--accent);font-weight:700">' + sanitize(u.user) +
                    '</span></td><td style="font-weight:700">' + u.tracks +
                    '</td><td style="color:var(--lc);font-weight:800">' + u.topScore +
                    '</td><td>' + u.badges + '</td></tr>';
            }).join("") + '</tbody></table></div>';
    }

    /** Generic leaderboard load-and-render helper */
    function loadLeaderboard(elementId, fetchFn, renderFn) {
        fetchFn().then(function (users) {
            var container = el(elementId);
            if (container) container.innerHTML = users.length ? renderFn(users) : '<p style="color:var(--t3);text-align:center;padding:16px">Could not load leaderboard.</p>';
        }).catch(function () {
            var container = el(elementId);
            if (container) container.innerHTML = '<p style="color:var(--t3);text-align:center;padding:16px">Could not load leaderboard.</p>';
        });
    }

    /** Leaderboard loading spinner HTML */
    var LEADERBOARD_SPINNER = '<div class="lb-loading"><div class="spinner-ring" style="border-top-color:var(--accent);border-color:var(--s3);width:22px;height:22px"></div><span>Fetching real stats...</span></div>';

    /** Comparison table row builder */
    function compareRow(label, val1, val2, isNumeric) {
        var cls1 = "", cls2 = "";
        if (isNumeric && typeof val1 === "number" && typeof val2 === "number") {
            cls1 = val1 > val2 ? "better" : val1 < val2 ? "worse" : "";
            cls2 = val2 > val1 ? "better" : val2 < val1 ? "worse" : "";
        }
        return "<tr><td>" + sanitize(String(label)) + "</td><td class=" + cls1 + ">" + sanitize(String(val1)) + "</td><td class=" + cls2 + ">" + sanitize(String(val2)) + "</td></tr>";
    }

    /* ═══════════════════════════════════════
       LEETCODE — /api/lc
       ═══════════════════════════════════════ */

    /** Fetch LeetCode user data */
    async function fetchLeetCode(username, signal) {
        var opts = {};
        if (signal) opts.signal = signal;
        var resp = await fetch("/api/lc?u=" + encodeURIComponent(username), opts);
        var json = await resp.json();
        if (resp.status === 404 || json.error === "not_found") throw new Error("not_found");
        if (!resp.ok) throw new Error("api_error");
        return json;
    }

    /** Render LeetCode stats */
    function showLeetCode(data) {
        currentData.lc = data;
        var ranking = data.ranking || 0;
        var solved = data.solved || 0;
        var totalQuestions = data.tQ || 0;
        if (!data.user && data.username) data.user = data.username;

        var tier = ranking && ranking < TOTAL_LC_USERS ? (function (pct) {
            return pct <= 1 ? "Top 1%" : pct <= 5 ? "Top 5%" : pct <= 10 ? "Top 10%" : pct <= 25 ? "Top 25%" : "Top " + Math.round(pct) + "%";
        })(ranking / TOTAL_LC_USERS * 100) : null;

        var username = sanitize(data.user || userInput.value.trim());
        var avatarSrc = data.avatar ? sanitize(data.avatar) : "";

        var html = '<div class="profile-card"><div class="avatar-wrap">' +
            (avatarSrc ? '<img class="avatar loaded" src="' + avatarSrc + '" onerror="this.style.display=\'none\'" alt="' + username + ' avatar" loading="lazy">' : '') +
            '<div class="avatar-fb" ' + (avatarSrc ? 'style="display:none"' : '') + '>' + svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>') +
            '</div></div><div class="pinfo"><div class="pname">' + username + '</div><div class="pchips">' +
            '<span class="chip" style="color:var(--lc);background:rgba(255,161,22,.1)">' + svgIcon('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>') + ' Rank ' + (ranking && ranking < TOTAL_LC_USERS ? formatNumber(ranking) : "\u2014") + '</span>' +
            (tier ? '<span class="chip" style="color:var(--easy);background:rgba(0,184,163,.1)">' + tier + '</span>' : '') +
            '</div></div><div class="ptotal"><div class="ptotal-val" id="lc-sv">0</div><div class="ptotal-lbl">Solved</div></div></div>';

        var barPct = totalQuestions > 0 ? (solved / totalQuestions * 100).toFixed(1) : 0;
        html += '<div style="margin-bottom:20px"><div class="total-bar"><div class="total-bar-fill" style="width:' + barPct + '%;background:linear-gradient(90deg,var(--easy),var(--lc))"></div></div><div class="bar-label">' + solved + ' / ' + totalQuestions + ' total problems</div></div>';

        html += '<div class="ring-grid">';
        [{ label: "Easy", color: "var(--easy)", solved: data.easy || 0, total: data.tE || 0 },
         { label: "Medium", color: "var(--med)", solved: data.med || 0, total: data.tM || 0 },
         { label: "Hard", color: "var(--hard)", solved: data.hard || 0, total: data.tH || 0 }
        ].forEach(function (ring) {
            var offset = RING_CIRCUMFERENCE * (1 - (ring.total > 0 ? ring.solved / ring.total : 0));
            html += '<div class="ring-card"><div class="ring-wrap"><svg class="ring-svg" viewBox="0 0 120 120" role="img" aria-label="' + ring.label + ': ' + ring.solved + ' of ' + ring.total + ' solved"><circle class="ring-track" cx="60" cy="60" r="48"/><circle class="ring-fill" cx="60" cy="60" r="48" stroke="' + ring.color + '" style="color:' + ring.color + ';stroke-dasharray:' + RING_CIRCUMFERENCE + ';stroke-dashoffset:' + offset + '"/></svg><div class="ring-center"><span class="ring-num">' + ring.solved + '</span><span class="ring-sub">/ ' + ring.total + '</span></div></div><span class="diff-label" style="color:' + ring.color + '">' + ring.label + '</span><span class="diff-pct">' + percent(ring.solved, ring.total) + '</span></div>';
        });
        html += '</div>';

        // World Ranking section
        html += '<div class="section-card"><div class="section-header">' + svgIcon('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>') + '<h3>World Ranking</h3><span class="sub-info">~4.5M LeetCode users</span></div>';
        var gaugePct = ranking && ranking < TOTAL_LC_USERS ? Math.min(ranking / TOTAL_LC_USERS * 100, 100) : 100;
        html += '<div class="gauge-bar"><div class="gauge-fill" style="width:' + gaugePct + '%;background:linear-gradient(90deg,var(--easy),var(--lc),var(--hard))"></div><div class="gauge-dot" style="left:' + gaugePct + '%;border-color:var(--lc)"><div class="gauge-lbl" style="color:var(--lc);border-color:rgba(255,161,22,.3)">' + (ranking && ranking < TOTAL_LC_USERS ? "#" + formatNumber(ranking) : "Unranked") + '</div></div></div>';
        html += '<div class="gauge-marks"><span>Top 1%</span><span>Top 10%</span><span>Top 25%</span><span>Top 50%</span><span>100%</span></div>';

        html += '<div class="detail-grid">';
        [{ v: ranking && ranking < TOTAL_LC_USERS ? "#" + formatNumber(ranking) : "\u2014", l: "Global Rank" },
         { v: tier || "\u2014", l: "Percentile" }, { v: formatNumber(TOTAL_LC_USERS), l: "Total Users" },
         { v: percent(solved, totalQuestions), l: "Completion" },
         { v: data.accept != null ? data.accept + "%" : "\u2014", l: "Acceptance Rate" },
         { v: formatNumber(solved), l: "Problems Solved" }
        ].forEach(function (item) { html += '<div class="detail-item"><div class="detail-val">' + item.v + '</div><div class="detail-lbl">' + item.l + '</div></div>'; });
        html += '</div></div>';

        // Stat cards
        html += '<div class="stat-grid">';
        [{ l: "Acceptance", v: data.accept != null ? data.accept + "%" : "\u2014", bg: "rgba(168,85,247,.13)", ic: "#a855f7" },
         { l: "Ranking", v: ranking && ranking < TOTAL_LC_USERS ? "#" + formatNumber(ranking) : "\u2014", bg: "rgba(102,126,234,.13)", ic: "#667eea" },
         { l: "Total Qs", v: formatNumber(totalQuestions), bg: "rgba(255,161,22,.13)", ic: "#ffa116" },
         { l: "Easy", v: (data.easy || 0) + "/" + (data.tE || 0), bg: "rgba(0,184,163,.08)", ic: "#00b8a3" },
         { l: "Medium", v: (data.med || 0) + "/" + (data.tM || 0), bg: "rgba(255,192,30,.08)", ic: "#ffc01e" },
         { l: "Hard", v: (data.hard || 0) + "/" + (data.tH || 0), bg: "rgba(239,71,67,.08)", ic: "#ef4743" }
        ].forEach(function (card) {
            html += '<div class="stat-card"><div class="stat-ic" style="background:' + card.bg + ';color:' + card.ic + '">' + svgIcon('<circle cx="12" cy="12" r="10"/>') + '</div><div><div class="stat-val">' + card.v + '</div><div class="stat-lbl">' + card.l + '</div></div></div>';
        });
        html += '</div>';

        // Activity graph
        if (data.calendar) html += buildHeatmap(lcCalendarMap(data.calendar));

        // Compare
        html += '<div class="section-card"><div class="section-header">' + svgIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>') + '<h3>Compare with Another Coder</h3></div><div class="cmp-input"><label for="lc-cmp-in" class="sr-only">Second LeetCode username</label><input type="text" id="lc-cmp-in" placeholder="Enter second LeetCode username..." maxlength="40"><button class="search-btn cmp-btn" id="lc-cmp-btn" type="button">Compare</button></div><div id="lc-cmp-out"></div></div>';

        // Leaderboard
        html += '<div class="section-card"><div class="section-header">' + svgIcon('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>') + '<h3>LeetCode Top Coders</h3><span class="lb-live">LIVE DATA</span></div><div id="lc-lb-content">' + LEADERBOARD_SPINNER + '</div></div>';

        statsEl.innerHTML = html;
        statsEl.classList.remove("hidden");
        animateCount(el("lc-sv"), solved);
        loadLeaderboard("lc-lb-content", getLCLeaderboard, renderLCLeaderboard);

        // Compare handler
        el("lc-cmp-btn").addEventListener("click", async function () {
            var btn = this;
            var user2 = el("lc-cmp-in").value.trim();
            if (!user2 || btn.disabled) return;
            btn.disabled = true; btn.textContent = "Loading...";
            try {
                var cached = getCache("leetcode", user2);
                var data2 = cached || await fetchLeetCode(user2);
                if (!cached) setCache("leetcode", user2, data2);
                var A = currentData.lc, B = data2;
                var name1 = sanitize(A.user || "User 1"), name2 = sanitize(B.user || user2);
                el("lc-cmp-out").innerHTML = '<table class="cmp-table"><thead><tr><th>Metric</th><th>' + name1 + '</th><th>' + name2 + '</th></tr></thead><tbody>' +
                    compareRow("Total Solved", A.solved || 0, B.solved || 0, true) +
                    compareRow("Easy", A.easy || 0, B.easy || 0, true) +
                    compareRow("Medium", A.med || 0, B.med || 0, true) +
                    compareRow("Hard", A.hard || 0, B.hard || 0, true) +
                    compareRow("Acceptance", A.accept != null ? A.accept + "%" : "\u2014", B.accept != null ? B.accept + "%" : "\u2014", false) +
                    compareRow("Ranking", A.ranking && A.ranking < TOTAL_LC_USERS ? "#" + formatNumber(A.ranking) : "\u2014", B.ranking && B.ranking < TOTAL_LC_USERS ? "#" + formatNumber(B.ranking) : "\u2014", false) +
                    "</tbody></table>";
            } catch (e) {
                el("lc-cmp-out").innerHTML = '<p style="color:var(--hard);font-size:.85rem;margin-top:12px">User "' + sanitize(user2) + '" not found.</p>';
            } finally { btn.disabled = false; btn.textContent = "Compare"; }
        });
    }

    /* ═══════════════════════════════════════
       CODEFORCES — /api/cf
       ═══════════════════════════════════════ */

    /** Fetch Codeforces user data */
    async function fetchCodeforces(username, signal) {
        var opts = {};
        if (signal) opts.signal = signal;
        var resp = await fetch("/api/cf?handle=" + encodeURIComponent(username), opts);
        var json = await resp.json();
        if (resp.status === 404 || json.error === "not_found") throw new Error("not_found");
        if (!resp.ok) throw new Error("api_error");
        return json;
    }

    /** Render Codeforces stats */
    function showCodeforces(data) {
        currentData.cf = data;
        var user = data.user, contests = data.contests, submissions = data.subs;
        var rankColor = cfRankColor(user.rank);
        var fullName = ((user.firstName || "") + " " + (user.lastName || "")).trim();
        var avatar = user.titlePhoto || user.avatar;
        if (avatar && avatar.startsWith("//")) avatar = "https:" + avatar;

        var solvedMap = {}, tagMap = {}, langMap = {};
        submissions.forEach(function (sub) {
            if (sub.verdict === "OK") {
                var key = sub.problem.contestId + "_" + sub.problem.index;
                if (!solvedMap[key]) {
                    solvedMap[key] = { id: sub.problem.contestId + sub.problem.index, nm: sub.problem.name, tags: sub.problem.tags || [] };
                    (sub.problem.tags || []).forEach(function (tag) { tagMap[tag] = (tagMap[tag] || 0) + 1; });
                }
            }
            langMap[sub.programmingLanguage] = (langMap[sub.programmingLanguage] || 0) + 1;
        });
        var solvedArr = Object.values(solvedMap);
        var tagArr = Object.entries(tagMap).sort(function (a, b) { return b[1] - a[1]; });
        var langArr = Object.entries(langMap).sort(function (a, b) { return b[1] - a[1]; });
        var maxLang = langArr[0] ? langArr[0][1] : 1;

        var avatarSrc = avatar ? sanitize(avatar) : "";
        var displayName = fullName ? sanitize(fullName) + " (" + sanitize(user.handle) + ")" : sanitize(user.handle);

        var html = '<div class="profile-card"><div class="avatar-wrap">' +
            (avatarSrc ? '<img class="avatar loaded" src="' + avatarSrc + '" onerror="this.style.display=\'none\'" alt="' + sanitize(user.handle) + ' avatar" loading="lazy">' : '') +
            '<div class="avatar-fb"' + (avatarSrc ? ' style="display:none"' : '') + '>' + svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>') +
            '</div></div><div class="pinfo"><div class="pname">' + displayName + '</div><div class="pchips">' +
            '<span class="chip" style="color:' + rankColor + ';background:' + rankColor + '1a">' + sanitize(user.rank || "Unrated") + '</span>' +
            (user.organization ? '<span class="chip" style="color:var(--lc);background:rgba(255,161,22,.1)">' + sanitize(user.organization) + '</span>' : '') +
            (user.country ? '<span class="chip" style="color:var(--t2);background:var(--s3)">' + sanitize(user.country) + '</span>' : '') +
            '</div></div><div class="ptotal"><div class="ptotal-val" id="cf-rt">0</div><div class="ptotal-lbl">Rating</div></div></div>';

        var gaugePct = Math.min((user.rating || 0) / 4000 * 100, 100);
        html += '<div class="section-card"><div class="section-header">' + svgIcon('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>') + '<h3>World Ranking</h3><span class="sub-info">~40K active rated users</span></div>';
        html += '<div class="gauge-bar"><div class="gauge-fill" style="width:' + gaugePct + '%;background:linear-gradient(90deg,#808080,#008000,#03a89e,#0000ff,#aa00aa,#ff8c00,#ff0000)"></div><div class="gauge-dot" style="left:' + gaugePct + '%;border-color:' + rankColor + '"><div class="gauge-lbl" style="color:' + rankColor + ';border-color:' + rankColor + '44">' + (user.rating || "Unrated") + '</div></div></div>';
        html += '<div class="gauge-marks"><span>Newbie</span><span>Specialist</span><span>Expert</span><span>Master</span><span>GM</span></div>';

        html += '<div class="detail-grid">';
        [{ v: user.rating || "\u2014", l: "Rating" }, { v: user.maxRating || "\u2014", l: "Max Rating" },
         { v: user.maxRank || "\u2014", l: "Max Rank" }, { v: contests.length, l: "Contests" },
         { v: user.contribution || 0, l: "Contribution" }, { v: formatNumber(user.friendOfCount || 0), l: "Followers" },
         { v: solvedArr.length, l: "Problems Solved" }, { v: tagArr.length, l: "Topics Covered" }
        ].forEach(function (item) { html += '<div class="detail-item"><div class="detail-val">' + sanitize(String(item.v)) + '</div><div class="detail-lbl">' + item.l + '</div></div>'; });
        html += '</div></div>';

        html += '<div class="stat-grid">';
        [{ l: "Rating", v: user.rating || 0, bg: "rgba(24,144,255,.13)", ic: "#1890ff" },
         { l: "Max Rating", v: user.maxRating || 0, bg: "rgba(255,140,0,.13)", ic: "#ff8c00" },
         { l: "Contests", v: contests.length, bg: "rgba(0,184,163,.13)", ic: "#00b8a3" },
         { l: "Solved", v: solvedArr.length, bg: "rgba(168,85,247,.13)", ic: "#a855f7" },
         { l: "Followers", v: formatNumber(user.friendOfCount || 0), bg: "rgba(102,126,234,.13)", ic: "#667eea" },
         { l: "Contribution", v: user.contribution || 0, bg: rankColor + "1a", ic: rankColor }
        ].forEach(function (card) {
            html += '<div class="stat-card"><div class="stat-ic" style="background:' + card.bg + ';color:' + card.ic + '">' + svgIcon('<circle cx="12" cy="12" r="10"/>') + '</div><div><div class="stat-val">' + card.v + '</div><div class="stat-lbl">' + card.l + '</div></div></div>';
        });
        html += '</div>';

        if (tagArr.length) {
            html += '<div class="section-card"><div class="section-header">' + svgIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>') + '<h3>Problem Topics</h3><span class="sub-info">' + solvedArr.length + ' solved</span></div><div class="tags-wrap">' +
                tagArr.slice(0, 25).map(function (t) { return '<div class="tag"><b>' + t[1] + '</b>' + sanitize(t[0]) + '</div>'; }).join("") + '</div></div>';
        }

        if (solvedArr.length) {
            html += '<div class="section-card"><div class="section-header">' + svgIcon('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>') + '<h3>Solved Problems</h3><span class="sub-info">Showing ' + Math.min(solvedArr.length, 60) + ' of ' + solvedArr.length + '</span></div><div class="prob-scroll">' +
                solvedArr.slice(0, 60).map(function (p) {
                    return '<div class="prob-row"><span class="prob-id">' + sanitize(p.id) + '</span><span class="prob-nm">' + sanitize(p.nm) + '</span><div class="prob-tags">' + p.tags.slice(0, 3).map(function (t) { return '<span class="prob-tag">' + sanitize(t) + '</span>'; }).join("") + '</div></div>';
                }).join("") + '</div></div>';
        }

        if (langArr.length) {
            html += '<div class="section-card"><div class="section-header">' + svgIcon('<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>') + '<h3>Languages Used</h3></div><div class="lang-list">' +
                langArr.slice(0, 6).map(function (lang) {
                    return '<div class="lang-item"><span class="lang-nm">' + sanitize(lang[0].split("(")[0].trim()) + '</span><div class="lang-bar"><div class="lang-bar-fill" style="width:' + Math.round(lang[1] / maxLang * 100) + '%"></div></div><span class="lang-ct">' + lang[1] + '</span></div>';
                }).join("") + '</div></div>';
        }

        if (submissions.length) {
            html += '<div class="section-card"><div class="section-header">' + svgIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>') + '<h3>Recent Submissions</h3></div><div class="sub-list">' +
                submissions.slice(0, 10).map(function (sub) {
                    var verdictClass = sub.verdict === "OK" ? "ac" : sub.verdict === "WRONG_ANSWER" ? "wa" : sub.verdict === "TIME_LIMIT_EXCEEDED" ? "tle" : "oth";
                    var verdictText = sub.verdict === "OK" ? "Accepted" : sub.verdict === "WRONG_ANSWER" ? "WA" : sub.verdict === "TIME_LIMIT_EXCEEDED" ? "TLE" : (sub.verdict || "?").replace(/_/g, " ");
                    return '<div class="sub-item"><span class="sub-prob">' + sanitize(sub.problem.index + ". " + sub.problem.name) + '</span><span class="sub-v ' + verdictClass + '">' + sanitize(verdictText) + '</span><span class="sub-lang">' + sanitize(sub.programmingLanguage) + '</span></div>';
                }).join("") + '</div></div>';
        }

        // Activity graph
        if (submissions.length) html += buildHeatmap(cfSubsMap(submissions));

        // Compare
        html += '<div class="section-card"><div class="section-header">' + svgIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>') + '<h3>Compare with Another Coder</h3></div><div class="cmp-input"><label for="cf-cmp-in" class="sr-only">Second Codeforces handle</label><input type="text" id="cf-cmp-in" placeholder="Enter second Codeforces handle..." maxlength="40"><button class="search-btn cmp-btn" id="cf-cmp-btn" type="button">Compare</button></div><div id="cf-cmp-out"></div></div>';

        // Leaderboard
        html += '<div class="section-card"><div class="section-header">' + svgIcon('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>') + '<h3>Codeforces World Leaderboard</h3><span class="lb-live">LIVE DATA</span></div><div id="cf-lb-content">' + LEADERBOARD_SPINNER + '</div></div>';

        statsEl.innerHTML = html;
        statsEl.classList.remove("hidden");
        animateCount(el("cf-rt"), user.rating || 0);
        loadLeaderboard("cf-lb-content", getCFLeaderboard, renderCFLeaderboard);

        // Compare handler
        el("cf-cmp-btn").addEventListener("click", async function () {
            var btn = this;
            var user2 = el("cf-cmp-in").value.trim();
            if (!user2 || btn.disabled) return;
            btn.disabled = true; btn.textContent = "Loading...";
            try {
                var cached = getCache("codeforces", user2);
                var data2 = cached || await fetchCodeforces(user2);
                if (!cached) setCache("codeforces", user2, data2);
                var A = currentData.cf, B = data2;
                var solved2 = {};
                B.subs.forEach(function (s) { if (s.verdict === "OK") solved2[s.problem.contestId + "_" + s.problem.index] = 1; });
                el("cf-cmp-out").innerHTML = '<table class="cmp-table"><thead><tr><th>Metric</th><th>' + sanitize(A.user.handle) + '</th><th>' + sanitize(B.user.handle) + '</th></tr></thead><tbody>' +
                    compareRow("Rating", A.user.rating || 0, B.user.rating || 0, true) +
                    compareRow("Max Rating", A.user.maxRating || 0, B.user.maxRating || 0, true) +
                    compareRow("Contests", A.contests.length, B.contests.length, true) +
                    compareRow("Problems Solved", solvedArr.length, Object.keys(solved2).length, true) +
                    compareRow("Contribution", A.user.contribution || 0, B.user.contribution || 0, true) +
                    compareRow("Followers", A.user.friendOfCount || 0, B.user.friendOfCount || 0, true) +
                    compareRow("Rank", A.user.rank || "Unrated", B.user.rank || "Unrated", false) +
                    "</tbody></table>";
            } catch (e) {
                el("cf-cmp-out").innerHTML = '<p style="color:var(--hard);font-size:.85rem;margin-top:12px">User "' + sanitize(user2) + '" not found.</p>';
            } finally { btn.disabled = false; btn.textContent = "Compare"; }
        });
    }

    /* ═══════════════════════════════════════
       HACKERRANK — /api/hr
       ═══════════════════════════════════════ */

    /** Fetch HackerRank user data */
    async function fetchHackerRank(username, signal) {
        var opts = {};
        if (signal) opts.signal = signal;
        var resp = await fetch("/api/hr?u=" + encodeURIComponent(username), opts);
        var json = await resp.json();
        if (resp.status === 404 || json.error === "not_found") throw new Error("not_found");
        if (!resp.ok) throw new Error("api_error");
        return json;
    }

    /** Render HackerRank stats */
    function showHackerRank(data, username) {
        currentData.hr = data;
        currentData.hrU = username;

        var tracks = data.scores.filter(function (t) {
            return (t.practice && t.practice.score > 0) || (t.contest && typeof t.contest.score === "number" && t.contest.score > 0);
        }).sort(function (a, b) {
            return Math.max(b.practice ? b.practice.score : 0, b.contest && typeof b.contest.score === "number" ? b.contest.score : 0) -
                   Math.max(a.practice ? a.practice.score : 0, a.contest && typeof a.contest.score === "number" ? a.contest.score : 0);
        });
        var badges = data.badges;
        var totalGold = 0, totalSilver = 0, totalBronze = 0;
        data.scores.forEach(function (t) {
            if (t.contest && t.contest.medals) {
                totalGold += t.contest.medals.gold || 0;
                totalSilver += t.contest.medals.silver || 0;
                totalBronze += t.contest.medals.bronze || 0;
            }
        });
        var maxScore = tracks.length ? Math.max.apply(null, tracks.map(function (t) {
            return Math.max(t.practice ? t.practice.score : 0, t.contest && typeof t.contest.score === "number" ? t.contest.score : 0);
        })) : 100;

        var safeUsername = sanitize(username);
        var html = '<div class="profile-card"><div class="avatar-wrap"><div class="avatar-fb">' + svgIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>') + '</div></div><div class="pinfo"><div class="pname">' + safeUsername + '</div><div class="pchips">' +
            '<span class="chip" style="color:var(--easy);background:rgba(0,184,163,.1)">' + tracks.length + ' Active Tracks</span>' +
            '<span class="chip" style="color:var(--lc);background:rgba(255,161,22,.1)">' +
            (totalGold + totalSilver + totalBronze > 0 ? '<span class="medal medal-g">' + totalGold + 'G</span> <span class="medal medal-s">' + totalSilver + 'S</span> <span class="medal medal-b">' + totalBronze + 'B</span>' : 'No medals') +
            '</span></div></div><div class="ptotal"><div class="ptotal-val">' + badges.length + '</div><div class="ptotal-lbl">Badges</div></div></div>';

        if (tracks.length) {
            html += '<div class="section-card"><div class="section-header">' + svgIcon('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>') + '<h3>Track Scores & World Rankings</h3></div><div class="track-list">' +
                tracks.map(function (track) {
                    var practiceScore = track.practice ? track.practice.score : 0;
                    var contestScore = track.contest && typeof track.contest.score === "number" ? track.contest.score : 0;
                    var score = Math.max(practiceScore, contestScore);
                    var practiceRank = track.practice ? track.practice.rank : null;
                    var contestRank = track.contest ? track.contest.rank : null;
                    var medals = track.contest && track.contest.medals ? track.contest.medals : {};
                    var medalHtml = "";
                    if (medals.gold) medalHtml += '<span class="medal medal-g">' + medals.gold + 'G</span>';
                    if (medals.silver) medalHtml += '<span class="medal medal-s">' + medals.silver + 'S</span>';
                    if (medals.bronze) medalHtml += '<span class="medal medal-b">' + medals.bronze + 'B</span>';
                    return '<div class="track-item"><span class="track-nm">' + sanitize(track.name) + '</span><div class="track-bar-wrap"><div class="track-bar"><div class="track-bar-fill" style="width:' + Math.min(score / maxScore * 100, 100) + '%"></div></div><div class="track-meta">' +
                        (practiceRank && practiceRank !== "N/A" ? '<span>World #' + formatNumber(practiceRank) + '</span>' : '') +
                        (contestRank && contestRank !== "N/A" && contestRank !== practiceRank ? '<span>Contest #' + contestRank + '</span>' : '') +
                        (track.contest && track.contest.competitions ? '<span>' + track.contest.competitions + ' contests</span>' : '') +
                        medalHtml + '</div></div><span class="track-score">' + score.toFixed(0) + '</span></div>';
                }).join("") + '</div></div>';
        }

        if (badges.length) {
            html += '<div class="section-card"><div class="section-header">' + svgIcon('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>') + '<h3>Badges & Achievements</h3></div><div class="badge-grid">' +
                badges.map(function (badge) {
                    var stars = "";
                    for (var i = 0; i < (badge.total_stars || 0); i++) stars += '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
                    return '<div class="badge-card"><div class="badge-stars">' + stars + '</div><div><div class="badge-nm">' + sanitize(badge.badge_name) + '</div><div class="badge-det">' + badge.solved + '/' + badge.total_challenges + ' solved</div></div></div>';
                }).join("") + '</div></div>';
        }

        // Activity graph
        if (data.recent && data.recent.length) html += buildHeatmap(hrRecentMap(data.recent));

        // Compare
        html += '<div class="section-card"><div class="section-header">' + svgIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>') + '<h3>Compare with Another Coder</h3></div><div class="cmp-input"><label for="hr-cmp-in" class="sr-only">Second HackerRank username</label><input type="text" id="hr-cmp-in" placeholder="Enter second HackerRank username..." maxlength="40"><button class="search-btn cmp-btn" id="hr-cmp-btn" type="button">Compare</button></div><div id="hr-cmp-out"></div></div>';

        // Leaderboard
        html += '<div class="section-card"><div class="section-header">' + svgIcon('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>') + '<h3>HackerRank Top Coders</h3><span class="lb-live">LIVE DATA</span></div><div id="hr-lb-content">' + LEADERBOARD_SPINNER + '</div></div>';

        statsEl.innerHTML = html;
        statsEl.classList.remove("hidden");
        loadLeaderboard("hr-lb-content", getHRLeaderboard, renderHRLeaderboard);

        // Compare handler
        el("hr-cmp-btn").addEventListener("click", async function () {
            var btn = this;
            var user2 = el("hr-cmp-in").value.trim();
            if (!user2 || btn.disabled) return;
            btn.disabled = true; btn.textContent = "Loading...";
            try {
                var cached = getCache("hackerrank", user2);
                var data2 = cached || await fetchHackerRank(user2);
                if (!cached) setCache("hackerrank", user2, data2);
                var tracks2count = data2.scores.filter(function (t) { return t.practice && t.practice.score > 0; }).length;
                var topScore2 = data2.scores.length ? Math.max.apply(null, data2.scores.filter(function (t) { return t.practice && t.practice.score > 0; }).map(function (t) { return t.practice.score; })) : 0;
                el("hr-cmp-out").innerHTML = '<table class="cmp-table"><thead><tr><th>Metric</th><th>' + safeUsername + '</th><th>' + sanitize(user2) + '</th></tr></thead><tbody>' +
                    compareRow("Active Tracks", tracks.length, tracks2count, true) +
                    compareRow("Badges", badges.length, data2.badges.length, true) +
                    compareRow("Top Score", +maxScore.toFixed(0), +topScore2.toFixed(0), true) +
                    "</tbody></table>";
            } catch (e) {
                el("hr-cmp-out").innerHTML = '<p style="color:var(--hard);font-size:.85rem;margin-top:12px">User "' + sanitize(user2) + '" not found.</p>';
            } finally { btn.disabled = false; btn.textContent = "Compare"; }
        });
    }

    /* ═══════════════════════════════════════
       MAIN SEARCH
       ═══════════════════════════════════════ */

    /** Execute search for the current platform and username */
    async function doSearch() {
        if (activeController) { activeController.abort(); activeController = null; }

        var username = userInput.value.trim();
        if (!username) { showError("Please enter a username."); return; }
        if (!USERNAME_REGEX.test(username)) { showError("Invalid username."); return; }

        setLoading(true);
        hideError();

        var controller = new AbortController();
        activeController = controller;
        var signal = controller.signal;

        try {
            // 1. Try localStorage cache first (instant)
            var cached = getCache(currentPlatform, username);
            if (cached) {
                if (currentPlatform === "leetcode") showLeetCode(cached);
                else if (currentPlatform === "codeforces") showCodeforces(cached);
                else showHackerRank(cached, username);
                addRecentSearch(username);
                return;
            }

            // 2. Try MongoDB cache (fast, survives browser clear)
            var dbCached = await dbGetStats(currentPlatform, username);
            if (dbCached && !signal.aborted) {
                if (currentPlatform === "leetcode") showLeetCode(dbCached);
                else if (currentPlatform === "codeforces") showCodeforces(dbCached);
                else showHackerRank(dbCached, username);
                setCache(currentPlatform, username, dbCached);
                addRecentSearch(username);
                return;
            }
            if (signal.aborted) return;

            // 3. Fresh fetch from external API
            var data;
            if (currentPlatform === "leetcode") {
                data = await fetchLeetCode(username, signal);
                if (signal.aborted) return;
                showLeetCode(data);
                setCache("leetcode", username, data);
                dbSaveStats("leetcode", username, data);
            } else if (currentPlatform === "codeforces") {
                data = await fetchCodeforces(username, signal);
                if (signal.aborted) return;
                showCodeforces(data);
                setCache("codeforces", username, data);
                dbSaveStats("codeforces", username, data);
            } else {
                data = await fetchHackerRank(username, signal);
                if (signal.aborted) return;
                showHackerRank(data, username);
                setCache("hackerrank", username, data);
                dbSaveStats("hackerrank", username, data);
            }
            addRecentSearch(username);
        } catch (error) {
            if (error.name === "AbortError" || signal.aborted) return;
            var platformName = PLATFORM_NAMES[currentPlatform];
            if (error.message === "not_found") {
                showError('User "' + username + '" not found on ' + platformName + '.', "Check the exact username (case-sensitive). New accounts may take a few hours to appear.");
            } else {
                showError("Could not reach " + platformName + " servers.", "Try again in a moment. The API may be temporarily unavailable.");
            }
        } finally {
            if (!signal.aborted) setLoading(false);
            if (activeController === controller) activeController = null;
        }
    }

    searchBtn.addEventListener("click", doSearch);
    userInput.addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
    userInput.addEventListener("input", hideError);
    renderRecentSearches();

    /* ═══ Activity Heatmap (GitHub-style) ═══ */
    var MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    function dateKey(d) { return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()); }

    /** Build heatmap HTML from { "YYYY-MM-DD": count } map */
    function buildHeatmap(map) {
        if (!map || !Object.keys(map).length) return "";
        var total = 0, days = 0, mx = 0;
        Object.keys(map).forEach(function(k) { var v = map[k]; if (v > 0) { total += v; days++; if (v > mx) mx = v; } });
        if (!days) return "";

        var today = new Date(); today.setHours(0,0,0,0);
        var start = new Date(today); start.setDate(start.getDate() - 364);
        start.setDate(start.getDate() - start.getDay()); // align Sunday

        var q1 = Math.max(1, Math.ceil(mx*0.25)), q2 = Math.max(2, Math.ceil(mx*0.5)), q3 = Math.max(3, Math.ceil(mx*0.75));

        var weeks = "", months = [], lastM = -1, wi = 0;
        var c = new Date(start);
        while (c <= today) {
            var col = "";
            for (var d = 0; d < 7; d++) {
                if (c > today) { col += '<div class="hm"></div>'; }
                else {
                    var k = dateKey(c), v = map[k] || 0;
                    var lv = v === 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4;
                    col += '<div class="hm" data-l="' + lv + '" title="' + v + ' on ' + k + '"></div>';
                }
                if (d === 0 && c.getMonth() !== lastM && c <= today) { months.push({w:wi,m:MN[c.getMonth()]}); lastM = c.getMonth(); }
                c.setDate(c.getDate() + 1);
            }
            weeks += '<div class="heatmap-col">' + col + '</div>';
            wi++;
        }

        // month labels
        var mh = '<div class="heatmap-months">';
        var pw = 0;
        months.forEach(function(m) { mh += '<span style="margin-left:' + ((m.w - pw) * 14) + 'px">' + m.m + '</span>'; pw = m.w; });
        mh += '</div>';

        // streak
        var streak = 0, cur = 0, sc2 = new Date(start);
        while (sc2 <= today) { if (map[dateKey(sc2)]) { cur++; if (cur > streak) streak = cur; } else { cur = 0; } sc2.setDate(sc2.getDate()+1); }

        return '<div class="section-card"><div class="section-header">' +
            svgIcon('<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7" y="7" width="3" height="3"/><rect x="14" y="7" width="3" height="3"/><rect x="7" y="14" width="3" height="3"/><rect x="14" y="14" width="3" height="3"/>') +
            '<h3>Activity Graph</h3><span class="sub-info">Last 52 weeks</span></div>' +
            mh + '<div class="heatmap-wrap"><div class="heatmap-grid">' + weeks + '</div></div>' +
            '<div class="heatmap-footer"><span><strong>' + total + '</strong> submissions &middot; <strong>' + days + '</strong> active days &middot; <strong>' + streak + '</strong> day streak</span>' +
            '<div class="heatmap-legend"><span>Less</span><div class="hm"></div><div class="hm" data-l="1"></div><div class="hm" data-l="2"></div><div class="hm" data-l="3"></div><div class="hm" data-l="4"></div><span>More</span></div>' +
            '</div></div>';
    }

    /** Convert unix-keyed LeetCode calendar to YYYY-MM-DD map */
    function lcCalendarMap(cal) {
        var m = {};
        Object.keys(cal).forEach(function(ts) { var d = new Date(parseInt(ts)*1000); m[dateKey(d)] = (m[dateKey(d)]||0) + cal[ts]; });
        return m;
    }

    /** Convert CF submissions array to YYYY-MM-DD map */
    function cfSubsMap(subs) {
        var m = {};
        subs.forEach(function(s) { var d = new Date(s.creationTimeSeconds*1000); var k = dateKey(d); m[k] = (m[k]||0) + 1; });
        return m;
    }

    /** Convert HR recent_challenges array (ISO created_at) to YYYY-MM-DD map */
    function hrRecentMap(recent) {
        var m = {};
        recent.forEach(function(r) {
            if (!r.created_at) return;
            var d = new Date(r.created_at);
            if (isNaN(d)) return;
            var k = dateKey(d);
            m[k] = (m[k]||0) + 1;
        });
        return m;
    }

    /* ═══ Footer Platform Links ═══ */
    document.querySelectorAll(".footer-link[data-platform]").forEach(function (link) {
        link.addEventListener("click", function (e) {
            e.preventDefault();
            var platform = link.dataset.platform;
            var card = document.querySelector('.platform-card[data-platform="' + platform + '"]');
            if (card && !card.classList.contains("disabled")) card.click();
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
    });

});
