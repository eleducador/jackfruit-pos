let state = null;
let currentVersion = '';
let currentView = 'salon';
let selectedTableId = 1;
let selectedExternalOrderId = null;
let zoneFilter = 'all';
let kdsStationFilter = 'all';
let soundEnabled = true;
let knownNotificationIds = new Set();
let firstLoadDone = false;

// Estado temporal para tomar pedido manual en POS
let posDraftChannel = 'mesa';
let posDraftTableId = 0;
let posDraftItems = {}; // prodId -> { product, qty }

// Estado temporal para Checkout
let checkoutOrderId = '';
let checkoutVoucherType = 'boleta';

// Estado de Sesión / Perfil de Usuario y Reportes Históricos (Día / Mes / Año)
let currentUser = null;
let reportPeriodMode = 'day'; // 'day' | 'month' | 'year'

const viewTitles = {
  salon: '🏛️ Salón, Mesas y Caja Rápida',
  kds: '👨‍🍳 Pantalla Inteligente de Comandas (KDS Cocina / Heladería / Barra)',
  simulador: '📱 Simulador en Vivo: Celular QR del Cliente + Recepción en Cocina y Caja',
  qrs: '🖨️ Generador de Tarjetas QR y PIN de Seguridad por Mesa (Mesas 1 a 28)',
  facturacion: '🧾 Facturación Electrónica (facturaloconlwp.com), Caja y Auditoría',
  carta: '📖 Gestión de Carta Digital y Precios (162 Productos Jackfruit)',
  reportes: '📊 Control Gerencial de Ventas Detalladas (Día / Mes / Año - Retención 1 Año) y Perfiles'
};

function playAlertChime(type, spokenText) {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (type === 'qr_order') {
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.14);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    } else if (type === 'waiter_call' || type === 'bill_request') {
      // Doble timbre fuerte de llamado de mesa
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(784, ctx.currentTime);
      osc.frequency.setValueAtTime(1046.5, ctx.currentTime + 0.15);
      osc.frequency.setValueAtTime(784, ctx.currentTime + 0.32);
      osc.frequency.setValueAtTime(1046.5, ctx.currentTime + 0.47);
      gain.gain.setValueAtTime(0.28, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.75);
      osc.start();
      osc.stop(ctx.currentTime + 0.75);
    } else {
      osc.frequency.setValueAtTime(523.25, ctx.currentTime);
      osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.12);
      osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.24);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    }

    if (spokenText && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(spokenText);
      utter.lang = 'es-PE';
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
    }
  } catch (e) {}
}

function showWaiterCallPopup(notif) {
  const modal = document.getElementById('waiterCallPopupModal');
  if (!modal) return;

  const tableId = notif.tableId || 1;
  const table = (state && state.tables) ? state.tables.find(t => t.id === tableId) : null;
  const tName = table ? table.name.toUpperCase() : ('MESA ' + tableId);
  const tZone = table ? table.zone : 'Salón Principal';

  const isBill = notif.type === 'bill_request';
  document.getElementById('waiterPopupIcon').textContent = isBill ? '🧾' : '🔔';
  document.getElementById('waiterPopupSubtitle').textContent = isBill
    ? '¡SOLICITUD DE CUENTA DESDE EL QR!'
    : '¡LLAMADO AL MOZO EN PANTALLA!';
  document.getElementById('waiterPopupTableName').textContent = tName;
  document.getElementById('waiterPopupMessage').textContent = isBill
    ? notif.message
    : `La ${table ? table.name : ('Mesa ' + tableId)} está solicitando la presencia del mozo en este momento.`;
  document.getElementById('waiterPopupZone').textContent = `${tZone} • Hora del llamado: ${notif.time || 'Ahora mismo'}`;

  const attendBtn = document.getElementById('waiterPopupAttendBtn');
  attendBtn.onclick = async function () {
    modal.classList.remove('open');
    if (isBill) {
      await clearTableAlerts(tableId);
      switchView('salon');
      selectTableAndOpenCheckout(tableId);
    } else {
      await clearTableAlerts(tableId);
      switchView('salon');
      selectTable(tableId);
    }
  };

  modal.classList.add('open');
}

function dismissWaiterPopupOnly() {
  const modal = document.getElementById('waiterCallPopupModal');
  if (modal) modal.classList.remove('open');
}

function renderGlobalTopAlerts() {
  const globalBox = document.getElementById('globalTopAlerts');
  if (!globalBox || !state) return;

  const items = [];
  state.tables.forEach(t => {
    if (t.waiterCall) {
      items.push(`
        <div class="alert-banner" style="margin:10px 0 4px;border:2px solid #f59e0b;background:#fef3c7;box-shadow:0 4px 12px rgba(245,158,11,0.18)">
          <span style="font-size:14.5px">🔔 <strong>¡ATENCIÓN MOZO! La ${t.name.toUpperCase()} (${t.zone}) está solicitando al mozo.</strong></span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" onclick="attendTableCallFromBanner(${t.id})">✅ Atender ${t.name}</button>
          </div>
        </div>
      `);
    }
    if (t.billRequested) {
      items.push(`
        <div class="alert-banner" style="margin:10px 0 4px;border:2px solid #2563eb;background:#dbeafe;color:#1e3a8a">
          <span style="font-size:14.5px">🧾 <strong>¡CUENTA SOLICITADA! La ${t.name.toUpperCase()} pide la cuenta (${t.billTypeRequested || 'Boleta'}).</strong></span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" onclick="switchView('salon');selectTableAndOpenCheckout(${t.id})">💳 Cobrar ${t.name}</button>
            <button class="btn btn-sm" onclick="clearTableAlerts(${t.id})">Atendido ✓</button>
          </div>
        </div>
      `);
    }
  });

  globalBox.innerHTML = items.join('');
}

async function attendTableCallFromBanner(tableId) {
  dismissWaiterPopupOnly();
  await clearTableAlerts(tableId);
  switchView('salon');
  selectTable(tableId);
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  document.getElementById('soundToggleBtn').textContent = soundEnabled ? '🔊 Sonido: ON' : '🔇 Sonido: OFF';
}

async function loadState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    state = data;
    currentVersion = data.version;

    if (data.notifications) {
      // Procesar desde el más antiguo al más reciente para mostrar el último llamado en pantalla
      const reversed = [...data.notifications].reverse();
      reversed.forEach(n => {
        if (!knownNotificationIds.has(n.id)) {
          knownNotificationIds.add(n.id);
          if (firstLoadDone) {
            if (n.type === 'waiter_call') {
              playAlertChime('waiter_call', `Atención, la Mesa ${n.tableId} está llamando al mozo`);
              showWaiterCallPopup(n);
            } else if (n.type === 'bill_request') {
              playAlertChime('bill_request', `Atención, la Mesa ${n.tableId} solicita la cuenta`);
              showWaiterCallPopup(n);
            } else {
              playAlertChime(n.type);
            }
          }
        }
      });
    }

    if (!firstLoadDone) {
      firstLoadDone = true;
      populateAdminCategoryFilter();
      populateSimulatorSelect();
    }

    renderAll();
  } catch (e) {
    console.error('Error cargando estado:', e);
  }
}

async function pollChanges() {
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    if (data.version && data.version !== currentVersion) {
      await loadState();
    }
  } catch (e) {}
}

function switchView(view) {
  if (currentUser) {
    const role = currentUser.role;
    if ((view === 'reportes' || view === 'carta') && role !== 'admin') {
      alert('🔒 Acceso restringido: Solo el perfil Administrador puede ingresar a este módulo.');
      return;
    }
    if (view === 'facturacion' && role !== 'admin' && role !== 'cajero') {
      alert('🔒 Acceso restringido: Solo Administrador o Cajero pueden ver Boletas y Facturas.');
      return;
    }
  }
  currentView = view;
  ['salon', 'kds', 'simulador', 'qrs', 'facturacion', 'carta', 'reportes'].forEach(v => {
    const vEl = document.getElementById('view-' + v);
    const nEl = document.getElementById('nav-' + v);
    if (vEl) vEl.style.display = (v === view) ? 'block' : 'none';
    if (nEl) nEl.classList.toggle('active', v === view);
  });
  document.getElementById('viewTitle').textContent = viewTitles[view] || '';
  renderAll();
}

function renderAll() {
  if (!state) return;
  updateSidebarBadges();
  renderGlobalTopAlerts();
  renderSalon();
  renderKds();
  renderSimulatorRightPane();
  if (currentView === 'qrs') renderQrCards();
  if (currentView === 'facturacion') renderFacturacionView();
  if (currentView === 'carta') renderAdminProducts();
  if (currentView === 'reportes') renderAdminReportsView();
}

function updateSidebarBadges() {
  const occupiedCount = state.tables.filter(t => t.status === 'occupied').length;
  document.getElementById('badge-salon').textContent = occupiedCount;

  const openOrders = state.orders.filter(o => o.status === 'open');
  let pendingKdsItems = 0;
  openOrders.forEach(o => {
    (o.items || []).forEach(it => {
      if (it.state === 'pending' || it.state === 'preparing') pendingKdsItems++;
    });
  });
  document.getElementById('badge-kds').textContent = pendingKdsItems;
  document.getElementById('badge-vouchers').textContent = (state.vouchers || []).length;
  document.getElementById('badge-products').textContent = (state.products || []).filter(p => p.active).length;
}

// ============================================================================
// 1. SALÓN, MESAS Y CAJA RÁPIDA
// ============================================================================
function setZoneFilter(z) {
  zoneFilter = z;
  ['all', 'main', 'terrace', 'external'].forEach(k => {
    const btn = document.getElementById('zoneBtn-' + k);
    if (btn) btn.classList.remove('btn-primary');
  });
  if (z === 'all') document.getElementById('zoneBtn-all').classList.add('btn-primary');
  else if (z === 'Salón Principal') document.getElementById('zoneBtn-main').classList.add('btn-primary');
  else if (z === 'Salón 2 / Terraza') document.getElementById('zoneBtn-terrace').classList.add('btn-primary');
  else if (z === 'external') document.getElementById('zoneBtn-external').classList.add('btn-primary');
  renderSalon();
}

