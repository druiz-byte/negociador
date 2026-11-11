/* NegoLab (multiempresa) — front-end
   La web es la misma para todas las empresas: al entrar con el código de
   grupo, el servidor devuelve la empresa (logo, colores, textos) y sus casos.
   Sin dependencias externas. Todo el estado vive en el navegador;
   las fichas confidenciales de la simulación nunca llegan hasta aquí. */

/* Si el sitio y el servidor viven juntos (Render), NEGOCIADOR_API queda vacío
   y las llamadas van al mismo origen. Si están separados (GitHub Pages +
   Cloudflare), aquí va la URL del worker. */
const API = (window.NEGOCIADOR_API || '').replace(/\/+$/, '');

const estado = {
  // Grupo con el que se ha entrado: { codigo, nombreGrupo, abierto, empresa }.
  acceso: null,
  casos: [],
  filtro: 'todos',
  caso: null,
  rolId: null,
  // El perfil conductual ya no se elige en la web (ver 04-despliegue-web.md /
  // bitácora): la simulación juega siempre "rojo · impulsor".
  // En el caso Tecnobit la configuración la fija el servidor (contraparte,
  // dureza 3): todos negocian igual y al terminar reciben el feedback del
  // evaluador independiente. Ver configFija en negociador-api/src/casos.js.
  config: { modo: 'contraparte', dureza: 3, color: 'rojo' },
  briefing: null,
  mensajes: [],
  ocupado: false,
  terminada: false,
  // Identifican a qué caso y rol pertenece la negociación en curso (estado.mensajes),
  // para no reanudar por error una sesión de un caso/rol distinto al recién elegido.
  sesionCasoId: null,
  sesionRolId: null,
  avatar: { activo: false, cliente: null, silenciado: false, reconexiones: 0 },
  // Firma del historial que devuelve el servidor tras cada intervención de la
  // simulación (ver negociador-api/src/firma.js). Sin ella no se puede puntuar.
  firma: null,
  // Competición: si el servidor la tiene activa, si esta negociación puntúa,
  // y si la negociación en curso se empezó compitiendo.
  competicion: { disponible: false, reglas: null, puntua: true },
  sesionCompite: false,
  evaluando: false,
};

const $ = (s, raiz = document) => raiz.querySelector(s);
const $$ = (s, raiz = document) => Array.from(raiz.querySelectorAll(s));

/* ─────────── Markdown mínimo ─────────── */

function escapar(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function enLinea(t) {
  return escapar(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function md(texto) {
  const lineas = (texto || '').split('\n');
  const salida = [];
  let i = 0;
  let enLista = null;

  const cerrarLista = () => {
    if (enLista) { salida.push(`</${enLista}>`); enLista = null; }
  };

  while (i < lineas.length) {
    const l = lineas[i];

    // Tabla
    if (/^\s*\|/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lineas[i + 1] || '')) {
      cerrarLista();
      const celdas = (fila) =>
        fila.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const cab = celdas(l);
      i += 2;
      let html = '<table><thead><tr>' + cab.map((c) => `<th>${enLinea(c)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lineas.length && /^\s*\|/.test(lineas[i])) {
        html += '<tr>' + celdas(lineas[i]).map((c) => `<td>${enLinea(c)}</td>`).join('') + '</tr>';
        i++;
      }
      salida.push(html + '</tbody></table>');
      continue;
    }

    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      cerrarLista();
      const n = Math.min(m[1].length + 1, 4);
      salida.push(`<h${n}>${enLinea(m[2])}</h${n}>`);
    } else if ((m = l.match(/^\s*[-*]\s+(.*)$/))) {
      if (enLista !== 'ul') { cerrarLista(); salida.push('<ul>'); enLista = 'ul'; }
      salida.push(`<li>${enLinea(m[1])}</li>`);
    } else if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (enLista !== 'ol') { cerrarLista(); salida.push('<ol>'); enLista = 'ol'; }
      salida.push(`<li>${enLinea(m[1])}</li>`);
    } else if ((m = l.match(/^>\s?(.*)$/))) {
      cerrarLista();
      salida.push(`<blockquote>${enLinea(m[1])}</blockquote>`);
    } else if (l.trim() === '') {
      cerrarLista();
    } else {
      cerrarLista();
      salida.push(`<p>${enLinea(l)}</p>`);
    }
    i++;
  }
  cerrarLista();
  return salida.join('\n');
}

/* ─────────── Navegación ─────────── */

const VISTAS_VALIDAS = [
  'acceso', 'inicio', 'casos', 'configurar', 'briefing', 'sala', 'preparacion', 'marco',
  'competicion', 'profesor', 'aviso-legal', 'privacidad', 'cookies',
];
// Vistas que se pueden abrir directamente con un enlace (negolab.es/#privacidad):
// las que no dependen de haber elegido antes un caso.
const VISTAS_DIRECTAS = ['inicio', 'casos', 'preparacion', 'marco', 'competicion', 'profesor', 'aviso-legal', 'privacidad', 'cookies'];
// Vistas que se pueden ver sin haber entrado con un código de grupo.
const VISTAS_SIN_ACCESO = ['acceso', 'profesor', 'aviso-legal', 'privacidad', 'cookies'];

/* Cada vista queda registrada en el historial del navegador (con
   history.pushState) para que la flecha "atrás" del navegador vuelva a la
   vista anterior de la propia web (p. ej. de la sala al briefing) en vez de
   sacar al usuario de la página o dejarle una pantalla en blanco. */
function ir(vista, opciones = {}) {
  const { registrarHistorial = true } = opciones;
  if (!VISTAS_VALIDAS.includes(vista)) vista = 'inicio';
  if (!estado.acceso && !VISTAS_SIN_ACCESO.includes(vista)) vista = 'acceso';
  if (estado.acceso && vista === 'acceso') vista = 'inicio';

  const activaAntes = $('.vista.activa');
  const veniaDeSala = activaAntes && activaAntes.id === 'vista-sala';
  $$('.vista').forEach((v) => v.classList.toggle('activa', v.id === `vista-${vista}`));
  $$('nav.principal button').forEach((b) =>
    b.setAttribute('aria-current', String(b.dataset.ir === vista))
  );
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (vista === 'preparacion') { montarTablasPreparacion(); actualizarNotaPrep(); }
  if (vista === 'competicion') pintarCompeticion();
  if (vista === 'profesor') pintarProfesor();
  // El avatar cuesta por minuto conectado: si salimos de la sala por la
  // navegación superior (no por "Salir"), lo cerramos igual que allí.
  if (veniaDeSala && vista !== 'sala') pararAvatar();

  if (registrarHistorial) {
    if (history.state && history.state.vista === vista) {
      history.replaceState({ vista }, '', '#' + vista);
    } else {
      history.pushState({ vista }, '', '#' + vista);
    }
  }
  window.dispatchEvent(new CustomEvent('negociador:vista', { detail: vista }));
}

/* Al pulsar "atrás"/"adelante", el navegador nos dice a qué vista volver.
   Si esa vista necesita datos que ya no están (por ejemplo "sala" sin
   ningún caso elegido en esta carga de página), no puede reconstruirse:
   en ese caso llevamos a la biblioteca de casos en vez de a una vista rota. */
window.addEventListener('popstate', (e) => {
  let vista = (e.state && e.state.vista) || (estado.acceso ? 'inicio' : 'acceso');
  const necesitaCaso = ['configurar', 'briefing', 'sala'].includes(vista);
  const necesitaBriefing = ['briefing', 'sala'].includes(vista);
  if ((necesitaCaso && !estado.caso) || (necesitaBriefing && !estado.briefing)) {
    vista = 'casos';
  }
  ir(vista, { registrarHistorial: false });
});

function actualizarNotaPrep() {
  const nota = document.getElementById('nota-prep');
  if (!nota) return;
  nota.textContent = estado.briefing ? '' : 'Elige un caso antes de entrar en la sala.';
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ir]');
  if (b) {
    // En los enlaces (<a href="#...">) evitamos la navegación por ancla del
    // navegador, que dispararía un popstate sin estado y nos llevaría a inicio.
    if (b.tagName === 'A') e.preventDefault();
    // Si la puerta de cookies está abierta como ventana y se pide una página
    // legal, se cierra la ventana para poder leerla (sigue como barra abajo).
    ir(b.dataset.ir);
    return;
  }
  const d = e.target.closest('[data-desplazar]');
  if (d) {
    e.preventDefault();
    const destino = document.getElementById(d.dataset.desplazar);
    if (destino) destino.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

/* ─────────── Biblioteca de casos ─────────── */

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* El servidor gratuito de Render se duerme tras un rato sin visitas y tarda
   cerca de un minuto en despertar. Lanzamos un aviso nada más cargar la
   portada para que vaya arrancando mientras el usuario lee. */
function despertarServidor() {
  return fetch(`${API}/api/salud`, { cache: 'no-store' })
    .then((r) => r.json())
    .then((d) => {
      estado.competicion.disponible = Boolean(d && d.competicion);
      estado.competicion.reglas = (d && d.reglas) || null;
      actualizarDisponibilidadCompeticion();
      pintarReglas();
    })
    .catch(() => {});
}

/* ─────────── Acceso por código de grupo ───────────
   El código decide la empresa: su imagen, sus textos y sus casos. Se guarda
   en el navegador para no pedirlo cada vez; "Cambiar de grupo" lo olvida. */

const CLAVE_ACCESO = 'negociador-acceso-v1';

// Aviso mientras el servidor gratuito de Render arranca en frío (hasta un minuto).
const MENSAJE_ESPERA =
  'El negociador se está preparando. Se está leyendo y preparando la negociación; le cuesta un poco, pero solo al principio: después es implacable y no necesita tiempo extra.';

/* Empresas cuyos casos son de consulta a un experto (p. ej. «Built to
   Innovate»): no hay negociación, así que la web oculta el briefing, la hoja
   de preparación, la evaluación y los resultados, y lleva directamente a la
   conversación (ver casos-bensaou.js en el servidor). */
function esModoExperto() {
  return estado.casos.length > 0 && estado.casos.every((c) => c.experto);
}

/* ─────────── Idioma ───────────
   La web está en castellano. Una empresa puede pedir otro idioma con
   "idioma" en empresas.js (Built to Innovate: 'en'). Entonces se traducen
   los textos visibles del modo experto (tabla TEXTOS_EN) y los mensajes
   que genera app.js (función tx). Las páginas legales y el panel del
   profesor siguen en castellano. */
function idiomaWeb() {
  return (estado.acceso && estado.acceso.empresa && estado.acceso.empresa.idioma) || 'es';
}
const tx = (es, en) => (idiomaWeb() === 'en' ? en : es);

// Selector → HTML en inglés. Solo elementos visibles en el modo experto.
const TEXTOS_EN = [
  ['nav.principal [data-ir="inicio"]', 'Home'],
  ['nav.principal [data-ir="casos"] .solo-experto', 'The expert'],
  ['#vista-inicio .barra-accion.solo-experto [data-empezar-experto]', 'Start the conversation'],
  ['#vista-inicio .barra-accion.solo-experto [data-ir="casos"]', 'What you can ask'],
  ['#vista-inicio .pasos.solo-experto .paso:nth-child(1) h3', 'Ask'],
  ['#vista-inicio .pasos.solo-experto .paso:nth-child(2) h3', 'Dig deeper'],
  ['#vista-inicio .pasos.solo-experto .paso:nth-child(2) p', 'Ask for examples, follow up and tell it about your own situation: your company, your team, your industry.'],
  ['#vista-inicio .pasos.solo-experto .paso:nth-child(3) h3', 'Listen'],
  ['#vista-inicio .bloque.solo-experto h3', 'About this expert'],
  ['#vista-inicio .bloque.solo-experto p', 'An AI avatar that answers using the framework of <em>Built to Innovate</em> (Ben M. Bensaou, McGraw Hill). No case, no grade, no ranking: just a space for your questions. Like any AI, it can make mistakes, so check anything important against the book.'],
  ['#vista-casos h2 .solo-experto', 'The expert'],
  ['#vista-casos p.solo-experto', 'An open conversation: ask anything about building innovation into your organization.'],
  ['#vista-sala .dato:nth-of-type(1) span:first-child', 'Session'],
  ['#vista-sala .dato:nth-of-type(2) span:first-child', 'You'],
  ['#btn-salir', 'Leave the room'],
  ['#btn-enviar', 'Send'],
  ['#avatar-estado', 'Connecting the avatar…'],
  ['footer.principal .solo-experto:not(div.solo-experto)', 'a conversation with an expert'],
  ['footer.principal div.solo-experto', 'The expert is an AI avatar and can make mistakes.'],
  ['footer.principal [data-ir="aviso-legal"]', 'Legal notice'],
  ['footer.principal [data-ir="privacidad"]', 'Privacy'],
  ['footer.principal [data-abrir-cookies]', 'Cookie settings'],
  ['footer.principal [data-ir="profesor"]', 'Instructor access'],
];
const textosOriginales = new Map();

function aplicarIdioma(idioma) {
  document.documentElement.lang = idioma;
  TEXTOS_EN.forEach(([selector, en]) => {
    if (en === null) return;
    $$(selector).forEach((el) => {
      if (!textosOriginales.has(el)) textosOriginales.set(el, el.innerHTML);
      el.innerHTML = idioma === 'en' ? en : textosOriginales.get(el);
    });
  });
}

const MENSAJE_ESPERA_EXPERTO =
  'El experto se está preparando. Le cuesta un poco solo al principio; después responde con normalidad.';
const MENSAJE_ESPERA_EXPERTO_EN =
  'The expert is getting ready. It takes a moment only at the start; after that it answers normally.';

function leerAccesoGuardado() {
  try { return JSON.parse(localStorage.getItem(CLAVE_ACCESO)) || null; } catch { return null; }
}

async function entrarConCodigo(codigo, { intento = 1, desdeFormulario = false, vistaInicial = 'inicio' } = {}) {
  const nota = $('#nota-acceso');
  const btn = $('#btn-acceso');
  btn.disabled = true;
  nota.textContent = intento === 1 ? 'Comprobando el código…' : `${MENSAJE_ESPERA} (intento ${intento} de 3)`;
  const aviso = setTimeout(() => {
    nota.textContent = MENSAJE_ESPERA;
  }, 4000);
  try {
    const r = await fetch(`${API}/api/grupos/${encodeURIComponent(codigo)}`, { cache: 'no-store' });
    clearTimeout(aviso);
    let datos = {};
    try { datos = await r.json(); } catch {}
    if (!r.ok) {
      // Código que ya no existe (grupo borrado): se olvida y se vuelve a pedir.
      if (r.status === 404) { try { localStorage.removeItem(CLAVE_ACCESO); } catch {} }
      if (r.status >= 500 && intento < 3) { await esperar(6000); return entrarConCodigo(codigo, { intento: intento + 1, desdeFormulario, vistaInicial }); }
      nota.textContent = datos.error || 'No se ha podido comprobar el código.';
      if (!desdeFormulario) ir('acceso', { registrarHistorial: false });
      return false;
    }
    estado.acceso = {
      codigo: datos.grupo.codigo,
      nombreGrupo: datos.grupo.nombre,
      abierto: datos.grupo.abierto,
      empresa: datos.empresa,
    };
    try { localStorage.setItem(CLAVE_ACCESO, JSON.stringify({ codigo: datos.grupo.codigo })); } catch {}
    estado.casos = datos.casos || [];
    estado.filtro = 'todos';
    aplicarEmpresa(datos.empresa);
    document.body.classList.toggle('modo-experto', esModoExperto());
    aplicarIdioma(idiomaWeb());
    pintarFiltros();
    pintarCasos();
    pintarMarco();
    nota.textContent = '';
    $('#acceso-codigo').value = '';
    ir(vistaInicial);
    return true;
  } catch (err) {
    clearTimeout(aviso);
    if (intento < 3) { await esperar(6000); return entrarConCodigo(codigo, { intento: intento + 1, desdeFormulario, vistaInicial }); }
    nota.textContent = 'No se ha podido contactar con el servidor del simulador. Reinténtalo en un momento.';
    if (!desdeFormulario) ir('acceso', { registrarHistorial: false });
    return false;
  } finally {
    btn.disabled = false;
  }
}

$('#form-acceso').addEventListener('submit', (e) => {
  e.preventDefault();
  const codigo = $('#acceso-codigo').value.trim().toUpperCase();
  if (codigo.length < 4) { $('#nota-acceso').textContent = 'Escribe el código completo.'; return; }
  entrarConCodigo(codigo, { desdeFormulario: true });
});

const VARIABLES_COLOR = {
  acento: '--acento', acento2: '--acento-2', azul: '--azul', fondo: '--fondo',
  superficie: '--superficie', borde: '--borde', texto: '--texto', tenue: '--tenue',
};
const TITULO_NEUTRO = document.title;

function hexARgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* Viste la web con la imagen de la empresa. Los textos vienen de nuestro
   propio servidor (empresas.js), por eso se insertan como HTML. */
function aplicarEmpresa(empresa) {
  const raiz = document.documentElement.style;
  const colores = (empresa.marca && empresa.marca.colores) || {};
  Object.entries(VARIABLES_COLOR).forEach(([clave, variable]) => {
    if (colores[clave]) raiz.setProperty(variable, colores[clave]);
    else raiz.removeProperty(variable);
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && colores.acento) meta.setAttribute('content', colores.acento);

  const img = $('#logo-empresa');
  const texto = $('#logo-texto');
  if (empresa.marca && empresa.marca.logo) {
    // Si el fichero del logo no carga, se muestra el nombre en texto.
    img.onerror = () => {
      img.classList.add('oculto');
      texto.textContent = empresa.nombre;
      texto.classList.remove('oculto');
    };
    img.src = empresa.marca.logo;
    img.alt = empresa.marca.logoAlt || empresa.nombre;
    img.classList.remove('oculto');
    texto.classList.add('oculto');
  } else {
    img.classList.add('oculto');
    img.removeAttribute('src');
    texto.textContent = empresa.nombre;
    texto.classList.remove('oculto');
  }

  const t = empresa.textos || {};
  $$('[data-texto]').forEach((el) => { el.innerHTML = t[el.dataset.texto] || ''; });
  document.title = t.titulo || `NegoLab · ${empresa.nombre}`;
  $$('[data-empresa-pie]').forEach((el) => { el.textContent = ` · ${empresa.nombreCorto || empresa.nombre}`; });
  pintarGrupoActivo();
  document.body.classList.remove('sin-acceso');

  // PDF: misma paleta y mismo logotipo que la web.
  Object.assign(COLOR_PDF, COLOR_PDF_NEUTRO);
  const rgb = (c) => hexARgb(colores[c]);
  if (rgb('acento')) COLOR_PDF.acento = rgb('acento');
  if (rgb('fondo')) COLOR_PDF.fondo2 = rgb('fondo');
  if (rgb('superficie')) COLOR_PDF.superficie = rgb('superficie');
  if (rgb('borde')) COLOR_PDF.borde = rgb('borde');
  if (rgb('texto')) COLOR_PDF.texto = rgb('texto');
  if (rgb('tenue')) COLOR_PDF.tenue = rgb('tenue');
  marcaPdf = (empresa.nombreCorto || empresa.nombre || '').toUpperCase();
  cargarLogoPdf(empresa.marca && empresa.marca.logo);
}

function pintarGrupoActivo() {
  const caja = $('#grupo-activo');
  if (!caja) return;
  if (!estado.acceso) { caja.innerHTML = ''; return; }
  caja.innerHTML = `${tx('Grupo', 'Group')}: <strong>${escapar(estado.acceso.nombreGrupo)}</strong> (${escapar(estado.acceso.codigo)}) ·
    <button type="button" data-salir-grupo>${tx('Cambiar de grupo', 'Change group')}</button>`;
}

function salirDelGrupo() {
  if (estado.mensajes.length && !estado.terminada && !esModoExperto() &&
      !confirm('Tienes una negociación sin terminar. Si cambias de grupo se perderá. ¿Continuar?')) return;
  pararAvatar();
  try { localStorage.removeItem(CLAVE_ACCESO); } catch {}
  estado.acceso = null;
  estado.casos = [];
  estado.caso = null;
  estado.rolId = null;
  estado.briefing = null;
  estado.mensajes = [];
  estado.terminada = false;
  estado.firma = null;
  Object.values(VARIABLES_COLOR).forEach((v) => document.documentElement.style.removeProperty(v));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#2b3a55');
  $('#logo-empresa').classList.add('oculto');
  $('#logo-texto').classList.add('oculto');
  $$('[data-texto]').forEach((el) => { el.innerHTML = ''; });
  $$('[data-empresa-pie]').forEach((el) => { el.textContent = ''; });
  document.title = TITULO_NEUTRO;
  Object.assign(COLOR_PDF, COLOR_PDF_NEUTRO);
  logoPdf = null;
  marcaPdf = '';
  document.body.classList.add('sin-acceso');
  document.body.classList.remove('modo-experto');
  aplicarIdioma('es');
  pintarGrupoActivo();
  ir('acceso');
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-salir-grupo]')) { e.preventDefault(); salirDelGrupo(); }
});

/* La rúbrica y las reglas de puntuación que se publican son las del caso de
   la empresa (con un solo caso por empresa, la del primero). */
function pintarMarco() {
  const caso = estado.casos[0];
  const rubrica = (caso && caso.rubrica) || [];
  $('#marco-rubrica').innerHTML = rubrica
    .map((c) => `<tr><td><strong>${escapar(c.nombre)}</strong></td><td>${escapar(c.descriptor || '')}</td><td class="peso">${escapar(String(c.peso))} %</td></tr>`)
    .join('');
  const niveles = (caso && caso.niveles) || [];
  window.NEGOLAB_RUBRICA = { competencias: rubrica, niveles };
  $('#marco-niveles').innerHTML = niveles
    .map((n) => {
      const [cab, ...resto] = n.split(':');
      return `<tr><td><strong>${escapar(cab.replace(/^Nivel\s*/, ''))}</strong></td><td>${escapar(resto.join(':').trim())}</td></tr>`;
    })
    .join('');
  pintarReglas();
}

function pintarReglas() {
  const caso = estado.casos[0];
  const reglas = estado.competicion.reglas;
  if (!caso || !caso.configFija || !reglas || !reglas.factorDureza) return;
  const d = caso.configFija.dureza;
  const factor = reglas.factorDureza[d] || 1;
  const nombres = { 1: 'inicial', 2: 'intermedio', 3: 'avanzado', 4: 'experto' };
  const f = (n) => String(n).replace('.', ',');
  const max = Math.round((reglas.rubricaMax + reglas.resultadoMax) * factor * 10) / 10;
  $('#reglas-factor-formula').textContent = f(factor);
  $('#reglas-factor').textContent = `Nivel ${nombres[d] || d} (${d}/4), igual para todos: ×${f(factor)}`;
  $('#reglas-maximo').innerHTML = `Máximo posible: (${reglas.rubricaMax} + ${reglas.resultadoMax}) × ${f(factor)} = <strong>${f(max)} puntos</strong>.`;
}

function pintarFiltros() {
  const tipos = ['todos', ...new Set(estado.casos.map((c) => c.tipo))];
  $('#filtros').classList.toggle('oculto', estado.casos.length < 2);
  const nombre = { todos: 'Todos', comercial: 'Comercial', compras: 'Compras', proyectos: 'Proyectos' };
  $('#filtros').innerHTML = tipos
    .map((t) => `<button data-filtro="${t}" aria-pressed="${t === estado.filtro}">${nombre[t] || t}</button>`)
    .join('');
  $$('#filtros button').forEach((b) =>
    b.addEventListener('click', () => { estado.filtro = b.dataset.filtro; pintarFiltros(); pintarCasos(); })
  );
}

function pintarCasos() {
  const visibles = estado.casos.filter((c) => estado.filtro === 'todos' || c.tipo === estado.filtro);
  $('#lista-casos').innerHTML = visibles
    .map((c) => c.experto ? tarjetaExperto(c) : `
    <article class="tarjeta">
      <div class="meta">
        <span class="pastilla ${c.tipo}">${c.tipo}</span>
        <span class="pastilla">Nivel ${escapar(c.dificultad)}</span>
        <span class="pastilla">${escapar(c.duracion)}</span>
      </div>
      <h3>${escapar(c.titulo)}</h3>
      <p class="sub">${escapar(c.subtitulo || '')}</p>
      <p class="resumen">${escapar(c.resumen)}</p>
      ${c.roles.length === 1 && c.contraparte ? `<div class="vars"><strong>Tu papel:</strong> ${escapar(c.roles[0].nombre)}<br>
        <strong>Al otro lado:</strong> ${escapar(c.contraparte.nombre)}</div>` : ''}
      <div class="vars"><strong>Variables:</strong> ${c.variables.map(escapar).join(' · ')}</div>
      <button class="boton" data-caso="${c.id}">Preparar esta negociación</button>
    </article>`
    )
    .join('');
  $$('#lista-casos [data-caso]').forEach((b) =>
    b.addEventListener('click', () => abrirConfigurador(b.dataset.caso))
  );
  $$('#lista-casos [data-experto]').forEach((b) =>
    b.addEventListener('click', () => iniciarExperto(b.dataset.experto))
  );
}

function tarjetaExperto(c) {
  const experto = c.contraparte || { nombre: '', descripcion: '' };
  return `
    <article class="tarjeta">
      <div class="meta"><span class="pastilla">${tx('Experto', 'Expert')}</span><span class="pastilla">${tx('Consulta abierta', 'Open conversation')}</span></div>
      <h3>${escapar(c.titulo)}</h3>
      <p class="sub">${escapar(c.subtitulo || '')}</p>
      <p class="resumen">${escapar(c.resumen)}</p>
      <div class="vars"><strong>${tx('Con', 'With')}:</strong> ${escapar(experto.nombre)}<br><small>${escapar(experto.descripcion || '')}</small></div>
      <div class="vars"><strong>${tx('Temas', 'Topics')}:</strong> ${c.variables.map(escapar).join(' · ')}</div>
      <button class="boton" data-experto="${c.id}">${tx('Empezar la conversación', 'Start the conversation')}</button>
    </article>`;
}

/* Experto: sin configurador ni briefing. Se carga la guía de uso (el
   "briefing" del participante) y se entra directamente en la sala. Si ya
   había una conversación abierta con este experto, se retoma. */
async function iniciarExperto(casoId) {
  const caso = casoId ? estado.casos.find((c) => c.id === casoId) : estado.casos.find((c) => c.experto);
  if (!caso) return;
  if (estado.ocupado) return;
  const botones = $$('[data-experto], [data-empezar-experto]');
  botones.forEach((b) => { b.disabled = true; });
  try {
    if (!estado.briefing || estado.briefing.casoId !== caso.id) {
      const r = await fetch(`${API}/api/briefing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo: estado.acceso.codigo, casoId: caso.id, rolId: caso.roles[0].id }),
      });
      const datos = await r.json();
      if (!r.ok) throw new Error(datos.error || 'error');
      estado.briefing = datos;
    }
    estado.caso = caso;
    estado.rolId = caso.roles[0].id;
    estado.config = { ...caso.configFija };
    entrarEnLaSala();
  } catch (err) {
    alert(tx('No se ha podido abrir la conversación: ', 'Could not open the conversation: ') + (err.message || err));
  } finally {
    botones.forEach((b) => { b.disabled = false; });
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-empezar-experto]')) { e.preventDefault(); iniciarExperto(); }
});

