/* ═══════════════════════════════════════════════
   HISTÓRICO — Filtros Dinâmicos + Gráficos
   ═══════════════════════════════════════════════ */

const Historico = {
  chart: null,
  allData: [],
  currentPage: 1,
  pageSize: 20,
  limits: null,

  async init() {
    this.limits = Dashboard.limits;
    this.setupFilterListeners();
    await this.loadRooms();
  },

  setupFilterListeners() {
    // Period buttons
    document.querySelectorAll('#filter-period-buttons .filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('#filter-period-buttons .filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');

        const period = e.target.dataset.period;
        const customDates = document.getElementById('filter-custom-dates');
        customDates.style.display = period === 'custom' ? 'flex' : 'none';
      });
    });

    // Apply filters button
    document.getElementById('btn-apply-filters')?.addEventListener('click', () => this.applyFilters());

    // Export CSV
    document.getElementById('btn-export-csv')?.addEventListener('click', () => this.exportCSV());
  },

  async loadRooms() {
    try {
      const rooms = await API.get('/api/temperatura/salas');
      const select = document.getElementById('filter-sala');
      const reportSelect = document.getElementById('report-sala');
      const centerSelects = [
        document.getElementById('global-centro-custo'),
        document.getElementById('filter-centro-custo'),
        document.getElementById('alertas-centro-custo'),
        document.getElementById('report-centro-custo'),
      ].filter(Boolean);

      rooms.forEach(room => {
        const opt = `<option value="${room.codigo_sala}">${room.sala} (${room.centro_custo})</option>`;
        if (select) select.innerHTML += opt;
        if (reportSelect) reportSelect.innerHTML += opt;
      });

      const centers = [...new Set(rooms.map(room => room.centro_custo).filter(Boolean))].sort();
      centerSelects.forEach(centerSelect => {
        const defaultLabel = centerSelect.id === 'global-centro-custo' ? 'Todos' : 'Todos os Centros';
        centerSelect.innerHTML = `<option value="">${defaultLabel}</option>`;
        centers.forEach(center => {
          centerSelect.innerHTML += `<option value="${center}">${center}</option>`;
        });
      });
    } catch (e) {
      console.error('Error loading rooms:', e);
    }
  },

  getDateRange() {
    const active = document.querySelector('#filter-period-buttons .filter-btn.active');
    const period = active?.dataset.period || 'today';

    const now = new Date();
    let inicio, fim;

    switch (period) {
      case 'today':
        inicio = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        fim = now;
        break;
      case '7d':
        inicio = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        fim = now;
        break;
      case '30d':
        inicio = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        fim = now;
        break;
      case 'custom':
        const startVal = document.getElementById('filter-date-start')?.value;
        const endVal = document.getElementById('filter-date-end')?.value;
        inicio = startVal ? new Date(startVal) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        fim = endVal ? new Date(endVal + 'T23:59:59') : now;
        break;
    }

    return {
      inicio: inicio.toISOString().slice(0, 19).replace('T', ' '),
      fim: fim.toISOString().slice(0, 19).replace('T', ' '),
    };
  },

  async applyFilters() {
    const { inicio, fim } = this.getDateRange();
    const sala = document.getElementById('filter-sala')?.value || '';
    const centroCusto = document.getElementById('filter-centro-custo')?.value
      || document.getElementById('global-centro-custo')?.value
      || '';

    try {
      let url = `/api/temperatura/historico?inicio=${encodeURIComponent(inicio)}&fim=${encodeURIComponent(fim)}`;
      if (sala) url += `&sala=${encodeURIComponent(sala)}`;
      if (centroCusto) url += `&centro_custo=${encodeURIComponent(centroCusto)}`;

      this.allData = await API.get(url);
      this.currentPage = 1;
      this.renderChart();
      this.renderTable();
    } catch (e) {
      console.error('Error applying filters:', e);
    }
  },

  renderChart() {
    if (!this.allData.length) return;

    // Group data by data_hora for charting
    const grouped = {};
    this.allData.forEach(r => {
      const key = r.data_hora || '';
      if (!grouped[key]) grouped[key] = { temps: [], umids: [] };
      grouped[key].temps.push(r.temperatura_c);
      grouped[key].umids.push(r.umidade_pct);
    });

    const entries = Object.entries(grouped).reverse();
    const labels = entries.map(([k]) => {
      const parts = k.split(' ');
      if (parts.length > 1) {
        const dateParts = parts[0].split('/');
        const timeParts = parts[1].split(':');
        const hm = timeParts.slice(0, 2).join(':'); // HH:MM
        
        const active = document.querySelector('#filter-period-buttons .filter-btn.active');
        const period = active?.dataset.period || 'today';
        if (period === 'today') {
          return hm;
        } else if (dateParts.length > 1) {
          return `${dateParts[0]}/${dateParts[1]} ${hm}`; // DD/MM HH:MM
        }
      }
      return k;
    });
    const tempData = entries.map(([, v]) => v.temps.reduce((a, b) => a + b, 0) / v.temps.length);
    const umidData = entries.map(([, v]) => v.umids.reduce((a, b) => a + b, 0) / v.umids.length);

    this.chart = NMCharts.createTempHumidChart('chart-historico', labels, tempData, umidData, this.limits);
  },

  renderTable() {
    const tbody = document.getElementById('data-table-body');
    const info = document.getElementById('table-info');
    if (!tbody) return;

    const total = this.allData.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const start = (this.currentPage - 1) * this.pageSize;
    const pageData = this.allData.slice(start, start + this.pageSize);

    if (info) info.textContent = `${total} registros`;

    tbody.innerHTML = pageData.map(r => {
      const tempAlert = r.temperatura_c < this.limits?.temp.min || r.temperatura_c > this.limits?.temp.max;
      const umidAlert = r.umidade_pct < this.limits?.umid.min || r.umidade_pct > this.limits?.umid.max;

      return `
        <tr>
          <td>${r.data_hora || ''}</td>
          <td>${r.sala || ''}</td>
          <td class="${tempAlert ? 'cell-alert' : ''}">${r.temperatura_c.toFixed(1)}°C</td>
          <td class="${umidAlert ? 'cell-warning' : ''}">${r.umidade_pct}%</td>
          <td>${r.bateria || '--'}</td>
          <td>${r.online || '--'}</td>
        </tr>
      `;
    }).join('');

    // Pagination
    const pagination = document.getElementById('table-pagination');
    if (pagination && totalPages > 1) {
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

  exportCSV() {
    if (!this.allData.length) return;

    const headers = ['Data/Hora', 'Sala', 'Centro de Custo', 'Temperatura (°C)', 'Umidade (%)', 'Bateria', 'Online'];
    const csvRows = [headers.join(';')];

    this.allData.forEach(r => {
      csvRows.push([
        r.data_hora || '',
        r.sala || '',
        r.centro_custo || '',
        r.temperatura_c.toFixed(1),
        r.umidade_pct,
        r.bateria || '',
        r.online || '',
      ].join(';'));
    });

    const blob = new Blob(['\ufeff' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `historico_temperatura_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
