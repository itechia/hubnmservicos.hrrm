/* Dashboard — Visão Geral (Real-Time) */

const Dashboard = {
  chart24h: null,
  limits: null,

  async init() {
    await this.loadLimits();
    await this.refresh();
  },

  async loadLimits() {
    try {
      const centroCusto = App.getCentroCustoFilter?.() || '';
      const suffix = centroCusto ? `?centro_custo=${encodeURIComponent(centroCusto)}` : '';
      const res = await API.get(`/api/config/limites${suffix}`);
      this.limits = res;
    } catch (e) {
      this.limits = { temp: { min: 15, max: 30, target: 22 }, umid: { min: 40, max: 70, target: 55 } };
    }
  },

  async refresh() {
    try {
      const centroCusto = App.getCentroCustoFilter?.() || '';
      const centroQuery = centroCusto ? `&centro_custo=${encodeURIComponent(centroCusto)}` : '';
      const centroQueryStart = centroCusto ? `?centro_custo=${encodeURIComponent(centroCusto)}` : '';
      await this.loadLimits();
      const [current, histData, stats, alertsData] = await Promise.all([
        API.get(`/api/temperatura/atual${centroQueryStart}`),
        API.get(`/api/temperatura/historico?limit=500${centroQuery}`),
        API.get(`/api/temperatura/stats${centroQueryStart}`),
        API.get(`/api/temperatura/alertas?limit=10${centroQuery}`),
      ]);

      this.renderConditions(current, stats);
      this.renderSetpoints(current);
      this.renderRoomCards(current);
      this.renderChart24h(histData);
      this.renderChartStats(stats);
      this.renderAlertsBar(alertsData);
      this.updateSidebarSummary(current, stats);
      this.updateAlertBadge(alertsData);

      // Update last update time in header status
      const now = new Date();
      const lastUpdateEl = document.getElementById('last-update-time');
      if (lastUpdateEl) {
        lastUpdateEl.textContent = now.toLocaleDateString('pt-BR') + ' ' + now.toLocaleTimeString('pt-BR');
      }
    } catch (e) {
      console.error('Dashboard refresh error:', e);
    }
  },

  renderConditions(current, stats) {
    const container = document.getElementById('conditions-grid');
    if (!container) return;

    // Calculate averages from current readings
    const avgTemp = current.reduce((s, r) => s + r.temperatura_c, 0) / (current.length || 1);
    const avgUmid = current.reduce((s, r) => s + r.umidade_pct, 0) / (current.length || 1);
    const onlineCount = current.filter(r => r.online === 'Sim').length;

    const tempPct = this.valueToPercent(avgTemp, this.limits.temp.min - 5, this.limits.temp.max + 10);
    const umidPct = this.valueToPercent(avgUmid, 0, 100);

    container.innerHTML = `
      <div class="condition-item">
        ${this.createGaugeSVG(tempPct, this.getStatusColor(avgTemp, this.limits.temp), `
          <span class="big-number">${avgTemp.toFixed(1)}</span>
          <span class="unit">°C</span>
        `)}
        <div class="condition-label">Temperatura Média</div>
        <div class="condition-sub">Alvo: ${this.formatTarget(this.limits.temp.target, '°C')} | Faixa: ${this.limits.temp.min}–${this.limits.temp.max}°C</div>
      </div>

      <div class="condition-item">
        ${this.createGaugeSVG(umidPct, this.getStatusColor(avgUmid, this.limits.umid), `
          <span class="big-number">${this.formatHumidity(avgUmid)}</span>
          <span class="unit">%</span>
        `)}
        <div class="condition-label">Umidade Média</div>
        <div class="condition-sub">Alvo: ${this.formatTarget(this.limits.umid.target, '%')} | Faixa: ${this.limits.umid.min}–${this.limits.umid.max}%</div>
      </div>

      <div class="condition-item">
        ${this.createGaugeSVG((onlineCount / (current.length || 1)) * 100, onlineCount === current.length ? '#26C281' : '#F1C40F', `
          <span class="big-number">${onlineCount}/${current.length}</span>
          <span class="unit">ON</span>
        `)}
        <div class="condition-label">Sensores Online</div>
        <div class="condition-sub">${current.length - onlineCount} offline</div>
      </div>
    `;

    // Indicators
    const indicators = document.getElementById('conditions-indicators');
    if (indicators) {
      const tempStatus = this.classifyComfort(avgTemp, this.limits.temp);
      const umidStatus = this.classifyComfort(avgUmid, this.limits.umid);
      const trend = this.calculateTrend(avgTemp);

      indicators.innerHTML = `
        <div class="indicator-item">
          <span class="indicator-label">Conforto</span>
          <span class="indicator-value ${tempStatus.class}">${tempStatus.label}</span>
        </div>
        <div class="indicator-item">
          <span class="indicator-label">Tendência</span>
          <span class="indicator-value normal">${trend.icon} ${trend.label}</span>
        </div>
        <div class="indicator-item">
          <span class="indicator-label">Umidade</span>
          <span class="indicator-value ${umidStatus.class}">${umidStatus.label}</span>
        </div>
      `;
    }
  },

  renderConditions(current, stats) {
    const container = document.getElementById('conditions-grid');
    if (!container) return;

    const avgTemp = current.reduce((sum, reading) => sum + reading.temperatura_c, 0) / (current.length || 1);
    const avgUmid = current.reduce((sum, reading) => sum + reading.umidade_pct, 0) / (current.length || 1);
    const onlineCount = current.filter(reading => reading.online === 'Sim').length;
    const umidPct = this.valueToPercent(avgUmid, 0, 100);

    container.innerHTML = `
      <div class="condition-readout condition-readout-temp">
        <div class="readout-icon">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 14.76V5a4 4 0 0 0-8 0v9.76a6 6 0 1 0 8 0Z"/><path d="M10 5v13"/></svg>
        </div>
        <div>
          <div class="condition-label">Temperatura Média</div>
          <div class="readout-value temp">${avgTemp.toFixed(1)}<span>°C</span></div>
          <div class="condition-sub">Alvo: ${this.formatTarget(this.limits.temp.target, '°C')}</div>
          <div class="condition-sub">Faixa: ${this.limits.temp.min} - ${this.limits.temp.max} °C</div>
        </div>
      </div>

      <div class="condition-humidity-center">
        ${this.createGaugeSVG(umidPct, this.getStatusColor(avgUmid, this.limits.umid), `
          <span class="big-number">${this.formatHumidity(avgUmid)}</span>
          <span class="unit">%</span>
        `)}
        <div class="condition-label">Umidade Média</div>
      </div>

      <div class="condition-readout condition-readout-sensors">
        <div class="readout-icon">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="10" rx="2"/><path d="M8 19h8"/><path d="M12 15v4"/><path d="M8 9h8"/></svg>
        </div>
        <div>
          <div class="condition-label">Sensores Monitorados</div>
          <div class="readout-value sensors">${onlineCount}<span>/${current.length}</span></div>
          <div class="condition-sub">Online: ${onlineCount}</div>
          <div class="condition-sub">Offline: ${current.length - onlineCount}</div>
          <div class="condition-sub">Médias: ${avgTemp.toFixed(1)} °C · ${this.formatHumidity(avgUmid)}%</div>
        </div>
      </div>
    `;

    const indicators = document.getElementById('conditions-indicators');
    if (indicators) {
      const tempStatus = this.classifyComfort(avgTemp, this.limits.temp);
      const umidStatus = this.classifyComfort(avgUmid, this.limits.umid);
      const trend = this.calculateTrend(avgTemp);

      indicators.innerHTML = `
        <div class="indicator-item">
          <span class="indicator-icon">&#9787;</span>
          <span class="indicator-label">Conforto</span>
          <span class="indicator-value ${tempStatus.class}">${tempStatus.label}</span>
        </div>
        <div class="indicator-item">
          <span class="indicator-icon">→</span>
          <span class="indicator-label">Tendência</span>
          <span class="indicator-value normal">${trend.label}</span>
        </div>
        <div class="indicator-item">
          <span class="indicator-icon">✣</span>
          <span class="indicator-label">Qualidade Geral</span>
          <span class="indicator-value ${umidStatus.class}">${umidStatus.label}</span>
        </div>
      `;
    }
  },

  renderSetpoints(current) {
    const container = document.getElementById('setpoints-content');
    if (!container) return;

    const avgTemp = current.reduce((s, r) => s + r.temperatura_c, 0) / (current.length || 1);
    const avgUmid = current.reduce((s, r) => s + r.umidade_pct, 0) / (current.length || 1);

    const tempPct = ((avgTemp - this.limits.temp.min) / (this.limits.temp.max - this.limits.temp.min)) * 100;
    const umidPct = ((avgUmid - this.limits.umid.min) / (this.limits.umid.max - this.limits.umid.min)) * 100;

    container.innerHTML = `
      <div class="setpoint-item">
        <div class="setpoint-header">
          <span class="setpoint-label">Temperatura Alvo</span>
          <span class="setpoint-value">${this.formatTarget(this.limits.temp.target, '°C')}</span>
        </div>
        <div class="setpoint-range">
          <span>${this.limits.temp.min}°C</span>
          <div class="range-bar">
            <div class="range-fill" style="left:0;right:0;background:linear-gradient(90deg,#26C281 0%,#26C281 20%,#F1C40F 20%,#008BC6 40%,#008BC6 60%,#F1C40F 80%,#E74C3C 100%)"></div>
            <div class="range-marker" style="left:${Math.max(0, Math.min(100, tempPct))}%"></div>
          </div>
          <span>${this.limits.temp.max}°C</span>
        </div>
      </div>

      <div class="setpoint-item">
        <div class="setpoint-header">
          <span class="setpoint-label">Umidade Alvo</span>
          <span class="setpoint-value">${this.formatTarget(this.limits.umid.target, '%')}</span>
        </div>
        <div class="setpoint-range">
          <span>${this.limits.umid.min}%</span>
          <div class="range-bar">
            <div class="range-fill" style="left:0;right:0;background:linear-gradient(90deg,#E74C3C 0%,#F1C40F 15%,#008BC6 35%,#008BC6 65%,#F1C40F 85%,#E74C3C 100%)"></div>
            <div class="range-marker" style="left:${Math.max(0, Math.min(100, umidPct))}%"></div>
          </div>
          <span>${this.limits.umid.max}%</span>
        </div>
      </div>

      <div class="setpoint-item" style="background: rgba(0,139,198,0.05); border-color: rgba(0,139,198,0.2);">
        <div class="setpoint-header">
          <span class="setpoint-label">Norma</span>
          <span class="setpoint-value" style="font-size:var(--fs-sm);color:var(--nm-azul-profundo);">${this.limits.norma || 'RDC50 / ANVISA'}</span>
        </div>
        <div style="font-size:var(--fs-xs);color:var(--text-muted);">
          ${this.getLimitsDescription(current)}
        </div>
      </div>
    `;
  },

  renderSetpoints(current) {
    const container = document.getElementById('setpoints-content');
    if (!container) return;

    const avgTemp = current.reduce((sum, reading) => sum + reading.temperatura_c, 0) / (current.length || 1);
    const avgUmid = current.reduce((sum, reading) => sum + reading.umidade_pct, 0) / (current.length || 1);
    const tempPct = ((avgTemp - this.limits.temp.min) / (this.limits.temp.max - this.limits.temp.min)) * 100;
    const umidPct = ((avgUmid - this.limits.umid.min) / (this.limits.umid.max - this.limits.umid.min)) * 100;

    container.innerHTML = `
      <div class="setpoint-item setpoint-control">
        <div class="setpoint-header">
          <span class="setpoint-label">Temperatura Alvo</span>
          <span class="setpoint-value temp">${this.formatTarget(this.limits.temp.target, '°C')}</span>
        </div>
        <div class="setpoint-range">
          <span>${this.limits.temp.min} °C</span>
          <div class="range-bar">
            <div class="range-fill temp-fill"></div>
            <div class="range-marker" style="left:${Math.max(0, Math.min(100, tempPct))}%"></div>
          </div>
          <span>${this.limits.temp.max} °C</span>
        </div>
      </div>

      <div class="setpoint-item setpoint-control">
        <div class="setpoint-header">
          <span class="setpoint-label">Umidade Alvo</span>
          <span class="setpoint-value umid">${this.formatTarget(this.limits.umid.target, '%')}</span>
        </div>
        <div class="setpoint-range">
          <span>${this.limits.umid.min}%</span>
          <div class="range-bar">
            <div class="range-fill umid-fill"></div>
            <div class="range-marker" style="left:${Math.max(0, Math.min(100, umidPct))}%"></div>
          </div>
          <span>${this.limits.umid.max}%</span>
        </div>
      </div>

      <div class="setpoint-item standard-note">
        <div class="setpoint-header">
          <span class="setpoint-label">Norma</span>
          <span class="setpoint-badge">${this.limits.norma || 'RDC50 / ANVISA'}</span>
        </div>
        <div class="condition-sub">${this.getLimitsDescription(current)}</div>
      </div>
    `;
  },

  renderRoomCards(rooms) {
    const container = document.getElementById('rooms-section');
    if (!container) return;

    // Sort rooms: critico first, then atencao, then normal
    const sortedRooms = [...rooms].sort((a, b) => {
      const getScore = (r) => {
        if (r.temp_status === 'critico' || r.umid_status === 'critico') return 2;
        if (r.temp_status === 'atencao' || r.umid_status === 'atencao') return 1;
        return 0;
      };
      return getScore(b) - getScore(a);
    });

    container.innerHTML = sortedRooms.map(room => {
      const tempStatus = this.classifyComfort(room.temperatura_c, this.limits.temp);
      const overallStatus = room.temp_status === 'critico' || room.umid_status === 'critico'
        ? 'critico' : room.temp_status === 'atencao' || room.umid_status === 'atencao'
          ? 'atencao' : 'normal';

      return `
        <div class="room-card ${overallStatus}">
          <div class="room-header">
            <div>
              <div class="room-name">${room.sala || 'Sala'}</div>
              <div class="room-sector">${room.centro_custo || ''} · Cód: ${room.codigo_sala}</div>
            </div>
            <div class="room-online">
              <span class="online-dot ${room.online === 'Sim' ? 'on' : 'off'}"></span>
              ${room.online === 'Sim' ? 'Online' : 'Offline'}
            </div>
          </div>
          <div class="room-metrics">
            <div class="room-metric">
              <div class="room-metric-value temp">${room.temperatura_c.toFixed(1)}°C</div>
              <div class="room-metric-label">Temperatura</div>
            </div>
            <div class="room-metric">
              <div class="room-metric-value umid">${this.formatHumidity(room.umidade_pct)}%</div>
              <div class="room-metric-label">Umidade</div>
            </div>
          </div>
          <div class="room-meta">
            <span>Bateria: ${room.bateria || '--'}</span>
            <span>${room.data_hora || '--'}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  renderRoomCards(rooms) {
    const container = document.getElementById('rooms-section');
    if (!container) return;

    const sortedRooms = [...rooms].sort((a, b) => this.getRoomPriority(b) - this.getRoomPriority(a));

    container.innerHTML = `
      <div class="equipment-panel-title">Equipamentos Monitorados</div>
      ${sortedRooms.map(room => {
        const overallStatus = room.online !== 'Sim'
          ? 'critico'
          : room.temp_status === 'critico' || room.umid_status === 'critico'
            ? 'critico' : room.temp_status === 'atencao' || room.umid_status === 'atencao'
              ? 'atencao' : 'normal';

        return `
          <div class="room-card equipment-row ${overallStatus}">
            <div class="equipment-status-side">
              <div class="equipment-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="8" rx="2"/><path d="M7 17h.01M12 17h.01M17 17h.01"/><path d="M8 13v6M16 13v6"/></svg>
              </div>
              <div class="room-online status-pill ${room.online === 'Sim' ? 'on' : 'off'}">${room.online === 'Sim' ? 'Ligado' : 'Offline'}</div>
            </div>
            <div class="equipment-body">
              <div class="room-header">
                <div>
                  <div class="room-name">${room.sala || 'Sala'}</div>
                  <div class="room-sector">${room.centro_custo || ''} · Cód: ${room.codigo_sala}</div>
                </div>
              </div>
              <div class="equipment-meta">
                <span>Temp. saída: ${room.temperatura_c.toFixed(1)} °C</span>
                <span>Umid.: ${this.formatHumidity(room.umidade_pct)}%</span>
                <span>Bateria: ${room.bateria || '--'}</span>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    `;
  },

  renderChart24h(histData) {
    if (!histData || histData.length === 0) return;

    // Group by hour, take most recent 24h
    const grouped = {};
    histData.forEach(r => {
      const key = r.data_hora || '';
      if (!grouped[key]) grouped[key] = { temps: [], umids: [] };
      grouped[key].temps.push(r.temperatura_c);
      grouped[key].umids.push(r.umidade_pct);
    });

    const entries = Object.entries(grouped).slice(0, 48).reverse();
    const labels = entries.map(([k]) => {
      const parts = k.split(' ');
      if (parts.length > 1) {
        const timeParts = parts[1].split(':');
        return timeParts.slice(0, 2).join(':'); // HH:MM
      }
      return k;
    });
    const tempData = entries.map(([, v]) => v.temps.reduce((a, b) => a + b, 0) / v.temps.length);
    const umidData = entries.map(([, v]) => v.umids.reduce((a, b) => a + b, 0) / v.umids.length);

    this.chart24h = NMCharts.createTempHumidChart('chart-24h', labels, tempData, umidData, this.limits);
  },

  renderChartStats(stats) {
    const container = document.getElementById('chart-stats-24h');
    if (!container || !stats.geral) return;

    const g = stats.geral;
    container.innerHTML = `
      <div class="chart-stat">
        <div class="chart-stat-label">Temp. Min / Max</div>
        <div class="chart-stat-value">${g.temp_min.toFixed(1)} / ${g.temp_max.toFixed(1)} °C</div>
      </div>
      <div class="chart-stat">
        <div class="chart-stat-label">Umid. Min / Max</div>
        <div class="chart-stat-value">${this.formatHumidity(g.umid_min)} / ${this.formatHumidity(g.umid_max)} %</div>
      </div>
      <div class="chart-stat">
        <div class="chart-stat-label">Média Geral</div>
        <div class="chart-stat-value">${g.temp_avg.toFixed(1)} °C | ${this.formatHumidity(g.umid_avg)}%</div>
      </div>
      <div class="chart-stat">
        <div class="chart-stat-label">Total Leituras</div>
        <div class="chart-stat-value">${g.total_leituras}</div>
      </div>
    `;
  },

  renderAlertsBar(alertsData) {
    const container = document.getElementById('alerts-bar-content');
    if (!container) return;

    const alerts = alertsData.alertas || [];
    if (alerts.length === 0) {
      container.innerHTML = `
        <div class="alert-bar-item ok">
          <span class="alert-bar-icon">OK</span>
          <span class="alert-bar-text">Todos os parâmetros normais</span>
          <span class="alert-bar-time">${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      `;
      return;
    }

    container.innerHTML = alerts.slice(0, 5).map(a => {
      const isTemp = a.alerta_temp;
      const isUmid = a.alerta_umid;
      const type = (isTemp === 'temp_alta' || isTemp === 'temp_baixa') ? 'critical' : 'warning';
      let icon = '!';
      let text = '';

      if (isTemp === 'temp_alta') { icon = 'T'; text = `Temp. ALTA: ${a.temperatura_c.toFixed(1)}°C — ${a.sala}`; }
      else if (isTemp === 'temp_baixa') { icon = 'T'; text = `Temp. BAIXA: ${a.temperatura_c.toFixed(1)}°C — ${a.sala}`; }
      if (isUmid === 'umid_alta') { icon = 'U'; text = `Umid. ALTA: ${this.formatHumidity(a.umidade_pct)}% — ${a.sala}`; }
      else if (isUmid === 'umid_baixa') { icon = 'U'; text = `Umid. BAIXA: ${this.formatHumidity(a.umidade_pct)}% — ${a.sala}`; }

      return `
        <div class="alert-bar-item ${type}">
          <span class="alert-bar-icon">${icon}</span>
          <span class="alert-bar-text">${text}</span>
          <span class="alert-bar-time">${a.data_hora || ''}</span>
        </div>
      `;
    }).join('');
  },

  updateSidebarSummary(current, stats) {
    const avgTemp = current.reduce((s, r) => s + r.temperatura_c, 0) / (current.length || 1);
    const avgUmid = current.reduce((s, r) => s + r.umidade_pct, 0) / (current.length || 1);
    const onlineCount = current.filter(r => r.online === 'Sim').length;

    document.getElementById('summary-temp').textContent = `${avgTemp.toFixed(1)}°C`;
    document.getElementById('summary-umid').textContent = `${this.formatHumidity(avgUmid)}%`;
    document.getElementById('summary-sensors').textContent = `${onlineCount}/${current.length}`;

    const statusEl = document.getElementById('summary-status');
    const allNormal = current.every(r => r.temp_status === 'normal' && r.umid_status === 'normal');
    statusEl.textContent = allNormal ? 'Normal' : 'Atenção';
    statusEl.style.color = allNormal ? 'var(--nm-verde)' : 'var(--nm-amarelo)';
  },

  updateAlertBadge(alertsData) {
    const badge = document.getElementById('alert-badge');
    const count = (alertsData.alertas || []).length;
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline' : 'none';
    }
  },

  // Helpers
  createGaugeSVG(percent, color, valueHTML) {
    const r = 48;
    const c = 2 * Math.PI * r;
    const offset = c - (Math.min(100, Math.max(0, percent)) / 100) * c;

    return `
      <div class="condition-gauge">
        <svg viewBox="0 0 120 120">
          <circle class="gauge-bg" cx="60" cy="60" r="${r}" />
          <circle class="gauge-fill" cx="60" cy="60" r="${r}"
            stroke="${color}"
            stroke-dasharray="${c}"
            stroke-dashoffset="${offset}" />
        </svg>
        <div class="condition-value">
          ${valueHTML}
        </div>
      </div>
    `;
  },

  valueToPercent(val, min, max) {
    return ((val - min) / (max - min)) * 100;
  },

  formatHumidity(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    return number.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  },

  formatTarget(value, unit = '') {
    const number = Number(value);
    if (!Number.isFinite(number)) return 'Por setor';
    const formatted = number.toLocaleString('pt-BR', { minimumFractionDigits: unit.includes('°') ? 1 : 0, maximumFractionDigits: 1 });
    return `${formatted}${unit}`;
  },

  getLimitsDescription(current = []) {
    if (this.limits?.modo === 'multissetor') {
      const activeRooms = current.filter(reading => reading.online === 'Sim').length;
      return `${activeRooms} salas com sensores ativos e metas individuais`;
    }

    return this.limits?.descricao || 'Área monitorada';
  },

  getRoomPriority(room) {
    if (room.online !== 'Sim') return 5000;

    const statusScore = room.temp_status === 'critico' || room.umid_status === 'critico'
      ? 2000
      : room.temp_status === 'atencao' || room.umid_status === 'atencao'
        ? 1000
        : 0;

    const tempDeviation = this.getLimitDeviation(room.temperatura_c, this.limits.temp);
    const humidityDeviation = this.getLimitDeviation(room.umidade_pct, this.limits.umid);

    return statusScore + Math.max(tempDeviation, humidityDeviation);
  },

  getLimitDeviation(value, limits) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    if (number < limits.min) return limits.min - number;
    if (number > limits.max) return number - limits.max;
    return 0;
  },

  getStatusColor(val, limits) {
    if (val < limits.min || val > limits.max) return '#E74C3C';
    const margin = (limits.max - limits.min) * 0.15;
    if (val < limits.min + margin || val > limits.max - margin) return '#F1C40F';
    return '#26C281';
  },

  classifyComfort(val, limits) {
    if (val < limits.min || val > limits.max) return { label: 'CRÍTICO', class: 'critico' };
    const margin = (limits.max - limits.min) * 0.15;
    if (val < limits.min + margin || val > limits.max - margin) return { label: 'ATENÇÃO', class: 'atencao' };
    const mid = (limits.max + limits.min) / 2;
    const goodRange = (limits.max - limits.min) * 0.25;
    if (Math.abs(val - mid) < goodRange) return { label: 'ÓTIMO', class: 'normal' };
    return { label: 'BOM', class: 'normal' };
  },

  calculateDewPoint(temp, humidity) {
    const a = 17.27;
    const b = 237.7;
    const gamma = ((a * temp) / (b + temp)) + Math.log(Math.max(humidity, 1) / 100);
    return (b * gamma) / (a - gamma);
  },

  calculateTrend() {
    // Simple trend — could be enhanced with actual historical data
    return { icon: '→', label: 'ESTÁVEL' };
  },
};