/* ─────────── Configurador ─────────── */

function abrirConfigurador(casoId) {
  estado.caso = estado.casos.find((c) => c.id === casoId);
  estado.rolId = null;
  $('#config-titulo').textContent = estado.caso.titulo;
  $('#config-sub').textContent = estado.caso.subtitulo || '';

  // Caso con papel y configuración fijos (Tecnobit): no se elige nada; se
  // muestra la mesa tal cual y el servidor impone esa misma configuración.
  const fija = estado.caso.configFija;
  $('#bloque-modo').classList.toggle('oculto', Boolean(fija));
  $('#bloque-dureza').classList.toggle('oculto', Boolean(fija));
  if (fija) estado.config = { ...fija };
  if (estado.caso.roles.length === 1) {
    const yo = estado.caso.roles[0];
    const otro = estado.caso.contraparte || { nombre: 'La contraparte', descripcion: '' };
    estado.rolId = yo.id;
    $('#titulo-rol').textContent = 'La mesa';
    $('#opciones-rol').className = 'ficha-fija';
    $('#opciones-rol').innerHTML = `
      <div class="item"><span>Tu papel</span><strong>${escapar(yo.nombre)}</strong><small>${escapar(yo.descripcion || '')}</small></div>
      <div class="item"><span>Al otro lado</span><strong>${escapar(otro.nombre)}</strong><small>${escapar(otro.descripcion || '')}</small></div>
      <div class="item"><span>Nivel</span><strong>${escapar(NOMBRE_DUREZA_FIJA[estado.config.dureza] || String(estado.config.dureza))}</strong><small>Igual para todos los participantes.</small></div>
      <div class="item"><span>Duración</span><strong>${escapar(estado.caso.duracion || '')}</strong><small>Al terminar, un evaluador independiente te da el feedback.</small></div>`;
    $('#btn-empezar').disabled = false;
    $('#nota-config').textContent = '';
    pintarCompeticionEnConfigurador();
    ir('configurar');
    return;
  }
  $('#titulo-rol').innerHTML = 'Tu papel <small>eliges un lado; la simulación juega el otro</small>';
  $('#opciones-rol').className = 'opciones';
  $('#opciones-rol').innerHTML = estado.caso.roles
    .map(
      (r) => `<button class="opcion" data-rol="${r.id}">
        <strong>${escapar(r.nombre)}</strong><span>${escapar(r.descripcion || '')}</span></button>`
    )
    .join('');
  $$('#opciones-rol [data-rol]').forEach((b) =>
    b.addEventListener('click', () => {
      estado.rolId = b.dataset.rol;
      $$('#opciones-rol .opcion').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      $('#btn-empezar').disabled = false;
      const otro = estado.caso.roles.find((r) => r.id !== estado.rolId);
      $('#nota-config').textContent = `La simulación interpretará a ${otro.nombre}.`;
    })
  );
  $('#btn-empezar').disabled = true;
  $('#nota-config').textContent = 'Elige primero tu papel.';
  pintarCompeticionEnConfigurador();
  ir('configurar');
}

