// server.js - Versión simplificada: Solo lógica de CRON y administración
require("dotenv").config();

const express = require("express");
const cron = require("node-cron");

const { runNightlyCron } = require("./cron-nightly"); // Importamos el motor del cron
const { mountOAuthRoutes } = require("./0authinstall");

const app = express();
app.use(express.json());

// ---------- OAuth install endpoints (para obtener/renovar el token) ----------
mountOAuthRoutes(app);

// ---------- Endpoints de Estado y Administración ----------

// Página de inicio para ver si el servidor responde
app.get("/", (_req, res) => {
  const hasToken = !!process.env.SHOPIFY_ACCESS_TOKEN;
  res.send(
    hasToken
      ? "✅ VIP Club Middleware activo (Modo CRON activo)"
      : "❌ Token no configurado. Visita /install para autorizar.",
  );
});

/**
 * Endpoint manual para forzar la ejecución del CRON desde fuera (Railway o Postman)
 * Requiere la cabecera 'X-Admin-Key' definida en tu .env
 */
app.post("/admin/run-reconciliation", async (req, res) => {
  const key = req.get("X-Admin-Key");
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).send("No autorizado");
  }

  try {
    console.log("[ADMIN] Forzando ejecución manual de la reconciliación...");
    const stats = await runNightlyCron();
    res.json({
      status: "success",
      message: "Proceso completado",
      details: stats,
    });
  } catch (e) {
    console.error("[ADMIN] Error en ejecución manual:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Arranque del Servidor y Programación ----------

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`\n🚀 Servidor YourOptimum VIP escuchando en puerto ${port}`);
  console.log(`🔧 Modo: Solo CRON Jobs (Webhooks desactivados)`);

  if (!process.env.SHOPIFY_ACCESS_TOKEN) {
    console.log(
      "⚠️  ATENCIÓN: SHOPIFY_ACCESS_TOKEN no configurado. El CRON no funcionará.",
    );
    return;
  }

  // Programación del CRON Nocturno (3:00 AM por defecto)
  const tz = process.env.CRON_TZ || "Europe/Madrid";

  cron.schedule(
    "0 3 * * *",
    async () => {
      console.log("\n🌙 [CRON] Iniciando tarea programada de las 03:00...");
      try {
        await runNightlyCron();
        console.log("✅ [CRON] Tarea finalizada con éxito.");
      } catch (e) {
        console.error(
          "🚨 [CRON] Fallo crítico durante la ejecución:",
          e.message,
        );
      }
    },
    {
      scheduled: true,
      timezone: tz,
    },
  );

  console.log(`📅 CRON programado diariamente a las 03:00 (${tz})`);
});
