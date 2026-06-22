import app, { PORT } from './api/index.js';

// START SERVER (For local development)
app.listen(PORT, () => {
  console.log(`\n🏥 Hub de Monitoramento HRRM`);
  console.log(`   Servidor local rodando em http://localhost:${PORT}\n`);
});