$$('.opcion[data-campo]').forEach((b) =>
  b.addEventListener('click', () => {
    const campo = b.dataset.campo;
    if (campo === 'modo' && compiteEstaNegociacion()) return; // en competición, solo contraparte
    const valor = campo === 'dureza' ? parseInt(b.dataset.valor, 10) : b.dataset.valor;
    estado.config[campo] = valor;
    $$(`.opcion[data-campo="${campo}"]`).forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
  })
);

/* ─────────── Briefing ─────────── */

$('#btn-empezar').addEventListener('click', async () => {
  const btn = $('#btn-empezar');
  btn.disabled = true;
  btn.textContent = 'Cargando…';
  try {
    const r = await fetch(`${API}/api/briefing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grupo: estado.acceso.codigo, casoId: estado.caso.id, rolId: estado.rolId }),
    });
    const datos = await r.json();
    if (!r.ok) throw new Error(datos.error || 'error');
    estado.briefing = datos;
    $('#briefing-contexto').innerHTML =
      md(datos.contexto) +
      `<p><strong>Variables en juego:</strong> ${datos.variables.map(escapar).join(' · ')}</p>`;
    $('#briefing-rol-titulo').textContent = datos.rol.nombre;
    $('#briefing-rol').innerHTML = md(datos.rol.briefing);
    guardarVariablesEnPreparacion(datos.variables);
    ir('briefing');
  } catch (err) {
    alert('No se ha podido cargar el briefing: ' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ver mi briefing';
  }
});

/* ─────────── Sala de negociación ─────────── */

const NOMBRE_COLOR = { rojo: 'Rojo', amarillo: 'Amarillo', verde: 'Verde', azul: 'Azul', oculto: 'Oculto' };
const NOMBRE_DUREZA = { 1: '1 · Colaborativo', 2: '2 · Firme', 3: '3 · Implacable', 4: '4 · Hostil' };
const NOMBRE_DUREZA_FIJA = { 1: '1/4 · Inicial', 2: '2/4 · Intermedio', 3: '3/4 · Avanzado', 4: '4/4 · Experto' };

/* ─────────── Avatar (anam.ai) ───────────
   El avatar solo pone cara y voz: quien negocia sigue siendo Claude, a
   través de /api/chat como siempre. El texto ya generado se reenvía al
   avatar con createTalkMessageStream(). Si algo falla en cualquier punto
   (sin clave en el servidor, sin red, SDK no disponible…), la sala sigue
   funcionando en modo texto sin que el participante pierda nada. */

const FUENTES_ANAM_SDK = [
  'assets/vendor/anam.umd.js',
  'https://cdn.jsdelivr.net/npm/@anam-ai/js-sdk@4.25.0/dist/umd/anam.js',
];
let promesaAnamSDK = null;

function cargarAnamSDK() {
  if (window.anam && window.anam.createClient) return Promise.resolve(window.anam);
  if (!promesaAnamSDK) {
    promesaAnamSDK = (async () => {
      let ultimo;
      for (const src of FUENTES_ANAM_SDK) {
        try {
          await cargarGuion(src);
          if (window.anam && window.anam.createClient) return window.anam;
          ultimo = new Error('el SDK de anam.ai no se ha inicializado');
        } catch (err) { ultimo = err; }
      }
      throw ultimo || new Error('no se ha podido cargar el SDK de anam.ai');
    })().catch((err) => { promesaAnamSDK = null; throw err; });
  }
  return promesaAnamSDK;
}

function mostrarEstadoAvatar(texto) {
  const caja = $('#avatar-caja');
  const nota = $('#avatar-estado');
  if (!caja || !nota) return;
  if (texto) {
    nota.textContent = texto;
    nota.classList.remove('oculto');
    caja.classList.remove('oculto');
  } else {
    nota.classList.add('oculto');
  }
}

function ocultarAvatar() {
  const caja = $('#avatar-caja');
  if (caja) caja.classList.add('oculto');
}

async function pararAvatar() {
  const av = estado.avatar;
  // Se suelta el cliente ANTES de cerrarlo: así el aviso CONNECTION_CLOSED
  // sabe que este cierre es intencionado y no intenta reconectar.
  const cliente = av.cliente;
  av.cliente = null;
  av.activo = false;
  if (cliente) {
    try { await cliente.stopStreaming(); } catch {}
  }
  ocultarAvatar();
}

/* Si anam.ai cierra la sesión por su cuenta (silencio prolongado, límite de
   duración del plan, corte de red…) y el participante sigue en la sala con
   la negociación abierta, se vuelve a conectar el avatar automáticamente.
   Con tope de reconexiones por entrada en la sala, para no gastar sesiones
   si el participante ha dejado la pestaña abierta y se ha ido. */
const MAX_RECONEXIONES_AVATAR = 3;

function sigueEnLaSala() {
  const sala = document.getElementById('vista-sala');
  return Boolean(sala && sala.classList.contains('activa'));
}

function avatarCerradoPorAnam(cliente) {
  // Cierre intencionado (pararAvatar) o de un cliente ya sustituido: nada que hacer.
  if (estado.avatar.cliente !== cliente) return;
  estado.avatar.activo = false;
  estado.avatar.cliente = null;
  if (!sigueEnLaSala() || estado.terminada) { ocultarAvatar(); return; }
  if (estado.avatar.reconexiones >= MAX_RECONEXIONES_AVATAR) {
    mostrarEstadoAvatar(tx('El avatar se ha desconectado. La negociación sigue por texto.', 'The avatar has disconnected. The conversation continues in text.'));
    return;
  }
  estado.avatar.reconexiones += 1;
  mostrarEstadoAvatar(tx('Reconectando el avatar…', 'Reconnecting the avatar…'));
  setTimeout(() => {
    if (sigueEnLaSala() && !estado.terminada && !estado.avatar.cliente) iniciarAvatar();
  }, 1500);
}

async function iniciarAvatar() {
  await pararAvatar();
  if (!estado.caso || !estado.rolId) return;

  mostrarEstadoAvatar(tx('Conectando el avatar…', 'Connecting the avatar…'));
  const nombre = $('#avatar-nombre');
  if (nombre) nombre.textContent = estado.briefing ? estado.briefing.contraparte.nombre : '—';

  try {
    const [anam, r] = await Promise.all([
      cargarAnamSDK(),
      fetch(`${API}/api/avatar-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grupo: estado.acceso.codigo, casoId: estado.caso.id, rolId: estado.rolId }),
      }),
    ]);

    if (!r.ok) {
      // El avatar es un añadido, no un requisito: si no está disponible,
      // no interrumpimos la negociación por texto.
      ocultarAvatar();
      return;
    }
    const datos = await r.json();
    if (!datos.sessionToken) { ocultarAvatar(); return; }

    const cliente = anam.createClient(datos.sessionToken, { disableInputAudio: true });
    estado.avatar.cliente = cliente;

    cliente.addListener(anam.AnamEvent.SESSION_READY, () => mostrarEstadoAvatar(''));
    cliente.addListener(anam.AnamEvent.CONNECTION_CLOSED, () => avatarCerradoPorAnam(cliente));

    await cliente.streamToVideoElement('avatar-video');
    const video = $('#avatar-video');
    if (video) video.muted = estado.avatar.silenciado;
    estado.avatar.activo = true;
  } catch (err) {
    console.error('Avatar no disponible:', err);
    await pararAvatar();
  }
}

$('#avatar-mute').addEventListener('click', () => {
  estado.avatar.silenciado = !estado.avatar.silenciado;
  const video = $('#avatar-video');
  if (video) video.muted = estado.avatar.silenciado;
  $('#avatar-mute').textContent = estado.avatar.silenciado ? '🔇' : '🔊';
  $('#avatar-mute').setAttribute('aria-pressed', String(estado.avatar.silenciado));
});

function entrarEnLaSala() {
  // Sin caso configurado no hay sala: mandamos a elegir uno.
  if (!estado.caso || !estado.briefing) {
    const nota = $('#nota-prep');
    if (nota) nota.textContent = 'Elige antes un caso y tu papel.';
    ir('casos');
    return;
  }
  // Si ya hay una negociación en curso PARA ESTE MISMO CASO Y ROL, volvemos
  // a ella sin reiniciarla (pero sí reconectamos el avatar, que se cierra al
  // salir de la sala). Si el caso o el rol han cambiado desde la última vez
  // -aunque queden mensajes sin cerrar-, es una negociación nueva: no hay
  // que arrastrar el papel ni la conversación de la anterior.
  const experto = Boolean(estado.caso.experto);
  const compite = !experto && compiteEstaNegociacion();
  const esLaMismaSesion =
    estado.mensajes.length &&
    !estado.terminada &&
    estado.sesionCasoId === estado.caso.id &&
    estado.sesionRolId === estado.rolId &&
    estado.sesionCompite === compite &&
    // Si se ha cambiado la dureza o el modo, es otra negociación: reanudar la
    // anterior con otra configuración rompería la firma y no podría puntuar.
    estado.sesionDureza === estado.config.dureza &&
    estado.sesionModo === (compite ? 'contraparte' : estado.config.modo);
  estado.avatar.reconexiones = 0;
  if (esLaMismaSesion) { ir('sala'); iniciarAvatar(); return; }

  estado.mensajes = [];
  estado.terminada = false;
  estado.firma = null;
  marcarPrepUsada();
  estado.sesionCasoId = estado.caso.id;
  estado.sesionRolId = estado.rolId;
  estado.sesionCompite = compite;
  if (compite) estado.config.modo = 'contraparte';
  estado.sesionDureza = estado.config.dureza;
  estado.sesionModo = estado.config.modo;
  const ins = leerInscripcion();
  $('#sala-competicion-fila').classList.toggle('oculto', !compite);
  $('#sala-competicion').textContent = compite && ins ? ins.codigo : '—';
  $('#conversacion').innerHTML = '';
  $('#sala-caso').textContent = estado.caso.titulo;
  $('#sala-yo').textContent = estado.briefing.rol.nombre;
  $('#sala-simulacion').textContent = estado.briefing.contraparte.nombre;
  const fija = Boolean(estado.caso.configFija);
  $('#sala-dureza').textContent = (fija ? NOMBRE_DUREZA_FIJA : NOMBRE_DUREZA)[estado.config.dureza];
  $('#sala-color').textContent = NOMBRE_COLOR[estado.config.color];
  $('#sala-color-fila').classList.toggle('oculto', fija);
  $('#sala-turnos').textContent = '0';
  $('#sala-recordatorio').innerHTML = md(estado.briefing.rol.briefing);
  $('#btn-tiempo-muerto').classList.toggle('oculto', estado.config.modo !== 'coach');
  // Experto: la mesa se describe como una consulta, no como una negociación.
  $('#sala-dureza-fila').classList.toggle('oculto', experto);
  $('#sala-etq-otro').textContent = experto ? tx('Experto', 'Expert') : 'Al otro lado';
  $('#sala-etq-turnos').textContent = experto ? tx('Preguntas', 'Questions') : 'Intervenciones';
  $('#sala-titulo-mesa').textContent = experto ? tx('La conversación', 'The conversation') : 'La mesa';
  $('#sala-titulo-briefing').textContent = experto ? tx('Cómo sacarle partido', 'Getting the most out of it') : 'Tu briefing';
  $('#entrada').placeholder = experto
    ? tx('Escribe tu pregunta… (Enter para enviar, Mayús+Enter para salto de línea)', 'Type your question… (Enter to send, Shift+Enter for a new line)')
    : 'Escribe tu intervención… (Enter para enviar, Mayús+Enter para salto de línea)';
  ir('sala');
  iniciarAvatar();
  hablarConSimulacion();
}

$('#btn-a-la-sala').addEventListener('click', entrarEnLaSala);
$('#btn-prep-a-la-sala').addEventListener('click', entrarEnLaSala);

$('#btn-salir').addEventListener('click', () => {
  // Con el experto no se pierde nada: al volver, la conversación se retoma.
  if (estado.caso && estado.caso.experto) { pararAvatar(); ir('inicio'); return; }
  if (estado.mensajes.length && !estado.terminada) {
    if (!confirm('Vas a salir de la negociación en curso. ¿Seguro?')) return;
  }
  pararAvatar();
  ir('casos');
});

window.addEventListener('beforeunload', () => { pararAvatar(); });

function turno(tipo, texto, quien) {
  const div = document.createElement('div');
  div.className = `turno ${tipo}`;
  div.innerHTML = `${quien ? `<div class="quien">${escapar(quien)}</div>` : ''}<div class="texto"></div>`;
  div.querySelector('.texto').textContent = texto;
  $('#conversacion').appendChild(div);
  $('#conversacion').scrollTop = $('#conversacion').scrollHeight;
  return div;
}

/* ─── Texto para la voz del avatar ───
   Dónde cortar: tras un fin de frase (. ? ! ; :) o salto de línea seguido de
   espacio. Si no hay ninguno y el texto ya es largo, en el último espacio,
   para no retrasar demasiado la voz. Devuelve la posición de corte o 0. */
function ultimoCorteDeFrase(t) {
  let corte = 0;
  const re = /[.!?;:…](?=\s)|\n/g;
  let m;
  while ((m = re.exec(t))) corte = m.index + 1;
  if (!corte && t.length > 160) {
    const esp = t.lastIndexOf(' ');
    if (esp > 60) corte = esp + 1;
  }
  return corte;
}

/* Símbolos y abreviaturas que una voz multilingüe tiende a leer en inglés
   ("€", "%", "M€", "48 h"…) se escriben con palabras en castellano, y se
   quitan las marcas de formato que no deben leerse. Solo afecta a lo que
   dice el avatar; en pantalla el texto sigue igual. */
