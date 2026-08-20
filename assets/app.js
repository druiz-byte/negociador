/* Negociador Implacable — front-end
   Sin dependencias externas. Todo el estado vive en el navegador;
   las fichas confidenciales de la simulación nunca llegan hasta aquí. */

/* Si el sitio y el servidor viven juntos (Render), NEGOCIADOR_API queda vacío
   y las llamadas van al mismo origen. Si están separados (GitHub Pages +
   Cloudflare), aquí va la URL del worker. */
const API = (window.NEGOCIADOR_API || '').replace(/\/+$/, '');

const estado = {
  casos: [],
  filtro: 'todos',
  caso: null,
  rolId: null,
  // El perfil conductual ya no se elige en la web (ver 04-despliegue-web.md /
  // bitácora): la simulación juega siempre "rojo · impulsor".
  config: { modo: 'evaluador', dureza: 2, color: 'rojo' },
  briefing: null,
  mensajes: [],
  ocupado: false,
  terminada: false,
  // Identifican a qué caso y rol pertenece la negociación en curso (estado.mensajes),
  // para no reanudar por error una sesión de un caso/rol distinto al recién elegido.
  sesionCasoId: null,
  sesionRolId: null,
  avatar: { activo: false, cliente: null, silenciado: false },
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

const VISTAS_VALIDAS = ['inicio', 'casos', 'configurar', 'briefing', 'sala', 'preparacion', 'marco'];

/* Cada vista queda registrada en el historial del navegador (con
   history.pushState) para que la flecha "atrás" del navegador vuelva a la
   vista anterior de la propia web (p. ej. de la sala al briefing) en vez de
   sacar al usuario de la página o dejarle una pantalla en blanco. */
function ir(vista, opciones = {}) {
  const { registrarHistorial = true } = opciones;
  if (!VISTAS_VALIDAS.includes(vista)) vista = 'inicio';

  const activaAntes = $('.vista.activa');
  const veniaDeSala = activaAntes && activaAntes.id === 'vista-sala';
  $$('.vista').forEach((v) => v.classList.toggle('activa', v.id === `vista-${vista}`));
  $$('nav.principal button').forEach((b) =>
    b.setAttribute('aria-current', String(b.dataset.ir === vista))
  );
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (vista === 'preparacion') { montarTablasPreparacion(); actualizarNotaPrep(); }
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
}

/* Al pulsar "atrás"/"adelante", el navegador nos dice a qué vista volver.
   Si esa vista necesita datos que ya no están (por ejemplo "sala" sin
   ningún caso elegido en esta carga de página), no puede reconstruirse:
   en ese caso llevamos a la biblioteca de casos en vez de a una vista rota. */
window.addEventListener('popstate', (e) => {
  let vista = (e.state && e.state.vista) || 'inicio';
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
  if (b) { ir(b.dataset.ir); }
});

/* ─────────── Biblioteca de casos ─────────── */

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* El servidor gratuito de Render se duerme tras un rato sin visitas y tarda
   cerca de un minuto en despertar. Lanzamos un aviso nada más cargar la
   portada para que vaya arrancando mientras el usuario lee. */
function despertarServidor() {
  fetch(`${API}/api/salud`, { cache: 'no-store' }).catch(() => {});
}

async function cargarCasos({ intento = 1 } = {}) {
  const lista = $('#lista-casos');
  lista.innerHTML = '<p style="color:var(--tenue)">Cargando casos…</p>';

  const aviso = setTimeout(() => {
    lista.innerHTML = `<div class="aviso info">
      <strong>Despertando el servidor…</strong><br>
      El simulador se apaga cuando nadie lo usa y tarda cerca de un minuto en volver.
      Solo pasa la primera vez; a partir de ahí va inmediato.
    </div>`;
  }, 4000);

  try {
    const r = await fetch(`${API}/api/casos`, { cache: 'no-store' });
    clearTimeout(aviso);
    if (!r.ok) throw new Error('respuesta ' + r.status);
    const datos = await r.json();
    estado.casos = datos.casos || [];
    pintarFiltros();
    pintarCasos();
  } catch (err) {
    clearTimeout(aviso);
    if (intento < 3) {
      lista.innerHTML = `<div class="aviso info">Despertando el servidor… (intento ${intento + 1} de 3)</div>`;
      await esperar(6000);
      return cargarCasos({ intento: intento + 1 });
    }
    lista.innerHTML = `<div class="aviso">
      No se ha podido contactar con el servidor del simulador. Puede estar caído o en mantenimiento.
      <br><br><button class="boton secundario" id="btn-reintentar">Reintentar</button>
      <br><br><small>Detalle técnico: ${escapar(String(err.message || err))}</small>
    </div>`;
    const b = $('#btn-reintentar');
    if (b) b.addEventListener('click', () => cargarCasos());
  }
}

function pintarFiltros() {
  const tipos = ['todos', ...new Set(estado.casos.map((c) => c.tipo))];
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
    .map(
      (c) => `
    <article class="tarjeta">
      <div class="meta">
        <span class="pastilla ${c.tipo}">${c.tipo}</span>
        <span class="pastilla">Dificultad ${c.dificultad}</span>
        <span class="pastilla">${c.duracion}</span>
      </div>
      <h3>${escapar(c.titulo)}</h3>
      <p class="sub">${escapar(c.subtitulo || '')}</p>
      <p class="resumen">${escapar(c.resumen)}</p>
      <div class="vars"><strong>Variables:</strong> ${c.variables.map(escapar).join(' · ')}</div>
      <button class="boton" data-caso="${c.id}">Preparar esta negociación</button>
    </article>`
    )
    .join('');
  $$('#lista-casos [data-caso]').forEach((b) =>
    b.addEventListener('click', () => abrirConfigurador(b.dataset.caso))
  );
}

/* ─────────── Configurador ─────────── */

function abrirConfigurador(casoId) {
  estado.caso = estado.casos.find((c) => c.id === casoId);
  estado.rolId = null;
  $('#config-titulo').textContent = estado.caso.titulo;
  $('#config-sub').textContent = estado.caso.subtitulo || '';
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
  ir('configurar');
}

$$('.opcion[data-campo]').forEach((b) =>
  b.addEventListener('click', () => {
    const campo = b.dataset.campo;
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
      body: JSON.stringify({ casoId: estado.caso.id, rolId: estado.rolId }),
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
  if (av.cliente) {
    try { await av.cliente.stopStreaming(); } catch {}
  }
  av.cliente = null;
  av.activo = false;
  ocultarAvatar();
}

async function iniciarAvatar() {
  await pararAvatar();
  if (!estado.caso || !estado.rolId) return;

  mostrarEstadoAvatar('Conectando el avatar…');
  const nombre = $('#avatar-nombre');
  if (nombre) nombre.textContent = estado.briefing ? estado.briefing.contraparte.nombre : '—';

  try {
    const [anam, r] = await Promise.all([
      cargarAnamSDK(),
      fetch(`${API}/api/avatar-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ casoId: estado.caso.id, rolId: estado.rolId }),
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
    cliente.addListener(anam.AnamEvent.CONNECTION_CLOSED, () => { estado.avatar.activo = false; });

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
  const esLaMismaSesion =
    estado.mensajes.length &&
    !estado.terminada &&
    estado.sesionCasoId === estado.caso.id &&
    estado.sesionRolId === estado.rolId;
  if (esLaMismaSesion) { ir('sala'); iniciarAvatar(); return; }

  estado.mensajes = [];
  estado.terminada = false;
  estado.sesionCasoId = estado.caso.id;
  estado.sesionRolId = estado.rolId;
  $('#conversacion').innerHTML = '';
  $('#sala-caso').textContent = estado.caso.titulo;
  $('#sala-yo').textContent = estado.briefing.rol.nombre;
  $('#sala-simulacion').textContent = estado.briefing.contraparte.nombre;
  $('#sala-dureza').textContent = NOMBRE_DUREZA[estado.config.dureza];
  $('#sala-color').textContent = NOMBRE_COLOR[estado.config.color];
  $('#sala-turnos').textContent = '0';
  $('#sala-recordatorio').innerHTML = md(estado.briefing.rol.briefing);
  $('#btn-tiempo-muerto').classList.toggle('oculto', estado.config.modo !== 'coach');
  ir('sala');
  iniciarAvatar();
  hablarConSimulacion();
}

$('#btn-a-la-sala').addEventListener('click', entrarEnLaSala);
$('#btn-prep-a-la-sala').addEventListener('click', entrarEnLaSala);

$('#btn-salir').addEventListener('click', () => {
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

  // Si tarda demasiado, casi siempre es que el servidor estaba dormido.
  const avisoLento = setTimeout(() => {
    if (!acumulado) {
      caja.innerHTML =
        '<span class="escribiendo"><i></i><i></i><i></i></span>' +
        '<div style="color:var(--tenue);font-size:.85rem;margin-top:8px">Despertando el servidor, un momento…</div>';
    }
  }, 7000);
  try {
    const r = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        casoId: estado.caso.id,
        rolId: estado.rolId,
        config: estado.config,
        mensajes: estado.mensajes,
      }),
    });

    clearTimeout(avisoLento);

    if (!r.ok) {
      let mensaje = 'No se ha podido contactar con la simulación.';
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

    const enviarAlAvatar = (texto, esUltimo = false) => {
      if (!avatarDisponible || esModoInforme || !flujoAvatar) return;
      if (!texto && !esUltimo) return;
      try {
        if (flujoAvatar.isActive()) flujoAvatar.streamMessageChunk(texto, esUltimo);
      } catch (err) { console.error('Avatar (talkStream):', err); }
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
    if (flujoAvatar) {
      try { if (flujoAvatar.isActive()) await flujoAvatar.endMessage(); } catch {}
    }

    if (!acumulado) {
      caja.innerHTML = '<span style="color:var(--rojo)">La simulación no ha respondido. Reintenta.</span>';
      return;
    }

    estado.mensajes.push({ role: 'assistant', content: acumulado });

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
    caja.innerHTML = `<span style="color:var(--rojo)">Error de conexión: ${escapar(String(err.message || err))}</span>`;
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
  if (!t || estado.ocupado) return;
  if (estado.terminada && !/repetir/i.test(t)) {
    turno('sistema', 'La simulación ya está cerrada. Vuelve a la biblioteca para empezar otra.', '');
    return;
  }
  estado.mensajes.push({ role: 'user', content: t });
  turno('mio', t, 'Tú');
  $('#entrada').value = '';
  hablarConSimulacion();
}

$('#btn-enviar').addEventListener('click', () => enviar($('#entrada').value));
$('#entrada').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar($('#entrada').value); }
});
$$('[data-atajo]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.atajo.startsWith('FIN') && !confirm('Se cerrará la negociación y la simulación entregará el informe. ¿Continuar?')) return;
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
    btn.title = 'Dictar por voz';
  };

  const marcarEscuchando = () => {
    escuchando = true;
    btn.classList.add('grabando');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = '⏹';
    btn.title = 'Detener el dictado';
  };

  btn.addEventListener('click', () => {
    if (escuchando) {
      if (reconocimiento) reconocimiento.stop();
      return;
    }
    if (estado.ocupado) return;

    reconocimiento = new MotorDictado();
    reconocimiento.lang = 'es-ES';
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
        alert('No se ha podido acceder al micrófono. Revisa los permisos del navegador para este sitio.');
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

const CLAVE_PREP = 'negociador-preparacion-v1';

function leerPrep() {
  try { return JSON.parse(localStorage.getItem(CLAVE_PREP)) || {}; } catch { return {}; }
}
function escribirPrep(datos) {
  localStorage.setItem(CLAVE_PREP, JSON.stringify(datos));
  const aviso = $('#aviso-guardado');
  aviso.classList.add('visible');
  clearTimeout(escribirPrep._t);
  escribirPrep._t = setTimeout(() => aviso.classList.remove('visible'), 1200);
}

function guardarVariablesEnPreparacion(variables) {
  const datos = leerPrep();
  datos.variables = variables;
  escribirPrep(datos);
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
  localStorage.removeItem(CLAVE_PREP);
  $$('[data-prep]').forEach((el) => (el.value = ''));
});

/* ─── Descarga de la hoja en PDF ───
   Se genera en el navegador con jsPDF, replicando los colores y la
   estructura de la web. Los huecos sin rellenar salen como "No contestado". */

const SIN_RESPUESTA = 'No contestado';

const COLOR_PDF = {
  fondo: [13, 16, 22],
  fondo2: [20, 25, 34],
  superficie: [25, 31, 42],
  borde: [40, 48, 61],
  texto: [232, 234, 238],
  tenue: [152, 163, 179],
  acento: [224, 164, 88],
};

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

/* Valor de un campo; cadena vacía si no hay nada escrito. */
function valorPrep(id) {
  const el = document.getElementById(id);
  const s = el && typeof el.value === 'string' ? el.value.trim() : '';
  return s;
}

function variablesPrep() {
  const datos = leerPrep();
  return datos.variables && datos.variables.length ? datos.variables : ['', '', '', '', ''];
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
    doc.text('Negociador Implacable · simulador docente de negociación', M, ALTO_PAG - 10);
    doc.text(String(pos.pagina), ANCHO_PAG - M, ALTO_PAG - 10, { align: 'right' });
  };
  const saltarPagina = () => { pie(); doc.addPage(); pos.pagina++; fondo(); pos.y = M + 8; };
  const espacio = (alto) => { if (pos.y + alto > LIMITE) saltarPagina(); };

  const cabecera = (tituloDoc, filasMeta) => {
    fondo();
    pos.y = M + 6;
    doc.setFillColor(...COLOR_PDF.acento);
    doc.circle(M + 1.6, pos.y - 1.4, 1.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...COLOR_PDF.acento);
    doc.text('NEGOCIADOR IMPLACABLE', M + 5.6, pos.y);
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

async function descargarHojaPdf() {
  const JsPDF = await cargarJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  const pdf = crearConstructorPdf(doc);

  pdf.cabecera('Hoja de preparación', [
    ['Caso', estado.caso ? estado.caso.titulo : ''],
    ['Mi papel', estado.briefing ? estado.briefing.rol.nombre : ''],
    ['Fecha', new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })],
  ]);

  const variables = variablesPrep();
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
  doc.save('hoja-preparacion-negociacion.pdf');
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

async function descargarInformePdf(textoInforme) {
  const JsPDF = await cargarJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
  const pdf = crearConstructorPdf(doc);

  pdf.cabecera('Informe de la negociación', [
    ['Caso', estado.caso ? estado.caso.titulo : ''],
    ['Mi papel', estado.briefing ? estado.briefing.rol.nombre : ''],
    ['Simulación', estado.briefing ? estado.briefing.contraparte.nombre : ''],
    ['Fecha', new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })],
  ]);

  renderizarInformeEnPdf(pdf, textoInforme);

  pdf.pie();
  doc.save('informe-negociacion.pdf');
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
function descargarHojaMarkdown() {
  const v = valorPrep;
  const oNo = (s) => (s ? s : SIN_RESPUESTA);
  const variables = variablesPrep();

  let t = '# Hoja de preparación de la negociación\n\n';
  t += `**Caso**: ${oNo(estado.caso ? estado.caso.titulo : '')}\n\n`;
  t += `**Mi papel**: ${oNo(estado.briefing ? estado.briefing.rol.nombre : '')}\n\n`;

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
  a.download = 'hoja-preparacion-negociacion.md';
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

/* ─────────── Arranque ─────────── */

// Deja un primer registro en el historial para que la flecha "atrás" tenga
// a dónde volver desde el principio (ver ir()/popstate más arriba).
history.replaceState({ vista: 'inicio' }, '', '#inicio');

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

cargarCasos();
montarTablasPreparacion();
