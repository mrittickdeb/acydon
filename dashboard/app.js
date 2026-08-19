// ====================================================================
// INGESTION ENGINE — Dashboard Client
// Vanilla JS — no framework, no build step.
// ====================================================================

(() => {
  'use strict';

  // ── State ──
  const state = {
    jobs: [],
    total: 0,
    page: 0,
    pageSize: 30,
    source: '',
    search: '',
    connected: false,
    lastScrape: null,
    wsReconnectAttempt: 0,
  };

  // ── DOM Refs ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    systemStatus:  $('#system-status'),
    statusLabel:   $('#system-status .status-label'),
    activeSources: $('#active-sources'),
    totalJobs:     $('#total-jobs'),
    lastScrape:    $('#last-scrape'),
    btnScrape:     $('#btn-scrape'),
    searchInput:   $('#search-input'),
    sourceFilter:  $('#source-filter'),
    jobList:       $('#job-list'),
    pagination:    $('#pagination'),
    btnPrev:       $('#btn-prev'),
    btnNext:       $('#btn-next'),
    pageInfo:      $('#page-info'),
    healthCards:   $('#health-cards'),
    runsList:      $('#runs-list'),
    statTotal:     $('#stat-total'),
    stat24h:       $('#stat-24h'),
    statConfidence:$('#stat-confidence'),
    statWs:        $('#stat-ws'),
    logStream:     $('#log-stream'),
    btnClearLog:   $('#btn-clear-log'),
  };

  // ── API Client ──
  const api = {
    base: window.location.origin,

    async get(path) {
      try {
        const res = await fetch(`${this.base}${path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        addLog('error', `API error: ${err.message}`);
        return null;
      }
    },

    async post(path) {
      try {
        const res = await fetch(`${this.base}${path}`, { method: 'POST' });
        return await res.json();
      } catch (err) {
        addLog('error', `API error: ${err.message}`);
        return null;
      }
    }
  };

  // ── WebSocket ──
  let ws = null;

  function connectWS() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      state.connected = true;
      state.wsReconnectAttempt = 0;
      updateSystemStatus('HEALTHY');
      addLog('info', 'WebSocket connected');
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.addEventListener('close', () => {
      state.connected = false;
      updateSystemStatus('DISCONNECTED');
      addLog('warn', 'WebSocket disconnected — reconnecting…');

      // Exponential backoff reconnect
      const delay = Math.min(1000 * Math.pow(2, state.wsReconnectAttempt), 30000);
      state.wsReconnectAttempt++;
      setTimeout(connectWS, delay);
    });

    ws.addEventListener('error', () => {
      // close handler will fire after this
    });
  }

  function handleWSMessage(msg) {
    switch (msg.type) {
      case 'job:new':
        handleNewJob(msg.data.job);
        break;

      case 'scrape:started':
        addLog('info', `Scrape started: ${msg.data.run?.source || 'unknown'}`);
        updateBtnScrape(true);
        break;

      case 'scrape:progress':
        if (msg.data.latestJob) {
          addLog('info', `Found: ${msg.data.latestJob.title} @ ${msg.data.latestJob.company}`);
        }
        break;

      case 'scrape:completed':
        const run = msg.data.run;
        if (run) {
          addLog('info', `Scrape done: ${run.source} — ${run.jobsNew} new, ${run.jobsDuplicate} dupes`);
          state.lastScrape = new Date();
          els.lastScrape.textContent = 'Just now';
        }
        updateBtnScrape(false);
        refreshAll();
        break;

      case 'scrape:failed':
        addLog('error', `Scrape failed: ${msg.data.run?.source} — ${msg.data.run?.errors?.[0] || 'Unknown error'}`);
        updateBtnScrape(false);
        break;

      case 'health:update':
        fetchHealth();
        break;

      case 'log':
        const level = msg.data.level || 'info';
        addLog(level, msg.data.message);
        break;

      case 'connected':
        addLog('info', 'Dashboard connected to engine');
        break;
    }
  }

  // ── Job Handling ──
  function handleNewJob(job) {
    if (!job) return;

    // Add to top of local state
    state.jobs.unshift(job);
    state.total++;

    // Update UI immediately
    els.totalJobs.textContent = formatNumber(state.total);

    // If we're on the first page, prepend the card
    if (state.page === 0) {
      const card = createJobCard(job, true);
      const emptyState = els.jobList.querySelector('.empty-state');
      if (emptyState) emptyState.remove();

      els.jobList.insertBefore(card, els.jobList.firstChild);

      // Remove excess cards if over page size
      const cards = els.jobList.querySelectorAll('.job-card');
      if (cards.length > state.pageSize) {
        cards[cards.length - 1].remove();
      }
    }

    updatePageInfo();
  }

  function createJobCard(job, isNew = false) {
    const card = document.createElement('div');
    card.className = `job-card${isNew ? ' new-job' : ''}`;
    card.dataset.id = job.id;

    const confidenceClass = job.confidence >= 0.7 ? 'confidence-high'
      : job.confidence >= 0.4 ? 'confidence-med' : 'confidence-low';

    const salaryHtml = job.salary
      ? `<span class="job-salary">${formatSalary(job.salary)}</span>`
      : '';

    const tagsHtml = (job.tags || []).slice(0, 4).map(
      tag => `<span class="job-tag">${escapeHtml(tag)}</span>`
    ).join('');

    const sourceClass = `source-${job.source}`;

    card.innerHTML = `
      <div class="job-card-header">
        <div class="job-title">
          ${job.url
            ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a>`
            : escapeHtml(job.title)
          }
        </div>
      </div>
      <div class="job-meta">
        <span class="job-company">${escapeHtml(job.company)}</span>
        <span class="job-location">${escapeHtml(job.location)}</span>
        ${salaryHtml}
      </div>
      ${tagsHtml ? `<div class="job-tags">${tagsHtml}</div>` : ''}
      <div class="job-footer">
        <div class="run-info">
          <span class="job-source ${sourceClass}">${escapeHtml(job.source)}</span>
          <span class="job-time">${timeAgo(job.scrapedAt || job.scraped_at)}</span>
        </div>
        <div class="job-confidence ${confidenceClass}">
          <div class="confidence-bar">
            <div class="confidence-fill" style="width: ${Math.round(job.confidence * 100)}%"></div>
          </div>
          ${Math.round(job.confidence * 100)}%
        </div>
      </div>
    `;

    // Remove "new" highlight after 3s
    if (isNew) {
      setTimeout(() => card.classList.remove('new-job'), 3000);
    }

    return card;
  }

  function renderJobs(jobs) {
    els.jobList.innerHTML = '';

    if (jobs.length === 0) {
      els.jobList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📡</div>
          <p>No jobs found</p>
          <p class="empty-sub">Try adjusting your filters or trigger a scrape</p>
        </div>
      `;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const job of jobs) {
      fragment.appendChild(createJobCard(job));
    }
    els.jobList.appendChild(fragment);
  }

  // ── Health Panel ──
  function renderHealth(healthData) {
    if (!healthData || !Array.isArray(healthData)) return;

    els.healthCards.innerHTML = '';

    for (const h of healthData) {
      const stateClass = h.state === 'CLOSED' ? 'state-closed'
        : h.state === 'OPEN' ? 'state-open' : 'state-half-open';

      const stateLabel = h.state === 'CLOSED' ? 'Healthy'
        : h.state === 'OPEN' ? 'Down' : 'Probing';

      const rateColor = h.successRate >= 0.9 ? 'var(--accent-green)'
        : h.successRate >= 0.5 ? 'var(--accent-amber)' : 'var(--accent-red)';

      const card = document.createElement('div');
      card.className = 'health-card';
      card.innerHTML = `
        <div class="health-card-header">
          <span class="health-source">${escapeHtml(h.source)}</span>
          <span class="health-state ${stateClass}">${stateLabel}</span>
        </div>
        <div class="health-metrics">
          <div class="health-metric">
            <span class="health-metric-label">Success Rate</span>
            <span class="health-metric-value">${Math.round(h.successRate * 100)}%</span>
            <div class="rate-bar">
              <div class="rate-fill" style="width: ${h.successRate * 100}%; background: ${rateColor}"></div>
            </div>
          </div>
          <div class="health-metric">
            <span class="health-metric-label">Avg Response</span>
            <span class="health-metric-value">${h.avgResponseMs}ms</span>
          </div>
          <div class="health-metric">
            <span class="health-metric-label">Requests</span>
            <span class="health-metric-value">${formatNumber(h.totalRequests)}</span>
          </div>
          <div class="health-metric">
            <span class="health-metric-label">Failures</span>
            <span class="health-metric-value">${h.consecutiveFailures}</span>
          </div>
        </div>
      `;

      els.healthCards.appendChild(card);
    }
  }

  // ── Runs Panel ──
  function renderRuns(runs) {
    if (!runs || !Array.isArray(runs)) return;

    els.runsList.innerHTML = '';

    if (runs.length === 0) {
      els.runsList.innerHTML = '<div class="empty-state"><p class="empty-sub">No scrape runs yet</p></div>';
      return;
    }

    for (const run of runs.slice(0, 10)) {
      const statusClass = run.status === 'completed' ? 'run-completed'
        : run.status === 'failed' ? 'run-failed' : 'run-running';

      const item = document.createElement('div');
      item.className = 'run-item';
      item.innerHTML = `
        <div class="run-info">
          <span class="run-source">${escapeHtml(run.source)}</span>
          <span class="run-status ${statusClass}">${run.status}</span>
        </div>
        <span class="run-stats">+${run.jobsNew || run.jobs_new || 0} new</span>
        <span class="run-time">${timeAgo(run.startedAt || run.started_at)}</span>
      `;
      els.runsList.appendChild(item);
    }
  }

  // ── Stats ──
  function renderStats(stats) {
    if (!stats) return;

    const jobStats = stats.jobs || {};
    els.statTotal.textContent = formatNumber(jobStats.total || 0);
    els.stat24h.textContent = formatNumber(jobStats.last24h || 0);
    els.statConfidence.textContent = `${Math.round((jobStats.avgConfidence || 0) * 100)}%`;
    els.statWs.textContent = String(stats.wsClients || 0);
    els.activeSources.textContent = String((stats.adapters || []).length);
  }

  // ── System Status ──
  function updateSystemStatus(status) {
    const badge = els.systemStatus;
    badge.className = 'status-badge';

    switch (status) {
      case 'HEALTHY':
        badge.classList.add('status-healthy');
        els.statusLabel.textContent = 'Healthy';
        break;
      case 'DEGRADED':
      case 'PARTIAL':
        badge.classList.add('status-degraded');
        els.statusLabel.textContent = 'Degraded';
        break;
      case 'DOWN':
        badge.classList.add('status-down');
        els.statusLabel.textContent = 'Down';
        break;
      default:
        badge.classList.add('status-unknown');
        els.statusLabel.textContent = 'Disconnected';
    }
  }

  // ── Scrape Button ──
  function updateBtnScrape(loading) {
    if (loading) {
      els.btnScrape.innerHTML = '<span class="spinner"></span> Scraping…';
      els.btnScrape.disabled = true;
    } else {
      els.btnScrape.innerHTML = '<span class="btn-icon">↻</span> Scrape Now';
      els.btnScrape.disabled = false;
    }
  }

  // ── Log Stream ──
  function addLog(level, message) {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${level}`;

    const time = new Date().toLocaleTimeString('en-US', { hour12: false });

    entry.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-level">${level.toUpperCase().slice(0, 4)}</span>
      <span class="log-msg">${escapeHtml(String(message))}</span>
    `;

    els.logStream.appendChild(entry);

    // Auto-scroll to bottom
    els.logStream.scrollTop = els.logStream.scrollHeight;

    // Limit log entries
    const entries = els.logStream.querySelectorAll('.log-entry');
    if (entries.length > 200) {
      entries[0].remove();
    }
  }

  // ── Pagination ──
  function updatePageInfo() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    const currentPage = state.page + 1;

    els.pageInfo.textContent = `${currentPage} / ${totalPages} (${formatNumber(state.total)} jobs)`;
    els.btnPrev.disabled = state.page <= 0;
    els.btnNext.disabled = currentPage >= totalPages;
  }

  // ── Data Fetching ──
  async function fetchJobs() {
    const offset = state.page * state.pageSize;
    let path = `/api/jobs?limit=${state.pageSize}&offset=${offset}`;
    if (state.source) path += `&source=${encodeURIComponent(state.source)}`;
    if (state.search) path += `&search=${encodeURIComponent(state.search)}`;

    const res = await api.get(path);
    if (!res || !res.ok) return;

    state.jobs = res.data;
    state.total = res.pagination.total;

    renderJobs(state.jobs);
    updatePageInfo();
    els.totalJobs.textContent = formatNumber(state.total);
  }

  async function fetchHealth() {
    const res = await api.get('/api/health');
    if (res && res.ok) {
      updateSystemStatus(res.data.status);
      renderHealth(res.data.sources);
    }
  }

  async function fetchRuns() {
    const res = await api.get('/api/runs');
    if (res && res.ok) {
      renderRuns(res.data);
    }
  }

  async function fetchStats() {
    const res = await api.get('/api/stats');
    if (res && res.ok) {
      renderStats(res.data);
    }
  }

  async function refreshAll() {
    await Promise.all([
      fetchJobs(),
      fetchHealth(),
      fetchRuns(),
      fetchStats(),
    ]);
  }

  // ── Event Handlers ──
  function setupEventHandlers() {
    // Scrape button
    els.btnScrape.addEventListener('click', async () => {
      updateBtnScrape(true);
      await api.post('/api/scrape');
    });

    // Search
    let searchTimeout;
    els.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        state.search = els.searchInput.value.trim();
        state.page = 0;
        fetchJobs();
      }, 300);
    });

    // Source filter
    els.sourceFilter.addEventListener('change', () => {
      state.source = els.sourceFilter.value;
      state.page = 0;
      fetchJobs();
    });

    // Pagination
    els.btnPrev.addEventListener('click', () => {
      if (state.page > 0) {
        state.page--;
        fetchJobs();
      }
    });

    els.btnNext.addEventListener('click', () => {
      const totalPages = Math.ceil(state.total / state.pageSize);
      if (state.page + 1 < totalPages) {
        state.page++;
        fetchJobs();
      }
    });

    // Clear log
    els.btnClearLog.addEventListener('click', () => {
      els.logStream.innerHTML = '';
      addLog('info', 'Log cleared');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Don't intercept when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      switch (e.key.toLowerCase()) {
        case 'r':
          els.btnScrape.click();
          break;
        case 'f':
          e.preventDefault();
          els.searchInput.focus();
          break;
      }
    });

    // ESC to blur search
    els.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        els.searchInput.blur();
      }
    });
  }

  // ── Utility Functions ──
  function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffSec < 10) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24)  return `${diffHr}h ago`;
    if (diffDay < 7)  return `${diffDay}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatNumber(n) {
    if (typeof n !== 'number') return String(n);
    return n.toLocaleString('en-US');
  }

  function formatSalary(salary) {
    if (!salary) return '';
    const sym = salary.currency === 'EUR' ? '€' : salary.currency === 'GBP' ? '£' : '$';
    const min = (salary.min / 1000).toFixed(0);
    const max = (salary.max / 1000).toFixed(0);
    if (min === max) return `${sym}${min}k`;
    return `${sym}${min}k–${sym}${max}k`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── "Last Scrape" Timer ──
  function startLastScrapeTimer() {
    setInterval(() => {
      if (state.lastScrape) {
        els.lastScrape.textContent = timeAgo(state.lastScrape.toISOString());
      }
    }, 10000);
  }

  // ── Periodic Refresh ──
  function startPeriodicRefresh() {
    // Refresh stats every 30s
    setInterval(() => {
      fetchStats();
      fetchHealth();
    }, 30000);

    // Refresh runs every 15s
    setInterval(fetchRuns, 15000);
  }

  // ── Initialize ──
  async function init() {
    addLog('info', 'Dashboard initializing…');

    setupEventHandlers();
    connectWS();

    await refreshAll();

    startLastScrapeTimer();
    startPeriodicRefresh();

    addLog('info', 'Dashboard ready — press R to scrape, F to filter');
  }

  // ── 🥚 Konami Code Easter Egg ──
  // ↑ ↑ ↓ ↓ ← → ← → B A
  (function initKonami() {
    const SEQ = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
    let pos = 0;
    let hackerMode = false;

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      const expected = SEQ[pos];
      if (e.key === expected || e.key.toLowerCase() === expected) {
        pos++;
        if (pos === SEQ.length) {
          pos = 0;
          hackerMode = !hackerMode;
          triggerHackerMode(hackerMode);
        }
      } else {
        pos = 0;
      }
    });

    function triggerHackerMode(on) {
      if (on) {
        // Rain effect first
        spawnMatrixRain();
        setTimeout(() => {
          document.body.classList.add('hacker-mode');
          addLog('info', '> ACCESS GRANTED — welcome to the other side');
          addLog('info', '> CRT_MODE=1 PHOSPHOR=P1 SCANLINE_FREQ=60Hz');
          addLog('info', '> enter the code again to return');
        }, 800);
      } else {
        document.body.classList.remove('hacker-mode');
        addLog('info', '> CRT_MODE=0 — back to normal');
        // Remove leftover rain
        const rain = document.getElementById('matrix-rain');
        if (rain) rain.remove();
      }
    }

    function spawnMatrixRain() {
      // Remove old canvas if it exists
      const old = document.getElementById('matrix-rain');
      if (old) old.remove();

      const canvas = document.createElement('canvas');
      canvas.id = 'matrix-rain';
      canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;pointer-events:none;opacity:0.85;';
      document.body.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;

      const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';
      const fontSize = 14;
      const columns = Math.floor(canvas.width / fontSize);
      const drops = new Array(columns).fill(1);

      // Random start positions for more organic look
      for (let i = 0; i < drops.length; i++) {
        drops[i] = Math.random() * -50;
      }

      let frame = 0;
      const maxFrames = 90; // ~1.5 seconds at 60fps

      function draw() {
        frame++;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#00ff41';
        ctx.font = `${fontSize}px 'JetBrains Mono', monospace`;

        for (let i = 0; i < drops.length; i++) {
          const char = chars[Math.floor(Math.random() * chars.length)];
          const x = i * fontSize;
          const y = drops[i] * fontSize;

          // Head of the drop is brighter
          ctx.fillStyle = Math.random() > 0.95 ? '#ffffff' : '#00ff41';
          ctx.fillText(char, x, y);

          if (y > canvas.height && Math.random() > 0.975) {
            drops[i] = 0;
          }
          drops[i]++;
        }

        if (frame < maxFrames) {
          requestAnimationFrame(draw);
        } else {
          // Fade out
          canvas.style.transition = 'opacity 0.5s ease';
          canvas.style.opacity = '0';
          setTimeout(() => canvas.remove(), 600);
        }
      }

      draw();
    }
  })();

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
