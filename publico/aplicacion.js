(function () {
  const portal = document.body.dataset.portal;
  const claveSesion = "ContrataT-sesion";
  let usuario = cargarSesion();
  let streamCamara = null;
  let temporizadorCamaraEsp32 = null;
  let postulacionActual = null;
  let historialRecluta = null;
  let biometriaPendiente = null;
  let accesoSeleccionado = null;
  let temporizadorReenvioCodigo = null;
  let temporizadorActualizacionEnVivo = null;
  const cvSeleccionadoPorVacante = {};

  const $ = (selector, raiz = document) => raiz.querySelector(selector);
  const $$ = (selector, raiz = document) => Array.from(raiz.querySelectorAll(selector));

  iniciar();

  function iniciar() {
    configurarPestanas();
    configurarContrasenasVisibles();
    configurarRegistroInterno();
    configurarMenu();
    configurarSesion();
    configurarCamara();
    configurarVacantesRh();
    renderizar();
  }

  function configurarContrasenasVisibles() {
    // Nota: agrega el botón Mostrar/Ocultar a todas las contraseñas de login y registro.
    $$("input[type='password']").forEach((input) => {
      if (input.parentElement?.classList.contains("campo-password")) return;
      const contenedor = document.createElement("div");
      contenedor.className = "campo-password";
      input.parentNode.insertBefore(contenedor, input);
      contenedor.appendChild(input);

      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "boton-ver-password";
      boton.textContent = "Mostrar";
      boton.addEventListener("click", () => {
        const mostrar = input.type === "password";
        input.type = mostrar ? "text" : "password";
        boton.textContent = mostrar ? "Ocultar" : "Mostrar";
      });
      contenedor.appendChild(boton);
    });
  }

  function configurarRegistroInterno() {
    if (portal !== "rh" && portal !== "seguridad") return;
    const form = $("#formRegistro");
    if (!form || location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
    form.dataset.tokenValidado = "true";
    $(".campo-contrasena", form)?.classList.remove("oculto");
    const inputContrasena = $("input[name='contrasena']", form);
    if (inputContrasena) inputContrasena.disabled = false;
    $$("[data-enviar-token], [data-validar-token]", form).forEach((boton) => {
      boton.classList.add("oculto");
      boton.disabled = true;
    });
    const token = $("input[name='tokenCorreo']", form);
    if (token) {
      token.required = false;
      token.closest("label")?.classList.add("oculto");
    }
    const ayuda = $("[data-ayuda-token]", form);
    if (ayuda) ayuda.textContent = "Registro interno local: crea la contraseña directamente.";
  }

  function cargarSesion() {
    const sesion = localStorage.getItem(claveSesion);
    return sesion ? JSON.parse(sesion) : null;
  }

  function guardarSesion(nuevaSesion) {
    usuario = nuevaSesion;
    if (usuario) localStorage.setItem(claveSesion, JSON.stringify(usuario));
    else localStorage.removeItem(claveSesion);
    if (temporizadorActualizacionEnVivo) {
      clearInterval(temporizadorActualizacionEnVivo);
      temporizadorActualizacionEnVivo = null;
    }
    renderizar();
  }

  async function api(ruta, opciones = {}) {
    const respuesta = await fetch(ruta, {
      headers: { "Content-Type": "application/json", ...(opciones.headers || {}) },
      ...opciones
    });
    const datos = await respuesta.json().catch(() => null);
    if (!respuesta.ok) {
    throw new Error(datos?.mensaje || "Ocurrió un error en el servidor");
    }
    return datos;
  }

  function mensaje(texto) {
    const nodo = $("#mensaje");
    if (!nodo) return;
    nodo.textContent = texto;
    nodo.classList.add("mostrar");
    setTimeout(() => nodo.classList.remove("mostrar"), 2800);
  }

  function configurarPestanas() {
    $$("[data-auth-tab]").forEach((boton) => {
      boton.addEventListener("click", () => {
        const destino = boton.dataset.authTab;
        $$("[data-auth-tab]").forEach((tab) => tab.classList.toggle("activo", tab === boton));
        $$("[data-auth-panel]").forEach((panel) => panel.classList.toggle("oculto", panel.dataset.authPanel !== destino));
      });
    });

    $("#formLogin")?.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const datos = Object.fromEntries(new FormData(evento.currentTarget));
      try {
        const sesion = await api("/api/usuarios/sesion", {
          method: "POST",
          body: JSON.stringify({ ...datos, portal })
        });
        guardarSesion({ ...sesion, portal });
        mensaje("Bienvenido, " + sesion.nombreCompleto + ".");
      } catch (error) {
        mensaje(error.message);
        $("[data-auth-tab='registro']")?.click();
      }
    });

    $("#formRegistro")?.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      if (evento.currentTarget.dataset.tokenValidado !== "true") {
        mensaje("Primero valida el código enviado a tu correo.");
        return;
      }
      const datos = Object.fromEntries(new FormData(evento.currentTarget));
      try {
        const sesion = await api("/api/usuarios/registro", {
          method: "POST",
          body: JSON.stringify({ ...datos, portal })
        });
        guardarSesion({ ...sesion, portal });
        mensaje("Usuario guardado en MongoDB Atlas.");
      } catch (error) {
        mensaje(error.message);
      }
    });

    $("[data-enviar-token]")?.addEventListener("click", async () => {
      const form = $("#formRegistro");
      const boton = $("[data-enviar-token]", form);
      const datos = Object.fromEntries(new FormData(form));
      if (!datos.nombreCompleto || !datos.correo) {
        mensaje("Escribe nombre y correo antes de pedir el código.");
        return;
      }
      if ((portal === "rh" || portal === "seguridad") && !datos.numeroReloj) {
        mensaje("Escribe el número de reloj del empleado.");
        return;
      }
      try {
        const respuesta = await api("/api/correo/solicitar-token", {
          method: "POST",
          body: JSON.stringify({ ...datos, portal })
        });
        form.dataset.tokenValidado = "false";
        $(".campo-contrasena", form)?.classList.add("oculto");
        const inputContrasena = $("input[name='contrasena']", form);
        if (inputContrasena) {
          inputContrasena.value = "";
          inputContrasena.disabled = true;
        }
        const ayuda = $("[data-ayuda-token]", form);
        if (ayuda) {
          ayuda.textContent = respuesta.tokenPrueba
            ? "Modo prueba: tu código es " + respuesta.tokenPrueba
            : "Revisa tu correo y escribe el código recibido.";
        }
        iniciarEsperaReenvioCodigo(boton);
        mensaje(respuesta.mensaje);
      } catch (error) {
        mensaje(error.message);
      }
    });

    $("[data-validar-token]")?.addEventListener("click", async () => {
      const form = $("#formRegistro");
      const datos = Object.fromEntries(new FormData(form));
      if (!datos.correo || !datos.tokenCorreo) {
        mensaje("Escribe el correo y el codigo recibido.");
        return;
      }
      try {
        const respuesta = await api("/api/correo/validar-token", {
          method: "POST",
          body: JSON.stringify({ portal, correo: datos.correo, token: datos.tokenCorreo })
        });
        form.dataset.tokenValidado = "true";
        $(".campo-contrasena", form)?.classList.remove("oculto");
        const inputContrasena = $("input[name='contrasena']", form);
        if (inputContrasena) {
          inputContrasena.disabled = false;
          inputContrasena.focus();
        }
        const ayuda = $("[data-ayuda-token]", form);
        if (ayuda) ayuda.textContent = respuesta.mensaje;
        mensaje(respuesta.mensaje);
      } catch (error) {
        mensaje(error.message);
      }
    });
  }

  function iniciarEsperaReenvioCodigo(boton) {
    if (!boton) return;
    clearInterval(temporizadorReenvioCodigo);
    const textoOriginal = "Enviar código al correo";
    let segundos = 30;
    boton.disabled = true;
    boton.textContent = `Reenviar en ${segundos}s`;
    temporizadorReenvioCodigo = setInterval(() => {
      segundos -= 1;
      if (segundos <= 0) {
        clearInterval(temporizadorReenvioCodigo);
        boton.disabled = false;
        boton.textContent = textoOriginal;
        return;
      }
      boton.textContent = `Reenviar en ${segundos}s`;
    }, 1000);
  }

  function activarPanel(destino) {
    $$("[data-seccion]").forEach((tab) => tab.classList.toggle("activo", tab.dataset.seccion === destino));
    $$("[data-panel]").forEach((panel) => panel.classList.toggle("activo", panel.dataset.panel === destino));
  }

  function configurarMenu() {
    $$("[data-seccion]").forEach((boton) => {
      boton.addEventListener("click", async () => {
        const destino = boton.dataset.seccion;
        activarPanel(destino);

        if (portal === "recluta" && destino === "mensajeAutomatico") {
          await marcarMensajeAutomaticoLeido();
        }

        if (portal === "rh" && destino === "cancelados") {
          const badge = $("#badgeCanceladosRh");
          if (badge) {
            badge.textContent = "0";
            badge.classList.add("oculto");
          }
          await marcarNotificacionesRhLeidas();
        }
      });
    });
  }

  function configurarSesion() {
    $$("[data-recargar]").forEach((boton) => {
      boton.addEventListener("click", () => {
        window.location.reload();
      });
    });
    $$("[data-inicio]").forEach((boton) => {
      boton.addEventListener("click", () => {
        $("[data-seccion]")?.click();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
    $$("[data-cerrar]").forEach((boton) => {
      boton.addEventListener("click", () => {
        detenerCamara();
        guardarSesion(null);
        mensaje("Sesión cerrada.");
      });
    });
  }

  function configurarVacantesRh() {
    const botonAgregar = $("#botonAgregarVacante");
    const contenedorFormulario = $("#formVacanteRhContainer");
    const listaVacantes = $("#vacantesRhLista");

    botonAgregar?.addEventListener("click", () => {
      const formularioVisible = !contenedorFormulario?.classList.contains("oculto");
      if (formularioVisible) {
        contenedorFormulario?.classList.add("oculto");
        listaVacantes?.classList.remove("oculto");
        botonAgregar.textContent = "Agregar";
        return;
      }

      listaVacantes?.classList.add("oculto");
      contenedorFormulario?.classList.remove("oculto");
      botonAgregar.textContent = "Cancelar";
    });

    $("#formVacanteRh")?.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const datos = Object.fromEntries(new FormData(evento.currentTarget));
      try {
        await api("/api/rh/vacantes", {
          method: "POST",
          body: JSON.stringify({
            ...datos,
            personasNecesarias: Number(datos.personasNecesarias || 1)
          })
        });
        evento.currentTarget.reset();
        contenedorFormulario?.classList.add("oculto");
        listaVacantes?.classList.remove("oculto");
        botonAgregar && (botonAgregar.textContent = "Agregar");
        mensaje("Vacante publicada. Ya aparece en Recluta.");
        await renderizarRh();
      } catch (error) {
        mensaje(error.message);
      }
    });
  }

  function iniciarActualizacionEnVivo() {
    if (temporizadorActualizacionEnVivo) {
      clearInterval(temporizadorActualizacionEnVivo);
    }
    if (!usuario || usuario.portal !== portal) return;

    temporizadorActualizacionEnVivo = setInterval(async () => {
      if (document.hidden || !usuario || usuario.portal !== portal) return;
      try {
        await renderizar();
      } catch (error) {
        console.warn("Error al actualizar en vivo:", error.message);
      }
    }, 8000);
  }

  async function renderizar() {
    const sesionValida = usuario && usuario.portal === portal;
    // Nota: los botones de inicio/cerrar sesion solo aparecen cuando ya hay sesion iniciada.
    $(".sesion")?.classList.toggle("oculto", !sesionValida);
    $("#vistaAcceso")?.classList.toggle("oculto", Boolean(sesionValida));
    $("#vistaApp")?.classList.toggle("oculto", !sesionValida);
    if ($("#nombreUsuario")) $("#nombreUsuario").textContent = sesionValida ? usuario.nombreCompleto + (usuario.contratado || usuario.tipoUsuario === "empleado" ? " · Empleado" : "") : "Invitado";
    if (!sesionValida) {
      if (temporizadorActualizacionEnVivo) {
        clearInterval(temporizadorActualizacionEnVivo);
        temporizadorActualizacionEnVivo = null;
      }
      return;
    }

    if (portal === "recluta") {
      await renderizarRecluta();
      await actualizarContadorMensajes();
    }
    if (portal === "rh") await renderizarRh();
    if (portal === "seguridad") await renderizarSeguridad();

    iniciarActualizacionEnVivo();
  }

  async function renderizarRecluta() {
    const vacantes = await api("/api/vacantes");
    $("#totalVacantes").textContent = vacantes.length;
    $("#listaVacantes").innerHTML = usuario.contratado ? `<article class="item"><div><h3>Usuario contratado</h3><p>Tu cuenta ya está registrada como empleado de esta empresa. Puedes consultar tu historial y acceso planta. ¡Gracias por utilizar ContrataT!</p></div><span class="estado">Empleado</span></article>` : vacantes.map((vacante) => {
      const archivoSeleccionado = cvSeleccionadoPorVacante[vacante._id];
      return `
        <article class="item">
          <div>
            <h3>${vacante.titulo}</h3>
            <p>${vacante.descripcion}</p>
            <div class="meta"><span>${vacante.area}</span><span>Turno: ${vacante.turno || vacante.horario || "Pendiente"}</span><span>${vacante.horario}</span><span>${vacante.ubicacion}</span></div>
            ${archivoSeleccionado ? `
              <div class="cv-seleccionado">
                <span>${archivoSeleccionado.name || "CV seleccionado"}</span>
                <button class="boton-quitar-cv" type="button" data-quitar-cv="${vacante._id}" aria-label="Quitar CV">×</button>
              </div>
            ` : `
              <label class="campo-cv">Subir CV para RH<input type="file" accept=".pdf,.doc,.docx" data-cv="${vacante._id}"></label>
            `}
          </div>
          <button class="boton-principal" data-aplicar="${vacante._id}">Mandar CV</button>
        </article>
      `;
    }).join("");

    $$("[data-cv]").forEach((input) => {
      input.addEventListener("change", (evento) => {
        const vacanteId = evento.target.dataset.cv;
        const archivo = evento.target.files?.[0];
        if (!archivo) {
          delete cvSeleccionadoPorVacante[vacanteId];
          renderizarRecluta();
          return;
        }
        cvSeleccionadoPorVacante[vacanteId] = archivo;
        renderizarRecluta();
      });
    });

    $$("[data-quitar-cv]").forEach((boton) => {
      boton.addEventListener("click", () => {
        delete cvSeleccionadoPorVacante[boton.dataset.quitarCv];
        renderizarRecluta();
      });
    });

    $$("[data-aplicar]").forEach((boton) => {
      boton.addEventListener("click", async () => {
        const archivo = cvSeleccionadoPorVacante[boton.dataset.aplicar];
        if (!archivo) {
          mensaje("Primero selecciona tu CV para que RH lo pueda revisar.");
          return;
        }
        const cv = await archivoADataUrl(archivo);
        postulacionActual = await api("/api/postulaciones", {
          method: "POST",
          body: JSON.stringify({ reclutaId: usuario._id, vacanteId: boton.dataset.aplicar, cv })
        });
        delete cvSeleccionadoPorVacante[boton.dataset.aplicar];
        mensaje("CV enviado a RH. Espera que RH valide y de acceso.");
        $("[data-seccion='estado']")?.click();
        await renderizarRecluta();
      });
    });

    postulacionActual = await api("/api/postulaciones/recluta/" + usuario._id);
    historialRecluta = await api("/api/postulaciones/recluta/" + usuario._id + "/historial");
    if (historialRecluta?.contratado && !usuario.contratado) {
      usuario = { ...usuario, contratado: true, tipoUsuario: "empleado" };
      localStorage.setItem(claveSesion, JSON.stringify(usuario));
      if ($("#nombreUsuario")) $("#nombreUsuario").textContent = usuario.nombreCompleto + " · Empleado";
    }
    mostrarBiometriaRecluta();
    mostrarEstadoRecluta();
    mostrarMensajeAutomaticoRecluta();
    mostrarPerfilEgresadoRecluta();
    mostrarHistorialRecluta();
    actualizarBotonAccesoPlanta();
  }

  async function abrirCamaraRecluta() {
    if (!postulacionActual) {
      mensaje("Primero manda tu CV a RH.");
      return;
    }
    if (!puedeCapturarBiometria(postulacionActual)) {
      mensaje("RH todavía no ha autorizado o solicitado la captura biométrica.");
      return;
    }

    try {
      if (streamCamara) {
        detenerCamara();
      }
      streamCamara = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      $("#videoCamara").srcObject = streamCamara;
      $("#panelPrivacidadBiometria")?.classList.add("oculto");
      $("#panelPreviewBiometria")?.classList.remove("oculto");
      mensaje("Cámara activa. Coloca tu rostro al centro.");
    } catch (error) {
      mensaje("No se pudo abrir la cámara. Revisa permisos del navegador.");
    }
  }

  function configurarCamara() {
    $("#iniciarCamara")?.addEventListener("click", async () => {
      const privacidad = $("#panelPrivacidadBiometria");
      const preview = $("#panelPreviewBiometria");
      if (privacidad) {
        privacidad.classList.remove("oculto");
      }
      if (preview) {
        preview.classList.add("oculto");
      }
    });

    $("#aceptarPrivacidadCamara")?.addEventListener("click", async () => {
      const checkbox = $("#aceptaPrivacidad");
      if (!checkbox?.checked) {
        mensaje("Acepta el aviso de privacidad antes de abrir la cámara.");
        return;
      }
      await abrirCamaraRecluta();
    });

    $("#cancelarPrivacidadCamara")?.addEventListener("click", () => {
      $("#panelPrivacidadBiometria")?.classList.add("oculto");
      $("#panelPreviewBiometria")?.classList.remove("oculto");
    });

    $("#capturarFoto")?.addEventListener("click", () => {
      const video = $("#videoCamara");
      const canvas = $("#canvasCamara");
      if (!postulacionActual || !video?.srcObject) {
        mensaje("Solicita la cámara antes de capturar.");
        return;
      }
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      biometriaPendiente = canvas.toDataURL("image/png");
      mostrarBiometriaRecluta();
      detenerCamara();
      $("#capturarFoto")?.classList.add("oculto");
      $("#volverATomarFoto")?.classList.remove("oculto");
      $("#enviarFotoBiometria")?.classList.remove("oculto");
      mensaje("Foto capturada. Revisa la vista previa y envíala cuando quieras.");
    });

    $("#enviarFotoBiometria")?.addEventListener("click", async () => {
      if (!postulacionActual || !biometriaPendiente) {
        mensaje("Primero toma una foto antes de enviarla.");
        return;
      }

      const botonEnviar = $("#enviarFotoBiometria");
      if (botonEnviar) {
        botonEnviar.disabled = true;
        botonEnviar.textContent = "Enviando...";
      }

      postulacionActual = await api("/api/postulaciones/" + postulacionActual._id + "/biometria", {
        method: "PUT",
        body: JSON.stringify({ imagenBase64: biometriaPendiente, aceptoPrivacidad: true })
      });

      biometriaPendiente = null;
      if (botonEnviar) {
        botonEnviar.textContent = "Enviar foto";
        botonEnviar.disabled = false;
        botonEnviar.classList.add("oculto");
      }
      $("#volverATomarFoto")?.classList.add("oculto");
      $("#capturarFoto")?.classList.add("oculto");
      $("#botonBiometriaRecluta")?.classList.add("oculto");
      mostrarBiometriaRecluta();
      mostrarEstadoRecluta();
      mensaje("Imagen biométrica guardada para RH y Seguridad.");
    });

    $("#volverATomarFoto")?.addEventListener("click", async () => {
      const checkbox = $("#aceptaPrivacidad");
      if (checkbox) checkbox.checked = true;
      biometriaPendiente = null;
      const botonEnviar = $("#enviarFotoBiometria");
      if (botonEnviar) {
        botonEnviar.textContent = "Enviar foto";
        botonEnviar.disabled = false;
      }
      mostrarBiometriaRecluta();
      $("#volverATomarFoto")?.classList.add("oculto");
      $("#enviarFotoBiometria")?.classList.add("oculto");
      $("#capturarFoto")?.classList.remove("oculto");
      await abrirCamaraRecluta();
    });

    $("#configurarCamaraEsp32")?.addEventListener("click", () => {
  const actual = localStorage.getItem("ContrataT-esp32cam-url") || "";

  const nueva = window.prompt(
    "Configurar ESP32-CAM\n\nEscribe la URL que apareció en el Monitor Serial:",
    actual || "http://192.168.1.220"
  );

  if (nueva === null) {
    return;
  }

  const urlEsp32 = nueva.trim().replace(/\/$/, "");

  if (!urlEsp32) {
    localStorage.removeItem("ContrataT-esp32cam-url");
    mensaje("Se eliminó la configuración de la cámara.");
    return;
  }

  localStorage.setItem("ContrataT-esp32cam-url", urlEsp32);

  iniciarVistaEsp32(urlEsp32);

  mensaje("ESP32-CAM configurada correctamente.");
});

    $("#capturarSeguridad")?.addEventListener("click", capturarRostroSeguridad);
  }

  function detenerCamara() {
    if (!streamCamara) return;
    streamCamara.getTracks().forEach((track) => track.stop());
    streamCamara = null;
    if ($("#videoCamara")) $("#videoCamara").srcObject = null;
  }

  function detenerCamaraSeguridad() {
    if (temporizadorCamaraEsp32) clearInterval(temporizadorCamaraEsp32);
    temporizadorCamaraEsp32 = null;
    const vista = $("#videoSeguridad");
    if (vista) vista.removeAttribute("src");
  }

  function mostrarBiometriaRecluta() {
    const vista = $("#vistaBiometriaRecluta");
    if (!vista) return;

    const estadoEnRevision = coincideEstado(postulacionActual?.estado, "Biometria pendiente de revision RH", "Acceso listo para Seguridad", "Acceso verificado por Seguridad");
    const requiereRecaptura = coincideEstado(postulacionActual?.estado, "Biometria rechazada por RH", "Acceso autorizado por RH");
    const imagenActual = biometriaPendiente || (!estadoEnRevision && !requiereRecaptura ? postulacionActual?.biometria?.imagenBase64 : null);
    vista.innerHTML = imagenActual ? `<img src="${imagenActual}" alt="Imagen biométrica capturada">` : "Sin captura biométrica";

    const autorizado = puedeCapturarBiometria(postulacionActual);
    const botonBiometria = $("#botonBiometriaRecluta");
    if (botonBiometria) {
      const ocultarSeccion = estadoEnRevision;
      botonBiometria.classList.toggle("oculto", ocultarSeccion || !autorizado);
    }

    if (estadoEnRevision) {
      $("#panelPrivacidadBiometria")?.classList.add("oculto");
      $("#panelPreviewBiometria")?.classList.add("oculto");
      $("#botonBiometriaRecluta")?.classList.add("oculto");
    }

    $("#bloqueoCamara").textContent = autorizado
      ? "RH autorizó o solicitó tu captura biométrica. Toma la foto de frente, con buena luz y sin cubrir el rostro."
      : "La cámara se habilita cuando RH valida tu CV y da acceso a la empresa.";
    $("#iniciarCamara").disabled = !autorizado;
    $("#capturarFoto").disabled = !autorizado;
    $("#enviarFotoBiometria").disabled = !autorizado || !biometriaPendiente;

    const ocultarCaptura = Boolean(biometriaPendiente) || estadoEnRevision;
    $("#capturarFoto").classList.toggle("oculto", ocultarCaptura);
    $("#enviarFotoBiometria").classList.toggle("oculto", !biometriaPendiente || estadoEnRevision);
    $("#volverATomarFoto").classList.toggle("oculto", !biometriaPendiente || estadoEnRevision);

    const botonEnviar = $("#enviarFotoBiometria");
    if (botonEnviar) {
      botonEnviar.textContent = "Enviar foto";
      botonEnviar.disabled = !autorizado || !biometriaPendiente;
    }
  }

  function normalizarEstado(estado) {
    return (estado || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  }

  function coincideEstado(estadoActual, ...estadosEsperados) {
    const actual = normalizarEstado(estadoActual);
    return estadosEsperados.some((estado) => actual === normalizarEstado(estado));
  }

  function puedeCapturarBiometria(postulacion) {
    return coincideEstado(postulacion?.estado, "Acceso autorizado por RH") || coincideEstado(postulacion?.estado, "Biometria rechazada por RH");
  }

  function ocultarSeccionBiometria(postulacion) {
    return coincideEstado(postulacion?.estado, "Biometria pendiente de revision RH", "Acceso listo para Seguridad", "Acceso verificado por Seguridad");
  }

  function puedeCancelarPostulacion(postulacion) {
    const estadosFinalesOEntrevista = [
      "Postulación cancelada por Recluta",
      "Postulacion cancelada por Recluta",
      "Acceso negado por RH",
      "Acceso cerrado",
      "Acceso vencido",
      "Acceso verificado por Seguridad",
      "Asistio a entrevista",
      "No asistió a entrevista",
      "No asistio a entrevista",
      "No aceptado después de entrevista",
      "No aceptado despues de entrevista",
      "Perfil egresado generado"
    ];
    return postulacion && !estadosFinalesOEntrevista.some((estado) => coincideEstado(postulacion.estado, estado));
  }

  function esEstadoRechazado(estado) {
    return [
      "Acceso negado por RH",
      "Acceso negado por Seguridad",
      "Acceso vencido",
      "No asistió a entrevista",
      "No asistio a entrevista",
      "No aceptado después de entrevista",
      "No aceptado despues de entrevista",
      "Biometria rechazada por RH"
    ].some((estadoEsperado) => coincideEstado(estado, estadoEsperado));
  }

  function actualizarBotonAccesoPlanta() {
    const boton = $("#botonAccesoPlanta");
    if (!boton) return;
    const aceptado = postulacionActual?.estado === "Perfil egresado generado";
    boton.classList.toggle("oculto", !aceptado);
    if (!aceptado && boton.classList.contains("activo")) $(`[data-seccion='estado']`)?.click();
  }

  function mostrarEstadoRecluta() {
    const vista = $("#estadoPostulacion");
    if (!vista) return;

    const rechazadosHistoricos = (historialRecluta?.postulaciones || []).filter((postulacion) => esEstadoRechazado(postulacion.estado));

    if (rechazadosHistoricos.length > 1) {
      vista.innerHTML = `
        <span class="estado">Historial de rechazos</span>
        <h3>Has tenido ${rechazadosHistoricos.length} postulaciones rechazadas</h3>
        <div style="display: grid; gap: 12px; margin-top: 14px;">
          ${rechazadosHistoricos.map((postulacion, indice) => `
            <article style="padding: 16px 18px; border-radius: 14px; background: rgba(255,255,255,0.52); border: 1px solid rgba(15,118,110,0.14); box-shadow: 0 2px 8px rgba(12,32,35,0.04);">
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px;">
                <h4 style="margin: 0; font-size: 1.05rem;">${indice + 1}. ${postulacion.tituloVacante || "Vacante sin nombre"}</h4>
                <span style="padding: 5px 10px; border-radius: 999px; background: rgba(202, 84, 84, 0.12); color: #8a2c2c; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;">${postulacion.estado}</span>
              </div>
              <p style="margin: 0 0 8px; color: #2a2a2a;">${postulacion.razonRechazo ? `Razón: ${postulacion.razonRechazo}` : "Sin motivo especificado"}</p>
              <div style="display: flex; flex-wrap: wrap; gap: 10px; color: #4a4a4a; font-size: 0.82rem;">
                <span>${postulacion.areaVacante || "Área pendiente"}</span>
                <span>•</span>
                <span>${postulacion.creadaEn ? new Date(postulacion.creadaEn).toLocaleDateString("es-MX") : "Sin fecha"}</span>
              </div>
            </article>
          `).join("")}
        </div>
      `;
      return;
    }

    if (!postulacionActual) {
      vista.innerHTML = "<p>Aún no has aplicado a una vacante.</p>";
      return;
    }
    vista.innerHTML = `
      <span class="estado">${postulacionActual.estado}</span>
      <h3>${postulacionActual.tituloVacante}</h3>
      <p>CV enviado: ${postulacionActual.cv?.nombre || "Sin CV"}</p>
      <p>Entrevista: ${postulacionActual.fechaEntrevista || "Pendiente de validar biometría"} · Hora límite: ${postulacionActual.horaLimite || "Sin hora"} · Entrevistador: ${postulacionActual.entrevistador || "Sin entrevistador"}</p>
      <p>Dirección: ${postulacionActual.direccion || "Sin dirección acordada"}</p>
      <p>${postulacionActual.razonRechazo ? "Razón de rechazo: " + postulacionActual.razonRechazo : "Consulta aquí la respuesta de RH."}</p>
      ${postulacionActual.estado === "Perfil egresado generado" ? `<p><strong>Pasaste la entrevista.</strong> Día de inducción: ${postulacionActual.fechaInduccion || "Por definir"}</p><button class="boton-principal separacion" type="button" data-ir-perfil-egresado>Ver acceso planta</button>` : ""}
      ${puedeCancelarPostulacion(postulacionActual) ? `<button class="boton-peligro separacion" type="button" data-cancelar-postulacion="${postulacionActual._id}">Cancelar postulación</button>` : ""}
    `;
    $("[data-cancelar-postulacion]", vista)?.addEventListener("click", cancelarPostulacionRecluta);
    $("[data-ir-perfil-egresado]", vista)?.addEventListener("click", () => $("[data-seccion='perfilEgresadoRecluta']")?.click());
  }

  async function cancelarPostulacionRecluta() {
    if (!postulacionActual) return;
    const confirmar = confirm("¿Está seguro que desea cancelar la postulación? Se cancelará la entrevista, se eliminarán los datos biométricos y tendrá que iniciar el proceso de nuevo si quiere postular.");
    if (!confirmar) return;
    postulacionActual = await api("/api/postulaciones/" + postulacionActual._id + "/cancelar", { method: "PATCH" });
    mensaje("Postulación cancelada. RH recibió la notificación.");
    mostrarEstadoRecluta();
    mostrarMensajeAutomaticoRecluta();
    mostrarBiometriaRecluta();
    actualizarBotonAccesoPlanta();
  }


  async function actualizarContadorMensajes() {
    const contador = $("#contadorMensajes");
    if (!contador || portal !== "recluta" || !usuario?._id) return;
    try {
      const datos = await api("/api/notificaciones/recluta/" + usuario._id);
      const noLeidos = Number(datos.noLeidas || 0);
      contador.textContent = String(noLeidos);
      contador.classList.toggle("oculto", noLeidos === 0);
    } catch (error) {
      contador.classList.add("oculto");
    }
  }

  async function marcarMensajeAutomaticoLeido() {
    if (portal !== "recluta" || !usuario?._id) return;
    try {
      await api("/api/notificaciones/recluta/" + usuario._id + "/leer", { method: "PATCH" });
    } catch (error) {
      return;
    }
    await actualizarContadorMensajes();
  }

  function mostrarMensajeAutomaticoRecluta() {
    const vista = $("#mensajeAutomaticoRecluta");
    if (!vista) return;
    if (!postulacionActual) {
      vista.innerHTML = `
        <span class="estado">Sin postulación</span>
        <h3>Primero manda tu CV</h3>
        <p>Selecciona una vacante disponible, adjunta tu CV y presiona <strong>Mandar CV</strong>. RH revisará tu información.</p>
      `;
      return;
    }

    if (postulacionActual.mensajeAutomatico) {
      vista.innerHTML = `
        <span class="estado">${postulacionActual.estado}</span>
        <h3>Actualización de tu proceso</h3>
        <p>${postulacionActual.mensajeAutomatico}</p>
      `;
      return;
    }

    if (postulacionActual.estado === "Acceso autorizado por RH") {
      vista.innerHTML = `
        <span class="estado">CV validado para entrevista</span>
        <h3>Registra tus datos biométricos para agendarte una entrevista</h3>
        <p>RH validó tu CV para entrevista. Registra tus datos biométricos para agendarte una entrevista.</p>
        <div class="pasos separacion">
          <span>Entra a Datos biométricos</span>
          <span>Acepta el aviso de privacidad</span>
          <span>Solicita la cámara</span>
          <span>Captura tu rostro</span>
        </div>
        <p class="separacion">Si RH valida tu imagen biométrica, se agendará tu entrevista y se enviará el acceso a Seguridad.</p>
        <button class="boton-principal" type="button" data-ir-biometria>Ir a datos biométricos</button>
      `;
      $("[data-ir-biometria]", vista)?.addEventListener("click", () => $("[data-seccion='biometria']")?.click());
      return;
    }

    if (postulacionActual.estado === "Biometria rechazada por RH") {
      vista.innerHTML = `
        <span class="estado">Biometría rechazada por RH</span>
        <h3>Vuelve a registrar tus datos biométricos</h3>
        <p>${postulacionActual.mensajeAutomatico || "RH no validó tu imagen biométrica. Debes registrar tus datos biométricos otra vez para continuar con la entrevista."}</p>
        <div class="pasos separacion">
          <span>Entra a Datos biométricos</span>
          <span>Acepta el aviso de privacidad</span>
          <span>Solicita la cámara</span>
          <span>Captura rostro nuevamente</span>
        </div>
        <button class="boton-principal separacion" type="button" data-ir-biometria>Repetir biometría</button>
      `;
      $("[data-ir-biometria]", vista)?.addEventListener("click", () => $("[data-seccion='biometria']")?.click());
      return;
    }

    if (postulacionActual.estado === "Biometria pendiente de revision RH") {
      vista.innerHTML = `
        <span class="estado">Biometría registrada</span>
        <h3>Espera revisión de RH</h3>
        <p>Tu rostro ya fue capturado. RH debe validar la biometría para agendar tu entrevista y generar el acceso visible en Seguridad.</p>
        <p>Entrevista: pendiente hasta que RH valide tu biometría.</p>
      `;
      return;
    }

    if (postulacionActual.estado === "Acceso listo para Seguridad") {
      vista.innerHTML = `
        <span class="estado">Acceso listo para Seguridad</span>
        <h3>Tu acceso fue generado</h3>
        <p>RH validó tu biometría. Tu entrevista ya fue agendada y Seguridad podrá comparar tu rostro al llegar.</p>
        <p>Entrevista: ${postulacionActual.fechaEntrevista || "Por definir"} · Hora límite: ${postulacionActual.horaLimite || "Sin hora"} · Entrevistador: ${postulacionActual.entrevistador || "Sin entrevistador"}</p>
      `;
      return;
    }

    if (postulacionActual.estado === "Postulacion cancelada por Recluta") {
      vista.innerHTML = `
        <span class="estado">Postulación cancelada</span>
        <h3>Proceso cancelado</h3>
        <p>Cancelaste la entrevista y la postulación.</p>
        <p>Si quieres postular de nuevo, entra a Vacantes, sube tu CV y comienza el proceso otra vez.</p>
      `;
      return;
    }

    if (postulacionActual.estado === "Perfil egresado generado") {
      vista.innerHTML = `
        <span class="estado">Aceptado como nuevo ingreso</span>
        <h3>Pasaste la entrevista</h3>
        <p>Felicidades. RH creó tu acceso para iniciar inducción en el puesto <strong>${postulacionActual.tituloVacante}</strong>.</p>
          <p>Debes asistir a inducción el día: <strong>${postulacionActual.fechaInduccion || "Por definir"}</strong>.</p>
          <p>Desde ahora debes usar tu <strong>Acceso planta</strong> para entrar. Ese perfil ya contiene tu imagen validada, por eso no necesitas volver a registrar datos biométricos.</p>
        <button class="boton-principal" type="button" data-ir-perfil-egresado>Ver acceso planta</button>
      `;
      $("[data-ir-perfil-egresado]", vista)?.addEventListener("click", () => $("[data-seccion='perfilEgresadoRecluta']")?.click());
      return;
    }

    if (postulacionActual.estado === "Acceso negado por Seguridad") {
      vista.innerHTML = `
        <span class="estado">${postulacionActual.estado}</span>
        <h3>Puedes volver a postular</h3>
        <p>${postulacionActual.razonRechazo || "Seguridad no autorizó este acceso. Puedes enviar tu CV otra vez y repetir el proceso."}</p>
        <button class="boton-principal separacion" type="button" data-ir-vacantes>Volver a vacantes</button>
      `;
      $("[data-ir-vacantes]", vista)?.addEventListener("click", () => $("[data-seccion='vacantes']")?.click());
      return;
    }

    if (postulacionActual.estado.includes("negado") || postulacionActual.estado === "Acceso vencido") {
      vista.innerHTML = `
        <span class="estado">${postulacionActual.estado}</span>
        <h3>No puedes registrar biometría</h3>
        <p>${postulacionActual.razonRechazo || "RH o Seguridad no autorizó el acceso."}</p>
      `;
      return;
    }

    vista.innerHTML = `
      <span class="estado">${postulacionActual.estado}</span>
      <h3>Espera la respuesta de RH</h3>
      <p>Tu CV fue enviado a RH. Cuando RH dé acceso a la empresa, aquí aparecerá el mensaje para registrar tus datos biométricos.</p>
      <p>Consulta este apartado o la pestaña Estado para ver avances.</p>
    `;
  }

  function mostrarPerfilEgresadoRecluta() {
    const vista = $("#perfilEgresadoRecluta");
    if (!vista) return;
    if (!postulacionActual || postulacionActual.estado !== "Perfil egresado generado") {
      vista.innerHTML = "<p>Tu acceso a planta aparecerá cuando RH confirme que fuiste aceptado en el puesto.</p>";
      return;
    }
    const folioPase = String(postulacionActual?._id || "CT-IND").slice(-6).toUpperCase();
    vista.innerHTML = `
      <span class="estado">Acceso planta generado</span>
      <div class="perfil-egresado-pase separacion">
        <div class="pase-header">
          <div class="pase-titulo-wrap">
            <span class="pase-badge">ContrataT</span>
            <h3>Acceso de inducción</h3>
          </div>
          <div class="pase-logo" aria-label="Logo de ContrataT">CT</div>
        </div>
        <div class="pase-body">
          <div class="pase-foto">
            ${postulacionActual.biometria?.imagenBase64 ? `<img src="${postulacionActual.biometria.imagenBase64}" alt="Imagen biométrica de ${postulacionActual.nombreRecluta}">` : `<div class="preview">Sin imagen</div>`}
          </div>
          <div class="pase-datos">
            <p class="pase-label">Nombre</p>
            <h4>${postulacionActual.nombreRecluta}</h4>
            <p class="pase-label">Puesto</p>
            <p class="pase-puesto">${postulacionActual.tituloVacante || "Por definir"}</p>
            <div class="pase-grid">
              <div>
                <span>Día</span>
                <strong>${postulacionActual.fechaInduccion || "Por definir"}</strong>
              </div>
              <div>
                <span>Hora</span>
                <strong>${postulacionActual.horaInduccion || "09:00"}</strong>
              </div>
              <div>
                <span>Lugar</span>
                <strong>${postulacionActual.lugarInduccion || postulacionActual.ubicacionVacante || postulacionActual.direccion || "Por confirmar"}</strong>
              </div>
            </div>
          </div>
        </div>
        <div class="pase-footer">
          <div class="pase-folio">
            <span>Folio</span>
            <strong>${folioPase}</strong>
          </div>
          <button class="boton-principal boton-imprimir" type="button" data-imprimir-pase>Imprimir pase</button>
        </div>
      </div>
      <h3 class="separacion">${postulacionActual.tituloVacante}</h3>
      <article class="tarjeta separacion">
        <h3>¿Qué es su puesto?</h3>
        <p>${postulacionActual.queEsVacante || postulacionActual.areaVacante || "Puesto asignado por RH por medio de ContrataT."}</p>
      </article>
      <article class="tarjeta separacion">
        <h3>¿Qué hace en su puesto?</h3>
        <p>${postulacionActual.descripcionVacante || "Realiza las actividades asignadas al puesto y reporta avances a su responsable."}</p>
      </article>
      <div class="meta"><span>${postulacionActual.areaVacante || "Área pendiente"}</span><span>Turno: ${postulacionActual.turnoVacante || "Pendiente"}</span><span>${postulacionActual.horarioVacante || "Horario pendiente"}</span><span>${postulacionActual.ubicacionVacante || "Ubicación pendiente"}</span></div>
    `;
    $("[data-imprimir-pase]", vista)?.addEventListener("click", () => {
      const pase = $(".perfil-egresado-pase", vista);
      if (!pase) {
        window.print();
        return;
      }

      const impresion = window.open("", "_blank", "width=900,height=700");
      if (!impresion) {
        window.print();
        return;
      }

      const contenido = pase.cloneNode(true);
      impresion.document.write(`<!doctype html>
        <html lang="es">
          <head>
            <meta charset="utf-8">
            <title>Pase de inducción</title>
            <link rel="stylesheet" href="estilos.css">
            <style>
              html, body { margin: 0; padding: 0; background: #ffffff; }
              body { font-family: Arial, sans-serif; display: flex; justify-content: center; padding: 24px; }
              .perfil-egresado-pase {
                width: min(100%, 760px);
                box-shadow: none !important;
                border: 1px solid rgba(15, 118, 110, 0.12);
                border-radius: 22px;
                overflow: hidden;
                background: linear-gradient(135deg, #ffffff 0%, #effcfb 100%);
              }
              .boton-imprimir, [data-imprimir-pase] { display: none !important; }
            </style>
          </head>
          <body>
            ${contenido.outerHTML}
          </body>
        </html>
      `);
      impresion.document.close();
      impresion.focus();
      setTimeout(() => impresion.print(), 300);
    });
  }


  function mostrarHistorialRecluta() {
    const vista = $("#historialRecluta");
    if (!vista) return;
    const registros = historialRecluta?.postulaciones || [];
    if (!registros.length) {
      vista.innerHTML = "<p>Tu historial se creará cuando RH acepte o rechace tu postulación para entrevista.</p>";
      return;
    }
    const contratado = historialRecluta.contratado;
    vista.innerHTML = `
      <article class="item">
        <div>
          <h3>Resumen del recluta</h3>
          <p>Historial creado con <strong>${historialRecluta.totalAplicaciones}</strong> postulación(es) ya aceptadas o rechazadas por RH.</p>
          <div class="meta"><span>${contratado ? "Contratado" : "No contratado"}</span><span>${contratado ? "Usuario convertido a empleado" : "Sigue como recluta"}</span></div>
        </div>
        <span class="estado">${contratado ? "Empleado" : "Recluta"}</span>
      </article>
      ${registros.map((p, indice) => `
        <article class="item">
          <div>
            <h3>${indice + 1}. ${p.tituloVacante || "Vacante sin nombre"}</h3>
            <p>${p.estado}</p>
            <div class="meta"><span>${p.areaVacante || "Area pendiente"}</span><span>Turno: ${p.turnoVacante || "Pendiente"}</span><span>${p.creadaEn ? new Date(p.creadaEn).toLocaleDateString("es-MX") : "Sin fecha"}</span></div>
            ${p.razonRechazo ? `<p><strong>Razón:</strong> ${p.razonRechazo}</p>` : ""}
            ${p.fechaInduccion ? `<p><strong>Induccion:</strong> ${p.fechaInduccion}</p>` : ""}
          </div>
          <span class="estado">${p.estado === "Perfil egresado generado" ? "Contratado" : "Proceso"}</span>
        </article>
      `).join("")}
    `;
  }

  function tieneNotificacionRhSinLeer(postulacion) {
    if (!postulacion || !postulacion.notificacionRh) return false;
    return postulacion.notificacionRhLeida !== true && String(postulacion.notificacionRh).trim() !== "";
  }

  function actualizarBadgesRh(postulaciones) {
    const recibidos = postulaciones.filter((p) => p.estado === "CV enviado a RH" && tieneNotificacionRhSinLeer(p));
    const cancelados = postulaciones.filter((p) => coincideEstado(
      p.estado,
      "Postulación cancelada por Recluta",
      "Postulacion cancelada por Recluta"
    ) && tieneNotificacionRhSinLeer(p));
    const biometriaPendiente = postulaciones.filter((p) => p.estado === "Biometria pendiente de revision RH" && !coincideEstado(
      p.estado,
      "Postulación cancelada por Recluta",
      "Postulacion cancelada por Recluta",
      "Postulación cancelada por RH",
      "Postulacion cancelada por RH"
    ));

    const badgeRecibidos = $("#badgeCvRecibidos");
    const badgeCancelados = $("#badgeCanceladosRh");
    const badgeReclutar = $("#badgeReclutarRh");

    if (badgeRecibidos) {
      badgeRecibidos.textContent = String(recibidos.length);
      badgeRecibidos.classList.toggle("oculto", recibidos.length === 0);
    }

    if (badgeCancelados) {
      badgeCancelados.textContent = String(cancelados.length);
      badgeCancelados.classList.toggle("oculto", cancelados.length === 0);
    }

    if (badgeReclutar) {
      badgeReclutar.textContent = String(biometriaPendiente.length);
      badgeReclutar.classList.toggle("oculto", biometriaPendiente.length === 0);
    }
  }

  async function renderizarRh() {
    const postulaciones = await api("/api/rh/postulaciones");
    const vacantes = await api("/api/rh/vacantes");
    const canceladas = postulaciones.filter((p) => coincideEstado(
      p.estado,
      "Postulación cancelada por Recluta",
      "Postulacion cancelada por Recluta"
    ));
    const rechazadas = postulaciones.filter((p) => [
      "Acceso negado por RH",
      "Acceso negado por Seguridad",
      "Acceso vencido",
      "No asistió a entrevista",
      "No asistio a entrevista",
      "No aceptado después de entrevista",
      "No aceptado despues de entrevista"
    ].some((estado) => coincideEstado(p.estado, estado)));
    const cvRecibidos = postulaciones.filter((p) => p.estado === "CV enviado a RH" && !canceladas.includes(p) && !rechazadas.includes(p));
    const biometriaPendiente = postulaciones.filter((p) => p.estado === "Biometria pendiente de revision RH" && !canceladas.includes(p) && !rechazadas.includes(p));
    const entrevistasPendientes = postulaciones.filter((p) => ["Acceso listo para Seguridad", "Acceso cerrado", "Acceso verificado por Seguridad"].includes(p.estado) && !canceladas.includes(p) && !rechazadas.includes(p));
    const contratacionPendiente = postulaciones.filter((p) => p.estado === "Asistio a entrevista" && !canceladas.includes(p) && !rechazadas.includes(p));

    actualizarBadgesRh(postulaciones);
    $("#totalPostulaciones").textContent = cvRecibidos.length;
    renderizarListaRh("#listaRh", cvRecibidos, postulaciones, "No hay CV recibidos.", true);
    renderizarListaRh("#listaCvRechazadosRh", rechazadas, postulaciones, "No hay CV rechazados.", false);
    renderizarListaRh("#listaCanceladosRh", canceladas, postulaciones, "No hay postulaciones canceladas.", false);

    $$("[data-ver-cv]").forEach((boton) => boton.addEventListener("click", () => {
      const postulacion = postulaciones.find((p) => p._id === boton.dataset.verCv);
      if (!postulacion?.cv?.contenidoBase64) {
        mensaje("Esta postulación no tiene CV adjunto.");
        return;
      }
      abrirArchivoBase64(postulacion.cv.contenidoBase64);
    }));
    $$("[data-ver-biometria]").forEach((boton) => boton.addEventListener("click", () => {
      const postulacion = postulaciones.find((p) => p._id === boton.dataset.verBiometria);
      if (!postulacion?.biometria?.imagenBase64) {
        mensaje("Esta postulación no tiene imagen biométrica guardada.");
        return;
      }
      activarPanel("biometria");
      const bioVista = $("#biometriaRh");
      if (bioVista) {
        const botonBio = $$('[data-seleccionar-bio-rh]', bioVista).find((item) => item.getAttribute("data-seleccionar-bio-rh") === postulacion._id);
        if (botonBio) {
          botonBio.click();
        }
      }
    }));
    $$("[data-aceptar]").forEach((boton) => boton.addEventListener("click", () => cambiarEstadoRh(boton.dataset.aceptar, "Acceso autorizado por RH")));
    $$("[data-rechazar]").forEach((boton) => boton.addEventListener("click", () => {
      const razonRechazo = prompt("Razón para no dar acceso:", "CV no cumple requisitos de la vacante");
      cambiarEstadoRh(boton.dataset.rechazar, "Acceso negado por RH", razonRechazo || "Sin razón capturada");
    }));
    renderizarBiometriaSeleccionable("#biometriaRh", postulaciones, "rh");
    renderizarReclutarRh(biometriaPendiente, entrevistasPendientes, contratacionPendiente);
    const aceptados = postulaciones.filter((p) => p.estado === "Perfil egresado generado");
    renderizarPerfilesEgresado(aceptados);
    renderizarVacantesRh(vacantes);
  }

  function renderizarListaRh(selector, lista, postulaciones, mensajeVacio, puedeDecidir) {
    const contenedor = $(selector);
    if (!contenedor) return;
    contenedor.innerHTML = lista.length ? lista.map((p) => `
      <article class="item" data-leer-rh="${p._id}">
        <div>
          <h3>${p.nombreRecluta}</h3>
          <p>${p.tituloVacante} · ${p.estado}</p>
          ${tieneNotificacionRhSinLeer(p) ? `<div class="notificacion-roja" data-leer-rh="${p._id}"><span class="punto-rojo"></span>${p.notificacionRh}</div>` : ""}
          <p>CV recibido: ${p.cv?.nombre || "Sin CV adjunto"}</p>
          <div class="meta"><span>${p.fechaEntrevista}</span><span>${p.entrevistador}</span><span>${p.direccion}</span></div>
        </div>
        <div class="acciones">
          <button class="boton-secundario" data-ver-cv="${p._id}">Ver CV</button>
          ${p.biometria?.imagenBase64 ? `<button class="boton-secundario" data-ver-biometria="${p._id}">Ver biometría</button>` : `<span class="estado">Sin biometría</span>`}
          ${puedeDecidir && p.estado === "CV enviado a RH" ? `<button class="boton-exito" data-aceptar="${p._id}">Validar CV para entrevista</button><button class="boton-peligro" data-rechazar="${p._id}">No dar acceso</button>` : `<span class="estado">${p.estado === "Acceso autorizado por RH" ? "Acceso permitido" : p.estado}</span>`}
        </div>
      </article>
    `).join("") : `<p>${mensajeVacio}</p>`;

    $$('[data-leer-rh]').forEach((item) => {
      item.addEventListener('click', (evento) => {
        evento.stopPropagation();
        marcarNotificacionRhLeida(item.dataset.leerRh);
      });
    });
  }

  async function marcarNotificacionRhLeida(id) {
    if (!id) return;
    const badge = $("#badgeCanceladosRh");
    if (badge) {
      badge.textContent = "0";
      badge.classList.add("oculto");
    }
    try {
      await api("/api/rh/postulaciones/" + id + "/leer", { method: "PATCH" });
      await renderizarRh();
    } catch (error) {
      mensaje(error.message);
    }
  }

  async function marcarNotificacionesRhLeidas() {
    try {
      await api("/api/rh/notificaciones/leer", { method: "PATCH" });
      const badge = $("#badgeCanceladosRh");
      if (badge) {
        badge.textContent = "0";
        badge.classList.add("oculto");
      }
      await renderizarRh();
    } catch (error) {
      console.warn("No se pudo limpiar la notificación de cancelados:", error.message);
    }
  }

  async function cambiarEstadoRh(id, estado, razonRechazo = "") {
    await api("/api/rh/postulaciones/" + id, {
      method: "PATCH",
      body: JSON.stringify({ estado, razonRechazo })
    });
    mensaje("Respuesta de RH guardada en MongoDB Atlas.");
    await renderizarRh();
  }

  async function renderizarSeguridad() {
    const accesos = await api("/api/seguridad/accesos");
    const rechazados = await api("/api/seguridad/rechazados");
    const historial = await api("/api/seguridad/historial");
    const accesosPendientes = Array.isArray(accesos)
      ? accesos.filter((p) => p.estado === "Acceso listo para Seguridad")
      : [];
    const total = accesosPendientes.length;
    $("#totalAccesos").textContent = total;
    renderizarAccesosSeguridad(accesosPendientes);
    renderizarRechazadosSeleccionables(rechazados);
    renderizarHistorialSeguridad(historial, ["#historialSeguridad", "#historialAccesosSeguridad"]);
  }

  function renderizarHistorialSeguridad(registros = [], contenedores = ["#historialSeguridad", "#historialAccesosSeguridad"]) {
    const registrosValidos = (Array.isArray(registros) ? registros : []).filter((registro) => {
      const nombre = String(registro?.nombre || "").trim();
      return nombre && nombre !== "Persona";
    });

    const html = registrosValidos.length ? registrosValidos.map((registro) => {
      const fecha = new Date(registro.fecha);
      const hora = fecha.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
      const fechaFormateada = fecha.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric" });

      return `
        <article class="item-historial">
          <div>
            <strong>${registro.nombre}</strong>
            <small>${registro.vacante || "Acceso temporal"}</small>
          </div>
          <div class="estado-historial">${registro.estado}</div>
          <time>${fechaFormateada} · ${hora}</time>
        </article>
      `;
    }).join("") : "<p class='vacio-historial'>Todavía no hay accesos registrados.</p>";

    contenedores.forEach((selector) => {
      const contenedor = $(selector);
      if (contenedor) contenedor.innerHTML = html;
    });
  }

async function iniciarVerificacionSeguridad(postulacion) {
  accesoSeleccionado = postulacion;

  const listaAccesos = $("#listaAccesos");
  const panel = $("#panelVerificacionSeguridad");
  const botonCoincide = $("#confirmarCoincide");
  const botonNoCoincide = $("#confirmarNoCoincide");
  const botonConfigurar = $("#configurarCamaraEsp32");
  const botonConfigurarServo = $("#configurarServoEsp32");
  const botonCapturar = $("#capturarSeguridad");

  // Mostrar el panel de verificación
  panel?.classList.remove("oculto");
  panel?.classList.remove("captura-realizada");

  // Ocultar la información grande del candidato
  if (listaAccesos) {
    listaAccesos.classList.add("modo-verificacion");
  }

  // Ocultar los botones finales hasta tener la segunda fotografía
  if (botonCoincide) botonCoincide.style.display = "none";
  if (botonNoCoincide) botonNoCoincide.style.display = "none";

  // Mantener visibles las configuraciones y la captura mientras no exista captura
  if (botonConfigurar) botonConfigurar.style.display = "";
  if (botonConfigurarServo) botonConfigurarServo.style.display = "";
  if (botonCapturar) botonCapturar.style.display = "";

  renderizarComparacionSeguridad(postulacion, false);

    // Conectar botones de seguridad después de crear el panel
  if (botonCapturar) {
    botonCapturar.onclick = () => {
      console.log("CAPTURAR ROSTRO: botón presionado");
      capturarRostroSeguridad();
    };
  }

  if (botonConfigurar) {
    botonConfigurar.onclick = () => {
      configurarCamaraEsp32();
    };
  }

  if (botonConfigurarServo) {
    botonConfigurarServo.onclick = () => {
      configurarServoEsp32();
    };
  }

  const urlEsp32 = obtenerUrlEsp32(true);

  if (!urlEsp32) return;

  iniciarVistaEsp32(urlEsp32);

  mensaje("ESP32-CAM conectada. Captura el rostro para continuar.");
}

  function renderizarComparacionSeguridad(postulacion, hayCaptura = false) {
    const imagenRegistrada = postulacion?.biometria?.imagenBase64 || "";
    const capturaActual = hayCaptura && postulacion?.capturaSeguridad ? `
      <img src="${postulacion.capturaSeguridad}" alt="Rostro actual capturado" class="foto-capturada-seguridad">
    ` : `
      <div id="capturaActualSeguridad" class="preview">
        <span>Esperando captura...</span>
      </div>
    `;

    const botonesFinales = hayCaptura ? `
      <div id="accionesFinalesSeguridad" class="acciones-finales-seguridad">
        <button id="volverATomarFotoSeguridad" class="boton-claro" type="button">Volver a tomar foto</button>
        <button id="confirmarCoincide" class="boton-exito" type="button">Rostro coincide</button>
        <button id="confirmarNoCoincide" class="boton-peligro" type="button">No coincide</button>
      </div>
    ` : "";

    $("#comparacionSeguridad").innerHTML = `
      <div class="biometria-titulo-final">
        <span>VERIFICACIÓN BIOMÉTRICA</span>
        <h2>Comparación de rostro</h2>
        <p>Confirma visualmente que el rostro actual corresponde al registrado.</p>
      </div>

      <div class="biometria-comparacion-final">
        <article class="biometria-final">
          <div class="etiqueta-foto">ROSTRO REGISTRADO</div>
          ${
            imagenRegistrada
              ? `<img src="${imagenRegistrada}" alt="Rostro registrado">`
              : `<div class="preview">Sin biometría guardada</div>`
          }
          <strong>${postulacion?.nombreRecluta || "Persona"}</strong>
        </article>

        <article class="biometria-final">
          <div class="etiqueta-foto">ROSTRO ACTUAL</div>
          ${capturaActual}
          <strong>Cámara de Seguridad</strong>
        </article>
      </div>

      ${botonesFinales}
    `;

    $("#confirmarCoincide")?.addEventListener("click", () => validarSeguridad(true));
    $("#confirmarNoCoincide")?.addEventListener("click", () => validarSeguridad(false));
    $("#volverATomarFotoSeguridad")?.addEventListener("click", () => {
      if (!accesoSeleccionado) return;
      accesoSeleccionado.capturaSeguridad = "";
      $("#panelVerificacionSeguridad")?.classList.remove("captura-realizada");
      renderizarComparacionSeguridad(accesoSeleccionado, false);
      const urlEsp32 = obtenerUrlEsp32(true);
      if (urlEsp32) iniciarVistaEsp32(urlEsp32);
      mensaje("Puedes volver a tomar la foto desde la cámara.");
    });
  }

  function normalizarUrlEsp32(valor) {
    if (!valor || typeof valor !== "string") return "";

    const url = valor.trim().replace(/\/$/, "");
    if (!url) return "";
    if (!/^https?:\/\//i.test(url)) return `http://${url}`;
    return url;
  }

  function configurarCamaraEsp32() {
    const actual = obtenerUrlEsp32();
    const nueva = prompt("URL del ESP32-CAM:", actual || "http://192.168.1.50");
    if (nueva === null) return;
    const urlEsp32 = normalizarUrlEsp32(nueva);
    if (!urlEsp32) {
      localStorage.removeItem("ContrataT-esp32cam-url");
      mensaje("Se borró la configuración de la cámara.");
      return;
    }
    localStorage.setItem("ContrataT-esp32cam-url", urlEsp32);
    iniciarVistaEsp32(urlEsp32);
    mensaje("Dirección de la ESP32-CAM actualizada.");
  }

  function configurarServoEsp32() {
    const actual = obtenerUrlServo(true) || obtenerUrlEsp32(true);
    const nueva = prompt("URL del servo o puerta:", actual || "http://192.168.1.50");
    if (nueva === null) return;
    const urlServo = normalizarUrlEsp32(nueva);
    if (!urlServo) {
      localStorage.removeItem("ContrataT-servo-url");
      mensaje("Se borró la configuración del servo.");
      return;
    }
    localStorage.setItem("ContrataT-servo-url", urlServo);
    mensaje("Dirección del servo actualizada.");
  }

  function iniciarVistaEsp32(urlEsp32) {
    const urlNormalizada = normalizarUrlEsp32(urlEsp32);
    if (!urlNormalizada) return;
    detenerCamaraSeguridad();
    const actualizar = () => {
      const vista = $("#videoSeguridad");
      if (vista) vista.src = `${urlNormalizada}/captura?ts=${Date.now()}`;
    };
    actualizar();
    temporizadorCamaraEsp32 = setInterval(actualizar, 1200);
  }
function capturarRostroSeguridad() {
  if (!accesoSeleccionado) {
    mensaje("Primero selecciona un acceso.");
    return;
  }

  const urlEsp32 = obtenerUrlEsp32();

  if (!urlEsp32) {
    mensaje("Primero configura la IP de la ESP32-CAM.");
    return;
  }

  const urlCaptura = `${urlEsp32}/captura?foto=${Date.now()}`;
  const contenedor = document.getElementById("capturaActualSeguridad");

  if (!contenedor) {
    mensaje("No se encontró el espacio para mostrar la captura.");
    return;
  }

  contenedor.innerHTML = `
    <img
      src="${urlCaptura}"
      alt="Rostro actual capturado"
      class="foto-capturada-seguridad"
    >
  `;

  accesoSeleccionado.capturaSeguridad = urlCaptura;
  renderizarComparacionSeguridad(accesoSeleccionado, true);
  $("#panelVerificacionSeguridad")?.classList.add("captura-realizada");
  detenerCamaraSeguridad();

  mensaje("Rostro capturado correctamente. Compara las dos fotografías.");
}
  async function validarSeguridad(coincide) {
    if (!accesoSeleccionado) {
      mensaje("Selecciona un acceso para verificar.");
      return;
    }

    const hayCaptura = Boolean(accesoSeleccionado?.capturaSeguridad);

    if (coincide && !hayCaptura) {
      mensaje("Primero captura el rostro actual con la ESP32-CAM.");
      return;
    }

    if (coincide) {
      const puertaAbierta = await abrirPuertaEsp32();
      if (!puertaAbierta) {
        mensaje("La puerta o el servo no respondió. No se valida el acceso hasta que funcione el botón.");
        return;
      }
    }
    await api("/api/seguridad/accesos/" + accesoSeleccionado._id + "/validar", {
      method: "PATCH",
      body: JSON.stringify({
        coincide,
        capturaSeguridad: accesoSeleccionado.capturaSeguridad || ""
      })
    });
    detenerCamaraSeguridad();
    $("#panelVerificacionSeguridad")?.classList.add("oculto");
    if (coincide) {
      mensaje("Rostro verificado. Acceso cerrado y retirado de la lista.");
      activarPanel("accesos");
      const botonAccesos = $("[data-seccion='accesos']");
      botonAccesos?.classList.add("activo");
    } else {
      mensaje("Rostro no coincide. Acceso negado.");
      activarPanel("rechazados");
      const botonRechazados = $("[data-seccion='rechazados']");
      botonRechazados?.classList.add("activo");
    }
    await renderizarSeguridad();
  }
async function abrirPuertaEsp32() {
  const urlServo = normalizarUrlEsp32(obtenerUrlServo(true) || obtenerUrlEsp32(true));

  if (!urlServo) {
    mensaje("Configura la IP del servo antes de abrir la puerta.");
    return false;
  }

  try {
    const urlAbrir = `${urlServo}/abrir`;
    console.log("Enviando orden al relay de la ESP32:", urlAbrir);

    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), 3000);

    const respuesta = await fetch(urlAbrir, {
      method: "GET",
      mode: "cors",
      signal: controlador.signal
    });

    clearTimeout(temporizador);

    if (!respuesta.ok) {
      const texto = await respuesta.text().catch(() => "");
      throw new Error(`La ESP32 rechazó el comando (${respuesta.status}): ${texto || "sin detalle"}`);
    }

    const datos = await respuesta.json().catch(() => null);

    console.log("Respuesta de la ESP32:", datos);

    mensaje("✅ Rostro coincide. Puerta abierta.");

    return true;

  } catch (error) {
    console.error("Error al abrir la puerta:", error);

    const detalle = error instanceof Error ? error.message : "";
    mensaje(
      detalle
        ? `❌ No se pudo abrir la puerta: ${detalle}`
        : "❌ No se pudo conectar con la ESP32 del acceso. Verifica la IP configurada, Wi‑Fi y alimentación."
    );

    return false;
  }
}

  function blobADataUrl(blob) {
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => resolve(lector.result);
      lector.onerror = reject;
      lector.readAsDataURL(blob);
    });
  }

  function renderizarAccesosSeguridad(accesos) {
    const contenedor = $("#listaAccesos");
    if (!contenedor) return;
    if (!accesos.length) {
      contenedor.innerHTML = "<p>No hay candidatos pendientes por validar en Seguridad.</p>";
      return;
    }

    const idActivo = accesoSeleccionado?._id || accesos[0]._id;
    const accesoInicial = accesos.find((p) => p._id === idActivo) || accesos[0];

    contenedor.innerHTML = `
      <div class="selector-detalle">
        <div>
          <input class="buscador" data-buscar-nombres placeholder="Buscar por nombre">
          <div class="lista-nombres">
            ${accesos.map((p) => `<button class="boton-nombre ${p._id === accesoInicial._id ? "activo" : ""}" data-seleccionar-acceso="${p._id}">${p.nombreRecluta}</button>`).join("")}
          </div>
        </div>
        <div id="detalleAccesoSeguridad" class="detalle-persona"></div>
      </div>
    `;

    const mostrar = (postulacion) => {
      if (!postulacion) return;
      accesoSeleccionado = postulacion;
      $("#detalleAccesoSeguridad").innerHTML = `
        <h3>${postulacion.nombreRecluta}</h3>
        <p class="texto-detalle">Viene a entrevista: ${postulacion.fechaEntrevista || "Sin fecha"} · ${postulacion.horaLimite || "Sin hora"}</p>
        <p class="texto-detalle"><strong>RH:</strong> ${postulacion.entrevistador || "Sin entrevistador"}</p>
        <div class="meta acceso-meta"><span>${postulacion.tituloVacante}</span><span>${postulacion.direccion || "Sin dirección"}</span></div>
        <div class="biometria-caja">
          ${postulacion.biometria?.imagenBase64 ? `<img src="${postulacion.biometria.imagenBase64}" alt="Biometría de ${postulacion.nombreRecluta}">` : `<div class="preview biometria-preview">Sin biometría</div>`}
        </div>
        <div class="acciones separacion acciones-seguridad"><button class="boton-principal" data-verificar-acceso="${postulacion._id}">Verificar con cámara</button><button class="boton-secundario" data-cerrar-acceso="${postulacion._id}">Cerrar acceso</button></div>
      `;
      enlazarBotonesAcceso();
    };

    const enlazarBotonesAcceso = () => {
      $$("[data-verificar-acceso]", contenedor).forEach((boton) => boton.addEventListener("click", () => {
        const seleccionada = accesos.find((p) => p._id === boton.dataset.verificarAcceso);
        if (seleccionada) accesoSeleccionado = seleccionada;
        iniciarVerificacionSeguridad(seleccionada);
      }));
      $$("[data-cerrar-acceso]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
        await api("/api/seguridad/accesos/" + boton.dataset.cerrarAcceso + "/cerrar", { method: "PATCH" });
        mensaje("Acceso cerrado en MongoDB Atlas.");
        const pendienteActual = accesos.find((p) => p._id === boton.dataset.cerrarAcceso);
        if (pendienteActual) {
          const indice = accesos.indexOf(pendienteActual);
          if (indice >= 0) accesos.splice(indice, 1);
        }
        renderizarAccesosSeguridad(accesos.filter((p) => p.estado === "Acceso listo para Seguridad"));
        await renderizarSeguridad();
      }));
    };

    $$("[data-seleccionar-acceso]", contenedor).forEach((boton) => boton.addEventListener("click", () => {
      $$("[data-seleccionar-acceso]", contenedor).forEach((b) => b.classList.toggle("activo", b === boton));
      const seleccionada = accesos.find((p) => p._id === boton.dataset.seleccionarAcceso);
      if (seleccionada) {
        accesoSeleccionado = seleccionada;
      }
      mostrar(seleccionada);
    }));

    conectarBuscador(contenedor);
    mostrar(accesoInicial);
  }

  function renderizarRechazadosSeleccionables(rechazados) {
    const contenedor = $("#listaRechazados");
    if (!contenedor) return;
    if (!rechazados.length) {
      contenedor.innerHTML = "<p>No hay reclutas rechazados.</p>";
      return;
    }
    contenedor.innerHTML = `
      <div class="selector-detalle">
        <div><input class="buscador" data-buscar-nombres placeholder="Buscar por nombre"><div class="lista-nombres">
          ${rechazados.map((p, indice) => `<button class="boton-nombre ${indice === 0 ? "activo" : ""}" data-seleccionar-rechazo="${p._id}">${p.nombreRecluta}</button>`).join("")}
        </div></div>
        <div id="detalleRechazo" class="detalle-persona"></div>
      </div>
    `;
    const mostrar = (p) => {
      $("#detalleRechazo").innerHTML = `
        <h3>${p.nombreRecluta}</h3>
        <span class="estado">${p.estado === "Acceso vencido" ? "Vencido" : "Rechazado"}</span>
        <p class="separacion">${p.razonRechazo || "Sin razón capturada"}</p>
        <div class="meta"><span>${p.tituloVacante}</span><span>${p.correoRecluta}</span><span>${p.fechaEntrevista || "Sin entrevista"}</span></div>
      `;
    };
    $$("[data-seleccionar-rechazo]", contenedor).forEach((boton) => boton.addEventListener("click", () => {
      $$("[data-seleccionar-rechazo]", contenedor).forEach((b) => b.classList.toggle("activo", b === boton));
      mostrar(rechazados.find((p) => p._id === boton.dataset.seleccionarRechazo));
    }));
    conectarBuscador(contenedor);
    mostrar(rechazados[0]);
  }

  function renderizarPerfilesEgresado(perfiles) {
    const contenedor = $("#perfilesEgresado");
    if (!contenedor) return;
    if (!perfiles.length) {
      contenedor.innerHTML = "<p>No hay reclutas aceptados para perfil egresado.</p>";
      return;
    }
    contenedor.innerHTML = `
      <div class="selector-detalle">
        <div><input class="buscador" data-buscar-nombres placeholder="Buscar por nombre"><div class="lista-nombres">
          ${perfiles.map((p, indice) => `<button class="boton-nombre ${indice === 0 ? "activo" : ""}" data-seleccionar-perfil="${p._id}">${p.nombreRecluta}</button>`).join("")}
        </div></div>
        <div id="detallePerfilEgresado" class="detalle-persona"></div>
      </div>
    `;
    const mostrar = (p) => {
      $("#detallePerfilEgresado").innerHTML = `
        <h3>${p.nombreRecluta}</h3>
        <span class="estado">Perfil egresado</span>
        <p class="separacion">Día de inducción: ${p.fechaInduccion || "Por definir"}</p>
        ${p.biometria?.imagenBase64 ? `<img src="${p.biometria.imagenBase64}" alt="Imagen de ${p.nombreRecluta}">` : `<div class="preview">Sin imagen</div>`}
        <h3 class="separacion">${p.tituloVacante}</h3>
        <p><strong>Qué es:</strong> ${p.queEsVacante || p.areaVacante || "Puesto operativo"}</p>
        <p><strong>Qué hace:</strong> ${p.descripcionVacante || "Realiza las actividades asignadas al puesto y reporta avances a su responsable."}</p>
        <div class="meta"><span>${p.areaVacante || "Area pendiente"}</span><span>Turno: ${p.turnoVacante || "Pendiente"}</span><span>${p.horarioVacante || "Horario pendiente"}</span><span>${p.ubicacionVacante || "Ubicacion pendiente"}</span></div>
      `;
    };
    $$("[data-seleccionar-perfil]", contenedor).forEach((boton) => boton.addEventListener("click", () => {
      $$("[data-seleccionar-perfil]", contenedor).forEach((b) => b.classList.toggle("activo", b === boton));
      mostrar(perfiles.find((p) => p._id === boton.dataset.seleccionarPerfil));
    }));
    conectarBuscador(contenedor);
    mostrar(perfiles[0]);
  }

  let vistaReclutarActiva = "biometria";

  function renderizarReclutarRh(candidatos, entrevistas = [], contrataciones = []) {
    const contenedor = $("#listaReclutarRh");
    if (!contenedor) return;

    const pendientesHtml = candidatos.length ? `
      <div class="separacion" data-panel-bio-pendiente>
        <div class="cabecera-subseccion">
          <h3>Biometría pendiente</h3>
        </div>
        <div class="selector-detalle">
          <div class="lista-nombres">
            ${candidatos.map((p, indice) => `<button class="boton-nombre ${indice === 0 ? "activo" : ""}" data-seleccionar-reclutar="${p._id}">${p.nombreRecluta}</button>`).join("")}
          </div>
          <div id="detalleReclutarRh" class="detalle-persona"></div>
        </div>
      </div>
    ` : "<p>No hay reclutas pendientes de validación biométrica.</p>";

    const validacionHtml = `
      <div class="separacion" data-panel-validacion-entrevistas>
        ${entrevistas.length ? `
          <div class="selector-detalle">
            <div class="lista-nombres">
              ${entrevistas.map((p, indice) => `<button class="boton-nombre ${indice === 0 ? "activo" : ""}" data-seleccionar-validacion="${p._id}">${p.nombreRecluta}</button>`).join("")}
            </div>
            <div id="detalleValidacionEntrevistas" class="detalle-persona"></div>
          </div>
        ` : "<p>No hay entrevistas por validar.</p>"}
      </div>
    `;

    const contratacionHtml = `
      <div class="separacion oculto" data-panel-contratacion>
        ${contrataciones.length ? `
          <div class="selector-detalle">
            <div class="lista-nombres">
              ${contrataciones.map((p, indice) => `<button class="boton-nombre ${indice === 0 ? "activo" : ""}" data-seleccionar-contratacion="${p._id}">${p.nombreRecluta}</button>`).join("")}
            </div>
            <div id="detalleContratacionEntrevistas" class="detalle-persona"></div>
          </div>
        ` : "<p>No hay contrataciones por evaluar.</p>"}
      </div>
    `;

    contenedor.innerHTML = `${pendientesHtml}${validacionHtml}${contratacionHtml}`;

    const mostrarPendiente = (p) => {
      const detalle = $("#detalleReclutarRh");
      if (!detalle) return;
      detalle.innerHTML = `
        <h3>${p.nombreRecluta}</h3>
        ${p.notificacionRh ? `<div class="notificacion-roja"><span class="punto-rojo"></span>${p.notificacionRh}</div>` : ""}
        <span class="estado">${p.estado === "Biometria pendiente de revision RH" ? "Biometría pendiente" : p.estado}</span>
        <p class="separacion"><strong>Puesto:</strong> ${p.tituloVacante}</p>
        <p><strong>Qué es:</strong> ${p.queEsVacante || p.areaVacante || "Puesto operativo"}</p>
        <p><strong>Qué hace:</strong> ${p.descripcionVacante || "Actividades asignadas por el área."}</p>
        ${p.biometria?.imagenBase64 ? `<img src="${p.biometria.imagenBase64}" alt="Biometría de ${p.nombreRecluta}">` : `<div class="preview">Sin biometría</div>`}
        <div class="meta separacion"><span>${p.fechaEntrevista || "Fecha pendiente"}</span><span>${p.horaLimite || "Sin hora límite"}</span><span>${p.entrevistador || "Sin entrevistador"}</span></div>
        <div class="acciones separacion">
          <button class="boton-exito" data-validar-bio="${p._id}">Validar</button>
          <button class="boton-peligro" data-no-validar-bio="${p._id}">No validar</button>
        </div>
      `;

      $$("[data-validar-bio]", detalle).forEach((boton) => boton.addEventListener("click", async () => {
        await cambiarEstadoRh(boton.dataset.validarBio, "Acceso listo para Seguridad");
        mensaje("Biometría validada. Ahora puede pasar a validación de entrevistas.");
        await renderizarRh();
      }));
      $$("[data-no-validar-bio]", detalle).forEach((boton) => boton.addEventListener("click", async () => {
        const razonRechazo = prompt("Motivo para no validar la biometría:", "La imagen no es clara o el rostro no coincide");
        await cambiarEstadoRh(boton.dataset.noValidarBio, "Biometria rechazada por RH", razonRechazo || "Biometría no aceptada por RH");
        mensaje("Biometría rechazada. El recluta deberá capturar otra vez.");
        await renderizarRh();
      }));
    };

    const mostrarAceptados = (p) => {
      const detalle = $("#detalleValidacionEntrevistas");
      if (!detalle) return;
      const puedeValidarEntrevista = ["Acceso listo para Seguridad", "Acceso cerrado", "Acceso verificado por Seguridad"].includes(p.estado);
      detalle.innerHTML = `
        <h3>${p.nombreRecluta}</h3>
        <span class="estado">${p.estado === "Biometria pendiente de revision RH" ? "Biometría pendiente" : p.estado}</span>
        <p class="separacion"><strong>Puesto:</strong> ${p.tituloVacante}</p>
        <p><strong>Qué es:</strong> ${p.queEsVacante || p.areaVacante || "Puesto operativo"}</p>
        <p><strong>Qué hace:</strong> ${p.descripcionVacante || "Actividades asignadas por el área."}</p>
        <p><strong>Correo:</strong> ${p.correoRecluta || "Sin correo"}</p>
        ${p.cv?.contenidoBase64 ? `<button class="boton-secundario separacion" data-ver-cv="${p._id}">Ver CV</button>` : `<span class="estado separacion">Sin CV</span>`}
        <div class="meta separacion"><span>${p.fechaEntrevista || "Fecha pendiente"}</span><span>${p.horaLimite || "Sin hora límite"}</span><span>${p.entrevistador || "Sin entrevistador"}</span></div>
        <h3 class="separacion">¿Asistió?</h3>
        <div class="acciones">
          <button class="boton-exito" data-asistio-entrevista="${p._id}" ${puedeValidarEntrevista ? "" : "disabled"}>Sí, asistió</button>
          <button class="boton-peligro" data-no-asistio-entrevista="${p._id}" ${puedeValidarEntrevista ? "" : "disabled"}>No asistió</button>
        </div>
      `;
      enlazarDecisionEntrevista(detalle);
    };

    const mostrarContratacion = (p) => {
      const detalle = $("#detalleContratacionEntrevistas");
      if (!detalle) return;
      const puedeContratar = p.estado === "Asistio a entrevista";
      detalle.innerHTML = `
        <h3>${p.nombreRecluta}</h3>
        <span class="estado">${p.estado}</span>
        <p class="separacion"><strong>Puesto:</strong> ${p.tituloVacante}</p>
        <p><strong>Correo:</strong> ${p.correoRecluta || "Sin correo"}</p>
        <div class="meta separacion"><span>${p.fechaEntrevista || "Fecha pendiente"}</span><span>${p.horaLimite || "Sin hora límite"}</span><span>${p.entrevistador || "Sin entrevistador"}</span></div>
        <h3 class="separacion">¿Pasó la entrevista?</h3>
        <div class="acciones">
          <button class="boton-exito" data-generar-egresado="${p._id}" ${puedeContratar ? "" : "disabled"}>Sí, pasó la entrevista</button>
          <button class="boton-peligro" data-no-paso-entrevista="${p._id}" ${puedeContratar ? "" : "disabled"}>No pasó la entrevista</button>
        </div>
      `;
      enlazarDecisionEntrevista(detalle);
    };

    const botonEntrevistasCabecera = document.querySelector("[data-panel='reclutar'] [data-mostrar-validacion-entrevistas]");
    const botonContratacionCabecera = document.querySelector("[data-panel='reclutar'] [data-mostrar-contratacion]");
    const botonRegresarCabecera = document.querySelector("[data-panel='reclutar'] [data-regresar-reclutar]");

    const mostrarSoloEntrevistas = () => {
      vistaReclutarActiva = "entrevistas";
      const panelBiometria = $("[data-panel-bio-pendiente]", contenedor);
      const panelEntrevistas = $("[data-panel-validacion-entrevistas]", contenedor);
      const panelContratacion = $("[data-panel-contratacion]", contenedor);
      panelBiometria?.classList.add("oculto");
      panelEntrevistas?.classList.remove("oculto");
      panelContratacion?.classList.add("oculto");
      botonRegresarCabecera?.classList.remove("oculto");
      botonEntrevistasCabecera?.classList.remove("oculto");
      botonContratacionCabecera?.classList.remove("oculto");
    };

    const mostrarContratacionPanel = () => {
      vistaReclutarActiva = "contratacion";
      const panelBiometria = $("[data-panel-bio-pendiente]", contenedor);
      const panelEntrevistas = $("[data-panel-validacion-entrevistas]", contenedor);
      const panelContratacion = $("[data-panel-contratacion]", contenedor);
      panelBiometria?.classList.add("oculto");
      panelEntrevistas?.classList.add("oculto");
      panelContratacion?.classList.remove("oculto");
      botonRegresarCabecera?.classList.remove("oculto");
      botonEntrevistasCabecera?.classList.remove("oculto");
      botonContratacionCabecera?.classList.remove("oculto");
    };

    const mostrarBiometriaPendiente = () => {
      vistaReclutarActiva = "biometria";
      const panelBiometria = $("[data-panel-bio-pendiente]", contenedor);
      const panelEntrevistas = $("[data-panel-validacion-entrevistas]", contenedor);
      const panelContratacion = $("[data-panel-contratacion]", contenedor);
      panelBiometria?.classList.remove("oculto");
      panelEntrevistas?.classList.add("oculto");
      panelContratacion?.classList.add("oculto");
      botonRegresarCabecera?.classList.add("oculto");
      botonEntrevistasCabecera?.classList.remove("oculto");
      botonContratacionCabecera?.classList.remove("oculto");
    };

    $$("[data-mostrar-validacion-entrevistas]", contenedor).forEach((boton) => {
      boton.addEventListener("click", mostrarSoloEntrevistas);
    });
    $$("[data-mostrar-contratacion]", contenedor).forEach((boton) => {
      boton.addEventListener("click", mostrarContratacionPanel);
    });
    if (botonEntrevistasCabecera) {
      botonEntrevistasCabecera.addEventListener("click", mostrarSoloEntrevistas);
    }
    if (botonContratacionCabecera) {
      botonContratacionCabecera.addEventListener("click", mostrarContratacionPanel);
    }
    botonRegresarCabecera?.addEventListener("click", mostrarBiometriaPendiente);

    const pendientes = $$("[data-seleccionar-reclutar]", contenedor);
    pendientes.forEach((boton) => boton.addEventListener("click", () => {
      pendientes.forEach((b) => b.classList.toggle("activo", b === boton));
      const p = candidatos.find((item) => item._id === boton.dataset.seleccionarReclutar);
      if (p) mostrarPendiente(p);
    }));

    const aceptadosBotones = $$("[data-seleccionar-validacion]", contenedor);
    aceptadosBotones.forEach((boton) => boton.addEventListener("click", () => {
      aceptadosBotones.forEach((b) => b.classList.toggle("activo", b === boton));
      const p = entrevistas.find((item) => item._id === boton.dataset.seleccionarValidacion);
      if (p) mostrarAceptados(p);
    }));

    const contratacionBotones = $$("[data-seleccionar-contratacion]", contenedor);
    contratacionBotones.forEach((boton) => boton.addEventListener("click", () => {
      contratacionBotones.forEach((b) => b.classList.toggle("activo", b === boton));
      const p = contrataciones.find((item) => item._id === boton.dataset.seleccionarContratacion);
      if (p) mostrarContratacion(p);
    }));

    if (candidatos.length) {
      const primer = candidatos[0];
      if (primer) mostrarPendiente(primer);
      $$('[data-seleccionar-reclutar]', contenedor)[0]?.classList.add('activo');
    }
    if (entrevistas.length) {
      const primerAceptado = entrevistas[0];
      if (primerAceptado) mostrarAceptados(primerAceptado);
      $$('[data-seleccionar-validacion]', contenedor)[0]?.classList.add('activo');
    }
    if (contrataciones.length) {
      const primeraContratacion = contrataciones[0];
      if (primeraContratacion) mostrarContratacion(primeraContratacion);
      $$('[data-seleccionar-contratacion]', contenedor)[0]?.classList.add('activo');
    }

    if (vistaReclutarActiva === "contratacion") {
      mostrarContratacionPanel();
    } else if (vistaReclutarActiva === "entrevistas") {
      mostrarSoloEntrevistas();
    } else {
      mostrarBiometriaPendiente();
    }
  }

  function enlazarDecisionEntrevista(contenedor) {
    $$("[data-asistio-entrevista]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      await cambiarEstadoRh(boton.dataset.asistioEntrevista, "Asistio a entrevista");
      mensaje("Asistencia registrada. Ahora decide si paso entrevista.");
    }));
    $$("[data-no-asistio-entrevista]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      const razonRechazo = prompt("Motivo de inasistencia:", "No asistió a la entrevista en la hora acordada");
      await cambiarEstadoRh(boton.dataset.noAsistioEntrevista, "No asistio a entrevista", razonRechazo || "No asistió a entrevista");
      mensaje("Inasistencia registrada.");
    }));
    $$("[data-generar-egresado]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      await cambiarEstadoRh(boton.dataset.generarEgresado, "Perfil egresado generado");
      mensaje("Acceso a planta generado.");
    }));
    $$("[data-no-paso-entrevista]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      const razonRechazo = prompt("Motivo por el que no pasó la entrevista:", "No cumple con los criterios de entrevista");
      await cambiarEstadoRh(boton.dataset.noPasoEntrevista, "No aceptado despues de entrevista", razonRechazo || "No aceptado después de entrevista");
      mensaje("Resultado de entrevista guardado.");
    }));
  }

  function renderizarVacantesRh(vacantes) {
    const contenedor = $("#vacantesRhLista");
    if (!contenedor) return;
    contenedor.innerHTML = vacantes.length ? vacantes.map((v) => `
      <article class="item">
        <div>
          <h3>${v.titulo}</h3>
          <p><strong>Qué es:</strong> ${v.queEs || v.area || "Puesto disponible"}</p>
          <p><strong>Qué hace:</strong> ${v.descripcion}</p>
          <div class="meta"><span>${v.area}</span><span>Turno: ${v.turno || v.horario || "Pendiente"}</span><span>${v.horario}</span><span>${v.ubicacion}</span></div>
          <div class="meta separacion"><span>Necesarios: ${Number(v.personasNecesarias || 1)}</span><span>${v.ocupada ? "Cupo lleno" : "Disponible"}</span></div>
        </div>
        <div class="acciones vertical">
          <label class="mini-campo">Necesarios<input type="number" min="1" value="${Number(v.personasNecesarias || 1)}" data-cupo-vacante="${v._id}"></label>
          <button class="boton-secundario" data-guardar-cupo="${v._id}" type="button">Guardar cupo</button>
          <button class="boton-peligro" data-borrar-vacante="${v._id}" type="button">Borrar vacante</button>
        </div>
      </article>
    `).join("") : "<p>No hay vacantes publicadas.</p>";

    $$("[data-guardar-cupo]").forEach((boton) => {
      boton.addEventListener("click", async () => {
        const input = $(`[data-cupo-vacante="${boton.dataset.guardarCupo}"]`);
        const numero = Number(input?.value || 1);
        await api("/api/rh/vacantes/" + boton.dataset.guardarCupo, {
          method: "PATCH",
          body: JSON.stringify({ personasNecesarias: Number.isFinite(numero) && numero > 0 ? numero : 1 })
        });
        mensaje("Cupo actualizado para la vacante.");
        await renderizarRh();
      });
    });

    $$("[data-borrar-vacante]").forEach((boton) => {
      boton.addEventListener("click", async () => {
        const confirmar = window.confirm("¿Deseas eliminar esta vacante?");
        if (!confirmar) return;
        await api("/api/rh/vacantes/" + boton.dataset.borrarVacante, { method: "DELETE" });
        mensaje("Vacante eliminada.");
        await renderizarRh();
      });
    });
  }

  function renderizarBiometriaSeleccionable(selector, postulaciones, contexto) {
    const vista = $(selector);
    if (!vista) return;
    const conProceso = postulaciones.filter((p) => {
      const tieneBiometria = Boolean(p.biometria?.imagenBase64);
      const enRevision = ["Biometria pendiente de revision RH", "Biometria rechazada por RH"].includes(p.estado);
      return tieneBiometria && enRevision;
    });
    if (!conProceso.length) {
      vista.innerHTML = "<p>Aún no hay datos biométricos para seleccionar.</p>";
      return;
    }
    const detalleId = contexto === "seguridad" ? "detalleBiometriaSeguridad" : "detalleBiometriaRh";
    const botonAttr = contexto === "seguridad" ? "data-seleccionar-bio-seg" : "data-seleccionar-bio-rh";
    vista.innerHTML = `
      <div class="selector-detalle">
        <div><input class="buscador" data-buscar-nombres placeholder="Buscar por nombre"><div class="lista-nombres">
          ${conProceso.map((p, indice) => `<button class="boton-nombre ${indice === 0 ? "activo" : ""}" ${botonAttr}="${p._id}">${p.nombreRecluta}</button>`).join("")}
        </div></div>
        <div id="${detalleId}" class="detalle-persona"></div>
      </div>
    `;
    const mostrar = (p) => {
      $("#" + detalleId).innerHTML = `
        <h3>Imagen capturada por ${p.nombreRecluta}</h3>
        <span class="estado">${p.estado === "Biometria pendiente de revision RH" ? "Biometría pendiente" : p.estado}</span>
        <p class="separacion"><strong>Persona:</strong> ${p.nombreRecluta}</p>
        <p class="separacion">${p.tituloVacante}</p>
        ${p.biometria?.imagenBase64 ? `<img src="${p.biometria.imagenBase64}" alt="Biometría de ${p.nombreRecluta}">` : `<div class="preview">Pendiente de captura</div>`}
        <div class="meta separacion"><span>${p.biometria?.capturadaEn ? new Date(p.biometria.capturadaEn).toLocaleString("es-MX") : "Sin fecha biométrica"}</span><span>${p.correoRecluta || "Sin correo"}</span></div>
        ${contexto === "rh" && p.estado === "Biometria pendiente de revision RH" ? `<div class="acciones separacion"><button class="boton-exito" data-aceptar-biometria="${p._id}">Aceptar biometría</button><button class="boton-peligro" data-rechazar-biometria="${p._id}">Rechazar biometría</button></div>` : ""}
      `;
      if (contexto === "rh") enlazarDecisionBiometria(vista);
    };
    $$(`[${botonAttr}]`, vista).forEach((boton) => boton.addEventListener("click", () => {
      $$(`[${botonAttr}]`, vista).forEach((b) => b.classList.toggle("activo", b === boton));
      mostrar(conProceso.find((p) => p._id === boton.getAttribute(botonAttr)));
    }));
    conectarBuscador(vista);
    mostrar(conProceso[0]);
  }

  function enlazarDecisionBiometria(contenedor) {
    $$("[data-aceptar-biometria]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      await cambiarEstadoRh(boton.dataset.aceptarBiometria, "Acceso listo para Seguridad");
      mensaje("Biometría validada. Entrevista agendada y acceso creado para Seguridad.");
    }));
    $$("[data-rechazar-biometria]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      const razonRechazo = prompt("Motivo para rechazar biometría:", "Imagen borrosa o rostro no visible correctamente");
      await cambiarEstadoRh(boton.dataset.rechazarBiometria, "Biometria rechazada por RH", razonRechazo || "Biometría no aceptada por RH");
      mensaje("Biometría rechazada. Recluta deberá capturar de nuevo.");
    }));
  }

  const busquedasPersistentes = new Map();

  function conectarBuscador(contenedor) {
    const inputs = $$("[data-buscar-nombres]", contenedor);
    if (!inputs.length) return;

    const panelKey = contenedor?.id || contenedor?.dataset?.panel || "buscador-general";
    const normalizarTexto = (texto = "") => texto
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

    inputs.forEach((input, indice) => {
      const clave = `${panelKey}:${indice}`;
      const listaBotones = $$(".boton-nombre", contenedor);
      if (!listaBotones.length) return;

      let mensajeNoExiste = input.parentElement?.querySelector(".mensaje-busqueda");
      if (!mensajeNoExiste) {
        mensajeNoExiste = document.createElement("div");
        mensajeNoExiste.className = "mensaje-busqueda";
        mensajeNoExiste.textContent = "Persona no existente";
        mensajeNoExiste.style.display = "none";
        input.parentElement?.appendChild(mensajeNoExiste);
      }

      const valorGuardado = busquedasPersistentes.get(clave) || "";
      if (!input.value && valorGuardado) {
        input.value = valorGuardado;
      }

      const aplicarFiltro = () => {
        const texto = normalizarTexto(input.value || "");
        busquedasPersistentes.set(clave, input.value || "");

        const visibles = [];
        listaBotones.forEach((boton) => {
          const nombreNormalizado = normalizarTexto(boton.textContent || "");
          const palabras = texto.split(/\s+/).filter(Boolean);
          const coincide = !texto || nombreNormalizado.includes(texto) || palabras.every((palabra) => nombreNormalizado.includes(palabra));
          boton.style.display = coincide ? "" : "none";
          if (coincide) visibles.push(boton);
        });

        if (!texto) {
          mensajeNoExiste.style.display = "none";
          return;
        }

        if (!visibles.length) {
          mensajeNoExiste.style.display = "block";
          return;
        }

        mensajeNoExiste.style.display = "none";

        const coincidenciaExacta = visibles.find((boton) => {
          const nombreNormalizado = normalizarTexto(boton.textContent || "");
          return nombreNormalizado === texto || nombreNormalizado.startsWith(`${texto} `);
        });

        const activoActual = listaBotones.find((boton) => boton.classList.contains("activo") && boton.style.display !== "none");
        const siguienteActivo = coincidenciaExacta || (visibles.length === 1 ? visibles[0] : null);

        if (siguienteActivo && (!activoActual || activoActual !== siguienteActivo)) {
          listaBotones.forEach((boton) => {
            boton.classList.toggle("activo", boton === siguienteActivo);
          });
          siguienteActivo.scrollIntoView({ block: "nearest", behavior: "smooth" });
          siguienteActivo.click();
        }
      };

      input.oninput = aplicarFiltro;
      input.onfocus = () => {
        if (!input.value && valorGuardado) {
          input.value = valorGuardado;
        }
        aplicarFiltro();
      };
      aplicarFiltro();
    });
  }

  function renderizarBiometria(selector, postulaciones) {
    const vista = $(selector);
    if (!vista) return;
    vista.innerHTML = postulaciones.length ? postulaciones.map((p) => {
      const imagen = p.biometria?.imagenBase64;
      return `
        <article class="biometria-item">
          ${imagen ? `<img src="${imagen}" alt="Biometria de ${p.nombreRecluta}">` : `<div class="preview">Pendiente de captura</div>`}
          <h3>${p.nombreRecluta}</h3>
          <p>${p.tituloVacante} · ${p.biometria?.capturadaEn ? new Date(p.biometria.capturadaEn).toLocaleString("es-MX") : "Sin fecha biometrica"}</p>
        </article>
      `;
    }).join("") : "<p>Aún no hay datos biométricos.</p>";
  }

  function archivoADataUrl(archivo) {
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => resolve({
        nombre: archivo.name,
        tipo: archivo.type || "application/octet-stream",
        contenidoBase64: lector.result
      });
      lector.onerror = reject;
      lector.readAsDataURL(archivo);
    });
  }

  function abrirArchivoBase64(contenidoBase64) {
    const ventana = window.open();
    if (!ventana) {
      mensaje("El navegador bloqueo la ventana del CV.");
      return;
    }
    ventana.document.write(`<iframe src="${contenidoBase64}" style="border:0;width:100%;height:100vh"></iframe>`);
  }

  function abrirImagenBase64(contenidoBase64, titulo = "Biometría") {
    const ventana = window.open();
    if (!ventana) {
      mensaje("El navegador bloqueo la vista de la biometría.");
      return;
    }
    ventana.document.write(`
      <html>
        <head>
          <title>${titulo}</title>
          <style>
            body { margin: 0; display: grid; place-items: center; background: #0f172a; font-family: sans-serif; }
            img { max-width: 92vw; max-height: 92vh; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.25); }
          </style>
        </head>
        <body>
          <img src="${contenidoBase64}" alt="${titulo}">
        </body>
      </html>
    `);
  }

  function obtenerUrlEsp32(silencioso = false) {
    const url = localStorage.getItem("ContrataT-esp32cam-url");
    const urlNormalizada = normalizarUrlEsp32(url);
    if (url && url !== urlNormalizada) {
      localStorage.setItem("ContrataT-esp32cam-url", urlNormalizada);
    }
    if (!urlNormalizada && !silencioso) {
      mensaje("Configura la IP de la ESP32-CAM primero.");
    }
    return urlNormalizada || "";
  }

  function obtenerUrlServo(silencioso = false) {
    const url = localStorage.getItem("ContrataT-servo-url");
    const urlNormalizada = normalizarUrlEsp32(url);
    if (url && url !== urlNormalizada) {
      localStorage.setItem("ContrataT-servo-url", urlNormalizada);
    }
    if (!urlNormalizada && !silencioso) {
      mensaje("Configura la IP del servo primero.");
    }
    return urlNormalizada || "";
  }
})();















