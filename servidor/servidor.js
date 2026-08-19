import cors from "cors";
import express from "express";
import { readFile } from "node:fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { ObjectId } from "mongodb";
import { colecciones, conectarBaseDatos, obtenerColeccion } from "./conexion.js";


dotenv.config();

const app = express();
const puerto = Number(process.env.PORT || process.env.PUERTO || 3000);
const portalPublico = process.env.PORTAL_PUBLICO === "recluta";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const carpetaPublica = path.join(__dirname, "..", "publico");

app.use(cors());
app.use(express.json({ limit: "12mb" }));
app.use((solicitud, respuesta, siguiente) => {
  respuesta.locals.portalPublico = portalPublico;
  siguiente();
});
app.use((solicitud, respuesta, siguiente) => {
  if (portalPublico && ["/rh.html", "/seguridad.html"].includes(solicitud.path)) {
    return respuesta.redirect("/");
  }
  siguiente();
});
app.get(["/", "/index.html"], async (_solicitud, respuesta, siguiente) => {
  if (!portalPublico) return siguiente();

  try {
    const index = await readFile(path.join(carpetaPublica, "index.html"), "utf8");
    respuesta.type("html").send(index.replace(
      /<nav class="cambio-portal">[\s\S]*?<\/nav>/,
      '<nav class="cambio-portal"><a class="activo" href="index.html">Recluta</a></nav>'
    ));
  } catch (error) {
    siguiente(error);
  }
});
// During development and deployment, always serve the newest interface files.
// This prevents a browser or a Render proxy from keeping an older version of
// the corrected texts, CSS or JavaScript.
app.use(express.static(carpetaPublica, {
  etag: false,
  lastModified: false,
  setHeaders: (respuesta, archivo) => {
    if (/\.(?:html|css|js)$/i.test(archivo)) {
      respuesta.setHeader("Cache-Control", "no-store, max-age=0");
    }
  }
}));

app.get("/api/salud", async (_solicitud, respuesta) => {
  const conteos = Object.fromEntries(await Promise.all(
    Object.entries(colecciones).map(async ([clave]) => [
      clave,
      await obtenerColeccion(clave).countDocuments()
    ])
  ));

  respuesta.json({
    estado: "conectado",
    empresa: process.env.NOMBRE_BASE_DATOS || "ContrataT",
    portalPublico: portalPublico ? "recluta" : "completo",
    conteos,
    colecciones
  });
});

app.post("/api/correo/solicitar-token", async (solicitud, respuesta) => {
  const { portal, correo, numeroReloj, nombreCompleto } = solicitud.body;
  if (portalPublico && portal !== "recluta") {
    return respuesta.status(403).json({ mensaje: "Este servicio público solo permite el portal Recluta" });
  }
  if (!["recluta", "rh", "seguridad"].includes(portal)) {
    return respuesta.status(400).json({ mensaje: "Portal inválido" });
  }
  if (!correo) {
    return respuesta.status(400).json({ mensaje: "Escribe un correo electrónico" });
  }
  if ((portal === "rh" || portal === "seguridad") && !numeroReloj) {
    return respuesta.status(400).json({ mensaje: "Escribe el número de reloj del empleado" });
  }

  const token = generarTokenCorreo();
  const expiraEn = new Date(Date.now() + 10 * 60 * 1000);
  const correoNormalizado = normalizarCorreo(correo);

  await obtenerColeccion("tokensCorreo").updateOne(
    { portal, correo: correoNormalizado },
    {
      $set: {
        portal,
        correo: correoNormalizado,
        numeroReloj: numeroReloj || "",
        nombreCompleto: nombreCompleto || "",
        token,
        validado: false,
        creadoEn: new Date(),
        expiraEn
      }
    },
    { upsert: true }
  );

  let envio;
  try {
    envio = await enviarTokenPorCorreo(correoNormalizado, token, portal, nombreCompleto);
  } catch (error) {
    console.error("Error al enviar correo ContrataT:", {
      host: process.env.CORREO_HOST,
      puerto: process.env.CORREO_PUERTO,
      seguro: process.env.CORREO_SEGURO,
      codigo: error.code,
      comando: error.command,
      mensaje: error.message
    });
    return respuesta.status(502).json({
      mensaje: "No se pudo enviar el correo. Revisa la configuración SMTP de Gmail en Render."
    });
  }
  await registrarBitacora("token_correo_enviado", portal, correoNormalizado, envio.modo);

  respuesta.json({
    mensaje: envio.mensaje,
    modo: envio.modo,
    tokenPrueba: envio.modo === "consola" ? token : undefined
  });
});

