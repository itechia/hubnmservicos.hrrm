process.env.TZ = 'America/Belem';
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import PDFDocument from 'pdfkit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

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
  timezone: '-03:00',
});

// ── RDC50 Limits ────────────────────────────────────────────────
const LIMITS = {
  temp: { min: +env.TEMP_MIN || 15, max: +env.TEMP_MAX || 30, target: +env.TEMP_TARGET || 22 },
  umid: { min: +env.UMID_MIN || 40, max: +env.UMID_MAX || 70, target: +env.UMID_TARGET || 55 },
  setor: 'PADRAO',
  norma: 'RDC50 / ANVISA',
  descricao: 'Area de Armazenamento Hospitalar',
};

const LIMITS_CSV_URL = env.LIMITES_SETORES_CSV_URL || env.SECTORS_LIMITS_CSV_URL || '';
const LIMITS_CACHE_MS = 5 * 60 * 1000;
let limitsCache = { loadedAt: 0, bySector: new Map() };
const LOGIN_CSV_CACHE_MS = 60 * 1000;
let loginCsvCache = { loadedAt: 0, users: [] };

const ENERGY_LIMITS = {
  faseNeutro: {
    nominal: 220,
    min: +env.ENERGIA_TENSAO_FN_MIN || 202,
    max: +env.ENERGIA_TENSAO_FN_MAX || 231,
  },
  desequilibrioMaxPct: +env.ENERGIA_DESEQUILIBRIO_MAX || 5,
  co2KgPorKwh: +env.ENERGIA_CO2_KG_KWH || 0.04,
  arvoreKgCo2Ano: +env.ENERGIA_ARVORE_KG_CO2_ANO || 22,
};

ENERGY_LIMITS.faseFase = {
  nominal: roundNumber(ENERGY_LIMITS.faseNeutro.nominal * Math.sqrt(3), 2),
  min: roundNumber(ENERGY_LIMITS.faseNeutro.min * Math.sqrt(3), 2),
  max: roundNumber(ENERGY_LIMITS.faseNeutro.max * Math.sqrt(3), 2),
};

const HUMIDITY_SQL = 'CASE WHEN umidade_pct > 100 AND umidade_pct <= 1000 THEN umidade_pct / 10 ELSE umidade_pct END';

// ── Stateless Token Authentication (JWT-like using native crypto) ──
const JWT_SECRET = env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!env.JWT_SECRET) {
  console.warn('JWT_SECRET ausente. Usando segredo temporário; sessões expiram ao reiniciar o servidor.');
}

function generateToken(user) {
  const payload = JSON.stringify({
    login: user.login,
    permissao: user.permissao,
    exp: Date.now() + 8 * 60 * 60 * 1000 // 8 hours expiration
  });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

function verifyToken(token) {
  try {
    const [payloadB64, signature] = token.split('.');
    if (!payloadB64 || !signature) return null;
    
    const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(payloadB64).digest('base64url');
    if (!safeEqual(signature, expectedSignature)) return null;
    
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp < Date.now()) return null; // Expired
    
    return { login: payload.login, permissao: payload.permissao };
  } catch (err) {
    return null;
  }
}

// ── Auth middleware ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Não autorizado. Faça login.' });
  }
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Sessão expirada ou inválida. Faça login novamente.' });
  }
  req.user = user;
  next();
}

function requirePermission(...allowedPermissions) {
  return (req, res, next) => {
    const permission = normalizePermission(req.user?.permissao);
    const login = normalizePermission(req.user?.login);
    const allowed = new Set([
      ...allowedPermissions.map(normalizePermission),
      'hrrm',
      'admin',
      'administrador',
      'master',
      'total',
    ]);

    const hasExplicitAccess = allowed.has(permission);
    const hasHrrmAccess = permission.includes('hrrm') || login.includes('hrrm');
    const hasEnergyAccess = permission.includes('energia') || login.includes('energia');

    if (!hasExplicitAccess && !hasHrrmAccess && !hasEnergyAccess) {
      return res.status(403).json({ error: 'Acesso restrito à permissão energia_eletrica.' });
    }

    next();
  };
}

const allowedCorsOrigins = (env.CORS_ORIGIN || env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedCorsOrigins.length === 0 || allowedCorsOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origem não permitida pelo CORS.'));
  },
};

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

