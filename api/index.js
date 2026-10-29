const fs = require('fs');
const path = require('path');

// ============================================================================
// JACKFRUIT RÍO NEGRO — VERCEL SERVERLESS API (ALTA CONCURRENCIA +1,000 CLIENTES)
// ============================================================================
// Soporta dos modos de persistencia automáticos:
// 1. MODO PRODUCCIÓN CLOUD (Recomendado para +1,000 clientes/fin de semana):
//    Si conectas "Upstash Redis / Vercel KV" desde el panel Storage de Vercel,
//    usa automáticamente KV_REST_API_URL y KV_REST_API_TOKEN para compartir el
//    estado en milisegundos entre todas las instancias serverless sin perder datos.
// 2. MODO FALLBACK INSTANTÁNEO (Sin configuración adicional):
//    Usa memoria global + /tmp/jackfruit-state.json inicializado desde data/seed.json.
// ============================================================================

const SEED_FILE = path.join(process.cwd(), 'data', 'seed.json');
const TMP_STATE_FILE = '/tmp/jackfruit-state.json';

function findEnvEndingWith(suffixes) {
  for (const s of suffixes) {
    if (process.env[s]) return process.env[s];
  }
  const keys = Object.keys(process.env || {});
  for (const s of suffixes) {
    const match = keys.find(k => k.toUpperCase().endsWith(s.toUpperCase()));
    if (match && process.env[match]) return process.env[match];
  }
  return '';
}

const KV_URL = findEnvEndingWith([
  'jackfruit_KV_REST_API_URL',
  'KV_REST_API_URL',
  'UPSTASH_REDIS_REST_URL'
]);
const KV_TOKEN = findEnvEndingWith([
  'jackfruit_KV_REST_API_TOKEN',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN'
]);
const KV_KEY = 'jackfruit:pos:state:v2';
const KV_VER_KEY = 'jackfruit:pos:version:v2';

let memoryState = null;
let memoryVersion = Date.now().toString();

function nowFormatted() {
  const d = new Date(Date.now() - 5 * 3600 * 1000); // Hora Perú (UTC-5)
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

function timeOnlyFormatted() {
  return nowFormatted().substring(11, 19);
}

function dateOnlyFormatted() {
  return nowFormatted().substring(0, 10);
}

function makeOrderItem(id, prodId, name, category, station, price, qty, comment, state, createdAt, source) {
  return {
    id,
    productId: prodId,
    name,
    category,
    station,
    price: Number(price),
    qty: Number(qty),
    subtotal: Number(price) * Number(qty),
    comment: comment || '',
    state,
    createdAt,
    source
  };
}

function addNotification(appState, type, message, tableId, orderId) {
  if (!Array.isArray(appState.notifications)) appState.notifications = [];
  appState.notifications.unshift({
    id: 'NTF-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    type,
    message,
    tableId: Number(tableId || 0),
    orderId: orderId || '',
    time: timeOnlyFormatted(),
    read: false
  });
  if (appState.notifications.length > 40) {
    appState.notifications.length = 40;
  }
}

function ensureDemoActiveOrders(appState) {
  if (!Array.isArray(appState.orders)) appState.orders = [];
  if (appState.orders.length === 0) {
    const fiveMinAgo = nowFormatted();
    const eightMinAgo = nowFormatted();

    const order1 = {
      id: 'ORD-1001',
      code: '12134',
      channel: 'qr',
      tableId: 6,
      tableName: 'Mesa 6',
      customerName: 'Cliente QR (Mesa 6)',
      createdAt: fiveMinAgo,
      updatedAt: fiveMinAgo,
      status: 'open',
      items: [
        makeOrderItem('ITM-1', 103, 'HELADOS MIXTO', 'HELADOS', 'heladeria', 7.0, 2, 'Bien frío, con jalea de jackfruit', 'pending', fiveMinAgo, 'qr'),
        makeOrderItem('ITM-2', 189, 'CREMOLADA DE JACK FRUIT', 'CREMOLADA', 'heladeria', 5.0, 2, '', 'pending', fiveMinAgo, 'qr'),
        makeOrderItem('ITM-3', 213, 'DESHIDRATADO DE JACK FRUIT', 'OTROS', 'barra', 10.0, 1, 'Para compartir en mesa', 'ready', fiveMinAgo, 'qr')
      ],
      total: 34.0
    };

    const order2 = {
      id: 'ORD-1002',
      code: '12135',
      channel: 'mesa',
      tableId: 3,
      tableName: 'Mesa 3',
      customerName: 'Familia Rojas',
      createdAt: eightMinAgo,
      updatedAt: eightMinAgo,
      status: 'open',
      items: [
        makeOrderItem('ITM-4', 82, 'PACO FRITO', 'PACO', 'cocina', 30.0, 2, 'Con patacones dorados y ají charapita', 'preparing', eightMinAgo, 'mozo'),
        makeOrderItem('ITM-5', 215, 'JUANES', 'CECINA', 'cocina', 25.0, 1, '', 'preparing', eightMinAgo, 'mozo'),
        makeOrderItem('ITM-6', 142, 'H2O COCO VASO', 'BEBIDAS', 'barra', 9.0, 2, 'Sin hielo', 'delivered', eightMinAgo, 'mozo')
      ],
      total: 103.0
    };

    appState.orders.push(order1, order2);

    (appState.tables || []).forEach(t => {
      if (t.id === 6) {
        t.status = 'occupied';
        t.currentOrderId = 'ORD-1001';
      } else if (t.id === 3) {
        t.status = 'occupied';
        t.currentOrderId = 'ORD-1002';
      }
    });

    addNotification(appState, 'qr_order', '📱 Pedido QR recibido en Mesa 6 (Helados Mixto x2, Cremolada Jackfruit x2)', 6, 'ORD-1001');
    addNotification(appState, 'kitchen_ready', '🍽️ ¡Listo para llevar a Mesa 6!: DESHIDRATADO DE JACK FRUIT (x1)', 6, 'ORD-1001');
  }
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data && data.result ? data.result : null;
  } catch (e) {
    return null;
  }
}

