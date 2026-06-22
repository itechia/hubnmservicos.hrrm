/* ═══════════════════════════════════════════════
   CHARTS — Chart.js Configuration (NM Serviços)
   ═══════════════════════════════════════════════ */

const NMCharts = {
  getThemeColors() {
    const isDark = document.body.classList.contains('dark-mode');
    return {
      temp: '#2E95FF',
      tempBg: isDark ? 'rgba(46,149,255,0.16)' : 'rgba(46,149,255,0.08)',
      umid: '#26C281',
      umidBg: isDark ? 'rgba(38,194,129,0.14)' : 'rgba(38,194,129,0.08)',
      limitLine: 'rgba(231,76,60,0.5)',
      grid: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(11,35,92,0.08)',
      text: isDark ? '#8b949e' : '#788794',
      tooltipBg: isDark ? 'rgba(22,27,34,0.95)' : 'rgba(255,255,255,0.95)',
      tooltipText: isDark ? '#e6edf3' : '#1E2329',
      tooltipBorder: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(11,35,92,0.1)',
    };
  },

  // Dynamic Options Generator
  getOptions(colors) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            color: colors.text,
            font: { family: 'Montserrat', size: 11, weight: 500 },
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 16,
          },
        },
        tooltip: {
          backgroundColor: colors.tooltipBg,
          titleColor: colors.tooltipText,
          bodyColor: colors.text,
          borderColor: colors.tooltipBorder,
          borderWidth: 1,
          padding: 12,
          cornerRadius: 8,
          titleFont: { family: 'Montserrat', size: 12, weight: 600 },
          bodyFont: { family: 'Montserrat', size: 11 },
          displayColors: true,
          callbacks: {},
        },
      },
      scales: {
        x: {
          grid: { color: colors.grid, drawBorder: false },
          ticks: { color: colors.text, font: { family: 'Montserrat', size: 10 }, maxTicksLimit: 12 },
        },
        y: {
          grid: { color: colors.grid, drawBorder: false },
          ticks: { color: colors.text, font: { family: 'Montserrat', size: 10 } },
        },
      },
    };
  },

  /**
   * Create a dual-axis line chart for temperature and humidity
   */
  createTempHumidChart(canvasId, labels, tempData, umidData, limits) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return null;

    // Destroy existing chart if any
    const existing = Chart.getChart(ctx);
    if (existing) existing.destroy();

    const colors = this.getThemeColors();
    const options = this.getOptions(colors);

    const datasets = [
      {
        label: 'Temperatura média (°C)',
        data: tempData,
        borderColor: colors.temp,
        backgroundColor: colors.tempBg,
        fill: true,
        tension: 0.4,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: colors.temp,
        yAxisID: 'y',
      },
      {
        label: 'Umidade relativa (%)',
        data: umidData,
        borderColor: colors.umid,
        backgroundColor: colors.umidBg,
        fill: true,
        tension: 0.4,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: colors.umid,
        yAxisID: 'y1',
      },
    ];

    // Add limit lines if provided
    if (limits) {
      datasets.push({
        label: `Limite máximo temp. (${limits.temp.max}°C)`,
        data: Array(labels.length).fill(limits.temp.max),
        borderColor: 'rgba(231,76,60,0.4)',
        borderDash: [6, 4],
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        yAxisID: 'y',
      });
      datasets.push({
        label: `Limite mínimo temp. (${limits.temp.min}°C)`,
        data: Array(labels.length).fill(limits.temp.min),
        borderColor: 'rgba(241,196,15,0.4)',
        borderDash: [6, 4],
        borderWidth: 1,
        pointRadius: 0,
        fill: false,
        yAxisID: 'y',
      });
    }

    const endpointLabels = {
      id: 'endpointLabels',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea } = chart;
        ctx.save();
        chart.data.datasets.slice(0, 2).forEach((dataset, datasetIndex) => {
          const meta = chart.getDatasetMeta(datasetIndex);
          const points = meta.data;
          if (!points || !points.length) return;

          const lastIndex = dataset.data.length - 1;
          const lastPoint = points[lastIndex];
          const value = dataset.data[lastIndex];
          if (!lastPoint || value == null || Number.isNaN(value)) return;

          const isTemp = dataset.label.toLowerCase().includes('temp');
          const text = isTemp ? `${Number(value).toFixed(1)} °C` : `${Number(value).toFixed(0)} %`;
          ctx.font = '600 11px Montserrat, sans-serif';
          const paddingX = 7;
          const labelWidth = ctx.measureText(text).width + paddingX * 2;
          const labelHeight = 20;
          const x = Math.min(lastPoint.x + 10, chartArea.right - labelWidth);
          const y = Math.max(chartArea.top + 2, Math.min(lastPoint.y - labelHeight / 2, chartArea.bottom - labelHeight));

          ctx.fillStyle = dataset.borderColor;
          ctx.beginPath();
          ctx.roundRect(x, y, labelWidth, labelHeight, 5);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(text, x + paddingX, y + 14);
        });
        ctx.restore();
      },
    };

    const allPointLabels = {
      id: 'allPointLabels',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea } = chart;
        ctx.save();
        chart.data.datasets.slice(0, 2).forEach((dataset, datasetIndex) => {
          const meta = chart.getDatasetMeta(datasetIndex);
          if (!meta?.data?.length) return;

          const isTemp = dataset.label.toLowerCase().includes('temp');
          ctx.font = '600 10px Montserrat, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const maxLabels = Math.max(5, Math.floor(chartArea.width / 92));
          const labelStep = Math.max(1, Math.ceil(meta.data.length / maxLabels));

          meta.data.forEach((point, index) => {
            const isEdge = index === 0 || index === meta.data.length - 1;
            if (!isEdge && index % labelStep !== 0) return;

            const value = dataset.data[index];
            if (value == null || Number.isNaN(value)) return;

            const text = isTemp ? `${Number(value).toFixed(1)}°` : `${Number(value).toFixed(0)}%`;
            const labelWidth = ctx.measureText(text).width + 8;
            const labelHeight = 15;
            const offset = isTemp ? 14 : -14;
            const x = Math.max(chartArea.left + labelWidth / 2, Math.min(point.x, chartArea.right - labelWidth / 2));
            const y = Math.max(chartArea.top + labelHeight / 2, Math.min(point.y + offset, chartArea.bottom - labelHeight / 2));

            ctx.fillStyle = datasetIndex === 0 ? 'rgba(46,149,255,0.92)' : 'rgba(38,194,129,0.92)';
            ctx.beginPath();
            ctx.roundRect(x - labelWidth / 2, y - labelHeight / 2, labelWidth, labelHeight, 4);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, x, y + 0.5);
          });
        });
        ctx.restore();
      },
    };

    return new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      plugins: [allPointLabels],
      options: {
        ...options,
        plugins: {
          ...options.plugins,
          tooltip: {
            ...options.plugins.tooltip,
            callbacks: {
              label: (ctx) => {
                const val = ctx.parsed.y;
                if (ctx.dataset.label.toLowerCase().includes('temp')) return `${ctx.dataset.label}: ${val?.toFixed(1)}°C`;
                if (ctx.dataset.label.includes('Umid')) return `${ctx.dataset.label}: ${val?.toFixed(0)}%`;
                return `${ctx.dataset.label}: ${val}`;
              },
            },
          },
        },
        scales: {
          x: {
            ...options.scales.x,
            ticks: {
              ...options.scales.x.ticks,
              maxRotation: 45,
              minRotation: 0,
            },
          },
          y: {
            ...options.scales.y,
            position: 'left',
            title: {
              display: true,
              text: 'Temperatura (°C)',
              color: colors.temp,
              font: { family: 'Montserrat', size: 11, weight: 500 },
            },
            suggestedMin: 10,
            suggestedMax: 40,
          },
          y1: {
            ...options.scales.y,
            position: 'right',
            title: {
              display: true,
              text: 'Umidade (%)',
              color: colors.umid,
              font: { family: 'Montserrat', size: 11, weight: 500 },
            },
            suggestedMin: 20,
            suggestedMax: 100,
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
  },
};