app.post("/api/correo/validar-token", async (solicitud, respuesta) => {
  const { portal, correo, token } = solicitud.body;
  if (portalPublico && portal !== "recluta") {
    return respuesta.status(403).json({ mensaje: "Este servicio publico solo permite el portal Recluta" });
  }
  const correoNormalizado = normalizarCorreo(correo);
  const registro = await obtenerColeccion("tokensCorreo").findOne({
    portal,
    correo: correoNormalizado,
    token: (token || "").trim()
  });

  if (!registro) {
    return respuesta.status(400).json({ mensaje: "El código no coincide" });
  }
  if (registro.expiraEn < new Date()) {
    return respuesta.status(400).json({ mensaje: "El código expiró. Solicita uno nuevo" });
  }

  await obtenerColeccion("tokensCorreo").updateOne(
    { _id: registro._id },
    { $set: { validado: true, validadoEn: new Date() } }
  );
  await registrarBitacora("token_correo_validado", portal, correoNormalizado, registro.nombreCompleto || "");
  respuesta.json({ mensaje: "Correo validado. Ya puedes crear tu contraseña" });
});

app.post("/api/usuarios/registro", async (solicitud, respuesta) => {
  const datos = solicitud.body;
  const portal = datos.portal;
  if (portalPublico && portal !== "recluta") {
    return respuesta.status(403).json({ mensaje: "Este servicio publico solo permite el portal Recluta" });
  }

  if (!["recluta", "rh", "seguridad"].includes(portal)) {
    return respuesta.status(400).json({ mensaje: "Portal invalido" });
  }

  const coleccion = obtenerColeccion(portal === "recluta" ? "reclutas" : portal);
  const filtroExiste = portal === "recluta"
    ? { correo: normalizarCorreo(datos.correo) }
    : { numeroReloj: datos.numeroReloj };

  const existe = await coleccion.findOne(filtroExiste);
  if (existe) {
    return respuesta.status(409).json({ mensaje: "El usuario ya existe" });
  }

  const requiereToken = portal === "recluta" || portalPublico;
    if (requiereToken) {
    const tokenValidado = await obtenerColeccion("tokensCorreo").findOne({
      portal,
      correo: normalizarCorreo(datos.correo),
      validado: true,
      expiraEn: { $gt: new Date() }
    });

    if (!tokenValidado) {
      return respuesta.status(400).json({ mensaje: "Primero valida el correo electrónico con el código enviado" });
    }
  }

  const usuario = {
    nombreCompleto: datos.nombreCompleto,
    correo: normalizarCorreo(datos.correo),
    telefono: datos.telefono || "",
    numeroReloj: datos.numeroReloj || "",
    contrasena: datos.contrasena,
    rol: portal,
    creadoEn: new Date()
  };

  const resultado = await coleccion.insertOne(usuario);
  await obtenerColeccion("tokensCorreo").deleteMany({ portal, correo: usuario.correo });
  await registrarBitacora("registro_usuario", portal, resultado.insertedId, usuario.nombreCompleto);

  respuesta.status(201).json(limpiarUsuario({ ...usuario, _id: resultado.insertedId }));
});

app.post("/api/usuarios/sesion", async (solicitud, respuesta) => {
  const { portal, correo, numeroReloj, contrasena } = solicitud.body;
  if (portalPublico && portal !== "recluta") {
    return respuesta.status(403).json({ mensaje: "Este servicio publico solo permite el portal Recluta" });
  }
  const coleccion = obtenerColeccion(portal === "recluta" ? "reclutas" : portal);
  const filtro = portal === "recluta"
    ? { correo: normalizarCorreo(correo), contrasena }
    : { numeroReloj, contrasena };

  const usuario = await coleccion.findOne(filtro);
  if (!usuario) {
    return respuesta.status(401).json({ mensaje: "No existe el usuario o la contraseña no coincide" });
  }

  await registrarBitacora("inicio_sesion", portal, usuario._id, usuario.nombreCompleto);
  respuesta.json(limpiarUsuario(usuario));
});

app.get("/api/vacantes", async (_solicitud, respuesta) => {
  const vacantes = await obtenerColeccion("vacantes").find({ activa: true }).sort({ creadaEn: 1 }).toArray();
  respuesta.json(vacantes.map((vacante) => ({
    ...vacante,
    personasNecesarias: Number(vacante.personasNecesarias || 1)
  })));
});

