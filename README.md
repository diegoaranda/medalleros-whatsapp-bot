# Medalleros WhatsApp Bot

Núcleo serverless multiempresa para recibir eventos de WhatsApp Cloud API, persistir conversaciones en Supabase y reanudar ejecuciones de flujos durables. No incluye dashboard, IA ni flujos comerciales de Medalleros.

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
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (sólo servidor)
- `WHATSAPP_GRAPH_API_VERSION` (opcional)

## Base de datos

Aplica las migraciones de `supabase/migrations` al proyecto de Supabase. Antes de recibir mensajes, crea una empresa y un canal `whatsapp` cuyo `external_id` sea el Phone Number ID de Meta. `credential_env_key` debe apuntar al nombre de una variable de servidor que contenga el token; por defecto usa `WHATSAPP_ACCESS_TOKEN`.

Las tablas públicas tienen RLS por membresía de empresa. El webhook usa exclusivamente la clave `service_role` en el servidor y nunca debe exponerse a clientes.

## Deploy

Despliega el repositorio en Vercel y configura las variables listadas arriba en **Project Settings → Environment Variables**. No se requiere dominio personalizado.

- Health: `GET /api/health` → `{ "ok": true }`
- Webhook: `GET /api/webhook` verifica la suscripción; `POST /api/webhook` valida la firma de Meta y recibe mensajes.

Después del deploy, en la configuración de Webhooks de la app de Meta registra `https://<dominio>/api/webhook` como **Callback URL**, usa el valor de `WHATSAPP_VERIFY_TOKEN` como **Verify Token**, y suscribe el campo `messages`.