function textoParaVoz(t) {
  // En inglés solo se quitan las marcas de formato: la voz ya lee bien los símbolos.
  if (idiomaWeb() === 'en') return String(t || '').replace(/[*_#`«»"“”]/g, '').replace(/[ \t]{2,}/g, ' ');
  return String(t || '')
    .replace(/[*_#`«»"“”]/g, '')
    .replace(/(\d)\s*M€/g, '$1 millones de euros')
    .replace(/(\d)\s*k€/gi, '$1 mil euros')
    .replace(/(\d)\s*€/g, '$1 euros')
    .replace(/€/g, ' euros')
    .replace(/(\d)\s*%/g, '$1 por ciento')
    .replace(/(\d)\s*h\b/g, '$1 horas')
    .replace(/(\d)\s*(?:sem\.|semanas?)\b/g, '$1 semanas')
    .replace(/\bvs\.?\s/gi, 'frente a ')
    .replace(/\bOK\b/g, 'de acuerdo')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\//g, ' o ')
    .replace(/[ \t]{2,}/g, ' ');
}

function esInforme(texto) {
  return /^##\s*Resultado/m.test(texto) || /^##\s*Puntuaci/m.test(texto);
}

async function hablarConSimulacion() {
  if (estado.ocupado) return;
  estado.ocupado = true;
  $('#btn-enviar').disabled = true;
  const btnMic = $('#btn-microfono');
  if (btnMic) btnMic.disabled = true;

  const contenedor = turno('simulacion', '', estado.briefing.contraparte.nombre);
  const caja = contenedor.querySelector('.texto');
  caja.innerHTML = '<span class="escribiendo"><i></i><i></i><i></i></span>';

  let acumulado = '';
  let firmaNueva = null;

  // Si tarda demasiado, casi siempre es que el servidor estaba dormido.
  const avisoLento = setTimeout(() => {
    if (!acumulado) {
      caja.innerHTML =
        '<span class="escribiendo"><i></i><i></i><i></i></span>' +
        `<div style="color:var(--tenue);font-size:.85rem;margin-top:8px">${estado.caso && estado.caso.experto ? tx(MENSAJE_ESPERA_EXPERTO, MENSAJE_ESPERA_EXPERTO_EN) : MENSAJE_ESPERA}</div>`;
    }
  }, 7000);
  try {
    const r = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grupo: estado.acceso.codigo,
        casoId: estado.caso.id,
        rolId: estado.rolId,
        config: estado.config,
        mensajes: estado.mensajes,
        firma: estado.firma,
      }),
    });

    clearTimeout(avisoLento);

    if (!r.ok) {
      let mensaje = tx('No se ha podido contactar con la simulación.', 'Could not reach the expert.');
      try { mensaje = (await r.json()).error || mensaje; } catch {}
      caja.innerHTML = `<span style="color:var(--rojo)">${escapar(mensaje)}</span>`;
      return;
    }

    const lector = r.body.getReader();
    const dec = new TextDecoder();
    let resto = '';
    caja.textContent = '';

    // El texto se reenvía al avatar a medida que llega, salvo que resulte
    // ser el informe final: eso se lee en pantalla pero el avatar (que
    // representa a la contraparte, en personaje) no lo dice en voz alta.
    // Como no sabemos si es informe hasta ver las primeras líneas, las
    // primeras palabras se retienen en un pequeño búfer antes de decidir.
    const avatarDisponible = estado.avatar.activo && estado.avatar.cliente;
    let bufer = '';
    let decidido = false;
    let esModoInforme = false;
    let flujoAvatar = null;

    // El texto de la simulación puede traer acotaciones de lenguaje no
    // verbal entre corchetes, p. ej. "[se echa hacia atrás]" o
    // "[entra en la sala y se sienta]" (ver prompt.js). Eso se queda en la
    // pantalla (el participante las lee como contexto), pero NO se le pasa
    // al avatar de voz: si se las mandamos, las lee en voz alta como si
    // fueran diálogo. El filtro es un pequeño autómata con memoria entre
    // trozos del streaming, porque un corchete puede partirse entre dos
    // fragmentos de texto que llegan por separado.
    let dentroDeCorchete = false;
    const filtrarParaAvatar = (fragmento) => {
      let salida = '';
      for (const ch of fragmento) {
        if (ch === '[') { dentroDeCorchete = true; continue; }
        if (ch === ']') { dentroDeCorchete = false; continue; }
        if (!dentroDeCorchete) salida += ch;
      }
      return salida;
    };

    // Al avatar no se le mandan los trozos tal como llegan (a veces son
    // una o dos letras, o una cifra suelta como "140.000 €"): con tan poco
    // texto, la voz multilingüe de anam.ai puede "adivinar" otro idioma y
    // pasarse al inglés a mitad de frase. Se acumula el texto y se envía
    // por frases completas, ya normalizado para leerse en castellano.
    let pendienteAvatar = '';
    const mandarTrozo = (texto, esUltimo) => {
      try {
        if (flujoAvatar.isActive()) flujoAvatar.streamMessageChunk(texto, esUltimo);
      } catch (err) { console.error('Avatar (talkStream):', err); }
    };
    const enviarAlAvatar = (texto, esUltimo = false) => {
      if (!avatarDisponible || esModoInforme || !flujoAvatar) return;
      pendienteAvatar += texto || '';
      if (esUltimo) {
        const resto = textoParaVoz(pendienteAvatar);
        pendienteAvatar = '';
        mandarTrozo(resto, true);
        return;
      }
      const corte = ultimoCorteDeFrase(pendienteAvatar);
      if (corte <= 0) return;
      const frase = textoParaVoz(pendienteAvatar.slice(0, corte));
      pendienteAvatar = pendienteAvatar.slice(corte);
      if (frase.trim()) mandarTrozo(frase, false);
    };

    const decidirAvatar = (forzar = false) => {
      if (decidido) return;
      if (esInforme(bufer)) { esModoInforme = true; decidido = true; return; }
      if (!forzar && bufer.length < 24 && !bufer.includes('\n\n')) return;
      decidido = true;
      if (avatarDisponible) {
        try { flujoAvatar = estado.avatar.cliente.createTalkMessageStream(); } catch { flujoAvatar = null; }
        enviarAlAvatar(bufer);
      }
    };

    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      resto += dec.decode(value, { stream: true });
      const partes = resto.split('\n\n');
      resto = partes.pop();
      for (const parte of partes) {
        for (const linea of parte.split('\n')) {
          if (!linea.startsWith('data:')) continue;
          const cuerpo = linea.slice(5).trim();
          if (!cuerpo || cuerpo === '[DONE]') continue;
          try {
            const ev = JSON.parse(cuerpo);
            if (ev.type === 'firma_negociador') { firmaNueva = ev.firma; continue; }
            if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
              const texto = ev.delta.text;
              acumulado += texto;
              caja.textContent = acumulado;
              $('#conversacion').scrollTop = $('#conversacion').scrollHeight;
              // El texto completo (con corchetes) se muestra en pantalla;
              // al avatar solo le llega la versión filtrada.
              const textoParaAvatar = filtrarParaAvatar(texto);
              if (!decidido) { bufer += textoParaAvatar; decidirAvatar(); }
              else enviarAlAvatar(textoParaAvatar);
            }
          } catch {}
        }
      }
    }

    if (!decidido) decidirAvatar(true);
    // Lo que quede sin cerrar en frase se manda ahora, como último trozo.
    if (flujoAvatar && pendienteAvatar.trim()) enviarAlAvatar('', true);
    if (flujoAvatar) {
      try { if (flujoAvatar.isActive()) await flujoAvatar.endMessage(); } catch {}
    }

    if (!acumulado) {
      caja.innerHTML = `<span style="color:var(--rojo)">${tx('La simulación no ha respondido. Reintenta.', 'No answer came back. Please try again.')}</span>`;
      return;
    }

    estado.mensajes.push({ role: 'assistant', content: acumulado });
    // La firma solo vale para el historial exacto que acaba de firmar el servidor.
    estado.firma = firmaNueva;

    // En competición la contraparte no puntúa: si aun así entrega un informe
    // (porque el participante escribió "informe"), no se muestra; en su lugar
    // se pide la evaluación oficial.
    if (estado.sesionCompite && esInforme(acumulado)) {
      contenedor.remove();
      estado.ocupado = false;
      // Se lanza al terminar este turno (después del "finally" de abajo),
      // para que no vuelva a habilitar el botón de enviar mientras se evalúa.
      setTimeout(evaluarCompeticion, 0);
      return;
    }

    if (esInforme(acumulado)) {
      contenedor.className = 'turno informe';
      contenedor.querySelector('.quien').textContent = 'Informe de la simulación';
      caja.innerHTML = md(acumulado);
      estado.terminada = true;

      const barraInforme = document.createElement('div');
      barraInforme.className = 'barra-accion';
      barraInforme.style.marginTop = '14px';
      const btnDescargarInforme = document.createElement('button');
      btnDescargarInforme.type = 'button';
      btnDescargarInforme.className = 'boton secundario';
      btnDescargarInforme.textContent = 'Descargar informe en PDF';
      btnDescargarInforme.addEventListener('click', async () => {
        const etiqueta = btnDescargarInforme.textContent;
        btnDescargarInforme.disabled = true;
        btnDescargarInforme.textContent = 'Generando el PDF…';
        try {
          await descargarInformePdf(acumulado);
        } catch (err) {
          console.error(err);
          alert('No se ha podido generar el PDF (' + (err.message || err) + '). Te descargo el informe en texto.');
          descargarInformeMarkdown(acumulado);
        } finally {
          btnDescargarInforme.disabled = false;
          btnDescargarInforme.textContent = etiqueta;
        }
      });
      barraInforme.appendChild(btnDescargarInforme);
      contenedor.appendChild(barraInforme);

      turno('sistema', 'Simulación cerrada. Puedes repetir el caso con otra configuración desde la biblioteca.', '');
    }
  } catch (err) {
    caja.innerHTML = `<span style="color:var(--rojo)">${tx('Error de conexión', 'Connection error')}: ${escapar(String(err.message || err))}</span>`;
  } finally {
    clearTimeout(avisoLento);
    estado.ocupado = false;
    $('#btn-enviar').disabled = false;
    if (btnMic) btnMic.disabled = false;
    $('#sala-turnos').textContent = String(estado.mensajes.filter((m) => m.role === 'user').length);
  }
}

function enviar(texto) {
  const t = (texto || '').trim();
  if (!t || estado.ocupado || estado.evaluando) return;
  if (estado.terminada && !/repetir/i.test(t)) {
    turno('sistema', 'La simulación ya está cerrada. Vuelve a la biblioteca para empezar otra.', '');
    return;
  }
  estado.mensajes.push({ role: 'user', content: t });
  turno('mio', t, tx('Tú', 'You'));
  $('#entrada').value = '';
  hablarConSimulacion();
}

$('#btn-enviar').addEventListener('click', () => enviar($('#entrada').value));
$('#entrada').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar($('#entrada').value); }
});
$$('[data-atajo]').forEach((b) =>
  b.addEventListener('click', () => {
    const esFin = b.dataset.atajo.startsWith('FIN');
    if (esFin && estado.sesionCompite) {
      if (estado.terminada || estado.ocupado || estado.evaluando) return;
      if (!confirm('Se cerrará la negociación y el evaluador independiente calculará tu puntuación, que quedará guardada para tu profesor. ¿Continuar?')) return;
      evaluarCompeticion();
      return;
    }
    if (esFin && estado.caso && estado.caso.configFija) {
      if (estado.terminada || estado.ocupado || estado.evaluando) return;
      if (!confirm('Se cerrará la negociación y un evaluador independiente analizará la conversación para darte tu feedback. ¿Continuar?')) return;
      evaluarLibre();
      return;
    }
    if (esFin && !confirm('Se cerrará la negociación y la simulación entregará el informe. ¿Continuar?')) return;
    enviar(b.dataset.atajo);
  })
);

/* ─────────── Dictado por voz ───────────
   Alternativa al teclado para dar instrucciones a la simulación: usa el
   reconocimiento de voz del propio navegador (Web Speech API). No hay
   servidor de por medio ni se envía audio a ningún sitio. Donde el
   navegador no lo soporte (Firefox de escritorio, la mayoría de Safari
   antiguos…) el botón se queda oculto y todo sigue funcionando por texto,
   igual que con el avatar o el PDF. */

const MotorDictado = window.SpeechRecognition || window.webkitSpeechRecognition || null;

function inicializarDictado() {
  const btn = $('#btn-microfono');
  if (!btn) return;
  if (!MotorDictado) return; // se queda oculto (clase "oculto" ya puesta en el HTML)

  btn.classList.remove('oculto');

  let reconocimiento = null;
  let escuchando = false;

  const marcarReposo = () => {
    escuchando = false;
    btn.classList.remove('grabando');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = '🎤';
    btn.title = tx('Dictar por voz', 'Dictate');
  };

  const marcarEscuchando = () => {
    escuchando = true;
    btn.classList.add('grabando');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = '⏹';
    btn.title = tx('Detener el dictado', 'Stop dictation');
  };

  btn.addEventListener('click', () => {
    if (escuchando) {
      if (reconocimiento) reconocimiento.stop();
      return;
    }
    if (estado.ocupado) return;

    reconocimiento = new MotorDictado();
    reconocimiento.lang = idiomaWeb() === 'en' ? 'en-US' : 'es-ES';
    reconocimiento.interimResults = false;
    reconocimiento.maxAlternatives = 1;

    reconocimiento.addEventListener('start', marcarEscuchando);
    reconocimiento.addEventListener('end', marcarReposo);

    reconocimiento.addEventListener('result', (e) => {
      const texto = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join(' ')
        .trim();
      if (!texto) return;
      const entrada = $('#entrada');
      entrada.value = entrada.value.trim() ? `${entrada.value.trim()} ${texto}` : texto;
      entrada.focus();
      entrada.scrollTop = entrada.scrollHeight;
    });

    reconocimiento.addEventListener('error', (e) => {
      console.error('Dictado por voz:', e.error);
      marcarReposo();
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        alert(tx('No se ha podido acceder al micrófono. Revisa los permisos del navegador para este sitio.', 'Could not access the microphone. Check this site\'s browser permissions.'));
      } else if (e.error === 'no-speech') {
        // Nada que avisar: el participante simplemente no ha dicho nada.
      }
    });

    try {
      reconocimiento.start();
    } catch (err) {
      console.error('Dictado por voz:', err);
      marcarReposo();
    }
  });
}

inicializarDictado();

/* ─────────── Hoja de preparación ─────────── */

/* La hoja vive en sessionStorage (no en localStorage): sobrevive a una
   recarga de la página, pero cada acceso nuevo (otra pestaña, otro día,
   otro participante en el mismo ordenador del aula) empieza con la hoja en
   blanco. Además, en cuanto una hoja se ha usado en una negociación, al
   pedir el briefing de un intento nuevo se borra (ver marcarPrepUsada). */
const CLAVE_PREP = 'negociador-preparacion-v1';

// Restos de la versión anterior, que guardaba la hoja en localStorage para siempre.
try { localStorage.removeItem(CLAVE_PREP); } catch {}

function leerPrep() {
  try { return JSON.parse(sessionStorage.getItem(CLAVE_PREP)) || {}; } catch { return {}; }
}
function escribirPrep(datos) {
  try { sessionStorage.setItem(CLAVE_PREP, JSON.stringify(datos)); } catch {}
  const aviso = $('#aviso-guardado');
  aviso.classList.add('visible');
  clearTimeout(escribirPrep._t);
  escribirPrep._t = setTimeout(() => aviso.classList.remove('visible'), 1200);
}

function guardarVariablesEnPreparacion(variables) {
  // Intento nuevo: si la hoja ya se usó en una negociación anterior, se
  // empieza en blanco en lugar de arrastrar lo que se escribió entonces.
  const datos = leerPrep().usada ? {} : leerPrep();
  if (!datos.campos) vaciarCamposPrep();
  datos.variables = variables;
  escribirPrep(datos);
}

// Marca la hoja como usada al empezar una negociación nueva en la sala.
function marcarPrepUsada() {
  const datos = leerPrep();
  datos.usada = true;
  try { sessionStorage.setItem(CLAVE_PREP, JSON.stringify(datos)); } catch {}
}

function vaciarCamposPrep() {
  $$('[data-prep]').forEach((el) => (el.value = ''));
}

