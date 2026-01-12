# Trigger Zendesk: Copiar campos desde Requester al Ticket

## Explicación funcional

El trigger se ejecuta al crear un ticket nuevo. Verifica que los campos `vin` y `jac_store` del ticket estén vacíos y que exista un requester. Si se cumplen las condiciones, copia automáticamente los valores de `vin` y `jac_store` desde el registro People del requester hacia los campos correspondientes del ticket.

## Configuración del Trigger

### Condiciones (ALL - todas deben cumplirse)

1. **Ticket status is new** - Detecta creación de ticket
   - Field: `status`
   - Operator: `is`
   - Value: `new`

2. **Ticket.vin is empty** - Campo VIN del ticket vacío
   - Field: `custom_field_41998965643412`
   - Operator: `is`
   - Value: `` (vacío)

3. **Ticket.jac_store is empty** - Campo JAC Store del ticket vacío
   - Field: `custom_field_41998797757844`
   - Operator: `is`
   - Value: `` (vacío)

4. **Requester exists** - Requester presente
   - Field: `requester_id`
   - Operator: `present`

### Acciones

1. **Set Ticket.vin = Requester.vin**
   - Field: `custom_field_41998965643412`
   - Value: `{{ticket.requester.custom_fields.vin}}`

2. **Set Ticket.jac_store = Requester.jac_store**
   - Field: `custom_field_41998797757844`
   - Value: `{{ticket.requester.custom_fields.jac_store}}`

## Payload para Zendesk REST API

### Endpoint
```
POST https://{subdomain}.zendesk.com/api/v2/triggers.json
```

### Headers
```
Content-Type: application/json
Authorization: Basic {base64(email/token:api_token)}
```

### Payload JSON
```json
{
  "trigger": {
    "title": "Copiar VIN y JAC Store desde Requester al crear ticket",
    "active": true,
    "position": 1,
    "conditions": {
      "all": [
        {
          "field": "status",
          "operator": "is",
          "value": "new"
        },
        {
          "field": "custom_field_41998965643412",
          "operator": "is",
          "value": ""
        },
        {
          "field": "custom_field_41998797757844",
          "operator": "is",
          "value": ""
        },
        {
          "field": "requester_id",
          "operator": "present"
        }
      ]
    },
    "actions": [
      {
        "field": "custom_field_41998965643412",
        "value": "{{ticket.requester.custom_fields.vin}}"
      },
      {
        "field": "custom_field_41998797757844",
        "value": "{{ticket.requester.custom_fields.jac_store}}"
      }
    ]
  }
}
```

### Ejemplo con cURL
```bash
curl https://{subdomain}.zendesk.com/api/v2/triggers.json \
  -X POST \
  -H "Content-Type: application/json" \
  -u {email}/token:{api_token} \
  -d @trigger_copiar_requester_fields.json
```

## Notas técnicas

- Los campos personalizados se referencian con el prefijo `custom_field_` seguido del Field ID.
- La sintaxis Liquid `{{ticket.requester.custom_fields.vin}}` accede al campo `vin` del objeto People del requester.
- El operador `present` verifica que el campo `requester_id` tenga un valor asignado.
- Para el campo picklist `jac_store`, el valor debe coincidir exactamente con uno de los values del picklist, no con el label.

