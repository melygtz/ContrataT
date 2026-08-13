import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const uri = process.env.MONGODB_URI;
const nombreBaseDatos = process.env.NOMBRE_BASE_DATOS || "ContrataT";

if (!uri) {
  throw new Error("Falta MONGODB_URI en el archivo .env");
}

const cliente = new MongoClient(uri);
let baseDatos;

export const colecciones = {
  reclutas: "seccion_reclutas",
  rh: "seccion_rh",
  seguridad: "seccion_seguridad",
  vacantes: "seccion_vacantes",
  postulaciones: "seccion_postulaciones",
  biometria: "seccion_biometria",
  tokensCorreo: "seccion_tokens_correo",
  bitacora: "seccion_bitacora"
};

export async function conectarBaseDatos() {
  if (!baseDatos) {
    await cliente.connect();
    baseDatos = cliente.db(nombreBaseDatos);
    await prepararBaseDatos();
  }
  return baseDatos;
}

export function obtenerColeccion(nombre) {
  if (!baseDatos) {
    throw new Error("La base de datos aun no esta conectada");
  }
  return baseDatos.collection(colecciones[nombre]);
}

async function prepararBaseDatos() {
  await Promise.all([
    baseDatos.collection(colecciones.reclutas).createIndex({ correo: 1 }, { unique: true }),
    baseDatos.collection(colecciones.rh).createIndex({ numeroReloj: 1 }, { unique: true }),
    baseDatos.collection(colecciones.seguridad).createIndex({ numeroReloj: 1 }, { unique: true }),
    baseDatos.collection(colecciones.postulaciones).createIndex({ reclutaId: 1 }),
    baseDatos.collection(colecciones.biometria).createIndex({ postulacionId: 1 }),
    baseDatos.collection(colecciones.tokensCorreo).createIndex({ correo: 1, portal: 1 }),
    baseDatos.collection(colecciones.tokensCorreo).createIndex({ expiraEn: 1 }, { expireAfterSeconds: 0 }),
    baseDatos.collection(colecciones.bitacora).createIndex({ fecha: -1 })
  ]);

  await sembrarDatosIniciales();
}

async function sembrarDatosIniciales() {
  const vacantes = baseDatos.collection(colecciones.vacantes);
  const rh = baseDatos.collection(colecciones.rh);
  const seguridad = baseDatos.collection(colecciones.seguridad);

  if (await vacantes.countDocuments() === 0) {
    await vacantes.insertMany([
      {
        clave: "op-prod",
        titulo: "Operador de produccion",
        area: "Manufactura",
        horario: "Lunes a viernes",
        ubicacion: "Planta Norte",
        descripcion: "Operacion de linea, inspeccion de calidad y reporte de incidencias con supervisor.",
        activa: true,
        creadaEn: new Date()
      },
      {
        clave: "tec-mant",
        titulo: "Tecnico de mantenimiento",
        area: "Mantenimiento",
        horario: "Turno mixto",
        ubicacion: "Planta Central",
        descripcion: "Mantenimiento preventivo, atencion de fallas y llenado de bitacoras.",
        activa: true,
        creadaEn: new Date()
      },
      {
        clave: "aux-alm",
        titulo: "Auxiliar de almacen",
        area: "Logistica",
        horario: "Matutino",
        ubicacion: "CEDIS",
        descripcion: "Recepcion, acomodo, surtido de materiales y control basico de inventario.",
        activa: true,
        creadaEn: new Date()
      }
    ]);
  }

  if (await rh.countDocuments({ numeroReloj: "RH100" }) === 0) {
    await rh.insertOne({
      nombreCompleto: "Mariana RH",
      numeroReloj: "RH100",
      correo: "rh@ContrataT.mx",
      contrasena: "123456",
      rol: "rh",
      creadoEn: new Date()
    });
  }

  if (await seguridad.countDocuments({ numeroReloj: "SEG100" }) === 0) {
    await seguridad.insertOne({
      nombreCompleto: "Luis Seguridad",
      numeroReloj: "SEG100",
      correo: "seguridad@ContrataT.mx",
      contrasena: "123456",
      rol: "seguridad",
      creadoEn: new Date()
    });
  }
}