function renderSalon() {
  if (!state) return;
  const openOrders = state.orders.filter(o => o.status === 'open');
  const occupiedTables = state.tables.filter(t => t.status === 'occupied').length;

  let readyDishesCount = 0;
  let qrOrdersCount = 0;
  openOrders.forEach(o => {
    if (o.channel === 'qr') qrOrdersCount++;
    (o.items || []).forEach(it => {
      if (it.state === 'ready') readyDishesCount += it.qty;
    });
  });

  const totalPaidToday = (state.vouchers || []).reduce((acc, v) => acc + Number(v.total || 0), 0);
  const goal = Number(state.company.salesGoal || 1800);
  const pct = Math.min(100, Math.round((totalPaidToday / goal) * 100));

  document.getElementById('salonKpis').innerHTML = `
    <div class="kpi-card">
      <div>
        <div class="kpi-label">Mesas Activas</div>
        <div class="kpi-val">${occupiedTables} / ${state.tables.length}</div>
        <div class="kpi-sub">${qrOrdersCount} iniciadas por QR de mesa</div>
      </div>
      <div class="kpi-icon" style="background:#fef3c7;color:#b45309">🪑</div>
    </div>
    <div class="kpi-card">
      <div>
        <div class="kpi-label">Platos Listos para Llevar</div>
        <div class="kpi-val" style="color:${readyDishesCount > 0 ? '#15803d' : 'inherit'}">${readyDishesCount}</div>
        <div class="kpi-sub">Trabajo del mozo: solo recoger y entregar</div>
      </div>
      <div class="kpi-icon" style="background:#dcfce7;color:#15803d">🍽️</div>
    </div>
    <div class="kpi-card">
      <div>
        <div class="kpi-label">Comandas en Cocina</div>
        <div class="kpi-val">${openOrders.length}</div>
        <div class="kpi-sub">0 comandas antiguas estancadas</div>
      </div>
      <div class="kpi-icon" style="background:#ffedd5;color:#c2410c">🔥</div>
    </div>
    <div class="kpi-card">
      <div>
        <div class="kpi-label">Ventas Cobradas vs Meta</div>
        <div class="kpi-val">S/ ${totalPaidToday.toFixed(2)}</div>
        <div class="kpi-sub">Meta diaria: S/ ${goal.toFixed(2)} (${pct}%)</div>
      </div>
      <div class="kpi-icon" style="background:#e0f2fe;color:#0369a1">💰</div>
    </div>
  `;

  // Alertas accionables inmediatas para el Mozo / Caja
  const alertsHtml = [];
  openOrders.forEach(o => {
    const readyItems = (o.items || []).filter(i => i.state === 'ready');
    if (readyItems.length > 0) {
      const names = readyItems.map(i => `${i.qty}x ${i.name}`).join(', ');
      alertsHtml.push(`
        <div class="alert-banner ready">
          <span>🍽️ <strong>¡LISTO EN COCINA PARA LLEVAR A ${o.tableName.toUpperCase()}!:</strong> ${names}</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm btn-primary" onclick="markReadyItemsDelivered('${o.id}')">
              ✅ Ya lo llevé a la mesa
            </button>
          </div>
        </div>
      `);
    }
  });

  state.tables.forEach(t => {
    if (t.waiterCall) {
      alertsHtml.push(`
        <div class="alert-banner">
          <span>🔔 <strong>${t.name}</strong> llamó al mozo desde su código QR.</span>
          <button class="btn btn-sm" onclick="clearTableAlerts(${t.id})">Atendido ✓</button>
        </div>
      `);
    }
    if (t.billRequested) {
      alertsHtml.push(`
        <div class="alert-banner" style="background:#eff6ff;border-color:#93c5fd;color:#1e3a8a">
          <span>🧾 <strong>${t.name}</strong> solicita la cuenta desde el QR — Desea: <strong>${t.billTypeRequested || 'Boleta'}</strong></span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm btn-primary" onclick="selectTableAndOpenCheckout(${t.id})">💳 Cobrar Ahora</button>
            <button class="btn btn-sm" onclick="clearTableAlerts(${t.id})">Ocultar</button>
          </div>
        </div>
      `);
    }
  });

  document.getElementById('waiterAlertsStrip').innerHTML = alertsHtml.join('');

  // Renderizar Cuadrícula de Mesas o Pedidos Externos
  const gridEl = document.getElementById('tablesGrid');
  if (zoneFilter === 'external') {
    const extOrders = openOrders.filter(o => o.channel !== 'mesa' && o.channel !== 'qr');
    if (extOrders.length === 0) {
      gridEl.innerHTML = `<div style="grid-column:1/-1;background:#fff;padding:28px;border-radius:14px;text-align:center;color:var(--muted)">No hay pedidos activos en Mostrador o Delivery. Usa los botones superiores para crear uno.</div>`;
    } else {
      gridEl.innerHTML = extOrders.map(o => `
        <div class="table-card occupied ${selectedExternalOrderId === o.id ? 'selected' : ''}" onclick="selectExternalOrder('${o.id}')">
          <div class="table-card-top">
            <span class="table-num">${o.channel === 'delivery' ? '🛵 Delivery' : '🛍️ Mostrador'}</span>
            <span class="pin-tag">#${o.code}</span>
          </div>
          <div style="font-size:12px;font-weight:700">${o.customerName}</div>
          <div class="table-total">S/ ${Number(o.total).toFixed(2)}</div>
        </div>
      `).join('');
    }
  } else {
    const filteredTables = state.tables.filter(t => zoneFilter === 'all' || t.zone === zoneFilter);
    gridEl.innerHTML = filteredTables.map(t => {
      const ord = openOrders.find(o => o.tableId === t.id);
      const onlyPendingCnt = ord ? (ord.items || []).filter(i => i.state === 'pending').length : 0;
      const preparingCnt = ord ? (ord.items || []).filter(i => i.state === 'preparing').length : 0;
      const readyCnt = ord ? (ord.items || []).filter(i => i.state === 'ready').length : 0;

      let statusCls = 'st-free';
      let stateBannerText = '';

      if (t.waiterCall) {
        statusCls = 'st-waiter';
        stateBannerText = '🔔 ¡LLAMA AL MOZO!';
      } else if (t.billRequested) {
        statusCls = 'st-bill';
        stateBannerText = '🧾 ¡PIDE LA CUENTA!';
      } else if (readyCnt > 0) {
        statusCls = 'st-ready';
        stateBannerText = `✅ ¡LISTO PARA LLEVAR! (${readyCnt})`;
      } else if (preparingCnt > 0) {
        statusCls = 'st-preparing';
        stateBannerText = `🔥 EN PREPARACIÓN (${preparingCnt})`;
      } else if (onlyPendingCnt > 0) {
        statusCls = 'st-pending';
        stateBannerText = `⏳ EN COLA COCINA (${onlyPendingCnt})`;
      } else if (ord) {
        statusCls = 'st-delivered';
        stateBannerText = '🍽️ SERVIDO EN MESA';
      }

      return `
        <div class="table-card ${statusCls} ${selectedTableId === t.id && !selectedExternalOrderId ? 'selected' : ''}" onclick="selectTable(${t.id})">
          <div class="table-card-top">
            <span class="table-num">${t.name}</span>
            <span class="pin-tag" title="PIN de seguridad QR">PIN: ${t.pin}</span>
          </div>
          ${ord ? `
            <div style="font-size:11.5px;color:rgba(255,255,255,0.92);font-weight:700">
              ${ord.channel === 'qr' ? '📱 Pedido QR' : '🤵 Salón'} • ${ord.items.length} ítem(s)
            </div>
            <div class="table-total">S/ ${Number(ord.total).toFixed(2)}</div>
            <div class="table-state-banner">${stateBannerText}</div>
          ` : (t.waiterCall || t.billRequested) ? `
            <div style="font-size:12px;color:#fff;font-weight:700;margin-top:4px">${t.zone}</div>
            <div class="table-state-banner">${stateBannerText}</div>
          ` : `
            <div style="font-size:12px;color:var(--muted);margin-top:8px">Disponible</div>
            <div style="font-size:11px;color:#94a3b8;margin-top:4px">${t.zone}</div>
          `}
        </div>
      `;
    }).join('');
  }

  renderSelectedOrderPanel();
}

function selectTable(tableId) {
  selectedTableId = tableId;
  selectedExternalOrderId = null;
  renderSalon();
}

function selectExternalOrder(orderId) {
  selectedExternalOrderId = orderId;
  renderSalon();
}