app.post("/api/postulaciones", async (solicitud, respuesta) => {
  const { reclutaId, vacanteId, cv } = solicitud.body;
  const recluta = await obtenerColeccion("reclutas").findOne({ _id: new ObjectId(reclutaId) });
  const vacante = await obtenerColeccion("vacantes").findOne({ _id: new ObjectId(vacanteId) });

  if (!recluta || !vacante) {
    return respuesta.status(404).json({ mensaje: "Recluta o vacante no encontrada" });
  }

  const postulaciones = obtenerColeccion("postulaciones");
  const estadosFinalizados = [
    "Postulación cancelada por Recluta",
    "Acceso cerrado",
    "Acceso negado por RH",
    "Acceso vencido",
    "No asistió a entrevista",
    "No aceptado después de entrevista"
  ];
  const ultimaPostulacion = await postulaciones.findOne(
    { reclutaId: recluta._id, vacanteId: vacante._id },
    { sort: { creadaEn: -1 } }
  );
  const existePostulacionActiva = Boolean(
    ultimaPostulacion && !estadosFinalizados.includes(ultimaPostulacion.estado)
  );

  if (existePostulacionActiva) {
    const existente = ultimaPostulacion;
    if (cv) {
      const camposActualizados = {
        cv,
        estado: "CV enviado a RH",
        notificacionRh: "CV actualizado desde el portal Recluta.",
        notificacionReclutaLeida: false,
        actualizadaEn: new Date()
      };
      await postulaciones.updateOne({ _id: existente._id }, { $set: camposActualizados });
      const actualizado = await postulaciones.findOne({ _id: existente._id });
      await registrarBitacora("cv_actualizado", "recluta", recluta._id, recluta.nombreCompleto);
      await notificarReclutaPorCorreo({
        postulacion: { ...actualizado, correoRecluta: recluta.correo, nombreRecluta: recluta.nombreCompleto },
        estado: "CV enviado a RH",
        mensaje: "Tu CV fue recibido correctamente por RH y quedará en revisión."
      });
      return respuesta.json(actualizado);
    }
    return respuesta.json(existente);
  }

  const postulacion = {
    reclutaId: recluta._id,
    nombreRecluta: recluta.nombreCompleto,
    correoRecluta: recluta.correo,
    telefonoRecluta: recluta.telefono,
    vacanteId: vacante._id,
    tituloVacante: vacante.titulo,
    areaVacante: vacante.area || "",
    turnoVacante: vacante.turno || "",
    horarioVacante: vacante.horario || "",
    ubicacionVacante: vacante.ubicacion || "",
    queEsVacante: vacante.queEs || "",
    descripcionVacante: vacante.descripcion || "",
    cv: cv || null,
    estado: "CV enviado a RH",
    notificacionRh: "Nuevo CV recibido desde el portal Recluta.",
    notificacionReclutaLeida: false,
    fechaEntrevista: obtenerFechaProxima(),
    horaLimite: "17:00",
    entrevistador: "Mariana RH",
    direccion: "Av. Horizonte 214, Parque Industrial Nova",
    creadaEn: new Date(),
    actualizadaEn: new Date()
  };

  const resultado = await postulaciones.insertOne(postulacion);
  await registrarBitacora("postulacion_creada", "recluta", recluta._id, recluta.nombreCompleto);
  await notificarReclutaPorCorreo({
    postulacion: { ...postulacion, _id: resultado.insertedId },
    estado: "CV enviado a RH",
    mensaje: "Tu CV fue entregado a RH. Pronto recibirás una actualización del proceso."
  });
  respuesta.status(201).json({ ...postulacion, _id: resultado.insertedId });
});

app.get("/api/postulaciones/recluta/:reclutaId", async (solicitud, respuesta) => {
  const postulacion = await obtenerColeccion("postulaciones")
    .find({ reclutaId: new ObjectId(solicitud.params.reclutaId) })
    .sort({ creadaEn: -1 })
    .limit(1)
    .next();

  if (!postulacion) return respuesta.json(null);
  respuesta.json(await agregarBiometria(postulacion));
});

app.get("/api/postulaciones/recluta/:reclutaId/historial", async (solicitud, respuesta) => {
  const reclutaId = new ObjectId(solicitud.params.reclutaId);
  const postulaciones = await obtenerColeccion("postulaciones")
    .find({ reclutaId })
    .sort({ creadaEn: -1 })
    .toArray();

  respuesta.json({
    totalAplicaciones: postulaciones.length,
    contratado: postulaciones.some((postulacion) => postulacion.estado === "Perfil egresado generado"),
    postulaciones
  });
});

