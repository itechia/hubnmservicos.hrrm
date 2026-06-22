/* ═══════════════════════════════════════════════
   APP — Main Controller (Auth, Router, Clock)
   ═══════════════════════════════════════════════ */

// ── API Helper ──────────────────────────────
const API = {
  token: null,

  async get(url) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    if (res.status === 401) { App.logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },

  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { App.logout(); throw new Error('Unauthorized'); }
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  },
};

// ── Main App ────────────────────────────────
const App = {
  refreshInterval: null,
  currentPage: 'visao-geral',

  async init() {
    // Check stored session
    const token = localStorage.getItem('hrrm_token');
    const user = localStorage.getItem('hrrm_user');

    // Initialize toggles first so theme is applied instantly
    this.setupToggles();

    if (token && user) {
      API.token = token;
      this.showDashboard(JSON.parse(user));
    } else {
      this.showLogin();
    }

    this.setupLoginForm();
    this.setupNavigation();
    this.setupSidebarToggle();
    this.startClock();
  },

  // ── Theme & TV Mode Toggles ──────────────
  setupToggles() {
    const themeBtn = document.getElementById('theme-toggle-btn');
    const tvBtn = document.getElementById('tv-toggle-btn');

    // Load saved preferences
    const savedTheme = localStorage.getItem('hrrm_theme') || 'dark';
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
    this.updateBrandLogo(savedTheme === 'dark');

    const savedTv = localStorage.getItem('hrrm_tv') === 'true';
    if (savedTv) {
      document.body.classList.add('tv-mode');
    } else {
      document.body.classList.remove('tv-mode');
    }

    themeBtn?.addEventListener('click', () => {
      const isDark = document.body.classList.toggle('dark-mode');
      localStorage.setItem('hrrm_theme', isDark ? 'dark' : 'light');
      this.updateBrandLogo(isDark);
      
      // Instantly refresh charts/views to apply new theme colors
      if (this.currentPage === 'visao-geral') {
        Dashboard.refresh();
      } else if (this.currentPage === 'historico') {
        Historico.applyFilters();
      }
    });

    tvBtn?.addEventListener('click', () => {
      const isTv = document.body.classList.toggle('tv-mode');
      localStorage.setItem('hrrm_tv', isTv ? 'true' : 'false');
    });
  },

  updateBrandLogo(isDark) {
    const logoSrc = isDark ? '/logo-dark.png' : '/logo.png';
    document.querySelectorAll('img[src*="logo"]').forEach(img => {
      img.src = logoSrc;
    });
  },

  // ── Login ────────────────────────────────
  setupLoginForm() {
    const form = document.getElementById('login-form');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const login = document.getElementById('login-input').value.trim();
      const senha = document.getElementById('senha-input').value.trim();
      const errorEl = document.getElementById('login-error');
      const btn = document.getElementById('login-btn');
      const btnText = btn.querySelector('.btn-text');
      const btnLoader = btn.querySelector('.btn-loader');

      // UI feedback
      errorEl.style.display = 'none';
      btnText.style.display = 'none';
      btnLoader.style.display = 'inline-block';
      btn.disabled = true;

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login, senha }),
        });

        const data = await res.json();

        if (!res.ok) {
          errorEl.textContent = data.error || 'Credenciais inválidas.';
          errorEl.style.display = 'block';
          return;
        }

        // Store session
        API.token = data.token;
        localStorage.setItem('hrrm_token', data.token);
        localStorage.setItem('hrrm_user', JSON.stringify(data.user));

        this.showDashboard(data.user);
      } catch (err) {
        errorEl.textContent = 'Erro de conexão. Tente novamente.';
        errorEl.style.display = 'block';
      } finally {
        btnText.style.display = 'inline';
        btnLoader.style.display = 'none';
        btn.disabled = false;
      }
    });
  },

  showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  },

  async showDashboard(user) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    // Update user display
    const avatar = document.getElementById('user-avatar');
    if (avatar) avatar.textContent = (user.login || 'U')[0].toUpperCase();

    // Logout button
    document.getElementById('logout-btn')?.addEventListener('click', () => this.logout());

    // Initialize modules
    await Dashboard.init();
    await Historico.init();
    this.setupCentroCustoFilter();
    await Alertas.init();
    Relatorio.init();

    // Auto-refresh every 60 seconds
    this.refreshInterval = setInterval(async () => {
      await Dashboard.refresh();
    }, 60000);
  },

  getCentroCustoFilter() {
    return document.getElementById('global-centro-custo')?.value || '';
  },

  setupCentroCustoFilter() {
    const selectIds = [
      'global-centro-custo',
      'filter-centro-custo',
      'alertas-centro-custo',
      'report-centro-custo',
    ];
    const selects = selectIds
      .map(id => document.getElementById(id))
      .filter(Boolean);
    const savedCenter = localStorage.getItem('hrrm_centro_custo') || '';

    if (savedCenter) {
      selects.forEach(select => {
        if ([...select.options].some(option => option.value === savedCenter)) {
          select.value = savedCenter;
        }
      });
    }

    const refreshCurrentPage = () => {
      if (this.currentPage === 'visao-geral') {
        Dashboard.refresh();
      } else if (this.currentPage === 'historico') {
        Historico.applyFilters();
      } else if (this.currentPage === 'alertas') {
        Alertas.refresh();
      }
    };

    selects.forEach(select => {
      select.addEventListener('change', () => {
        const value = select.value;
        localStorage.setItem('hrrm_centro_custo', value);
        selects.forEach(otherSelect => {
          if (otherSelect !== select && [...otherSelect.options].some(option => option.value === value)) {
            otherSelect.value = value;
          }
        });
        refreshCurrentPage();
      });
    });

    if (savedCenter) {
      refreshCurrentPage();
    }
  },

  logout() {
    const token = localStorage.getItem('hrrm_token');
    if (token) {
      fetch('/api/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      }).catch(() => {});
    }

    localStorage.removeItem('hrrm_token');
    localStorage.removeItem('hrrm_user');
    API.token = null;

    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.showLogin();
  },

  // ── Navigation ───────────────────────────
  setupNavigation() {
    // Sidebar navigation
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const page = link.dataset.page;
        this.navigateTo(page);
      });
    });

    // Mobile bottom nav
    document.querySelectorAll('.mobile-nav-item').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const page = link.dataset.page;
        this.navigateTo(page);
      });
    });

    // Handle hash
    window.addEventListener('hashchange', () => {
      const page = location.hash.replace('#', '') || 'visao-geral';
      this.navigateTo(page);
    });
  },

  navigateTo(page) {
    this.currentPage = page;

    // Update sidebar active state
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.querySelector(`.nav-link[data-page="${page}"]`)?.classList.add('active');

    // Update mobile nav
    document.querySelectorAll('.mobile-nav-item').forEach(l => l.classList.remove('active'));
    document.querySelector(`.mobile-nav-item[data-page="${page}"]`)?.classList.add('active');

    // Show page
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pageEl = document.getElementById(`page-${page}`);
    if (pageEl) pageEl.classList.add('active');

    // Load data for specific pages
    if (page === 'historico') {
      Historico.applyFilters();
    } else if (page === 'alertas') {
      Alertas.refresh();
    }

    // Close sidebar on mobile
    document.getElementById('sidebar')?.classList.remove('open');

    // Update hash
    history.replaceState(null, '', `#${page}`);
  },

  // ── Sidebar Toggle (Mobile) ──────────────
  setupSidebarToggle() {
    const toggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const savedCollapsed = localStorage.getItem('hrrm_sidebar_collapsed') === 'true';
    if (savedCollapsed) {
      document.body.classList.add('sidebar-collapsed');
    }

    toggle?.addEventListener('click', () => {
      if (window.matchMedia('(min-width: 1025px)').matches) {
        const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
        localStorage.setItem('hrrm_sidebar_collapsed', isCollapsed ? 'true' : 'false');
      } else {
        sidebar?.classList.toggle('open');
      }
    });

    // Close sidebar on overlay click
    document.addEventListener('click', (e) => {
      if (sidebar?.classList.contains('open') && !sidebar.contains(e.target) && !toggle?.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });
  },

  // ── Clock ────────────────────────────────
  startClock() {
    const update = () => {
      const now = new Date();
      const clockEl = document.getElementById('header-clock');
      const dateEl = document.getElementById('header-date');

      if (clockEl) {
        clockEl.textContent = now.toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
      }

      if (dateEl) {
        dateEl.textContent = now.toLocaleDateString('pt-BR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
        });
      }
    };

    update();
    setInterval(update, 1000);
  },
};

// ── Start App ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
