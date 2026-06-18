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
app.use(express.static(carpetaPublica));

app.get("/api/salud", async (_solicitud, respuesta) => {
  respuesta.json({
    estado: "conectado",
    empresa: process.env.NOMBRE_BASE_DATOS || "ContrataT",
    portalPublico: portalPublico ? "recluta" : "completo",
    colecciones
  });
});

app.post("/api/correo/solicitar-token", async (solicitud, respuesta) => {
  const { portal, correo, numeroReloj, nombreCompleto } = solicitud.body;
  if (portalPublico && portal !== "recluta") {
    return respuesta.status(403).json({ mensaje: "Este servicio publico solo permite el portal Recluta" });
  }
  if (!["recluta", "rh", "seguridad"].includes(portal)) {
    return respuesta.status(400).json({ mensaje: "Portal invalido" });
  }
  if (!correo) {
    return respuesta.status(400).json({ mensaje: "Escribe un correo electronico" });
  }
  if ((portal === "rh" || portal === "seguridad") && !numeroReloj) {
    return respuesta.status(400).json({ mensaje: "Escribe el numero de reloj del empleado" });
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
      mensaje: "No se pudo enviar el correo. Revisa la configuracion SMTP de Gmail en Render."
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
    return respuesta.status(400).json({ mensaje: "El token no coincide" });
  }
  if (registro.expiraEn < new Date()) {
    return respuesta.status(400).json({ mensaje: "El token expiro. Solicita uno nuevo" });
  }

  await obtenerColeccion("tokensCorreo").updateOne(
    { _id: registro._id },
    { $set: { validado: true, validadoEn: new Date() } }
  );
  await registrarBitacora("token_correo_validado", portal, correoNormalizado, registro.nombreCompleto || "");
  respuesta.json({ mensaje: "Correo validado. Ya puedes crear tu contrasena" });
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

  const tokenValidado = await obtenerColeccion("tokensCorreo").findOne({
    portal,
    correo: normalizarCorreo(datos.correo),
    validado: true,
    expiraEn: { $gt: new Date() }
  });

  if (!tokenValidado) {
    return respuesta.status(400).json({ mensaje: "Primero valida el correo electronico con el token enviado" });
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
    return respuesta.status(401).json({ mensaje: "No existe el usuario o la contrasena no coincide" });
  }

  await registrarBitacora("inicio_sesion", portal, usuario._id, usuario.nombreCompleto);
  respuesta.json(limpiarUsuario(usuario));
});

app.get("/api/vacantes", async (_solicitud, respuesta) => {
  const vacantes = await obtenerColeccion("vacantes").find({ activa: true }).sort({ creadaEn: 1 }).toArray();
  respuesta.json(vacantes);
});

app.post("/api/postulaciones", async (solicitud, respuesta) => {
  const { reclutaId, vacanteId } = solicitud.body;
  const recluta = await obtenerColeccion("reclutas").findOne({ _id: new ObjectId(reclutaId) });
  const vacante = await obtenerColeccion("vacantes").findOne({ _id: new ObjectId(vacanteId) });

  if (!recluta || !vacante) {
    return respuesta.status(404).json({ mensaje: "Recluta o vacante no encontrada" });
  }

  const postulaciones = obtenerColeccion("postulaciones");
  const existente = await postulaciones.findOne({ reclutaId: recluta._id, estado: { $ne: "Acceso cerrado" } });
  if (existente) {
    return respuesta.json(existente);
  }

  const postulacion = {
    reclutaId: recluta._id,
    nombreRecluta: recluta.nombreCompleto,
    correoRecluta: recluta.correo,
    telefonoRecluta: recluta.telefono,
    vacanteId: vacante._id,
    tituloVacante: vacante.titulo,
    estado: "CV recibido",
    fechaEntrevista: obtenerFechaProxima(),
    horaLimite: "17:00",
    entrevistador: "Mariana RH",
    direccion: "Av. Horizonte 214, Parque Industrial Nova",
    creadaEn: new Date(),
    actualizadaEn: new Date()
  };

  const resultado = await postulaciones.insertOne(postulacion);
  await registrarBitacora("postulacion_creada", "recluta", recluta._id, recluta.nombreCompleto);
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

app.put("/api/postulaciones/:id/biometria", async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });
  if (!postulacion) return respuesta.status(404).json({ mensaje: "Postulacion no encontrada" });

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
  await obtenerColeccion("postulaciones").updateOne(
    { _id: id },
    { $set: { estado: "Esperando validacion RH", actualizadaEn: new Date() } }
  );
  await registrarBitacora("biometria_capturada", "recluta", postulacion.reclutaId, postulacion.nombreRecluta);

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

app.patch("/api/rh/postulaciones/:id", soloInterno, async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  const campos = {
    estado: solicitud.body.estado,
    razonRechazo: solicitud.body.razonRechazo || "",
    fechaInduccion: solicitud.body.estado === "Aceptado" ? obtenerFechaProxima() : "",
    actualizadaEn: new Date()
  };

  await obtenerColeccion("postulaciones").updateOne({ _id: id }, { $set: campos });
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });
  await registrarBitacora("respuesta_rh", "rh", id, campos.estado);
  respuesta.json(await agregarBiometria(postulacion));
});

app.get("/api/seguridad/accesos", soloInterno, async (_solicitud, respuesta) => {
  const accesos = await obtenerColeccion("postulaciones").find({ estado: "Aceptado" }).sort({ actualizadaEn: -1 }).toArray();
  respuesta.json(await Promise.all(accesos.map(agregarBiometria)));
});

app.get("/api/seguridad/rechazados", soloInterno, async (_solicitud, respuesta) => {
  const rechazados = await obtenerColeccion("postulaciones").find({ estado: "Rechazado" }).sort({ actualizadaEn: -1 }).toArray();
  respuesta.json(await Promise.all(rechazados.map(agregarBiometria)));
});

app.patch("/api/seguridad/accesos/:id/cerrar", soloInterno, async (solicitud, respuesta) => {
  const id = new ObjectId(solicitud.params.id);
  await obtenerColeccion("postulaciones").updateOne(
    { _id: id },
    { $set: { estado: "Acceso cerrado", accesoCerradoEn: new Date(), actualizadaEn: new Date() } }
  );
  const postulacion = await obtenerColeccion("postulaciones").findOne({ _id: id });
  await registrarBitacora("acceso_cerrado", "seguridad", id, postulacion?.nombreRecluta || "");
  respuesta.json(postulacion);
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

  const asunto = `Token de verificacion ContrataT - ${portal.toUpperCase()}`;
  const texto = `Hola ${nombreCompleto || "usuario"}, tu token de verificacion es ${token}. Expira en 10 minutos.`;
  const html = `<p>Hola ${nombreCompleto || "usuario"},</p><p>Tu token de verificacion es:</p><h2>${token}</h2><p>Expira en 10 minutos.</p>`;

  if (webhookGmail) {
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
      mensaje: "Token enviado al correo electronico."
    };
  }

  if (!host || !usuario || !contrasena) {
    console.log("Token de correo ContrataT:", { destino, portal, token });
    return {
      modo: "consola",
      mensaje: "No hay correo SMTP configurado. Token mostrado en consola del servidor para prueba."
    };
  }

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
    mensaje: "Token enviado al correo electronico."
  };
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

function obtenerFechaProxima() {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + 3);
  return fecha.toLocaleDateString("es-MX", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}