app.patch("/api/postulaciones/:id/cancelar", async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  const campos = {
    estado: "Postulación cancelada por Recluta",
    razonRechazo: "El recluta canceló su postulación desde el portal.",
    notificacionRh: "El recluta canceló su postulación.",
    actualizadaEn: new Date()
  };

  await obtenerColeccion("postulaciones").updateOne({ _id: id }, { $set: campos });
  await obtenerColeccion("biometria").deleteMany({ postulacionId: id });
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });
  await registrarBitacora("postulacion_cancelada", "recluta", id, postulacion?.nombreRecluta || "");
  await notificarReclutaPorCorreo({
    postulacion,
    estado: "Postulación cancelada por Recluta",
    mensaje: "Cancelaste tu postulación. Si deseas postularte nuevamente, podrás hacerlo desde el portal cuando quieras."
  });
  respuesta.json(await agregarBiometria(postulacion));
});

app.put("/api/postulaciones/:id/biometria", async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });
  if (!postulacion) return respuesta.status(404).json({ mensaje: "Postulación no encontrada" });

  const biometria = {
    postulacionId: id,
    reclutaId: postulacion.reclutaId,
    nombreRecluta: postulacion.nombreRecluta,
    imagenBase64: solicitud.body.imagenBase64,
    aceptoPrivacidad: Boolean(solicitud.body.aceptoPrivacidad),
    capturadaEn: new Date()
  };

  await obtenerColeccion("biometria").updateOne(
    { postulacionId: id },
    { $set: biometria },
    { upsert: true }
  );
  const mensajeAutomatico = "RH revisará tu imagen biométrica. Cuando la valide te avisaremos si puedes continuar con la entrevista.";
  await obtenerColeccion("postulaciones").updateOne(
    { _id: id },
    {
      $set: {
        estado: "Biometria pendiente de revision RH",
        mensajeAutomatico,
        notificacionRh: "El recluta capturó biometría para revisión.",
        notificacionReclutaLeida: false,
        actualizadaEn: new Date()
      }
    }
  );
  await registrarBitacora("biometria_capturada", "recluta", postulacion.reclutaId, postulacion.nombreRecluta);
  await notificarReclutaPorCorreo({
    postulacion: { ...postulacion, estado: "Biometria pendiente de revision RH", mensajeAutomatico },
    estado: "Biometria pendiente de revision RH",
    mensaje: mensajeAutomatico
  });

  respuesta.json(await agregarBiometria({ ...postulacion, estado: "Esperando validacion RH" }));
});

const soloInterno = (solicitud, respuesta, siguiente) => {
  if (portalPublico) {
    return respuesta.status(404).json({ mensaje: "Ruta disponible solo en el sistema interno" });
  }
  siguiente();
};

app.get("/api/rh/postulaciones", soloInterno, async (_solicitud, respuesta) => {
  const postulaciones = await obtenerColeccion("postulaciones").find().sort({ creadaEn: -1 }).toArray();
  respuesta.json(await Promise.all(postulaciones.map(agregarBiometria)));
});

app.get("/api/rh/vacantes", soloInterno, async (_solicitud, respuesta) => {
  const vacantes = await obtenerColeccion("vacantes").find().sort({ creadaEn: -1 }).toArray();
  respuesta.json(vacantes);
});

app.post("/api/rh/vacantes", soloInterno, async (solicitud, respuesta) => {
  const datos = solicitud.body;
  const personasNecesarias = Number(datos.personasNecesarias || 1);
  const vacante = {
    clave: "vac-" + Date.now(),
    titulo: datos.titulo,
    area: datos.area,
    horario: datos.horario,
    turno: datos.turno,
    ubicacion: datos.ubicacion,
    queEs: datos.queEs,
    descripcion: datos.descripcion,
    personasNecesarias: Number.isFinite(personasNecesarias) && personasNecesarias > 0 ? personasNecesarias : 1,
    activa: true,
    ocupada: false,
    creadaEn: new Date(),
    actualizadaEn: new Date()
  };

  const resultado = await obtenerColeccion("vacantes").insertOne(vacante);
  await registrarBitacora("vacante_creada", "rh", resultado.insertedId, vacante.titulo);
  respuesta.status(201).json({ ...vacante, _id: resultado.insertedId });
});

app.patch("/api/rh/vacantes/:id", soloInterno, async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  const personasNecesarias = Number(solicitud.body.personasNecesarias || 1);
  const cantidadValida = Number.isFinite(personasNecesarias) && personasNecesarias > 0 ? personasNecesarias : 1;

  await obtenerColeccion("vacantes").updateOne(
    { _id: id },
    {
      $set: {
        personasNecesarias: cantidadValida,
        activa: true,
        ocupada: false,
        actualizadaEn: new Date()
      }
    }
  );

  const vacante = await obtenerColeccion("vacantes").findOne({ _id: id });
  respuesta.json(vacante);
});

app.delete("/api/rh/vacantes/:id", soloInterno, async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  const vacante = await obtenerColeccion("vacantes").findOne({ _id: id });
  await obtenerColeccion("vacantes").deleteOne({ _id: id });
  await registrarBitacora("vacante_eliminada", "rh", id, vacante?.titulo || "Vacante eliminada");
  respuesta.json({ ok: true, eliminado: true });
});

