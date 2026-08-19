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
  config: { modo: 'evaluador', dureza: 2, color: 'oculto' },
  briefing: null,
  mensajes: [],
  ocupado: false,
  terminada: false,
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

function ir(vista) {
  $$('.vista').forEach((v) => v.classList.toggle('activa', v.id === `vista-${vista}`));
  $$('nav.principal button').forEach((b) =>
    b.setAttribute('aria-current', String(b.dataset.ir === vista))
  );
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (vista === 'preparacion') { montarTablasPreparacion(); actualizarNotaPrep(); }
}

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

function entrarEnLaSala() {
  // Sin caso configurado no hay sala: mandamos a elegir uno.
  if (!estado.caso || !estado.briefing) {
    const nota = $('#nota-prep');
    if (nota) nota.textContent = 'Elige antes un caso y tu papel.';
    ir('casos');
    return;
  }
  // Si ya hay una negociación en curso, volvemos a ella sin reiniciarla.
  if (estado.mensajes.length && !estado.terminada) { ir('sala'); return; }

  estado.mensajes = [];
  estado.terminada = false;
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
  hablarConSimulacion();
}

$('#btn-a-la-sala').addEventListener('click', entrarEnLaSala);
$('#btn-prep-a-la-sala').addEventListener('click', entrarEnLaSala);

