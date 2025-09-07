// ================== IMPORTS BÁSICOS ==================
import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

// Ruta base (Railway: STORAGE_DIR=/data)
const PATH = process.env.STORAGE_DIR || '.';

// ================== BD JSON (lowdb) + CENSO OFICIAL ==================
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';


const MAX_RESIDENTS_PER_FLAT = 2;
const db = new Low(new JSONFile(`${PATH}/db.json`), {});

// ---------- Censo oficial (128) ----------
function buildCensus() {
  const flats = {};
  const add = (p, plantaLabel, puertas) => {
    for (const pu of puertas) {
      const key = `${p}-${plantaLabel}-${pu}`;
      flats[key] = {
        portal: p,
        planta: plantaLabel, // 'BAJO' | 1..6
        puerta: pu,
        cap: MAX_RESIDENTS_PER_FLAT,
        ocupacion: 0,
        habilitada: true
      };
    }
  };
  const range = (a,b) => Array.from({length:b-a+1}, (_,i)=>a+i);

  // Portal 1 (17)
  for (const pl of range(1,5)) add(1, pl, ['A','B','C']);
  add(1, 6, ['A','B']);

  // Portal 2 (20)
  add(2, 'BAJO', ['A','B','C']);
  for (const pl of range(1,5)) add(2, pl, ['A','B','C']);
  add(2, 6, ['A','B']);

  // Portal 3 (27)
  add(3, 'BAJO', ['A','B','C','D']);
  for (const pl of range(1,5)) add(3, pl, ['A','B','C','D']);
  add(3, 6, ['A','B','C']);

  // Portal 4 (27)
  add(4, 'BAJO', ['A','B','C','D']);
  for (const pl of range(1,5)) add(4, pl, ['A','B','C','D']);
  add(4, 6, ['A','B','C']);

  // Portal 5 (17)
  for (const pl of range(1,5)) add(5, pl, ['A','B','C']);
  add(5, 6, ['A','B']);

  // Portal 6 (20)
  add(6, 'BAJO', ['A','B','C']);
  for (const pl of range(1,5)) add(6, pl, ['A','B','C']);
  add(6, 6, ['A','B']);

  return flats;
}

async function initDB() {
  await db.read();

  if (!db.data) db.data = {};
  if (!db.data.flats) db.data.flats = {};
  if (!db.data.residents) db.data.residents = {};

  const target = buildCensus();

  // Sincroniza censo
  for (const [k, v] of Object.entries(target)) {
    if (!db.data.flats[k]) {
      db.data.flats[k] = { ...v, ocupacion: db.data.flats[k]?.ocupacion ?? 0 };
    } else {
      db.data.flats[k].portal = v.portal;
      db.data.flats[k].planta = v.planta;
      db.data.flats[k].puerta = v.puerta;
      db.data.flats[k].cap = MAX_RESIDENTS_PER_FLAT;
      db.data.flats[k].habilitada = true;
      db.data.flats[k].ocupacion = db.data.flats[k].ocupacion ?? 0;
    }
  }
  for (const k of Object.keys(db.data.flats)) {
    if (!target[k]) db.data.flats[k].habilitada = false;
  }

  await db.write();
  const total = Object.values(db.data.flats).filter(f => f.habilitada).length;
  console.log(`🔢 Censo cargado. Viviendas habilitadas: ${total}`);
}

function makeKey(portal, plantaLabel, puerta){ return `${portal}-${plantaLabel}-${puerta}`; }

async function getResidentFlat(waId){
  await db.read();
  const r = db.data.residents[waId];
  if (!r) return null;
  return db.data.flats[r.flatKey] || null;
}

async function assignResident(waId, name, portal, plantaLabel, puerta){
  await db.read();
  const key = makeKey(portal, plantaLabel, puerta);
  const flat = db.data.flats[key];
  if (!flat) return { ok:false, reason:'NO_EXISTE' };
  if (!flat.habilitada) return { ok:false, reason:'NO_HABILITADA' };
  if (flat.ocupacion >= flat.cap) return { ok:false, reason:'LLENO' };

  // liberar piso anterior si tenía
  const prev = db.data.residents[waId];
  if (prev?.flatKey && db.data.flats[prev.flatKey]) {
    db.data.flats[prev.flatKey].ocupacion = Math.max(0, db.data.flats[prev.flatKey].ocupacion - 1);
  }

  db.data.residents[waId] = { name, flatKey: key };
  flat.ocupacion++;
  await db.write();
  return { ok:true, flat };
}