async function verificarVacantePorCupo(vacanteId) {
  if (!vacanteId) return;
  const vacante = await obtenerColeccion("vacantes").findOne({ _id: new ObjectId(vacanteId) });
  if (!vacante || !Number.isFinite(Number(vacante.personasNecesarias))) return;

  const aceptados = await obtenerColeccion("postulaciones").countDocuments({
    vacanteId: new ObjectId(vacanteId),
    estado: "Perfil egresado generado"
  });

  if (aceptados >= Number(vacante.personasNecesarias)) {
    await obtenerColeccion("vacantes").updateOne(
      { _id: new ObjectId(vacanteId) },
      {
        $set: {
          activa: false,
          ocupada: true,
          cerradaEn: new Date(),
          actualizadaEn: new Date()
        }
      }
    );
  }
}

app.patch("/api/rh/postulaciones/:id", soloInterno, async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  const estado = solicitud.body.estado;
  const fechaInduccion = estado === "Perfil egresado generado" ? obtenerFechaProxima() : "";
  const horaInduccion = estado === "Perfil egresado generado" ? (solicitud.body.horaInduccion || "09:00") : "";
  const lugarInduccion = estado === "Perfil egresado generado" ? (solicitud.body.lugarInduccion || "Por confirmar") : "";
  const mensajeAutomatico = obtenerMensajeAutomatico(estado, solicitud.body.razonRechazo) || "RH actualizó tu proceso. Revisa tu portal para más detalles.";
  const campos = {
    estado,
    razonRechazo: solicitud.body.razonRechazo || "",
    mensajeAutomatico,
    notificacionRhLeida: false,
    notificacionReclutaLeida: false,
    ...(fechaInduccion ? { fechaInduccion } : {}),
    ...(horaInduccion ? { horaInduccion } : {}),
    ...(lugarInduccion ? { lugarInduccion } : {}),
    actualizadaEn: new Date()
  };

  if (["Acceso autorizado por RH", "Asistio a entrevista", "No asistio a entrevista", "No aceptado despues de entrevista", "Acceso negado por RH", "Acceso negado por Seguridad", "Acceso vencido"].includes(estado)) {
    await obtenerColeccion("biometria").deleteMany({ postulacionId: id });
  }

  await obtenerColeccion("postulaciones").updateOne({ _id: id }, { $set: campos });
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });
  await registrarBitacora("respuesta_rh", "rh", id, campos.estado);
  if (postulacion?.correoRecluta) {
    const mensajeCorreo = estado === "Perfil egresado generado"
      ? `Felicidades, ${postulacion.nombreRecluta || "usuario"}. Has sido contratado para inducción en el puesto ${postulacion.tituloVacante || "asignado"}. Tu pase está listo para el día ${postulacion.fechaInduccion || "por confirmar"} a las ${postulacion.horaInduccion || "09:00"}. Lugar: ${postulacion.lugarInduccion || postulacion.direccion || "por confirmar"}. Ingresa a tu perfil de egresado en ContrataT para mostrar tu pase a Seguridad.`
      : mensajeAutomatico;

    await enviarNotificacionPostulacionPorCorreo({
      correo: postulacion.correoRecluta,
      nombre: postulacion.nombreRecluta,
      tituloVacante: postulacion.tituloVacante,
      estado,
      mensaje: mensajeCorreo
    });
  }
  if (estado === "Perfil egresado generado") {
    await verificarVacantePorCupo(postulacion?.vacanteId);
  }
  respuesta.json(await agregarBiometria(postulacion));
});

app.patch("/api/rh/postulaciones/:id/leer", soloInterno, async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  await obtenerColeccion("postulaciones").updateOne(
    { _id: id },
    { $set: { notificacionRhLeida: true, notificacionRh: "", notificacionReclutaLeida: true } }
  );
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });
  respuesta.json(postulacion);
});

app.patch("/api/rh/notificaciones/leer", soloInterno, async (_solicitud, respuesta) => {
  await obtenerColeccion("postulaciones").updateMany(
    {
      notificacionRh: { $exists: true, $ne: "" }
    },
    { $set: { notificacionRhLeida: true, notificacionRh: "" } }
  );
  respuesta.json({ ok: true, mensaje: "Notificaciones de RH marcadas como leidas" });
});

app.get("/api/seguridad/accesos", soloInterno, async (_solicitud, respuesta) => {
  const accesos = await obtenerColeccion("postulaciones")
    .find({ estado: { $in: ["Acceso listo para Seguridad"] } })
    .sort({ actualizadaEn: -1 })
    .toArray();
  respuesta.json(await Promise.all(accesos.map(agregarBiometria)));
});