const rateLimitStore = new Map();

function createRateLimiter({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${windowMs}:${max}:${req.ip}:${req.method}:${req.path}`;
    const now = Date.now();
    const record = rateLimitStore.get(key);

    if (!record || record.resetAt <= now) {
      rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count += 1;
    if (record.count > max) {
      res.setHeader('Retry-After', Math.ceil((record.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Muitas requisições. Aguarde alguns segundos e tente novamente.' });
    }

    return next();
  };
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function parseLimit(value, fallback = 100, max = 5000) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(limit, max);
}

// ── Express App ─────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use('/api/', createRateLimiter({ windowMs: 60 * 1000, max: 240 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// PDF Download Bridge (converts POSTed base64 bytes to a downloadable PDF response)
app.post('/api/relatorio/download', requireAuth, (req, res) => {
  try {
    const { pdfBase64, filename } = req.body;
    if (!pdfBase64) return res.status(400).send('Dados do PDF ausentes.');
    if (typeof pdfBase64 !== 'string' || pdfBase64.length > 10 * 1024 * 1024) {
      return res.status(413).send('PDF inválido ou grande demais.');
    }

    const buffer = Buffer.from(pdfBase64, 'base64');
    if (!buffer.length || buffer.subarray(0, 4).toString() !== '%PDF') {
      return res.status(400).send('Arquivo PDF inválido.');
    }
    
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

app.post('/api/login', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  try {
    const { login, senha } = req.body;
    if (!login || !senha) {
      return res.status(400).json({ error: 'Login e senha são obrigatórios.' });
    }

    const users = await loadLoginUsers();
    const foundUser = users.find(user => user.login === login && user.senha === senha);

    if (!foundUser) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const safeUser = { login: foundUser.login, permissao: foundUser.permissao };
    const token = generateToken(safeUser);

    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});

app.post('/api/logout', (req, res) => {
  res.json({ ok: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG / LIMITS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/config/limites', requireAuth, async (req, res) => {
  try {
    res.json(await getLimitsForSector(req.query.centro_custo));
  } catch (err) {
    console.error('Error fetching configured limits:', err);
    res.json(LIMITS);
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEMPERATURE DATA ENDPOINTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Current readings (latest per room)
app.get('/api/temperatura/atual', requireAuth, async (req, res) => {
  try {
    const { centro_custo } = req.query;
    let subWhere = 'codigo_sala IS NOT NULL';
    let outerWhere = '1 = 1';
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

    // Add status classification based on configured limits for each sector
    const enriched = await Promise.all(rows.map(async (r) => {
      const limits = await getLimitsForSector(r.centro_custo);
      return {
        ...r,
        temperatura_c: parseFloat(r.temperatura_c),
        umidade_pct: normalizeHumidity(r.umidade_pct),
        temp_status: classifyValue(parseFloat(r.temperatura_c), limits.temp),
        umid_status: classifyValue(normalizeHumidity(r.umidade_pct), limits.umid),
        limites: limits,
      };
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
      params.push(parseLimit(queryLimit, 500, 5000));
    }

    const [rows] = await pool.query(sql, params);
    res.json(rows.map(normalizeTemperatureReading));
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

    const limits = await getLimitsForSector(centro_custo);

    const [stats] = await pool.query(`
      SELECT
        MIN(temperatura_c) AS temp_min,
        MAX(temperatura_c) AS temp_max,
        AVG(temperatura_c) AS temp_avg,
        MIN(${HUMIDITY_SQL}) AS umid_min,
        MAX(${HUMIDITY_SQL}) AS umid_max,
        AVG(${HUMIDITY_SQL}) AS umid_avg,
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
        MIN(${HUMIDITY_SQL}) AS umid_min,
        MAX(${HUMIDITY_SQL}) AS umid_max,
        AVG(${HUMIDITY_SQL}) AS umid_avg,
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
        umid_min: normalizeHumidity(stats[0].umid_min),
        umid_max: normalizeHumidity(stats[0].umid_max),
        umid_avg: normalizeHumidity(stats[0].umid_avg),
      },
      por_sala: roomStats.map(r => ({
        ...r,
        temp_min: parseFloat(r.temp_min),
        temp_max: parseFloat(r.temp_max),
        temp_avg: parseFloat(r.temp_avg),
        umid_min: normalizeHumidity(r.umid_min),
        umid_max: normalizeHumidity(r.umid_max),
        umid_avg: normalizeHumidity(r.umid_avg),
      })),
      limites: limits,
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

    const limits = await getLimitsForSector(centro_custo);
    const requestedLimit = parseLimit(queryLimit, 100, 500);

    if (!centro_custo && limits.modo === 'multissetor') {
      let sql = `
        SELECT *
        FROM controle_de_temperatura
        WHERE codigo_sala IS NOT NULL AND online = 'Sim'
      `;
      const params = [];

      if (inicio) { sql += ' AND criado_em >= ?'; params.push(inicio); }
      if (fim) { sql += ' AND criado_em <= ?'; params.push(fim); }

      sql += ' ORDER BY criado_em DESC LIMIT ?';
      params.push(Math.min(Math.max(requestedLimit * 20, 500), 5000));

      const [candidateRows] = await pool.query(sql, params);
      const normalizedRows = await Promise.all(candidateRows.map(async (row) => {
        const rowLimits = await getLimitsForSector(row.centro_custo);
        const normalized = normalizeTemperatureReading(row);
        const alertaTemp = normalized.temperatura_c < rowLimits.temp.min
          ? 'temp_baixa'
          : normalized.temperatura_c > rowLimits.temp.max
            ? 'temp_alta'
            : null;
        const alertaUmid = normalized.umidade_pct < rowLimits.umid.min
          ? 'umid_baixa'
          : normalized.umidade_pct > rowLimits.umid.max
            ? 'umid_alta'
            : null;

        return {
          ...normalized,
          alerta_temp: alertaTemp,
          alerta_umid: alertaUmid,
          limites: rowLimits,
        };
      }));

      const alertRows = normalizedRows.filter(row => row.alerta_temp || row.alerta_umid);

      return res.json({
        alertas: alertRows.slice(0, requestedLimit),
        contagem: {
          alertas_temp: alertRows.filter(row => row.alerta_temp).length,
          alertas_umid: alertRows.filter(row => row.alerta_umid).length,
        },
      });
    }

    let whereClause = `
      WHERE codigo_sala IS NOT NULL AND online = 'Sim'
      AND (
        temperatura_c < ${limits.temp.min} OR temperatura_c > ${limits.temp.max}
        OR ${HUMIDITY_SQL} < ${limits.umid.min} OR ${HUMIDITY_SQL} > ${limits.umid.max}
      )
    `;
    const params = [];

    if (centro_custo) { whereClause += ' AND centro_custo = ?'; params.push(centro_custo); }
    if (inicio) { whereClause += ' AND criado_em >= ?'; params.push(inicio); }
    if (fim) { whereClause += ' AND criado_em <= ?'; params.push(fim); }

    const [rows] = await pool.query(`
      SELECT *, 
        CASE 
          WHEN temperatura_c < ${limits.temp.min} THEN 'temp_baixa'
          WHEN temperatura_c > ${limits.temp.max} THEN 'temp_alta'
          ELSE NULL 
        END AS alerta_temp,
        CASE 
          WHEN ${HUMIDITY_SQL} < ${limits.umid.min} THEN 'umid_baixa'
          WHEN ${HUMIDITY_SQL} > ${limits.umid.max} THEN 'umid_alta'
          ELSE NULL 
        END AS alerta_umid
      FROM controle_de_temperatura
      ${whereClause}
      ORDER BY criado_em DESC
      LIMIT ?
    `, [...params, requestedLimit]);

    // Count by type
    const [counts] = await pool.query(`
      SELECT
        SUM(CASE WHEN temperatura_c < ${limits.temp.min} OR temperatura_c > ${limits.temp.max} THEN 1 ELSE 0 END) AS alertas_temp,
        SUM(CASE WHEN ${HUMIDITY_SQL} < ${limits.umid.min} OR ${HUMIDITY_SQL} > ${limits.umid.max} THEN 1 ELSE 0 END) AS alertas_umid
      FROM controle_de_temperatura
      ${whereClause}
    `, params);

    res.json({
      alertas: rows.map(normalizeTemperatureReading),
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
      WHERE codigo_sala IS NOT NULL
      ORDER BY sala
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ error: 'Erro ao buscar salas.' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ELECTRICAL ENERGY HUB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.get('/api/energia/config', requireAuth, requirePermission('energia_eletrica'), (req, res) => {
  res.json(ENERGY_LIMITS);
});

app.get('/api/energia/geracao/plantas', requireAuth, requirePermission('energia_eletrica'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT planta
      FROM historico_geracao_energia
      WHERE planta IS NOT NULL AND planta <> ''
      ORDER BY planta
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching energy plants:', err);
    res.status(500).json({ error: 'Erro ao buscar plantas de geração.' });
  }
});

app.get('/api/energia/geracao/historico', requireAuth, requirePermission('energia_eletrica'), async (req, res) => {
  try {
    const { inicio, fim, planta, limit: queryLimit } = req.query;
    let sql = `
      SELECT data, energia, planta
      FROM historico_geracao_energia
      WHERE 1 = 1
    `;
    const params = [];

    if (planta) { sql += ' AND planta = ?'; params.push(planta); }
    if (inicio) { sql += ' AND data >= ?'; params.push(inicio); }
    if (fim) { sql += ' AND data <= ?'; params.push(fim); }

    sql += ' ORDER BY data DESC';
    if (queryLimit) { sql += ' LIMIT ?'; params.push(parseLimit(queryLimit, 500, 5000)); }

    const [rows] = await pool.query(sql, params);
    res.json(rows.map(row => ({ ...row, energia: parseFloat(row.energia) })));
  } catch (err) {
    console.error('Error fetching generation history:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico de geração.' });
  }
});

app.get('/api/energia/geracao/stats', requireAuth, requirePermission('energia_eletrica'), async (req, res) => {
  try {
    const { inicio, fim, planta } = req.query;
    let whereClause = 'WHERE 1 = 1';
    const params = [];

    if (planta) { whereClause += ' AND planta = ?'; params.push(planta); }
    if (inicio) { whereClause += ' AND data >= ?'; params.push(inicio); }
    if (fim) { whereClause += ' AND data <= ?'; params.push(fim); }

    const [statsRows] = await pool.query(`
      SELECT
        COUNT(*) AS dias_monitorados,
        SUM(energia) AS total_kwh,
        AVG(energia) AS media_kwh_dia,
        MIN(energia) AS menor_kwh,
        MAX(energia) AS maior_kwh,
        MIN(data) AS data_inicio,
        MAX(data) AS data_fim
      FROM historico_geracao_energia
      ${whereClause}
    `, params);

    const [bestRows] = await pool.query(`
      SELECT data, energia, planta
      FROM historico_geracao_energia
      ${whereClause}
      ORDER BY energia DESC, data DESC
      LIMIT 1
    `, params);

    const [byPlantRows] = await pool.query(`
      SELECT planta, COUNT(*) AS dias, SUM(energia) AS total_kwh, AVG(energia) AS media_kwh_dia
      FROM historico_geracao_energia
      ${whereClause}
      GROUP BY planta
      ORDER BY total_kwh DESC
    `, params);

    const stats = statsRows[0] || {};
    const totalKwh = parseFloat(stats.total_kwh) || 0;
    const co2EvitadoKg = roundNumber(totalKwh * ENERGY_LIMITS.co2KgPorKwh, 2);

    res.json({
      geral: {
        ...stats,
        total_kwh: totalKwh,
        media_kwh_dia: parseFloat(stats.media_kwh_dia) || 0,
        menor_kwh: parseFloat(stats.menor_kwh) || 0,
        maior_kwh: parseFloat(stats.maior_kwh) || 0,
        co2_evitado_kg: co2EvitadoKg,
        arvores_equivalentes_ano: roundNumber(co2EvitadoKg / ENERGY_LIMITS.arvoreKgCo2Ano, 2),
      },
      melhor_dia: bestRows[0] ? { ...bestRows[0], energia: parseFloat(bestRows[0].energia) } : null,
      por_planta: byPlantRows.map(row => ({
        ...row,
        total_kwh: parseFloat(row.total_kwh) || 0,
        media_kwh_dia: parseFloat(row.media_kwh_dia) || 0,
      })),
      limites: ENERGY_LIMITS,
    });
  } catch (err) {
    console.error('Error fetching generation stats:', err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas de geração.' });
  }
});

app.get('/api/energia/iot/atual', requireAuth, requirePermission('energia_eletrica'), async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT *
      FROM monitoramento_energia_iot
      ORDER BY data_hora_registro DESC, id DESC
      LIMIT 1
    `);
    res.json(rows[0] ? normalizeEnergyReading(rows[0]) : null);
  } catch (err) {
    console.error('Error fetching current energy IOT data:', err);
    res.status(500).json({ error: 'Erro ao buscar monitoramento elétrico atual.' });
  }
});

app.get('/api/energia/iot/historico', requireAuth, requirePermission('energia_eletrica'), async (req, res) => {
  try {
    const { inicio, fim, fornecedor, criticidade, status_rede, somente_alarmados, limit: queryLimit } = req.query;
    const { whereClause, params } = buildEnergyIotWhere({ inicio, fim, fornecedor, criticidade, status_rede, somente_alarmados });
    let sql = `
      SELECT *
      FROM monitoramento_energia_iot
      ${whereClause}
      ORDER BY data_hora_registro DESC, id DESC
    `;

    if (queryLimit) {
      sql += ' LIMIT ?';
      params.push(parseLimit(queryLimit, 1000, 10000));
    }

    const [rows] = await pool.query(sql, params);
    res.json(rows.map(normalizeEnergyReading));
  } catch (err) {
    console.error('Error fetching energy IOT history:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico elétrico.' });
  }
});

app.get('/api/energia/iot/stats', requireAuth, requirePermission('energia_eletrica'), async (req, res) => {
  try {
    const { inicio, fim, fornecedor, criticidade, status_rede } = req.query;
    const { whereClause, params } = buildEnergyIotWhere({ inicio, fim, fornecedor, criticidade, status_rede });

    const [statsRows] = await pool.query(`
      SELECT
        COUNT(*) AS total_leituras,
        SUM(alarme_ativo = 'SIM') AS total_alarmes,
        SUM(leitura_valida = 'INVALIDA') AS leituras_invalidas,
        SUM(fornecedor_energia = 'CONCESSIONARIA') AS leituras_concessionaria,
        SUM(fornecedor_energia = 'GERADOR') AS leituras_gerador,
        AVG(v1_tensao_v) AS v1_avg,
        AVG(v2_tensao_v) AS v2_avg,
        AVG(v3_tensao_v) AS v3_avg,
        MIN(LEAST(v1_tensao_v, v2_tensao_v, v3_tensao_v)) AS menor_tensao_fn,
        MAX(GREATEST(v1_tensao_v, v2_tensao_v, v3_tensao_v)) AS maior_tensao_fn,
        AVG(tensao_media_fase_neutro_v) AS media_fn,
        AVG(tensao_rede_linha_linha_estimado_v) AS media_ff,
        AVG(desequilibrio_percentual) AS desequilibrio_avg,
        MAX(desequilibrio_percentual) AS desequilibrio_max,
        MIN(data_hora_registro) AS data_inicio,
        MAX(data_hora_registro) AS data_fim
      FROM monitoramento_energia_iot
      ${whereClause}
    `, params);

    const [statusRows] = await pool.query(`
      SELECT status_rede, criticidade, fornecedor_energia, COUNT(*) AS total
      FROM monitoramento_energia_iot
      ${whereClause}
      GROUP BY status_rede, criticidade, fornecedor_energia
      ORDER BY total DESC
    `, params);

    res.json({
      geral: normalizeEnergyStats(statsRows[0] || {}),
      distribuicao: statusRows,
      limites: ENERGY_LIMITS,
    });
  } catch (err) {
    console.error('Error fetching energy IOT stats:', err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas elétricas.' });
  }
});

app.get('/api/energia/iot/inconformidades', requireAuth, requirePermission('energia_eletrica'), async (req, res) => {
  try {
    const { inicio, fim, fornecedor, criticidade, status_rede, limit: queryLimit } = req.query;
    const { whereClause, params } = buildEnergyIotWhere({
      inicio,
      fim,
      fornecedor,
      criticidade,
      status_rede,
      somente_alarmados: 'true',
    });

    const [rows] = await pool.query(`
      SELECT *
      FROM monitoramento_energia_iot
      ${whereClause}
      ORDER BY data_hora_registro DESC, id DESC
      LIMIT ?
    `, [...params, parseLimit(queryLimit, 100, 500)]);

    res.json(rows.map(normalizeEnergyReading));
  } catch (err) {
    console.error('Error fetching energy nonconformities:', err);
    res.status(500).json({ error: 'Erro ao buscar inconformidades elétricas.' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PDF REPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/relatorio/pdf', requireAuth, async (req, res) => {
  try {
    const { inicio, fim, sala, centro_custo } = req.body;
    const limits = await getLimitsForSector(centro_custo);

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
        MIN(${HUMIDITY_SQL}) AS umid_min, MAX(${HUMIDITY_SQL}) AS umid_max, AVG(${HUMIDITY_SQL}) AS umid_avg,
        COUNT(*) AS total,
        SUM(CASE WHEN temperatura_c < ${limits.temp.min} OR temperatura_c > ${limits.temp.max} THEN 1 ELSE 0 END) AS alertas_temp,
        SUM(CASE WHEN ${HUMIDITY_SQL} < ${limits.umid.min} OR ${HUMIDITY_SQL} > ${limits.umid.max} THEN 1 ELSE 0 END) AS alertas_umid
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
      ['Temperatura (°C)', parseFloat(stats[0].temp_min).toFixed(1), parseFloat(stats[0].temp_max).toFixed(1), parseFloat(stats[0].temp_avg).toFixed(1), String(limits.temp.min), String(limits.temp.max)],
      ['Umidade (%)', String(normalizeHumidity(stats[0].umid_min)), String(normalizeHumidity(stats[0].umid_max)), normalizeHumidity(stats[0].umid_avg).toFixed(1), String(limits.umid.min), String(limits.umid.max)],
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
        String(normalizeHumidity(r.umidade_pct) || ''),
        r.bateria || '',
        r.online || '',
      ];

      xPos = 50;
      for (let j = 0; j < cellData.length; j++) {
        const isAlert = (j === 2 && (parseFloat(cellData[j]) < limits.temp.min || parseFloat(cellData[j]) > limits.temp.max))
          || (j === 3 && (parseInt(cellData[j]) < limits.umid.min || parseInt(cellData[j]) > limits.umid.max));

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

function roundNumber(value, decimals = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(decimals));
}

function normalizePermission(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function parseNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function calcLineLineVoltage(a, b) {
  const va = parseNullableNumber(a);
  const vb = parseNullableNumber(b);
  if (!Number.isFinite(va) || !Number.isFinite(vb)) return null;
  return roundNumber(Math.sqrt((va ** 2) + (vb ** 2) + (va * vb)), 2);
}

function classifyVoltage(value, limits = ENERGY_LIMITS.faseNeutro) {
  const voltage = parseNullableNumber(value);
  if (!Number.isFinite(voltage)) return 'sem_leitura';
  if (voltage < limits.min || voltage > limits.max) return 'critico';

  const lowerAttention = limits.min + ((limits.nominal - limits.min) * 0.2);
  const upperAttention = limits.max - ((limits.max - limits.nominal) * 0.2);
  if (voltage <= lowerAttention || voltage >= upperAttention) return 'atencao';

  return 'normal';
}

function normalizeEnergyReading(row) {
  const v1 = parseNullableNumber(row.v1_tensao_v);
  const v2 = parseNullableNumber(row.v2_tensao_v);
  const v3 = parseNullableNumber(row.v3_tensao_v);
  const v12 = calcLineLineVoltage(v1, v2);
  const v23 = calcLineLineVoltage(v2, v3);
  const v13 = calcLineLineVoltage(v1, v3);

  return {
    ...row,
    v1_tensao_v: v1,
    v2_tensao_v: v2,
    v3_tensao_v: v3,
    tensao_media_fase_neutro_v: parseNullableNumber(row.tensao_media_fase_neutro_v),
    tensao_rede_linha_linha_estimado_v: parseNullableNumber(row.tensao_rede_linha_linha_estimado_v),
    desequilibrio_percentual: parseNullableNumber(row.desequilibrio_percentual),
    v12_tensao_v: v12,
    v23_tensao_v: v23,
    v13_tensao_v: v13,
    v1_status_normativo: classifyVoltage(v1),
    v2_status_normativo: classifyVoltage(v2),
    v3_status_normativo: classifyVoltage(v3),
    v12_status_normativo: classifyVoltage(v12, ENERGY_LIMITS.faseFase),
    v23_status_normativo: classifyVoltage(v23, ENERGY_LIMITS.faseFase),
    v13_status_normativo: classifyVoltage(v13, ENERGY_LIMITS.faseFase),
  };
}

function normalizeEnergyStats(stats) {
  const total = Number(stats.total_leituras) || 0;
  const concessionaria = Number(stats.leituras_concessionaria) || 0;
  const gerador = Number(stats.leituras_gerador) || 0;

  return {
    ...stats,
    total_leituras: total,
    total_alarmes: Number(stats.total_alarmes) || 0,
    leituras_invalidas: Number(stats.leituras_invalidas) || 0,
    leituras_concessionaria: concessionaria,
    leituras_gerador: gerador,
    concessionaria_pct: total ? roundNumber((concessionaria / total) * 100, 1) : 0,
    gerador_pct: total ? roundNumber((gerador / total) * 100, 1) : 0,
    v1_avg: parseNullableNumber(stats.v1_avg),
    v2_avg: parseNullableNumber(stats.v2_avg),
    v3_avg: parseNullableNumber(stats.v3_avg),
    menor_tensao_fn: parseNullableNumber(stats.menor_tensao_fn),
    maior_tensao_fn: parseNullableNumber(stats.maior_tensao_fn),
    media_fn: parseNullableNumber(stats.media_fn),
    media_ff: parseNullableNumber(stats.media_ff),
    desequilibrio_avg: parseNullableNumber(stats.desequilibrio_avg),
    desequilibrio_max: parseNullableNumber(stats.desequilibrio_max),
  };
}

async function loadLoginUsers() {
  if (Date.now() - loginCsvCache.loadedAt < LOGIN_CSV_CACHE_MS && loginCsvCache.users.length) {
    return loginCsvCache.users;
  }

  const response = await fetch(env.SHEETS_CSV_URL);
  if (!response.ok) throw new Error(`Login CSV HTTP ${response.status}`);

  const rows = parseCsv(await response.text());
  const users = rows.map((row) => {
    const values = Object.values(row);
    return {
      login: rowValue(row, 'login', 'usuario', 'user') || values[0] || '',
      senha: rowValue(row, 'senha', 'password') || values[1] || '',
      permissao: rowValue(row, 'permissao', 'permissão', 'perfil') || values.slice(2).join(', '),
    };
  }).filter(user => user.login && user.senha);

  loginCsvCache = { loadedAt: Date.now(), users };
  return users;
}

function normalizeHumidity(value) {
  const humidity = parseNullableNumber(value);
  if (!Number.isFinite(humidity)) return null;
  if (humidity > 100 && humidity <= 1000) return roundNumber(humidity / 10, 1);
  return roundNumber(humidity, 1);
}

function normalizeTemperatureReading(row) {
  return {
    ...row,
    temperatura_c: parseFloat(row.temperatura_c),
    umidade_pct: normalizeHumidity(row.umidade_pct),
  };
}

async function getLimitsForSector(sector) {
  const sectorKey = normalizePermission(sector || '');
  if (!LIMITS_CSV_URL) return { ...LIMITS };

  const bySector = await loadSectorLimits();
  if (!sectorKey) return getAggregateLimits(bySector);
  return bySector.get(sectorKey) || bySector.get('padrao') || getAggregateLimits(bySector);
}

function getAggregateLimits(bySector) {
  const limits = [...bySector.values()];
  if (!limits.length) return { ...LIMITS };

  const uniqueTargets = (items, key) => [...new Set(items.map(item => item[key].target).filter(Number.isFinite))];
  const tempTargets = uniqueTargets(limits, 'temp');
  const humidityTargets = uniqueTargets(limits, 'umid');
  const norms = [...new Set(limits.map(item => item.norma).filter(Boolean))];

  return {
    temp: {
      min: Math.min(...limits.map(item => item.temp.min)),
      max: Math.max(...limits.map(item => item.temp.max)),
      target: tempTargets.length === 1 ? tempTargets[0] : LIMITS.temp.target,
    },
    umid: {
      min: Math.min(...limits.map(item => item.umid.min)),
      max: Math.max(...limits.map(item => item.umid.max)),
      target: humidityTargets.length === 1 ? humidityTargets[0] : LIMITS.umid.target,
    },
    setor: 'TODOS',
    modo: 'multissetor',
    setores: limits.map(item => item.setor),
    norma: norms.length === 1 ? norms[0] : 'Regras por setor',
    descricao: `${limits.length} salas com metas individuais`,
  };
}

async function loadSectorLimits() {
  if (Date.now() - limitsCache.loadedAt < LIMITS_CACHE_MS) {
    return limitsCache.bySector;
  }

  try {
    const response = await fetch(LIMITS_CSV_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const rows = parseCsv(await response.text());
    const bySector = new Map();

    for (const row of rows) {
      const sector = rowValue(row, 'centro_custo', 'setor', 'centro_de_custo');
      const active = normalizePermission(rowValue(row, 'ativo', 'status') || 'sim');
      if (!sector || ['nao', 'não', 'inativo', 'false', '0'].includes(active)) continue;

      bySector.set(normalizePermission(sector), {
        temp: {
          min: parseConfiguredNumber(rowValue(row, 'temperatura_minima_c', 'temperatura_minimac', 'temperatura_minima', 'temp_min'), LIMITS.temp.min),
          max: parseConfiguredNumber(rowValue(row, 'temperatura_maxima_c', 'temperatura_maximac', 'temperatura_maxima', 'temp_max'), LIMITS.temp.max),
          target: parseConfiguredNumber(rowValue(row, 'temperatura_alvo_c', 'temperatura_alvoc', 'temperatura_alvo', 'temp_alvo'), LIMITS.temp.target),
        },
        umid: {
          min: parseConfiguredNumber(rowValue(row, 'umidade_minima_pct', 'umidade_minima', 'umid_min'), LIMITS.umid.min),
          max: parseConfiguredNumber(rowValue(row, 'umidade_maxima_pct', 'umidade_maxima', 'umid_max'), LIMITS.umid.max),
          target: parseConfiguredNumber(rowValue(row, 'umidade_alvo_pct', 'umidade_alvo', 'umid_alvo'), LIMITS.umid.target),
        },
        setor: sector,
        norma: rowValue(row, 'norma', 'referencia_normativa') || LIMITS.norma,
        descricao: rowValue(row, 'descricao', 'observacao', 'ambiente') || LIMITS.descricao,
      });
    }

    limitsCache = { loadedAt: Date.now(), bySector };
    return bySector;
  } catch (err) {
    console.error('Error loading sector limits CSV:', err);
    limitsCache = { loadedAt: Date.now(), bySector: new Map() };
    return limitsCache.bySector;
  }
}

function parseCsv(text) {
  const rows = [];
  let current = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      current.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      current.push(value);
      if (current.some(cell => cell.trim())) rows.push(current);
      current = [];
      value = '';
    } else {
      value += char;
    }
  }

  current.push(value);
  if (current.some(cell => cell.trim())) rows.push(current);
  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeHeader);
  return rows.slice(1).map(row => Object.fromEntries(headers.map((header, index) => [header, (row[index] || '').trim()])));
}

function normalizeHeader(value) {
  return normalizePermission(value)
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .replace(/^temp_/, 'temperatura_')
    .replace(/^umid_/, 'umidade_');
}

function rowValue(row, ...keys) {
  for (const key of keys) {
    const value = row[normalizeHeader(key)];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function parseConfiguredNumber(value, fallback) {
  const number = Number(String(value || '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : fallback;
}

function buildEnergyIotWhere(filters = {}) {
  let whereClause = 'WHERE 1 = 1';
  const params = [];

  if (filters.inicio) { whereClause += ' AND data_hora_registro >= ?'; params.push(filters.inicio); }
  if (filters.fim) { whereClause += ' AND data_hora_registro <= ?'; params.push(filters.fim); }
  if (filters.fornecedor) { whereClause += ' AND fornecedor_energia = ?'; params.push(filters.fornecedor); }
  if (filters.criticidade) { whereClause += ' AND criticidade = ?'; params.push(filters.criticidade); }
  if (filters.status_rede) { whereClause += ' AND status_rede = ?'; params.push(filters.status_rede); }
  if (filters.somente_alarmados === 'true' || filters.somente_alarmados === true) {
    whereClause += " AND (alarme_ativo = 'SIM' OR leitura_valida = 'INVALIDA' OR status_rede <> 'NORMAL')";
  }

  return { whereClause, params };
}

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
