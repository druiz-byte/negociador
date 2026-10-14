/* Negociador Implacable — ventanas emergentes de consulta.

   Dos ventanas, para consultar las reglas sin perder lo que se está haciendo:
   - La rúbrica: el enlace «marco» de las reglas de competición
     (data-abrir-rubrica), en vez de navegar a la sección «El marco».
   - Cómo se puntúa: el enlace del bloque de competición del configurador
     (data-desplazar-reglas), en vez de saltar a la página de Competición.
     Su contenido se copia de las reglas publicadas en esa página
     (#reglas-competicion), así que no hay dos versiones que mantener.
   Se cierran con la ×, con el botón «Entendido», con Esc o pulsando fuera. */

(function () {
  // Rúbrica del caso Tecnobit «Operación Punto Crítico» (la misma que usa el
  // evaluador en negociador-api/src/casos.js): competencia, peso y qué se observa.
  const COMPETENCIAS = [
    ['Preparación y estrategia', 10, 'Llega con objetivos, límites y alternativas claros; sabe qué necesita, qué puede ceder y qué pedirá a cambio.'],
    ['Exploración de intereses', 20, 'Investiga las necesidades reales del cliente, qué hay detrás de cada exigencia y cómo decide, en lugar de quedarse en las posiciones.'],
    ['Escucha y adaptación', 10, 'Recoge lo que dice el cliente, verifica, resume y ajusta su propuesta a la información nueva.'],
    ['Argumentación de valor', 10, 'Explica el valor y los riesgos de cada opción con argumentos verificables.'],
    ['Gestión de presión', 10, 'Mantiene la calma y una relación constructiva ante la urgencia y la amenaza de cambiar de proveedor, sin ceder por ello.'],
    ['Gestión de concesiones', 15, 'Concede de forma condicionada («si vosotros…, nosotros…»), dentro de sus límites autorizados y a cambio de contrapartidas verificables.'],
    ['Creación de alternativas', 15, 'Genera opciones que satisfacen intereses de ambas partes.'],
    ['Cierre y compromisos', 10, 'Cierra un acuerdo concreto y ejecutable: qué, cuándo, precio, aportación de cada parte, autorizaciones pendientes y formalización.'],
  ];
  const NIVELES = [
    ['1 · Reactivo', 'Responde a las exigencias sin explorar ni preparar alternativas.'],
    ['2 · Básico', 'Identifica algunas necesidades, pero negocia principalmente desde posiciones.'],
    ['3 · Competente', 'Explora intereses, argumenta valor y plantea intercambios razonables.'],
    ['4 · Avanzado', 'Identifica prioridades ocultas, construye alternativas y gestiona eficazmente las concesiones.'],
    ['5 · Experto', 'Integra intereses, riesgos, valor económico y relación comercial en un acuerdo sólido y ejecutable.'],
  ];

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const ESTILO = `
    .modal-rubrica { position: fixed; inset: 0; z-index: 180; display: flex; align-items: center; justify-content: center;
      background: rgba(20, 35, 50, .55); backdrop-filter: blur(3px); padding: 16px; }
    .modal-rubrica .caja { background: var(--fondo-2); border: 1px solid var(--borde); border-radius: 14px;
      max-width: 860px; width: 100%; max-height: calc(100vh - 32px); overflow-y: auto; padding: 26px 28px;
      box-shadow: 0 20px 60px rgba(28,43,58,.25); position: relative; }
    .modal-rubrica h2 { font-size: 1.3rem; margin-right: 40px; }
    .modal-rubrica .cerrar { position: absolute; top: 14px; right: 14px; width: 34px; height: 34px; border-radius: 50%;
      background: var(--superficie); border: 1px solid var(--borde); color: var(--texto); font-size: 1.2rem; cursor: pointer; line-height: 1; }
    .modal-rubrica .cerrar:hover { border-color: var(--acento); }
    .modal-rubrica .intro { color: var(--tenue); font-size: .92rem; margin: 0 0 14px; }
    .modal-rubrica table { width: 100%; border-collapse: collapse; font-size: .86rem; }
    .modal-rubrica th, .modal-rubrica td { border: 1px solid var(--borde); padding: 8px 10px; text-align: left; vertical-align: top; }
    .modal-rubrica th { background: var(--superficie); font-weight: 600; }
    .modal-rubrica td small { color: var(--tenue); display: block; margin-top: 2px; }
    .modal-rubrica .nota-baja { color: #9e322c; }
    .modal-rubrica .nota-alta { color: var(--verde); }
    .modal-rubrica .formula { font-weight: 650; color: var(--acento); background: var(--acento-suave); border-radius: 8px;
      padding: 10px 14px; margin: 0 0 12px; }
    .modal-rubrica .prosa table td small { display: inline; }
    .modal-rubrica .pie { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; margin-top: 18px; }
    body.modal-abierto { overflow: hidden; }
    @media (max-width: 640px) {
      .modal-rubrica .caja { padding: 20px 16px; }
      .modal-rubrica table, .modal-rubrica tbody, .modal-rubrica tr, .modal-rubrica td { display: block; width: 100%; }
      .modal-rubrica thead { display: none; }
      .modal-rubrica tr { margin-bottom: 12px; }
      .modal-rubrica td { border-top-width: 0; }
      .modal-rubrica td:first-child { border-top-width: 1px; background: var(--superficie); }
    }`;

  const modales = {};
  let abierto = null;
  let anteriorFoco = null;

  function crear(id, titulo, cuerpo) {
    if (!document.getElementById('estilo-modales')) {
      const s = document.createElement('style');
      s.id = 'estilo-modales';
      s.textContent = ESTILO;
      document.head.appendChild(s);
    }
    const m = document.createElement('div');
    m.className = 'modal-rubrica oculto';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', `${id}-titulo`);
    m.innerHTML = `
      <div class="caja">
        <button class="cerrar" type="button" aria-label="Cerrar" data-cerrar-modal>×</button>
        <h2 id="${id}-titulo">${titulo}</h2>
        ${cuerpo}
      </div>`;
    document.body.appendChild(m);
    // Pulsar fuera de la caja cierra; los botones con data-cerrar-modal también
    // (el de «Ver el marco completo» además navega, gracias a su data-ir).
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-cerrar-modal]')) cerrar();
    });
    return m;
  }

  function construirRubrica() {
    return crear('modal-rubrica', 'Rúbrica de competencias', `
        <p class="intro">Ocho competencias, de 1 a 5 cada una, con su peso. Cada nota va acompañada de una cita
          literal de lo que dijiste: sin evidencia, la nota es baja. La media ponderada (1–5) se multiplica por 8
          (máximo 40 puntos).</p>
        <table>
          <thead><tr><th>Competencia</th><th>Peso</th><th>Qué se observa</th></tr></thead>
          <tbody>${COMPETENCIAS.map(([c, peso, desc], i) => `<tr>
            <td><strong>${i + 1}. ${esc(c)}</strong></td>
            <td class="nota-alta"><strong>${peso} %</strong></td>
            <td>${esc(desc)}</td></tr>`).join('')}</tbody>
        </table>
        <p class="intro" style="margin-top:16px">Interpretación del nivel global:</p>
        <table>
          <tbody>${NIVELES.map(([n, d]) => `<tr><td><strong>${esc(n)}</strong></td><td>${esc(d)}</td></tr>`).join('')}</tbody>
        </table>
        <div class="pie">
          <button class="boton fantasma" type="button" data-ir="marco" data-cerrar-modal>Ver el marco completo</button>
          <button class="boton" type="button" data-cerrar-modal>Entendido</button>
        </div>`);
  }

  function construirPuntuacion() {
    const reglas = document.getElementById('reglas-competicion');
    const copia = reglas ? reglas.cloneNode(true) : document.createElement('div');
    copia.removeAttribute('id');
    const h = copia.querySelector('h3');
    if (h) h.remove();
    return crear('modal-puntuacion', 'Cómo se puntúa', `
        ${copia.innerHTML}
        <div class="pie">
          <button class="boton" type="button" data-cerrar-modal>Entendido</button>
        </div>`);
  }

  function abrir(cual) {
    if (!modales[cual]) modales[cual] = cual === 'rubrica' ? construirRubrica() : construirPuntuacion();
    // Si hay otra ventana abierta (p. ej. «marco» desde «Cómo se puntúa»), se cambia de una a otra.
    if (abierto && abierto !== modales[cual]) abierto.classList.add('oculto');
    else anteriorFoco = document.activeElement;
    abierto = modales[cual];
    abierto.classList.remove('oculto');
    document.body.classList.add('modal-abierto');
    abierto.querySelector('.cerrar').focus();
  }

  function cerrar() {
    if (!abierto) return;
    abierto.classList.add('oculto');
    abierto = null;
    document.body.classList.remove('modal-abierto');
    if (anteriorFoco && anteriorFoco.focus) anteriorFoco.focus();
  }

  // El enlace «Cómo se puntúa» del configurador lo pinta app.js con su propio
  // manejador (que saltaba a la página de Competición). Lo interceptamos en la
  // fase de captura, antes de que llegue a ese manejador, para abrir la ventana.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-desplazar-reglas]');
    if (a) { e.preventDefault(); e.stopPropagation(); abrir('puntuacion'); }
  }, true);

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-abrir-rubrica]');
    if (a) { e.preventDefault(); abrir('rubrica'); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
})();
