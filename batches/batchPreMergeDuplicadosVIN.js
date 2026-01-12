import zendeskClient from "../zendeskClient.js";
import { writeFile } from "fs/promises";

const VIN_FIELD_ID = "41998965643412";
const DIAS_BUSQUEDA = 10;
const MAX_PAGINAS = 10;

const TAG_ANALIZADO_PRE_MERGE = "analizado_pre_merge_vin";
const TAG_CANDIDATO_MERGE = "pre_merge_vin";
const TAG_MERGE_VALIDADO = "merge_validado";

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

function extraerCampoPersonalizado(ticket, fieldId) {
  if (!ticket.custom_fields || !Array.isArray(ticket.custom_fields)) {
    return null;
  }
  
  const campo = ticket.custom_fields.find(
    (campo) => campo.id === parseInt(fieldId)
  );
  
  return campo && campo.value ? String(campo.value).trim().toLowerCase() : null;
}

function extraerVIN(ticket) {
  return extraerCampoPersonalizado(ticket, VIN_FIELD_ID);
}


async function obtenerDatosSolicitante(requesterId) {
  try {
    const response = await zendeskClient.get(`/users/${requesterId}.json`);
    const user = response.data.user;
    
    return {
      email: user.email ? user.email.toLowerCase().trim() : null,
      phone: user.phone ? user.phone.trim() : null
    };
  } catch (error) {
    console.error(`Error al obtener datos del solicitante ${requesterId}:`, error.message);
    return { email: null, phone: null };
  }
}


function obtenerFechaSinHora(fechaISO) {
  return fechaISO.split("T")[0];
}

