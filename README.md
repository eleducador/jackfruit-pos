# 🌴 Jackfruit Río Negro — POS, Comandas KDS en Vivo, Pedidos QR y Facturación Electrónica SUNAT

Aplicación web completa para **JACKFRUIT RIO NEGRO E.I.R.L. (RUC 20604377405)** diseñada para operar tanto en servidor local como en **Vercel + GitHub** con soporte de alta concurrencia (**+1,000 clientes por fin de semana**).

## ✨ Características Principales
- **📱 Carta Interactiva QR estilo Windows Mobile (`public/qr.html`):** Cuadros grandes (Live Tiles), PIN de seguridad de 2 dígitos por mesa, seguimiento del pedido en vivo, alertas emergentes con sonido/vibración cuando cocina prepara o despacha el pedido, llamado al mozo en pantalla y solicitud de cuenta con autocompletado de DNI/RUC en vivo.
- **🍳 Pantalla Inteligente de Comandas KDS (`public/index.html`):** Estaciones separadas (Heladería, Cocina Principal, Barra & Tienda), cronómetro semáforo y despacho en 1 clic hacia el celular del cliente y el salón.
- **🧾 Facturación Electrónica (`facturaloconlwp.com`):** Emisión de Boleta (`BA01`), Factura (`FA01`) y Nota de Venta (`NV01`) con exoneración de IGV por Ley de la Amazonía (`codAfectacionIgv = 20`) y consulta en vivo RENIEC/SUNAT.

## 🚀 Despliegue en Vercel + GitHub (Soporte +1,000 clientes/fin de semana)
1. Sube esta carpeta a un repositorio en **GitHub** (`public/`, `api/`, `data/seed.json`, `vercel.json`, `package.json`).
2. Entra a **[vercel.com](https://vercel.com)** ➔ **Add New Project** ➔ Importa tu repositorio de GitHub y pulsa **Deploy**.
3. Para persistencia compartida de alta concurrencia (+1,000 clientes), ve a la pestaña **Storage** de tu proyecto en Vercel ➔ **Create Database** ➔ selecciona **Upstash Redis (Vercel KV)** (Plan gratuito) y conéctalo al proyecto. ¡Listo! [`api/index.js`](./api/index.js) detectará automáticamente `KV_REST_API_URL` y `KV_REST_API_TOKEN`.
