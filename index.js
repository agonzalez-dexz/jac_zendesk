import cron from "node-cron";
import { ejecutarBatch48h } from "./batch48h.js";

const esEjecucionManual = process.argv.includes("--manual");

if (esEjecucionManual) {
  console.log("Ejecución manual iniciada...");
  ejecutarBatch48h()
    .then(() => {
      console.log("Ejecución manual completada");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Error en ejecución manual:", error);
      process.exit(1);
    });
} else {
  console.log("Scheduler iniciado. Ejecución programada a las 02:00 AM diariamente");
  
  cron.schedule("0 2 * * *", () => {
    console.log("Ejecutando batch programado...");
    ejecutarBatch48h()
      .then(() => {
        console.log("Batch programado completado");
      })
      .catch((error) => {
        console.error("Error en batch programado:", error);
      });
  });
}