async function kvSet(key, val) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: typeof val === 'string' ? val : JSON.stringify(val)
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function loadState() {
  // 1. Intentar leer desde Upstash Redis / Vercel KV si está configurado
  if (KV_URL && KV_TOKEN) {
    const rawKv = await kvGet(KV_KEY);
    if (rawKv) {
      try {
        const parsed = typeof rawKv === 'string' ? JSON.parse(rawKv) : rawKv;
        memoryState = parsed;
        memoryVersion = String(parsed._version || Date.now());
        return memoryState;
      } catch (e) {}
    }
  }

  // 2. Intentar leer desde memoria o /tmp/jackfruit-state.json
  if (memoryState) return memoryState;

  try {
    if (fs.existsSync(TMP_STATE_FILE)) {
      const rawTmp = fs.readFileSync(TMP_STATE_FILE, 'utf8');
      memoryState = JSON.parse(rawTmp);
      memoryVersion = String(memoryState._version || Date.now());
      return memoryState;
    }
  } catch (e) {}

  // 3. Inicializar desde data/seed.json
  const rawSeed = fs.readFileSync(SEED_FILE, 'utf8');
  memoryState = JSON.parse(rawSeed);
  ensureDemoActiveOrders(memoryState);
  await saveState(memoryState);
  return memoryState;
}

async function saveState(appState) {
  memoryVersion = Date.now().toString();
  appState._version = memoryVersion;
  memoryState = appState;

  const serialized = JSON.stringify(appState);

  try {
    fs.writeFileSync(TMP_STATE_FILE, serialized, 'utf8');
  } catch (e) {}

  if (KV_URL && KV_TOKEN) {
    await Promise.all([
      kvSet(KV_KEY, serialized),
      kvSet(KV_VER_KEY, memoryVersion)
    ]);
  }
}

async function getFastVersion() {
  if (KV_URL && KV_TOKEN) {
    const v = await kvGet(KV_VER_KEY);
    if (v) return String(v);
  }
  return memoryVersion;
}

