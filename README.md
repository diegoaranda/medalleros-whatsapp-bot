# Medalleros WhatsApp Bot

Webhook mínimo y seguro para recibir eventos de WhatsApp Cloud API en Vercel. Esta fase no responde mensajes ni almacena datos.

## Instalación y desarrollo

```bash
npm install
npm run dev
```

Copia `.env.example` a `.env.local` y completa las variables necesarias, sin subirlas al repositorio.

## Variables

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_WABA_ID`
- `META_APP_SECRET`

## Deploy

Despliega el repositorio en Vercel y configura las cinco variables en **Project Settings → Environment Variables**. No se requiere dominio personalizado.

- Health: `GET /api/health` → `{ "ok": true }`
- Webhook: `GET /api/webhook` verifica la suscripción; `POST /api/webhook` valida la firma de Meta y recibe mensajes.

Después del deploy, en la configuración de Webhooks de la app de Meta registra `https://<dominio>/api/webhook` como **Callback URL**, usa el valor de `WHATSAPP_VERIFY_TOKEN` como **Verify Token**, y suscribe el campo `messages`.
