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
  currentPage: 'hub',
  currentUser: null,
  tvRotationInterval: null,
  tvRotationPages: [],
  tvRotationPageIndex: 0,

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
    this.setupTvMode();
    this.startClock();
  },

  // ── Theme Toggle ─────────────────────────
  setupToggles() {
    const themeBtn = document.getElementById('theme-toggle-btn');

    // Load saved preferences
    const savedTheme = localStorage.getItem('hrrm_theme') || 'dark';
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
    this.updateBrandLogo(savedTheme === 'dark');

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
    this.currentUser = user;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    // Update user display
    const avatar = document.getElementById('user-avatar');
    if (avatar) avatar.textContent = (user.login || 'U')[0].toUpperCase();

    // Logout button
    document.getElementById('logout-btn')?.addEventListener('click', () => this.logout());

    // 1. Immediately apply permissions and navigate to set the correct layout (e.g. hide sidebar on Hub)
    this.applyPermissions(user);
    const initialPage = location.hash.replace('#', '') || 'hub';
    this.navigateTo(initialPage);

    // 2. Initialize modules in the background to prevent blocking the UI layout
    this.setupCentroCustoFilter();
    Relatorio.init();

    Promise.all([
      Dashboard.init().catch(e => console.error('Dashboard init error:', e)),
      Historico.init().catch(e => console.error('Historico init error:', e)),
      Alertas.init().catch(e => console.error('Alertas init error:', e)),
      Energia.init().catch(e => console.error('Energia init error:', e)),
      EnergiaHistorico.init().catch(e => console.error('EnergiaHistorico init error:', e))
    ]);

    this.lastRefresh = {
      temperature: Date.now(),
      energySolar: Date.now(),
      energyRede: Date.now()
    };

    // Auto-refresh checker (runs every 5 seconds)
    this.refreshInterval = setInterval(async () => {
      const now = Date.now();

      if (['visao-geral', 'historico', 'alertas', 'relatorios'].includes(this.currentPage)) {
        // Temperature refresh: every 30 minutes
        if (now - this.lastRefresh.temperature >= 30 * 60 * 1000) {
          this.lastRefresh.temperature = now;
          await Dashboard.refresh();
        }
      } else if (this.currentPage === 'rede-eletrica') {
        // Real-time energy refresh: every 30 seconds
        if (now - this.lastRefresh.energyRede >= 30 * 1000) {
          this.lastRefresh.energyRede = now;
          await Energia.refreshRede({ filtered: false });
        }
      } else if (this.currentPage === 'energia-solar') {
        // Solar energy refresh: once a day (every 24 hours)
        if (now - this.lastRefresh.energySolar >= 24 * 60 * 60 * 1000) {
          this.lastRefresh.energySolar = now;
          await Energia.refreshGeracao();
        }
      }
    }, 5000);
  },

  hasEnergyPermission(user) {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
    const permission = normalize(user?.permissao);
    const login = normalize(user?.login);

    return ['energia_eletrica', 'hrrm', 'admin', 'administrador', 'master', 'total'].includes(permission)
      || permission.includes('hrrm')
      || permission.includes('energia')
      || login.includes('hrrm')
      || login.includes('energia');
  },

  applyPermissions(user) {
    const hasEnergy = this.hasEnergyPermission(user);
    document.querySelectorAll('.energy-only').forEach(element => {
      element.style.display = hasEnergy ? '' : 'none';
      element.dataset.authorized = hasEnergy ? 'true' : 'false';
    });
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
    this.currentUser = null;

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

    document.querySelectorAll('[data-module-target]').forEach(card => {
      card.addEventListener('click', () => {
        this.navigateTo(card.dataset.moduleTarget);
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
    if (!document.getElementById(`page-${page}`)) {
      page = 'hub';
    }
    if (this.getPageModule(page) === 'energy' && !this.hasEnergyPermission(this.currentUser)) {
      page = 'hub';
    }

    this.currentPage = page;
    this.updateModuleNavigation(page);

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

    // Load data for specific pages and update timestamps for background scheduler
    if (['visao-geral', 'historico', 'alertas', 'relatorios'].includes(page)) {
      if (this.lastRefresh) this.lastRefresh.temperature = Date.now();
      if (page === 'visao-geral') {
        Dashboard.refresh();
      } else if (page === 'historico') {
        Historico.applyFilters();
      } else if (page === 'alertas') {
        Alertas.refresh();
      }
    } else if (page === 'energia-solar') {
      if (this.lastRefresh) this.lastRefresh.energySolar = Date.now();
      Energia.refreshGeracao();
    } else if (page === 'rede-eletrica') {
      if (this.lastRefresh) this.lastRefresh.energyRede = Date.now();
      Energia.refreshRede({ filtered: false });
    } else if (page === 'relatorio-energia') {
      if (this.lastRefresh) this.lastRefresh.energyRede = Date.now();
      Energia.refreshRede({ filtered: true });
    } else if (page === 'historico-energia') {
      if (this.lastRefresh) this.lastRefresh.energyRede = Date.now();
      EnergiaHistorico.applyFilters();
    }

    // Close sidebar on mobile
    document.getElementById('sidebar')?.classList.remove('open');

    // Update hash
    history.replaceState(null, '', `#${page}`);
  },

  getPageModule(page) {
    if (page === 'hub') return 'hub';
    if (['energia-solar', 'rede-eletrica', 'relatorio-energia', 'historico-energia'].includes(page)) return 'energy';
    return 'temperature';
  },

  updateModuleNavigation(page) {
    const module = this.getPageModule(page);
    document.body.dataset.module = module;

    document.querySelectorAll('.sidebar-nav .temp-module').forEach(item => {
      item.style.display = module === 'temperature' ? '' : 'none';
    });
    document.querySelectorAll('.sidebar-nav .energy-module').forEach(item => {
      item.style.display = module === 'energy' ? '' : 'none';
    });

    const sidebarSummary = document.getElementById('sidebar-summary');
    if (sidebarSummary) {
      sidebarSummary.style.display = module === 'temperature' ? '' : 'none';
    }

    const brandModule = document.querySelector('.brand-module');
    if (brandModule) {
      brandModule.textContent = module === 'energy'
        ? 'Controle de Energia'
        : module === 'temperature'
          ? 'Controle de Temperatura'
          : 'Hub de Monitoramento';
    }

    const statusItems = document.querySelectorAll('.header-status .status-item');
    if (statusItems[0]) {
      statusItems[0].querySelector('.status-label').textContent = module === 'energy' ? 'ENERGIA' : 'SISTEMA';
      statusItems[0].querySelector('.status-value').textContent = 'ATIVO';
    }
    if (statusItems[1]) {
      statusItems[1].querySelector('.status-label').textContent = module === 'energy' ? 'M\u00d3DULO' : 'MODO';
      statusItems[1].querySelector('.status-value').textContent = module === 'energy' ? 'MONITORAMENTO' : 'AUTOM\u00c1TICO';
    }
    const centerFilter = document.getElementById('status-centro-custo');
    if (centerFilter) {
      centerFilter.style.display = module === 'temperature' ? '' : 'none';
    }
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

  // ── TV Mode & Rotation State Management ──
  setupTvMode() {
    const tvBtn = document.getElementById('tv-toggle-btn');
    const modal = document.getElementById('tv-modal');
    const closeBtn = document.getElementById('btn-close-tv-modal');
    const cancelBtn = document.getElementById('btn-cancel-tv-modal');
    const form = document.getElementById('tv-config-form');
    const exitBtn = document.getElementById('tv-exit-btn');

    if (!tvBtn || !modal) return;

    const openModal = () => {
      const hasEnergy = this.hasEnergyPermission(this.currentUser);
      document.querySelectorAll('#tv-modal .energy-only').forEach(option => {
        option.style.display = hasEnergy ? '' : 'none';
      });

      const savedInterval = localStorage.getItem('hrrm_tv_interval') || '30';
      const intervalInput = document.getElementById('tv-rotate-interval');
      if (intervalInput) intervalInput.value = savedInterval;

      modal.style.display = 'flex';
    };

    const closeModal = () => {
      modal.style.display = 'none';
    };

    tvBtn.addEventListener('click', () => {
      if (this.currentPage === 'hub') {
        openModal();
        return;
      }

      const savedInterval = parseInt(localStorage.getItem('hrrm_tv_interval'), 10) || 30;
      this.startTvRotation([this.currentPage], savedInterval);
    });
    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      closeModal();

      const hasEnergy = this.hasEnergyPermission(this.currentUser);
      const pages = [...document.querySelectorAll('#tv-modal input[data-tv-page]:checked')]
        .map(input => input.value)
        .filter(page => hasEnergy || this.getPageModule(page) !== 'energy');

      if (pages.length === 0) {
        alert('Selecione pelo menos um m\u00f3dulo para rota\u00e7\u00e3o.');
        return;
      }

      const intervalInput = document.getElementById('tv-rotate-interval');
      const seconds = parseInt(intervalInput?.value) || 30;
      localStorage.setItem('hrrm_tv_interval', seconds.toString());

      this.startTvRotation(pages, seconds);
    });

    exitBtn?.addEventListener('click', () => {
      this.stopTvRotation();
    });

    const onFullscreenChange = () => {
      const isFullscreen = document.fullscreenElement ||
                           document.webkitFullscreenElement ||
                           document.mozFullScreenElement ||
                           document.msFullscreenElement;

      if (!isFullscreen && document.body.classList.contains('tv-mode')) {
        this.stopTvRotation();
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('mozfullscreenchange', onFullscreenChange);
    document.addEventListener('MSFullscreenChange', onFullscreenChange);
  },

  startTvRotation(pages, intervalSecs) {
    this.stopTvRotation(); // Ensure clean state

    this.tvRotationPages = pages;
    this.tvRotationPageIndex = 0;

    // Apply tv-mode class
    document.body.classList.add('tv-mode');
    
    // Show exit button
    const exitBtn = document.getElementById('tv-exit-btn');
    if (exitBtn) exitBtn.style.display = 'flex';

    // Request fullscreen safely
    const docEl = document.documentElement;
    try {
      if (docEl.requestFullscreen) {
        docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      } else if (docEl.mozRequestFullScreen) {
        docEl.mozRequestFullScreen();
      } else if (docEl.msRequestFullscreen) {
        docEl.msRequestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen API is blocked or not supported on this browser (TBrowser fallback).');
    }

    // Immediately navigate to first page
    this.navigateTo(this.tvRotationPages[0]);

    // Setup transition interval
    if (this.tvRotationPages.length > 1) {
      this.tvRotationInterval = setInterval(() => {
        this.tvRotationPageIndex = (this.tvRotationPageIndex + 1) % this.tvRotationPages.length;
        const nextPage = this.tvRotationPages[this.tvRotationPageIndex];
        this.navigateTo(nextPage);
      }, intervalSecs * 1000);
    }
  },

  stopTvRotation() {
    // Clear timer
    if (this.tvRotationInterval) {
      clearInterval(this.tvRotationInterval);
      this.tvRotationInterval = null;
    }
    this.tvRotationPages = [];
    this.tvRotationPageIndex = 0;

    // Remove tv-mode class
    document.body.classList.remove('tv-mode');

    // Hide exit button
    const exitBtn = document.getElementById('tv-exit-btn');
    if (exitBtn) exitBtn.style.display = 'none';

    // Exit fullscreen safely
    try {
      if (document.exitFullscreen) {
        if (document.fullscreenElement) document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        if (document.webkitFullscreenElement) document.webkitExitFullscreen();
      } else if (document.mozCancelFullScreen) {
        if (document.mozFullScreenElement) document.mozCancelFullScreen();
      } else if (document.msExitFullscreen) {
        if (document.msFullscreenElement) document.msExitFullscreen();
      }
    } catch (err) {
      console.warn('Error exiting fullscreen:', err);
    }

    // Refresh current page to apply normal layout size
    this.navigateTo(this.currentPage || 'hub');
  },

  // ── Clock ────────────────────────────────
  startClock() {
    const update = () => {
      const now = new Date();
      const clockEl = document.getElementById('header-clock');
      const dateEl = document.getElementById('header-date');
      const hubLastUpdateEl = document.getElementById('hub-last-update');

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

      if (hubLastUpdateEl) {
        hubLastUpdateEl.textContent = now.toLocaleDateString('pt-BR') + ' ' + now.toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
      }
    };

    update();
    setInterval(update, 1000);
  },
};

// ── Start App ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
