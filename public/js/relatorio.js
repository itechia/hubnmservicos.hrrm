/* ═══════════════════════════════════════════════
   RELATÓRIOS — Client-Side PDF Export (pdf-lib)
   ═══════════════════════════════════════════════ */

const Relatorio = {
  init() {
    document.getElementById('btn-generate-pdf')?.addEventListener('click', () => this.generatePDF());
  },

  async generatePDF() {
    const inicio = document.getElementById('report-date-start')?.value || '';
    const fim = document.getElementById('report-date-end')?.value || '';
    const sala = document.getElementById('report-sala')?.value || '';
    const centroCusto = this.getCentroCustoFilter();

    const btn = document.getElementById('btn-generate-pdf');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="btn-loader" style="display:inline-block;"></span> Gerando...';
    btn.disabled = true;

    try {
      // 1. Fetch data from backend JSON endpoints
      let historyUrl = `/api/temperatura/historico?limit=500`;
      let statsUrl = `/api/temperatura/stats?`;
      const queryParts = [];
      if (inicio) queryParts.push(`inicio=${inicio}T00:00:00`);
      if (fim) queryParts.push(`fim=${fim}T23:59:59`);
      if (sala) queryParts.push(`sala=${encodeURIComponent(sala)}`);
      if (centroCusto) queryParts.push(`centro_custo=${encodeURIComponent(centroCusto)}`);

      if (queryParts.length > 0) {
        historyUrl += `&${queryParts.join('&')}`;
        statsUrl += queryParts.join('&');
      }

      const [historyData, statsData] = await Promise.all([
        API.get(historyUrl),
        API.get(statsUrl)
      ]);
      const nomeSala = this.getAmbienteLabel(sala, historyData);

      const g = statsData.geral;
      const limits = statsData.limites || { temp: { min: 15, max: 30 }, umid: { min: 40, max: 70 } };

      // 2. Generate PDF using pdf-lib (client-side)
      if (typeof PDFLib === 'undefined') {
        throw new Error('Biblioteca PDFLib não carregada.');
      }

      const { PDFDocument, StandardFonts, rgb } = PDFLib;
      const pdfDoc = await PDFDocument.create();
      
      // Page size A4 (595.28 x 841.89 points)
      let page = pdfDoc.addPage([595.28, 841.89]);
      const { width, height } = page.getSize();
      
      // Helper function to draw text
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      // Colors matching NM Serviços Guidelines
      const colorNMBlue = rgb(11/255, 35/255, 92/255);      // #0B235C
      const colorNMAco = rgb(61/255, 90/255, 140/255);      // #3D5A8C
      const colorNMCiano = rgb(0/255, 179/255, 198/255);     // #00B3C6
      const colorDark = rgb(30/255, 35/255, 41/255);        // #1E2329
      const colorGray = rgb(120/255, 135/255, 148/255);    // #788794
      const colorLightGray = rgb(242/255, 244/255, 247/255); // #F2F4F7
      const colorRed = rgb(231/255, 76/255, 60/255);        // #E74C3C
      const colorYellow = rgb(241/255, 196/255, 15/255);    // #F1C40F
      const colorGreen = rgb(38/255, 194/255, 129/255);     // #26C281

      // ── Draw Brand Header Block ─────────────────────────────
      page.drawRectangle({
        x: 0,
        y: height - 100,
        width: width,
        height: 100,
        color: colorNMBlue,
      });

      // Try to embed official logo
      try {
        const logoResponse = await fetch('/logo-dark.png');
        if (logoResponse.ok) {
          const logoBytes = await logoResponse.arrayBuffer();
          let logoImage;
          try {
            logoImage = await pdfDoc.embedPng(logoBytes);
          } catch (pngErr) {
            // Fallback if the logo file is actually a JPG/JPEG
            logoImage = await pdfDoc.embedJpg(logoBytes);
          }
          const logoDims = logoImage.scale(Math.min(125 / logoImage.width, 58 / logoImage.height));
          page.drawImage(logoImage, {
            x: 40,
            y: height - 82,
            width: logoDims.width,
            height: logoDims.height,
          });
        }
      } catch (err) {
        console.warn('Failed to embed logo, using text fallback:', err);
        // Fallback text if logo cannot be loaded
        page.drawText('NM SERVIÇOS', {
          x: 40,
          y: height - 60,
          size: 20,
          font: fontBold,
          color: rgb(1, 1, 1),
        });
      }

      page.drawText('Soluções inteligentes em serviços e manutenção', {
        x: 40,
        y: height - 85,
        size: 9,
        font: fontRegular,
        color: rgb(0.9, 0.9, 0.9),
      });

      // Badge
      page.drawRectangle({
        x: width - 150,
        y: height - 65,
        width: 110,
        height: 26,
        color: colorNMCiano,
        opacity: 0.9,
      });
      page.drawText('ANVISA / RDC50', {
        x: width - 138,
        y: height - 55,
        size: 9,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      // Helper function to format date
      const formatInputDate = (dateStr) => {
        if (!dateStr) return '';
        const parts = dateStr.split('-');
        if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
        return dateStr;
      };

      // ── Report Title & Metadata ─────────────────────────────
      let y = height - 140;
      page.drawText('RELATÓRIO INSTITUCIONAL DE CONTROLE DE TEMPERATURA', {
        x: 40,
        y: y,
        size: 13,
        font: fontBold,
        color: colorDark,
      });

      y -= 18;
      const periodStr = `Período: ${inicio ? formatInputDate(inicio) : 'Início'} a ${fim ? formatInputDate(fim) : 'Atual'}`;
      page.drawText(periodStr, { x: 40, y: y, size: 9, font: fontRegular, color: colorGray });
      
      const emitStr = `Emitido em: ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}`;
      page.drawText(emitStr, { x: width - 200, y: y, size: 9, font: fontRegular, color: colorGray });

      y -= 14;
      page.drawText(`Ambiente: ${nomeSala}`, { x: 40, y: y, size: 9, font: fontBold, color: colorNMAco });

      // Divider Line
      y -= 12;
      page.drawLine({
        start: { x: 40, y: y },
        end: { x: width - 40, y: y },
        thickness: 1,
        color: colorLightGray,
      });

      // ── KPI Summary Cards ─────────────────────────────
      y -= 75;
      const cardW = 158;
      const cardH = 55;
      const cardGap = 20;

      // Card 1: Total Leituras
      page.drawRectangle({ x: 40, y: y, width: cardW, height: cardH, color: colorLightGray });
      page.drawText('TOTAL DE LEITURAS', { x: 50, y: y + 38, size: 7, font: fontBold, color: colorGray });
      page.drawText(String(g.total_leituras || 0), { x: 50, y: y + 12, size: 20, font: fontBold, color: colorDark });

      // Card 2: Média Temperatura
      page.drawRectangle({ x: 40 + cardW + cardGap, y: y, width: cardW, height: cardH, color: colorLightGray });
      page.drawText('TEMPERATURA MÉDIA', { x: 40 + cardW + cardGap + 10, y: y + 38, size: 7, font: fontBold, color: colorGray });
      page.drawText(`${g.temp_avg ? g.temp_avg.toFixed(1) : '--'} °C`, { x: 40 + cardW + cardGap + 10, y: y + 12, size: 20, font: fontBold, color: colorNMBlue });

      // Card 3: Média Umidade
      page.drawRectangle({ x: 40 + 2 * (cardW + cardGap), y: y, width: cardW, height: cardH, color: colorLightGray });
      page.drawText('UMIDADE MÉDIA', { x: 40 + 2 * (cardW + cardGap) + 10, y: y + 38, size: 7, font: fontBold, color: colorGray });
      page.drawText(`${g.umid_avg ? parseFloat(g.umid_avg).toFixed(0) : '--'} %`, { x: 40 + 2 * (cardW + cardGap) + 10, y: y + 12, size: 20, font: fontBold, color: colorNMCiano });

      // ── Summary Table ─────────────────────────────
      y -= 35;
      page.drawText('Resumo Estatístico dos Parâmetros', { x: 40, y: y, size: 10, font: fontBold, color: colorDark });
      
      y -= 20;
      // Table Header Background
      page.drawRectangle({ x: 40, y: y - 5, width: width - 80, height: 18, color: colorNMBlue });
      
      const colWidths = [120, 80, 80, 80, 75, 80];
      const headers = ['Métrica', 'Mínimo', 'Máximo', 'Média', 'Limite Min', 'Limite Máx'];
      
      let xPos = 45;
      headers.forEach((hdr, idx) => {
        page.drawText(hdr, { x: xPos, y: y, size: 8, font: fontBold, color: rgb(1, 1, 1) });
        xPos += colWidths[idx];
      });

      // Row 1: Temp
      y -= 18;
      page.drawRectangle({ x: 40, y: y - 5, width: width - 80, height: 18, color: colorLightGray });
      let rowTemp = [
        'Temperatura (°C)',
        g.temp_min ? g.temp_min.toFixed(1) : '--',
        g.temp_max ? g.temp_max.toFixed(1) : '--',
        g.temp_avg ? g.temp_avg.toFixed(1) : '--',
        `${limits.temp.min} °C`,
        `${limits.temp.max} °C`
      ];
      xPos = 45;
      rowTemp.forEach((val, idx) => {
        page.drawText(val, { x: xPos, y: y, size: 8, font: fontRegular, color: colorDark });
        xPos += colWidths[idx];
      });

      // Row 2: Umid
      y -= 18;
      let rowUmid = [
        'Umidade (%)',
        g.umid_min ? String(g.umid_min) : '--',
        g.umid_max ? String(g.umid_max) : '--',
        g.umid_avg ? parseFloat(g.umid_avg).toFixed(1) : '--',
        `${limits.umid.min} %`,
        `${limits.umid.max} %`
      ];
      xPos = 45;
      rowUmid.forEach((val, idx) => {
        page.drawText(val, { x: xPos, y: y, size: 8, font: fontRegular, color: colorDark });
        xPos += colWidths[idx];
      });

      // Helper function to draw Footer on any page
      const drawFooter = (p) => {
        p.drawText(`NM Serviços | Central de Monitoramento HRRM | Relatório gerado em ${new Date().toLocaleString('pt-BR')}`, {
          x: 40,
          y: 20,
          size: 7,
          font: fontRegular,
          color: colorGray,
        });
      };

      // Historical trend chart
      y -= 38;
      y = this.drawTrendSection(page, {
        x: 40,
        y,
        width: width - 80,
        height: 120,
        historyData,
        limits,
        fonts: { regular: fontRegular, bold: fontBold },
        colors: {
          dark: colorDark,
          gray: colorGray,
          lightGray: colorLightGray,
          temp: colorNMCiano,
          umid: colorGreen,
          red: colorRed,
        },
      });

      // ── Detailed Readings Table ─────────────────────────────
      y -= 32;
      page.drawText('Detalhamento das Leituras Registradas no Período', { x: 40, y: y, size: 10, font: fontBold, color: colorDark });

      y -= 20;

      const dataHeaders = ['Data/Hora', 'Sala / Centro de Custo', 'Temperatura', 'Umidade', 'Bateria', 'Online'];
      const dataColWidths = [120, 160, 75, 55, 55, 50];

      const drawTableHeader = (p) => {
        p.drawRectangle({ x: 40, y: y - 5, width: width - 80, height: 18, color: colorNMAco });
        let xp = 45;
        dataHeaders.forEach((hdr, idx) => {
          p.drawText(hdr, { x: xp, y: y, size: 8, font: fontBold, color: rgb(1, 1, 1) });
          xp += dataColWidths[idx];
        });
      };

      drawTableHeader(page);

      // Render all readings in the period (supporting multiple pages dynamically)
      const displayRows = historyData; 
      for (let i = 0; i < displayRows.length; i++) {
        y -= 18;

        // If table flows past the printable area bottom, add a new page
        if (y < 60) {
          drawFooter(page);
          page = pdfDoc.addPage([595.28, 841.89]);
          y = 801.89; // Start at the top of the new page
          drawTableHeader(page);
          y -= 18;
        }

        const r = displayRows[i];
        
        // Alternating row background
        if (i % 2 === 0) {
          page.drawRectangle({ x: 40, y: y - 5, width: width - 80, height: 18, color: colorLightGray });
        }

        const isTempAlert = parseFloat(r.temperatura_c) < limits.temp.min || parseFloat(r.temperatura_c) > limits.temp.max;
        const isUmidAlert = parseInt(r.umidade_pct) < limits.umid.min || parseInt(r.umidade_pct) > limits.umid.max;

        // Format dates into Brazilian format if they are in ISO format
        let formattedDate = r.data_hora || '';
        if (formattedDate.includes('-') && formattedDate.includes('T')) {
          try {
            const d = new Date(formattedDate);
            if (!isNaN(d.getTime())) {
              formattedDate = d.toLocaleString('pt-BR');
            }
          } catch (e) {}
        }

        const rowData = [
          formattedDate,
          `${r.sala || 'Sala'} (${r.centro_custo || '--'})`,
          `${parseFloat(r.temperatura_c).toFixed(1)} °C`,
          `${r.umidade_pct} %`,
          r.bateria || '--',
          r.online || '--'
        ];

        xPos = 45;
        rowData.forEach((val, idx) => {
          let cellColor = colorDark;
          let cellFont = fontRegular;
          if (idx === 2 && isTempAlert) { cellColor = colorRed; cellFont = fontBold; }
          if (idx === 3 && isUmidAlert) { cellColor = colorRed; cellFont = fontBold; }
          page.drawText(val, { x: xPos, y: y, size: 7.5, font: cellFont, color: cellColor });
          xPos += dataColWidths[idx];
        });
      }

      // Draw footer on final page
      drawFooter(page);

      // 3. Trigger a real PDF download from the generated bytes
      const pdfBytes = await pdfDoc.save();
      const filename = `Relatorio_NM_Servicos_${inicio || 'historico'}_${fim || new Date().toISOString().slice(0, 10)}`;
      this.downloadPdfBytes(pdfBytes, filename);

      // 4. Update preview screen
      this.showPreview(inicio, fim, sala, statsData, historyData);
    } catch (e) {
      console.error('PDF generation error:', e);
      alert('Erro ao gerar relatório PDF. Verifique se os filtros estão corretos.');
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  },

  getCentroCustoFilter() {
    return document.getElementById('report-centro-custo')?.value
      || document.getElementById('global-centro-custo')?.value
      || '';
  },

  getAmbienteLabel(sala, historyData = []) {
    const salaSelect = document.getElementById('report-sala');
    if (sala && salaSelect) {
      return salaSelect.options[salaSelect.selectedIndex]?.text || sala;
    }

    const nomes = [...new Set(
      historyData
        .map(reading => reading.sala)
        .filter(Boolean)
    )].sort();

    return nomes.length ? nomes.join(', ') : 'Todos os Ambientes';
  },

  drawTrendSection(page, config) {
    const { x, y, width, height, historyData, limits, fonts, colors } = config;
    const rows = [...(historyData || [])].reverse().filter(r => Number.isFinite(parseFloat(r.temperatura_c)));

    page.drawText('Histórico de Temperatura e Umidade', {
      x,
      y,
      size: 10,
      font: fonts.bold,
      color: colors.dark,
    });

    const chartY = y - height - 18;
    page.drawRectangle({ x, y: chartY, width, height, color: colors.lightGray });

    if (!rows.length) {
      page.drawText('Nenhuma leitura encontrada para o período selecionado.', {
        x: x + 16,
        y: chartY + height / 2,
        size: 8,
        font: fonts.regular,
        color: colors.gray,
      });
      return chartY;
    }

    const sampleStep = Math.max(1, Math.ceil(rows.length / 80));
    const sampled = rows.filter((_, index) => index % sampleStep === 0);
    const temps = sampled.map(r => parseFloat(r.temperatura_c));
    const umids = sampled.map(r => parseFloat(r.umidade_pct));
    const tempMin = Math.min(limits.temp.min - 2, ...temps);
    const tempMax = Math.max(limits.temp.max + 2, ...temps);
    const umidMin = Math.min(limits.umid.min - 5, ...umids);
    const umidMax = Math.max(limits.umid.max + 5, ...umids);
    const plot = {
      x: x + 34,
      y: chartY + 26,
      width: width - 68,
      height: height - 48,
    };

    for (let i = 0; i <= 4; i++) {
      const gridY = plot.y + (plot.height / 4) * i;
      page.drawLine({
        start: { x: plot.x, y: gridY },
        end: { x: plot.x + plot.width, y: gridY },
        thickness: 0.4,
        color: colors.gray,
        opacity: 0.25,
      });
    }

    const tempToY = (value) => plot.y + ((value - tempMin) / (tempMax - tempMin || 1)) * plot.height;
    [limits.temp.min, limits.temp.max].forEach(limit => {
      page.drawLine({
        start: { x: plot.x, y: tempToY(limit) },
        end: { x: plot.x + plot.width, y: tempToY(limit) },
        thickness: 0.7,
        color: colors.red,
        opacity: 0.45,
      });
    });

    const toPoint = (value, index, min, max) => ({
      x: plot.x + (sampled.length === 1 ? 0 : (plot.width * index) / (sampled.length - 1)),
      y: plot.y + ((value - min) / (max - min || 1)) * plot.height,
    });

    const drawSeries = (values, min, max, color) => {
      for (let i = 1; i < values.length; i++) {
        page.drawLine({
          start: toPoint(values[i - 1], i - 1, min, max),
          end: toPoint(values[i], i, min, max),
          thickness: 1.5,
          color,
        });
      }
    };

    drawSeries(temps, tempMin, tempMax, colors.temp);
    drawSeries(umids, umidMin, umidMax, colors.umid);

    page.drawText(`${tempMax.toFixed(0)} °C`, { x: x + 6, y: plot.y + plot.height - 4, size: 7, font: fonts.regular, color: colors.gray });
    page.drawText(`${tempMin.toFixed(0)} °C`, { x: x + 6, y: plot.y - 2, size: 7, font: fonts.regular, color: colors.gray });
    page.drawText(`${umidMax.toFixed(0)} %`, { x: x + width - 30, y: plot.y + plot.height - 4, size: 7, font: fonts.regular, color: colors.gray });
    page.drawText(`${umidMin.toFixed(0)} %`, { x: x + width - 30, y: plot.y - 2, size: 7, font: fonts.regular, color: colors.gray });
    page.drawRectangle({ x: x + 16, y: chartY + 8, width: 8, height: 3, color: colors.temp });
    page.drawText('Temperatura', { x: x + 28, y: chartY + 6, size: 7, font: fonts.regular, color: colors.dark });
    page.drawRectangle({ x: x + 106, y: chartY + 8, width: 8, height: 3, color: colors.umid });
    page.drawText('Umidade', { x: x + 118, y: chartY + 6, size: 7, font: fonts.regular, color: colors.dark });
    page.drawText(`${rows.length} leituras analisadas`, { x: x + width - 118, y: chartY + 6, size: 7, font: fonts.regular, color: colors.gray });

    return chartY;
  },

  downloadPdfBytes(pdfBytes, filename) {
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

  async showPreview(inicio, fim, sala, statsData, historyData = []) {
    const previewCard = document.getElementById('report-preview-card');
    const preview = document.getElementById('report-preview');
    if (!previewCard || !preview) return;

    previewCard.style.display = 'block';

    const g = statsData.geral;

    const formatInputDate = (dateStr) => {
      if (!dateStr) return '';
      const parts = dateStr.split('-');
      if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
      return dateStr;
    };

    const nomeSala = this.getAmbienteLabel(sala, historyData);

    preview.innerHTML = `
      <div style="border-bottom: 3px solid #0B235C; padding-bottom: 16px; margin-bottom: 24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="display:inline-flex;align-items:center;justify-content:center;background:#0B235C;border-radius:6px;padding:6px 8px;">
              <img src="/logo-dark.png" alt="Logo" style="height:36px;width:auto;">
            </span>
            <div>
              <h2 style="color:#0B235C;margin:0;font-family:'Cinzel',serif;font-size:18px;">NM Serviços</h2>
              <p style="color:#788794;margin:2px 0 0;font-size:10px;">Soluções inteligentes em serviços e manutenção</p>
            </div>
          </div>
          <div style="background:#00B3C6;color:white;padding:6px 14px;border-radius:4px;font-size:11px;font-weight:600;">
            ANVISA RDC50
          </div>
        </div>
      </div>

      <h3 style="color:#1E2329;font-size:14px;margin-bottom:8px;font-family:'Montserrat',sans-serif;font-weight:700;">RELATÓRIO DE CONTROLE DE TEMPERATURA</h3>
      <p style="color:#788794;font-size:11px;margin-bottom:4px;"><strong>Ambiente:</strong> ${nomeSala}</p>
      <p style="color:#788794;font-size:11px;margin-bottom:4px;"><strong>Período:</strong> ${inicio ? formatInputDate(inicio) : 'Início'} a ${fim ? formatInputDate(fim) : 'Atual'}</p>
      <p style="color:#788794;font-size:11px;margin-bottom:24px;"><strong>Emitido em:</strong> ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR')}</p>

      <div style="display:flex;gap:16px;margin-bottom:24px;">
        <div style="flex:1;background:#F2F4F7;padding:12px;border-radius:6px;">
          <div style="color:#788794;font-size:9px;text-transform:uppercase;font-weight:600;">Total de Leituras</div>
          <div style="color:#1E2329;font-size:22px;font-weight:700;">${g.total_leituras}</div>
        </div>
        <div style="flex:1;background:#F2F4F7;padding:12px;border-radius:6px;">
          <div style="color:#788794;font-size:9px;text-transform:uppercase;font-weight:600;">Temp. Média</div>
          <div style="color:#0B235C;font-size:22px;font-weight:700;">${g.temp_avg.toFixed(1)}°C</div>
        </div>
        <div style="flex:1;background:#F2F4F7;padding:12px;border-radius:6px;">
          <div style="color:#788794;font-size:9px;text-transform:uppercase;font-weight:600;">Umid. Média</div>
          <div style="color:#00B3C6;font-size:22px;font-weight:700;">${parseFloat(g.umid_avg).toFixed(0)}%</div>
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:24px;">
        <thead>
          <tr style="background:#0B235C;color:white;">
            <th style="padding:6px 10px;text-align:left;">Métrica</th>
            <th style="padding:6px 10px;text-align:left;">Mínimo</th>
            <th style="padding:6px 10px;text-align:left;">Máximo</th>
            <th style="padding:6px 10px;text-align:left;">Média</th>
            <th style="padding:6px 10px;text-align:left;">Limite</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background:#F2F4F7;">
            <td style="padding:8px 10px;">Temperatura (°C)</td>
            <td style="padding:8px 10px;">${g.temp_min.toFixed(1)}</td>
            <td style="padding:8px 10px;">${g.temp_max.toFixed(1)}</td>
            <td style="padding:8px 10px;">${g.temp_avg.toFixed(1)}</td>
            <td style="padding:8px 10px;">${statsData.limites.temp.min}–${statsData.limites.temp.max}</td>
          </tr>
          <tr>
            <td style="padding:8px 10px;">Umidade (%)</td>
            <td style="padding:8px 10px;">${g.umid_min}</td>
            <td style="padding:8px 10px;">${g.umid_max}</td>
            <td style="padding:8px 10px;">${parseFloat(g.umid_avg).toFixed(0)}</td>
            <td style="padding:8px 10px;">${statsData.limites.umid.min}–${statsData.limites.umid.max}</td>
          </tr>
        </tbody>
      </table>

      <div style="background:#FFF3CD;border:1px solid #FFEBAA;padding:10px 14px;border-radius:6px;font-size:10px;">
        <strong style="color:#856404;">Relatório Exportado com Sucesso!</strong><br>
        <span style="color:#856404;">O arquivo PDF foi baixado com resumo executivo, gráfico histórico, limites RDC50 e detalhamento das leituras.</span>
      </div>

    `;
  },

  // Helper to convert Uint8Array to base64 string
  // Helper to convert Uint8Array to base64 string efficiently in chunks
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    const chunk = 8192; // 8KB chunks
    for (let i = 0; i < len; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return window.btoa(binary);
  },
};
