import zendeskClient from "../zendeskClient.js";
import fs from "fs";

const FIELD_ID_VIN = 41998965643412;
const FIELD_KEY_VIN = "vin";
const FIELD_ID_JAC_STORE = 41998797757844;
const FIELD_KEY_JAC_STORE = "jac_store";
const TAG_COMPLETADO = "campos_completados_desde_Batch";
const DIAS_BUSQUEDA = 1;

function obtenerFechaInicio() {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() - DIAS_BUSQUEDA);
  return fecha.toISOString().split("T")[0];
}

function obtenerValorCampoPersonalizado(ticket, fieldId) {
  if (!ticket.custom_fields) return null;
  const campo = ticket.custom_fields.find(cf => cf.id === fieldId);
  return campo ? campo.value : null;
}

function ticketNecesitaCompletar(ticket) {
  const vin = obtenerValorCampoPersonalizado(ticket, FIELD_ID_VIN);
  const jacStore = obtenerValorCampoPersonalizado(ticket, FIELD_ID_JAC_STORE);
  
  const vinVacio = !vin || vin === "";
  const jacStoreVacio = !jacStore || jacStore === "";
  
  return vinVacio || jacStoreVacio;
}

async function buscarTicketsPendientes() {
  const fechaInicio = obtenerFechaInicio();
  const query = `type:ticket created>=${fechaInicio}`;
  
  try {
    const response = await zendeskClient.get("/search.json", {
      params: { query }
    });
    
    const todosLosTickets = response.data.results || [];
    const ticketsPendientes = todosLosTickets.filter(ticket => 
      ticketNecesitaCompletar(ticket) && ticket.requester_id
    );
    
    return ticketsPendientes;
  } catch (error) {
    console.error("Error al buscar tickets pendientes:", error.message);
    throw error;
  }
}

async function obtenerRequester(requesterId) {
  try {
    const response = await zendeskClient.get(`/users/${requesterId}.json`);
    return response.data.user;
  } catch (error) {
    console.error(`Error al obtener requester ${requesterId}:`, error.message);
    throw error;
  }
}

function obtenerValorCampoPeople(user, fieldKey) {
  if (!user || !user.user_fields) return null;
  return user.user_fields[fieldKey] || null;
}

async function obtenerTagsTicket(ticketId) {
  try {
    const response = await zendeskClient.get(`/tickets/${ticketId}.json`);
    return response.data.ticket.tags || [];
  } catch (error) {
    console.error(`Error al obtener tags del ticket ${ticketId}:`, error.message);
    return [];
  }
}

async function actualizarTicket(ticketId, camposActualizar) {
  const customFields = [];
  
  if (camposActualizar.vin !== undefined) {
    customFields.push({
      id: FIELD_ID_VIN,
      value: camposActualizar.vin
    });
  }
  
  if (camposActualizar.jacStore !== undefined) {
    customFields.push({
      id: FIELD_ID_JAC_STORE,
      value: camposActualizar.jacStore
    });
  }
  
  const tags = await obtenerTagsTicket(ticketId);
  if (!tags.includes(TAG_COMPLETADO)) {
    tags.push(TAG_COMPLETADO);
  }
  
  try {
    await zendeskClient.put(`/tickets/${ticketId}.json`, {
      ticket: {
        custom_fields: customFields,
        tags: tags
      }
    });
  } catch (error) {
    console.error(`Error al actualizar ticket ${ticketId}:`, error.message);
    throw error;
  }
}

export async function ejecutarBatchCompletarCampos() {
  console.log("Iniciando batch de completar campos desde requester...");
  
  const resumen = {
    fechaEjecucion: new Date().toISOString(),
    ticketsProcesados: 0,
    ticketsActualizados: 0,
    ticketsOmitidos: 0,
    errores: 0,
    detalles: []
  };
  
  try {
    const tickets = await buscarTicketsPendientes();
    console.log(`Encontrados ${tickets.length} tickets candidatos`);
    
    for (const ticket of tickets) {
      const detalleTicket = {
        ticket_id: ticket.id,
        campos_actualizados: [],
        omitido: false,
        razon_omision: null,
        error: null
      };
      
      try {
        const vinTicket = obtenerValorCampoPersonalizado(ticket, FIELD_ID_VIN);
        const jacStoreTicket = obtenerValorCampoPersonalizado(ticket, FIELD_ID_JAC_STORE);
        
        if (!ticket.requester_id) {
          detalleTicket.omitido = true;
          detalleTicket.razon_omision = "No tiene requester_id";
          console.log(`Ticket #${ticket.id}: Omitido - No tiene requester_id`);
          resumen.ticketsOmitidos++;
          resumen.detalles.push(detalleTicket);
          continue;
        }
        
        const requester = await obtenerRequester(ticket.requester_id);
        const vinRequester = obtenerValorCampoPeople(requester, FIELD_KEY_VIN);
        const jacStoreRequester = obtenerValorCampoPeople(requester, FIELD_KEY_JAC_STORE);
        
        const camposActualizar = {};
        const camposActualizados = [];
        
        if ((!vinTicket || vinTicket === "") && vinRequester) {
          camposActualizar.vin = vinRequester;
          camposActualizados.push("VIN");
        }
        
        if ((!jacStoreTicket || jacStoreTicket === "") && jacStoreRequester) {
          camposActualizar.jacStore = jacStoreRequester;
          camposActualizados.push("JAC Store");
        }
        
        if (Object.keys(camposActualizar).length === 0) {
          detalleTicket.omitido = true;
          detalleTicket.razon_omision = "Requester no tiene valores para completar campos faltantes";
          console.log(`Ticket #${ticket.id}: Omitido - Requester no tiene valores disponibles`);
          resumen.ticketsOmitidos++;
        } else {
          await actualizarTicket(ticket.id, camposActualizar);
          detalleTicket.campos_actualizados = camposActualizados;
          console.log(`Ticket #${ticket.id}: Actualizado - Campos: ${camposActualizados.join(", ")}`);
          resumen.ticketsActualizados++;
        }
        
        resumen.ticketsProcesados++;
        resumen.detalles.push(detalleTicket);
        
      } catch (error) {
        resumen.errores++;
        detalleTicket.error = error.message;
        console.error(`Ticket #${ticket.id}: Error - ${error.message}`);
        resumen.detalles.push(detalleTicket);
      }
    }
    
    console.log(`Batch completado. Procesados: ${resumen.ticketsProcesados}, Actualizados: ${resumen.ticketsActualizados}, Omitidos: ${resumen.ticketsOmitidos}, Errores: ${resumen.errores}`);
    
    const nombreArchivo = `resumen_completar_campos_${new Date().toISOString().split("T")[0]}.json`;
    fs.writeFileSync(nombreArchivo, JSON.stringify(resumen, null, 2));
    console.log(`Resumen guardado en: ${nombreArchivo}`);
    
    return resumen;
  } catch (error) {
    console.error("Error crítico en batch:", error.message);
    throw error;
  }
}

(async () => {
  try {
    await ejecutarBatchCompletarCampos();
  } catch (error) {
    console.error("Error ejecutando el batch:", error.message);
  }
})();