function renderSelectedOrderPanel() {
  const panel = document.getElementById('selectedTablePanel');
  const openOrders = state.orders.filter(o => o.status === 'open');
  let order = null;
  let table = null;

  if (selectedExternalOrderId) {
    order = openOrders.find(o => o.id === selectedExternalOrderId);
  } else {
    table = state.tables.find(t => t.id === selectedTableId) || state.tables[0];
    if (table) order = openOrders.find(o => o.tableId === table.id);
  }

  if (!order) {
    const tName = table ? table.name : 'Mesa';
    const tId = table ? table.id : 1;
    const tPin = table ? table.pin : '--';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <h3 style="font-size:18px;font-weight:800">${tName} — Libre</h3>
          <span style="font-size:12px;color:var(--muted)">PIN de Seguridad QR: <strong>${tPin}</strong></span>
        </div>
        <button class="btn btn-sm btn-accent" onclick="window.open('/qr.html?mesa=${tId}', '_blank')">
          📱 Probar QR de ${tName}
        </button>
      </div>
      <div style="text-align:center;padding:30px 12px;background:#f8fafc;border-radius:12px;border:1px dashed var(--border);margin-bottom:14px">
        <div style="font-size:32px;margin-bottom:8px">🌴</div>
        <p style="font-size:13px;color:var(--muted)">
          Cuando el cliente escanee el QR de la <strong>${tName}</strong> e ingrese el PIN <strong>${tPin}</strong>, su pedido aparecerá aquí y en Cocina automáticamente.
        </p>
      </div>
      <button class="btn btn-primary" style="width:100%;justify-content:center;padding:12px" onclick="openPosNewOrderModal('mesa', ${tId})">
        + Tomar Pedido Manual en ${tName}
      </button>
    `;
    return;
  }

  const stateBadges = {
    pending: '<span class="mini-badge" style="background:#fef3c7;color:#92400e">⏳ Cola</span>',
    preparing: '<span class="mini-badge" style="background:#ffedd5;color:#c2410c">🔥 Cocina</span>',
    ready: '<span class="mini-badge" style="background:#dcfce7;color:#15803d">✅ Listo</span>',
    delivered: '<span class="mini-badge" style="background:#f1f5f9;color:#475569">🍽️ Servido</span>'
  };

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border)">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <h3 style="font-size:18px;font-weight:800">${order.tableName}</h3>
          <span class="mini-badge" style="background:#dcfce7;color:#15803d">#${order.code}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">
          Cliente: <strong>${order.customerName}</strong> ${ table ? `• PIN QR: <strong>${table.pin}</strong>` : '' }
        </div>
      </div>
      ${table ? `
        <button class="btn btn-sm" onclick="window.open('/qr.html?mesa=${table.id}', '_blank')" title="Abrir vista celular del cliente">
          📱 Ver QR
        </button>
      ` : ''}
    </div>

    <div style="max-height:310px;overflow-y:auto;margin-bottom:12px">
      ${(order.items || []).map(it => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed var(--border);gap:8px">
          <div style="flex:1">
            <div style="font-size:13.5px;font-weight:700">
              ${it.qty}x ${it.name}
              <span style="font-size:10px;color:var(--muted)">(${it.source === 'qr' ? '📱 QR' : '🤵 Mozo'})</span>
            </div>
            ${it.comment ? `<div style="font-size:11px;color:#b45309">Nota: ${it.comment}</div>` : ''}
            <div style="font-size:12px;color:var(--muted)">S/ ${Number(it.subtotal).toFixed(2)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${stateBadges[it.state] || ''}
            ${it.state === 'ready' ? `
              <button class="btn btn-sm btn-primary" onclick="updateSingleItemState('${order.id}', '${it.id}', 'delivered')" title="Marcar como entregado en mesa">
                Entregar
              </button>
            ` : ''}
            <button class="btn btn-sm" style="color:var(--danger);padding:4px 7px" onclick="removeOrderItem('${order.id}', '${it.id}', '${it.name}')" title="Anular ítem con registro en auditoría">
              ✕
            </button>
          </div>
        </div>
      `).join('')}
    </div>

    <div style="background:#f8fafc;padding:12px;border-radius:12px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px">
        <span>Op. Exonerada (Ley Amazonía):</span>
        <span>S/ ${Number(order.total).toFixed(2)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:800;color:#052e16">
        <span>Total a Cobrar:</span>
        <span>S/ ${Number(order.total).toFixed(2)}</span>
      </div>
    </div>

    ${(order.billingDocNumber || order.billingVoucherType || (table && (table.billDocNumber || table.billVoucherKey))) ? `
      <div style="background:#eff6ff;border:1.5px solid #3b82f6;border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#1e3a8a">
        <div style="font-weight:800;margin-bottom:4px">🧾 Datos de Facturación Grabados desde el QR:</div>
        <div><strong>Comprobante:</strong> ${(order.billingVoucherType || (table && table.billVoucherKey)) === 'factura' ? 'Factura Electrónica (FA01)' : ((order.billingVoucherType || (table && table.billVoucherKey)) === 'notaVenta' ? 'Nota de Venta (NV01)' : 'Boleta Electrónica (BA01)')}</div>
        ${(order.billingDocNumber || (table && table.billDocNumber)) ? `<div><strong>DNI / RUC:</strong> ${order.billingDocNumber || table.billDocNumber}</div>` : ''}
        ${(order.billingClientName || (table && table.billClientName)) ? `<div><strong>Cliente / Razón Social:</strong> ${order.billingClientName || table.billClientName}</div>` : ''}
        ${(order.billingPaymentMethod || (table && table.billPaymentMethod)) ? `<div><strong>Medio de Pago:</strong> ${order.billingPaymentMethod || table.billPaymentMethod}</div>` : ''}
      </div>
    ` : ''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <button class="btn" style="justify-content:center" onclick="openPosNewOrderModal('${order.channel}', ${order.tableId || 0}, '${order.id}')">
        + Agregar Platos
      </button>
      <button class="btn" style="justify-content:center" onclick="printPreAccount('${order.id}')">
        🖨️ Pre-Cuenta
      </button>
    </div>

    <button class="btn btn-primary" style="width:100%;justify-content:center;padding:13px;font-size:14.5px" onclick="openCheckoutModal('${order.id}')">
      💳 Cobrar y Emitir Boleta / Factura
    </button>
  `;
}

// ============================================================================
// 2. PANTALLA INTELIGENTE DE COMANDAS — KDS (COCINA / HELADERÍA / BARRA)
// ============================================================================
function setKdsStation(st) {
  kdsStationFilter = st;
  ['all', 'heladeria', 'cocina', 'barra'].forEach(k => {
    const btn = document.getElementById('kdsSt-' + k);
    if (btn) btn.classList.toggle('btn-primary', k === st);
  });
  renderKds();
}

function getElapsedInfo(createdAtStr) {
  if (!createdAtStr) return { text: '00:00', mins: 0, sla: 'sla-green' };
  const parts = createdAtStr.split(/[- :]/);
  const dt = new Date(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0, parts[5] || 0);
  const diffSec = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  const text = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  let sla = 'sla-green';
  if (mins >= 12) sla = 'sla-red';
  else if (mins >= 5) sla = 'sla-amber';
  return { text, mins, sla };
}

function renderKdsCardHtml(order, stationFilter) {
  const activeItems = (order.items || []).filter(it => {
    if (it.state === 'delivered') return false;
    if (stationFilter !== 'all' && it.station !== stationFilter) return false;
    return true;
  });
  if (activeItems.length === 0) return '';

  const elapsed = getElapsedInfo(order.updatedAt || order.createdAt);
  const hasPending = activeItems.some(i => i.state === 'pending');
  const hasPreparing = activeItems.some(i => i.state === 'preparing');

  // Estado global intenso para pintar todo el cuadro de la comanda en KDS
  let kdsStateClass = 'kds-state-ready';
  let kdsStateTag = '✅ LISTO PARA MOZO';
  if (hasPreparing) {
    kdsStateClass = 'kds-state-preparing';
    kdsStateTag = '🔥 EN PREPARACIÓN';
  } else if (hasPending) {
    kdsStateClass = 'kds-state-pending';
    kdsStateTag = '⏳ EN COLA / NUEVO';
  }

  const stationBadges = {
    heladeria: '🍨 Heladería',
    cocina: '🍳 Cocina',
    barra: '🍹 Barra'
  };

  return `
    <div class="kds-card ${kdsStateClass} ${elapsed.sla}" data-created="${order.updatedAt || order.createdAt}">
      <div class="kds-header">
        <div>
          <div style="font-size:18px;font-weight:800;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span>${order.tableName}</span>
            <span style="font-size:11px;font-weight:800;background:rgba(0,0,0,0.32);padding:3px 9px;border-radius:99px;border:1px solid rgba(255,255,255,0.35)">
              ${kdsStateTag}
            </span>
          </div>
          <div style="font-size:11.5px;opacity:0.95;margin-top:3px">
            Comanda #${order.code} • ${order.customerName} (${order.channel === 'qr' ? '📱 QR MESA' : '🤵 SALÓN'})
          </div>
        </div>
        <div class="kds-timer" data-timer-ts="${order.updatedAt || order.createdAt}">⏱ ${elapsed.text}</div>
      </div>

      <div class="kds-items">
        ${activeItems.map(it => {
          const rowBg = it.state === 'ready'
            ? 'background:#86efac;border:1.5px solid #16a34a;color:#052e16;'
            : (it.state === 'preparing'
                ? 'background:#fdba74;border:1.5px solid #ea580c;color:#7c2d12;'
                : 'background:#fde047;border:1.5px solid #d97706;color:#713f12;');
          return `
          <div class="kds-item-row" style="${rowBg}padding:10px;border-radius:10px;margin-bottom:8px">
            <div style="display:flex;align-items:start;gap:8px">
              <span class="kds-qty" style="color:inherit">${it.qty}x</span>
              <div>
                <div style="font-weight:800;font-size:14.5px">${it.name}</div>
                <span style="font-size:11px;font-weight:700;opacity:0.85">${stationBadges[it.station] || it.category}</span>
                ${it.comment ? `<div style="font-size:12px;font-weight:800;color:#fff;background:#b91c1c;padding:2px 8px;border-radius:6px;margin-top:4px">⚠️ ${it.comment}</div>` : ''}
              </div>
            </div>
            <div>
              ${it.state === 'pending' ? `
                <button class="btn btn-sm" style="background:#ea580c;color:#fff;border-color:#c2410c;font-weight:800" onclick="updateSingleItemState('${order.id}', '${it.id}', 'preparing')">
                  🔥 Preparar
                </button>
              ` : it.state === 'preparing' ? `
                <button class="btn btn-sm" style="background:#15803d;color:#fff;border-color:#14532d;font-weight:800" onclick="updateSingleItemState('${order.id}', '${it.id}', 'ready')">
                  ✅ Listo
                </button>
              ` : `
                <button class="btn btn-sm" style="background:#052e16;color:#fff;font-weight:800" onclick="updateSingleItemState('${order.id}', '${it.id}', 'delivered')">
                  🍽️ Entregado
                </button>
              `}
            </div>
          </div>
        `;
        }).join('')}
      </div>

      <div class="kds-footer">
        ${hasPending ? `
          <button class="btn" style="flex:1;justify-content:center;background:#ffedd5;color:#9a3412;border-color:#fdba74" onclick="updateWholeOrderKds('${order.id}', 'preparing', '${stationFilter}')">
            🔥 En Preparación Todo
          </button>
        ` : ''}
        ${(hasPending || hasPreparing) ? `
          <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="updateWholeOrderKds('${order.id}', 'ready', '${stationFilter}')">
            ✅ ¡Despachar Listo para Mozo!
          </button>
        ` : `
          <button class="btn" style="flex:1;justify-content:center" onclick="updateWholeOrderKds('${order.id}', 'delivered', '${stationFilter}')">
            🍽️ Marcar Todo Entregado en Mesa
          </button>
        `}
      </div>
    </div>
  `;
}

function renderKds() {
  if (!state) return;
  const openOrders = state.orders.filter(o => o.status === 'open');
  const cards = openOrders.map(o => renderKdsCardHtml(o, kdsStationFilter)).filter(Boolean);
  const grid = document.getElementById('kdsGrid');

  if (cards.length === 0) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;background:#fff;border:1px solid var(--border);border-radius:16px;padding:48px 20px;text-align:center">
        <div style="font-size:44px;margin-bottom:10px">✨</div>
        <h3 style="font-size:18px;font-weight:800;margin-bottom:4px">¡Todo al día en esta estación!</h3>
        <p style="font-size:13.5px;color:var(--muted)">Las nuevas comandas enviadas por QR desde las mesas aparecerán aquí al instante.</p>
      </div>
    `;
  } else {
    grid.innerHTML = cards.join('');
  }
}

