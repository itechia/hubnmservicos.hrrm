/* ═══════════════════════════════════════════════
   ALERTAS — Central de Alertas RDC50
   ═══════════════════════════════════════════════ */

const Alertas = {
  async init() {
    document.getElementById('btn-apply-alertas-filters')?.addEventListener('click', () => this.refresh());
    await this.refresh();
  },

  async refresh() {
    try {
      const centroCusto = document.getElementById('alertas-centro-custo')?.value
        || document.getElementById('global-centro-custo')?.value
        || '';
      let url = '/api/temperatura/alertas?limit=100';
      if (centroCusto) url += `&centro_custo=${encodeURIComponent(centroCusto)}`;
      const data = await API.get(url);
      this.renderCounters(data.contagem);
      this.renderTimeline(data.alertas);
    } catch (e) {
      console.error('Error loading alerts:', e);
    }
  },

  renderCounters(contagem) {
    const tempEl = document.getElementById('counter-temp-value');
    const umidEl = document.getElementById('counter-umid-value');

    if (tempEl) tempEl.textContent = contagem?.alertas_temp || 0;
    if (umidEl) umidEl.textContent = contagem?.alertas_umid || 0;
  },

  renderTimeline(alertas) {
    const container = document.getElementById('alert-timeline');
    if (!container) return;

    if (!alertas || alertas.length === 0) {
      container.innerHTML = `
        <div class="alert-timeline-item" style="border-color: var(--nm-verde);">
          <div class="alert-timeline-icon" style="background:rgba(38,194,129,0.15);color:var(--nm-verde);">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
          <div class="alert-timeline-body">
            <div class="alert-timeline-title">Nenhum alerta ativo</div>
            <div class="alert-timeline-desc">Todos os sensores estão operando dentro dos limites RDC50/ANVISA.</div>
          </div>
          <span class="alert-timeline-time">Agora</span>
        </div>
      `;
      return;
    }

    container.innerHTML = alertas.map(a => {
      const isTemp = a.alerta_temp;
      const isUmid = a.alerta_umid;
      let type = 'warning';
      let title = '';
      let desc = '';
      let icon = '';

      if (isTemp === 'temp_alta') {
        type = 'critical';
        title = `Temperatura Elevada — ${a.sala}`;
        desc = `Leitura de ${a.temperatura_c.toFixed(1)}°C (limite máx: ${Dashboard.limits?.temp.max || 30}°C)`;
        icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
      } else if (isTemp === 'temp_baixa') {
        type = 'critical';
        title = `Temperatura Baixa — ${a.sala}`;
        desc = `Leitura de ${a.temperatura_c.toFixed(1)}°C (limite mín: ${Dashboard.limits?.temp.min || 15}°C)`;
        icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
      }

      if (isUmid === 'umid_alta') {
        type = a.alerta_temp ? 'critical' : 'warning';
        title = title ? title + ' + Umidade Alta' : `Umidade Elevada — ${a.sala}`;
        desc += desc ? ` | Umidade: ${a.umidade_pct}%` : `Leitura de ${a.umidade_pct}% (limite máx: ${Dashboard.limits?.umid.max || 70}%)`;
        if (!icon) icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
      } else if (isUmid === 'umid_baixa') {
        type = a.alerta_temp ? 'critical' : 'warning';
        title = title ? title + ' + Umidade Baixa' : `Umidade Reduzida — ${a.sala}`;
        desc += desc ? ` | Umidade: ${a.umidade_pct}%` : `Leitura de ${a.umidade_pct}% (limite mín: ${Dashboard.limits?.umid.min || 40}%)`;
        if (!icon) icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
      }

      return `
        <div class="alert-timeline-item ${type}">
          <div class="alert-timeline-icon">${icon}</div>
          <div class="alert-timeline-body">
            <div class="alert-timeline-title">${title}</div>
            <div class="alert-timeline-desc">${desc}</div>
          </div>
          <span class="alert-timeline-time">${a.data_hora || ''}</span>
        </div>
      `;
    }).join('');
  },
};