app.get("/api/seguridad/rechazados", soloInterno, async (_solicitud, respuesta) => {
  const rechazados = await obtenerColeccion("postulaciones")
    .find({ estado: { $in: ["Acceso negado por Seguridad", "Acceso vencido", "No asistió a entrevista", "No aceptado después de entrevista"] } })
    .sort({ actualizadaEn: -1 })
    .toArray();
  respuesta.json(await Promise.all(rechazados.map(agregarBiometria)));
});

app.get("/api/seguridad/historial", soloInterno, async (_solicitud, respuesta) => {
  const historial = await obtenerColeccion("bitacora")
    .find({ seccion: "seguridad", accion: { $in: ["validacion_seguridad", "puerta_abierta", "acceso_cerrado"] } })
    .sort({ fecha: -1 })
    .limit(40)
    .toArray();

  const registros = await Promise.all(historial.map(async (item) => {
    const postulacion = item.referenciaId && ObjectId.isValid(item.referenciaId)
      ? await obtenerColeccion("postulaciones").findOne({ _id: new ObjectId(item.referenciaId) }, { projection: { nombreRecluta: 1, tituloVacante: 1 } })
      : null;

    if (!postulacion?.nombreRecluta) {
      return null;
    }

    return {
      nombre: postulacion.nombreRecluta,
      vacante: postulacion?.tituloVacante || "Acceso temporal",
      estado: item.detalle || "Validación",
      accion: item.accion,
      fecha: item.fecha
    };
  }));

  respuesta.json(registros.filter(Boolean).slice(0, 20));
});

app.patch("/api/seguridad/accesos/:id/validar", soloInterno, async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  const coincide = Boolean(solicitud.body.coincide);
  const campos = {
    estado: coincide ? "Acceso cerrado" : "Acceso negado por Seguridad",
    capturaSeguridad: solicitud.body.capturaSeguridad || "",
    razonRechazo: coincide ? "" : "La captura de seguridad no coincide con la biometría registrada.",
    accesoCerradoEn: coincide ? new Date() : null,
    actualizadaEn: new Date()
  };

  await obtenerColeccion("postulaciones").updateOne({ _id: id }, { $set: campos });
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });

  await registrarBitacora(
    "validacion_seguridad",
    "seguridad",
    id,
    coincide ? "Acceso autorizado" : "Acceso negado por Seguridad"
  );

  if (coincide) {
    await registrarBitacora(
      "puerta_abierta",
      "seguridad",
      id,
      "Puerta abierta por validación de rostro"
    );
  }

  await notificarReclutaPorCorreo({
    postulacion,
    estado: campos.estado,
    mensaje: coincide
      ? "Seguridad verificó tu rostro y tu acceso quedó cerrado correctamente."
      : "Seguridad no pudo validar tu rostro. Revisa tu proceso y sigue las indicaciones de RH."
  });
  respuesta.json(await agregarBiometria(postulacion));
});

app.patch("/api/seguridad/accesos/:id/cerrar", soloInterno, async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  await obtenerColeccion("postulaciones").updateOne(
    { _id: id },
    { $set: { estado: "Acceso cerrado", accesoCerradoEn: new Date(), actualizadaEn: new Date() } }
  );
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });
  await registrarBitacora("acceso_cerrado", "seguridad", id, "Acceso cerrado");
  respuesta.json(postulacion);
});

app.get("/api/notificaciones/recluta/:reclutaId", async (solicitud, respuesta) => {
  const reclutaId = new ObjectId(solicitud.params.reclutaId);
  const noLeidas = await obtenerColeccion("postulaciones").countDocuments({
    reclutaId,
    notificacionReclutaLeida: false,
    $or: [
      { mensajeAutomatico: { $exists: true, $ne: "" } },
      { notificacionRh: { $exists: true, $ne: "" } }
    ]
  });

  respuesta.json({ noLeidas });
});

app.patch("/api/notificaciones/recluta/:reclutaId/leer", async (solicitud, respuesta) => {
  const reclutaId = new ObjectId(solicitud.params.reclutaId);
  await obtenerColeccion("postulaciones").updateMany(
    {
      reclutaId,
      $or: [
        { mensajeAutomatico: { $exists: true, $ne: "" } },
        { notificacionRh: { $exists: true, $ne: "" } }
      ]
    },
    { $set: { notificacionReclutaLeida: true } }
  );
  respuesta.json({ mensaje: "Notificaciones marcadas como leidas" });
});

app.get("*", (_solicitud, respuesta) => {
  respuesta.sendFile(path.join(carpetaPublica, "index.html"));
});