async function agruparCandidatosMerge(tickets, cacheSolicitantes = {}) {
  const gruposVIN = {};
  const gruposContacto = {};
  
  for (const ticket of tickets) {
    const fecha = obtenerFechaSinHora(ticket.created_at);
    const vin = extraerVIN(ticket);
    
    if (vin && vin !== "") {
      const claveVIN = `vin:${vin}|fecha:${fecha}`;
      if (!gruposVIN[claveVIN]) {
        gruposVIN[claveVIN] = [];
      }
      gruposVIN[claveVIN].push(ticket);
    }
    
    if (ticket.requester_id) {
      if (!cacheSolicitantes[ticket.requester_id]) {
        cacheSolicitantes[ticket.requester_id] = await obtenerDatosSolicitante(ticket.requester_id);
      }
      
      const datosSolicitante = cacheSolicitantes[ticket.requester_id];
      const email = datosSolicitante.email;
      const phone = datosSolicitante.phone;
      
      if (email && email !== "") {
        const claveEmail = `email:${email}|fecha:${fecha}`;
        if (!gruposContacto[claveEmail]) {
          gruposContacto[claveEmail] = [];
        }
        gruposContacto[claveEmail].push(ticket);
      }
      
      if (phone && phone !== "") {
        const clavePhone = `phone:${phone}|fecha:${fecha}`;
        if (!gruposContacto[clavePhone]) {
          gruposContacto[clavePhone] = [];
        }
        gruposContacto[clavePhone].push(ticket);
      }
    }
  }
  
  const todosLosGrupos = {};
  
  for (const clave in gruposVIN) {
    if (gruposVIN[clave].length >= 2) {
      const idsUnicos = gruposVIN[clave].map(t => t.id).sort().join(",");
      if (!todosLosGrupos[idsUnicos]) {
        todosLosGrupos[idsUnicos] = {
          tipo: "vin",
          criterio: clave,
          tickets: gruposVIN[clave]
        };
      }
    }
  }
  
  for (const clave in gruposContacto) {
    if (gruposContacto[clave].length >= 2) {
      const idsUnicos = gruposContacto[clave].map(t => t.id).sort().join(",");
      if (!todosLosGrupos[idsUnicos]) {
        todosLosGrupos[idsUnicos] = {
          tipo: clave.startsWith("email:") ? "email" : "telefono",
          criterio: clave,
          tickets: gruposContacto[clave]
        };
      }
    }
  }
  
  return Object.values(todosLosGrupos);
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

function validarGrupoCandidato(grupo) {
  if (grupo.tickets.length < 2) {
    return { valido: false, motivo: "Menos de 2 tickets en el grupo" };
  }
  
  return { 
    valido: true,
    tipo: grupo.tipo,
    criterio: grupo.criterio,
    tickets: grupo.tickets
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function marcarTicketsConTags(ticketIds, tags) {
  const resultados = [];
  const DELAY_ENTRE_PETICIONES = 300;
  const MAX_REINTENTOS = 3;
  const DELAY_REINTENTO_BASE = 2000;
  
  for (const ticketId of ticketIds) {
    let reintentos = 0;
    let exito = false;
    
    while (reintentos < MAX_REINTENTOS && !exito) {
      try {
        const ticket = await zendeskClient.get(`/tickets/${ticketId}.json`);
        const tagsActuales = ticket.data.ticket.tags || [];
        
        const tagsNuevos = [...new Set([...tagsActuales, ...tags])];
        
        await zendeskClient.put(`/tickets/${ticketId}.json`, {
          ticket: {
            tags: tagsNuevos
          }
        });
        
        resultados.push({ ticketId, exito: true });
        exito = true;
        
        if (reintentos > 0) {
          console.log(`Ticket ${ticketId} marcado exitosamente después de ${reintentos} reintentos`);
        }
      } catch (error) {
        if (error.response && error.response.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || DELAY_REINTENTO_BASE;
          const delayReintento = parseInt(retryAfter) * 1000 || DELAY_REINTENTO_BASE * Math.pow(2, reintentos);
          
          reintentos++;
          
          if (reintentos < MAX_REINTENTOS) {
            console.log(`Rate limit alcanzado para ticket ${ticketId}. Reintentando en ${delayReintento}ms (intento ${reintentos}/${MAX_REINTENTOS})`);
            await delay(delayReintento);
          } else {
            console.error(`Error al marcar ticket ${ticketId} después de ${MAX_REINTENTOS} reintentos:`, error.message);
            resultados.push({ ticketId, exito: false, error: error.message });
          }
        } else {
          console.error(`Error al marcar ticket ${ticketId}:`, error.message);
          resultados.push({ ticketId, exito: false, error: error.message });
          exito = true;
        }
      }
    }
    
    await delay(DELAY_ENTRE_PETICIONES);
  }
  
  return resultados;
}

function mostrarResultados(candidatos) {
  console.log("\n=== PRE-MERGE: DETECCIÓN DE CANDIDATOS ===\n");
  console.log(`Período de búsqueda: últimos ${DIAS_BUSQUEDA} días`);
  console.log(`Grupos candidatos: ${candidatos.length}\n`);
  
  if (candidatos.length > 0) {
    console.log("=== CANDIDATOS A MERGE ===\n");
    for (const candidato of candidatos) {
      console.log(`Tipo: ${candidato.tipo}`);
      console.log(`Criterio: ${candidato.criterio}`);
      console.log(`Tickets: ${candidato.tickets.map(t => `#${t.id}`).join(", ")}`);
      console.log("");
    }
  }
}

async function guardarResultados(candidatos) {
  const resultado = {
    fecha_analisis: new Date().toISOString(),
    dias_busqueda: DIAS_BUSQUEDA,
    total_candidatos: candidatos.length,
    candidatos: candidatos.map(c => ({
      tipo: c.tipo,
      criterio: c.criterio,
      tickets: c.tickets.map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        created_at: t.created_at,
        requester_id: t.requester_id
      }))
    }))
  };
  
  const contenido = JSON.stringify(resultado, null, 2);
  
  try {
    await writeFile("pre_merge_candidatos.json", contenido, "utf8");
    console.log(`\nResultados guardados en: pre_merge_candidatos.json`);
  } catch (error) {
    console.error("Error al guardar resultados:", error.message);
    throw error;
  }
}

async function guardarDuplicadosVIN(tickets) {
  const grupos = agruparPorVINyFecha(tickets);
  const duplicados = detectarDuplicados(grupos);
  
  const resultado = {
    fecha_analisis: new Date().toISOString(),
    dias_busqueda: DIAS_BUSQUEDA,
    total_duplicados: duplicados.length,
    duplicados
  };
  
  const contenido = JSON.stringify(resultado, null, 2);
  
  try {
    await writeFile("duplicados_vin.json", contenido, "utf8");
    console.log(`Resultados guardados en: duplicados_vin.json`);
  } catch (error) {
    console.error("Error al guardar duplicados_vin.json:", error.message);
    throw error;
  }
}

export async function ejecutarPreMergeDuplicadosVIN() {
  console.log("Iniciando pre-merge de tickets duplicados...");
  
  try {
    const tickets = await buscarTickets(DIAS_BUSQUEDA);
    console.log(`Tickets encontrados: ${tickets.length}`);
    
    if (tickets.length === 0) {
      console.log("No se encontraron tickets para analizar.");
      return { total_tickets: 0, total_candidatos: 0 };
    }
    
    const cacheSolicitantes = {};
    const gruposCandidatos = await agruparCandidatosMerge(tickets, cacheSolicitantes);
    console.log(`Grupos candidatos encontrados: ${gruposCandidatos.length}`);
    
    const candidatos = [];
    const ticketsMarcados = new Set();
    
    for (const grupo of gruposCandidatos) {
      try {
        const validacion = validarGrupoCandidato(grupo);
        
        if (validacion.valido) {
          const todosLosIds = grupo.tickets.map(t => t.id);
          
          await marcarTicketsConTags(todosLosIds, [TAG_ANALIZADO_PRE_MERGE, TAG_CANDIDATO_MERGE, TAG_MERGE_VALIDADO]);
          
          todosLosIds.forEach(id => ticketsMarcados.add(id));
          
          candidatos.push({
            tipo: validacion.tipo,
            criterio: validacion.criterio,
            tickets: grupo.tickets
          });
        }
      } catch (error) {
        console.error(`Error procesando grupo ${grupo.criterio}:`, error.message);
      }
    }
    
    mostrarResultados(candidatos);
    await guardarResultados(candidatos);
    await guardarDuplicadosVIN(tickets);
    
    console.log("\nPre-merge completado.");
    return {
      total_tickets: tickets.length,
      total_candidatos: candidatos.length
    };
  } catch (error) {
    console.error("Error crítico en pre-merge:", error.message);
    throw error;
  }
}

(async () => {
  try {
    console.log("▶ Iniciando batch de pre-merge de duplicados por VIN...");
    await ejecutarPreMergeDuplicadosVIN();
    console.log("▶ Batch finalizado");
  } catch (error) {
    console.error("✖ Error ejecutando el batch:", error);
  }
})();

