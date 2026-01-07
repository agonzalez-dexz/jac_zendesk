import zendeskClient from "../zendeskClient.js";
import { writeFile } from "fs/promises";

const VIN_FIELD_ID = "PLACEHOLDER_VIN_FIELD_ID";
const DIAS_BUSQUEDA = 7;
const MAX_PAGINAS = 10;

function obtenerFechaSinHora(fechaISO) {
  return fechaISO.split("T")[0];
}

function extraerVIN(ticket) {
  if (!ticket.custom_fields || !Array.isArray(ticket.custom_fields)) {
    return null;
  }
  
  const campoVIN = ticket.custom_fields.find(
    (campo) => campo.id === parseInt(VIN_FIELD_ID)
  );
  
  return campoVIN && campoVIN.value ? campoVIN.value.trim() : null;
}

async function buscarTickets(dias) {
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() - dias);
  const fechaISO = fechaLimite.toISOString().split("T")[0];
  
  const query = `type:ticket created>=${fechaISO}`;
  
  try {
    let todosLosTickets = [];
    let nextPageUrl = null;
    let paginaActual = 0;
    
    do {
      try {
        const response = nextPageUrl 
          ? await zendeskClient.get(nextPageUrl)
          : await zendeskClient.get("/search.json", { params: { query } });
        
        todosLosTickets = todosLosTickets.concat(response.data.results || []);
        paginaActual++;
        nextPageUrl = response.data.next_page || null;
        
        if (nextPageUrl) {
          const urlObj = new URL(nextPageUrl);
          let pathname = urlObj.pathname;
          if (pathname.startsWith("/api/v2")) {
            pathname = pathname.replace("/api/v2", "");
          }
          nextPageUrl = pathname + urlObj.search;
        }
        
        if (paginaActual >= MAX_PAGINAS) {
          console.log(`Límite de páginas alcanzado (${MAX_PAGINAS}). Procesando resultados obtenidos hasta ahora.`);
          nextPageUrl = null;
        }
      } catch (error) {
        if (error.response && error.response.status === 422) {
          console.log("Límite de búsqueda de Zendesk alcanzado. Procesando resultados obtenidos hasta ahora.");
          break;
        }
        throw error;
      }
    } while (nextPageUrl);
    
    return todosLosTickets;
  } catch (error) {
    console.error("Error al buscar tickets:", error.message);
    throw error;
  }
}

function agruparPorVINyFecha(tickets) {
  const grupos = {};
  
  for (const ticket of tickets) {
    const vin = extraerVIN(ticket);
    
    if (!vin || vin === "") {
      continue;
    }
    
    const fecha = obtenerFechaSinHora(ticket.created_at);
    const clave = `${vin}|${fecha}`;
    
    if (!grupos[clave]) {
      grupos[clave] = {
        vin,
        fecha,
        tickets: []
      };
    }
    
    grupos[clave].tickets.push({
      ticket_id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      created_at: ticket.created_at
    });
  }
  
  return grupos;
}

function detectarDuplicados(grupos) {
  const duplicados = [];
  
  for (const clave in grupos) {
    const grupo = grupos[clave];
    
    if (grupo.tickets.length >= 2) {
      duplicados.push(grupo);
    }
  }
  
  return duplicados;
}

function mostrarResultados(duplicados) {
  console.log("\n=== DETECCIÓN DE TICKETS DUPLICADOS POR VIN ===\n");
  console.log(`Período de búsqueda: últimos ${DIAS_BUSQUEDA} días`);
  console.log(`Total de grupos duplicados encontrados: ${duplicados.length}\n`);
  
  if (duplicados.length === 0) {
    console.log("No se encontraron tickets duplicados.");
    return;
  }
  
  for (const grupo of duplicados) {
    console.log(`VIN: ${grupo.vin}`);
    console.log(`Fecha: ${grupo.fecha}`);
    console.log(`Cantidad de tickets: ${grupo.tickets.length}`);
    console.log("Tickets:");
    
    for (const ticket of grupo.tickets) {
      console.log(`  - ID: ${ticket.ticket_id} | ${ticket.subject} | Status: ${ticket.status}`);
    }
    console.log("");
  }
}

async function guardarResultados(duplicados) {
  const resultado = {
    fecha_analisis: new Date().toISOString(),
    dias_busqueda: DIAS_BUSQUEDA,
    total_duplicados: duplicados.length,
    duplicados
  };
  
  const contenido = JSON.stringify(resultado, null, 2);
  
  try {
    await writeFile("duplicados_vin.json", contenido, "utf8");
    console.log(`\nResultados guardados en: duplicados_vin.json`);
  } catch (error) {
    console.error("Error al guardar resultados:", error.message);
    throw error;
  }
}

export async function ejecutarDetectarDuplicadosVIN() {
  console.log("Iniciando detección de tickets duplicados por VIN...");
  
  try {
    const tickets = await buscarTickets(DIAS_BUSQUEDA);
    console.log(`Tickets encontrados: ${tickets.length}`);
    
    if (tickets.length === 0) {
      console.log("No se encontraron tickets para analizar.");
      return { total_tickets: 0, total_duplicados: 0 };
    }
    
    const grupos = agruparPorVINyFecha(tickets);
    const duplicados = detectarDuplicados(grupos);
    
    mostrarResultados(duplicados);
    await guardarResultados(duplicados);
    
    console.log("\nAnálisis completado.");
    return {
      total_tickets: tickets.length,
      total_duplicados: duplicados.length
    };
  } catch (error) {
    console.error("Error crítico en detección de duplicados:", error.message);
    throw error;
  }
}

(async () => {
  try {
    console.log("▶ Iniciando batch de detección de duplicados por VIN...");
    await ejecutarDetectarDuplicadosVIN();
    console.log("▶ Batch finalizado");
  } catch (error) {
    console.error("✖ Error ejecutando el batch:", error);
  }
})();