await conectarBaseDatos();

app.listen(puerto, () => {
  console.log(`ContrataT disponible en http://localhost:${puerto}`);
  console.log(`Modo: ${portalPublico ? "portal publico Recluta" : "sistema completo local"}`);
  console.log(`Base de datos: ${process.env.NOMBRE_BASE_DATOS || "ContrataT"}`);
});

async function notificarReclutaPorCorreo({ postulacion, estado, mensaje }) {
  if (!postulacion?.correoRecluta) return { ok: false, modo: "sin-correo" };
  const nombre = postulacion.nombreRecluta || "usuario";
  const tituloVacante = postulacion.tituloVacante || "la vacante solicitada";
  return enviarNotificacionPostulacionPorCorreo({
    correo: postulacion.correoRecluta,
    nombre,
    tituloVacante,
    estado,
    mensaje
  });
}

async function enviarNotificacionPostulacionPorCorreo({ correo, nombre, tituloVacante, estado, mensaje }) {
  const destino = String(correo || "").trim();
  if (!destino || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) {
    console.warn("Se omitió el envío de correo por dirección inválida:", { correo, estado, tituloVacante });
    return { ok: false, modo: "correo-invalido" };
  }

  const asunto = `Actualización de tu proceso ContrataT`;
  const texto = `Hola ${nombre || "usuario"},\n\nTu proceso para la vacante ${tituloVacante || "solicitada"} tuvo un cambio de estado: ${estado}.\n\n${mensaje}\n\nInicia sesión en ContrataT para ver la notificación.`;
  const html = `
    <div style="font-family: Arial, sans-serif; color: #17212b; line-height: 1.6;">
      <h2 style="margin-bottom: 12px; color: #0f766e;">Actualización de tu proceso ContrataT</h2>
      <p>Hola ${nombre || "usuario"},</p>
      <p>Tu proceso para la vacante <strong>${tituloVacante || "solicitada"}</strong> tuvo un cambio de estado:</p>
      <p><strong>${estado}</strong></p>
      <p>${mensaje}</p>
      <p>Inicia sesión en ContrataT para ver más detalles.</p>
    </div>
  `;

  const webhookGmail = process.env.CORREO_WEBHOOK_URL;
  if (webhookGmail) {
    try {
      const respuesta = await fetch(webhookGmail, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secreto: process.env.CORREO_WEBHOOK_SECRETO, destino, asunto, texto, html })
      });
      const datos = await respuesta.json().catch(() => null);
      if (!respuesta.ok || datos?.ok === false) {
        throw new Error(datos?.mensaje || "Webhook de Gmail falló");
      }
      return { ok: true, modo: "gmail-webhook" };
    } catch (error) {
      console.warn("No se pudo enviar la notificación por webhook de Gmail:", error.message);
    }
  }

  const host = process.env.CORREO_HOST;
  const usuario = process.env.CORREO_USUARIO;
  const contrasena = process.env.CORREO_CONTRASENA;
  if (!host || !usuario || !contrasena) {
    console.log("Notificación por correo ContrataT:", { destino, nombre, tituloVacante, estado, mensaje });
    return { ok: true, modo: "consola" };
  }

  try {
    const transporte = nodemailer.createTransport({
      host,
      port: Number(process.env.CORREO_PUERTO || 587),
      secure: String(process.env.CORREO_SEGURO).toLowerCase() === "true",
      family: 4,
      auth: { user: usuario, pass: contrasena }
    });
    await transporte.sendMail({
      from: process.env.CORREO_REMITENTE || usuario,
      to: destino,
      subject: asunto,
      text: texto,
      html
    });
    return { ok: true, modo: "correo" };
  } catch (error) {
    console.warn("No se pudo enviar la notificación por SMTP:", error.message);
    return { ok: false, modo: "error" };
  }
}

function normalizarCorreo(correo = "") {
  return correo.trim().toLowerCase();
}