$('#btn-salir').addEventListener('click', () => {
  if (estado.mensajes.length && !estado.terminada) {
    if (!confirm('Vas a salir de la negociación en curso. ¿Seguro?')) return;
  }
  ir('casos');
});

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
              acumulado += ev.delta.text;
              caja.textContent = acumulado;
              $('#conversacion').scrollTop = $('#conversacion').scrollHeight;
            }
          } catch {}
        }
      }
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
      turno('sistema', 'Simulación cerrada. Puedes repetir el caso con otra configuración desde la biblioteca.', '');
    }
  } catch (err) {
    caja.innerHTML = `<span style="color:var(--rojo)">Error de conexión: ${escapar(String(err.message || err))}</span>`;
  } finally {
    clearTimeout(avisoLento);
    estado.ocupado = false;
    $('#btn-enviar').disabled = false;
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

async function descargarHojaPdf() {
  const JsPDF = await cargarJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });

  const ANCHO_PAG = 210, ALTO_PAG = 297, M = 16;
  const ancho = ANCHO_PAG - M * 2;
  const LIMITE = ALTO_PAG - 20;
  let y = 0, pagina = 1;

  const fondo = () => { doc.setFillColor(...COLOR_PDF.fondo); doc.rect(0, 0, ANCHO_PAG, ALTO_PAG, 'F'); };
  const pie = () => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...COLOR_PDF.tenue);
    doc.text('Negociador Implacable · simulador docente de negociación', M, ALTO_PAG - 10);
    doc.text(String(pagina), ANCHO_PAG - M, ALTO_PAG - 10, { align: 'right' });
  };
  const saltarPagina = () => { pie(); doc.addPage(); pagina++; fondo(); y = M + 8; };
  const espacio = (alto) => { if (y + alto > LIMITE) saltarPagina(); };

  fondo();
  y = M + 6;

  /* ── Cabecera ── */
  doc.setFillColor(...COLOR_PDF.acento);
  doc.circle(M + 1.6, y - 1.4, 1.5, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...COLOR_PDF.acento);
  doc.text('NEGOCIADOR IMPLACABLE', M + 5.6, y);
  y += 10;
  doc.setFontSize(19); doc.setTextColor(...COLOR_PDF.texto);
  doc.text('Hoja de preparación', M, y);
  y += 8;

  const meta = [
    ['Caso', estado.caso ? estado.caso.titulo : ''],
    ['Mi papel', estado.briefing ? estado.briefing.rol.nombre : ''],
    ['Fecha', new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })],
  ];
  const altoMeta = meta.length * 6 + 6;
  doc.setFillColor(...COLOR_PDF.fondo2);
  doc.setDrawColor(...COLOR_PDF.borde); doc.setLineWidth(0.2);
  doc.roundedRect(M, y - 1, ancho, altoMeta, 2, 2, 'FD');
  y += 4;
  meta.forEach(([etiqueta, valor], i) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.setTextColor(...COLOR_PDF.tenue);
    doc.text(etiqueta, M + 4, y);
    const vacio = !valor;
    doc.setFont('helvetica', vacio ? 'normal' : 'bold');
    doc.setTextColor(...(vacio ? COLOR_PDF.tenue : COLOR_PDF.texto));
    doc.text(vacio ? SIN_RESPUESTA : valor, ANCHO_PAG - M - 4, y, { align: 'right' });
    if (i < meta.length - 1) {
      doc.setDrawColor(...COLOR_PDF.borde);
      doc.line(M + 4, y + 1.8, ANCHO_PAG - M - 4, y + 1.8);
    }
    y += 6;
  });
  y += 8;

  /* ── Ayudas de dibujo ── */
  const seccion = (numero, titulo, sub) => {
    espacio(20);
    doc.setFillColor(...COLOR_PDF.acento);
    doc.rect(M, y - 4, 1.8, 5.4, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...COLOR_PDF.texto);
    const t = `${numero} · ${titulo}`;
    doc.text(t, M + 5, y);
    if (sub) {
      const w = doc.getTextWidth(t);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.setTextColor(...COLOR_PDF.tenue);
      doc.text(sub, M + 5 + w + 3, y);
    }
    y += 7;
  };

  const tabla = (cabeceras, filas, anchos) => {
    const alto = 7;
    const cabecera = () => {
      espacio(alto + 8);
      doc.setFillColor(...COLOR_PDF.superficie);
      doc.setDrawColor(...COLOR_PDF.borde); doc.setLineWidth(0.2);
      doc.rect(M, y - 4.4, ancho, alto, 'FD');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...COLOR_PDF.tenue);
      let x = M;
      cabeceras.forEach((c, i) => {
        if (i) doc.line(x, y - 4.4, x, y - 4.4 + alto);
        doc.text(String(c).toUpperCase(), x + 2, y);
        x += anchos[i];
      });
      y += alto;
    };
    cabecera();
    filas.forEach((fila) => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      const celdas = fila.map((t, i) => doc.splitTextToSize(String(t), anchos[i] - 4));
      const nLineas = celdas.reduce((m, c) => Math.max(m, c.length), 1);
      const altoFila = Math.max(alto, nLineas * 4 + 3);
      if (y - 4.4 + altoFila > LIMITE) { saltarPagina(); cabecera(); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); }
      doc.setFillColor(...COLOR_PDF.fondo2);
      doc.setDrawColor(...COLOR_PDF.borde); doc.setLineWidth(0.2);
      doc.rect(M, y - 4.4, ancho, altoFila, 'FD');
      let x = M;
      celdas.forEach((lineas, i) => {
        if (i) doc.line(x, y - 4.4, x, y - 4.4 + altoFila);
        doc.setTextColor(...(fila[i] === SIN_RESPUESTA ? COLOR_PDF.tenue : COLOR_PDF.texto));
        lineas.forEach((l, j) => doc.text(l, x + 2, y + j * 4));
        x += anchos[i];
      });
      y += altoFila;
    });
    y += 8;
  };

  const campo = (etiqueta, valor) => {
    const vacio = !valor;
    const texto = vacio ? SIN_RESPUESTA : valor;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    const lineas = doc.splitTextToSize(texto, ancho - 8);
    espacio(6 + lineas.length * 5 + 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...COLOR_PDF.tenue);
    doc.text(etiqueta.toUpperCase(), M, y);
    y += 5;
    const arriba = y - 3.4;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    doc.setTextColor(...(vacio ? COLOR_PDF.tenue : COLOR_PDF.texto));
    lineas.forEach((l) => { doc.text(l, M + 4, y); y += 5; });
    doc.setDrawColor(...(vacio ? COLOR_PDF.borde : COLOR_PDF.acento));
    doc.setLineWidth(0.6);
    doc.line(M + 0.6, arriba, M + 0.6, y - 4.4);
    doc.setLineWidth(0.2);
    y += 5;
  };

  /* ── Contenido ── */
  const variables = variablesPrep();
  const oNo = (s) => (s ? s : SIN_RESPUESTA);

  seccion('1', 'Mis objetivos por variable', 'óptimo, satisfactorio, mínimo');
  tabla(
    ['Variable', 'Óptimo', 'Satisfactorio', 'Mínimo'],
    variables.map((_, i) => [
      oNo(valorPrep(`obj-${i}-var`)),
      oNo(valorPrep(`obj-${i}-opt`)),
      oNo(valorPrep(`obj-${i}-sat`)),
      oNo(valorPrep(`obj-${i}-min`)),
    ]),
    [46, 44, 44, 44]
  );

  seccion('2', 'Coste e importancia', 'el mapa del toma y daca');
  tabla(
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

  seccion('3', 'MAAN', 'mi alternativa y la suya');
  campo('Mi mejor alternativa si no hay acuerdo', valorPrep('p-maan-mio'));
  campo('Su alternativa probable', valorPrep('p-maan-suyo'));

  seccion('4', 'Posición, intereses, necesidad');
  campo('Lo que dirán que quieren', valorPrep('p-posicion'));
  campo('Lo que probablemente les mueve', valorPrep('p-intereses'));
  campo('Lo que de verdad necesitan', valorPrep('p-necesidad'));

  seccion('5', 'Mis preguntas', 'por escrito, como manda el marco');
  campo('Para averiguar', valorPrep('p-preg-averiguar'));
  campo('Para comprender', valorPrep('p-preg-comprender'));
  campo('Para construir', valorPrep('p-preg-construir'));
  campo('Para concretar', valorPrep('p-preg-concretar'));
  campo('La pregunta más difícil que me pueden hacer, y mi respuesta', valorPrep('p-preg-dificil'));

  seccion('6', 'Mi apertura', 'y los tres primeros movimientos');
  campo('Oferta inicial', valorPrep('p-apertura'));
  campo('Movimiento 2', valorPrep('p-mov2'));
  campo('Movimiento 3', valorPrep('p-mov3'));
  campo('Tácticas que espero y mi respuesta', valorPrep('p-tacticas'));

  pie();
  doc.save('hoja-preparacion-negociacion.pdf');
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