function montarTablasPreparacion() {
  const datos = leerPrep();
  const variables = datos.variables && datos.variables.length
    ? datos.variables
    : ['', '', '', '', ''];

  $('#tabla-objetivos').innerHTML = variables
    .map(
      (v, i) => `<tr>
        <td><input type="text" data-prep id="obj-${i}-var" value="${escapar(v)}"></td>
        <td><input type="text" data-prep id="obj-${i}-opt"></td>
        <td><input type="text" data-prep id="obj-${i}-sat"></td>
        <td><input type="text" data-prep id="obj-${i}-min"></td>
      </tr>`
    )
    .join('');

  $('#tabla-variables').innerHTML = variables
    .map(
      (v, i) => `<tr>
        <td><input type="text" data-prep id="var-${i}-nom" value="${escapar(v)}"></td>
        <td><input type="text" data-prep id="var-${i}-mc"></td>
        <td><input type="text" data-prep id="var-${i}-mi"></td>
        <td><input type="text" data-prep id="var-${i}-lc"></td>
        <td><input type="text" data-prep id="var-${i}-li"></td>
      </tr>`
    )
    .join('');

  restaurarPrep();
  engancharPrep();
}

function engancharPrep() {
  $$('[data-prep]').forEach((el) => {
    if (el._enganchado) return;
    el._enganchado = true;
    el.addEventListener('input', () => {
      const datos = leerPrep();
      datos.campos = datos.campos || {};
      datos.campos[el.id] = el.value;
      escribirPrep(datos);
    });
  });
}

function restaurarPrep() {
  const datos = leerPrep();
  const campos = datos.campos || {};
  $$('[data-prep]').forEach((el) => {
    if (campos[el.id] !== undefined && campos[el.id] !== '') el.value = campos[el.id];
  });
}

$('#btn-borrar-prep').addEventListener('click', () => {
  if (!confirm('Se borrará toda tu hoja de preparación. ¿Seguro?')) return;
  try { sessionStorage.removeItem(CLAVE_PREP); } catch {}
  vaciarCamposPrep();
});

/* ─── Descarga de la hoja en PDF ───
   Se genera en el navegador con jsPDF, replicando los colores y la
   estructura de la web. Los huecos sin rellenar salen como "No contestado". */

const SIN_RESPUESTA = 'No contestado';

// Logotipo de la empresa para la cabecera de los PDF: { datos, ancho, alto }.
// Se precarga como data URL al entrar con el código; si no se pudiera
// cargar (o la empresa no tiene logo), el PDF sale igual sin logotipo.
let logoPdf = null;
let marcaPdf = '';

function cargarLogoPdf(url) {
  logoPdf = null;
  if (!url) return;
  const conMedidas = (datos) => {
    const im = new Image();
    im.onload = () => { logoPdf = { datos, ancho: im.naturalWidth || 1, alto: im.naturalHeight || 1 }; };
    im.src = datos;
  };
  fetch(url)
    .then((r) => (r.ok ? r.blob() : null))
    .then((blob) => {
      if (!blob) return;
      if (blob.type.includes('svg')) {
        // Un SVG que solo envuelve un PNG (como el de Tecnobit): jsPDF necesita ese PNG.
        return blob.text().then((svg) => {
          const m = svg.match(/href="(data:image\/png;base64,[^"]+)"/);
          if (m) conMedidas(m[1]);
        });
      }
      const lector = new FileReader();
      lector.onload = () => conMedidas(lector.result);
      lector.readAsDataURL(blob);
    })
    .catch(() => {});
}

// Paleta de los PDF: neutra por defecto; aplicarEmpresa() pone la de la empresa.
const COLOR_PDF_NEUTRO = {
  fondo: [255, 255, 255],
  fondo2: [244, 245, 247],
  superficie: [235, 237, 241],
  borde: [214, 218, 225],
  texto: [29, 36, 48],
  tenue: [92, 102, 118],
  acento: [43, 58, 85],
};
const COLOR_PDF = { ...COLOR_PDF_NEUTRO };

/* La librería viaja con la web (assets/vendor/), así que el PDF también
   funciona en redes que bloquean CDN externas. Si el fichero faltara,
   se intenta la copia pública de cdnjs. */
const FUENTES_JSPDF = [
  'assets/vendor/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js',
];
let promesaJsPDF = null;

function cargarGuion(src) {
  return new Promise((resolver, rechazar) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolver;
    s.onerror = () => rechazar(new Error('no se ha podido cargar ' + src));
    document.head.appendChild(s);
  });
}

function cargarJsPDF() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (!promesaJsPDF) {
    promesaJsPDF = (async () => {
      let ultimo;
      for (const src of FUENTES_JSPDF) {
        try {
          await cargarGuion(src);
          if (window.jspdf && window.jspdf.jsPDF) return window.jspdf.jsPDF;
          ultimo = new Error('jsPDF no se ha inicializado');
        } catch (err) { ultimo = err; }
      }
      throw ultimo || new Error('no se ha podido cargar la librería de PDF');
    })().catch((err) => { promesaJsPDF = null; throw err; });
  }
  return promesaJsPDF;
}

/* Fábrica de ayudas de dibujo para un documento jsPDF con la estética de la
   web (fondo oscuro, acento, tablas). Se comparte entre la hoja de
   preparación y el informe final de la negociación, para que ambos
   documentos salgan con el mismo aspecto. */
function crearConstructorPdf(doc) {
  const ANCHO_PAG = 210, ALTO_PAG = 297, M = 16;
  const ancho = ANCHO_PAG - M * 2;
  const LIMITE = ALTO_PAG - 20;
  const pos = { y: 0, pagina: 1 };

  const fondo = () => { doc.setFillColor(...COLOR_PDF.fondo); doc.rect(0, 0, ANCHO_PAG, ALTO_PAG, 'F'); };
  const pie = () => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...COLOR_PDF.tenue);
    doc.text(`NegoLab${marcaPdf ? ' · ' + (estado.acceso && estado.acceso.empresa ? estado.acceso.empresa.nombreCorto || marcaPdf : marcaPdf) : ''} — simulador de negociación`, M, ALTO_PAG - 10);
    doc.text(String(pos.pagina), ANCHO_PAG - M, ALTO_PAG - 10, { align: 'right' });
  };
  const saltarPagina = () => { pie(); doc.addPage(); pos.pagina++; fondo(); pos.y = M + 8; };
  const espacio = (alto) => { if (pos.y + alto > LIMITE) saltarPagina(); };

  const cabecera = (tituloDoc, filasMeta) => {
    fondo();
    pos.y = M + 6;
    doc.setFillColor(...COLOR_PDF.acento);
    doc.rect(0, 0, ANCHO_PAG, 2.2, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...COLOR_PDF.acento);
    doc.text(marcaPdf ? `NEGOLAB · ${marcaPdf}` : 'NEGOLAB', M, pos.y);
    if (logoPdf) {
      // Cabe en una caja de 28 × 10 mm, respetando la proporción del logotipo.
      const escala = Math.min(28 / logoPdf.ancho, 10 / logoPdf.alto);
      const w = logoPdf.ancho * escala;
      const h = logoPdf.alto * escala;
      const formato = /^data:image\/jpe?g/.test(logoPdf.datos) ? 'JPEG' : 'PNG';
      try { doc.addImage(logoPdf.datos, formato, ANCHO_PAG - M - w, pos.y - 6.5, w, h); } catch {}
    }
    pos.y += 10;
    doc.setFontSize(19); doc.setTextColor(...COLOR_PDF.texto);
    doc.text(tituloDoc, M, pos.y);
    pos.y += 8;

    const altoMeta = filasMeta.length * 6 + 6;
    doc.setFillColor(...COLOR_PDF.fondo2);
    doc.setDrawColor(...COLOR_PDF.borde); doc.setLineWidth(0.2);
    doc.roundedRect(M, pos.y - 1, ancho, altoMeta, 2, 2, 'FD');
    pos.y += 4;
    filasMeta.forEach(([etiqueta, valor], i) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.setTextColor(...COLOR_PDF.tenue);
      doc.text(etiqueta, M + 4, pos.y);
      const vacio = !valor;
      doc.setFont('helvetica', vacio ? 'normal' : 'bold');
      doc.setTextColor(...(vacio ? COLOR_PDF.tenue : COLOR_PDF.texto));
      doc.text(vacio ? SIN_RESPUESTA : valor, ANCHO_PAG - M - 4, pos.y, { align: 'right' });
      if (i < filasMeta.length - 1) {
        doc.setDrawColor(...COLOR_PDF.borde);
        doc.line(M + 4, pos.y + 1.8, ANCHO_PAG - M - 4, pos.y + 1.8);
      }
      pos.y += 6;
    });
    pos.y += 8;
  };

  const seccion = (numero, titulo, sub) => {
    espacio(20);
    doc.setFillColor(...COLOR_PDF.acento);
    doc.rect(M, pos.y - 4, 1.8, 5.4, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...COLOR_PDF.texto);
    const t = numero ? `${numero} · ${titulo}` : titulo;
    doc.text(t, M + 5, pos.y);
    if (sub) {
      const w = doc.getTextWidth(t);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.setTextColor(...COLOR_PDF.tenue);
      doc.text(sub, M + 5 + w + 3, pos.y);
    }
    pos.y += 7;
  };

  const tabla = (cabeceras, filas, anchos) => {
    const alto = 7;
    const dibujarCabecera = () => {
      espacio(alto + 8);
      doc.setFillColor(...COLOR_PDF.superficie);
      doc.setDrawColor(...COLOR_PDF.borde); doc.setLineWidth(0.2);
      doc.rect(M, pos.y - 4.4, ancho, alto, 'FD');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...COLOR_PDF.tenue);
      let x = M;
      cabeceras.forEach((c, i) => {
        if (i) doc.line(x, pos.y - 4.4, x, pos.y - 4.4 + alto);
        doc.text(String(c).toUpperCase(), x + 2, pos.y);
        x += anchos[i];
      });
      pos.y += alto;
    };
    dibujarCabecera();
    filas.forEach((fila) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      const celdas = fila.map((t, i) => doc.splitTextToSize(String(t), anchos[i] - 4));
      const nLineas = celdas.reduce((m, c) => Math.max(m, c.length), 1);
      const altoFila = Math.max(alto, nLineas * 4 + 3);
      if (pos.y - 4.4 + altoFila > LIMITE) { saltarPagina(); dibujarCabecera(); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); }
      doc.setFillColor(...COLOR_PDF.fondo2);
      doc.setDrawColor(...COLOR_PDF.borde); doc.setLineWidth(0.2);
      doc.rect(M, pos.y - 4.4, ancho, altoFila, 'FD');
      let x = M;
      celdas.forEach((lineas, i) => {
        if (i) doc.line(x, pos.y - 4.4, x, pos.y - 4.4 + altoFila);
        doc.setTextColor(...(fila[i] === SIN_RESPUESTA ? COLOR_PDF.tenue : COLOR_PDF.texto));
        lineas.forEach((l, j) => doc.text(l, x + 2, pos.y + j * 4));
        x += anchos[i];
      });
      pos.y += altoFila;
    });
    pos.y += 8;
  };

  const campo = (etiqueta, valor) => {
    const vacio = !valor;
    const texto = vacio ? SIN_RESPUESTA : valor;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    const lineas = doc.splitTextToSize(texto, ancho - 8);
    espacio(6 + lineas.length * 5 + 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...COLOR_PDF.tenue);
    doc.text(etiqueta.toUpperCase(), M, pos.y);
    pos.y += 5;
    const arriba = pos.y - 3.4;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    doc.setTextColor(...(vacio ? COLOR_PDF.tenue : COLOR_PDF.texto));
    lineas.forEach((l) => { doc.text(l, M + 4, pos.y); pos.y += 5; });
    doc.setDrawColor(...(vacio ? COLOR_PDF.borde : COLOR_PDF.acento));
    doc.setLineWidth(0.6);
    doc.line(M + 0.6, arriba, M + 0.6, pos.y - 4.4);
    doc.setLineWidth(0.2);
    pos.y += 5;
  };

  // Quita el marcado de énfasis de markdown (**negrita**, `código`) para
  // dibujar texto plano: jsPDF no compone estilos distintos dentro de una
  // misma línea sin trabajo extra, así que aquí se prioriza que el informe
  // sea legible y fiel al contenido antes que reproducir la negrita.
  const limpiarEnfasis = (t) =>
    String(t).replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();

  const parrafo = (texto) => {
    const limpio = limpiarEnfasis(texto);
    if (!limpio) return;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...COLOR_PDF.texto);
    const lineas = doc.splitTextToSize(limpio, ancho);
    espacio(lineas.length * 5 + 4);
    lineas.forEach((l) => { doc.text(l, M, pos.y); pos.y += 5; });
    pos.y += 3;
  };

  const lista = (items, ordenada) => {
    items.forEach((item, i) => {
      const marcador = ordenada ? `${i + 1}.` : '•';
      const limpio = limpiarEnfasis(item);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
      const lineas = doc.splitTextToSize(limpio, ancho - 8);
      espacio(lineas.length * 5 + 2);
      doc.setTextColor(...COLOR_PDF.acento);
      doc.text(marcador, M, pos.y);
      doc.setTextColor(...COLOR_PDF.texto);
      lineas.forEach((l, j) => doc.text(l, M + 7, pos.y + j * 5));
      pos.y += lineas.length * 5 + 2;
    });
    pos.y += 3;
  };

  return { doc, pos, M, ancho, fondo, pie, saltarPagina, espacio, cabecera, seccion, tabla, campo, parrafo, lista, limpiarEnfasis };
}

/* La hoja se dibuja a partir de sus datos guardados ({ variables, campos }),
   no de lo que hay en pantalla: así sirve igual para la hoja actual del
   navegador que para la hoja que se envió con un resultado de la competición
   y se descarga después desde el ranking. */
function lectorHoja(datos) {
  const campos = (datos && datos.campos) || {};
  const variables = datos && datos.variables && datos.variables.length ? datos.variables : ['', '', '', '', ''];
  const v = (id) => {
    const x = campos[id];
    if (typeof x === 'string' && x.trim()) return x.trim();
    // Los nombres de variable vienen rellenos por defecto con las del caso.
    const m = id.match(/^(?:obj-(\d+)-var|var-(\d+)-nom)$/);
    if (m) return variables[Number(m[1] || m[2])] || '';
    return '';
  };
  return { v, variables };
}

