import zendeskClient from "../zendeskClient.js";
import { CONFIG } from "../config.js";

const MILISEGUNDOS_48H = 48 * 60 * 60 * 1000;

function haPasado48Horas(createdAt) {
  const fechaCreacion = new Date(createdAt);
  const ahora = new Date();
  const diferencia = ahora - fechaCreacion;
  return diferencia >= MILISEGUNDOS_48H;
}

async function buscarTicketsElegibles() {
  const query = `type:ticket status<solved -tags:${CONFIG.TAG_SEGUIMIENTO}`;
  
  try {
    const response = await zendeskClient.get("/search.json", {
      params: { query }
    });
    
    return response.data.results || [];
  } catch (error) {
    console.error("Error al buscar tickets:", error.message);
    throw error;
  }
}

async function crearTicketSeguimiento(ticketOrigen) {
  const subject = `Seguimiento 48 horas - Ticket #${ticketOrigen.id}`;
  
  const nuevoTicket = {
    ticket: {
      subject,
      form_id: CONFIG.FORM_ID,
      group_id: CONFIG.GROUP_ID,
      priority: CONFIG.PRIORITY,
      requester_id: ticketOrigen.requester_id,
      tags: ["seguimiento_48h", "batch"],
      comment: {
        body: `Ticket de seguimiento automático generado para el ticket #${ticketOrigen.id}`,
        public: false
      },
      custom_fields: [
        {
          id: CONFIG.CAMPOS.PRIMER_CONTACTO.id,
          value: CONFIG.CAMPOS.PRIMER_CONTACTO.value
        },
        {
          id: CONFIG.CAMPOS.AREA.id,
          value: CONFIG.CAMPOS.AREA.value
        }
      ]
    }
  };
  
  try {
    const response = await zendeskClient.post("/tickets.json", nuevoTicket);
    return response.data.ticket;
  } catch (error) {
    console.error(`Error al crear ticket de seguimiento para ticket #${ticketOrigen.id}:`, error.message);
    throw error;
  }
}

async function marcarTicketOrigen(ticketId) {
  try {
    await zendeskClient.put(`/tickets/${ticketId}.json`, {
      ticket: {
        tags: [CONFIG.TAG_SEGUIMIENTO]
      }
    });
  } catch (error) {
    console.error(`Error al marcar ticket #${ticketId}:`, error.message);
    throw error;
  }
}

export async function ejecutarBatch48h() {
  console.log("Iniciando batch de seguimiento 48h...");
  
  try {
    const tickets = await buscarTicketsElegibles();
    console.log(`Encontrados ${tickets.length} tickets candidatos`);
    
    let procesados = 0;
    let errores = 0;
    
    for (const ticket of tickets) {
      try {
        if (!haPasado48Horas(ticket.created_at)) {
          continue;
        }
        
        await crearTicketSeguimiento(ticket);
        await marcarTicketOrigen(ticket.id);
        
        procesados++;
        console.log(`Ticket #${ticket.id} procesado correctamente`);
      } catch (error) {
        errores++;
        console.error(`Error procesando ticket #${ticket.id}:`, error.message);
      }
    }
    
    console.log(`Batch completado. Procesados: ${procesados}, Errores: ${errores}`);
    return { procesados, errores };
  } catch (error) {
    console.error("Error crítico en batch:", error.message);
    throw error;
  }
}