async function removeResident(waId){
  await db.read();
  const prev = db.data.residents[waId];
  if (prev?.flatKey && db.data.flats[prev.flatKey]) {
    db.data.flats[prev.flatKey].ocupacion = Math.max(0, db.data.flats[prev.flatKey].ocupacion - 1);
  }
  delete db.data.residents[waId];
  await db.write();
}

// ---------- Parser tolerante ----------
function parseFlat(input) {
  const t = (input || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toUpperCase()
    .replace(/\s+/g,' ')
    .trim();

  const portalM =
    t.match(/^P(?:ORTAL)?\s*(\d)\b/) ||
    t.match(/\bPORTAL\s*(\d)\b/) ||
    t.match(/^\s*(\d)\b/);
  if (!portalM) return { ok:false };
  const portal = parseInt(portalM[1],10);
  if (!(portal >=1 && portal <=6)) return { ok:false };

  const rest = t.replace(portalM[0], '').trim();

  let plantaLabel = null, puerta = null, m;

  m = rest.match(/\b(BAJO|PB|0)\b[ ,\-]*([A-D])\b/);
  if (m) {
    plantaLabel = 'BAJO';
    puerta = m[2];
  } else {
    m = rest.match(/\b(\d)\s*[ºO]?\s*([A-D])\b/);
    if (m) {
      plantaLabel = parseInt(m[1],10);
      puerta = m[2];
    }
  }

  if (!plantaLabel || !puerta) return { ok:false };
  return { ok:true, portal, plantaLabel, puerta };
}

// Detecta intentos de vivienda aunque sean inválidos (para decir "no existe")
function tryExtractAnyFlat(raw) {
  const t = (raw || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toUpperCase()
    .replace(/\s+/g,' ')
    .trim();

  const pM = t.match(/(?:^|[\s,])P(?:ORTAL)?\s*(\d)\b/) || t.match(/^(\d)\b/);
  if (!pM) return null;
  const portal = parseInt(pM[1],10);

  const rest = t.replace(pM[0], '').trim();

  let plantaLabel = null, puertaAny = null, m;
  m = rest.match(/\b(BAJO|PB|0)\b[ ,\-]*([A-Z])\b/);
  if (m) { plantaLabel = 'BAJO'; puertaAny = m[2]; }
  else {
    m = rest.match(/\b(\d)\s*[ºO]?\s*([A-Z])\b/);
    if (m) { plantaLabel = parseInt(m[1],10); puertaAny = m[2]; }
  }
  if (!plantaLabel || !puertaAny) return null;
  return { portal, plantaLabel, puertaAny };
}

// ================== VERIFICACIÓN EN GRUPO ==================
const VERIFICATION_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const KICK_AFTER_BAJA_MS = 60 * 60 * 1000;     // 1 hora después de BAJA
// clave: `${groupId}:${waId}` -> { state, startedAt, timeoutId }
const groupSessions = new Map();

// Seguimiento de miembros de la comunidad para limitar quién puede hablar por privado
const communityMembers = new Set(); // waId de quienes están (o estuvieron) en el grupo

// Grupos donde corre la verificación (los iremos detectando en group_join)
const communityGroupIds = new Set();

function privateHelpMessage(isResident) {
  if (isResident) {
    return (
      '👋 Hola. Ya estás registrado en la *Comunidad ATENEA*.\n' +
      'Puedes usar:\n' +
      '• MI_PISO → ver tu vivienda\n' +
      '• BAJA → borrar tu registro (te expulsaremos del grupo en 1h)\n' +
      '• ALTA PORTAL PLANTA PUERTA + "Tu Nombre" → cambiar registro\n' +
      'Ejemplos: ALTA P2 2D Juan Pérez | ALTA P3 BAJO C Ana López'
    );
  }
  return (
    '👋 Hola. Soy el bot de la *Comunidad ATENEA*.\n' +
    'La verificación se realiza *en el grupo* tras entrar por enlace y ser aprobado.\n' +
    'Si ya entraste y el bot te habló en el grupo, contesta allí.\n\n' +
    'Cuando estés verificado podrás usar en privado:\n' +
    '• MI_PISO | BAJA | ALTA PORTAL PLANTA PUERTA + Tu Nombre'
  );
}

// Helpers de sí/no
function normalizeYesNo(text='') {
  const t = text.toLowerCase().trim();
  const yes = ['si','sí','s','yes','y','claro','por supuesto'];
  const no  = ['no','n','nope','nop'];
  if (yes.includes(t) || t.startsWith('si') || t.startsWith('sí') || t.includes('residente') || t.includes('propietario')) return 'yes';
  if (no.includes(t) || t.startsWith('no ') || t.includes('no soy') || t.includes('no tengo')) return 'no';
  return 'unknown';
}

// --- Helpers para IDs / menciones seguras ---
function toWid(id) {
  if (!id) return null;
  if (typeof id === 'string') return id;
  if (id._serialized) return id._serialized;
  if (id.id && id.id._serialized) return id.id._serialized;
  if (id.user) return `${id.user}@c.us`;
  return null;
}
function mentionOpts(id) {
  const wid = toWid(id);
  if (!wid || !/@c\.us$/.test(wid)) return {};
  return { mentions: [wid] };
}
// Envío seguro a grupo (evita msg.reply en grupos y normaliza la mención)
async function safeSendGroup(groupId, text, maybeIdForMention) {
  try {
    const opts = mentionOpts(maybeIdForMention); // {} si no es un @c.us válido
    await client.sendMessage(groupId, text, opts);
  } catch (e) {
    console.error('safeSendGroup error:', e.message || e);
  }
}

// Nombre “significativo” (evita ".", "-", etc.)
function isMeaningfulName(name) {
  const t = (name || '').trim();
  if (t.length < 2) return false;
  // Debe tener al menos una letra o número
  return /[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/.test(t);
}

// Devuelve el "mejor" nombre visible del usuario (sin números)
async function resolveDisplayName(waId, groupId = null) {
  const id = toWid(waId);
  if (!id) return '';

  try {
    const c = await client.getContactById(id);
    const pick = c?.pushname || c?.verifiedName || c?.name || null;
    if (isMeaningfulName(pick)) return pick.trim();
  } catch {}

  try {
    if (groupId) {
      const g = await client.getChatById(groupId);
      if (g?.isGroup && Array.isArray(g.participants)) {
        const p = g.participants.find(p => toWid(p?.id) === id);
        const notify = p?.notifyName || p?.name || null;
        if (isMeaningfulName(notify)) return (notify || '').trim();
      }
    }
  } catch {}

  return ''; // si no hay nombre usable, devolvemos vacío (usaremos fallback “vecino/a”)
}

// Expulsión compatible con versiones antiguas y nuevas
async function removeFromGroup(groupId, waId) {
  try {
    // Preferir método en GroupChat si existe
    const chat = await client.getChatById(groupId);
    if (chat && chat.isGroup && typeof chat.removeParticipants === 'function') {
      await chat.removeParticipants([toWid(waId)]);
      return true;
    }
    // Fallback a API nueva si está disponible
    if (typeof client.groupParticipantsUpdate === 'function') {
      await client.groupParticipantsUpdate(groupId, [toWid(waId)], 'remove');
      return true;
    }
  } catch (e) {
    console.error('kick error:', e.message || e);
  }
  return false;
}

// Expulsión diferida 1h tras BAJA (de todos los grupos comunidad)
function scheduleKickAfterBaja(waId) {
  setTimeout(async () => {
    try {
      for (const gid of communityGroupIds) {
        await removeFromGroup(gid, waId);
      }
      communityMembers.delete(toWid(waId)); // ya no podrá hablar por privado
    } catch (e) {
      console.error('deferred kick error:', e.message || e);
    }
  }, KICK_AFTER_BAJA_MS);
}

// Arranca verificación en grupo
async function startGroupVerification(groupId, waId) {
  const key = `${groupId}:${waId}`;
  const prev = groupSessions.get(key);
  if (prev?.timeoutId) clearTimeout(prev.timeoutId);

  // Marca que este usuario pertenece a la comunidad (para poder hablar por privado)
  communityMembers.add(toWid(waId));

  const display = await resolveDisplayName(waId, groupId);
  await safeSendGroup(
    groupId,
    `👋 Bienvenido/a *${display || 'vecino/a'}*.\n` +
    `Soy el 🤖 bot de *Insur Atenea*. Esta comunidad es de uso exclusivo para los vecinos. ¿Eres propietario o residente de la comunidad *INSUR ATENEA*? Por favor, responde *Sí* o *No*, gracias.`,
    waId
  );

  const timeoutId = setTimeout(async () => {
    const s = groupSessions.get(key);
    if (s && s.state !== 'VERIFIED' && s.state !== 'TERMINATED') {
      try {
        const disp = await resolveDisplayName(waId, groupId);
        await safeSendGroup(
          groupId,
          `⏰ *${disp || 'Este usuario'}* no completó la verificación a tiempo (1h). Será retirado del grupo.`,
          waId
        );
        await removeFromGroup(groupId, waId);
      } catch (e) {
        console.error('remove timeout error:', e.message || e);
      }
      groupSessions.delete(key);
      communityMembers.delete(toWid(waId));
    }
  }, VERIFICATION_WINDOW_MS);

  groupSessions.set(key, { state: 'ASK_YESNO', startedAt: Date.now(), timeoutId });
}

// ================== CLIENTE WHATSAPP ==================
let lastQR = null;
let qrTimer = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: `${PATH}/.wwebjs_auth` }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-extensions','--no-zygote']
  },
  webVersionCache: { type: 'none' },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 0,
  authTimeoutMs: 120000
});