async function descargarHojaPdf(datos = leerPrep(), meta = {}) {
  const JsPDF = await cargarJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  const pdf = crearConstructorPdf(doc);
  const { v: valorPrep, variables } = lectorHoja(datos);

  pdf.cabecera('Hoja de preparación', [
    ['Caso', meta.caso !== undefined ? meta.caso : estado.caso ? estado.caso.titulo : ''],
    ['Mi papel', meta.rol !== undefined ? meta.rol : estado.briefing ? estado.briefing.rol.nombre : ''],
    ['Fecha', fechaLarga(meta.fecha)],
  ]);

  const oNo = (s) => (s ? s : SIN_RESPUESTA);

  pdf.seccion('1', 'Mis objetivos por variable', 'óptimo, satisfactorio, mínimo');
  pdf.tabla(
    ['Variable', 'Óptimo', 'Satisfactorio', 'Mínimo'],
    variables.map((_, i) => [
      oNo(valorPrep(`obj-${i}-var`)),
      oNo(valorPrep(`obj-${i}-opt`)),
      oNo(valorPrep(`obj-${i}-sat`)),
      oNo(valorPrep(`obj-${i}-min`)),
    ]),
    [46, 44, 44, 44]
  );

  pdf.seccion('2', 'Coste e importancia', 'el mapa del toma y daca');
  pdf.tabla(
    ['Variable', 'Me cuesta', 'Me importa', 'Les cuesta', 'Les importa'],
    variables.map((_, i) => [
      oNo(valorPrep(`var-${i}-nom`)),
      oNo(valorPrep(`var-${i}-mc`)),
      oNo(valorPrep(`var-${i}-mi`)),
      oNo(valorPrep(`var-${i}-lc`)),
      oNo(valorPrep(`var-${i}-li`)),
    ]),
    [50, 32, 32, 32, 32]
  );

  pdf.seccion('3', 'MAAN', 'mi alternativa y la suya');
  pdf.campo('Mi mejor alternativa si no hay acuerdo', valorPrep('p-maan-mio'));
  pdf.campo('Su alternativa probable', valorPrep('p-maan-suyo'));

  pdf.seccion('4', 'Posición, intereses, necesidad');
  pdf.campo('Lo que dirán que quieren', valorPrep('p-posicion'));
  pdf.campo('Lo que probablemente les mueve', valorPrep('p-intereses'));
  pdf.campo('Lo que de verdad necesitan', valorPrep('p-necesidad'));

  pdf.seccion('5', 'Mis preguntas', 'por escrito, como manda el marco');
  pdf.campo('Para averiguar', valorPrep('p-preg-averiguar'));
  pdf.campo('Para comprender', valorPrep('p-preg-comprender'));
  pdf.campo('Para construir', valorPrep('p-preg-construir'));
  pdf.campo('Para concretar', valorPrep('p-preg-concretar'));
  pdf.campo('La pregunta más difícil que me pueden hacer, y mi respuesta', valorPrep('p-preg-dificil'));

  pdf.seccion('6', 'Mi apertura', 'y los tres primeros movimientos');
  pdf.campo('Oferta inicial', valorPrep('p-apertura'));
  pdf.campo('Movimiento 2', valorPrep('p-mov2'));
  pdf.campo('Movimiento 3', valorPrep('p-mov3'));
  pdf.campo('Tácticas que espero y mi respuesta', valorPrep('p-tacticas'));

  pdf.pie();
  doc.save(meta.fichero || 'hoja-preparacion-negociacion.pdf');
}

function fechaLarga(f) {
  const d = f ? new Date(f) : new Date();
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
}

/* ── Descarga del informe final en PDF ───
   Mismo aspecto que la hoja de preparación (misma fábrica de ayudas de
   dibujo, arriba). El informe es el markdown que ya ha entregado la
   simulación siguiendo la estructura fija de prompt.js (## Resultado,
   ## Puntuación, tablas, listas…), así que se recorre línea a línea igual
   que hace md() para la pantalla, pero dibujando con jsPDF en vez de HTML. */
function renderizarInformeEnPdf(pdf, texto) {
  const lineas = (texto || '').split('\n');
  let i = 0;
  let listaAcumulada = null;

  const cerrarLista = () => {
    if (listaAcumulada) { pdf.lista(listaAcumulada.items, listaAcumulada.ordenada); listaAcumulada = null; }
  };
  const esFilaTabla = (l) => /^\s*\|/.test(l || '');
  const esSeparadorTabla = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l || '');
  const celdasDeFila = (fila) =>
    fila.trim().replace(/^\||\|$/g, '').split('|').map((c) => pdf.limpiarEnfasis(c.trim()));

  while (i < lineas.length) {
    const l = lineas[i];
    let m;

    if (esFilaTabla(l) && esSeparadorTabla(lineas[i + 1])) {
      cerrarLista();
      const cab = celdasDeFila(l);
      i += 2;
      const filas = [];
      while (i < lineas.length && esFilaTabla(lineas[i])) { filas.push(celdasDeFila(lineas[i])); i++; }
      const anchoCol = pdf.ancho / cab.length;
      pdf.tabla(cab, filas, cab.map(() => anchoCol));
      continue;
    }

    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      cerrarLista();
      pdf.seccion(null, pdf.limpiarEnfasis(m[2]));
      i++; continue;
    }

    if ((m = l.match(/^\s*[-*]\s+(.*)$/))) {
      if (!listaAcumulada || listaAcumulada.ordenada) { cerrarLista(); listaAcumulada = { items: [], ordenada: false }; }
      listaAcumulada.items.push(m[1]);
      i++; continue;
    }

    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (!listaAcumulada || !listaAcumulada.ordenada) { cerrarLista(); listaAcumulada = { items: [], ordenada: true }; }
      listaAcumulada.items.push(m[1]);
      i++; continue;
    }

    if (l.trim() === '') { cerrarLista(); i++; continue; }

    cerrarLista();
    pdf.parrafo(l);
    i++;
  }
  cerrarLista();
}

async function descargarInformePdf(textoInforme, meta = null) {
  const JsPDF = await cargarJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  const pdf = crearConstructorPdf(doc);

  const filas = meta
    ? meta.filas
    : [
        ['Caso', estado.caso ? estado.caso.titulo : ''],
        ['Mi papel', estado.briefing ? estado.briefing.rol.nombre : ''],
        ['Simulación', estado.briefing ? estado.briefing.contraparte.nombre : ''],
      ];
  pdf.cabecera((meta && meta.titulo) || 'Informe de la negociación', [...filas, ['Fecha', fechaLarga(meta && meta.fecha)]]);

  renderizarInformeEnPdf(pdf, textoInforme);

  pdf.pie();
  doc.save((meta && meta.fichero) || 'informe-negociacion.pdf');
}

/* Igual que con la hoja de preparación: si el PDF no se puede generar (sin
   red, CDN bloqueada…), se descarga el mismo informe en texto para no
   dejar al participante sin nada. */
function descargarInformeMarkdown(textoInforme) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([textoInforme || ''], { type: 'text/markdown;charset=utf-8' }));
  a.download = 'informe-negociacion.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* Si el PDF no se puede generar (sin red, CDN bloqueada), se descarga
   la misma hoja en texto para no dejar al usuario sin nada. */
function descargarHojaMarkdown(datos = leerPrep(), meta = {}) {
  const { v, variables } = lectorHoja(datos);
  const oNo = (s) => (s ? s : SIN_RESPUESTA);

  let t = '# Hoja de preparación de la negociación\n\n';
  t += `**Caso**: ${oNo(meta.caso !== undefined ? meta.caso : estado.caso ? estado.caso.titulo : '')}\n\n`;
  t += `**Mi papel**: ${oNo(meta.rol !== undefined ? meta.rol : estado.briefing ? estado.briefing.rol.nombre : '')}\n\n`;

  t += '## 1. Objetivos por variable\n\n| Variable | Óptimo | Satisfactorio | Mínimo |\n|---|---|---|---|\n';
  variables.forEach((_, i) => {
    t += `| ${oNo(v(`obj-${i}-var`))} | ${oNo(v(`obj-${i}-opt`))} | ${oNo(v(`obj-${i}-sat`))} | ${oNo(v(`obj-${i}-min`))} |\n`;
  });

  t += '\n## 2. Coste e importancia\n\n| Variable | Me cuesta | Me importa | Les cuesta | Les importa |\n|---|---|---|---|---|\n';
  variables.forEach((_, i) => {
    t += `| ${oNo(v(`var-${i}-nom`))} | ${oNo(v(`var-${i}-mc`))} | ${oNo(v(`var-${i}-mi`))} | ${oNo(v(`var-${i}-lc`))} | ${oNo(v(`var-${i}-li`))} |\n`;
  });

  t += `\n## 3. MAAN\n\n**El mío**: ${oNo(v('p-maan-mio'))}\n\n**El suyo**: ${oNo(v('p-maan-suyo'))}\n`;
  t += `\n## 4. Posición, intereses, necesidad\n\n- Posición: ${oNo(v('p-posicion'))}\n- Intereses: ${oNo(v('p-intereses'))}\n- Necesidad: ${oNo(v('p-necesidad'))}\n`;
  t += `\n## 5. Preguntas\n\n- Para averiguar: ${oNo(v('p-preg-averiguar'))}\n- Para comprender: ${oNo(v('p-preg-comprender'))}\n- Para construir: ${oNo(v('p-preg-construir'))}\n- Para concretar: ${oNo(v('p-preg-concretar'))}\n- La más difícil que me pueden hacer: ${oNo(v('p-preg-dificil'))}\n`;
  t += `\n## 6. Apertura\n\n1. ${oNo(v('p-apertura'))}\n2. ${oNo(v('p-mov2'))}\n3. ${oNo(v('p-mov3'))}\n\n**Tácticas esperadas**: ${oNo(v('p-tacticas'))}\n`;

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([t], { type: 'text/markdown;charset=utf-8' }));
  a.download = (meta.fichero || 'hoja-preparacion-negociacion.pdf').replace(/\.pdf$/, '.md');
  a.click();
  URL.revokeObjectURL(a.href);
}

$('#btn-descargar-prep').addEventListener('click', async () => {
  const btn = $('#btn-descargar-prep');
  const etiqueta = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generando el PDF…';
  try {
    await descargarHojaPdf();
  } catch (err) {
    console.error(err);
    alert('No se ha podido generar el PDF (' + (err.message || err) + '). Te descargo la hoja en texto.');
    descargarHojaMarkdown();
  } finally {
    btn.disabled = false;
    btn.textContent = etiqueta;
  }
});

/* ─────────── Competición ───────────
   El participante se apunta con el código de su grupo y un nombre o alias.
   Al terminar una negociación que puntúa, la web pide al servidor la
   evaluación oficial (/api/evaluar), que devuelve los puntos, el informe y
   un token privado. Ese token se guarda solo en este navegador: es lo que
   permite descargar después el informe y la hoja desde el ranking, y que
   nadie más pueda hacerlo. */

const CLAVE_INSCRIPCION = 'negociador-competicion-v1';
const CLAVE_MIS_RESULTADOS = 'negociador-mis-resultados-v1';

function leerLocal(clave, porDefecto) {
  try { const v = JSON.parse(localStorage.getItem(clave)); return v === null ? porDefecto : v; } catch { return porDefecto; }
}
function escribirLocal(clave, valor) {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch {}
}

// La inscripción (nombre o alias + consentimiento) vale solo para el grupo con
// el que se ha entrado: si se cambia de grupo, hay que registrarse otra vez.
const leerInscripcion = () => {
  const ins = leerLocal(CLAVE_INSCRIPCION, null);
  return ins && estado.acceso && ins.codigo === estado.acceso.codigo ? ins : null;
};
const leerMisResultados = () => leerLocal(CLAVE_MIS_RESULTADOS, []);
function guardarMiResultado(r) {
  const lista = leerMisResultados().filter((x) => x.id !== r.id);
  lista.unshift(r);
  escribirLocal(CLAVE_MIS_RESULTADOS, lista.slice(0, 200));
}
function olvidarMiResultado(id) {
  escribirLocal(CLAVE_MIS_RESULTADOS, leerMisResultados().filter((x) => x.id !== id));
}

function compiteEstaNegociacion() {
  return Boolean(estado.competicion.disponible && leerInscripcion() && estado.competicion.puntua);
}

const fmtNum = (n) => (Math.round(Number(n) * 10) / 10).toLocaleString('es-ES', { maximumFractionDigits: 1 });
const fechaCorta = (f) => new Date(f).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });

async function pedirJson(url, opciones = {}) {
  const r = await fetch(url, opciones);
  let datos = {};
  try { datos = await r.json(); } catch {}
  return { r, datos };
}

function actualizarDisponibilidadCompeticion() {
  const activa = $('.vista.activa');
  if (activa && activa.id === 'vista-configurar' && estado.caso) pintarCompeticionEnConfigurador();
  if (activa && activa.id === 'vista-competicion') pintarCompeticion();
  if (activa && activa.id === 'vista-profesor') pintarProfesor();
}

/* ─── En el configurador ─── */

function aplicarBloqueoModo() {
  const compite = compiteEstaNegociacion();
  if (compite) estado.config.modo = 'contraparte';
  $$('.opcion[data-campo="modo"]').forEach((o) => {
    o.disabled = compite && o.dataset.valor !== 'contraparte';
    o.setAttribute('aria-pressed', String(o.dataset.valor === estado.config.modo));
  });
}

function pintarCompeticionEnConfigurador() {
  const bloque = $('#bloque-competicion');
  if (!estado.competicion.disponible) { bloque.classList.add('oculto'); aplicarBloqueoModo(); return; }
  bloque.classList.remove('oculto');
  const ins = leerInscripcion();
  const caja = $('#competicion-config');
  if (!ins) {
    caja.innerHTML = `<p class="ayuda" style="margin:0 0 12px">Regístrate con tu nombre o un alias y el resultado de esta
      negociación quedará guardado para tu profesor. Si no, recibirás igualmente tu feedback.</p>
      <button class="boton secundario" type="button" data-ir="competicion">Registrarme</button>`;
    aplicarBloqueoModo();
    return;
  }
  caja.innerHTML = `<label class="casilla">
      <input type="checkbox" id="chk-puntua" ${estado.competicion.puntua ? 'checked' : ''}>
      <span>Registrar el resultado de esta negociación en <strong>${escapar(ins.nombreGrupo || ins.codigo)}</strong>
      como <strong>${escapar(ins.nombre)}</strong>.</span>
    </label>
    <p class="ayuda" style="margin:10px 0 0">Al pulsar «Fin de la simulación» te puntúa un evaluador independiente y tu
      resultado queda guardado para tu profesor. Tú ves tus puntos y tu informe; el ranking solo lo ve el profesor.
      <a href="#" data-desplazar-reglas>Cómo se puntúa</a>.</p>`;
  $('#chk-puntua').addEventListener('change', (e) => {
    estado.competicion.puntua = e.target.checked;
    aplicarBloqueoModo();
  });
  caja.querySelector('[data-desplazar-reglas]').addEventListener('click', (e) => {
    e.preventDefault();
    ir('competicion');
    setTimeout(() => $('#reglas-competicion').scrollIntoView({ behavior: 'smooth' }), 50);
  });
  aplicarBloqueoModo();
}

/* ─── Evaluación oficial al terminar ─── */

function hojaParaEnviar() {
  const datos = leerPrep();
  const campos = datos.campos || {};
  const alguno = Object.keys(campos).some(
    (k) => !/^(obj-\d+-var|var-\d+-nom)$/.test(k) && typeof campos[k] === 'string' && campos[k].trim()
  );
  return alguno ? { variables: datos.variables || [], campos } : null;
}

function bloquearComposicion(bloquear) {
  $('#btn-enviar').disabled = bloquear;
  const mic = $('#btn-microfono');
  if (mic) mic.disabled = bloquear;
}