function generarTokenCorreo() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function enviarTokenPorCorreo(destino, token, portal, nombreCompleto = "") {
  const webhookGmail = process.env.CORREO_WEBHOOK_URL;
  const secretoWebhook = process.env.CORREO_WEBHOOK_SECRETO;
  const host = process.env.CORREO_HOST;
  const usuario = process.env.CORREO_USUARIO;
  const contrasena = process.env.CORREO_CONTRASENA;
  const entornoLocal = !process.env.NODE_ENV || process.env.NODE_ENV === "development" || process.env.CORREO_MODO === "consola";

  const asunto = `Código de verificación ContrataT - ${portal.toUpperCase()}`;
  const texto = `Hola ${nombreCompleto || "usuario"}, tu código de verificación ContrataT es ${token}. Expira en 10 minutos.`;
  const html = `<p>Hola ${nombreCompleto || "usuario"},</p><p>Tu código de verificación ContrataT es:</p><h2>${token}</h2><p>Expira en 10 minutos.</p>`;

  if (webhookGmail) {
    try {
      const respuesta = await fetch(webhookGmail, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secreto: secretoWebhook,
          destino,
          asunto,
          texto,
          html
        })
      });
      const datos = await respuesta.json().catch(() => null);
      if (!respuesta.ok || datos?.ok === false) {
        throw new Error(datos?.mensaje || "El webhook de Gmail no pudo enviar el correo");
      }
      return {
        modo: "gmail-webhook",
        mensaje: "Código enviado al correo electrónico."
      };
    } catch (error) {
      if (entornoLocal) {
        console.log("Código de correo ContrataT (fallback local):", { destino, portal, codigo: token, error: error.message });
        return {
          modo: "consola",
          mensaje: "El correo de Gmail no respondió desde este entorno. Se usa modo local y el código aparece en consola."
        };
      }
      throw error;
    }
  }

  if (!host || !usuario || !contrasena) {
    console.log("Codigo de correo ContrataT:", { destino, portal, codigo: token });
    return {
      modo: "consola",
      mensaje: "No hay correo configurado. Código mostrado en consola del servidor para prueba."
    };
  }

  try {
    const transporte = nodemailer.createTransport({
      host,
      port: Number(process.env.CORREO_PUERTO || 587),
      secure: String(process.env.CORREO_SEGURO).toLowerCase() === "true",
      family: 4,
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 60000,
      auth: { user: usuario, pass: contrasena }
    });

    await transporte.sendMail({
      from: process.env.CORREO_REMITENTE || usuario,
      to: destino,
      subject: asunto,
      text: texto,
      html
    });

    return {
      modo: "correo",
      mensaje: "Código enviado al correo electrónico."
    };
  } catch (error) {
    if (entornoLocal) {
      console.log("Código de correo ContrataT (fallback local):", { destino, portal, codigo: token, error: error.message });
      return {
        modo: "consola",
        mensaje: "SMTP no está disponible desde este entorno. El código se mostró en consola para pruebas locales."
      };
    }
    throw error;
  }
}

function limpiarUsuario(usuario) {
  const { contrasena, ...seguro } = usuario;
  return seguro;
}

async function agregarBiometria(postulacion) {
  const biometria = await obtenerColeccion("biometria").findOne({ postulacionId: postulacion._id });
  return {
    ...postulacion,
    biometria: biometria || null
  };
}

async function registrarBitacora(accion, seccion, referenciaId, detalle) {
  await obtenerColeccion("bitacora").insertOne({
    accion,
    seccion,
    referenciaId,
    detalle,
    fecha: new Date()
  });
}

function obtenerMensajeAutomatico(estado, razonRechazo = "") {
  const mensajes = {
    "Acceso autorizado por RH": "RH validó tu CV. Ya puedes registrar tus datos biométricos para continuar con la entrevista.",
    "Biometria pendiente de revision RH": "Tu biometría ya está en revisión por RH. Cuando la validen, te avisaremos el siguiente paso.",
    "Acceso negado por RH": razonRechazo || "RH no autorizó tu CV para entrevista. Tu postulación quedó cancelada.",
    "Acceso negado por Seguridad": razonRechazo || "Seguridad no autorizó este acceso. Puedes volver a enviar tu CV y repetir el proceso para obtener un nuevo acceso de planta.",
    "Postulación cancelada por RH": razonRechazo || "RH canceló tu postulación. Ya no puedes continuar con este proceso.",
    "Postulacion cancelada por RH": razonRechazo || "RH canceló tu postulación. Ya no puedes continuar con este proceso.",
    "Biometria rechazada por RH": razonRechazo || "RH no validó tu imagen biométrica. Debes capturarla nuevamente.",
    "Acceso listo para Seguridad": "RH validó tu biometría. Tu entrevista ya fue agendada y Seguridad podrá verificar tu acceso.",
    "Asistio a entrevista": "RH registró que asististe a entrevista. Espera el resultado final.",
    "No asistio a entrevista": razonRechazo || "RH registró que no asististe a la entrevista.",
    "No aceptado despues de entrevista": razonRechazo || "RH registró que no fuiste aceptado después de la entrevista.",
    "Perfil egresado generado": "Felicidades. RH generó tu perfil de nuevo ingreso y tu acceso planta."
  };

  return mensajes[estado] || "";
}

function obtenerFechaProxima() {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + 3);
  return fecha.toLocaleDateString("es-MX", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}