// Un único reloj global ligero (sin fugas de memoria) que actualiza los cronómetros visibles cada segundo
setInterval(() => {
  document.querySelectorAll('[data-timer-ts]').forEach(el => {
    const ts = el.getAttribute('data-timer-ts');
    const info = getElapsedInfo(ts);
    el.textContent = '⏱ ' + info.text;
  });
}, 1000);

async function updateSingleItemState(orderId, itemId, newState) {
  await fetch('/api/kds/update-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, itemId, newState })
  });
  await loadState();
}

async function updateWholeOrderKds(orderId, newState, station) {
  await fetch('/api/kds/update-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, newState, station })
  });
  await loadState();
}

async function markReadyItemsDelivered(orderId) {
  const order = state.orders.find(o => o.id === orderId);
  if (!order) return;
  const readyItems = (order.items || []).filter(i => i.state === 'ready');
  for (const it of readyItems) {
    await fetch('/api/kds/update-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, itemId: it.id, newState: 'delivered' })
    });
  }
  await loadState();
}

async function clearTableAlerts(tableId) {
  await fetch('/api/qr/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableId, action: 'clear_alerts' })
  });
  await loadState();
}

// ============================================================================
// 3. SIMULADOR EN PANTALLA DIVIDIDA (CELULAR QR + KDS EN VIVO)
// ============================================================================
function populateSimulatorSelect() {
  const sel = document.getElementById('simTableSelect');
  if (!sel || !state) return;
  sel.innerHTML = state.tables.map(t => `<option value="${t.id}" ${t.id === 6 ? 'selected' : ''}>${t.name} (PIN: ${t.pin})</option>`).join('');
}

function changeSimulatorTable(tId) {
  document.getElementById('qrSimulatorFrame').src = '/qr.html?mesa=' + tId;
}

function renderSimulatorRightPane() {
  const container = document.getElementById('simLiveKds');
  if (!container || !state) return;
  const openOrders = state.orders.filter(o => o.status === 'open');
  const cards = openOrders.map(o => renderKdsCardHtml(o, 'all')).filter(Boolean);

  const recentNotifs = (state.notifications || []).slice(0, 4);
  container.innerHTML = `
    <div style="background:#fff;border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:14px">
      <div style="font-size:12px;font-weight:800;color:var(--muted);text-transform:uppercase;margin-bottom:8px">
        🔔 Últimos Eventos en Tiempo Real (Caja / Mozo / Cocina)
      </div>
      ${recentNotifs.map(n => `
        <div style="padding:7px 10px;background:#f8fafc;border-radius:8px;font-size:13px;font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between">
          <span>${n.message}</span>
          <span style="color:var(--muted);font-size:11px">${n.time}</span>
        </div>
      `).join('')}
    </div>
    <h4 style="font-size:14px;font-weight:800;margin-bottom:10px">👨‍🍳 Comandas Activas en Cocina / Heladería (${cards.length}):</h4>
    <div class="kds-grid">${cards.join('')}</div>
  `;
}

// ============================================================================
// 4. GENERADOR DE CÓDIGOS QR Y PIN POR MESA (IMPRIMIBLES)
// ============================================================================
function renderQrCards() {
  const container = document.getElementById('qrCardsContainer');
  if (!container || !state) return;

  const baseHost = (state.publicUrl && state.publicUrl.length > 5)
    ? state.publicUrl.replace(/\/$/, '')
    : ((state.lanIp && state.lanIp !== '127.0.0.1')
      ? `http://${state.lanIp}:${state.port || 8085}`
      : window.location.origin);

  container.innerHTML = state.tables.map(t => {
    const qrUrl = `${baseHost}/qr.html?mesa=${t.id}`;
    return `
      <div class="qr-print-card">
        <div style="font-size:11px;font-weight:800;color:var(--primary);letter-spacing:0.04em">JACKFRUIT RÍO NEGRO</div>
        <h3 style="font-size:20px;font-weight:800;margin:4px 0">${t.name}</h3>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">${t.zone}</div>
        <div id="qrcode-box-${t.id}" style="display:flex;justify-content:center;margin:10px 0"></div>
        <div style="background:#fef9c3;border:1.5px dashed #eab308;border-radius:10px;padding:6px 10px;margin:10px 0">
          <div style="font-size:10px;font-weight:700;color:#854d0e">PIN DE SEGURIDAD DE MESA</div>
          <div style="font-size:20px;font-weight:800;color:#713f12;letter-spacing:4px">${t.pin}</div>
        </div>
        <div style="font-size:10.5px;color:var(--muted);margin-bottom:10px">
          Escanea con tu celular para ver la carta y pedir sin esperar al mozo
        </div>
        <div class="no-print" style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-sm btn-primary" onclick="window.open('/qr.html?mesa=${t.id}', '_blank')">📱 Probar QR</button>
          <button class="btn btn-sm btn-accent" onclick="triggerTestWaiterCall(${t.id})">🔔 Llamar Mozo</button>
          <button class="btn btn-sm" onclick="regenerateTablePin(${t.id})">🔄 PIN</button>
        </div>
      </div>
    `;
  }).join('');

  setTimeout(() => {
    state.tables.forEach(t => {
      const box = document.getElementById('qrcode-box-' + t.id);
      if (box && typeof QRCode !== 'undefined') {
        box.innerHTML = '';
        new QRCode(box, {
          text: `${baseHost}/qr.html?mesa=${t.id}`,
          width: 138,
          height: 138,
          colorDark: '#052e16',
          colorLight: '#ffffff'
        });
      }
    });
  }, 60);
}

async function regenerateTablePin(tableId) {
  await fetch('/api/admin/table-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableId })
  });
  await loadState();
}

async function triggerTestWaiterCall(tableId) {
  await fetch('/api/qr/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableId, action: 'call_waiter' })
  });
  await loadState();
}

// ============================================================================
// 5. TOMAR PEDIDO MANUAL (MOZO / MOSTRADOR / DELIVERY) Y ANULAR ÍTEMS
// ============================================================================
function openPosNewOrderModal(channel, tableId = 0, existingOrderId = null) {
  posDraftChannel = channel;
  posDraftTableId = tableId;
  posDraftItems = {};
  document.getElementById('posSearchProd').value = '';
  document.getElementById('posCustomerName').value = '';

  let title = '🛍️ Nuevo Pedido en Mostrador';
  if (channel === 'delivery') title = '🛵 Nuevo Pedido Delivery';
  else if (tableId > 0) title = `🍽️ Agregar Platos — Mesa ${tableId}`;
  document.getElementById('posModalTitle').textContent = title;

  renderPosProductPicker();
  renderPosDraftList();
  document.getElementById('posOrderModal').classList.add('open');
}

function renderPosProductPicker() {
  if (!state) return;
  const q = (document.getElementById('posSearchProd').value || '').toLowerCase().trim();
  const prods = state.products.filter(p => p.active && (!q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q))).slice(0, 60);

  document.getElementById('posProductPickerList').innerHTML = prods.map(p => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:#fff">
      <div>
        <span style="font-size:10px;font-weight:800;color:var(--primary);background:var(--primary-soft);padding:1px 6px;border-radius:4px">${p.category}</span>
        <div style="font-weight:700;font-size:13px">${p.name}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-weight:800;font-size:13.5px">S/ ${Number(p.price).toFixed(2)}</span>
        <button class="btn btn-sm btn-primary" onclick="addPosDraftItem(${p.id}, 1)">+ Agregar</button>
      </div>
    </div>
  `).join('');
}

function addPosDraftItem(prodId, delta) {
  const prod = state.products.find(p => p.id === prodId);
  if (!prod) return;
  if (!posDraftItems[prodId]) posDraftItems[prodId] = { product: prod, qty: 0 };
  posDraftItems[prodId].qty += delta;
  if (posDraftItems[prodId].qty <= 0) delete posDraftItems[prodId];
  renderPosDraftList();
}

function renderPosDraftList() {
  const entries = Object.values(posDraftItems);
  const total = entries.reduce((s, e) => s + e.qty * e.product.price, 0);
  document.getElementById('posDraftTotal').textContent = 'S/ ' + total.toFixed(2);

  if (entries.length === 0) {
    document.getElementById('posDraftList').innerHTML = `<div style="color:var(--muted);font-size:12px;padding:20px 0;text-align:center">Selecciona productos de la lista izquierda.</div>`;
    return;
  }

  document.getElementById('posDraftList').innerHTML = entries.map(e => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dashed var(--border);font-size:12.5px">
      <div>
        <strong>${e.qty}x</strong> ${e.product.name}
        <div style="color:var(--muted)">S/ ${(e.qty * e.product.price).toFixed(2)}</div>
      </div>
      <div style="display:flex;gap:4px">
        <button class="btn btn-sm" onclick="addPosDraftItem(${e.product.id}, -1)">−</button>
        <button class="btn btn-sm" onclick="addPosDraftItem(${e.product.id}, 1)">+</button>
      </div>
    </div>
  `).join('');
}