async function evaluarCompeticion() {
  if (estado.evaluando || estado.terminada || estado.ocupado) return;
  const ins = leerInscripcion();
  if (!ins) { turno('sistema', 'Ya no estás registrado en este grupo, así que esta negociación no puede guardarse.', ''); return; }

  estado.evaluando = true;
  bloquearComposicion(true);
  const aviso = turno('sistema', '', '');
  aviso.querySelector('.texto').innerHTML =
    '<span class="escribiendo"><i></i><i></i><i></i></span><br>Negociación cerrada. El evaluador independiente está leyendo la conversación completa; tarda alrededor de un minuto.';

  const hoja = hojaParaEnviar();
  try {
    const { r, datos } = await pedirJson(`${API}/api/evaluar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grupo: ins.codigo,
        nombre: ins.nombre,
        consentimiento: true,
        casoId: estado.caso.id,
        rolId: estado.rolId,
        config: estado.config,
        mensajes: estado.mensajes,
        firma: estado.firma,
        hoja,
      }),
    });

    if (!r.ok) {
      const reintentable = r.status >= 500 || r.status === 429;
      aviso.querySelector('.texto').innerHTML =
        `<span style="color:var(--rojo)">${escapar(datos.error || 'No se ha podido completar la evaluación.')}</span>` +
        (reintentable ? '<br><button class="boton secundario" type="button" style="margin-top:10px">Reintentar la evaluación</button>' : '');
      const b = aviso.querySelector('button');
      if (b) b.addEventListener('click', () => { aviso.remove(); evaluarCompeticion(); });
      return;
    }

    estado.terminada = true;
    const meta = {
      id: datos.id,
      token: datos.token,
      codigo: ins.codigo,
      nombre: ins.nombre,
      caso: estado.caso.titulo,
      rol: estado.briefing.rol.nombre,
      puntos: datos.puntos.puntos,
      fecha: new Date().toISOString(),
    };
    guardarMiResultado(meta);
    aviso.remove();
    pintarInformeOficial(datos, meta, hoja);
  } catch (err) {
    aviso.querySelector('.texto').innerHTML =
      `<span style="color:var(--rojo)">Error de conexión: ${escapar(String(err.message || err))}</span>
       <br><button class="boton secundario" type="button" style="margin-top:10px">Reintentar la evaluación</button>`;
    aviso.querySelector('button').addEventListener('click', () => { aviso.remove(); evaluarCompeticion(); });
  } finally {
    estado.evaluando = false;
    bloquearComposicion(false);
  }
}

/* ─── Feedback sin competición ───
   Mismo evaluador independiente que en la competición, pero sin guardar nada
   en el servidor (/api/feedback). Es lo que recibe cualquier participante
   que no esté apuntado a un grupo. */
async function evaluarLibre() {
  if (estado.evaluando || estado.terminada || estado.ocupado) return;
  if (estado.mensajes.filter((m) => m.role === 'user').length < 3) {
    turno('sistema', 'La negociación es demasiado corta para evaluarla: necesitas al menos tres intervenciones.', '');
    return;
  }
  estado.evaluando = true;
  bloquearComposicion(true);
  const aviso = turno('sistema', '', '');
  aviso.querySelector('.texto').innerHTML =
    '<span class="escribiendo"><i></i><i></i><i></i></span><br>Negociación cerrada. El evaluador independiente está leyendo la conversación completa; tarda alrededor de un minuto.';
  const hoja = hojaParaEnviar();
  try {
    const { r, datos } = await pedirJson(`${API}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grupo: estado.acceso.codigo,
        casoId: estado.caso.id,
        rolId: estado.rolId,
        config: estado.config,
        mensajes: estado.mensajes,
        firma: estado.firma,
        hoja,
      }),
    });
    if (!r.ok) {
      const reintentable = r.status >= 500 || r.status === 429;
      aviso.querySelector('.texto').innerHTML =
        `<span style="color:var(--rojo)">${escapar(datos.error || 'No se ha podido completar la evaluación.')}</span>` +
        (reintentable ? '<br><button class="boton secundario" type="button" style="margin-top:10px">Reintentar la evaluación</button>' : '');
      const b = aviso.querySelector('button');
      if (b) b.addEventListener('click', () => { aviso.remove(); evaluarLibre(); });
      return;
    }
    estado.terminada = true;
    aviso.remove();
    const p = datos.puntos;
    const div = turno('informe', '', 'Tu feedback');
    div.querySelector('.texto').innerHTML = `<div class="resultado-competicion">
        <div class="cifra">${fmtNum(p.puntos)} puntos</div>
        <div>(${fmtNum(p.rubrica)} de rúbrica + ${fmtNum(p.resultado)} de resultado) × ${fmtNum(p.factor)} por nivel ·
          no se ha registrado</div>
      </div>` + md(datos.informe);
    const barra = document.createElement('div');
    barra.className = 'barra-accion';
    barra.style.marginTop = '14px';
    const fecha = new Date().toISOString();
    const metaInforme = {
      filas: [['Caso', estado.caso.titulo], ['Mi papel', estado.briefing.rol.nombre], ['Puntos', fmtNum(p.puntos)]],
      fecha,
    };
    const bPdf = document.createElement('button');
    bPdf.type = 'button'; bPdf.className = 'boton secundario'; bPdf.textContent = 'Descargar feedback en PDF';
    bPdf.addEventListener('click', () => conBotonOcupado(bPdf, () => descargarInformePdf(datos.informe, metaInforme), () => descargarInformeMarkdown(datos.informe)));
    barra.appendChild(bPdf);
    if (estado.competicion.disponible) {
      const bComp = document.createElement('button');
      bComp.type = 'button'; bComp.className = 'boton fantasma'; bComp.textContent = 'Registrarme para guardar mis resultados';
      bComp.addEventListener('click', () => ir('competicion'));
      barra.appendChild(bComp);
    }
    div.appendChild(barra);
    $('#conversacion').scrollTop = div.offsetTop - 20;
    turno('sistema', 'Simulación cerrada. Puedes repetir el caso desde «El caso» todas las veces que quieras' +
      (estado.competicion.disponible ? '; regístrate en «Resultados» para que se guarden para tu profesor.' : '.'), '');
  } catch (err) {
    aviso.querySelector('.texto').innerHTML =
      `<span style="color:var(--rojo)">Error de conexión: ${escapar(String(err.message || err))}</span>
       <br><button class="boton secundario" type="button" style="margin-top:10px">Reintentar la evaluación</button>`;
    aviso.querySelector('button').addEventListener('click', () => { aviso.remove(); evaluarLibre(); });
  } finally {
    estado.evaluando = false;
    bloquearComposicion(false);
  }
}

function pintarInformeOficial(datos, meta, hoja) {
  const p = datos.puntos;
  const div = turno('informe', '', 'Evaluación oficial');
  const caja = div.querySelector('.texto');
  caja.innerHTML = `<div class="resultado-competicion">
      <div class="cifra">${fmtNum(p.puntos)} puntos</div>
      <div>(${fmtNum(p.rubrica)} de rúbrica + ${fmtNum(p.resultado)} de resultado) × ${fmtNum(p.factor)} por nivel ·
        guardado para tu profesor</div>
    </div>` + md(datos.informe);

  const barra = document.createElement('div');
  barra.className = 'barra-accion';
  barra.style.marginTop = '14px';
  const boton = (texto, clase, accion) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'boton ' + clase; b.textContent = texto;
    b.addEventListener('click', accion);
    barra.appendChild(b);
    return b;
  };
  const metaInforme = {
    filas: [['Caso', meta.caso], ['Mi papel', meta.rol], ['Participante', meta.nombre], ['Puntos', fmtNum(meta.puntos)]],
    fecha: meta.fecha,
  };
  boton('Descargar informe en PDF', 'secundario', () =>
    conBotonOcupado(barra.children[0], () => descargarInformePdf(datos.informe, metaInforme), () => descargarInformeMarkdown(datos.informe))
  );
  if (hoja) {
    boton('Descargar mi hoja en PDF', 'secundario', (e) =>
      conBotonOcupado(e.target, () => descargarHojaPdf(hoja, { caso: meta.caso, rol: meta.rol, fecha: meta.fecha }), () => descargarHojaMarkdown(hoja, { caso: meta.caso, rol: meta.rol }))
    );
  }
  boton('Ver mis resultados', '', () => ir('competicion'));
  div.appendChild(barra);
  $('#conversacion').scrollTop = div.offsetTop - 20;
  turno('sistema', 'Simulación cerrada y guardada para tu profesor. Puedes repetir el caso desde «El caso» todas las veces que quieras.', '');
}

async function conBotonOcupado(boton, generar, respaldo) {
  const etiqueta = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Generando el PDF…';
  try {
    await generar();
  } catch (err) {
    console.error(err);
    alert('No se ha podido generar el PDF (' + (err.message || err) + '). Te lo descargo en texto.');
    if (respaldo) respaldo();
  } finally {
    boton.disabled = false;
    boton.textContent = etiqueta;
  }
}

/* ─── Vista de resultados: registro y mis resultados ───
   No hay ranking público: el participante ve solo sus propios resultados
   (los que registró desde este navegador). El ranking lo ve el profesor. */

function pintarCompeticion() {
  $('#comp-no-disponible').classList.toggle('oculto', estado.competicion.disponible);
  const ins = leerInscripcion();
  const form = $('#form-competicion');
  const estadoCaja = $('#comp-estado');

  if (ins) {
    $('#comp-titulo-inscripcion').textContent = 'Tu registro';
    form.classList.add('oculto');
    estadoCaja.innerHTML = `<div class="inscripcion-activa">
        Estás registrado en <strong>${escapar(ins.nombreGrupo || ins.codigo)}</strong>
        como <strong>${escapar(ins.nombre)}</strong>.
        ${estado.acceso && estado.acceso.abierto === false ? '<br><span style="color:var(--rojo)">Este grupo está cerrado: ya no admite resultados nuevos.</span>' : ''}
      </div>
      <div class="barra-accion">
        <button class="boton" type="button" data-ir="casos">Ir al caso</button>
        <button class="boton fantasma" type="button" id="btn-comp-salir">Cambiar de nombre</button>
      </div>`;
    $('#btn-comp-salir').addEventListener('click', () => {
      if (!confirm('Los resultados que ya has registrado se quedan con el nombre anterior. ¿Continuar?')) return;
      localStorage.removeItem(CLAVE_INSCRIPCION);
      $('#comp-nombre').value = ins.nombre;
      pintarCompeticion();
    });
  } else {
    $('#comp-titulo-inscripcion').textContent = 'Regístrate';
    form.classList.remove('oculto');
    estadoCaja.innerHTML = '';
  }
  $('#btn-comp-entrar').disabled = !estado.competicion.disponible || !estado.acceso;
  pintarMisResultados();
}

$('#form-competicion').addEventListener('submit', (e) => {
  e.preventDefault();
  const nota = $('#nota-competicion');
  if (!estado.acceso) { ir('acceso'); return; }
  const nombre = $('#comp-nombre').value.replace(/\s+/g, ' ').trim();
  if (nombre.length < 2) { nota.textContent = 'Escribe un nombre o alias de al menos 2 caracteres.'; return; }
  if (!$('#comp-consentimiento').checked) { nota.textContent = 'Tienes que aceptar las condiciones para registrar tus resultados.'; return; }
  escribirLocal(CLAVE_INSCRIPCION, {
    codigo: estado.acceso.codigo,
    nombreGrupo: estado.acceso.nombreGrupo,
    nombre,
    consentimiento: new Date().toISOString(),
  });
  estado.competicion.puntua = true;
  nota.textContent = '';
  pintarCompeticion();
});

function pintarMisResultados() {
  const bloque = $('#mis-resultados-bloque');
  const mios = estado.acceso ? leerMisResultados().filter((m) => m.codigo === estado.acceso.codigo) : [];
  bloque.classList.toggle('oculto', !mios.length && !leerInscripcion());
  $('#mis-resultados-grupo').textContent = estado.acceso ? estado.acceso.nombreGrupo : '';
  if (!mios.length) {
    $('#mis-resultados').innerHTML = '<p class="vacio">Todavía no has registrado ninguna negociación en este grupo.</p>';
    return;
  }
  $('#mis-resultados').innerHTML = `<div class="tabla-desplazable"><table class="ranking">
      <thead><tr><th>Fecha</th><th>Caso</th><th>Nombre o alias</th><th class="centro">Puntos</th><th>Descargas</th></tr></thead>
      <tbody>${mios.map((m) => `<tr class="mio">
        <td style="white-space:nowrap;color:var(--tenue)">${fechaCorta(m.fecha)}</td>
        <td>${escapar(m.caso || '')}</td>
        <td>${escapar(m.nombre || '')}</td>
        <td class="num puntos">${fmtNum(m.puntos)}</td>
        <td><div class="acciones">
          <button class="boton secundario" type="button" data-mio="informe" data-id="${m.id}">Informe</button>
          <button class="boton secundario" type="button" data-mio="hoja" data-id="${m.id}">Hoja</button>
          <button class="boton fantasma" type="button" data-mio="borrar" data-id="${m.id}" title="Borrar mi resultado">Borrar</button>
        </div></td></tr>`).join('')}</tbody></table></div>`;
  $$('#mis-resultados [data-mio]').forEach((b) => b.addEventListener('click', () => accionMiResultado(b)));
}

