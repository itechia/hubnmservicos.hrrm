const Energia = {
  limits: null,
  geracaoData: [],
  redeData: [],
  inconformidades: [],
  initialized: false,

  async init() {
    if (this.initialized) return;
    this.initialized = true;
    this.setupListeners();
    await this.loadConfig();
    await this.loadPlantas();
  },

  setupListeners() {
    document.getElementById('btn-energia-geracao-filtrar')?.addEventListener('click', () => this.refreshGeracao());
    document.getElementById('btn-energia-iot-filtrar')?.addEventListener('click', () => this.refreshRede({ filtered: true }));
    document.getElementById('btn-energia-report-pdf')?.addEventListener('click', () => this.generatePdf());
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

  async loadPlantas() {
    try {
      const plantas = await API.get('/api/energia/geracao/plantas');
      const select = document.getElementById('energia-geracao-planta');
      if (!select) return;
      select.innerHTML = '<option value="">Todas as Plantas</option>';
      plantas.forEach(row => {
        select.innerHTML += `<option value="${row.planta}">${row.planta}</option>`;
      });
    } catch (err) {
      console.error('Error loading energy plants:', err);
    }
  },

  getGeracaoQuery() {
    const params = new URLSearchParams();
    const inicio = document.getElementById('energia-geracao-inicio')?.value;
    const fim = document.getElementById('energia-geracao-fim')?.value;
    const planta = document.getElementById('energia-geracao-planta')?.value;
    if (inicio) params.set('inicio', inicio);
    if (fim) params.set('fim', fim);
    if (planta) params.set('planta', planta);
    return params.toString();
  },

  getRedeQuery(options = {}) {
    const params = new URLSearchParams();
    const inicio = document.getElementById('energia-iot-inicio')?.value;
    const fim = document.getElementById('energia-iot-fim')?.value;
    const fornecedor = document.getElementById('energia-iot-fornecedor')?.value;
    const criticidade = document.getElementById('energia-iot-criticidade')?.value;
    if (inicio) params.set('inicio', inicio.replace('T', ' '));
    if (fim) params.set('fim', fim.replace('T', ' '));
    if (fornecedor) params.set('fornecedor', fornecedor);
    if (criticidade) params.set('criticidade', criticidade);
    Object.entries(options).forEach(([key, value]) => params.set(key, value));
    return params.toString();
  },

  async refreshGeracao(options = {}) {
    if (!options.silent) {
      App.showLoading('Carregando geração solar...', 'Consultando histórico, KPIs e comparativo mensal.');
      App.setButtonLoading('btn-energia-geracao-filtrar', true, 'Carregando...');
    }
    try {
      const query = this.getGeracaoQuery();
      const suffix = query ? `?${query}` : '';
      const [stats, historico, comparativoMensal] = await Promise.all([
        API.get(`/api/energia/geracao/stats${suffix}`),
        API.get(`/api/energia/geracao/historico${query ? `${suffix}&limit=365` : '?limit=365'}`),
        this.getGeracaoMonthlyComparison(),
      ]);
      this.geracaoData = historico;
      this.renderGeracaoKpis(stats, comparativoMensal);
      this.renderGeracaoChart(historico);
      this.renderSustentabilidade(stats);
      this.renderGeracaoTable(historico);
    } catch (err) {
      console.error('Error refreshing generation dashboard:', err);
      this.renderGeracaoError(err);
    } finally {
      if (!options.silent) {
        App.setButtonLoading('btn-energia-geracao-filtrar', false);
        App.hideLoading();
      }
    }
  },

  async getGeracaoMonthlyComparison() {
    const now = new Date();
    const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDayPreviousMonth = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const previousDay = Math.min(now.getDate(), lastDayPreviousMonth);
    const previousEnd = new Date(now.getFullYear(), now.getMonth() - 1, previousDay);
    const planta = document.getElementById('energia-geracao-planta')?.value;

    const buildQuery = (inicio, fim) => {
      const params = new URLSearchParams({
        inicio: this.formatDateInput(inicio),
        fim: this.formatDateInput(fim),
      });
      if (planta) params.set('planta', planta);
      return params.toString();
    };

    const [currentStats, previousStats] = await Promise.all([
      API.get(`/api/energia/geracao/stats?${buildQuery(currentStart, currentEnd)}`),
      API.get(`/api/energia/geracao/stats?${buildQuery(previousStart, previousEnd)}`),
    ]);

    const currentTotal = Number(currentStats?.geral?.total_kwh || 0);
    const previousTotal = Number(previousStats?.geral?.total_kwh || 0);
    const percent = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : null;

    return {
      currentTotal,
      previousTotal,
      percent,
      comparedDays: previousDay,
      hasBase: previousTotal > 0,
    };
  },

  async refreshRede(options = {}) {
    if (!options.silent) {
      const title = options.filtered ? 'Aplicando filtros de energia...' : 'Carregando monitoramento elétrico...';
      const message = options.filtered
        ? 'Consultando histórico filtrado e inconformidades da rede.'
        : 'Buscando leituras atuais, fases e estatísticas operacionais.';
      App.showLoading(title, message);
      if (options.filtered) App.setButtonLoading('btn-energia-iot-filtrar', true, 'Filtrando...');
    }
    try {
      const query = options.filtered
        ? this.getRedeQuery({ limit: '500' })
        : new URLSearchParams({ limit: '500' }).toString();
      const suffix = query ? `?${query}` : '';
      const [atual, stats, historico, inconformidades] = await Promise.all([
        API.get('/api/energia/iot/atual'),
        API.get(`/api/energia/iot/stats${suffix}`),
        API.get(`/api/energia/iot/historico${suffix}`),
        API.get(`/api/energia/iot/inconformidades${suffix}`),
      ]);
      this.redeData = historico;
      this.inconformidades = inconformidades;
      this.renderRedeKpis(stats, atual);
      this.renderFasesAtual(atual);
      this.renderRedeChart(historico);
      this.renderRedeInsights(stats, atual);
      this.renderInconformidades(inconformidades);
    } catch (err) {
      console.error('Error refreshing electrical dashboard:', err);
      this.renderRedeError(err);
    } finally {
      if (!options.silent) {
        if (options.filtered) App.setButtonLoading('btn-energia-iot-filtrar', false);
        App.hideLoading();
      }
    }
  },

  renderGeracaoError(err) {
    const message = err?.message || 'Falha ao carregar dados de geração.';
    const kpis = document.getElementById('energia-geracao-kpis');
    const insights = document.getElementById('energia-sustentabilidade');
    const tbody = document.getElementById('energia-geracao-table-body');
    const info = document.getElementById('energia-geracao-table-info');
    if (kpis) {
      kpis.innerHTML = `
        ${this.kpiCard('Geração Total', '-- kWh', message, 'danger')}
        ${this.kpiCard('Média Diária', '-- kWh', 'Sem dados carregados', 'warning')}
        ${this.kpiCard('CO₂ Evitado', '-- kg', 'Aguardando leituras', 'info')}
        ${this.kpiCard('Melhor Dia', '--', 'Sem histórico disponível', 'info')}
      `;
    }
    if (insights) {
      insights.innerHTML = `
        <h3 class="card-title">IMPACTO SUSTENTÁVEL</h3>
        <p class="energy-reference">${message}</p>
      `;
    }
    if (info) info.textContent = '0 registros';
    if (tbody) tbody.innerHTML = '<tr><td colspan="4">Nenhum dado de geração disponível no momento.</td></tr>';
  },

  renderRedeError(err) {
    const message = err?.message || 'Falha ao carregar monitoramento elétrico.';
    const kpis = document.getElementById('energia-iot-kpis');
    const phases = document.getElementById('energia-fases-atual');
    const insights = document.getElementById('energia-rede-insights');
    const tbody = document.getElementById('energia-inconformidades-body');
    const info = document.getElementById('energia-inconformidades-info');
    if (kpis) {
      kpis.innerHTML = `
        ${this.kpiCard('Fornecedor Atual', '--', message, 'danger')}
        ${this.kpiCard('Status da Rede', '--', 'Sem leitura em tempo real', 'warning')}
        ${this.kpiCard('Alarmes', '--', 'Aguardando dados da tabela IOT', 'info')}
        ${this.kpiCard('Uso do Gerador', '--%', 'Sem período analisado', 'info')}
      `;
    }
    if (phases) {
      phases.innerHTML = ['V1', 'V2', 'V3', 'V1 & V2', 'V2 & V3', 'V1 & V3'].map(label => `
        <div class="phase-card sem_leitura">
          <span class="phase-label">${label}</span>
          <strong>-- V</strong>
          <small>Sem leitura</small>
        </div>
      `).join('');
    }
    if (insights) {
      insights.innerHTML = `
        <h3 class="card-title">QUALIDADE ELÉTRICA</h3>
        <p class="energy-reference">${message}</p>
      `;
    }
    if (info) info.textContent = '0 registros';
    if (tbody) tbody.innerHTML = '<tr><td colspan="6">Nenhuma inconformidade disponível no momento.</td></tr>';
  },

  renderGeracaoKpis(stats, comparativoMensal) {
    const g = stats.geral || {};
    const container = document.getElementById('energia-geracao-kpis');
    if (!container) return;
    const comparisonValue = comparativoMensal?.hasBase
      ? `${comparativoMensal.percent >= 0 ? '+' : ''}${this.formatNumber(comparativoMensal.percent, 1)}%`
      : '--';
    const comparisonSubtitle = comparativoMensal?.hasBase
      ? `${this.formatNumber(comparativoMensal.currentTotal, 1)} vs ${this.formatNumber(comparativoMensal.previousTotal, 1)} kWh | dias 1-${comparativoMensal.comparedDays}`
      : 'Sem base no m\u00eas anterior equivalente';
    const comparisonType = !comparativoMensal?.hasBase
      ? 'info'
      : comparativoMensal.percent >= 0
        ? 'success'
        : 'warning';
    container.innerHTML = `
      ${this.kpiCard('Gera\u00e7\u00e3o Total', `${this.formatNumber(g.total_kwh, 1)} kWh`, 'Energia solar acumulada no per\u00edodo', 'solar')}
      ${this.kpiCard('M\u00e9dia Di\u00e1ria', `${this.formatNumber(g.media_kwh_dia, 1)} kWh`, `${g.dias_monitorados || 0} dias monitorados`, 'info')}
      ${this.kpiCard('CO\u00b2 Evitado', `${this.formatNumber(g.co2_evitado_kg, 1)} kg`, 'Estimativa operacional de sustentabilidade', 'success')}
      ${this.kpiCard('M\u00eas atual vs anterior', comparisonValue, comparisonSubtitle, comparisonType)}
      ${this.kpiCard('Melhor Dia', stats.melhor_dia ? `${this.formatNumber(stats.melhor_dia.energia, 1)} kWh` : '--', stats.melhor_dia ? this.formatDate(stats.melhor_dia.data) : 'Sem dados', 'warning')}
    `;
  },

  renderSustentabilidade(stats) {
    const g = stats.geral || {};
    const container = document.getElementById('energia-sustentabilidade');
    if (!container) return;
    container.innerHTML = `
      <h3 class="card-title">IMPACTO SUSTENTÁVEL</h3>
      <div class="energy-insight-list">
        <div><strong>${this.formatNumber(g.total_kwh, 1)} kWh</strong><span>Energia renovável registrada</span></div>
        <div><strong>${this.formatNumber(g.co2_evitado_kg, 1)} kg CO₂</strong><span>Emissão evitada estimada</span></div>
        <div><strong>${this.formatNumber(g.arvores_equivalentes_ano, 2)}</strong><span>Árvores/ano equivalentes</span></div>
        <div><strong>${this.formatNumber(g.maior_kwh, 1)} kWh</strong><span>Pico de geração diária</span></div>
      </div>
      <p class="energy-reference">Base operacional: fator de emissão configurável por ambiente e rastreabilidade por planta.</p>
    `;
  },

  renderGeracaoChart(rows) {
    const canvas = document.getElementById('chart-energia-geracao');
    if (!canvas) return;
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    const data = [...rows].reverse();
    const colors = NMCharts.getThemeColors();
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.map(row => this.formatDate(row.data)),
        datasets: [{
          label: 'Geração (kWh)',
          data: data.map(row => row.energia),
          backgroundColor: 'rgba(38,194,129,0.55)',
          borderColor: '#26C281',
          borderWidth: 1,
          borderRadius: 5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: colors.text } } },
        scales: {
          x: { grid: { color: colors.grid }, ticks: { color: colors.text, maxTicksLimit: 12 } },
          y: { grid: { color: colors.grid }, ticks: { color: colors.text }, title: { display: true, text: 'kWh', color: colors.text } },
        },
      },
    });
  },

  renderGeracaoTable(rows) {
    const tbody = document.getElementById('energia-geracao-table-body');
    const info = document.getElementById('energia-geracao-table-info');
    if (!tbody) return;
    if (info) info.textContent = `${rows.length} registros`;
    tbody.innerHTML = rows.slice(0, 120).map(row => {
      const co2 = row.energia * (this.limits?.co2KgPorKwh || 0.04);
      return `
        <tr>
          <td>${this.formatDate(row.data)}</td>
          <td>${row.planta || '--'}</td>
          <td><strong>${this.formatNumber(row.energia, 2)} kWh</strong></td>
          <td>${this.formatNumber(co2, 2)} kg</td>
        </tr>
      `;
    }).join('');
  },

  renderRedeKpis(stats, atual) {
    const g = stats.geral || {};
    const container = document.getElementById('energia-iot-kpis');
    if (!container) return;
    container.innerHTML = `
      ${this.kpiCard('Fornecedor Atual', atual?.fornecedor_energia || '--', atual?.data_hora_registro ? this.formatDateTime(atual.data_hora_registro) : 'Sem leitura', atual?.fornecedor_energia === 'GERADOR' ? 'warning' : 'info')}
      ${this.kpiCard('Status da Rede', atual?.status_rede || '--', `Criticidade: ${atual?.criticidade || '--'}`, atual?.alarme_ativo === 'SIM' ? 'danger' : 'success')}
      ${this.kpiCard('Alarmes', String(g.total_alarmes || 0), `${g.leituras_invalidas || 0} leituras inválidas`, (g.total_alarmes || 0) > 0 ? 'danger' : 'success')}
      ${this.kpiCard('Uso do Gerador', `${this.formatNumber(g.gerador_pct, 1)}%`, `${g.leituras_gerador || 0} leituras no período`, 'warning')}
    `;
  },

  renderFasesAtual(atual) {
    const container = document.getElementById('energia-fases-atual');
    if (!container) return;
    if (!atual) {
      container.innerHTML = '<div class="card">Nenhuma leitura elétrica encontrada.</div>';
      return;
    }

    const phases = [
      ['V1', atual.v1_tensao_v, atual.v1_status_normativo],
      ['V2', atual.v2_tensao_v, atual.v2_status_normativo],
      ['V3', atual.v3_tensao_v, atual.v3_status_normativo],
      ['V1 & V2', atual.v12_tensao_v, atual.v12_status_normativo],
      ['V2 & V3', atual.v23_tensao_v, atual.v23_status_normativo],
      ['V1 & V3', atual.v13_tensao_v, atual.v13_status_normativo],
    ];

    container.innerHTML = phases.map(([label, value, status]) => `
      <div class="phase-card ${status}">
        <span class="phase-label">${label}</span>
        <strong>${value == null ? '--' : this.formatNumber(value, 1)} V</strong>
        <small>${this.statusLabel(status)}</small>
      </div>
    `).join('');
  },

  renderRedeChart(rows) {
    const canvas = document.getElementById('chart-energia-tensao');
    if (!canvas) return;
    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();

    const data = [...rows].reverse();
    const colors = NMCharts.getThemeColors();
    const labels = data.map(row => this.formatTime(row.data_hora_registro));
    new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          this.lineDataset('V1', data.map(row => row.v1_tensao_v), '#2E95FF'),
          this.lineDataset('V2', data.map(row => row.v2_tensao_v), '#26C281'),
          this.lineDataset('V3', data.map(row => row.v3_tensao_v), '#FF8A00'),
          this.limitDataset(`Mín. ${this.limits.faseNeutro.min} V`, labels, this.limits.faseNeutro.min, 'rgba(241,196,15,0.5)'),
          this.limitDataset(`Máx. ${this.limits.faseNeutro.max} V`, labels, this.limits.faseNeutro.max, 'rgba(231,76,60,0.5)'),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: colors.text } } },
        scales: {
          x: { grid: { color: colors.grid }, ticks: { color: colors.text, maxTicksLimit: 12 } },
          y: { grid: { color: colors.grid }, ticks: { color: colors.text }, suggestedMin: 190, suggestedMax: 240, title: { display: true, text: 'Volts', color: colors.text } },
        },
      },
    });
  },

  renderRedeInsights(stats, atual) {
    const g = stats.geral || {};
    const container = document.getElementById('energia-rede-insights');
    if (!container) return;
    container.innerHTML = `
      <h3 class="card-title">QUALIDADE ELÉTRICA</h3>
      <div class="energy-insight-list">
        <div><strong>${this.formatNumber(g.media_fn, 1)} V</strong><span>Média fase-neutro</span></div>
        <div><strong>${this.formatNumber(g.media_ff, 1)} V</strong><span>Média fase-fase estimada</span></div>
        <div><strong>${this.formatNumber(g.desequilibrio_max, 2)}%</strong><span>Maior desequilíbrio</span></div>
        <div><strong>${atual?.fases_afetadas || 'Nenhuma'}</strong><span>Fases afetadas na última leitura</span></div>
      </div>
      <p class="energy-reference">Referência operacional: faixa fase-neutro ${this.limits.faseNeutro.min}–${this.limits.faseNeutro.max} V e desequilíbrio máximo ${this.limits.desequilibrioMaxPct}%.</p>
    `;
  },

  renderInconformidades(rows) {
    const tbody = document.getElementById('energia-inconformidades-body');
    const info = document.getElementById('energia-inconformidades-info');
    if (!tbody) return;
    if (info) info.textContent = `${rows.length} registros`;
    tbody.innerHTML = rows.length ? rows.map(row => `
      <tr>
        <td>${this.formatDateTime(row.data_hora_registro)}</td>
        <td><span class="status-pill ${row.alarme_ativo === 'SIM' ? 'off' : 'on'}">${row.status_rede}</span></td>
        <td>${row.criticidade || '--'}</td>
        <td>${row.fornecedor_energia || '--'}</td>
        <td>${row.fases_afetadas || '--'}</td>
        <td>${row.observacao || '--'}</td>
      </tr>
    `).join('') : '<tr><td colspan="6">Nenhuma inconformidade encontrada no período.</td></tr>';
  },

  async generatePdf() {
    App.showLoading('Gerando PDF de energia...', 'Montando relatório com resumo e detalhamento. Esse processo pode levar alguns segundos.');
    App.setButtonLoading('btn-energia-report-pdf', true, 'Gerando PDF...');
    const tipo = document.getElementById('energia-report-tipo')?.value || 'geracao';
    const inicio = document.getElementById('energia-report-inicio')?.value || '';
    const fim = document.getElementById('energia-report-fim')?.value || '';
    const params = new URLSearchParams();
    if (inicio) params.set('inicio', tipo === 'rede' ? `${inicio} 00:00:00` : inicio);
    if (fim) params.set('fim', tipo === 'rede' ? `${fim} 23:59:59` : fim);
    const suffix = params.toString() ? `?${params.toString()}` : '';

    try {
      if (tipo === 'rede') {
        const [stats, rows] = await Promise.all([
          API.get(`/api/energia/iot/stats${suffix}`),
          API.get(`/api/energia/iot/historico${suffix}`),
        ]);
        await this.buildEnergyPdf('RELATÓRIO DE MONITORAMENTO DA REDE ELÉTRICA', stats.geral, rows, 'rede', inicio, fim);
        return;
      }

      const [stats, rows] = await Promise.all([
        API.get(`/api/energia/geracao/stats${suffix}`),
        API.get(`/api/energia/geracao/historico${suffix}`),
      ]);
      await this.buildEnergyPdf('RELATÓRIO DE GERAÇÃO DE ENERGIA SOLAR', stats.geral, rows, 'geracao', inicio, fim);
    } catch (err) {
      console.error('Error generating energy PDF:', err);
      alert('Erro ao gerar PDF de energia. Verifique os filtros e tente novamente.');
    } finally {
      App.setButtonLoading('btn-energia-report-pdf', false);
      App.hideLoading();
    }
  },

  async buildEnergyPdf(title, summary, rows, type, inicio, fim) {
    const { PDFDocument, rgb } = PDFLib;
    const pdfDoc = await PDFDocument.create();
    
    // Register fontkit
    pdfDoc.registerFontkit(window.fontkit);
    
    // Load Arial and Arial Bold fonts locally
    const [arialBytes, arialBoldBytes] = await Promise.all([
      fetch('/arial.ttf').then(res => res.arrayBuffer()),
      fetch('/arialbd.ttf').then(res => res.arrayBuffer()),
    ]);
    
    const fontRegular = await pdfDoc.embedFont(arialBytes);
    const fontBold = await pdfDoc.embedFont(arialBoldBytes);
    
    let page = pdfDoc.addPage([595.28, 841.89]);
    const { width, height } = page.getSize();
    const blue = rgb(11 / 255, 35 / 255, 92 / 255);
    const cyan = rgb(0, 179 / 255, 198 / 255);
    const dark = rgb(30 / 255, 35 / 255, 41 / 255);
    const gray = rgb(120 / 255, 135 / 255, 148 / 255);
    const light = rgb(242 / 255, 244 / 255, 247 / 255);

    page.drawRectangle({ x: 0, y: height - 96, width, height: 96, color: blue });
    try {
      const logoResponse = await fetch('/logo-dark.png');
      const logoBytes = await logoResponse.arrayBuffer();
      const logoImage = await pdfDoc.embedPng(logoBytes);
      const logoDims = logoImage.scale(Math.min(120 / logoImage.width, 54 / logoImage.height));
      page.drawImage(logoImage, { x: 40, y: height - 78, width: logoDims.width, height: logoDims.height });
    } catch (err) {
      page.drawText('NM SERVIÇOS', { x: 40, y: height - 58, size: 18, font: fontBold, color: rgb(1, 1, 1) });
    }

    page.drawText('ENERGIA ELÉTRICA | HRRM', { x: width - 190, y: height - 56, size: 11, font: fontBold, color: rgb(1, 1, 1) });
    page.drawText(title, { x: 40, y: height - 132, size: 13, font: fontBold, color: dark });
    
    const formatInputDate = (dateStr) => {
      if (!dateStr) return '';
      const parts = dateStr.split('-');
      if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
      return dateStr;
    };
    const periodStr = `Período: ${inicio ? formatInputDate(inicio) : 'Início'} a ${fim ? formatInputDate(fim) : 'Atual'}`;
    page.drawText(periodStr, { x: 40, y: height - 150, size: 9, font: fontRegular, color: gray });
    
    const emitStr = `Emitido em: ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`;
    page.drawText(emitStr, { x: width - 200, y: height - 150, size: 9, font: fontRegular, color: gray });

    let y = height - 210;
    const cards = type === 'geracao'
      ? [
          ['Total Gerado', `${this.formatNumber(summary.total_kwh, 1)} kWh`],
          ['Média Diária', `${this.formatNumber(summary.media_kwh_dia, 1)} kWh`],
          ['CO2 Evitado', `${this.formatNumber(summary.co2_evitado_kg, 1)} kg`],
        ]
      : [
          ['Leituras', String(summary.total_leituras || 0)],
          ['Alarmes', String(summary.total_alarmes || 0)],
          ['Gerador', `${this.formatNumber(summary.gerador_pct, 1)}%`],
        ];

    cards.forEach((card, index) => {
      const x = 40 + index * 175;
      page.drawRectangle({ x, y, width: 158, height: 54, color: light });
      page.drawText(card[0], { x: x + 10, y: y + 36, size: 7, font: fontBold, color: gray });
      page.drawText(card[1], { x: x + 10, y: y + 13, size: 17, font: fontBold, color: index === 1 ? cyan : blue });
    });

    y -= 38;
    page.drawText('Detalhamento', { x: 40, y, size: 10, font: fontBold, color: dark });
    y -= 20;
    const headers = type === 'geracao'
      ? ['Data', 'Planta', 'Geração kWh', 'CO2 evitado kg']
      : ['Data/Hora', 'Fornecedor', 'V1', 'V2', 'V3', 'Status'];
    const widths = type === 'geracao' ? [95, 170, 100, 120] : [120, 92, 58, 58, 58, 120];

    const drawHeader = () => {
      page.drawRectangle({ x: 40, y: y - 5, width: width - 80, height: 18, color: blue });
      let x = 45;
      headers.forEach((header, index) => {
        page.drawText(header, { x, y, size: 7, font: fontBold, color: rgb(1, 1, 1) });
        x += widths[index];
      });
    };

    drawHeader();
    for (const [index, row] of rows.entries()) {
      y -= 18;
      if (y < 55) {
        page = pdfDoc.addPage([595.28, 841.89]);
        y = 800;
        drawHeader();
        y -= 18;
      }
      if (index % 2 === 0) page.drawRectangle({ x: 40, y: y - 5, width: width - 80, height: 18, color: light });
      const values = type === 'geracao'
        ? [this.formatDate(row.data), row.planta || '--', this.formatNumber(row.energia, 2), this.formatNumber(row.energia * this.limits.co2KgPorKwh, 2)]
        : [this.formatDateTime(row.data_hora_registro), row.fornecedor_energia || '--', this.formatNumber(row.v1_tensao_v, 1), this.formatNumber(row.v2_tensao_v, 1), this.formatNumber(row.v3_tensao_v, 1), row.status_rede || '--'];
      let x = 45;
      values.forEach((value, valueIndex) => {
        page.drawText(String(value), { x, y, size: 7, font: fontRegular, color: dark });
        x += widths[valueIndex];
      });
    }

    page.drawText('Referências: ANEEL PRODIST Módulo 8 para qualidade de fornecimento; gestão hospitalar com foco em continuidade e rastreabilidade operacional.', {
      x: 40,
      y: 24,
      size: 7,
      font: fontRegular,
      color: gray,
    });

    const pdfBytes = await pdfDoc.save();
    this.downloadPdf(pdfBytes, `Relatorio_Energia_${type}_${new Date().toISOString().slice(0, 10)}`);
  },

  downloadPdf(pdfBytes, filename) {
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  kpiCard(label, value, subtitle, type = 'info') {
    return `
      <div class="energy-kpi-card ${type}">
        <span>${label}</span>
        <strong>${value}</strong>
        <small>${subtitle}</small>
      </div>
    `;
  },

  lineDataset(label, data, color) {
    return {
      label,
      data,
      borderColor: color,
      backgroundColor: `${color}22`,
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: false,
    };
  },

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

  statusLabel(status) {
    return {
      normal: 'Adequado',
      atencao: 'Atenção',
      critico: 'Crítico',
      sem_leitura: 'Sem leitura',
    }[status] || status || '--';
  },

  formatNumber(value, decimals = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    return number.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  },

  formatDate(value) {
    if (!value) return '--';
    return new Date(value).toLocaleDateString('pt-BR');
  },

  formatDateInput(value) {
    const date = new Date(value);
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  },

  formatDateTime(value) {
    if (!value) return '--';
    return new Date(value).toLocaleString('pt-BR');
  },

  formatTime(value) {
    if (!value) return '--';
    return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  },
};