client.on('qr', (qr) => {
  if (qr === lastQR) return;
  lastQR = qr;
  clearTimeout(qrTimer);
  qrTimer = setTimeout(() => {
    console.clear();
    console.log('[QR] Escanea con el teléfono PRINCIPAL:');
    qrcode.generate(qr, { small: true });
    console.log('\n(El QR caduca en ~20-30s; si sale otro, escanea el último).');
  }, 150);
});

client.on('authenticated', () => console.log('[authenticated] Sesión aceptada.'));
client.on('auth_failure', (m) => console.error('[auth_failure]', m || ''));
client.on('remote_session_saved', () => console.log('[remote_session_saved] Sesión guardada en disco.'));
client.on('loading_screen', (p, m) => console.log(`[loading_screen] ${p}% - ${m}`));
client.on('change_state', (state) => console.log('[change_state]', state));
client.once('ready', () => console.log('✅ BOT CONECTADO Y LISTO.'));
client.on('disconnected', (reason) => { console.error('[disconnected]', reason); setTimeout(() => client.initialize(), 3000); });

// Al aprobar/entrar alguien por enlace → dispara verificación EN GRUPO
client.on('group_join', async (notification) => {
  try {
    const chat = await notification.getChat();
    if (!chat.isGroup) return;

    // 👉 registra este grupo como “comunidad”
    communityGroupIds.add(chat.id._serialized);

    const rawJoined = (notification.recipientIds && notification.recipientIds.length
      ? notification.recipientIds
      : (notification.id?.participant ? [notification.id.participant] : [])
    ) || [];

    const joined = rawJoined.map(j => toWid(j)).filter(Boolean);

    for (const waId of joined) {
      await startGroupVerification(chat.id._serialized, waId);
    }
  } catch (e) {
    console.error('group_join error:', e.message || e);
  }
});

