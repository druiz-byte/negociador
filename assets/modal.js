/* Negociador Implacable — ventana emergente con la rúbrica.

   En la página de Competición, el enlace «marco» (data-abrir-rubrica) abre
   esta ventana en lugar de navegar a la sección «El marco», para que el
   participante consulte cómo se puntúa sin perder lo que estaba haciendo.
   Se cierra con la ×, con el botón «Entendido», con Esc o pulsando fuera. */

(function () {
  const DIMENSIONES = [
    ['Preparación y objetivos', '¿Llegó con óptimo, satisfactorio y mínimo por variable?',
      'Improvisa; no distingue lo que quiere de lo que aceptaría.',
      'Rango claro por variable; sabe en todo momento dónde está respecto a su mínimo.'],
    ['MAAN', '¿Conoce su alternativa y la usa como poder? ¿Explora la de la contraparte?',
      'Negocia como si el acuerdo fuera obligatorio.',
      'Usa su MAAN para sostener posiciones y sondea el de la contraparte.'],
    ['Preguntas y exploración', '¿Dirige con preguntas? ¿Pasa de la posición a la necesidad?',
      'Habla más de lo que pregunta; solo preguntas cerradas.',
      'Pregunta para averiguar, comprender, construir y concretar; descubre una necesidad no declarada.'],
    ['Escucha activa y autocontrol', '¿Verifica, resume, usa el silencio, mantiene la calma?',
      'Interrumpe y reacciona a la provocación.',
      'Resume con las palabras del otro, verifica antes de avanzar y no se descoloca.'],
    ['Gestión de variables y toma y daca', 'El corazón de la negociación.',
      'Negocia una sola variable (normalmente el precio).',
      'Negocia en paquete y concede siempre en formato «si tú… entonces yo…».'],
    ['Disciplina de concesiones', '¿Concesiones decrecientes y a cambio de algo?',
      'Concede sin contrapartida o con concesiones crecientes.',
      'Concesiones decrecientes y siempre a cambio de algo.'],
    ['Tácticas y contratácticas', '¿Detecta lo que le están haciendo y responde?',
      'No detecta las tácticas y cae en ellas.',
      'Identifica la táctica y aplica la contratáctica adecuada sin perder el foco.'],
    ['Cierre y concreción', 'Nada está acordado hasta que todo está acordado.',
      'Cierra sin resumir; acuerdos ambiguos.',
      'Resume el paquete completo punto por punto y pide confirmación explícita.'],
  ];

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const ESTILO = `
    .modal-rubrica { position: fixed; inset: 0; z-index: 180; display: flex; align-items: center; justify-content: center;
      background: rgba(5, 7, 10, .78); backdrop-filter: blur(3px); padding: 16px; }
    .modal-rubrica .caja { background: var(--fondo-2); border: 1px solid var(--borde); border-radius: 14px;
      max-width: 860px; width: 100%; max-height: calc(100vh - 32px); overflow-y: auto; padding: 26px 28px;
      box-shadow: 0 20px 60px rgba(0,0,0,.5); position: relative; }
    .modal-rubrica h2 { font-size: 1.3rem; margin-right: 40px; }
    .modal-rubrica .cerrar { position: absolute; top: 14px; right: 14px; width: 34px; height: 34px; border-radius: 50%;
      background: var(--superficie); border: 1px solid var(--borde); color: var(--texto); font-size: 1.2rem; cursor: pointer; line-height: 1; }
    .modal-rubrica .cerrar:hover { border-color: var(--acento); }
    .modal-rubrica .intro { color: var(--tenue); font-size: .92rem; margin: 0 0 14px; }
    .modal-rubrica table { width: 100%; border-collapse: collapse; font-size: .86rem; }
    .modal-rubrica th, .modal-rubrica td { border: 1px solid var(--borde); padding: 8px 10px; text-align: left; vertical-align: top; }
    .modal-rubrica th { background: var(--superficie); font-weight: 600; }
    .modal-rubrica td small { color: var(--tenue); display: block; margin-top: 2px; }
    .modal-rubrica .nota-baja { color: #f0a9a4; }
    .modal-rubrica .nota-alta { color: var(--verde); }
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

  let modal = null;
  let anteriorFoco = null;

  function construir() {
    const s = document.createElement('style');
    s.textContent = ESTILO;
    document.head.appendChild(s);

    modal = document.createElement('div');
    modal.className = 'modal-rubrica oculto';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'modal-rubrica-titulo');
    modal.innerHTML = `
      <div class="caja">
        <button class="cerrar" type="button" aria-label="Cerrar" data-cerrar-modal>×</button>
        <h2 id="modal-rubrica-titulo">Las ocho dimensiones de la rúbrica</h2>
        <p class="intro">Cada dimensión se puntúa de 1 a 5 (máximo 40) y cada nota va acompañada de una cita
          literal de lo que dijiste. Sin evidencia, la nota es baja.</p>
        <table>
          <thead><tr><th>Dimensión</th><th>1 · lo que resta</th><th>4–5 · lo que suma</th></tr></thead>
          <tbody>${DIMENSIONES.map(([d, q, baja, alta], i) => `<tr>
            <td><strong>${i + 1}. ${esc(d)}</strong><small>${esc(q)}</small></td>
            <td class="nota-baja">${esc(baja)}</td>
            <td class="nota-alta">${esc(alta)}</td></tr>`).join('')}</tbody>
        </table>
        <div class="pie">
          <button class="boton fantasma" type="button" data-ir="marco" data-cerrar-modal>Ver el marco completo</button>
          <button class="boton" type="button" data-cerrar-modal>Entendido</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    // Pulsar fuera de la caja cierra; los botones con data-cerrar-modal también
    // (el de «Ver el marco completo» además navega, gracias a su data-ir).
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-cerrar-modal]')) cerrar();
    });
  }

  function abrir() {
    if (!modal) construir();
    anteriorFoco = document.activeElement;
    modal.classList.remove('oculto');
    document.body.classList.add('modal-abierto');
    modal.querySelector('.cerrar').focus();
  }

  function cerrar() {
    if (!modal || modal.classList.contains('oculto')) return;
    modal.classList.add('oculto');
    document.body.classList.remove('modal-abierto');
    if (anteriorFoco && anteriorFoco.focus) anteriorFoco.focus();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-abrir-rubrica]');
    if (a) { e.preventDefault(); abrir(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
})();
