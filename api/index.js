import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import PDFDocument from 'pdfkit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Load .env manually with fallback to process.env ─────────────
const env = { ...process.env };
try {
  let envContent;
  try {
    envContent = readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  } catch {
    envContent = readFileSync(path.join(__dirname, '.env'), 'utf8');
  }
  if (envContent) {
    envContent.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return;
      env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
    });
  }
} catch (err) {
  // Safe to ignore on Vercel as it uses environment variables configured via the dashboard
}

const PORT = env.PORT || 3000;

// ── MySQL Pool ──────────────────────────────────────────────────
const pool = mysql.createPool({
  host: env.MYSQL_HOST,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 15000,
});

// ── RDC50 Limits ────────────────────────────────────────────────
const LIMITS = {
  temp: { min: +env.TEMP_MIN || 15, max: +env.TEMP_MAX || 30, target: +env.TEMP_TARGET || 22 },
  umid: { min: +env.UMID_MIN || 40, max: +env.UMID_MAX || 70, target: +env.UMID_TARGET || 55 },
};

// ── Sessions (in-memory for MVP) ────────────────────────────────
const sessions = new Map();
function generateToken() {
  return Array.from({ length: 48 }, () => Math.random().toString(36)[2]).join('');
}

// ── Auth middleware ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Não autorizado. Faça login.' });
  }
  req.user = sessions.get(token);
  next();
}

