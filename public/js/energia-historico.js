/* ═══════════════════════════════════════════════
   ENERGIA HISTÓRICO — Filtros, Gráficos e Tabela
   ═══════════════════════════════════════════════ */

const EnergiaHistorico = {
  chartNeutro: null,
  chartFase: null,
  allData: [],
  currentPage: 1,
  pageSize: 20,
  limits: null,

  async init() {
    await this.loadConfig();
    this.setupListeners();
    this.setDefaultDates();
    await this.applyFilters();
  },

  async loadConfig() {
    try {
      this.limits = await API.get('/api/energia/config');
    } catch (err) {
      this.limits = {
        faseNeutro: { nominal: 220, min: 202, max: 231 },
        faseFase: { nominal: 381.05, min: 349.87, max: 400.1 },
        desequilibrioMaxPct: 5,
        co2KgPorKwh: 0.04,
        arvoreKgCo2Ano: 22,
      };
    }
  },

  setupListeners() {
    document.getElementById('btn-energia-hist-filtrar')?.addEventListener('click', () => this.applyFilters());
  },

  setDefaultDates() {
    const now = new Date();
    const past30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const formatLocal = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      const yyyy = d.getFullYear();
      const MM = pad(d.getMonth() + 1);
      const dd = pad(d.getDate());
      const hh = pad(d.getHours());
      const mm = pad(d.getMinutes());
      return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
    };

    const inicioEl = document.getElementById('energia-hist-inicio');
    const fimEl = document.getElementById('energia-hist-fim');
    if (inicioEl && !inicioEl.value) inicioEl.value = formatLocal(past30d);
    if (fimEl && !fimEl.value) fimEl.value = formatLocal(now);
  },

  getFiltersQuery() {
    const params = new URLSearchParams();
    const inicio = document.getElementById('energia-hist-inicio')?.value;
    const fim = document.getElementById('energia-hist-fim')?.value;
    const fornecedor = document.getElementById('energia-hist-fornecedor')?.value;
    const criticidade = document.getElementById('energia-hist-criticidade')?.value;

    if (inicio) params.set('inicio', inicio.replace('T', ' ') + ':00');
    if (fim) params.set('fim', fim.replace('T', ' ') + ':59');
    if (fornecedor) params.set('fornecedor', fornecedor);
    if (criticidade) params.set('criticidade', criticidade);

    return params.toString();
  },

  async applyFilters() {
    try {
      const query = this.getFiltersQuery();
      const url = `/api/energia/iot/historico${query ? `?${query}` : ''}`;
      this.allData = await API.get(url);
      this.currentPage = 1;
      this.renderCharts();
      this.renderTable();
    } catch (err) {
      console.error('Error applying energy history filters:', err);
    }
  },

  renderCharts() {
    const canvasNeutro = document.getElementById('chart-energia-hist-neutro');
    const canvasFase = document.getElementById('chart-energia-hist-fase');
    if (!canvasNeutro || !canvasFase) return;

    if (this.chartNeutro) this.chartNeutro.destroy();
    if (this.chartFase) this.chartFase.destroy();

    if (!this.allData.length) return;

    const data = [...this.allData].reverse();
    const maxPoints = 300;
    const step = Math.max(1, Math.ceil(data.length / maxPoints));
    const chartData = data.filter((_, i) => i % step === 0);

    const labels = chartData.map(row => this.formatDateTimeShort(row.data_hora_registro));
    const colors = NMCharts.getThemeColors();

    // Chart 1: Tensões Fase-Neutro (V1, V2, V3)
    this.chartNeutro = new Chart(canvasNeutro, {
      type: 'line',
      data: {
        labels,
        datasets: [
          this.lineDataset('V1', chartData.map(row => row.v1_tensao_v), '#2E95FF'),
          this.lineDataset('V2', chartData.map(row => row.v2_tensao_v), '#26C281'),
          this.lineDataset('V3', chartData.map(row => row.v3_tensao_v), '#FF8A00'),
          this.limitDataset(`Mín. ${this.limits.faseNeutro.min} V`, labels, this.limits.faseNeutro.min, 'rgba(241,196,15,0.5)'),
          this.limitDataset(`Máx. ${this.limits.faseNeutro.max} V`, labels, this.limits.faseNeutro.max, 'rgba(231,76,60,0.5)'),
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: colors.text, usePointStyle: true, pointStyle: 'circle' } }
        },
        scales: {
          x: { grid: { color: colors.grid }, ticks: { color: colors.text, maxTicksLimit: 12 } },
          y: { grid: { color: colors.grid }, ticks: { color: colors.text }, suggestedMin: 190, suggestedMax: 240, title: { display: true, text: 'Volts (Fase-Neutro)', color: colors.text } }
        }
      }
    });

    // Chart 2: Tensões Fase-Fase (V1&V2, V2&V3, V1&V3)
    this.chartFase = new Chart(canvasFase, {
      type: 'line',
      data: {
        labels,
        datasets: [
          this.lineDataset('V1 & V2', chartData.map(row => row.v12_tensao_v), '#00D2FF'),
          this.lineDataset('V2 & V3', chartData.map(row => row.v23_tensao_v), '#E040FB'),
          this.lineDataset('V1 & V3', chartData.map(row => row.v13_tensao_v), '#FFD600'),
          this.limitDataset(`Mín. ${this.limits.faseFase.min.toFixed(0)} V`, labels, this.limits.faseFase.min, 'rgba(241,196,15,0.5)'),
          this.limitDataset(`Máx. ${this.limits.faseFase.max.toFixed(0)} V`, labels, this.limits.faseFase.max, 'rgba(231,76,60,0.5)'),
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: colors.text, usePointStyle: true, pointStyle: 'circle' } }
        },
        scales: {
          x: { grid: { color: colors.grid }, ticks: { color: colors.text, maxTicksLimit: 12 } },
          y: { grid: { color: colors.grid }, ticks: { color: colors.text }, suggestedMin: 320, suggestedMax: 420, title: { display: true, text: 'Volts (Fase-Fase)', color: colors.text } }
        }
      }
    });
  },

  renderTable() {
    const tbody = document.getElementById('energia-hist-table-body');
    const info = document.getElementById('energia-hist-table-info');
    if (!tbody) return;

    const total = this.allData.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const start = (this.currentPage - 1) * this.pageSize;
    const pageData = this.allData.slice(start, start + this.pageSize);

    if (info) info.textContent = `${total} registros`;

    if (!total) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: var(--space-md);">Nenhum registro encontrado para os filtros aplicados.</td></tr>';
      const pagination = document.getElementById('energia-hist-table-pagination');
      if (pagination) pagination.innerHTML = '';
      return;
    }

    tbody.innerHTML = pageData.map(row => {
      const isAlarme = row.alarme_ativo === 'SIM' || row.status_rede !== 'NORMAL';
      
      const v1Class = row.v1_status_normativo === 'critico' ? 'cell-alert' : row.v1_status_normativo === 'atencao' ? 'cell-warning' : '';
      const v2Class = row.v2_status_normativo === 'critico' ? 'cell-alert' : row.v2_status_normativo === 'atencao' ? 'cell-warning' : '';
      const v3Class = row.v3_status_normativo === 'critico' ? 'cell-alert' : row.v3_status_normativo === 'atencao' ? 'cell-warning' : '';

      const v12Class = row.v12_status_normativo === 'critico' ? 'cell-alert' : row.v12_status_normativo === 'atencao' ? 'cell-warning' : '';
      const v23Class = row.v23_status_normativo === 'critico' ? 'cell-alert' : row.v23_status_normativo === 'atencao' ? 'cell-warning' : '';
      const v13Class = row.v13_status_normativo === 'critico' ? 'cell-alert' : row.v13_status_normativo === 'atencao' ? 'cell-warning' : '';

      return `
        <tr>
          <td>${this.formatDateTime(row.data_hora_registro)}</td>
          <td><span class="status-pill ${isAlarme ? 'off' : 'on'}">${row.status_rede}</span></td>
          <td>${row.criticidade || '--'}</td>
          <td>${row.fornecedor_energia || '--'}</td>
          <td class="${v1Class}">${row.v1_tensao_v == null ? '--' : row.v1_tensao_v.toFixed(1) + ' V'}</td>
          <td class="${v2Class}">${row.v2_tensao_v == null ? '--' : row.v2_tensao_v.toFixed(1) + ' V'}</td>
          <td class="${v3Class}">${row.v3_tensao_v == null ? '--' : row.v3_tensao_v.toFixed(1) + ' V'}</td>
          <td class="${v12Class}">${row.v12_tensao_v == null ? '--' : row.v12_tensao_v.toFixed(1) + ' V'}</td>
          <td class="${v23Class}">${row.v23_tensao_v == null ? '--' : row.v23_tensao_v.toFixed(1) + ' V'}</td>
          <td class="${v13Class}">${row.v13_tensao_v == null ? '--' : row.v13_tensao_v.toFixed(1) + ' V'}</td>
        </tr>
      `;
    }).join('');

    const pagination = document.getElementById('energia-hist-table-pagination');
    if (pagination) {
      if (totalPages <= 1) {
        pagination.innerHTML = '';
        return;
      }
      let btns = '';
      if (this.currentPage > 1) btns += `<button class="page-btn" data-p="${this.currentPage - 1}">← Anterior</button>`;

      const maxVisible = 5;
      let startP = Math.max(1, this.currentPage - Math.floor(maxVisible / 2));
      let endP = Math.min(totalPages, startP + maxVisible - 1);
      if (endP - startP < maxVisible - 1) startP = Math.max(1, endP - maxVisible + 1);

      for (let i = startP; i <= endP; i++) {
        btns += `<button class="page-btn ${i === this.currentPage ? 'active' : ''}" data-p="${i}">${i}</button>`;
      }

      if (this.currentPage < totalPages) btns += `<button class="page-btn" data-p="${this.currentPage + 1}">Próximo →</button>`;

      pagination.innerHTML = btns;
      pagination.querySelectorAll('.page-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          this.currentPage = parseInt(e.target.dataset.p);
          this.renderTable();
        });
      });
    }
  },

  // Line Chart Helper
  lineDataset(label, data, color) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: `${color}11`,
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: false,
    };
  },

  // Limit Line Helper
  limitDataset(label, labels, value, color) {
    return {
      label,
      data: Array(labels.length).fill(value),
      borderColor: color,
      borderDash: [6, 4],
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
    };
  },

  formatDateTime(value) {
    if (!value) return '--';
    return new Date(value).toLocaleString('pt-BR');
  },

  formatDateTimeShort(value) {
    if (!value) return '--';
    const date = new Date(value);
    const pad = (n) => String(n).padStart(2, '0');
    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());
    return `${day}/${month} ${hour}:${minute}`;
  }
};
