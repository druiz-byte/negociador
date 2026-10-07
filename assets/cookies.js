/* Negociador Implacable — consentimiento de cookies y aviso de IA.

   Google Analytics NO se carga hasta que la persona lo acepta. Hasta que
   decide, se muestra la "puerta" (index.html, #puerta) con el aviso de que
   va a hablar con una IA y las dos opciones, igual de visibles: aceptar o
   rechazar la analítica. Las dos dejan entrar: no es un muro de cookies.

   La elección se guarda en el navegador 12 meses y se puede cambiar en
   cualquier momento desde "Configurar cookies", en el pie. */

(function () {
  const CLAVE = 'negociador-cookies-v1';
  const ID_GA = 'G-4LYE7GV8KP';
  const VIGENCIA_MS = 365 * 24 * 3600 * 1000;
  const VISTAS_LEGALES = ['aviso-legal', 'privacidad', 'cookies'];

  function leer() {
    try {
      const e = JSON.parse(localStorage.getItem(CLAVE));
      if (!e || !e.valor || !e.fecha) return null;
      if (Date.now() - new Date(e.fecha).getTime() > VIGENCIA_MS) return null;
      return e;
    } catch {
      return null;
    }
  }

  function guardar(valor) {
    try {
      localStorage.setItem(CLAVE, JSON.stringify({ valor, fecha: new Date().toISOString() }));
    } catch {}
  }

  function cargarAnalitica() {
    if (window.__negociadorGA) return;
    window.__negociadorGA = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', ID_GA);
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID_GA;
    document.head.appendChild(s);
  }

  function borrarCookiesAnalitica() {
    const partes = location.hostname.split('.');
    const dominios = ['', location.hostname];
    for (let i = 1; i < partes.length - 1; i++) dominios.push('.' + partes.slice(i).join('.'));
    dominios.push('.' + location.hostname);
    document.cookie.split(';').forEach((c) => {
      const nombre = c.split('=')[0].trim();
      if (!/^_ga/.test(nombre)) return;
      dominios.forEach((d) => {
        document.cookie = `${nombre}=; Max-Age=0; path=/${d ? '; domain=' + d : ''}`;
      });
    });
  }

  function vistaActual() {
    return (location.hash || '').replace('#', '');
  }

  function mostrar() {
    const puerta = document.getElementById('puerta');
    if (!puerta) return;
    puerta.classList.remove('oculto');
    actualizarModo();
    const b = document.getElementById('puerta-aceptar');
    if (b && !document.body.classList.contains('puerta-discreta')) b.focus();
  }

  function ocultar() {
    const puerta = document.getElementById('puerta');
    if (puerta) puerta.classList.add('oculto');
    document.body.classList.remove('puerta-abierta', 'puerta-discreta');
  }

  /* En las páginas legales la puerta se muestra como una barra abajo, para
     que se puedan leer antes de decidir. En el resto, como ventana. */
  function actualizarModo() {
    const puerta = document.getElementById('puerta');
    if (!puerta || puerta.classList.contains('oculto')) return;
    const legal = VISTAS_LEGALES.includes(vistaActual());
    document.body.classList.toggle('puerta-discreta', legal);
    document.body.classList.toggle('puerta-abierta', !legal);
  }

  function decidir(valor) {
    const antes = leer();
    guardar(valor);
    ocultar();
    if (valor === 'aceptadas') cargarAnalitica();
    else if (antes && antes.valor === 'aceptadas') {
      // Retira el consentimiento: borra sus cookies y recarga para descargar el script.
      borrarCookiesAnalitica();
      location.reload();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const aceptar = document.getElementById('puerta-aceptar');
    const rechazar = document.getElementById('puerta-rechazar');
    if (aceptar) aceptar.addEventListener('click', () => decidir('aceptadas'));
    if (rechazar) rechazar.addEventListener('click', () => decidir('rechazadas'));
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-abrir-cookies]');
      if (b) { e.preventDefault(); mostrar(); }
    });
    window.addEventListener('negociador:vista', actualizarModo);

    const e = leer();
    if (!e) mostrar();
    else if (e.valor === 'aceptadas') cargarAnalitica();
  });

  window.NegociadorCookies = { abrir: mostrar };
})();