async function accionMiResultado(boton) {
  const id = boton.dataset.id;
  const accion = boton.dataset.mio;
  const mio = leerMisResultados().find((m) => m.id === id);
  if (!mio) return;

  if (accion === 'borrar') {
    if (!confirm('Se borrará este resultado, con su informe y su hoja: tampoco lo verá el profesor. No se puede deshacer. ¿Continuar?')) return;
    const { r, datos } = await pedirJson(`${API}/api/resultados/${id}/borrar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mio.token }),
    });
    if (!r.ok) { alert(datos.error || 'No se ha podido borrar.'); return; }
    olvidarMiResultado(id);
    pintarMisResultados();
    return;
  }

  const etiqueta = boton.textContent;
  boton.disabled = true;
  boton.textContent = '…';
  try {
    const { r, datos } = await pedirJson(`${API}/api/resultados/${id}/descarga`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: mio.token }),
    });
    if (!r.ok) { alert(datos.error || 'No se ha podido descargar.'); return; }
    await descargarDeResultado(datos.resultado, accion);
  } catch (err) {
    alert('No se ha podido generar el PDF: ' + (err.message || err));
  } finally {
    boton.disabled = false;
    boton.textContent = etiqueta;
  }
}

/* Genera el PDF del informe o de la hoja a partir de un resultado guardado
   (lo usan tanto el participante como el profesor). */
async function descargarDeResultado(res, que) {
  const sufijo = `${res.nombre}-${res.caso_titulo}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (que === 'hoja') {
    if (!res.hoja) { alert('Este resultado no tiene hoja de preparación.'); return; }
    const meta = { caso: res.caso_titulo, rol: res.rol_nombre, fecha: res.creado, fichero: `hoja-${sufijo}.pdf` };
    try { await descargarHojaPdf(res.hoja, meta); } catch { descargarHojaMarkdown(res.hoja, meta); }
    return;
  }
  const meta = {
    filas: [['Caso', res.caso_titulo], ['Papel', res.rol_nombre], ['Participante', res.nombre], ['Dureza', NOMBRE_DUREZA[res.dureza] || ''], ['Puntos', fmtNum(res.puntos)]],
    fecha: res.creado,
    fichero: `informe-${sufijo}.pdf`,
  };
  try { await descargarInformePdf(res.informe, meta); } catch { descargarInformeMarkdown(res.informe); }
}

/* ─────────── Panel del profesor ─────────── */

const CLAVE_PROFESOR = 'negociador-profesor';
let profResultados = [];
let profGrupoActual = null; // código del grupo, o "empresa:<id>" para el ranking de toda una empresa
let profEmpresas = [];
let profGrupos = [];

const claveProfesor = () => { try { return sessionStorage.getItem(CLAVE_PROFESOR) || ''; } catch { return ''; } };

async function apiProfesor(ruta, opciones = {}) {
  const { r, datos } = await pedirJson(`${API}/api/admin/${ruta}`, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${claveProfesor()}`, ...(opciones.headers || {}) },
  });
  if (r.status === 401) {
    try { sessionStorage.removeItem(CLAVE_PROFESOR); } catch {}
    pintarProfesor();
    $('#nota-prof-login').textContent = datos.error || 'Clave incorrecta.';
  }
  return { r, datos };
}

function pintarProfesor() {
  $('#prof-no-disponible').classList.toggle('oculto', estado.competicion.disponible);
  const dentro = Boolean(claveProfesor());
  $('#prof-login').classList.toggle('oculto', dentro);
  $('#prof-panel').classList.toggle('oculto', !dentro);
  if (dentro) { cargarEmpresasProfesor(); cargarGruposProfesor(); }
}

async function cargarEmpresasProfesor() {
  let res;
  try { res = await apiProfesor('empresas'); } catch { return; }
  if (!res.r.ok) return;
  profEmpresas = res.datos.empresas || [];
  const opciones = profEmpresas.map((e) => `<option value="${escapar(e.id)}">${escapar(e.nombre)}</option>`).join('');
  const crear = $('#prof-grupo-empresa');
  const elegida = crear.value;
  crear.innerHTML = '<option value="">Elige la empresa…</option>' + opciones;
  if (profEmpresas.some((e) => e.id === elegida)) crear.value = elegida;
  const filtro = $('#prof-filtro-empresa');
  const filtrada = filtro.value;
  filtro.innerHTML = '<option value="">Todas las empresas</option>' + opciones;
  if (profEmpresas.some((e) => e.id === filtrada)) filtro.value = filtrada;
  $('#prof-ranking-empresa').disabled = !filtro.value;
  pintarGruposProfesor();
}

const nombreEmpresa = (id) => (profEmpresas.find((e) => e.id === id) || {}).nombre || id;

$('#prof-filtro-empresa').addEventListener('change', () => {
  $('#prof-ranking-empresa').disabled = !$('#prof-filtro-empresa').value;
  pintarGruposProfesor();
});
$('#prof-ranking-empresa').addEventListener('click', () => {
  const id = $('#prof-filtro-empresa').value;
  if (id) verResultadosProfesor(`empresa:${id}`);
});

$('#prof-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { sessionStorage.setItem(CLAVE_PROFESOR, $('#prof-clave').value); } catch {}
  $('#prof-clave').value = '';
  $('#nota-prof-login').textContent = '';
  pintarProfesor();
});

$('#prof-salir').addEventListener('click', () => {
  try { sessionStorage.removeItem(CLAVE_PROFESOR); } catch {}
  profGrupoActual = null;
  $('#prof-resultados-bloque').classList.add('oculto');
  pintarProfesor();
});

$('#prof-crear').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nota = $('#nota-prof-crear');
  nota.textContent = 'Creando…';
  const { r, datos } = await apiProfesor('grupos', {
    method: 'POST',
    body: JSON.stringify({ nombre: $('#prof-grupo-nombre').value, codigo: $('#prof-grupo-codigo').value, empresa: $('#prof-grupo-empresa').value }),
  });
  if (!r.ok) { if (r.status !== 401) nota.textContent = datos.error || 'No se ha podido crear el grupo.'; return; }
  nota.textContent = `Grupo de ${nombreEmpresa(datos.grupo.empresa)} creado. Código para tus alumnos: ${datos.grupo.codigo}`;
  $('#prof-grupo-nombre').value = '';
  $('#prof-grupo-codigo').value = '';
  cargarGruposProfesor();
});

async function cargarGruposProfesor() {
  const caja = $('#prof-grupos');
  caja.innerHTML = '<p class="vacio">Cargando…</p>';
  let res;
  try { res = await apiProfesor('grupos'); } catch { caja.innerHTML = '<div class="aviso">No se ha podido contactar con el servidor.</div>'; return; }
  const { r, datos } = res;
  if (!r.ok) { caja.innerHTML = r.status === 401 ? '' : `<div class="aviso">${escapar(datos.error || 'Error')}</div>`; return; }
  profGrupos = datos.grupos;
  pintarGruposProfesor();
}

function pintarGruposProfesor() {
  const caja = $('#prof-grupos');
  if (!profGrupos) return;
  const filtro = $('#prof-filtro-empresa').value;
  const grupos = profGrupos.filter((g) => !filtro || g.empresa === filtro);
  if (!grupos.length) {
    caja.innerHTML = `<p class="vacio">${profGrupos.length ? 'Esta empresa todavía no tiene grupos.' : 'Todavía no hay grupos. Crea el primero arriba.'}</p>`;
    return;
  }
  caja.innerHTML = `<div class="tabla-desplazable"><table class="ranking">
    <thead><tr><th>Empresa</th><th>Nombre</th><th>Código</th><th>Estado</th><th>Resultados</th><th>Creado</th><th></th></tr></thead>
    <tbody>${grupos.map((g) => `<tr>
      <td>${escapar(nombreEmpresa(g.empresa))}</td>
      <td>${escapar(g.nombre)}</td>
      <td><code>${escapar(g.codigo)}</code></td>
      <td>${g.abierto ? '<span style="color:var(--verde)">Abierto</span>' : '<span style="color:var(--tenue)">Cerrado</span>'}</td>
      <td class="num">${g.resultados}</td>
      <td style="color:var(--tenue)">${fechaCorta(g.creado)}</td>
      <td><div class="acciones">
        <button class="boton secundario" type="button" data-g="ver" data-codigo="${escapar(g.codigo)}">Ver resultados</button>
        <button class="boton fantasma" type="button" data-g="${g.abierto ? 'cerrar' : 'abrir'}" data-codigo="${escapar(g.codigo)}">${g.abierto ? 'Cerrar' : 'Reabrir'}</button>
        <button class="boton peligro" type="button" data-g="borrar" data-codigo="${escapar(g.codigo)}">Borrar</button>
      </div></td></tr>`).join('')}</tbody></table></div>`;
  $$('#prof-grupos [data-g]').forEach((b) => b.addEventListener('click', () => accionGrupo(b.dataset.g, b.dataset.codigo, profGrupos.find((g) => g.codigo === b.dataset.codigo))));
}

async function accionGrupo(accion, codigo, grupo) {
  const ruta = `grupos/${encodeURIComponent(codigo)}`;
  if (accion === 'ver') { verResultadosProfesor(codigo, grupo); return; }
  if (accion === 'borrar') {
    if (prompt(`Se borrará el grupo ${codigo} con TODOS sus resultados. No se puede deshacer.\nEscribe el código para confirmar:`) !== codigo) return;
    await apiProfesor(ruta, { method: 'DELETE' });
    if (profGrupoActual === codigo) $('#prof-resultados-bloque').classList.add('oculto');
  } else {
    await apiProfesor(ruta, { method: 'PATCH', body: JSON.stringify({ abierto: accion === 'abrir' }) });
  }
  cargarGruposProfesor();
}

async function verResultadosProfesor(clave, grupo) {
  profGrupoActual = clave;
  const deEmpresa = clave.startsWith('empresa:');
  const empresa = deEmpresa ? clave.slice('empresa:'.length) : (grupo && grupo.empresa) || '';
  $('#prof-resultados-bloque').classList.remove('oculto');
  $('#prof-resultados-grupo').textContent = deEmpresa
    ? `Ranking de ${nombreEmpresa(empresa)} · todos sus grupos`
    : `${nombreEmpresa(empresa)} · ${grupo ? grupo.nombre : ''} · ${clave}`;
  const caja = $('#prof-resultados');
  caja.innerHTML = '<p class="vacio">Cargando…</p>';
  const ruta = deEmpresa ? `empresas/${encodeURIComponent(empresa)}` : `grupos/${encodeURIComponent(clave)}`;
  const { r, datos } = await apiProfesor(ruta);
  if (!r.ok) { caja.innerHTML = `<div class="aviso">${escapar(datos.error || 'Error')}</div>`; return; }
  profResultados = datos.resultados;
  if (!profResultados.length) { caja.innerHTML = `<p class="vacio">${deEmpresa ? 'Esta empresa' : 'Este grupo'} todavía no tiene resultados.</p>`; return; }
  caja.innerHTML = `<div class="tabla-desplazable"><table class="ranking">
    <thead><tr><th>#</th><th>Nombre</th>${deEmpresa ? '<th>Grupo</th>' : ''}<th>Papel</th><th>Caso</th><th>Dureza</th><th>Hoja</th><th>Rúbrica</th><th>Resultado</th><th>×</th><th class="centro">Puntos</th><th>Fecha</th><th></th></tr></thead>
    <tbody>${profResultados.map((x, i) => `<tr>
      <td class="pos">${i + 1}</td><td>${escapar(x.nombre)}</td>${deEmpresa ? `<td>${escapar(x.grupo_nombre || x.grupo)}</td>` : ''}<td>${escapar(x.rol_nombre)}</td><td>${escapar(x.caso_titulo)}</td>
      <td>${x.dureza}</td><td style="white-space:nowrap">${x.hoja_rellenada ? 'Sí' : 'No'} <small style="color:var(--tenue)">${x.hoja_completitud} %</small></td>
      <td class="num">${fmtNum(x.rubrica)}</td><td class="num">${fmtNum(x.resultado)}</td><td class="num">${fmtNum(x.factor)}</td>
      <td class="num puntos">${fmtNum(x.puntos)}</td><td style="color:var(--tenue);white-space:nowrap">${fechaCorta(x.creado)}</td>
      <td><div class="acciones">
        <button class="boton secundario" type="button" data-r="informe" data-id="${x.id}">Informe</button>
        ${x.hoja_completitud > 0 ? `<button class="boton secundario" type="button" data-r="hoja" data-id="${x.id}">Hoja</button>` : ''}
        <button class="boton peligro" type="button" data-r="borrar" data-id="${x.id}">Anular</button>
      </div></td></tr>`).join('')}</tbody></table></div>`;
  $$('#prof-resultados [data-r]').forEach((b) => b.addEventListener('click', () => accionResultadoProfesor(b)));
}

async function accionResultadoProfesor(b) {
  const id = b.dataset.id;
  if (b.dataset.r === 'borrar') {
    if (!confirm('Se anulará este resultado: desaparece del ranking junto con su informe y su hoja. ¿Continuar?')) return;
    await apiProfesor(`resultados/${id}`, { method: 'DELETE' });
    verResultadosProfesor(profGrupoActual, profGrupos.find((g) => g.codigo === profGrupoActual));
    cargarGruposProfesor();
    return;
  }
  const etiqueta = b.textContent;
  b.disabled = true; b.textContent = '…';
  try {
    const { r, datos } = await apiProfesor(`resultados/${id}`);
    if (r.ok) await descargarDeResultado(datos.resultado, b.dataset.r);
  } finally {
    b.disabled = false; b.textContent = etiqueta;
  }
}

$('#prof-csv').addEventListener('click', () => {
  if (!profResultados.length) return;
  const cab = ['Posición', 'Nombre', 'Grupo', 'Papel', 'Caso', 'Dureza', 'Hoja rellenada', 'Hoja %', 'Rúbrica', 'Resultado', 'Factor', 'Puntos', 'Fecha'];
  const c = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const num = (n) => String(Math.round(Number(n) * 10) / 10).replace('.', ',');
  const filas = profResultados.map((x, i) => [
    i + 1, x.nombre, x.grupo_nombre || x.grupo || '', x.rol_nombre, x.caso_titulo, x.dureza, x.hoja_rellenada ? 'Sí' : 'No', x.hoja_completitud,
    num(x.rubrica), num(x.resultado), num(x.factor), num(x.puntos), new Date(x.creado).toLocaleString('es-ES'),
  ]);
  // Separador ";" y BOM para que Excel en español lo abra bien a la primera.
  const csv = '﻿' + [cab, ...filas].map((f) => f.map(c).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `ranking-${String(profGrupoActual).replace(':', '-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ─────────── Titular del sitio (páginas legales) ─────────── */

function rellenarTitular() {
  const t = window.NEGOCIADOR_TITULAR || {};
  if (t.nombre) $$('[data-titular="nombre"]').forEach((el) => { el.textContent = t.nombre; });
  if (t.email) {
    $$('[data-titular="email"]').forEach((a) => {
      a.textContent = t.email;
      a.href = t.email.includes('@') ? `mailto:${t.email}` : '#';
    });
  }
}

/* ─────────── Arranque ─────────── */

// Deja un primer registro en el historial para que la flecha "atrás" tenga
// a dónde volver desde el principio (ver ir()/popstate más arriba). Si se
// entra con un enlace directo a una vista que no necesita caso (por ejemplo
// negolab.es/#privacidad o #competicion), se abre esa vista.
const vistaDelEnlace = (location.hash || '').slice(1);
history.replaceState({ vista: 'acceso' }, '', '#acceso');
rellenarTitular();
// Las páginas legales y el panel del profesor se abren sin código.
if (VISTAS_SIN_ACCESO.includes(vistaDelEnlace) && vistaDelEnlace !== 'acceso') ir(vistaDelEnlace);

if (!API || API.includes('PON-AQUI')) {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div class="contenedor"><div class="aviso" style="margin-top:16px">
      La web todavía no apunta a ningún servidor: los casos y la sala de negociación no
      funcionarán. Edita <code>assets/config.js</code> y pon ahí la URL de tu servicio en Render.
    </div></div>`
  );
} else {
  despertarServidor();
}

// Si este navegador ya entró con un código, se vuelve a validar (por si el
// grupo se ha borrado) y se recupera la imagen de su empresa. Si se abrió
// directamente una página legal o el panel del profesor, se queda ahí.
const accesoGuardado = leerAccesoGuardado();
if (accesoGuardado && accesoGuardado.codigo && API && !API.includes('PON-AQUI')) {
  const libre = VISTAS_SIN_ACCESO.includes(vistaDelEnlace) && vistaDelEnlace !== 'acceso';
  const destino = libre ? vistaDelEnlace : VISTAS_DIRECTAS.includes(vistaDelEnlace) ? vistaDelEnlace : 'inicio';
  entrarConCodigo(accesoGuardado.codigo, { vistaInicial: destino });
}
montarTablasPreparacion();