// ── Express App ─────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// PDF Download Bridge (converts POSTed base64 bytes to a downloadable PDF response)
app.post('/api/relatorio/download', (req, res) => {
  try {
    const { pdfBase64, filename } = req.body;
    if (!pdfBase64) return res.status(400).send('Dados do PDF ausentes.');
    const buffer = Buffer.from(pdfBase64, 'base64');
    
    // Sanitize the filename to avoid headers formatting errors
    const safeFilename = (filename || 'relatorio').replace(/[^a-zA-Z0-9_\-]/g, '_');
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Download bridge error:', err);
    res.status(500).send('Erro ao baixar PDF.');
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTH ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/login', async (req, res) => {
  try {
    const { login, senha } = req.body;
    if (!login || !senha) {
      return res.status(400).json({ error: 'Login e senha são obrigatórios.' });
    }

    // Fetch credentials from Google Sheets CSV
    const csvUrl = env.SHEETS_CSV_URL;
    const response = await fetch(csvUrl);
    const csvText = await response.text();

    // Parse CSV (skip header)
    const lines = csvText.trim().split('\n').slice(1);
    let foundUser = null;

    for (const line of lines) {
      const parts = line.split(',').map(p => p.trim().replace(/\r/g, ''));
      if (parts.length >= 3) {
        const [csvLogin, csvSenha, csvPermissao] = parts;
        if (csvLogin === login && csvSenha === senha) {
          foundUser = { login: csvLogin, permissao: csvPermissao };
          break;
        }
      }
    }

    if (!foundUser) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = generateToken();
    sessions.set(token, foundUser);

    // Auto-expire session after 8 hours
    setTimeout(() => sessions.delete(token), 8 * 60 * 60 * 1000);

    res.json({ token, user: foundUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG / LIMITS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/config/limites', requireAuth, (req, res) => {
  res.json(LIMITS);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEMPERATURE DATA ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Current readings (latest per room)
app.get('/api/temperatura/atual', requireAuth, async (req, res) => {
  try {
    const { centro_custo } = req.query;
    let subWhere = "codigo_sala IS NOT NULL AND online = 'Sim'";
    let outerWhere = "t1.online = 'Sim'";
    const params = [];

    if (centro_custo) {
      subWhere += ' AND centro_custo = ?';
      outerWhere += ' AND t1.centro_custo = ?';
      params.push(centro_custo, centro_custo);
    }

    const [rows] = await pool.query(`
      SELECT t1.*
      FROM controle_de_temperatura t1
      INNER JOIN (
        SELECT codigo_sala, MAX(criado_em) AS max_criado
        FROM controle_de_temperatura
        WHERE ${subWhere}
        GROUP BY codigo_sala
      ) t2 ON t1.codigo_sala = t2.codigo_sala AND t1.criado_em = t2.max_criado
      WHERE ${outerWhere}
      ORDER BY t1.sala
    `, params);

    // Add status classification based on RDC50 limits
    const enriched = rows.map(r => ({
      ...r,
      temperatura_c: parseFloat(r.temperatura_c),
      temp_status: classifyValue(parseFloat(r.temperatura_c), LIMITS.temp),
      umid_status: classifyValue(r.umidade_pct, LIMITS.umid),
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Error fetching current data:', err);
    res.status(500).json({ error: 'Erro ao buscar dados atuais.' });
  }
});

// Historical data with filters
app.get('/api/temperatura/historico', requireAuth, async (req, res) => {
  try {
    const { inicio, fim, sala, centro_custo, limit: queryLimit } = req.query;

    let sql = `
      SELECT codigo_sala, centro_custo, sala, temperatura_c, umidade_pct,
             bateria, online, data_hora, criado_em
      FROM controle_de_temperatura
      WHERE codigo_sala IS NOT NULL AND online = 'Sim'
    `;
    const params = [];

    if (sala) {
      sql += ' AND codigo_sala = ?';
      params.push(sala);
    }

    if (centro_custo) {
      sql += ' AND centro_custo = ?';
      params.push(centro_custo);
    }

    if (inicio) {
      sql += ' AND criado_em >= ?';
      params.push(inicio);
    }

    if (fim) {
      sql += ' AND criado_em <= ?';
      params.push(fim);
    }

    sql += ' ORDER BY criado_em DESC';

    if (queryLimit) {
      sql += ' LIMIT ?';
      params.push(parseInt(queryLimit));
    }

    const [rows] = await pool.query(sql, params);
    res.json(rows.map(r => ({ ...r, temperatura_c: parseFloat(r.temperatura_c) })));
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico.' });
  }
});

// Statistics
app.get('/api/temperatura/stats', requireAuth, async (req, res) => {
  try {
    const { inicio, fim, sala, centro_custo } = req.query;

    let whereClause = "WHERE codigo_sala IS NOT NULL AND online = 'Sim'";
    const params = [];

    if (sala) { whereClause += ' AND codigo_sala = ?'; params.push(sala); }
    if (centro_custo) { whereClause += ' AND centro_custo = ?'; params.push(centro_custo); }
    if (inicio) { whereClause += ' AND criado_em >= ?'; params.push(inicio); }
    if (fim) { whereClause += ' AND criado_em <= ?'; params.push(fim); }

    const [stats] = await pool.query(`
      SELECT
        MIN(temperatura_c) AS temp_min,
        MAX(temperatura_c) AS temp_max,
        AVG(temperatura_c) AS temp_avg,
        MIN(umidade_pct) AS umid_min,
        MAX(umidade_pct) AS umid_max,
        AVG(umidade_pct) AS umid_avg,
        COUNT(*) AS total_leituras
      FROM controle_de_temperatura
      ${whereClause}
    `, params);

    const [roomStats] = await pool.query(`
      SELECT
        codigo_sala, sala,
        MIN(temperatura_c) AS temp_min,
        MAX(temperatura_c) AS temp_max,
        AVG(temperatura_c) AS temp_avg,
        MIN(umidade_pct) AS umid_min,
        MAX(umidade_pct) AS umid_max,
        AVG(umidade_pct) AS umid_avg,
        COUNT(*) AS total_leituras
      FROM controle_de_temperatura
      ${whereClause}
      GROUP BY codigo_sala, sala
    `, params);

    res.json({
      geral: {
        ...stats[0],
        temp_min: parseFloat(stats[0].temp_min),
        temp_max: parseFloat(stats[0].temp_max),
        temp_avg: parseFloat(stats[0].temp_avg),
      },
      por_sala: roomStats.map(r => ({
        ...r,
        temp_min: parseFloat(r.temp_min),
        temp_max: parseFloat(r.temp_max),
        temp_avg: parseFloat(r.temp_avg),
      })),
      limites: LIMITS,
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
  }
});

// Alerts (values outside RDC50 limits)
app.get('/api/temperatura/alertas', requireAuth, async (req, res) => {
  try {
    const { inicio, fim, centro_custo, limit: queryLimit } = req.query;

    let whereClause = `
      WHERE codigo_sala IS NOT NULL AND online = 'Sim'
      AND (
        temperatura_c < ${LIMITS.temp.min} OR temperatura_c > ${LIMITS.temp.max}
        OR umidade_pct < ${LIMITS.umid.min} OR umidade_pct > ${LIMITS.umid.max}
      )
    `;
    const params = [];

    if (centro_custo) { whereClause += ' AND centro_custo = ?'; params.push(centro_custo); }
    if (inicio) { whereClause += ' AND criado_em >= ?'; params.push(inicio); }
    if (fim) { whereClause += ' AND criado_em <= ?'; params.push(fim); }

    const [rows] = await pool.query(`
      SELECT *, 
        CASE 
          WHEN temperatura_c < ${LIMITS.temp.min} THEN 'temp_baixa'
          WHEN temperatura_c > ${LIMITS.temp.max} THEN 'temp_alta'
          ELSE NULL 
        END AS alerta_temp,
        CASE 
          WHEN umidade_pct < ${LIMITS.umid.min} THEN 'umid_baixa'
          WHEN umidade_pct > ${LIMITS.umid.max} THEN 'umid_alta'
          ELSE NULL 
        END AS alerta_umid
      FROM controle_de_temperatura
      ${whereClause}
      ORDER BY criado_em DESC
      LIMIT ?
    `, [...params, parseInt(queryLimit) || 100]);

    // Count by type
    const [counts] = await pool.query(`
      SELECT
        SUM(CASE WHEN temperatura_c < ${LIMITS.temp.min} OR temperatura_c > ${LIMITS.temp.max} THEN 1 ELSE 0 END) AS alertas_temp,
        SUM(CASE WHEN umidade_pct < ${LIMITS.umid.min} OR umidade_pct > ${LIMITS.umid.max} THEN 1 ELSE 0 END) AS alertas_umid
      FROM controle_de_temperatura
      ${whereClause}
    `, params);

    res.json({
      alertas: rows.map(r => ({ ...r, temperatura_c: parseFloat(r.temperatura_c) })),
      contagem: counts[0],
    });
  } catch (err) {
    console.error('Error fetching alerts:', err);
    res.status(500).json({ error: 'Erro ao buscar alertas.' });
  }
});

// Rooms list
app.get('/api/temperatura/salas', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT codigo_sala, centro_custo, sala
      FROM controle_de_temperatura
      WHERE codigo_sala IS NOT NULL AND online = 'Sim'
      ORDER BY sala
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ error: 'Erro ao buscar salas.' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PDF REPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/relatorio/pdf', requireAuth, async (req, res) => {
  try {
    const { inicio, fim, sala, centro_custo } = req.body;

    // Fetch data
    let whereClause = "WHERE codigo_sala IS NOT NULL AND online = 'Sim'";
    const params = [];
    if (sala) { whereClause += ' AND codigo_sala = ?'; params.push(sala); }
    if (centro_custo) { whereClause += ' AND centro_custo = ?'; params.push(centro_custo); }
    if (inicio) { whereClause += ' AND criado_em >= ?'; params.push(inicio); }
    if (fim) { whereClause += ' AND criado_em <= ?'; params.push(fim); }

    const [rows] = await pool.query(`
      SELECT * FROM controle_de_temperatura ${whereClause} ORDER BY criado_em ASC
    `, params);

    const [stats] = await pool.query(`
      SELECT
        MIN(temperatura_c) AS temp_min, MAX(temperatura_c) AS temp_max, AVG(temperatura_c) AS temp_avg,
        MIN(umidade_pct) AS umid_min, MAX(umidade_pct) AS umid_max, AVG(umidade_pct) AS umid_avg,
        COUNT(*) AS total,
        SUM(CASE WHEN temperatura_c < ${LIMITS.temp.min} OR temperatura_c > ${LIMITS.temp.max} THEN 1 ELSE 0 END) AS alertas_temp,
        SUM(CASE WHEN umidade_pct < ${LIMITS.umid.min} OR umidade_pct > ${LIMITS.umid.max} THEN 1 ELSE 0 END) AS alertas_umid
      FROM controle_de_temperatura ${whereClause}
    `, params);

    // Generate PDF
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=relatorio_temperatura_${Date.now()}.pdf`);
    doc.pipe(res);

    const blue = '#0B23BC';
    const darkBlue = '#1E2329';
    const teal = '#008BC6';
    const white = '#FFFFFF';
    const lightGray = '#F2F4F7';

    // ── Header ─────────────────────────────
    doc.rect(0, 0, 595.28, 90).fill(blue);
    doc.fontSize(22).fill(white).font('Helvetica-Bold')
      .text('NM Serviços', 50, 20);
    doc.fontSize(10).fill(white).font('Helvetica')
      .text('Soluções inteligentes em serviços e manutenção', 50, 48);

    // Badge
    doc.roundedRect(440, 25, 110, 30, 5).fill(teal);
    doc.fontSize(10).fill(white).font('Helvetica-Bold')
      .text('INDIVIDUAL', 455, 33);

    doc.moveDown(3);

    // ── Title ──────────────────────────────
    doc.fontSize(16).fill(darkBlue).font('Helvetica-Bold')
      .text('RELATÓRIO DE CONTROLE DE TEMPERATURA', 50, 110);

    const periodoText = `Período: ${inicio || 'Início'} a ${fim || 'Atual'}`;
    doc.fontSize(10).fill('#555').font('Helvetica')
      .text(periodoText, 50, 132);
    doc.text(`Emitido em: ${new Date().toLocaleDateString('pt-BR')}`, 50, 145);

    // ── Stats Cards ────────────────────────
    const y1 = 175;
    const cardWidth = 155;
    const cardGap = 15;

    // Card: Total Leituras
    doc.roundedRect(50, y1, cardWidth, 60, 5).fill(lightGray);
    doc.fontSize(8).fill('#768794').font('Helvetica').text('TOTAL DE LEITURAS', 60, y1 + 10);
    doc.fontSize(22).fill(darkBlue).font('Helvetica-Bold').text(String(stats[0].total), 60, y1 + 28);

    // Card: Alertas Temp
    doc.roundedRect(50 + cardWidth + cardGap, y1, cardWidth, 60, 5).fill(lightGray);
    doc.fontSize(8).fill('#768794').font('Helvetica').text('ALERTAS TEMPERATURA', 60 + cardWidth + cardGap, y1 + 10);
    doc.fontSize(22).fill('#E74C3C').font('Helvetica-Bold').text(String(stats[0].alertas_temp || 0), 60 + cardWidth + cardGap, y1 + 28);

    // Card: Alertas Umid
    doc.roundedRect(50 + 2 * (cardWidth + cardGap), y1, cardWidth, 60, 5).fill(lightGray);
    doc.fontSize(8).fill('#768794').font('Helvetica').text('ALERTAS UMIDADE', 60 + 2 * (cardWidth + cardGap), y1 + 10);
    doc.fontSize(22).fill('#F39C12').font('Helvetica-Bold').text(String(stats[0].alertas_umid || 0), 60 + 2 * (cardWidth + cardGap), y1 + 28);

    // ── Summary Table ──────────────────────
    let yPos = y1 + 80;
    doc.fontSize(12).fill(darkBlue).font('Helvetica-Bold').text('Resumo Estatístico', 50, yPos);
    yPos += 25;

    const summaryData = [
      ['Métrica', 'Mínimo', 'Máximo', 'Média', 'Limite Min', 'Limite Máx'],
      ['Temperatura (°C)', parseFloat(stats[0].temp_min).toFixed(1), parseFloat(stats[0].temp_max).toFixed(1), parseFloat(stats[0].temp_avg).toFixed(1), String(LIMITS.temp.min), String(LIMITS.temp.max)],
      ['Umidade (%)', String(stats[0].umid_min), String(stats[0].umid_max), parseFloat(stats[0].umid_avg).toFixed(1), String(LIMITS.umid.min), String(LIMITS.umid.max)],
    ];

    const colWidths = [110, 70, 70, 70, 75, 75];
    for (let i = 0; i < summaryData.length; i++) {
      const row = summaryData[i];
      const isHeader = i === 0;
      let xPos = 50;

      if (isHeader) {
        doc.rect(50, yPos - 3, 470, 20).fill(blue);
      } else if (i % 2 === 0) {
        doc.rect(50, yPos - 3, 470, 20).fill(lightGray);
      }

      for (let j = 0; j < row.length; j++) {
        doc.fontSize(8)
          .fill(isHeader ? white : darkBlue)
          .font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
          .text(row[j], xPos + 5, yPos, { width: colWidths[j] - 10 });
        xPos += colWidths[j];
      }
      yPos += 20;
    }

    // ── Data Table (last 50 records) ───────
    yPos += 20;
    doc.fontSize(12).fill(darkBlue).font('Helvetica-Bold').text('Detalhamento das Leituras', 50, yPos);
    yPos += 25;

    const headers = ['Data/Hora', 'Sala', 'Temp (°C)', 'Umid (%)', 'Bateria', 'Online'];
    const dataColWidths = [100, 90, 70, 60, 70, 60];
    let xPos = 50;

    doc.rect(50, yPos - 3, 450, 20).fill(blue);
    for (let j = 0; j < headers.length; j++) {
      doc.fontSize(7).fill(white).font('Helvetica-Bold')
        .text(headers[j], xPos + 3, yPos, { width: dataColWidths[j] - 6 });
      xPos += dataColWidths[j];
    }
    yPos += 20;

    const displayRows = rows.slice(-50);
    for (let i = 0; i < displayRows.length; i++) {
      if (yPos > 720) {
        doc.addPage();
        // Reprint header on new page
        doc.rect(0, 0, 595.28, 40).fill(blue);
        doc.fontSize(12).fill(white).font('Helvetica-Bold')
          .text('NM Serviços — Relatório de Temperatura (continuação)', 50, 12);
        yPos = 60;
      }

      const r = displayRows[i];
      if (i % 2 === 0) doc.rect(50, yPos - 3, 450, 18).fill(lightGray);

      const cellData = [
        r.data_hora || '',
        r.sala || '',
        parseFloat(r.temperatura_c).toFixed(1),
        String(r.umidade_pct || ''),
        r.bateria || '',
        r.online || '',
      ];

      xPos = 50;
      for (let j = 0; j < cellData.length; j++) {
        const isAlert = (j === 2 && (parseFloat(cellData[j]) < LIMITS.temp.min || parseFloat(cellData[j]) > LIMITS.temp.max))
          || (j === 3 && (parseInt(cellData[j]) < LIMITS.umid.min || parseInt(cellData[j]) > LIMITS.umid.max));

        doc.fontSize(7)
          .fill(isAlert ? '#E74C3C' : darkBlue)
          .font(isAlert ? 'Helvetica-Bold' : 'Helvetica')
          .text(cellData[j], xPos + 3, yPos, { width: dataColWidths[j] - 6 });
        xPos += dataColWidths[j];
      }
      yPos += 18;
    }

    // ── Footer note ────────────────────────
    yPos += 20;
    if (yPos > 720) doc.addPage();

    doc.roundedRect(50, yPos, 495.28, 40, 5).fill('#FFF3CD');
    doc.fontSize(8).fill('#856404').font('Helvetica-Bold')
      .text('Observação operacional', 60, yPos + 8);
    doc.fontSize(7).fill('#856404').font('Helvetica')
      .text('Os dados apresentados correspondem às leituras dos sensores de temperatura e umidade conforme RDC50/ANVISA. Valores fora dos limites estão destacados em vermelho.', 60, yPos + 20, { width: 475 });

    // ── Page footer ────────────────────────
    const pageFooterY = 800;
    doc.fontSize(7).fill('#999').font('Helvetica')
      .text(`NM Serviços | Relatório gerado automaticamente em ${new Date().toLocaleString('pt-BR')}`, 50, pageFooterY);

    doc.end();
  } catch (err) {
    console.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório PDF.' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function classifyValue(value, limits) {
  if (value < limits.min || value > limits.max) return 'critico';
  const margin = (limits.max - limits.min) * 0.15;
  if (value < limits.min + margin || value > limits.max - margin) return 'atencao';
  return 'normal';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SPA FALLBACK — serve index.html for all non-API routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// Export app for Vercel Serverless Function
export default app;
export { PORT };
