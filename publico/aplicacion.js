(function () {
  const portal = document.body.dataset.portal;
  const claveSesion = "ContrataT-sesion";
  let usuario = cargarSesion();
  let streamCamara = null;
  let streamSeguridad = null;
  let postulacionActual = null;
  let historialRecluta = null;
  let accesoSeleccionado = null;
  let temporizadorReenvioCodigo = null;

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
    // Nota: agrega el boton Mostrar/Ocultar a todas las contrasenas de login y registro.
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
    if (ayuda) ayuda.textContent = "Registro interno local: crea la contrasena directamente.";
  }

  function cargarSesion() {
    const sesion = localStorage.getItem(claveSesion);
    return sesion ? JSON.parse(sesion) : null;
  }

  function guardarSesion(nuevaSesion) {
    usuario = nuevaSesion;
    if (usuario) localStorage.setItem(claveSesion, JSON.stringify(usuario));
    else localStorage.removeItem(claveSesion);
    renderizar();
  }

  async function api(ruta, opciones = {}) {
    const respuesta = await fetch(ruta, {
      headers: { "Content-Type": "application/json", ...(opciones.headers || {}) },
      ...opciones
    });
    const datos = await respuesta.json().catch(() => null);
    if (!respuesta.ok) {
      throw new Error(datos?.mensaje || "Ocurrio un error en el servidor");
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
        mensaje("Primero valida el codigo enviado a tu correo.");
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
        mensaje("Escribe nombre y correo antes de pedir el codigo.");
        return;
      }
      if ((portal === "rh" || portal === "seguridad") && !datos.numeroReloj) {
        mensaje("Escribe el numero de reloj del empleado.");
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
            ? "Modo prueba: tu codigo es " + respuesta.tokenPrueba
            : "Revisa tu correo y escribe el codigo recibido.";
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
    const textoOriginal = "Enviar codigo al correo";
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

  function configurarMenu() {
    $$("[data-seccion]").forEach((boton) => {
      boton.addEventListener("click", () => {
        const destino = boton.dataset.seccion;
        $$("[data-seccion]").forEach((tab) => tab.classList.toggle("activo", tab === boton));
        $$("[data-panel]").forEach((panel) => panel.classList.toggle("activo", panel.dataset.panel === destino));
      });
    });
  }

  function configurarSesion() {
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
        mensaje("Sesion cerrada.");
      });
    });
  }

  function configurarVacantesRh() {
    $("#formVacanteRh")?.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const datos = Object.fromEntries(new FormData(evento.currentTarget));
      try {
        await api("/api/rh/vacantes", {
          method: "POST",
          body: JSON.stringify(datos)
        });
        evento.currentTarget.reset();
        mensaje("Vacante publicada. Ya aparece en Recluta.");
        await renderizarRh();
      } catch (error) {
        mensaje(error.message);
      }
    });
  }

  async function renderizar() {
    const sesionValida = usuario && usuario.portal === portal;
    // Nota: los botones de inicio/cerrar sesion solo aparecen cuando ya hay sesion iniciada.
    $(".sesion")?.classList.toggle("oculto", !sesionValida);
    $("#vistaAcceso")?.classList.toggle("oculto", Boolean(sesionValida));
    $("#vistaApp")?.classList.toggle("oculto", !sesionValida);
    if ($("#nombreUsuario")) $("#nombreUsuario").textContent = sesionValida ? usuario.nombreCompleto + (usuario.contratado || usuario.tipoUsuario === "empleado" ? " · Empleado" : "") : "Invitado";
    if (!sesionValida) return;

    if (portal === "recluta") await renderizarRecluta();
    if (portal === "rh") await renderizarRh();
    if (portal === "seguridad") await renderizarSeguridad();
  }

  async function renderizarRecluta() {
    const vacantes = await api("/api/vacantes");
    $("#totalVacantes").textContent = vacantes.length;
    $("#listaVacantes").innerHTML = usuario.contratado ? `<article class="item"><div><h3>Usuario contratado</h3><p>Tu cuenta ya esta registrada como empleado de esta empresa. Puedes consultar tu historial y acceso planta !Gracias por utilizar ContrataT¡.</p></div><span class="estado">Empleado</span></article>` : vacantes.map((vacante) => `
      <article class="item">
        <div>
          <h3>${vacante.titulo}</h3>
          <p>${vacante.descripcion}</p>
          <div class="meta"><span>${vacante.area}</span><span>Turno: ${vacante.turno || vacante.horario || "Pendiente"}</span><span>${vacante.horario}</span><span>${vacante.ubicacion}</span></div>
          <label class="campo-cv">Subir CV para RH<input type="file" accept=".pdf,.doc,.docx" data-cv="${vacante._id}"></label>
        </div>
        <button class="boton-principal" data-aplicar="${vacante._id}">Mandar CV</button>
      </article>
    `).join("");

    $$("[data-aplicar]").forEach((boton) => {
      boton.addEventListener("click", async () => {
        const archivo = $(`[data-cv="${boton.dataset.aplicar}"]`)?.files?.[0];
        if (!archivo) {
          mensaje("Primero selecciona tu CV para que RH lo pueda revisar.");
          return;
        }
        const cv = await archivoADataUrl(archivo);
        postulacionActual = await api("/api/postulaciones", {
          method: "POST",
          body: JSON.stringify({ reclutaId: usuario._id, vacanteId: boton.dataset.aplicar, cv })
        });
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

  function configurarCamara() {
    $("#iniciarCamara")?.addEventListener("click", async () => {
      if (!postulacionActual) {
        mensaje("Primero manda tu CV a RH.");
        return;
      }
      if (!puedeCapturarBiometria(postulacionActual)) {
        mensaje("RH todavia no ha autorizado o solicitado la captura biometrica.");
        return;
      }
      if (!$("#aceptaPrivacidad")?.checked) {
        mensaje("Acepta el aviso de privacidad antes de abrir la camara.");
        return;
      }
      try {
        streamCamara = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        $("#videoCamara").srcObject = streamCamara;
        mensaje("Camara activa. Coloca tu rostro al centro.");
      } catch (error) {
        mensaje("No se pudo abrir la camara. Revisa permisos del navegador.");
      }
    });

    $("#capturarFoto")?.addEventListener("click", async () => {
      const video = $("#videoCamara");
      const canvas = $("#canvasCamara");
      if (!postulacionActual || !video?.srcObject) {
        mensaje("Solicita la camara antes de capturar.");
        return;
      }
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const imagenBase64 = canvas.toDataURL("image/png");
      postulacionActual = await api("/api/postulaciones/" + postulacionActual._id + "/biometria", {
        method: "PUT",
        body: JSON.stringify({ imagenBase64, aceptoPrivacidad: true })
      });
      detenerCamara();
      mostrarBiometriaRecluta();
      mostrarEstadoRecluta();
      mensaje("Imagen biometrica guardada para RH y Seguridad.");
    });

    $("#capturarSeguridad")?.addEventListener("click", capturarRostroSeguridad);
    $("#confirmarCoincide")?.addEventListener("click", () => validarSeguridad(true));
    $("#confirmarNoCoincide")?.addEventListener("click", () => validarSeguridad(false));
  }

  function detenerCamara() {
    if (!streamCamara) return;
    streamCamara.getTracks().forEach((track) => track.stop());
    streamCamara = null;
    if ($("#videoCamara")) $("#videoCamara").srcObject = null;
  }

  function detenerCamaraSeguridad() {
    if (!streamSeguridad) return;
    streamSeguridad.getTracks().forEach((track) => track.stop());
    streamSeguridad = null;
    if ($("#videoSeguridad")) $("#videoSeguridad").srcObject = null;
  }

  function mostrarBiometriaRecluta() {
    const vista = $("#vistaBiometriaRecluta");
    if (!vista) return;
    const imagen = postulacionActual?.biometria?.imagenBase64;
    vista.innerHTML = imagen ? `<img src="${imagen}" alt="Imagen biometrica capturada">` : "Sin captura biometrica";
    const autorizado = puedeCapturarBiometria(postulacionActual);
    $("#bloqueoCamara").textContent = autorizado
      ? "RH autorizo o solicito tu captura biometrica. Toma la foto de frente, con buena luz y sin cubrir el rostro."
      : "La camara se habilita cuando RH valida tu CV y da acceso a la empresa.";
    $("#iniciarCamara").disabled = !autorizado;
    $("#capturarFoto").disabled = !autorizado;
  }

  function puedeCapturarBiometria(postulacion) {
    return postulacion?.estado === "Acceso autorizado por RH" || postulacion?.estado === "Biometria rechazada por RH";
  }

  function puedeCancelarPostulacion(postulacion) {
    const estadosFinalesOEntrevista = [
      "Postulacion cancelada por Recluta",
      "Acceso cerrado",
      "Acceso vencido",
      "Acceso verificado por Seguridad",
      "Asistio a entrevista",
      "No asistio a entrevista",
      "No aceptado despues de entrevista",
      "Perfil egresado generado"
    ];
    return postulacion && !estadosFinalesOEntrevista.includes(postulacion.estado);
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
    if (!postulacionActual) {
      vista.innerHTML = "<p>Aun no has aplicado a una vacante.</p>";
      return;
    }
    vista.innerHTML = `
      <span class="estado">${postulacionActual.estado}</span>
      <h3>${postulacionActual.tituloVacante}</h3>
      <p>CV enviado: ${postulacionActual.cv?.nombre || "Sin CV"}</p>
      <p>Entrevista: ${postulacionActual.fechaEntrevista || "Pendiente de validar biometria"} · Hora limite: ${postulacionActual.horaLimite || "Sin hora"} · Entrevistador: ${postulacionActual.entrevistador || "Sin entrevistador"}</p>
      <p>Direccion: ${postulacionActual.direccion || "Sin direccion acordada"}</p>
      <p>${postulacionActual.razonRechazo ? "Razon de rechazo: " + postulacionActual.razonRechazo : "Consulta aqui la respuesta de RH."}</p>
      ${postulacionActual.estado === "Perfil egresado generado" ? `<p><strong>Pasaste la entrevista.</strong> Dia de induccion: ${postulacionActual.fechaInduccion || "Por definir"}</p><button class="boton-principal separacion" type="button" data-ir-perfil-egresado>Ver acceso planta</button>` : ""}
      ${puedeCancelarPostulacion(postulacionActual) ? `<button class="boton-peligro separacion" type="button" data-cancelar-postulacion="${postulacionActual._id}">Cancelar postulacion</button>` : ""}
    `;
    $("[data-cancelar-postulacion]", vista)?.addEventListener("click", cancelarPostulacionRecluta);
    $("[data-ir-perfil-egresado]", vista)?.addEventListener("click", () => $("[data-seccion='perfilEgresadoRecluta']")?.click());
  }

  async function cancelarPostulacionRecluta() {
    if (!postulacionActual) return;
    const confirmar = confirm("Esta seguro que desea cancelar la postulacion? Se cancelara la entrevista, se eliminaran los datos biometricos y tendra que iniciar el proceso de nuevo si quiere postular.");
    if (!confirmar) return;
    postulacionActual = await api("/api/postulaciones/" + postulacionActual._id + "/cancelar", { method: "PATCH" });
    mensaje("Postulacion cancelada. RH recibio la notificacion.");
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
        <span class="estado">Sin postulacion</span>
        <h3>Primero manda tu CV</h3>
        <p>Selecciona una vacante disponible, adjunta tu CV y presiona <strong>Mandar CV</strong>. RH revisara tu informacion.</p>
      `;
      return;
    }

    if (postulacionActual.estado === "Acceso autorizado por RH") {
      vista.innerHTML = `
        <span class="estado">CV validado para entrevista</span>
        <h3>Registra tus datos biometricos para agendarte una entrevista</h3>
        <p>RH valido tu CV para entrevista. Registra tus datos biometricos para agendarte una entrevista.</p>
        <div class="pasos separacion">
          <span>Entra a Datos biometricos</span>
          <span>Acepta el aviso de privacidad</span>
          <span>Solicita la camara</span>
          <span>Captura tu rostro</span>
        </div>
        <p class="separacion">Si RH valida tu imagen biometrica, se agendara tu entrevista y se enviara el acceso a Seguridad.</p>
        <button class="boton-principal" type="button" data-ir-biometria>Ir a datos biometricos</button>
      `;
      $("[data-ir-biometria]", vista)?.addEventListener("click", () => $("[data-seccion='biometria']")?.click());
      return;
    }

    if (postulacionActual.estado === "Biometria rechazada por RH") {
      vista.innerHTML = `
        <span class="estado">Biometria rechazada por RH</span>
        <h3>Vuelve a registrar tus datos biometricos</h3>
        <p>${postulacionActual.mensajeAutomatico || "RH no valido tu imagen biometrica. Debes registrar tus datos biometricos otra vez para continuar con la entrevista."}</p>
        <div class="pasos separacion">
          <span>Entra a Datos biometricos</span>
          <span>Acepta privacidad</span>
          <span>Solicita la camara</span>
          <span>Captura rostro nuevamente</span>
        </div>
        <button class="boton-principal separacion" type="button" data-ir-biometria>Repetir biometria</button>
      `;
      $("[data-ir-biometria]", vista)?.addEventListener("click", () => $("[data-seccion='biometria']")?.click());
      return;
    }

    if (postulacionActual.estado === "Biometria pendiente de revision RH") {
      vista.innerHTML = `
        <span class="estado">Biometria registrada</span>
        <h3>Espera revision de RH</h3>
        <p>Tu rostro ya fue capturado. RH debe validar la biometria para agendar tu entrevista y generar el acceso visible en Seguridad.</p>
        <p>Entrevista: pendiente hasta que RH valide tu biometria.</p>
      `;
      return;
    }

    if (postulacionActual.estado === "Acceso listo para Seguridad") {
      vista.innerHTML = `
        <span class="estado">Acceso listo para Seguridad</span>
        <h3>Tu acceso fue generado</h3>
        <p>RH valido tu biometria. Tu entrevista ya fue agendada y Seguridad podra comparar tu rostro al llegar.</p>
        <p>Entrevista: ${postulacionActual.fechaEntrevista || "Por definir"} · Hora limite: ${postulacionActual.horaLimite || "Sin hora"} · Entrevistador: ${postulacionActual.entrevistador || "Sin entrevistador"}</p>
      `;
      return;
    }

    if (postulacionActual.estado === "Postulacion cancelada por Recluta") {
      vista.innerHTML = `
        <span class="estado">Postulacion cancelada</span>
        <h3>Proceso cancelado</h3>
        <p>Cancelaste la entrevista y la postulacion.</p>
        <p>Si quieres postular de nuevo, entra a Vacantes, sube tu CV y comienza el proceso otra vez.</p>
      `;
      return;
    }

    if (postulacionActual.estado === "Perfil egresado generado") {
      vista.innerHTML = `
        <span class="estado">Aceptado como nuevo ingreso</span>
        <h3>Pasaste la entrevista</h3>
        <p>Felicidades. RH creo tu acceso para iniciar induccion en el puesto <strong>${postulacionActual.tituloVacante}</strong>.</p>
        <p>Debes asistir a induccion el dia: <strong>${postulacionActual.fechaInduccion || "Por definir"}</strong>.</p>
        <p>Desde ahora debes usar tu <strong>Acceso planta</strong> para entrar. Ese perfil ya contiene tu imagen validada, por eso no necesitas volver a registrar datos biometricos.</p>
        <button class="boton-principal" type="button" data-ir-perfil-egresado>Ver acceso planta</button>
      `;
      $("[data-ir-perfil-egresado]", vista)?.addEventListener("click", () => $("[data-seccion='perfilEgresadoRecluta']")?.click());
      return;
    }

    if (postulacionActual.estado.includes("negado") || postulacionActual.estado === "Acceso vencido") {
      vista.innerHTML = `
        <span class="estado">${postulacionActual.estado}</span>
        <h3>No puedes registrar biometria</h3>
        <p>${postulacionActual.razonRechazo || "RH o Seguridad no autorizo el acceso."}</p>
      `;
      return;
    }

    vista.innerHTML = `
      <span class="estado">${postulacionActual.estado}</span>
      <h3>Espera la respuesta de RH</h3>
      <p>Tu CV fue enviado a RH. Cuando RH de acceso a la empresa, aqui aparecera el mensaje para registrar tus datos biometricos.</p>
      <p>Consulta este apartado o la pestaña Estado para ver avances.</p>
    `;
  }

  function mostrarPerfilEgresadoRecluta() {
    const vista = $("#perfilEgresadoRecluta");
    if (!vista) return;
    if (!postulacionActual || postulacionActual.estado !== "Perfil egresado generado") {
      vista.innerHTML = "<p>Tu acceso planta aparecera cuando RH confirme que fuiste aceptado en el puesto.</p>";
      return;
    }
    vista.innerHTML = `
      <span class="estado">Acceso planta generado</span>
      <h3>${postulacionActual.nombreRecluta}</h3>
      <p><strong>Dia de induccion:</strong> ${postulacionActual.fechaInduccion || "Por definir"}</p>
      ${postulacionActual.biometria?.imagenBase64 ? `<img src="${postulacionActual.biometria.imagenBase64}" alt="Imagen biometrica de ${postulacionActual.nombreRecluta}">` : `<div class="preview">Sin imagen biometrica</div>`}
      <h3 class="separacion">${postulacionActual.tituloVacante}</h3>
      <article class="tarjeta separacion">
        <h3>Que es su puesto</h3>
        <p>${postulacionActual.queEsVacante || postulacionActual.areaVacante || "Puesto asignado por RH por medio de ContrataT."}</p>
      </article>
      <article class="tarjeta separacion">
        <h3>Que hace en su puesto</h3>
        <p>${postulacionActual.descripcionVacante || "Realiza las actividades asignadas al puesto y reporta avances a su responsable."}</p>
      </article>
      <div class="meta"><span>${postulacionActual.areaVacante || "Area pendiente"}</span><span>Turno: ${postulacionActual.turnoVacante || "Pendiente"}</span><span>${postulacionActual.horarioVacante || "Horario pendiente"}</span><span>${postulacionActual.ubicacionVacante || "Ubicacion pendiente"}</span></div>
    `;
  }


  function mostrarHistorialRecluta() {
    const vista = $("#historialRecluta");
    if (!vista) return;
    const registros = historialRecluta?.postulaciones || [];
    if (!registros.length) {
      vista.innerHTML = "<p>Tu historial se creara cuando RH acepte o rechace tu postulacion para entrevista.</p>";
      return;
    }
    const contratado = historialRecluta.contratado;
    vista.innerHTML = `
      <article class="item">
        <div>
          <h3>Resumen del recluta</h3>
          <p>Historial creado con <strong>${historialRecluta.totalAplicaciones}</strong> postulacion(es) ya aceptadas o rechazadas por RH.</p>
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
            ${p.razonRechazo ? `<p><strong>Razon:</strong> ${p.razonRechazo}</p>` : ""}
            ${p.fechaInduccion ? `<p><strong>Induccion:</strong> ${p.fechaInduccion}</p>` : ""}
          </div>
          <span class="estado">${p.estado === "Perfil egresado generado" ? "Contratado" : "Proceso"}</span>
        </article>
      `).join("")}
    `;
  }

  async function renderizarRh() {
    const postulaciones = await api("/api/rh/postulaciones");
    const vacantes = await api("/api/rh/vacantes");
    const canceladas = postulaciones.filter((p) => p.estado === "Postulacion cancelada por Recluta");
    const rechazadas = postulaciones.filter((p) => [
      "Acceso negado por RH",
      "Acceso negado por Seguridad",
      "Acceso vencido",
      "No asistio a entrevista",
      "No aceptado despues de entrevista"
    ].includes(p.estado));
    const activas = postulaciones.filter((p) => !canceladas.includes(p) && !rechazadas.includes(p));

    $("#totalPostulaciones").textContent = activas.length;
    renderizarListaRh("#listaRh", activas, postulaciones, "No hay CV recibidos.", true);
    renderizarListaRh("#listaCvRechazadosRh", rechazadas, postulaciones, "No hay CV rechazados.", false);
    renderizarListaRh("#listaCanceladosRh", canceladas, postulaciones, "No hay postulaciones canceladas.", false);

    $$("[data-ver-cv]").forEach((boton) => boton.addEventListener("click", () => {
      const postulacion = postulaciones.find((p) => p._id === boton.dataset.verCv);
      if (!postulacion?.cv?.contenidoBase64) {
        mensaje("Esta postulacion no tiene CV adjunto.");
        return;
      }
      abrirArchivoBase64(postulacion.cv.contenidoBase64);
    }));
    $$("[data-aceptar]").forEach((boton) => boton.addEventListener("click", () => cambiarEstadoRh(boton.dataset.aceptar, "Acceso autorizado por RH")));
    $$("[data-rechazar]").forEach((boton) => boton.addEventListener("click", () => {
      const razonRechazo = prompt("Razon para no dar acceso:", "CV no cumple requisitos de la vacante");
      cambiarEstadoRh(boton.dataset.rechazar, "Acceso negado por RH", razonRechazo || "Sin razon capturada");
    }));
    renderizarBiometriaSeleccionable("#biometriaRh", postulaciones, "rh");
    renderizarReclutarRh(postulaciones.filter((p) => !["Postulacion cancelada por Recluta", "Acceso negado por RH", "Biometria rechazada por RH", "Acceso negado por Seguridad", "Acceso vencido", "Perfil egresado generado"].includes(p.estado)));
    const aceptados = postulaciones.filter((p) => p.estado === "Perfil egresado generado");
    renderizarPerfilesEgresado(aceptados);
    renderizarVacantesRh(vacantes);
  }

  function renderizarListaRh(selector, lista, postulaciones, mensajeVacio, puedeDecidir) {
    const contenedor = $(selector);
    if (!contenedor) return;
    contenedor.innerHTML = lista.length ? lista.map((p) => `
      <article class="item">
        <div>
          <h3>${p.nombreRecluta}</h3>
          <p>${p.tituloVacante} · ${p.estado}</p>
          ${p.notificacionRh ? `<p><strong>Notificacion:</strong> ${p.notificacionRh}</p>` : ""}
          <p>CV recibido: ${p.cv?.nombre || "Sin CV adjunto"}</p>
          <div class="meta"><span>${p.fechaEntrevista}</span><span>${p.entrevistador}</span><span>${p.direccion}</span></div>
        </div>
        <div class="acciones">
          <button class="boton-secundario" data-ver-cv="${p._id}">Ver CV</button>
          ${puedeDecidir && p.estado === "CV enviado a RH" ? `<button class="boton-exito" data-aceptar="${p._id}">Validar CV para entrevista</button><button class="boton-peligro" data-rechazar="${p._id}">No dar acceso</button>` : `<span class="estado">${p.estado === "Acceso autorizado por RH" ? "Acceso permitido" : p.estado}</span>`}
        </div>
      </article>
    `).join("") : `<p>${mensajeVacio}</p>`;
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
    $("#totalAccesos").textContent = accesos.length;
    renderizarAccesosSeguridad(accesos);
    renderizarRechazadosSeleccionables(rechazados);
  }

  async function iniciarVerificacionSeguridad(postulacion) {
    accesoSeleccionado = postulacion;
    $("#panelVerificacionSeguridad")?.classList.remove("oculto");
    $("#comparacionSeguridad").innerHTML = `
      <article class="biometria-item">
        ${postulacion.biometria?.imagenBase64 ? `<img src="${postulacion.biometria.imagenBase64}" alt="Biometria guardada">` : `<div class="preview">Sin biometria guardada</div>`}
        <h3>Rostro guardado</h3>
        <p>${postulacion.nombreRecluta}</p>
      </article>
      <article class="biometria-item">
        <div id="capturaActualSeguridad" class="preview">Captura pendiente</div>
        <h3>Rostro actual</h3>
        <p>Camara de seguridad</p>
      </article>
    `;
    try {
      streamSeguridad = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      $("#videoSeguridad").srcObject = streamSeguridad;
      mensaje("Camara de seguridad activa para verificar rostro.");
    } catch (error) {
      mensaje("No se pudo abrir la camara de seguridad.");
    }
  }

  function capturarRostroSeguridad() {
    const video = $("#videoSeguridad");
    const canvas = $("#canvasSeguridad");
    if (!accesoSeleccionado || !video?.srcObject) {
      mensaje("Primero selecciona un acceso y abre la camara.");
      return;
    }
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const imagen = canvas.toDataURL("image/png");
    $("#capturaActualSeguridad").innerHTML = `<img src="${imagen}" alt="Rostro actual capturado">`;
    accesoSeleccionado.capturaSeguridad = imagen;
    mensaje("Captura actual lista. Compara visualmente y confirma.");
  }

  async function validarSeguridad(coincide) {
    if (!accesoSeleccionado) {
      mensaje("Selecciona un acceso para verificar.");
      return;
    }
    if (coincide) {
      await abrirPuertaEsp32Cam();
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
    mensaje(coincide ? "Rostro verificado. Acceso permitido." : "Rostro no coincide. Acceso negado.");
    await renderizarSeguridad();
  }

  async function abrirPuertaEsp32Cam() {
    let urlEsp32 = localStorage.getItem("ContrataT-esp32cam-url") || "";
    if (!urlEsp32) {
      urlEsp32 = prompt("Escribe la URL del ESP32-CAM para abrir la puerta:", "http://192.168.1.50") || "";
      urlEsp32 = urlEsp32.trim().replace(/\/$/, "");
      if (urlEsp32) localStorage.setItem("ContrataT-esp32cam-url", urlEsp32);
    }
    if (!urlEsp32) {
      mensaje("No se envio senal al ESP32-CAM porque no se configuro URL.");
      return;
    }
    try {
      await fetch(urlEsp32 + "/abrir", { method: "GET", mode: "cors" });
      mensaje("Senal enviada al ESP32-CAM. Puerta abierta.");
    } catch (error) {
      mensaje("No se pudo conectar con el ESP32-CAM. Revisa IP, WiFi y energia.");
    }
  }

  function renderizarAccesosSeguridad(accesos) {
    const contenedor = $("#listaAccesos");
    if (!contenedor) return;
    if (!accesos.length) {
      contenedor.innerHTML = "<p>No hay accesos activos.</p>";
      return;
    }
    contenedor.innerHTML = `
      <div class="selector-detalle">
        <div><input class="buscador" data-buscar-nombres placeholder="Buscar por nombre"><div class="lista-nombres">
          ${accesos.map((p, indice) => `<button class="boton-nombre ${indice === 0 ? "activo" : ""}" data-seleccionar-acceso="${p._id}">${p.nombreRecluta}</button>`).join("")}
        </div></div>
        <div id="detalleAccesoSeguridad" class="detalle-persona"></div>
      </div>
    `;

    const mostrar = (postulacion) => {
      $("#detalleAccesoSeguridad").innerHTML = `
        <h3>${postulacion.nombreRecluta}</h3>
        <p>${postulacion.tituloVacante} · ${postulacion.estado}</p>
        <div class="meta"><span>Entrevista: ${postulacion.fechaEntrevista}</span><span>Hora limite ${postulacion.horaLimite}</span><span>${postulacion.direccion}</span></div>
        <p>Entrevistador: ${postulacion.entrevistador}</p>
        ${postulacion.biometria?.imagenBase64 ? `<img src="${postulacion.biometria.imagenBase64}" alt="Biometria de ${postulacion.nombreRecluta}">` : `<div class="preview">Sin biometria</div>`}
        <div class="acciones separacion"><button class="boton-principal" data-verificar-acceso="${postulacion._id}">Verificar con camara</button><button class="boton-secundario" data-cerrar-acceso="${postulacion._id}">Cerrar acceso</button></div>
      `;
      enlazarBotonesAcceso();
    };

    const enlazarBotonesAcceso = () => {
      $$("[data-verificar-acceso]", contenedor).forEach((boton) => boton.addEventListener("click", () => iniciarVerificacionSeguridad(accesos.find((p) => p._id === boton.dataset.verificarAcceso))));
      $$("[data-cerrar-acceso]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
        await api("/api/seguridad/accesos/" + boton.dataset.cerrarAcceso + "/cerrar", { method: "PATCH" });
        mensaje("Acceso cerrado en MongoDB Atlas.");
        await renderizarSeguridad();
      }));
    };

    $$("[data-seleccionar-acceso]", contenedor).forEach((boton) => boton.addEventListener("click", () => {
      $$("[data-seleccionar-acceso]", contenedor).forEach((b) => b.classList.toggle("activo", b === boton));
      mostrar(accesos.find((p) => p._id === boton.dataset.seleccionarAcceso));
    }));
    conectarBuscador(contenedor);
    mostrar(accesos[0]);
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
        <p class="separacion">${p.razonRechazo || "Sin razon capturada"}</p>
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
        <p class="separacion">Dia de induccion: ${p.fechaInduccion || "Por definir"}</p>
        ${p.biometria?.imagenBase64 ? `<img src="${p.biometria.imagenBase64}" alt="Imagen de ${p.nombreRecluta}">` : `<div class="preview">Sin imagen</div>`}
        <h3 class="separacion">${p.tituloVacante}</h3>
        <p><strong>Que es:</strong> ${p.queEsVacante || p.areaVacante || "Puesto operativo"}</p>
        <p><strong>Que hace:</strong> ${p.descripcionVacante || "Realiza las actividades asignadas al puesto y reporta avances a su responsable."}</p>
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

  function renderizarReclutarRh(candidatos) {
    const contenedor = $("#listaReclutarRh");
    if (!contenedor) return;
    if (!candidatos.length) {
      contenedor.innerHTML = "<p>No hay reclutas listos para validar entrevista.</p>";
      return;
    }
    contenedor.innerHTML = `
      <div class="selector-detalle">
        <div><input class="buscador" data-buscar-nombres placeholder="Buscar por nombre"><div class="lista-nombres">
          ${candidatos.map((p, indice) => `<button class="boton-nombre ${indice === 0 ? "activo" : ""}" data-seleccionar-reclutar="${p._id}">${p.nombreRecluta}</button>`).join("")}
        </div></div>
        <div id="detalleReclutarRh" class="detalle-persona"></div>
      </div>
    `;

    const mostrar = (p) => {
      $("#detalleReclutarRh").innerHTML = `
        <h3>${p.nombreRecluta}</h3>
        <span class="estado">${p.estado}</span>
        <p class="separacion"><strong>Puesto:</strong> ${p.tituloVacante}</p>
        <p><strong>Que es:</strong> ${p.queEsVacante || p.areaVacante || "Puesto operativo"}</p>
        <p><strong>Que hace:</strong> ${p.descripcionVacante || "Actividades asignadas por el area."}</p>
        ${p.biometria?.imagenBase64 ? `<img src="${p.biometria.imagenBase64}" alt="Biometria de ${p.nombreRecluta}">` : `<div class="preview">Sin biometria</div>`}
        <div class="meta separacion"><span>${p.fechaEntrevista || "Fecha pendiente"}</span><span>${p.horaLimite || "Sin hora limite"}</span><span>${p.entrevistador || "Sin entrevistador"}</span></div>
        <h3 class="separacion">Asistio?</h3>
        <div class="acciones">
          <button class="boton-exito" data-asistio-entrevista="${p._id}">Si asistio</button>
          <button class="boton-peligro" data-no-asistio-entrevista="${p._id}">No asistio</button>
        </div>
        <div id="decisionEntrevistaRh" class="separacion ${p.asistioEntrevista ? "" : "oculto"}">
          <h3>Paso la entrevista?</h3>
          <div class="acciones">
            <button class="boton-exito" data-generar-egresado="${p._id}">Si, generar perfil</button>
            <button class="boton-peligro" data-no-paso-entrevista="${p._id}">No paso entrevista</button>
          </div>
        </div>
      `;
      enlazarDecisionEntrevista(contenedor);
    };

    $$("[data-seleccionar-reclutar]", contenedor).forEach((boton) => boton.addEventListener("click", () => {
      $$("[data-seleccionar-reclutar]", contenedor).forEach((b) => b.classList.toggle("activo", b === boton));
      mostrar(candidatos.find((p) => p._id === boton.dataset.seleccionarReclutar));
    }));
    conectarBuscador(contenedor);
    mostrar(candidatos[0]);
  }

  function enlazarDecisionEntrevista(contenedor) {
    $$("[data-asistio-entrevista]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      await cambiarEstadoRh(boton.dataset.asistioEntrevista, "Asistio a entrevista");
      mensaje("Asistencia registrada. Ahora decide si paso entrevista.");
    }));
    $$("[data-no-asistio-entrevista]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      const razonRechazo = prompt("Motivo de inasistencia:", "No asistio a la entrevista en la hora acordada");
      await cambiarEstadoRh(boton.dataset.noAsistioEntrevista, "No asistio a entrevista", razonRechazo || "No asistio a entrevista");
      mensaje("Inasistencia registrada.");
    }));
    $$("[data-generar-egresado]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      await cambiarEstadoRh(boton.dataset.generarEgresado, "Perfil egresado generado");
      mensaje("Acceso planta generado.");
    }));
    $$("[data-no-paso-entrevista]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      const razonRechazo = prompt("Motivo por el que no paso entrevista:", "No cumple con los criterios de entrevista");
      await cambiarEstadoRh(boton.dataset.noPasoEntrevista, "No aceptado despues de entrevista", razonRechazo || "No aceptado despues de entrevista");
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
          <p><strong>Que es:</strong> ${v.queEs || v.area || "Puesto disponible"}</p>
          <p><strong>Que hace:</strong> ${v.descripcion}</p>
          <div class="meta"><span>${v.area}</span><span>Turno: ${v.turno || v.horario || "Pendiente"}</span><span>${v.horario}</span><span>${v.ubicacion}</span></div>
        </div>
        <span class="estado">${v.ocupada ? "Ocupada" : "Disponible"}</span>
      </article>
    `).join("") : "<p>No hay vacantes publicadas.</p>";
  }

  function renderizarBiometriaSeleccionable(selector, postulaciones, contexto) {
    const vista = $(selector);
    if (!vista) return;
    const conProceso = postulaciones.filter((p) => p.biometria?.imagenBase64 || p.estado.includes("Biometria") || p.estado.includes("Seguridad"));
    if (!conProceso.length) {
      vista.innerHTML = "<p>Aun no hay datos biometricos para seleccionar.</p>";
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
        <h3>${p.nombreRecluta}</h3>
        <span class="estado">${p.estado}</span>
        <p class="separacion">${p.tituloVacante}</p>
        ${p.biometria?.imagenBase64 ? `<img src="${p.biometria.imagenBase64}" alt="Biometria de ${p.nombreRecluta}">` : `<div class="preview">Pendiente de captura</div>`}
        <div class="meta separacion"><span>${p.biometria?.capturadaEn ? new Date(p.biometria.capturadaEn).toLocaleString("es-MX") : "Sin fecha biometrica"}</span><span>${p.correoRecluta || "Sin correo"}</span></div>
        ${contexto === "rh" && p.estado === "Biometria pendiente de revision RH" ? `<div class="acciones separacion"><button class="boton-exito" data-aceptar-biometria="${p._id}">Aceptar biometria</button><button class="boton-peligro" data-rechazar-biometria="${p._id}">Rechazar biometria</button></div>` : ""}
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
      mensaje("Biometria validada. Entrevista agendada y acceso creado para Seguridad.");
    }));
    $$("[data-rechazar-biometria]", contenedor).forEach((boton) => boton.addEventListener("click", async () => {
      const razonRechazo = prompt("Motivo para rechazar biometria:", "Imagen borrosa o rostro no visible correctamente");
      await cambiarEstadoRh(boton.dataset.rechazarBiometria, "Biometria rechazada por RH", razonRechazo || "Biometria no aceptada por RH");
      mensaje("Biometria rechazada. Recluta debera capturar de nuevo.");
    }));
  }

  function conectarBuscador(contenedor) {
    const input = $("[data-buscar-nombres]", contenedor);
    if (!input) return;
    input.addEventListener("input", () => {
      const texto = input.value.trim().toLowerCase();
      $$(".boton-nombre", contenedor).forEach((boton) => {
        boton.style.display = boton.textContent.toLowerCase().includes(texto) ? "" : "none";
      });
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
    }).join("") : "<p>Aun no hay datos biometricos.</p>";
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
})();



