// ================== HANDLER DE MENSAJES ==================
client.on('message', async (msg) => {
  const raw  = (msg.body || '').trim();
  const text = raw.toLowerCase();
  const chat = await msg.getChat();

  // ---------- PRIVADOS: solo si está en el grupo (o ya residente) ----------
  if (!chat.isGroup) {
    const isMember = communityMembers.has(toWid(msg.from));  // solo si pasó por el grupo
    const residentFlat = await getResidentFlat(msg.from);
    const isResident = !!residentFlat;

    if (!isMember && !isResident) {
      // Ignorar a desconocidos fuera del grupo
      return;
    }

    // Comandos a residentes
    if ((/^mi_piso$/i.test(raw) || /^mi\s+piso$/i.test(raw)) && isResident) {
      return msg.reply(`El piso que tienes registrado es: Portal ${residentFlat.portal}, Planta ${residentFlat.planta}, Puerta ${residentFlat.puerta}.`);
    }

    if (/^baja$/i.test(raw) && isResident) {
      await removeResident(msg.from);
      // Programa la expulsión de todos los grupos de comunidad dentro de 1 hora
      scheduleKickAfterBaja(msg.from);
      return msg.reply('Has sido dado de baja del censo. Serás retirado del grupo en 1 hora.');
    }

    if (/^alta\s+/i.test(raw) && isResident) {
      let m = raw.match(/^ALTA\s+P?(\d)\s+(\d)\s*([A-Da-d])\s+(.{2,})$/i);
      if (!m) m = raw.match(/^ALTA\s+P?(\d)\s+(BAJO|PB|0)\s*([A-Da-d])\s+(.{2,})$/i);
      if (!m) return msg.reply('Formato: ALTA PORTAL PLANTA PUERTA + Tu Nombre. Ej: ALTA P2 2D Juan Pérez');

      const portal = parseInt(m[1],10);
      const plantaLabel = (m[2].toUpperCase?.() ?? '').match(/^(BAJO|PB|0)$/i) ? 'BAJO' : parseInt(m[2],10);
      const puerta = m[3].toUpperCase();
      const name   = m[4].trim();

      const res = await assignResident(msg.from, name, portal, plantaLabel, puerta);
      if (!res.ok) {
        if (res.reason === 'NO_EXISTE')     return msg.reply('Esa vivienda no existe en el censo.');
        if (res.reason === 'NO_HABILITADA') return msg.reply('Esa vivienda todavía no está habilitada.');
        if (res.reason === 'LLENO')         return msg.reply('⚠️ Ese piso ya alcanzó el máximo de 2 personas.');
        return msg.reply('No he podido registrar la vivienda (error desconocido).');
      }
      const f = res.flat;
      return msg.reply(`✅ Registrado: ${name} → Portal ${f.portal}, Planta ${f.planta}, Puerta ${f.puerta}.`);
    }

    // Respuesta de ayuda para quien sí puede hablar por privado
    return msg.reply(privateHelpMessage(isResident));
  }

  // ---------- GRUPOS: solo responder si hay sesión de verificación ----------
  const groupId = chat.id._serialized;
  const waId = toWid(msg.author) || ''; // autor real en grupos
  if (!waId) return;

  const key = `${groupId}:${waId}`;
  const sess = groupSessions.get(key);

  // Si no hay verificación en curso, NO respondemos en grupo
  if (!sess) return;

  // 1) Paso sí/no
  if (sess.state === 'ASK_YESNO') {
    const yn = normalizeYesNo(raw);
    if (yn === 'yes') {
      groupSessions.set(key, { ...sess, state: 'ASK_FLAT' });
      const display = await resolveDisplayName(waId, groupId);
      return safeSendGroup(
        groupId,
        `Genial, *${display || 'vecino/a'}* ✅\n` +
        `Por favor, indica ahora tu *vivienda* en una línea: Portal, Planta+Puerta y tu *nombre*.\n` +
        `Ejemplos:\n` +
        `• P2 2D Juan Pérez\n` +
        `• P3 BAJO C Ana López`,
        waId
      );
    } else if (yn === 'no') {
      if (sess.timeoutId) clearTimeout(sess.timeoutId);
      const display = await resolveDisplayName(waId, groupId);
      try {
        await safeSendGroup(groupId, `Gracias, *${display || 'usuario'}*. Este grupo es solo para la comunidad. Disculpa las molestias, pero serás retirado.`, waId);
        await removeFromGroup(groupId, waId);
      } catch (e) {
        console.error('remove no error:', e.message || e);
      }
      groupSessions.delete(key);
      communityMembers.delete(toWid(waId));
      return;
    } else {
      const display = await resolveDisplayName(waId, groupId);
      return safeSendGroup(groupId, `Por favor, responde *Sí* o *No*, *${display || 'vecino/a'}*.`, waId);
    }
  }

  // 2) Paso vivienda
  if (sess.state === 'ASK_FLAT') {
    // intentos ALTA directos también válidos
    let m = raw.match(/^ALTA\s+P?(\d)\s+(\d)\s*([A-Da-d])\s+(.{2,})$/i);
    let portal, plantaLabel, puerta, name;

    if (m) {
      portal = parseInt(m[1],10);
      plantaLabel = parseInt(m[2],10);
      puerta = m[3].toUpperCase();
      name   = m[4].trim();
    } else {
      m = raw.match(/^ALTA\s+P?(\d)\s+(BAJO|PB|0)\s*([A-Da-d])\s+(.{2,})$/i);
      if (m) {
        portal = parseInt(m[1],10);
        plantaLabel = 'BAJO';
        puerta = m[3].toUpperCase();
        name   = m[4].trim();
      } else {
        // formato libre: "P2 2D Juan Pérez"
        const p = parseFlat(raw);
        if (!p.ok) {
          const any = tryExtractAnyFlat(raw);
          const display = await resolveDisplayName(waId, groupId);
          if (any) {
            if (!['A','B','C','D'].includes(any.puertaAny)) {
              return safeSendGroup(groupId, `Esa vivienda no existe en el censo (puerta no válida), *${display || 'vecino/a'}*.`, waId);
            }
            const keyFlat = makeKey(any.portal, any.plantaLabel, any.puertaAny);
            await db.read();
            const exists = !!db.data?.flats?.[keyFlat] && db.data.flats[keyFlat].habilitada;
            if (!exists) {
              return safeSendGroup(groupId, `Esa vivienda no existe en el censo, *${display || 'vecino/a'}*.`, waId);
            }
            return safeSendGroup(
              groupId,
              `Vivienda válida detectada, falta tu *nombre*.\n` +
              (any.plantaLabel === 'BAJO'
                ? `Envía: ALTA P${any.portal} BAJO ${any.puertaAny} Tu Nombre`
                : `Envía: ALTA P${any.portal} ${any.plantaLabel}${any.puertaAny} Tu Nombre`),
              waId
            );
          }
          return safeSendGroup(
            groupId,
            `No entendí la vivienda, *${display || 'vecino/a'}*.\n` +
            `Ejemplos:\n• P2 2D Juan Pérez\n• P3 BAJO C Ana López`,
            waId
          );
        }
        // tenemos portal/planta/puerta pero quizá sin nombre → intenta extraer nombre “lo que sobra”
        const withoutPP = raw.replace(/P(?:ORTAL)?\s*\d/i,'').trim();
        name = withoutPP.replace(/[0-6]\s*[ºo]?\s*[A-Da-d]|(BAJO|PB|0)\s*[A-Da-d]/i,'').trim();
        portal = p.portal;
        plantaLabel = p.plantaLabel;
        puerta = p.puerta.toUpperCase();
        if (!name || name.length < 2) {
          const display = await resolveDisplayName(waId, groupId);
          return safeSendGroup(
            groupId,
            `Me falta tu *nombre*, *${display || 'vecino/a'}*.\n` +
            (plantaLabel === 'BAJO'
              ? `Envía: ALTA P${portal} BAJO ${puerta} Tu Nombre`
              : `Envía: ALTA P${portal} ${plantaLabel}${puerta} Tu Nombre`),
            waId
          );
        }
      }
    }

    // validar y asignar
    const res = await assignResident(waId, name, portal, plantaLabel, puerta);
    if (!res.ok) {
      const display = await resolveDisplayName(waId, groupId);
      if (res.reason === 'NO_EXISTE')     return safeSendGroup(groupId, `Esa vivienda no existe en el censo, *${display || 'vecino/a'}*.`, waId);
      if (res.reason === 'NO_HABILITADA') return safeSendGroup(groupId, `Esa vivienda todavía no está habilitada, *${display || 'vecino/a'}*.`, waId);
      if (res.reason === 'LLENO')         return safeSendGroup(groupId, `⚠️ Ese piso ya alcanzó el máximo de 2 personas, *${display || 'vecino/a'}*.`, waId);
      return safeSendGroup(groupId, 'No he podido registrar la vivienda (error desconocido).', waId);
    }

    // ok → anuncia y cierra sesión
    const f = res.flat;
    if (sess.timeoutId) clearTimeout(sess.timeoutId);
    const displayOk = await resolveDisplayName(waId, groupId);
    await safeSendGroup(
      groupId,
      `✅ *${displayOk || 'Vecino/a'}* verificado/a y dado/a de alta.\n` +
      `Vivienda: Portal ${f.portal}, Planta ${f.planta}, Puerta ${f.puerta}. *¡Bienvenido/a a la comunidad de INSUR ATENEA!*`,
      waId
    );
    groupSessions.delete(key);
    return;
  }

  // Cualquier otro estado: no responder
});

// ================== ARRANQUE ==================
(async () => {
  await initDB();
  client.initialize();
})();