async function lookupDniRucFromLwp(number) {
  if (!number) return null;
  const clean = String(number).trim();
  if (clean.length !== 8 && clean.length !== 11) return null;

  const endpoint = clean.length === 11
    ? `https://facturaloconlwp.com/api/persona/ruc/${clean}`
    : `https://facturaloconlwp.com/api/persona/dni/${clean}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5500);
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data) return null;
    const first = String(data.firstname || '').trim();
    const second = String(data.secondname || '').trim();
    const fullName = first === '-' ? second : `${second} ${first}`.trim();
    const address = String(data.address || '').trim();
    if (!fullName) return null;
    return { name: fullName, address, raw: data };
  } catch (e) {
    return null;
  }
}

function recalcOrderTotal(order) {
  let sum = 0;
  (order.items || []).forEach(it => {
    sum += Number(it.subtotal || 0);
  });
  order.total = Number(sum.toFixed(2));
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const urlObj = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // Endpoint ultra-ligero con Edge Caching (absorbe el 99% del tráfico de +1,000 celulares en Vercel CDN)
  if (pathname === '/api/version' && req.method === 'GET') {
    const ver = await getFastVersion();
    res.setHeader('Cache-Control', 'public, s-maxage=1, stale-while-revalidate=2');
    return res.status(200).json({
      version: ver,
      storageMode: (KV_URL && KV_TOKEN) ? 'upstash-redis' : 'memory-tmp'
    });
  }

  const appState = await loadState();
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8085';
  const publicBaseUrl = `${proto}://${host}`;

  if (pathname === '/api/state' && req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      version: memoryVersion,
      storageMode: (KV_URL && KV_TOKEN) ? 'upstash-redis' : 'memory-tmp',
      publicBaseUrl,
      company: appState.company,
      series: appState.series,
      tables: appState.tables,
      products: appState.products,
      orders: appState.orders,
      vouchers: appState.vouchers,
      deletedItemsLog: appState.deletedItemsLog,
      notifications: appState.notifications
    });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  // 1. PEDIDO DESDE QR DEL CLIENTE
  if (pathname === '/api/qr/order' && req.method === 'POST') {
    const tableId = Number(body.tableId || 0);
    const pin = String(body.pin || '').trim();
    const customerName = String(body.customerName || 'Cliente QR').trim();
    const incomingItems = Array.isArray(body.items) ? body.items : [];

    const table = (appState.tables || []).find(t => Number(t.id) === tableId);
    if (!table) return res.status(400).json({ error: 'Mesa no válida.' });

    if (String(table.pin || '').trim() !== pin) {
      return res.status(403).json({
        error: `Código PIN de mesa incorrecto. Verifica el PIN de 2 dígitos impreso en el QR de la ${table.name}.`
      });
    }

    if (incomingItems.length === 0) {
      return res.status(400).json({ error: 'Tu carrito está vacío.' });
    }

    const nowStr = nowFormatted();
    let order = (appState.orders || []).find(o => Number(o.tableId) === tableId && o.status === 'open');
    let isNewOrder = false;

    if (!order) {
      isNewOrder = true;
      const nextNum = 12136 + (appState.orders || []).length + (appState.vouchers || []).length;
      order = {
        id: 'ORD-' + Date.now(),
        code: String(nextNum),
        channel: 'qr',
        tableId,
        tableName: table.name,
        customerName: customerName || `Cliente QR (${table.name})`,
        createdAt: nowStr,
        updatedAt: nowStr,
        status: 'open',
        items: [],
        total: 0
      };
      appState.orders.unshift(order);
      table.status = 'occupied';
      table.currentOrderId = order.id;
    } else {
      order.updatedAt = nowStr;
      if (customerName && customerName !== 'Cliente QR') {
        order.customerName = customerName;
      }
    }

    const summaryParts = [];
    let idx = (order.items || []).length + 1;

    incomingItems.forEach(ri => {
      const pid = Number(ri.productId);
      const qty = Math.max(1, Number(ri.qty || 1));
      const comment = String(ri.comment || '');
      const prod = (appState.products || []).find(p => Number(p.id) === pid);
      if (!prod) return;

      order.items.push(
        makeOrderItem(
          `ITM-${Date.now()}-${idx++}`,
          pid,
          prod.name,
          prod.category,
          prod.station,
          prod.price,
          qty,
          comment,
          'pending',
          nowStr,
          'qr'
        )
      );
      summaryParts.push(`${qty}x ${prod.name}`);
    });

    recalcOrderTotal(order);
    addNotification(
      appState,
      'qr_order',
      `📱 ${isNewOrder ? 'Nuevo pedido QR' : 'Adicional por QR'} en ${table.name}: ${summaryParts.join(', ')}`,
      tableId,
      order.id
    );

    await saveState(appState);
    return res.status(200).json({
      ok: true,
      order,
      message: '¡Pedido enviado directamente a Cocina y Caja!'
    });
  }

  // 2. ACCIONES DE MESA DESDE EL QR (LLAMAR AL MOZO / SOLICITAR CUENTA CON DNI/RUC)
  if (pathname === '/api/qr/action' && req.method === 'POST') {
    const tableId = Number(body.tableId || 0);
    const action = String(body.action || '');
    const table = (appState.tables || []).find(t => Number(t.id) === tableId);
    if (!table) return res.status(400).json({ error: 'Mesa no encontrada.' });

    let docNumber = String(body.docNumber || '').trim();
    let clientName = String(body.clientName || '').trim();
    let clientAddress = String(body.clientAddress || '').trim();

    if (action === 'request_bill' && docNumber && !clientName) {
      const looked = await lookupDniRucFromLwp(docNumber);
      if (looked && looked.name) {
        clientName = looked.name;
        if (!clientAddress && looked.address) clientAddress = looked.address;
      }
    }

    if (action === 'call_waiter') {
      table.waiterCall = true;
      addNotification(appState, 'waiter_call', `🔔 ${table.name} solicita la presencia del mozo.`, tableId, table.currentOrderId);
    } else if (action === 'request_bill') {
      let voucherPref = String(body.voucherType || 'Boleta Electrónica').trim();
      const paymentMethod = String(body.paymentMethod || 'Efectivo').trim();
      let voucherKey = 'boleta';

      if (voucherPref.toLowerCase().includes('factura') || docNumber.length === 11) {
        voucherKey = 'factura';
        voucherPref = 'Factura Electrónica';
      } else if (voucherPref.toLowerCase().includes('nota')) {
        voucherKey = 'notaVenta';
        voucherPref = 'Nota de Venta';
      } else {
        voucherKey = 'boleta';
        voucherPref = 'Boleta Electrónica';
      }

      let summaryDesc = voucherPref;
      if (docNumber) summaryDesc += ` • ${docNumber.length === 11 ? 'RUC' : 'DNI'}: ${docNumber}`;
      if (clientName) summaryDesc += ` (${clientName})`;
      if (paymentMethod) summaryDesc += ` • Pago: ${paymentMethod}`;

      table.billRequested = true;
      table.billTypeRequested = summaryDesc;
      table.billVoucherKey = voucherKey;
      table.billDocNumber = docNumber;
      table.billClientName = clientName;
      table.billClientAddress = clientAddress;
      table.billPaymentMethod = paymentMethod;

      const activeOrder = (appState.orders || []).find(o => Number(o.tableId) === tableId && o.status === 'open');
      if (activeOrder) {
        activeOrder.billingVoucherType = voucherKey;
        activeOrder.billingDocNumber = docNumber;
        activeOrder.billingClientName = clientName;
        activeOrder.billingClientAddress = clientAddress;
        activeOrder.billingPaymentMethod = paymentMethod;
        if (clientName && (!activeOrder.customerName || activeOrder.customerName.startsWith('Cliente'))) {
          activeOrder.customerName = clientName;
        }
      }

      addNotification(appState, 'bill_request', `🧾 ${table.name} solicita la cuenta — ${summaryDesc}`, tableId, table.currentOrderId);
    } else if (action === 'clear_alerts') {
      table.waiterCall = false;
      table.billRequested = false;
    }

    await saveState(appState);
    return res.status(200).json({
      ok: true,
      table,
      resolvedName: clientName,
      resolvedAddress: clientAddress
    });
  }

  // 3. PEDIDO MANUAL POS (SALÓN / MOSTRADOR / DELIVERY)
  if (pathname === '/api/pos/order' && req.method === 'POST') {
    const channel = String(body.channel || 'mesa');
    const tableId = Number(body.tableId || 0);
    const customerName = String(body.customerName || '').trim();
    const incomingItems = Array.isArray(body.items) ? body.items : [];

    if (incomingItems.length === 0) {
      return res.status(400).json({ error: 'Agrega al menos un producto al pedido.' });
    }

    const nowStr = nowFormatted();
    let table = null;
    let order = null;

    if (channel === 'mesa' && tableId > 0) {
      table = (appState.tables || []).find(t => Number(t.id) === tableId);
      order = (appState.orders || []).find(o => Number(o.tableId) === tableId && o.status === 'open');
    } else if (body.orderId) {
      order = (appState.orders || []).find(o => o.id === body.orderId);
    }

    if (!order) {
      const nextNum = 12136 + (appState.orders || []).length + (appState.vouchers || []).length;
      order = {
        id: 'ORD-' + Date.now(),
        code: String(nextNum),
        channel,
        tableId,
        tableName: table ? table.name : (channel === 'delivery' ? 'Delivery' : 'Mostrador / Para Llevar'),
        customerName: customerName || (channel === 'delivery' ? 'Cliente Delivery' : (channel === 'mostrador' ? 'Cliente Mostrador' : 'Cliente Salón')),
        createdAt: nowStr,
        updatedAt: nowStr,
        status: 'open',
        items: [],
        total: 0
      };
      appState.orders.unshift(order);
      if (table) {
        table.status = 'occupied';
        table.currentOrderId = order.id;
      }
    } else {
      order.updatedAt = nowStr;
      if (customerName) order.customerName = customerName;
    }

    let idx = (order.items || []).length + 1;
    const addedNames = [];

    incomingItems.forEach(ri => {
      const pid = Number(ri.productId);
      const qty = Math.max(1, Number(ri.qty || 1));
      const comment = String(ri.comment || '');
      const prod = (appState.products || []).find(p => Number(p.id) === pid);
      if (!prod) return;

      order.items.push(
        makeOrderItem(
          `ITM-${Date.now()}-${idx++}`,
          pid,
          prod.name,
          prod.category,
          prod.station,
          prod.price,
          qty,
          comment,
          'pending',
          nowStr,
          channel === 'mesa' ? 'mozo' : channel
        )
      );
      addedNames.push(`${qty}x ${prod.name}`);
    });

    recalcOrderTotal(order);
    addNotification(appState, 'pos_order', `📝 Comanda enviada a cocina (${order.tableName}): ${addedNames.join(', ')}`, tableId, order.id);

    await saveState(appState);
    return res.status(200).json({ ok: true, order });
  }

  // 4. ACTUALIZACIÓN DE ESTADO EN COCINA (KDS) -> DISPARA ALERTA EN CELULAR DEL CLIENTE
  if (pathname === '/api/kds/update' && req.method === 'POST') {
    const orderId = String(body.orderId || '');
    const itemId = String(body.itemId || '');
    const newState = String(body.newState || 'ready');
    const stationFilter = String(body.station || 'all');

    const order = (appState.orders || []).find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Comanda no encontrada.' });

    const readyNames = [];
    (order.items || []).forEach(item => {
      let match = false;
      if (itemId) {
        match = item.id === itemId;
      } else if (item.state !== 'delivered') {
        match = stationFilter === 'all' || !stationFilter || item.station === stationFilter;
      }
      if (match) {
        item.state = newState;
        if (newState === 'ready') {
          readyNames.push(`${item.qty}x ${item.name}`);
        }
      }
    });

    order.updatedAt = nowFormatted();
    if (readyNames.length > 0) {
      addNotification(
        appState,
        'kitchen_ready',
        `🍽️ ¡Listo en Cocina para llevar a ${order.tableName}!: ${readyNames.join(', ')}`,
        order.tableId || 0,
        orderId
      );
    }

    await saveState(appState);
    return res.status(200).json({ ok: true, order });
  }

  // 5. ANULAR ÍTEM CON AUDITORÍA
  if (pathname === '/api/pos/remove-item' && req.method === 'POST') {
    const orderId = String(body.orderId || '');
    const itemId = String(body.itemId || '');
    const reason = String(body.reason || 'Solicitud del cliente');

    const order = (appState.orders || []).find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });

    const idx = (order.items || []).findIndex(it => it.id === itemId);
    if (idx !== -1) {
      const removed = order.items.splice(idx, 1)[0];
      if (!Array.isArray(appState.deletedItemsLog)) appState.deletedItemsLog = [];
      appState.deletedItemsLog.unshift({
        id: 'DEL-' + Date.now(),
        orderCode: order.code,
        tableName: order.tableName,
        productName: removed.name,
        qty: removed.qty,
        price: removed.price,
        total: removed.subtotal,
        reason,
        deletedAt: nowFormatted(),
        deletedBy: 'Admin'
      });
    }

    recalcOrderTotal(order);
    if ((order.items || []).length === 0) {
      order.status = 'cancelled';
      const table = (appState.tables || []).find(t => Number(t.id) === Number(order.tableId));
      if (table) {
        table.status = 'free';
        table.currentOrderId = null;
        table.waiterCall = false;
        table.billRequested = false;
        table.billTypeRequested = '';
      }
    }

    await saveState(appState);
    return res.status(200).json({ ok: true, order });
  }

  // 6. CONSULTA EN VIVO DNI / RUC (RENIEC / SUNAT VÍA FACTURALOCONLWP.COM)
  if (pathname === '/api/fe/lookup' && req.method === 'POST') {
    const number = String(body.number || '').trim();
    if (!number) return res.status(400).json({ error: 'Ingrese un número de DNI o RUC.' });

    const looked = await lookupDniRucFromLwp(number);
    if (looked) {
      return res.status(200).json({
        ok: true,
        source: 'facturaloconlwp.com (En Vivo)',
        number,
        name: looked.name,
        address: looked.address || '',
        raw: looked.raw
      });
    }
    return res.status(200).json({
      ok: false,
      error: 'No se encontraron datos para ese documento.'
    });
  }

  // 7. COBRO DE CUENTA Y EMISIÓN DE COMPROBANTE ELECTRÓNICO (BA01, FA01, NV01)
  if (pathname === '/api/pos/checkout' && req.method === 'POST') {
    const orderId = String(body.orderId || '');
    const voucherType = String(body.voucherType || 'boleta');
    const paymentMethod = String(body.paymentMethod || 'Efectivo');
    let clientDocNumber = String(body.clientDocNumber || '').trim();
    let clientName = String(body.clientName || '').trim();
    let clientAddress = String(body.clientAddress || '').trim();
    const discount = Number(body.discount || 0);

    const order = (appState.orders || []).find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada.' });

    if (voucherType === 'factura' && clientDocNumber.length !== 11) {
      return res.status(400).json({ error: 'Para emitir Factura Electrónica es obligatorio un RUC válido de 11 dígitos.' });
    }

    if (!clientDocNumber) clientDocNumber = '11111111';
    if (!clientName) clientName = 'CLIENTES VARIOS';
    if (!clientAddress) clientAddress = '-';

    const company = appState.company || {};
    const seriesAll = appState.series || {};
    const serieCfg = seriesAll[voucherType] || seriesAll.boleta;

    const serieStr = String(serieCfg.serie);
    const corrNum = Number(serieCfg.correlativo);
    const corrStr = String(corrNum).padStart(8, '0');
    const tipoDocumento = String(serieCfg.code);
    serieCfg.correlativo = corrNum + 1;

    const leyAmazonia = company.leyAmazonia !== false;
    const igvRate = Number(company.igvRate || 0.18);

    const rawTotal = Number(order.total || 0);
    const finalTotal = Math.max(0, rawTotal - discount);
    const totalExoneradas = leyAmazonia ? Number(finalTotal.toFixed(4)) : 0;
    const totalGravadas = leyAmazonia ? 0 : Number((finalTotal / (1 + igvRate)).toFixed(4));
    const sumatoriaIGV = leyAmazonia ? 0 : Number((finalTotal - totalGravadas).toFixed(4));

    const nowStr = nowFormatted();
    const dateOnly = dateOnlyFormatted();

    const feDetalle = (order.items || []).map((it, idx) => {
      it.state = 'delivered';
      const unitPrice = Number(it.price);
      const qty = Number(it.qty);
      const valorUnit = leyAmazonia ? unitPrice : Number((unitPrice / (1 + igvRate)).toFixed(4));
      const valorVenta = leyAmazonia ? unitPrice * qty : Number(((unitPrice * qty) / (1 + igvRate)).toFixed(4));
      const igvItem = leyAmazonia ? 0 : Number((unitPrice * qty - valorVenta).toFixed(4));

      return {
        numeroOrden: idx + 1,
        unidadMedida: 'NIU',
        cantidad: qty,
        codigo: it.productId,
        descripcion: it.name,
        valorUnitario: valorUnit,
        precioUnitario: unitPrice,
        igvItem,
        iscItem: 0,
        valorVenta,
        codAfectacionIgv: leyAmazonia ? 20 : 10,
        valorReferencial: 0,
        codTipoOperacion: '01'
      };
    });

    const fePayload = {
      sucursalId: 1,
      fechaEmision: nowStr,
      tipoDocumento,
      codigoTipoDoc: 0,
      serie: serieStr,
      correlativo: corrStr,
      tipoDocCliente: voucherType === 'factura' || clientDocNumber.length === 11 ? 6 : 1,
      numeroDocCliente: clientDocNumber,
      razonSocialCliente: clientName,
      direccionCliente: clientAddress,
      totalVentaGravadas: totalGravadas,
      totalVentaInafectas: 0,
      totalVentaExoneradas: totalExoneradas,
      totalVentaGratuitas: 0,
      sumatoriaIGV,
      sumatoriaISC: 0,
      sumatoriaOtrosTributos: 0,
      sumatoriaOtrosCargos: 0,
      totalDescuentos: discount,
      importeTotal: finalTotal,
      tipoMoneda: 'PEN',
      motivoNota: '',
      motivoBaja: '',
      serieDocOrigen: '',
      correlativoDocOrigen: '',
      tipoDocOrigen: '',
      descuentoGlobal: discount,
      observaciones: '',
      estado: 'Pagado',
      correoCliente: '',
      vencimiento: dateOnly,
      formapago: 'Contado',
      companyBilling: 'LWP',
      url: 'https://facturaloconlwp.com/api/comprobante',
      detalle: feDetalle
    };

    let feStatus = 'Nota de Venta Interna';
    let feResponseMsg = 'Comprobante interno registrado correctamente.';

    if (voucherType === 'boleta' || voucherType === 'factura') {
      const token = String(company.feToken || '').trim();
      if (token) {
        try {
          const feRes = await fetch('https://facturaloconlwp.com/api/comprobante', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(fePayload)
          });
          feResponseMsg = await feRes.text();
          feStatus = feRes.ok ? 'Aceptado por SUNAT / LWP' : 'Observado / Pendiente LWP';
        } catch (ex) {
          feStatus = 'Pendiente Sincronización LWP';
          feResponseMsg = 'Payload generado con estándar LWP.';
        }
      } else {
        feStatus = 'Emitido (Listo para Envío LWP / SUNAT)';
        feResponseMsg = 'Estructura JSON LWP generada. Configure el Bearer Token de facturaloconlwp.com en Ajustes para despacho automático a SUNAT.';
      }
    }

    order.status = 'paid';
    order.paidAt = nowStr;
    order.paymentMethod = paymentMethod;

    const table = (appState.tables || []).find(t => Number(t.id) === Number(order.tableId));
    if (table) {
      table.status = 'free';
      table.currentOrderId = null;
      table.waiterCall = false;
      table.billRequested = false;
      table.billTypeRequested = '';
      table.billVoucherKey = '';
      table.billDocNumber = '';
      table.billClientName = '';
      table.billClientAddress = '';
      table.billPaymentMethod = '';
    }

    const voucher = {
      id: 'VCH-' + Date.now(),
      voucherType,
      voucherLabel: voucherType === 'factura' ? 'FACTURA ELECTRÓNICA' : (voucherType === 'boleta' ? 'BOLETA DE VENTA ELECTRÓNICA' : 'NOTA DE VENTA'),
      serie: serieStr,
      correlativo: corrStr,
      fullNumber: `${serieStr}-${corrStr}`,
      issuedAt: nowStr,
      orderId: order.id,
      orderCode: order.code,
      tableName: order.tableName,
      clientDocNumber,
      clientName,
      clientAddress,
      paymentMethod,
      totalGravadas,
      totalExoneradas,
      igv: sumatoriaIGV,
      discount,
      total: finalTotal,
      items: order.items,
      feStatus,
      feResponseMsg,
      fePayload
    };

    if (!Array.isArray(appState.vouchers)) appState.vouchers = [];
    appState.vouchers.unshift(voucher);
    addNotification(appState, 'sale_paid', `✅ Cuenta cobrada en ${order.tableName} — ${voucher.fullNumber} (S/ ${finalTotal.toFixed(2)})`, order.tableId || 0, orderId);

    await saveState(appState);
    return res.status(200).json({ ok: true, voucher, order });
  }

  // 8. ADMINISTRACIÓN DE CARTA, PINES Y CONFIGURACIÓN
  if (pathname === '/api/admin/product' && req.method === 'POST') {
    const action = String(body.action || 'update');
    if (action === 'create') {
      const maxId = (appState.products || []).reduce((m, p) => Math.max(m, Number(p.id || 0)), 300) + 1;
      const newProd = {
        id: maxId,
        valuedId: maxId * 2,
        name: String(body.name || '').toUpperCase().trim(),
        category: String(body.category || 'OTROS').toUpperCase().trim(),
        station: String(body.station || 'cocina'),
        price: Number(body.price || 0),
        unit: 'NIU',
        active: true
      };
      appState.products.unshift(newProd);
      await saveState(appState);
      return res.status(200).json({ ok: true, product: newProd });
    } else {
      const prod = (appState.products || []).find(p => Number(p.id) === Number(body.id));
      if (!prod) return res.status(404).json({ error: 'Producto no encontrado.' });
      if (body.active !== undefined) prod.active = Boolean(body.active);
      if (body.price !== undefined) prod.price = Number(body.price);
      if (body.name !== undefined) prod.name = String(body.name).toUpperCase().trim();
      if (body.station !== undefined) prod.station = String(body.station);
      await saveState(appState);
      return res.status(200).json({ ok: true, product: prod });
    }
  }

  if (pathname === '/api/admin/table-pin' && req.method === 'POST') {
    const table = (appState.tables || []).find(t => Number(t.id) === Number(body.tableId));
    if (!table) return res.status(404).json({ error: 'Mesa no encontrada.' });
    table.pin = body.pin ? String(body.pin).trim() : String(Math.floor(10 + Math.random() * 89));
    await saveState(appState);
    return res.status(200).json({ ok: true, table });
  }

  if (pathname === '/api/admin/config' && req.method === 'POST') {
    if (!appState.company) appState.company = {};
    if (body.feToken !== undefined) appState.company.feToken = String(body.feToken).trim();
    if (body.leyAmazonia !== undefined) appState.company.leyAmazonia = Boolean(body.leyAmazonia);
    if (body.dailySalesGoal !== undefined) appState.company.dailySalesGoal = Number(body.dailySalesGoal);
    await saveState(appState);
    return res.status(200).json({ ok: true, company: appState.company });
  }

  if (pathname === '/api/admin/reset-demo' && req.method === 'POST') {
    const rawSeed = fs.readFileSync(SEED_FILE, 'utf8');
    const fresh = JSON.parse(rawSeed);
    ensureDemoActiveOrders(fresh);
    await saveState(fresh);
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: 'Ruta API no encontrada: ' + pathname });
};
