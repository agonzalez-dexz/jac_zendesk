import zendeskClient from "../zendeskClient.js";
import { writeFile } from "fs/promises";

const VIN_FIELD_ID = "41998965643412";
const AREA_FIELD_ID = "41997749373972";
const DIAS_BUSQUEDA = 30;
const MAX_PAGINAS = 10;

const AREA_POSVENTA = "posventa";
const ESTADOS_RESUELTOS = ["solved", "closed"];

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

function extraerArea(ticket) {
  return extraerCampoPersonalizado(ticket, AREA_FIELD_ID);
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

function esTicketActivo(ticket) {
  return !ESTADOS_RESUELTOS.includes(ticket.status);
}

function esTicketResuelto(ticket) {
  return ESTADOS_RESUELTOS.includes(ticket.status);
}

function obtenerFechaSinHora(fechaISO) {
  return fechaISO.split("T")[0];
}

function agruparPorVIN(tickets) {
  const grupos = {};
  
  for (const ticket of tickets) {
    const vin = extraerVIN(ticket);
    
    if (!vin || vin === "") {
      continue;
    }
    
    if (!grupos[vin]) {
      grupos[vin] = [];
    }
    
    grupos[vin].push(ticket);
  }
  
  return grupos;
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

async function validarReglasGrupo(ticketsGrupo, cacheSolicitantes = {}) {
  if (ticketsGrupo.length < 2) {
    return { valido: false, motivo: "Menos de 2 tickets en el grupo" };
  }
  
  const primerTicket = ticketsGrupo[0];
  const requesterId = primerTicket.requester_id;
  
  if (!requesterId) {
    return { valido: false, motivo: "Ticket sin solicitante" };
  }
  
  if (!cacheSolicitantes[requesterId]) {
    cacheSolicitantes[requesterId] = await obtenerDatosSolicitante(requesterId);
  }
  
  const datosSolicitanteBase = cacheSolicitantes[requesterId];
  
  if (!datosSolicitanteBase.email && !datosSolicitanteBase.phone) {
    return { valido: false, motivo: "Solicitante sin email ni teléfono" };
  }
  
  let ticketsActivos = 0;
  let ticketPadre = null;
  const requestersUnicos = new Set();
  
  for (const ticket of ticketsGrupo) {
    if (ticket.requester_id !== requesterId) {
      return { valido: false, motivo: "Solicitantes diferentes en el grupo" };
    }
    
    requestersUnicos.add(ticket.requester_id);
    
    if (!cacheSolicitantes[ticket.requester_id]) {
      cacheSolicitantes[ticket.requester_id] = await obtenerDatosSolicitante(ticket.requester_id);
    }
    
    const datosTicket = cacheSolicitantes[ticket.requester_id];
    
    if (datosSolicitanteBase.email && datosTicket.email) {
      if (datosSolicitanteBase.email !== datosTicket.email) {
        return { valido: false, motivo: "Correo del solicitante no coincide" };
      }
    }
    
    if (datosSolicitanteBase.phone && datosTicket.phone) {
      if (datosSolicitanteBase.phone !== datosTicket.phone) {
        return { valido: false, motivo: "Teléfono del solicitante no coincide" };
      }
    }
    
    if (esTicketActivo(ticket)) {
      ticketsActivos++;
    }
    
    const area = extraerArea(ticket);
    if (area === AREA_POSVENTA && !esTicketResuelto(ticket)) {
      if (!ticketPadre) {
        ticketPadre = ticket;
      }
    }
  }
  
  if (ticketsActivos !== 1) {
    return { valido: false, motivo: `Cantidad de tickets activos incorrecta: ${ticketsActivos} (debe ser 1)` };
  }
  
  if (!ticketPadre) {
    return { valido: false, motivo: "No existe ticket padre con Área=Posventa y estado no resuelto" };
  }
  
  return { 
    valido: true, 
    ticketPadre,
    ticketsCandidatos: ticketsGrupo.filter(t => t.id !== ticketPadre.id)
  };
}

async function marcarTicketsConTags(ticketIds, tags) {
  const resultados = [];
  
  for (const ticketId of ticketIds) {
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
    } catch (error) {
      console.error(`Error al marcar ticket ${ticketId}:`, error.message);
      resultados.push({ ticketId, exito: false, error: error.message });
    }
  }
  
  return resultados;
}

function mostrarResultados(candidatos, excluidos) {
  console.log("\n=== PRE-MERGE: DETECCIÓN DE CANDIDATOS ===\n");
  console.log(`Período de búsqueda: últimos ${DIAS_BUSQUEDA} días`);
  console.log(`Grupos candidatos: ${candidatos.length}`);
  console.log(`Grupos excluidos: ${excluidos.length}\n`);
  
  if (candidatos.length > 0) {
    console.log("=== CANDIDATOS A MERGE ===\n");
    for (const candidato of candidatos) {
      console.log(`VIN: ${candidato.vin}`);
      console.log(`Ticket padre: #${candidato.ticketPadre.id} - ${candidato.ticketPadre.subject}`);
      console.log(`Tickets candidatos: ${candidato.ticketsCandidatos.map(t => `#${t.id}`).join(", ")}`);
      console.log("");
    }
  }
  
  if (excluidos.length > 0) {
    console.log("=== GRUPOS EXCLUIDOS ===\n");
    for (const excluido of excluidos) {
      console.log(`VIN: ${excluido.vin}`);
      console.log(`Motivo: ${excluido.motivo}`);
      console.log(`Tickets: ${excluido.tickets.map(t => `#${t.id}`).join(", ")}`);
      console.log("");
    }
  }
}

async function guardarResultados(candidatos, excluidos) {
  const resultado = {
    fecha_analisis: new Date().toISOString(),
    dias_busqueda: DIAS_BUSQUEDA,
    total_candidatos: candidatos.length,
    total_excluidos: excluidos.length,
    candidatos: candidatos.map(c => ({
      vin: c.vin,
      ticket_padre: {
        id: c.ticketPadre.id,
        subject: c.ticketPadre.subject,
        status: c.ticketPadre.status
      },
      tickets_candidatos: c.ticketsCandidatos.map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status
      }))
    })),
    excluidos: excluidos.map(e => ({
      vin: e.vin,
      motivo: e.motivo,
      tickets: e.tickets.map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status
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
  console.log("Iniciando pre-merge de tickets duplicados por VIN...");
  
  try {
    const tickets = await buscarTickets(DIAS_BUSQUEDA);
    console.log(`Tickets encontrados: ${tickets.length}`);
    
    if (tickets.length === 0) {
      console.log("No se encontraron tickets para analizar.");
      return { total_tickets: 0, total_candidatos: 0, total_excluidos: 0 };
    }
    
    const grupos = agruparPorVIN(tickets);
    console.log(`Grupos por VIN encontrados: ${Object.keys(grupos).length}`);
    
    const candidatos = [];
    const excluidos = [];
    const cacheSolicitantes = {};
    
    for (const vin in grupos) {
      try {
        const validacion = await validarReglasGrupo(grupos[vin], cacheSolicitantes);
        
        if (validacion.valido) {
          const todosLosIds = [
            validacion.ticketPadre.id,
            ...validacion.ticketsCandidatos.map(t => t.id)
          ];
          
          await marcarTicketsConTags(todosLosIds, ["pre_merge_vin", "merge_validado"]);
          
          candidatos.push({
            vin,
            ticketPadre: validacion.ticketPadre,
            ticketsCandidatos: validacion.ticketsCandidatos
          });
        } else {
          excluidos.push({
            vin,
            motivo: validacion.motivo,
            tickets: grupos[vin]
          });
        }
      } catch (error) {
        console.error(`Error procesando grupo VIN ${vin}:`, error.message);
        excluidos.push({
          vin,
          motivo: `Error en validación: ${error.message}`,
          tickets: grupos[vin]
        });
      }
    }
    
    mostrarResultados(candidatos, excluidos);
    await guardarResultados(candidatos, excluidos);
    await guardarDuplicadosVIN(tickets);
    
    console.log("\nPre-merge completado.");
    return {
      total_tickets: tickets.length,
      total_candidatos: candidatos.length,
      total_excluidos: excluidos.length
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

