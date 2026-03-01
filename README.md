# API de prueba para WhatsApp Cloud

Esta app te permite:
- Verificar y recibir eventos en `GET/POST /webhook`
- Enviar mensaje de texto con `POST /send-text`
- Responder automáticamente mensajes entrantes con OpenAI
- Usar una pantalla web para guiar la configuración

## 1) Requisitos
- Node.js 18+
- Una app en Meta for Developers con producto WhatsApp
- Un número de prueba y token de acceso de WhatsApp Cloud API

## 2) Instalación
```bash
npm install
cp .env.example .env
```

Completa `.env` con:
- `WHATSAPP_VERIFY_TOKEN`: cualquier token secreto que tú definas
- `WHATSAPP_ACCESS_TOKEN`: token temporal/permanente de Meta
- `WHATSAPP_PHONE_NUMBER_ID`: id del número de WhatsApp
- `META_APP_SECRET`: opcional, recomendado para validar firma de webhook
- `OPENAI_API_KEY`: API key de OpenAI
- `OPENAI_MODEL`: por defecto `gpt-4o`
- `OPENAI_REASONING_EFFORT`: `none`, `low`, `medium`, `high`
- `MEMORY_MAX_MESSAGES`: cantidad máxima de mensajes recientes por usuario (default `5`)
- `REDIS_URL`: URL de Redis para persistir memoria entre reinicios (opcional)
- `REDIS_KEY_PREFIX`: prefijo de claves en Redis (default `wha:memory:`)

> Seguridad: nunca subas tu `.env` a Git. Si compartiste tu API key públicamente, rótala de inmediato.

## 3) Ejecutar
```bash
npm run dev
```

Al iniciar, abre:
- `http://localhost:3000` (frontend de guía y estado)

## 4) Exponer localmente para webhook
Meta necesita URL pública HTTPS para llamar tu webhook. Ejemplo con ngrok:
```bash
ngrok http 3000
```

Usa la URL pública + `/webhook`, por ejemplo:
`https://abc123.ngrok-free.app/webhook`

## 5) Configurar en Meta (pantalla que compartiste)
1. En tu app de Meta, entra a **WhatsApp > Configuración de la API**.
2. En **Webhooks**, agrega:
   - **Callback URL**: tu URL pública `/webhook`
   - **Verify token**: el mismo de `WHATSAPP_VERIFY_TOKEN`
3. Suscribe al menos el campo `messages`.
4. Agrega números de prueba permitidos (recipient/test numbers).

## 6) Probar envío de mensaje
```bash
curl -X POST http://localhost:3000/send-text \
  -H "Content-Type: application/json" \
  -d '{"to":"521XXXXXXXXXX","text":"Hola desde mi app de prueba"}'
```

> Usa formato internacional sin `+` ni espacios.

## 7) Ver logs de mensajes entrantes
Cuando llegue un mensaje al número de prueba, verás en consola:
- `from`
- `type`
- `id`

## 8) Bot automático con OpenAI
Con el servidor corriendo y `OPENAI_API_KEY` configurada, cualquier mensaje de texto entrante se responde automáticamente.

Notas:
- Responde solo mensajes de tipo `text`.
- Si OpenAI falla, el webhook sigue respondiendo `200` a Meta para evitar reintentos.
- Mantiene memoria corta por número de teléfono (últimos `MEMORY_MAX_MESSAGES` mensajes).
- Si `REDIS_URL` está configurado, la memoria se persiste en Redis.
- Si Redis no está disponible, hace fallback automático a memoria en RAM.

## 10) Frontend de conexión
La app incluye una interfaz para revisar estado de variables sin mostrar secretos:

- `GET /` muestra el frontend de setup.
- `GET /config-status` devuelve solo `true/false` por variable de entorno.

## 9) Redis local (opcional)
Si tienes Docker, puedes levantar Redis así:

```bash
docker run -d --name wha-redis -p 6379:6379 redis:7-alpine
```

Y en `.env`:

```env
REDIS_URL=redis://localhost:6379
```

---
Si quieres, te puedo agregar respuesta automática (bot eco) para contestar cada mensaje recibido.