async function submitPosManualOrder() {
  const entries = Object.values(posDraftItems);
  if (entries.length === 0) return;

  await fetch('/api/pos/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: posDraftChannel,
      tableId: posDraftTableId,
      customerName: document.getElementById('posCustomerName').value.trim(),
      items: entries.map(e => ({ productId: e.product.id, qty: e.qty, comment: '' }))
    })
  });
  closeModal('posOrderModal');
  if (posDraftChannel !== 'mesa') setZoneFilter('external');
  await loadState();
}

async function removeOrderItem(orderId, itemId, itemName) {
  const reason = prompt(`Motivo de anulación para "${itemName}" (quedará registrado en Auditoría):`, 'Solicitud del cliente');
  if (reason === null) return;
  await fetch('/api/pos/remove-item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, itemId, reason })
  });
  await loadState();
}

// ============================================================================
// 6. COBRO Y FACTURACIÓN ELECTRÓNICA (BOLETA BA01, FACTURA FA01, NOTA NV01)
// ============================================================================
function selectTableAndOpenCheckout(tableId) {
  selectedTableId = tableId;
  const ord = state.orders.find(o => o.tableId === tableId && o.status === 'open');
  if (ord) openCheckoutModal(ord.id);
}

function openCheckoutModal(orderId) {
  const order = state.orders.find(o => o.id === orderId);
  if (!order) return;
  checkoutOrderId = orderId;

  const table = state.tables.find(t => t.id === order.tableId);

  // Obtener datos grabados automáticamente desde el QR del cliente (en la orden o en la mesa)
  const savedVoucherType = order.billingVoucherType || (table && table.billVoucherKey) || '';
  const savedDocNumber = order.billingDocNumber || (table && table.billDocNumber) || '';
  const savedClientName = order.billingClientName || (table && table.billClientName) || '';
  const savedClientAddress = order.billingClientAddress || (table && table.billClientAddress) || '';
  const savedPayMethod = order.billingPaymentMethod || (table && table.billPaymentMethod) || '';

  const docInput = document.getElementById('checkoutDocNumber');
  const nameInput = document.getElementById('checkoutClientName');
  const addrInput = document.getElementById('checkoutClientAddress');
  const paySelect = document.getElementById('checkoutPayMethod');
  const autoBanner = document.getElementById('checkoutAutoFillBanner');

  if (savedDocNumber) {
    docInput.value = savedDocNumber;
  } else {
    docInput.value = '11111111';
  }

  if (savedClientName) {
    nameInput.value = savedClientName;
  } else if (order.customerName && !order.customerName.startsWith('Cliente')) {
    nameInput.value = order.customerName;
  } else {
    nameInput.value = savedDocNumber ? '' : 'CLIENTES VARIOS';
  }

  addrInput.value = savedClientAddress || '-';

  if (savedPayMethod) {
    paySelect.value = savedPayMethod;
  } else {
    paySelect.value = 'Efectivo';
  }

  if (savedVoucherType === 'factura' || savedDocNumber.length === 11 || (table && table.billTypeRequested && table.billTypeRequested.toLowerCase().includes('factura'))) {
    selectVoucherType('factura', true);
  } else if (savedVoucherType === 'notaVenta') {
    selectVoucherType('notaVenta', true);
  } else {
    selectVoucherType('boleta', true);
  }

  if (autoBanner) {
    if (savedDocNumber || savedVoucherType || (table && table.billRequested)) {
      autoBanner.style.display = 'block';
      autoBanner.innerHTML = `✨ <strong>Datos pre-cargados automáticamente desde el QR de ${order.tableName}:</strong> ${checkoutVoucherType === 'factura' ? 'Factura Electrónica' : (checkoutVoucherType === 'notaVenta' ? 'Nota de Venta' : 'Boleta Electrónica')}${savedDocNumber ? ` • Doc: <strong>${savedDocNumber}</strong>` : ''}${savedClientName ? ` (${savedClientName})` : ''}`;
    } else {
      autoBanner.style.display = 'none';
    }
  }

  document.getElementById('checkoutDiscount').value = '0';
  document.getElementById('checkoutOrderSummary').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:15px;font-weight:800">${order.tableName} — Comanda #${order.code}</div>
        <div style="font-size:12px;color:#166534">${order.items.length} producto(s) • Se cerrarán automáticamente las comandas de cocina</div>
      </div>
      <div style="font-size:20px;font-weight:800;color:#052e16">S/ ${Number(order.total).toFixed(2)}</div>
    </div>
  `;

  document.getElementById('checkoutModal').classList.add('open');

  // Si el cliente puso su DNI o RUC pero aún no tenía nombre resuelto, consultamos automáticamente en vivo
  if ((savedDocNumber.length === 8 || savedDocNumber.length === 11) && (!nameInput.value || nameInput.value === 'CLIENTES VARIOS')) {
    lookupDniRucLive();
  }
}

function selectVoucherType(vType, preservePreFilled = false) {
  checkoutVoucherType = vType;
  ['boleta', 'factura', 'notaVenta'].forEach(t => {
    document.getElementById('vTypeBtn-' + t).classList.toggle('btn-primary', t === vType);
  });
  const docInput = document.getElementById('checkoutDocNumber');
  const nameInput = document.getElementById('checkoutClientName');
  if (vType === 'factura') {
    docInput.placeholder = 'Ingrese RUC de 11 dígitos (Obligatorio)';
    if (!preservePreFilled && docInput.value === '11111111') {
      docInput.value = '';
      nameInput.value = '';
    }
  } else {
    docInput.placeholder = '11111111 (Clientes Varios) o ingrese DNI';
    if (!preservePreFilled && !docInput.value) {
      docInput.value = '11111111';
      nameInput.value = 'CLIENTES VARIOS';
    }
  }
}

async function lookupDniRucLive() {
  const num = document.getElementById('checkoutDocNumber').value.trim();
  if (!num || num === '11111111') {
    alert('Ingresa un número de DNI (8 dígitos) o RUC (11 dígitos) para consultar en vivo en facturaloconlwp.com.');
    return;
  }
  const btn = document.getElementById('btnLookupDoc');
  btn.disabled = true;
  btn.textContent = 'Consultando...';

  try {
    const res = await fetch('/api/fe/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docType: num.length === 11 ? 'ruc' : 'dni',
        number: num
      })
    });
    const data = await res.json();
    if (data.ok && data.name) {
      document.getElementById('checkoutClientName').value = data.name;
      document.getElementById('checkoutClientAddress').value = data.address || '-';
      if (num.length === 11) selectVoucherType('factura');
    } else {
      alert(data.error || 'No se encontraron datos para ese documento.');
    }
  } catch (e) {
    alert('Error al consultar servicio RENIEC/SUNAT.');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Consultar SUNAT/RENIEC';
  }
}

async function confirmCheckoutSale() {
  const btn = document.getElementById('btnConfirmCheckout');
  btn.disabled = true;
  btn.textContent = 'Emitiendo comprobante...';

  try {
    const res = await fetch('/api/pos/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: checkoutOrderId,
        voucherType: checkoutVoucherType,
        paymentMethod: document.getElementById('checkoutPayMethod').value,
        clientDocNumber: document.getElementById('checkoutDocNumber').value.trim(),
        clientName: document.getElementById('checkoutClientName').value.trim(),
        clientAddress: document.getElementById('checkoutClientAddress').value.trim(),
        discount: parseFloat(document.getElementById('checkoutDiscount').value || '0')
      })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      alert(data.error || 'Error al emitir comprobante');
    } else {
      closeModal('checkoutModal');
      await loadState();
      showVoucherReceiptModal(data.voucher);
    }
  } catch (e) {
    alert('Error de red al procesar el cobro.');
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Registrar Pago y Emitir Comprobante';
  }
}

function showVoucherReceiptModal(v) {
  const c = state.company;
  const content = document.getElementById('receiptTicketContent');
  content.innerHTML = `
    <div style="border:1px solid #cbd5e1;border-radius:12px;padding:18px;font-family:'Courier New',monospace;font-size:12.5px;background:#fff;color:#000">
      <div style="text-align:center;border-bottom:1px dashed #000;padding-bottom:10px;margin-bottom:10px">
        <div style="font-weight:800;font-size:15px">${c.name}</div>
        <div>RUC: ${c.ruc}</div>
        <div style="font-size:11px">${c.address}</div>
        <div>Tel: ${c.phone}</div>
        <div style="margin-top:8px;font-weight:800;font-size:14px">${v.voucherLabel}</div>
        <div style="font-weight:800;font-size:15px">${v.fullNumber}</div>
      </div>

      <div style="margin-bottom:10px;line-height:1.4">
        <div><strong>FECHA:</strong> ${v.issuedAt}</div>
        <div><strong>CLIENTE:</strong> ${v.clientName}</div>
        <div><strong>DOC:</strong> ${v.clientDocNumber}</div>
        <div><strong>DIRECCIÓN:</strong> ${v.clientAddress}</div>
        <div><strong>MESA/ORIGEN:</strong> ${v.tableName} (Pedido #${v.orderCode})</div>
        <div><strong>FORMA PAGO:</strong> ${v.paymentMethod}</div>
      </div>

      <table style="width:100%;border-collapse:collapse;border-top:1px dashed #000;border-bottom:1px dashed #000;margin-bottom:10px">
        <thead>
          <tr style="border-bottom:1px dashed #000;text-align:left">
            <th style="padding:4px 0">CANT</th>
            <th>DESCRIPCIÓN</th>
            <th style="text-align:right">IMPORTE</th>
          </tr>
        </thead>
        <tbody>
          ${(v.items || []).map(it => `
            <tr>
              <td style="padding:3px 0">${it.qty}</td>
              <td>${it.name}</td>
              <td style="text-align:right">S/ ${Number(it.subtotal).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div style="text-align:right;line-height:1.5;margin-bottom:10px">
        <div>OP. EXONERADAS: S/ ${Number(v.totalExoneradas).toFixed(2)}</div>
        <div>OP. GRAVADAS: S/ ${Number(v.totalGravadas).toFixed(2)}</div>
        <div>IGV (18%): S/ ${Number(v.igv).toFixed(2)}</div>
        ${Number(v.discount) > 0 ? `<div>DESCUENTO: -S/ ${Number(v.discount).toFixed(2)}</div>` : ''}
        <div style="font-size:15px;font-weight:800">IMPORTE TOTAL: S/ ${Number(v.total).toFixed(2)}</div>
      </div>

      <div style="text-align:center;font-size:11px;border-top:1px dashed #000;padding-top:10px">
        <div>BIENES TRANSFERIDOS EN LA AMAZONÍA PARA SER CONSUMIDOS EN LA MISMA</div>
        <div style="margin-top:4px;font-weight:700">Estado FE: ${v.feStatus}</div>
        <div style="margin-top:6px">Representación impresa del Comprobante Electrónico • facturaloconlwp.com</div>
      </div>
    </div>

    <details style="margin-top:12px;font-size:12px" class="no-print">
      <summary style="cursor:pointer;font-weight:700;color:var(--primary)">
        Ver JSON Estandarizado para facturaloconlwp.com/api/comprobante
      </summary>
      <pre style="background:#0f172a;color:#86efac;padding:10px;border-radius:8px;overflow-x:auto;margin-top:6px;font-size:11px;max-height:180px">${JSON.stringify(v.fePayload, null, 2)}</pre>
    </details>

    <div style="display:flex;gap:10px;margin-top:14px" class="no-print">
      <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="window.print()">🖨️ Imprimir Ticket 80mm</button>
      <button class="btn" onclick="closeModal('voucherReceiptModal')">Cerrar</button>
    </div>
  `;
  document.getElementById('voucherReceiptModal').classList.add('open');
}

function printPreAccount(orderId) {
  const o = state.orders.find(ord => ord.id === orderId);
  if (!o) return;
  showVoucherReceiptModal({
    voucherLabel: 'PRE-CUENTA DE MESA (NO VÁLIDO COMO CPE)',
    fullNumber: 'PEDIDO #' + o.code,
    issuedAt: o.updatedAt || o.createdAt,
    clientName: o.customerName,
    clientDocNumber: '-',
    clientAddress: '-',
    tableName: o.tableName,
    orderCode: o.code,
    paymentMethod: 'Por Cobrar',
    totalExoneradas: o.total,
    totalGravadas: 0,
    igv: 0,
    discount: 0,
    total: o.total,
    items: o.items,
    feStatus: 'Pre-cuenta informativa',
    fePayload: { nota: 'Pre-cuenta antes de emisión de comprobante' }
  });
}

function renderFacturacionView() {
  if (!state) return;
  const vouchers = state.vouchers || [];
  const totalDay = vouchers.reduce((s, v) => s + Number(v.total || 0), 0);

  document.getElementById('cashboxSummary').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card">
        <div>
          <div class="kpi-label">Total Recaudado en Caja</div>
          <div class="kpi-val" style="color:var(--primary)">S/ ${totalDay.toFixed(2)}</div>
          <div class="kpi-sub">${vouchers.length} comprobantes emitidos</div>
        </div>
        <div class="kpi-icon" style="background:#dcfce7;color:#15803d">💵</div>
      </div>
      <div class="kpi-card">
        <div>
          <div class="kpi-label">Serie Boletas Electrónicas</div>
          <div class="kpi-val">${state.series.boleta.serie}-${String(state.series.boleta.correlativo).padStart(6, '0')}</div>
          <div class="kpi-sub">Conector LWP Activo</div>
        </div>
        <div class="kpi-icon" style="background:#e0f2fe;color:#0369a1">🧾</div>
      </div>
      <div class="kpi-card">
        <div>
          <div class="kpi-label">Serie Facturas Electrónicas</div>
          <div class="kpi-val">${state.series.factura.serie}-${String(state.series.factura.correlativo).padStart(6, '0')}</div>
          <div class="kpi-sub">Consulta RUC SUNAT en vivo</div>
        </div>
        <div class="kpi-icon" style="background:#fef3c7;color:#b45309">🏢</div>
      </div>
      <div class="kpi-card">
        <div>
          <div class="kpi-label">Ítems Anulados Hoy</div>
          <div class="kpi-val">${(state.deletedItemsLog || []).length}</div>
          <div class="kpi-sub">Auditoría controlada</div>
        </div>
        <div class="kpi-icon" style="background:#fee2e2;color:#b91c1c">🛡️</div>
      </div>
    </div>
  `;

  if (vouchers.length === 0) {
    document.getElementById('vouchersTableWrap').innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted)">Aún no se han emitido comprobantes en este turno. Cobra una mesa desde la vista Salón para generar Boletas o Facturas.</div>`;
  } else {
    document.getElementById('vouchersTableWrap').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Comprobante</th>
            <th>Tipo</th>
            <th>Fecha / Hora</th>
            <th>Mesa</th>
            <th>Cliente (DNI/RUC)</th>
            <th>Pago</th>
            <th>Total</th>
            <th>Estado FE (LWP)</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>
          ${vouchers.map((v, idx) => `
            <tr>
              <td style="font-weight:800">${v.fullNumber}</td>
              <td>${v.voucherLabel}</td>
              <td>${v.issuedAt}</td>
              <td>${v.tableName}</td>
              <td>${v.clientName} (${v.clientDocNumber})</td>
              <td>${v.paymentMethod}</td>
              <td style="font-weight:800">S/ ${Number(v.total).toFixed(2)}</td>
              <td><span class="mini-badge" style="background:#dcfce7;color:#15803d">${v.feStatus}</span></td>
              <td>
                <button class="btn btn-sm" onclick="showVoucherByIndex(${idx})">🖨️ Ver Ticket / JSON</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  const delLogs = state.deletedItemsLog || [];
  if (delLogs.length === 0) {
    document.getElementById('deletedLogWrap').innerHTML = `<div style="padding:16px;text-align:center;color:var(--muted)">No hay anulaciones registradas.</div>`;
  } else {
    document.getElementById('deletedLogWrap').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Fecha Eliminado</th>
            <th>Pedido</th>
            <th>Mesa</th>
            <th>Producto</th>
            <th>Cant.</th>
            <th>Total</th>
            <th>Motivo</th>
          </tr>
        </thead>
        <tbody>
          ${delLogs.map(d => `
            <tr>
              <td>${d.deletedAt}</td>
              <td>#${d.orderCode}</td>
              <td>${d.tableName}</td>
              <td style="font-weight:700">${d.productName}</td>
              <td>${d.qty}</td>
              <td>S/ ${Number(d.total).toFixed(2)}</td>
              <td>${d.reason}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}

function showVoucherByIndex(idx) {
  const v = state.vouchers[idx];
  if (v) showVoucherReceiptModal(v);
}

// ============================================================================
// 7. GESTIÓN DE CARTA Y PRECIOS (162 PRODUCTOS DE JACKFRUIT)
// ============================================================================
function populateAdminCategoryFilter() {
  if (!state) return;
  const cats = [...new Set(state.products.map(p => p.category))].sort();
  const sel = document.getElementById('adminProdCatFilter');
  sel.innerHTML = `<option value="ALL">Todas las Categorías (${cats.length})</option>` +
    cats.map(c => `<option value="${c}">${c}</option>`).join('');
}

function renderAdminProducts() {
  if (!state) return;
  const q = (document.getElementById('adminProdSearch').value || '').toLowerCase().trim();
  const cat = document.getElementById('adminProdCatFilter').value;

  const list = state.products.filter(p => {
    if (cat !== 'ALL' && p.category !== cat) return false;
    if (q && !p.name.toLowerCase().includes(q) && !p.category.toLowerCase().includes(q)) return false;
    return true;
  });

  document.getElementById('adminProductsTableWrap').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Producto / Plato</th>
          <th>Categoría</th>
          <th>Estación de Comanda (KDS)</th>
          <th>Precio (S/)</th>
          <th>Visible en QR</th>
          <th>Guardar</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(p => `
          <tr>
            <td>#${p.id}</td>
            <td style="font-weight:700">${p.name}</td>
            <td><span class="mini-badge" style="background:#f1f5f9">${p.category}</span></td>
            <td>
              <select id="st-${p.id}" class="form-input" style="padding:4px 8px;font-size:12px;width:auto">
                <option value="heladeria" ${p.station === 'heladeria' ? 'selected' : ''}>🍨 Heladería & Barra Fría</option>
                <option value="cocina" ${p.station === 'cocina' ? 'selected' : ''}>🍳 Cocina Principal</option>
                <option value="barra" ${p.station === 'barra' ? 'selected' : ''}>🍹 Barra & Tienda</option>
              </select>
            </td>
            <td>
              <input type="number" id="pr-${p.id}" class="form-input" style="width:95px;padding:4px 8px;font-weight:800" value="${Number(p.price).toFixed(2)}" step="0.5" />
            </td>
            <td>
              <input type="checkbox" id="ac-${p.id}" ${p.active ? 'checked' : ''} onchange="saveAdminProductRow(${p.id})" />
              <span style="font-size:12px">${p.active ? 'Activo' : 'Agotado'}</span>
            </td>
            <td>
              <button class="btn btn-sm btn-primary" onclick="saveAdminProductRow(${p.id})">Guardar</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function saveAdminProductRow(prodId) {
  const price = parseFloat(document.getElementById('pr-' + prodId).value || '0');
  const station = document.getElementById('st-' + prodId).value;
  const active = document.getElementById('ac-' + prodId).checked;

  await fetch('/api/admin/product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', id: prodId, price, station, active })
  });
  await loadState();
}

function openNewProductModal() {
  document.getElementById('newProdName').value = '';
  document.getElementById('newProdCat').value = 'HELADOS';
  document.getElementById('newProdPrice').value = '';
  document.getElementById('newProductModal').classList.add('open');
}

async function createNewProduct() {
  const name = document.getElementById('newProdName').value.trim();
  const category = document.getElementById('newProdCat').value.trim() || 'GENERAL';
  const station = document.getElementById('newProdStation').value;
  const price = parseFloat(document.getElementById('newProdPrice').value || '0');
  if (!name || price <= 0) {
    alert('Completa el nombre y un precio válido.');
    return;
  }
  await fetch('/api/admin/product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', name, category, station, price })
  });
  closeModal('newProductModal');
  await loadState();
  populateAdminCategoryFilter();
}

function openSettingsModal() {
  if (state && state.company) {
    document.getElementById('cfgFeToken').value = state.company.feToken || '';
    document.getElementById('cfgSalesGoal').value = state.company.salesGoal || 1800;
    document.getElementById('cfgLeyAmazonia').checked = !!state.company.leyAmazonia;
  }
  document.getElementById('settingsModal').classList.add('open');
}

async function saveFeConfig() {
  await fetch('/api/admin/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      feToken: document.getElementById('cfgFeToken').value.trim(),
      salesGoal: parseFloat(document.getElementById('cfgSalesGoal').value || '1800'),
      leyAmazonia: document.getElementById('cfgLeyAmazonia').checked
    })
  });
  closeModal('settingsModal');
  await loadState();
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

async function clearAllOrdersNow() {
  if (!confirm('¿Deseas limpiar todas las comandas de prueba de las mesas y dejar las 28 mesas libres? (El historial de ventas y comprobantes se conservará intacto).')) return;
  try {
    await fetch('/api/admin/reset-demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    await loadState();
  } catch (e) {}
}

// ============================================================================
// 8. CONTROL DE ACCESO POR PERFILES (ADMIN, CAJERO, COCINA, MOZO) Y VENTAS (DÍA/MES/AÑO)
// ============================================================================
function getPeruTodayStr() {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  return d.toISOString().substring(0, 10);
}

function initAuthAndReportsDefaults() {
  const today = getPeruTodayStr();
  const dateInp = document.getElementById('repDateInput');
  const monthInp = document.getElementById('repMonthInput');
  const yearInp = document.getElementById('repYearInput');
  if (dateInp && !dateInp.value) dateInp.value = today;
  if (monthInp && !monthInp.value) monthInp.value = today.substring(0, 7);
  if (yearInp) yearInp.value = today.substring(0, 4);

  try {
    const saved = sessionStorage.getItem('jackfruit_staff_user');
    if (saved) {
      currentUser = JSON.parse(saved);
      applyRolePermissions();
    } else {
      openLoginModal();
    }
  } catch (e) {
    openLoginModal();
  }
}

function openLoginModal() {
  const errBox = document.getElementById('loginErrorBox');
  if (errBox) errBox.style.display = 'none';
  const passInp = document.getElementById('loginPasswordInput');
  if (passInp) passInp.value = '';
  const modal = document.getElementById('loginScreenOverlay');
  if (modal) modal.classList.add('open');
}

async function submitStaffLogin() {
  const username = (document.getElementById('loginUsernameInput').value || '').trim();
  const password = (document.getElementById('loginPasswordInput').value || '').trim();
  const errBox = document.getElementById('loginErrorBox');
  if (!username || !password) {
    errBox.textContent = 'Ingresa tu usuario y contraseña.';
    errBox.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      errBox.textContent = data.error || 'Usuario o contraseña incorrectos.';
      errBox.style.display = 'block';
      return;
    }
    currentUser = data.user;
    sessionStorage.setItem('jackfruit_staff_user', JSON.stringify(currentUser));
    document.getElementById('loginScreenOverlay').classList.remove('open');
    applyRolePermissions();
  } catch (e) {
    errBox.textContent = 'Error de conexión al validar credenciales.';
    errBox.style.display = 'block';
  }
}

function applyRolePermissions() {
  if (!currentUser) return;
  const role = currentUser.role;
  const badge = document.getElementById('activeUserBadge');
  if (badge) {
    badge.textContent = `${currentUser.roleLabel || currentUser.role} (${currentUser.username})`;
  }

  const navMap = {
    admin: ['salon', 'kds', 'simulador', 'qrs', 'facturacion', 'carta', 'reportes'],
    cajero: ['salon', 'kds', 'simulador', 'qrs', 'facturacion'],
    cocina: ['kds'],
    mozo: ['salon', 'kds', 'qrs']
  };
  const allowed = navMap[role] || navMap.mozo;

  ['salon', 'kds', 'simulador', 'qrs', 'facturacion', 'carta', 'reportes'].forEach(v => {
    const btn = document.getElementById('nav-' + v);
    if (btn) btn.style.display = allowed.includes(v) ? 'flex' : 'none';
  });

  const btnSettings = document.getElementById('btnSettingsTop');
  const btnClear = document.getElementById('btnClearOrdersTop');
  if (btnSettings) btnSettings.style.display = role === 'admin' ? 'inline-flex' : 'none';
  if (btnClear) btnClear.style.display = (role === 'admin' || role === 'cajero') ? 'inline-flex' : 'none';

  if (!allowed.includes(currentView)) {
    switchView(allowed[0]);
  } else {
    renderAll();
  }
}

function setReportPeriodMode(mode) {
  reportPeriodMode = mode;
  ['day', 'month', 'year'].forEach(m => {
    const btn = document.getElementById('repModeBtn-' + m);
    if (btn) btn.classList.toggle('btn-primary', m === mode);
  });
  document.getElementById('repFilterDayWrap').style.display = mode === 'day' ? 'flex' : 'none';
  document.getElementById('repFilterMonthWrap').style.display = mode === 'month' ? 'flex' : 'none';
  document.getElementById('repFilterYearWrap').style.display = mode === 'year' ? 'flex' : 'none';
  renderAdminReportsView();
}

function getFilteredVouchersForReport() {
  if (!state || !state.vouchers) return { vouchers: [], label: '' };
  const today = getPeruTodayStr();
  const selDay = (document.getElementById('repDateInput')?.value || today).trim();
  const selMonth = (document.getElementById('repMonthInput')?.value || today.substring(0, 7)).trim();
  const selYear = (document.getElementById('repYearInput')?.value || today.substring(0, 4)).trim();

  if (reportPeriodMode === 'day') {
    return {
      vouchers: state.vouchers.filter(v => String(v.issuedAt || '').startsWith(selDay)),
      label: `Día ${selDay}`,
      key: selDay
    };
  } else if (reportPeriodMode === 'month') {
    return {
      vouchers: state.vouchers.filter(v => String(v.issuedAt || '').startsWith(selMonth)),
      label: `Mes ${selMonth}`,
      key: selMonth
    };
  } else {
    return {
      vouchers: state.vouchers.filter(v => String(v.issuedAt || '').startsWith(selYear)),
      label: `Año ${selYear} (Consolidado Anual 365 Días)`,
      key: selYear
    };
  }
}

function renderAdminReportsView() {
  if (!state) return;
  const { vouchers, label, key } = getFilteredVouchersForReport();

  let totalSales = 0;
  let totalBoletas = 0;
  let totalFacturas = 0;
  let totalNotas = 0;
  let countBoletas = 0;
  let countFacturas = 0;
  let countNotas = 0;

  const byPay = {
    'Efectivo': 0,
    'Yape / Plin': 0,
    'Tarjeta POS': 0,
    'Transferencia': 0
  };
  const prodMap = {};

  vouchers.forEach(v => {
    const amt = Number(v.total || 0);
    totalSales += amt;
    if (v.voucherType === 'factura') {
      totalFacturas += amt;
      countFacturas++;
    } else if (v.voucherType === 'notaVenta') {
      totalNotas += amt;
      countNotas++;
    } else {
      totalBoletas += amt;
      countBoletas++;
    }
    const pm = v.paymentMethod || 'Efectivo';
    byPay[pm] = (byPay[pm] || 0) + amt;

    (v.items || []).forEach(it => {
      const pName = it.name || 'Producto';
      if (!prodMap[pName]) prodMap[pName] = { name: pName, qty: 0, subtotal: 0 };
      prodMap[pName].qty += Number(it.qty || 0);
      prodMap[pName].subtotal += Number(it.subtotal || 0);
    });
  });

  // Si estamos consultando un día o mes que tiene Cierres Guardados en salesArchives y no hay vouchers sueltos, sumar desde salesArchives
  const archives = state.salesArchives || [];

  document.getElementById('reportKpisContainer').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card">
        <div>
          <div class="kpi-label">Venta Total (${label})</div>
          <div class="kpi-val" style="color:var(--primary)">S/ ${totalSales.toFixed(2)}</div>
          <div class="kpi-sub">${vouchers.length} comprobante(s) en el periodo</div>
        </div>
        <div class="kpi-icon" style="background:#dcfce7;color:#15803d">💰</div>
      </div>
      <div class="kpi-card">
        <div>
          <div class="kpi-label">Boletas Electrónicas (BA01)</div>
          <div class="kpi-val">S/ ${totalBoletas.toFixed(2)}</div>
          <div class="kpi-sub">${countBoletas} boleta(s) emitida(s)</div>
        </div>
        <div class="kpi-icon" style="background:#e0f2fe;color:#0369a1">🧾</div>
      </div>
      <div class="kpi-card">
        <div>
          <div class="kpi-label">Facturas Electrónicas (FA01)</div>
          <div class="kpi-val">S/ ${totalFacturas.toFixed(2)}</div>
          <div class="kpi-sub">${countFacturas} factura(s) con RUC</div>
        </div>
        <div class="kpi-icon" style="background:#fef3c7;color:#b45309">🏢</div>
      </div>
      <div class="kpi-card">
        <div>
          <div class="kpi-label">Notas de Venta (NV01)</div>
          <div class="kpi-val">S/ ${totalNotas.toFixed(2)}</div>
          <div class="kpi-sub">${countNotas} nota(s) interna(s)</div>
        </div>
        <div class="kpi-icon" style="background:#f3e8ff;color:#7e22ce">📝</div>
      </div>
    </div>
  `;

  // Desglose por Método de Pago
  document.getElementById('reportPayBreakdownWrap').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Método de Pago</th>
          <th>Importe Acumulado</th>
          <th>% del Total</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(byPay).map(([pm, val]) => {
          const pct = totalSales > 0 ? ((val / totalSales) * 100).toFixed(1) : '0.0';
          return `
            <tr>
              <td style="font-weight:700">${pm}</td>
              <td style="font-weight:800;color:#052e16">S/ ${Number(val).toFixed(2)}</td>
              <td><span class="mini-badge" style="background:#dcfce7;color:#15803d">${pct}%</span></td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  // Top productos vendidos
  const topProds = Object.values(prodMap).sort((a, b) => b.subtotal - a.subtotal);
  if (topProds.length === 0) {
    document.getElementById('reportTopProductsWrap').innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted)">Sin platos vendidos en este periodo aún.</div>`;
  } else {
    document.getElementById('reportTopProductsWrap').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Plato / Producto</th>
            <th>Unidades</th>
            <th>Total Vendido</th>
          </tr>
        </thead>
        <tbody>
          ${topProds.slice(0, 15).map(p => `
            <tr>
              <td style="font-weight:700">${p.name}</td>
              <td><strong>${p.qty}</strong> und.</td>
              <td style="font-weight:800">S/ ${Number(p.subtotal).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // Tabla principal según el modo (Día, Mes o Año)
  const titleEl = document.getElementById('reportMainTableTitle');
  const wrapEl = document.getElementById('reportMainTableWrap');

  if (reportPeriodMode === 'year') {
    titleEl.textContent = `🗓️ Consolidado Mensual del ${label} (12 Meses)`;
    const monthNames = [
      '01 - Enero', '02 - Febrero', '03 - Marzo', '04 - Abril',
      '05 - Mayo', '06 - Junio', '07 - Julio', '08 - Agosto',
      '09 - Septiembre', '10 - Octubre', '11 - Noviembre', '12 - Diciembre'
    ];
    const rows = monthNames.map((mLabel, idx) => {
      const mPrefix = `${key}-${String(idx + 1).padStart(2, '0')}`;
      const mVouchers = vouchers.filter(v => String(v.issuedAt || '').startsWith(mPrefix));
      const mTotal = mVouchers.reduce((s, v) => s + Number(v.total || 0), 0);
      const mBol = mVouchers.filter(v => v.voucherType === 'boleta').reduce((s, v) => s + Number(v.total || 0), 0);
      const mFac = mVouchers.filter(v => v.voucherType === 'factura').reduce((s, v) => s + Number(v.total || 0), 0);
      const mNot = mVouchers.filter(v => v.voucherType === 'notaVenta').reduce((s, v) => s + Number(v.total || 0), 0);
      return `
        <tr>
          <td style="font-weight:800">${mLabel} (${key})</td>
          <td>${mVouchers.length} ventas</td>
          <td>S/ ${mBol.toFixed(2)}</td>
          <td>S/ ${mFac.toFixed(2)}</td>
          <td>S/ ${mNot.toFixed(2)}</td>
          <td style="font-weight:800;color:#052e16">S/ ${mTotal.toFixed(2)}</td>
        </tr>
      `;
    }).join('');

    wrapEl.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Mes del Año</th>
            <th>Comprobantes</th>
            <th>Boletas (BA01)</th>
            <th>Facturas (FA01)</th>
            <th>Notas Venta (NV01)</th>
            <th>Total del Mes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } else {
    titleEl.textContent = `🧾 Detalle de Ventas Emitidas — ${label}`;
    if (vouchers.length === 0) {
      wrapEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--muted)">No hay ventas registradas para <strong>${label}</strong>. Cuando emitas una Boleta, Factura o Nota de Venta desde Salón, aparecerá detallada aquí automáticamente.</div>`;
    } else {
      wrapEl.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>Fecha y Hora</th>
              <th>Comprobante</th>
              <th>Mesa / Origen</th>
              <th>Cliente (DNI / RUC)</th>
              <th>Detalle de Productos Vendidos</th>
              <th>Pago</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            ${vouchers.map(v => {
              const itemsText = (v.items || []).map(i => `${i.qty}x ${i.name}`).join(', ');
              return `
                <tr>
                  <td>${v.issuedAt}</td>
                  <td style="font-weight:800">${v.fullNumber}<div style="font-size:10px;color:var(--muted)">${v.voucherLabel}</div></td>
                  <td>${v.tableName}</td>
                  <td><strong>${v.clientName}</strong><div style="font-size:11px;color:var(--muted)">Doc: ${v.clientDocNumber}</div></td>
                  <td style="font-size:12px;max-width:290px">${itemsText}</td>
                  <td><span class="mini-badge" style="background:#f1f5f9">${v.paymentMethod}</span></td>
                  <td style="font-weight:800;color:#052e16">S/ ${Number(v.total).toFixed(2)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    }
  }

  // Historial de Cierres Diarios Guardados (Retención 365 Días)
  const archWrap = document.getElementById('reportSavedArchivesWrap');
  if (archives.length === 0) {
    archWrap.innerHTML = `<div style="padding:18px;text-align:center;color:var(--muted)">Aún no hay cierres diarios archivados. Se guardan automáticamente al emitir ventas o pulsando el botón <strong>"💾 Guardar Cierre del Día en Historial Anual"</strong>.</div>`;
  } else {
    archWrap.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Fecha de Cierre</th>
            <th>Hora Guardado</th>
            <th>Comprobantes</th>
            <th>Boletas</th>
            <th>Facturas</th>
            <th>Notas Venta</th>
            <th>Total del Día</th>
            <th>Responsable / Nota</th>
          </tr>
        </thead>
        <tbody>
          ${archives.map(a => `
            <tr>
              <td style="font-weight:800">${a.date}</td>
              <td>${a.savedAt}</td>
              <td>${a.voucherCount} ventas</td>
              <td>S/ ${Number(a.totalBoletas || 0).toFixed(2)} (${a.countBoletas || 0})</td>
              <td>S/ ${Number(a.totalFacturas || 0).toFixed(2)} (${a.countFacturas || 0})</td>
              <td>S/ ${Number(a.totalNotas || 0).toFixed(2)} (${a.countNotas || 0})</td>
              <td style="font-weight:800;color:#052e16;font-size:14px">S/ ${Number(a.totalSales || 0).toFixed(2)}</td>
              <td style="font-size:12px">${a.closedBy || 'Admin'}${a.notes ? ` — <em>${a.notes}</em>` : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  renderAdminUsersTable();
}

async function saveDailySalesArchive() {
  const targetDate = (document.getElementById('repDateInput')?.value || getPeruTodayStr()).trim();
  const notes = (document.getElementById('repArchiveNotes')?.value || '').trim();
  const closedBy = currentUser ? `${currentUser.name} (${currentUser.username})` : 'Administrador';

  const res = await fetch('/api/admin/archive-day', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: targetDate, closedBy, notes })
  });
  const data = await res.json();
  if (data.ok) {
    if (document.getElementById('repArchiveNotes')) document.getElementById('repArchiveNotes').value = '';
    await loadState();
    alert(`✅ Cierre del día ${targetDate} guardado exitosamente en el Historial Anual (Total: S/ ${Number(data.archive.totalSales || 0).toFixed(2)}). Se conservará durante 1 año (365 días).`);
  }
}

function exportSalesReportCsv() {
  const { vouchers, label, key } = getFilteredVouchersForReport();
  if (vouchers.length === 0) {
    alert(`No hay ventas registradas en ${label} para exportar.`);
    return;
  }

  const lines = [
    ['Fecha_Hora', 'Comprobante', 'Tipo', 'Mesa_Origen', 'Doc_Cliente', 'Nombre_Razon_Social', 'Metodo_Pago', 'Productos', 'Total_Soles'].join(';')
  ];

  vouchers.forEach(v => {
    const itemsStr = (v.items || []).map(i => `${i.qty}x ${i.name}`).join(' | ').replace(/;/g, ',');
    lines.push([
      v.issuedAt,
      v.fullNumber,
      v.voucherLabel,
      v.tableName,
      v.clientDocNumber,
      String(v.clientName || '').replace(/;/g, ','),
      v.paymentMethod,
      itemsStr,
      Number(v.total || 0).toFixed(2)
    ].join(';'));
  });

  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Reporte_Ventas_Jackfruit_${key}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function renderAdminUsersTable() {
  const wrap = document.getElementById('adminUsersTableWrap');
  if (!wrap || !state) return;
  const users = state.users || [];

  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Usuario (Login)</th>
          <th>Nombre Completo</th>
          <th>Perfil / Nivel de Acceso</th>
          <th>Acciones</th>
        </tr>
      </thead>
      <tbody>
        ${users.map(u => `
          <tr>
            <td>#${u.id}</td>
            <td style="font-weight:800">${u.username}</td>
            <td>${u.name}</td>
            <td><span class="mini-badge" style="background:#dcfce7;color:#15803d">${u.roleLabel || u.role}</span></td>
            <td>
              <div style="display:flex;gap:6px">
                <button class="btn btn-sm" onclick="changeStaffUserPassword(${u.id}, '${u.username}')">🔑 Cambiar Clave</button>
                ${u.username !== 'admin' ? `
                  <button class="btn btn-sm" style="color:var(--danger)" onclick="deleteStaffUser(${u.id}, '${u.username}')">🗑 Eliminar</button>
                ` : ''}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function createStaffUser() {
  const name = (document.getElementById('newUsrName').value || '').trim();
  const username = (document.getElementById('newUsrLogin').value || '').trim().toLowerCase();
  const password = (document.getElementById('newUsrPass').value || '').trim();
  const role = document.getElementById('newUsrRole').value;

  if (!name || !username || !password) {
    alert('Completa el nombre, usuario y contraseña para crear el perfil.');
    return;
  }

  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create', name, username, password, role })
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    alert(data.error || 'Error al crear usuario.');
    return;
  }

  document.getElementById('newUsrName').value = '';
  document.getElementById('newUsrLogin').value = '';
  document.getElementById('newUsrPass').value = '';
  await loadState();
}

async function changeStaffUserPassword(id, username) {
  const newPass = prompt(`Ingresa la nueva contraseña para el usuario "${username}":`);
  if (!newPass || !newPass.trim()) return;
  await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update', id, password: newPass.trim() })
  });
  alert(`✅ Contraseña de "${username}" actualizada correctamente.`);
  await loadState();
}

async function deleteStaffUser(id, username) {
  if (!confirm(`¿Seguro que deseas eliminar al usuario "${username}"?`)) return;
  await fetch('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete', id })
  });
  await loadState();
}

initAuthAndReportsDefaults();
loadState();
setInterval(pollChanges, 1000);
