const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('redis');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const appSecret = process.env.META_APP_SECRET;
const openAiApiKey = process.env.OPENAI_API_KEY;
const openAiModel = process.env.OPENAI_MODEL || 'gpt-4o';
const openAiReasoningEffort = process.env.OPENAI_REASONING_EFFORT || 'medium';
const memoryMaxMessages = Number(process.env.MEMORY_MAX_MESSAGES || 5);
const redisUrl = process.env.REDIS_URL;
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || 'wha:memory:';
const memoryByUser = new Map();
let redisClient = null;

app.use('/webhook', express.json({
  verify: appSecret
    ? (req, res, buf) => {
        req.rawBody = buf;
      }
    : undefined,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/config-status', (_req, res) => {
  res.json({
    env: {
      WHATSAPP_VERIFY_TOKEN: Boolean(verifyToken),
      WHATSAPP_ACCESS_TOKEN: Boolean(accessToken),
      WHATSAPP_PHONE_NUMBER_ID: Boolean(phoneNumberId),
      META_APP_SECRET: Boolean(appSecret),
      OPENAI_API_KEY: Boolean(openAiApiKey),
      OPENAI_MODEL: Boolean(openAiModel),
      OPENAI_REASONING_EFFORT: Boolean(openAiReasoningEffort),
      REDIS_URL: Boolean(redisUrl),
      MEMORY_MAX_MESSAGES: Boolean(memoryMaxMessages),
    },
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && challenge && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

function isValidSignature(req) {
  if (!appSecret) return true;

  const signatureHeader = req.get('x-hub-signature-256');
  if (!signatureHeader || !req.rawBody) return false;

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  const response = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data;
}

function normalizeMemoryLimit() {
  return Number.isFinite(memoryMaxMessages) && memoryMaxMessages > 0
    ? memoryMaxMessages
    : 5;
}

function getUserMemory(userId) {
  if (!memoryByUser.has(userId)) {
    memoryByUser.set(userId, []);
  }
  return memoryByUser.get(userId);
}

function appendUserMemoryLocal(userId, role, content) {
  const history = getUserMemory(userId);
  history.push({ role, content });

  const maxItems = normalizeMemoryLimit();

  while (history.length > maxItems) {
    history.shift();
  }
}

function buildRedisMemoryKey(userId) {
  return `${redisKeyPrefix}${userId}`;
}

async function appendUserMemory(userId, role, content) {
  if (!redisClient?.isOpen) {
    appendUserMemoryLocal(userId, role, content);
    return;
  }

  const maxItems = normalizeMemoryLimit();
  const redisKey = buildRedisMemoryKey(userId);

  await redisClient.rPush(redisKey, JSON.stringify({ role, content }));
  await redisClient.lTrim(redisKey, -maxItems, -1);
}

async function getConversationMemory(userId) {
  if (!redisClient?.isOpen) {
    return getUserMemory(userId);
  }

  const redisKey = buildRedisMemoryKey(userId);
  const items = await redisClient.lRange(redisKey, 0, -1);

  return items
    .map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        return null;
      }
    })
    .filter((item) => item && item.role && item.content);
}

async function connectRedisIfConfigured() {
  if (!redisUrl) {
    console.log('Redis no configurado. Usando memoria en RAM.');
    return;
  }

  try {
    redisClient = createClient({ url: redisUrl });
    redisClient.on('error', (error) => {
      console.error('Error de Redis:', error.message);
    });
    await redisClient.connect();
    console.log('Redis conectado para memoria conversacional.');
  } catch (error) {
    redisClient = null;
    console.error('No se pudo conectar Redis. Se usará memoria en RAM:', error.message);
  }
}

async function generateAiReply(userId) {
  if (!openAiApiKey) {
    throw new Error('Falta OPENAI_API_KEY en .env');
  }

  const history = await getConversationMemory(userId);

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: openAiModel,
      messages: [
        {
          role: 'system',
          content:
            'Eres un asistente útil y breve por WhatsApp. Responde en español con claridad y en pocas líneas.',
        },
        ...history,
      ],
      reasoning_effort: openAiReasoningEffort,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const text = response.data?.choices?.[0]?.message?.content?.trim();
  return text || 'Recibí tu mensaje, pero no pude generar una respuesta en este momento.';
}

async function processIncomingMessages(messages) {
  for (const message of messages) {
    const from = message.from;
    const type = message.type;
    console.log('Mensaje entrante:', { from, type, id: message.id });

    if (type !== 'text') {
      continue;
    }

    const textBody = message.text?.body?.trim();
    if (!textBody) {
      continue;
    }

    if (!accessToken || !phoneNumberId) {
      console.error('No se puede responder: faltan variables de WhatsApp en .env');
      continue;
    }

    try {
      await appendUserMemory(from, 'user', textBody);
      const aiReply = await generateAiReply(from);
      await appendUserMemory(from, 'assistant', aiReply);
      await sendWhatsAppText(from, aiReply);
      console.log('Respuesta enviada a:', from);
    } catch (error) {
      const details = error.response?.data || error.message;
      console.error('Error respondiendo mensaje:', details);
    }
  }
}

app.post('/webhook', (req, res) => {
  if (!isValidSignature(req)) {
    return res.sendStatus(401);
  }

  const changes = req.body?.entry?.[0]?.changes?.[0]?.value;
  const messages = changes?.messages;

  if (Array.isArray(messages) && messages.length > 0) {
    processIncomingMessages(messages).catch((error) => {
      console.error('Error procesando mensajes entrantes:', error.message);
    });
  }

  return res.sendStatus(200);
});

app.post('/send-text', async (req, res) => {
  const { to, text } = req.body || {};

  if (!to || !text) {
    return res.status(400).json({
      ok: false,
      error: 'Campos requeridos: to, text',
    });
  }

  if (!accessToken || !phoneNumberId) {
    return res.status(500).json({
      ok: false,
      error: 'Faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID en .env',
    });
  }

  try {
    const data = await sendWhatsAppText(to, text);
    return res.json({ ok: true, data });
  } catch (error) {
    const status = error.response?.status || 500;
    const data = error.response?.data || { message: error.message };
    return res.status(status).json({ ok: false, error: data });
  }
});

async function startServer() {
  await connectRedisIfConfigured();

  app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('No se pudo iniciar el servidor:', error.message);
  process.exit(1);
});
