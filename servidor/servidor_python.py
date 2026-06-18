from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from email.message import EmailMessage
from bson import ObjectId
from pymongo import MongoClient
import base64
import json
import os
import random
import smtplib
import ssl
from datetime import datetime, timedelta


RAIZ = Path(__file__).resolve().parents[1]
PUBLICO = RAIZ / "publico"
ENV = RAIZ / ".env"


def leer_env():
    datos = {}
    if ENV.exists():
        for linea in ENV.read_text(encoding="utf-8-sig").splitlines():
            if "=" in linea and not linea.strip().startswith("#"):
                clave, valor = linea.split("=", 1)
                datos[clave.strip()] = valor.strip()
    return datos


CONFIG = leer_env()
PUERTO = int(CONFIG.get("PUERTO", "3000"))
NOMBRE_BASE = CONFIG.get("NOMBRE_BASE_DATOS", "ContrataT")
CLIENTE = MongoClient(CONFIG["MONGODB_URI"], serverSelectionTimeoutMS=15000)
BASE = CLIENTE[NOMBRE_BASE]

COLECCIONES = {
    "reclutas": "seccion_reclutas",
    "rh": "seccion_rh",
    "seguridad": "seccion_seguridad",
    "vacantes": "seccion_vacantes",
    "postulaciones": "seccion_postulaciones",
    "biometria": "seccion_biometria",
    "tokensCorreo": "seccion_tokens_correo",
    "bitacora": "seccion_bitacora",
    "notificaciones": "seccion_notificaciones",
}


def col(nombre):
    return BASE[COLECCIONES[nombre]]


def ahora():
    return datetime.utcnow()


def normalizar_correo(correo):
    return (correo or "").strip().lower()


def limpiar_usuario(usuario):
    usuario = dict(usuario)
    usuario.pop("contrasena", None)
    return usuario


def convertir_json(valor):
    if isinstance(valor, ObjectId):
        return str(valor)
    if isinstance(valor, datetime):
        return valor.isoformat()
    raise TypeError(f"No se puede convertir {type(valor)}")


def preparar_base():
    col("reclutas").create_index("correo", unique=True)
    col("rh").create_index("numeroReloj", unique=True)
    col("seguridad").create_index("numeroReloj", unique=True)
    col("postulaciones").create_index("reclutaId")
    col("biometria").create_index("postulacionId")
    col("tokensCorreo").create_index([("correo", 1), ("portal", 1)])
    col("tokensCorreo").create_index("expiraEn", expireAfterSeconds=0)
    col("notificaciones").create_index("reclutaId")
    col("notificaciones").create_index([("postulacionId", 1), ("estado", 1), ("mensaje", 1)], unique=True)

    if col("vacantes").count_documents({}) == 0:
        col("vacantes").insert_many([
            {
                "clave": "op-prod",
                "titulo": "Operador de produccion",
                "area": "Manufactura",
                "horario": "Lunes a viernes",
                "turno": "Matutino",
                "ubicacion": "Planta Norte",
                "descripcion": "Operacion de linea, inspeccion de calidad y reporte de incidencias con supervisor.",
                "activa": True,
                "creadaEn": ahora(),
            },
            {
                "clave": "tec-mant",
                "titulo": "Tecnico de mantenimiento",
                "area": "Mantenimiento",
                "horario": "Lunes a sabado",
                "turno": "Mixto",
                "ubicacion": "Planta Central",
                "descripcion": "Mantenimiento preventivo, atencion de fallas y llenado de bitacoras.",
                "activa": True,
                "creadaEn": ahora(),
            },
            {
                "clave": "aux-alm",
                "titulo": "Auxiliar de almacen",
                "area": "Logistica",
                "horario": "Lunes a viernes",
                "turno": "Matutino",
                "ubicacion": "CEDIS",
                "descripcion": "Recepcion, acomodo, surtido de materiales y control basico de inventario.",
                "activa": True,
                "creadaEn": ahora(),
            },
        ])

    if col("rh").count_documents({"numeroReloj": "RH100"}) == 0:
        col("rh").insert_one({
            "nombreCompleto": "Mariana RH",
            "numeroReloj": "RH100",
            "correo": "rh@ContrataT.mx",
            "contrasena": "123456",
            "rol": "rh",
            "creadoEn": ahora(),
        })

    if col("seguridad").count_documents({"numeroReloj": "SEG100"}) == 0:
        col("seguridad").insert_one({
            "nombreCompleto": "Luis Seguridad",
            "numeroReloj": "SEG100",
            "correo": "seguridad@ContrataT.mx",
            "contrasena": "123456",
            "rol": "seguridad",
            "creadoEn": ahora(),
        })


def registrar_bitacora(accion, seccion, referencia_id="", detalle=""):
    col("bitacora").insert_one({
        "accion": accion,
        "seccion": seccion,
        "referenciaId": referencia_id,
        "detalle": detalle,
        "fecha": ahora(),
    })


def fecha_proxima():
    return (datetime.now() + timedelta(days=3)).strftime("%d/%m/%Y")


def fecha_limite_vencida(postulacion):
    try:
        dia, mes, anio = [int(parte) for parte in postulacion.get("fechaEntrevista", "").split("/")]
        hora, minuto = [int(parte) for parte in postulacion.get("horaLimite", "17:00").split(":")]
        limite = datetime(anio, mes, dia, hora, minuto)
        return datetime.now() > limite
    except Exception:
        return False


def vencer_accesos_expirados():
    estados_vencibles = ["Acceso listo para Seguridad"]
    for postulacion in col("postulaciones").find({"estado": {"$in": estados_vencibles}}):
        if fecha_limite_vencida(postulacion):
            col("postulaciones").update_one(
                {"_id": postulacion["_id"]},
                {"$set": {
                    "estado": "Acceso vencido",
                    "razonRechazo": "La hora limite de llegada ya paso",
                    "accesoVencidoEn": ahora(),
                    "actualizadaEn": ahora(),
                }},
            )


def agregar_biometria(postulacion):
    bio = col("biometria").find_one({"postulacionId": postulacion["_id"]})
    postulacion["biometria"] = bio
    return postulacion


def cancelar_postulacion(post_id):
    postulacion = col("postulaciones").find_one({"_id": post_id})
    if not postulacion:
        return None
    col("biometria").delete_many({"postulacionId": post_id})
    campos = {
        "estado": "Postulacion cancelada por Recluta",
        "razonRechazo": "El recluta cancelo la entrevista y la postulacion",
        "notificacionRh": "El recluta cancelo la entrevista. Se quitaron datos biometricos, fecha y hora acordadas.",
        "fechaEntrevista": "",
        "horaLimite": "",
        "entrevistador": "",
        "direccion": "",
        "biometriaCancelada": True,
        "canceladaEn": ahora(),
        "actualizadaEn": ahora(),
    }
    col("postulaciones").update_one({"_id": post_id}, {"$set": campos})
    registrar_bitacora("postulacion_cancelada", "recluta", post_id, postulacion.get("nombreRecluta", ""))
    return col("postulaciones").find_one({"_id": post_id})


def enviar_token(destino, token, portal, nombre):
    host = CONFIG.get("CORREO_HOST")
    usuario = CONFIG.get("CORREO_USUARIO")
    contrasena = CONFIG.get("CORREO_CONTRASENA")
    remitente = CONFIG.get("CORREO_REMITENTE") or usuario

    if not host or not usuario or not contrasena:
        print("Token de correo ContrataT:", {"destino": destino, "portal": portal, "token": token})
        return {
            "modo": "consola",
            "mensaje": "No hay correo SMTP configurado. Token mostrado en consola.",
            "tokenPrueba": token,
        }

    mensaje = EmailMessage()
    mensaje["Subject"] = f"Token de verificacion ContrataT - {portal.upper()}"
    mensaje["From"] = remitente
    mensaje["To"] = destino
    mensaje.set_content(f"Hola {nombre or 'usuario'}, tu token de verificacion es {token}. Expira en 10 minutos.")

    puerto = int(CONFIG.get("CORREO_PUERTO", "587"))
    seguro = CONFIG.get("CORREO_SEGURO", "false").lower() == "true"
    contexto_ssl = ssl._create_unverified_context()

    if seguro:
        with smtplib.SMTP_SSL(host, puerto, context=contexto_ssl) as smtp:
            smtp.login(usuario, contrasena)
            smtp.send_message(mensaje)
    else:
        with smtplib.SMTP(host, puerto) as smtp:
            smtp.starttls(context=contexto_ssl)
            smtp.login(usuario, contrasena)
            smtp.send_message(mensaje)

    return {"modo": "correo", "mensaje": "Token enviado al correo electronico."}


def enviar_correo_simple(destino, asunto, contenido):
    host = CONFIG.get("CORREO_HOST")
    usuario = CONFIG.get("CORREO_USUARIO")
    contrasena = CONFIG.get("CORREO_CONTRASENA")
    remitente = CONFIG.get("CORREO_REMITENTE") or usuario

    if not host or not usuario or not contrasena or not destino:
        print("Correo ContrataT:", {"destino": destino, "asunto": asunto, "contenido": contenido})
        return {"modo": "consola"}

    mensaje = EmailMessage()
    mensaje["Subject"] = asunto
    mensaje["From"] = remitente
    mensaje["To"] = destino
    mensaje.set_content(contenido)

    puerto = int(CONFIG.get("CORREO_PUERTO", "587"))
    seguro = CONFIG.get("CORREO_SEGURO", "false").lower() == "true"
    contexto_ssl = ssl._create_unverified_context()

    if seguro:
        with smtplib.SMTP_SSL(host, puerto, context=contexto_ssl) as smtp:
            smtp.login(usuario, contrasena)
            smtp.send_message(mensaje)
    else:
        with smtplib.SMTP(host, puerto) as smtp:
            smtp.starttls(context=contexto_ssl)
            smtp.login(usuario, contrasena)
            smtp.send_message(mensaje)

    return {"modo": "correo"}


def crear_notificacion_postulacion(postulacion, mensaje_texto):
    if not postulacion or not mensaje_texto:
        return
    notificacion = {
        "reclutaId": postulacion.get("reclutaId"),
        "postulacionId": postulacion.get("_id"),
        "estado": postulacion.get("estado", ""),
        "titulo": "Mensaje nuevo de postulacion",
        "mensaje": mensaje_texto,
        "leida": False,
        "creadaEn": ahora(),
    }
    try:
        col("notificaciones").insert_one(notificacion)
    except Exception:
        return

    asunto = f"Tienes un mensaje nuevo de tu postulacion con {NOMBRE_BASE}"
    contenido = (
        f"Hola {postulacion.get('nombreRecluta', 'recluta')},\n\n"
        f"Tienes un mensaje nuevo de tu postulacion con {NOMBRE_BASE}.\n\n"
        f"Vacante: {postulacion.get('tituloVacante', 'Sin vacante')}\n"
        f"Mensaje: {mensaje_texto}\n\n"
        "Entra al portal de Recluta y revisa Notificaciones."
    )
    try:
        enviar_correo_simple(postulacion.get("correoRecluta", ""), asunto, contenido)
    except Exception as error:
        registrar_bitacora("correo_notificacion_error", "recluta", postulacion.get("_id", ""), str(error))


class Manejador(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLICO), **kwargs)

    def enviar_json(self, datos, estado=200):
        cuerpo = json.dumps(datos, default=convertir_json).encode("utf-8")
        self.send_response(estado)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,OPTIONS")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def leer_json(self):
        largo = int(self.headers.get("Content-Length", "0"))
        if largo == 0:
            return {}
        return json.loads(self.rfile.read(largo).decode("utf-8"))

    def do_OPTIONS(self):
        self.enviar_json({"ok": True})

    def do_GET(self):
        ruta = urlparse(self.path).path
        try:
            if ruta == "/api/salud":
                return self.enviar_json({"estado": "conectado", "empresa": NOMBRE_BASE, "colecciones": COLECCIONES})
            if ruta == "/api/vacantes":
                return self.enviar_json(list(col("vacantes").find({"activa": True, "ocupada": {"$ne": True}}).sort("creadaEn", 1)))
            if ruta == "/api/rh/vacantes":
                return self.enviar_json(list(col("vacantes").find({"activa": True}).sort("creadaEn", 1)))
            if ruta.startswith("/api/postulaciones/recluta/") and ruta.endswith("/historial"):
                recluta_id = ObjectId(ruta.split("/")[4])
                recluta = col("reclutas").find_one({"_id": recluta_id})
                posts = [agregar_biometria(p) for p in col("postulaciones").find({"reclutaId": recluta_id, "estado": {"$ne": "CV enviado a RH"}}).sort("creadaEn", -1)]
                contratado = bool(recluta and recluta.get("contratado")) or any(p.get("estado") == "Perfil egresado generado" for p in posts)
                return self.enviar_json({"totalAplicaciones": len(posts), "contratado": contratado, "tipoUsuario": "empleado" if contratado else "recluta", "postulaciones": posts})
            if ruta.startswith("/api/postulaciones/recluta/"):
                recluta_id = ObjectId(ruta.rsplit("/", 1)[1])
                post = col("postulaciones").find({"reclutaId": recluta_id}).sort("creadaEn", -1).limit(1)
                post = next(post, None)
                return self.enviar_json(agregar_biometria(post) if post else None)
            if ruta.startswith("/api/notificaciones/recluta/"):
                recluta_id = ObjectId(ruta.rsplit("/", 1)[1])
                notificaciones = list(col("notificaciones").find({"reclutaId": recluta_id}).sort("creadaEn", -1))
                no_leidas = col("notificaciones").count_documents({"reclutaId": recluta_id, "leida": False})
                return self.enviar_json({"noLeidas": no_leidas, "notificaciones": notificaciones})
            if ruta == "/api/rh/postulaciones":
                vencer_accesos_expirados()
                posts = [agregar_biometria(p) for p in col("postulaciones").find().sort("creadaEn", -1)]
                return self.enviar_json(posts)
            if ruta == "/api/seguridad/accesos":
                vencer_accesos_expirados()
                posts = [agregar_biometria(p) for p in col("postulaciones").find({"estado": {"$in": ["Acceso listo para Seguridad", "Acceso verificado por Seguridad"]}}).sort("actualizadaEn", -1)]
                return self.enviar_json(posts)
            if ruta == "/api/seguridad/rechazados":
                vencer_accesos_expirados()
                posts = [agregar_biometria(p) for p in col("postulaciones").find({"estado": {"$in": ["Acceso negado por RH", "Biometria rechazada por RH", "Acceso negado por Seguridad", "Acceso vencido", "Postulacion cancelada por Recluta", "No asistio a entrevista", "No aceptado despues de entrevista"]}}).sort("actualizadaEn", -1)]
                return self.enviar_json(posts)
            if ruta == "/":
                self.path = "/index.html"
            return super().do_GET()
        except Exception as error:
            return self.enviar_json({"mensaje": str(error)}, 500)

    def do_POST(self):
        ruta = urlparse(self.path).path
        datos = self.leer_json()
        try:
            if ruta == "/api/correo/solicitar-token":
                portal = datos.get("portal")
                correo = normalizar_correo(datos.get("correo"))
                if portal not in ["recluta", "rh", "seguridad"]:
                    return self.enviar_json({"mensaje": "Portal invalido"}, 400)
                if not correo:
                    return self.enviar_json({"mensaje": "Escribe un correo electronico"}, 400)
                if portal in ["rh", "seguridad"] and not datos.get("numeroReloj"):
                    return self.enviar_json({"mensaje": "Escribe el numero de reloj del empleado"}, 400)
                token = str(random.randint(100000, 999999))
                expira = ahora() + timedelta(minutes=10)
                col("tokensCorreo").update_one(
                    {"portal": portal, "correo": correo},
                    {"$set": {
                        "portal": portal,
                        "correo": correo,
                        "numeroReloj": datos.get("numeroReloj", ""),
                        "nombreCompleto": datos.get("nombreCompleto", ""),
                        "token": token,
                        "validado": False,
                        "creadoEn": ahora(),
                        "expiraEn": expira,
                    }},
                    upsert=True,
                )
                envio = enviar_token(correo, token, portal, datos.get("nombreCompleto", ""))
                registrar_bitacora("token_correo_enviado", portal, correo, envio["modo"])
                return self.enviar_json(envio)

            if ruta == "/api/correo/validar-token":
                portal = datos.get("portal")
                correo = normalizar_correo(datos.get("correo"))
                token = (datos.get("token") or "").strip()
                registro = col("tokensCorreo").find_one({"portal": portal, "correo": correo, "token": token})
                if not registro:
                    return self.enviar_json({"mensaje": "El token no coincide"}, 400)
                if registro["expiraEn"] < ahora():
                    return self.enviar_json({"mensaje": "El token expiro. Solicita uno nuevo"}, 400)
                col("tokensCorreo").update_one({"_id": registro["_id"]}, {"$set": {"validado": True, "validadoEn": ahora()}})
                return self.enviar_json({"mensaje": "Correo validado. Ya puedes crear tu contrasena"})

            if ruta == "/api/usuarios/registro":
                portal = datos.get("portal")
                coleccion = col("reclutas" if portal == "recluta" else portal)
                filtro = {"correo": normalizar_correo(datos.get("correo"))} if portal == "recluta" else {"numeroReloj": datos.get("numeroReloj")}
                if coleccion.find_one(filtro):
                    return self.enviar_json({"mensaje": "El usuario ya existe"}, 409)
                token_ok = col("tokensCorreo").find_one({
                    "portal": portal,
                    "correo": normalizar_correo(datos.get("correo")),
                    "validado": True,
                    "expiraEn": {"$gt": ahora()},
                })
                if not token_ok:
                    return self.enviar_json({"mensaje": "Primero valida el correo electronico con el token enviado"}, 400)
                usuario = {
                    "nombreCompleto": datos.get("nombreCompleto"),
                    "correo": normalizar_correo(datos.get("correo")),
                    "telefono": datos.get("telefono", ""),
                    "numeroReloj": datos.get("numeroReloj", ""),
                    "contrasena": datos.get("contrasena"),
                    "rol": portal,
                    "creadoEn": ahora(),
                }
                resultado = coleccion.insert_one(usuario)
                usuario["_id"] = resultado.inserted_id
                col("tokensCorreo").delete_many({"portal": portal, "correo": usuario["correo"]})
                registrar_bitacora("registro_usuario", portal, resultado.inserted_id, usuario["nombreCompleto"])
                return self.enviar_json(limpiar_usuario(usuario), 201)

            if ruta == "/api/usuarios/sesion":
                portal = datos.get("portal")
                coleccion = col("reclutas" if portal == "recluta" else portal)
                filtro = {"correo": normalizar_correo(datos.get("correo")), "contrasena": datos.get("contrasena")} if portal == "recluta" else {"numeroReloj": datos.get("numeroReloj"), "contrasena": datos.get("contrasena")}
                usuario = coleccion.find_one(filtro)
                if not usuario:
                    return self.enviar_json({"mensaje": "No existe el usuario o la contrasena no coincide"}, 401)
                return self.enviar_json(limpiar_usuario(usuario))

            if ruta == "/api/postulaciones":
                recluta = col("reclutas").find_one({"_id": ObjectId(datos.get("reclutaId"))})
                vacante = col("vacantes").find_one({"_id": ObjectId(datos.get("vacanteId"))})
                if not recluta or not vacante:
                    return self.enviar_json({"mensaje": "Recluta o vacante no encontrada"}, 404)
                if vacante.get("ocupada"):
                    return self.enviar_json({"mensaje": "Esta vacante ya fue ocupada y no esta disponible"}, 409)
                existente = col("postulaciones").find_one({"reclutaId": recluta["_id"], "estado": {"$in": ["CV enviado a RH", "Acceso autorizado por RH", "Biometria pendiente de revision RH", "Biometria rechazada por RH", "Acceso listo para Seguridad", "Acceso verificado por Seguridad", "Asistio a entrevista"]}})
                if existente:
                    if datos.get("cv"):
                        col("postulaciones").update_one(
                            {"_id": existente["_id"]},
                            {"$set": {
                                "cv": datos.get("cv", {}),
                                "estado": "CV enviado a RH",
                                "razonRechazo": "",
                                "actualizadaEn": ahora(),
                            }},
                        )
                        existente = col("postulaciones").find_one({"_id": existente["_id"]})
                    return self.enviar_json(agregar_biometria(existente))
                post = {
                    "reclutaId": recluta["_id"],
                    "nombreRecluta": recluta["nombreCompleto"],
                    "correoRecluta": recluta["correo"],
                    "telefonoRecluta": recluta.get("telefono", ""),
                    "vacanteId": vacante["_id"],
                    "tituloVacante": vacante["titulo"],
                    "areaVacante": vacante.get("area", ""),
                    "horarioVacante": vacante.get("horario", ""),
                    "turnoVacante": vacante.get("turno", vacante.get("horario", "")),
                    "ubicacionVacante": vacante.get("ubicacion", ""),
                    "descripcionVacante": vacante.get("descripcion", ""),
                    "queEsVacante": vacante.get("queEs", vacante.get("area", "")),
                    "estado": "CV enviado a RH",
                    "cv": datos.get("cv", {}),
                    "fechaEntrevista": "",
                    "horaLimite": "",
                    "entrevistador": "",
                    "direccion": "",
                    "creadaEn": ahora(),
                    "actualizadaEn": ahora(),
                }
                resultado = col("postulaciones").insert_one(post)
                post["_id"] = resultado.inserted_id
                return self.enviar_json(post, 201)

            if ruta == "/api/rh/vacantes":
                vacante = {
                    "clave": "vac-" + str(int(datetime.now().timestamp())),
                    "titulo": datos.get("titulo", "").strip(),
                    "area": datos.get("area", "").strip(),
                    "horario": datos.get("horario", "").strip(),
                    "turno": datos.get("turno", "").strip(),
                    "ubicacion": datos.get("ubicacion", "").strip(),
                    "queEs": datos.get("queEs", "").strip(),
                    "descripcion": datos.get("descripcion", "").strip(),
                    "activa": True,
                    "creadaEn": ahora(),
                    "creadaPor": "RH",
                }
                if not vacante["titulo"] or not vacante["descripcion"]:
                    return self.enviar_json({"mensaje": "Completa los datos de la vacante"}, 400)
                resultado = col("vacantes").insert_one(vacante)
                vacante["_id"] = resultado.inserted_id
                registrar_bitacora("vacante_creada", "rh", resultado.inserted_id, vacante["titulo"])
                return self.enviar_json(vacante, 201)

            return self.enviar_json({"mensaje": "Ruta no encontrada"}, 404)
        except Exception as error:
            return self.enviar_json({"mensaje": str(error)}, 500)

    def do_PUT(self):
        ruta = urlparse(self.path).path
        datos = self.leer_json()
        try:
            if ruta.startswith("/api/postulaciones/") and ruta.endswith("/biometria"):
                post_id = ObjectId(ruta.split("/")[3])
                post = col("postulaciones").find_one({"_id": post_id})
                if not post:
                    return self.enviar_json({"mensaje": "Postulacion no encontrada"}, 404)
                if post.get("estado") not in ["Acceso autorizado por RH", "Biometria rechazada por RH"]:
                    return self.enviar_json({"mensaje": "RH debe dar acceso antes de capturar biometria"}, 400)
                bio = {
                    "postulacionId": post_id,
                    "reclutaId": post["reclutaId"],
                    "nombreRecluta": post["nombreRecluta"],
                    "imagenBase64": datos.get("imagenBase64"),
                    "aceptoPrivacidad": bool(datos.get("aceptoPrivacidad")),
                    "capturadaEn": ahora(),
                }
                col("biometria").update_one({"postulacionId": post_id}, {"$set": bio}, upsert=True)
                col("postulaciones").update_one({"_id": post_id}, {"$set": {"estado": "Biometria pendiente de revision RH", "mensajeAutomatico": "RH revisara tu imagen biometrica. Si no es validada deberas capturarla de nuevo antes de agendar entrevista.", "razonRechazo": "", "requiereNuevaBiometria": False, "actualizadaEn": ahora()}})
                post.update({"estado": "Biometria pendiente de revision RH"})
                return self.enviar_json(agregar_biometria(post))
            return self.enviar_json({"mensaje": "Ruta no encontrada"}, 404)
        except Exception as error:
            return self.enviar_json({"mensaje": str(error)}, 500)

    def do_PATCH(self):
        ruta = urlparse(self.path).path
        datos = self.leer_json()
        try:
            if ruta.startswith("/api/notificaciones/recluta/") and ruta.endswith("/leer"):
                recluta_id = ObjectId(ruta.split("/")[4])
                col("notificaciones").update_many({"reclutaId": recluta_id, "leida": False}, {"$set": {"leida": True, "leidaEn": ahora()}})
                return self.enviar_json({"ok": True, "noLeidas": 0})
            if ruta.startswith("/api/rh/postulaciones/"):
                post_id = ObjectId(ruta.rsplit("/", 1)[1])
                estado = datos.get("estado")
                campos = {
                    "estado": estado,
                    "razonRechazo": datos.get("razonRechazo", ""),
                    "actualizadaEn": ahora(),
                }
                if estado == "Acceso autorizado por RH":
                    campos["mensajeAutomatico"] = "RH valido tu CV para entrevista. Registra tus datos biometricos para agendarte una entrevista."
                    campos["requiereNuevaBiometria"] = True
                if estado == "Biometria rechazada por RH":
                    campos["mensajeAutomatico"] = "RH no valido tu imagen biometrica. Entra a Datos biometricos y vuelve a capturar tu rostro con buena luz y de frente para poder agendar la entrevista."
                    campos["requiereNuevaBiometria"] = True
                if estado == "Acceso listo para Seguridad":
                    campos["mensajeAutomatico"] = "RH valido tu imagen biometrica. Tu entrevista ya fue agendada y tu acceso esta disponible para Seguridad."
                    campos["requiereNuevaBiometria"] = False
                    campos["fechaEntrevista"] = fecha_proxima()
                    campos["horaLimite"] = "17:00"
                    campos["entrevistador"] = "Mariana RH"
                    campos["direccion"] = "Av. Horizonte 214, Parque Industrial Nova"
                if estado == "Perfil egresado generado":
                    postulacion_actual = col("postulaciones").find_one({"_id": post_id})
                    vacante = None
                    if postulacion_actual and postulacion_actual.get("vacanteId"):
                        vacante = col("vacantes").find_one({"_id": postulacion_actual["vacanteId"]})
                    campos["asistioEntrevista"] = True
                    campos["pasoEntrevista"] = True
                    campos["fechaInduccion"] = fecha_proxima()
                    campos["mensajeAutomatico"] = "Pasaste la entrevista. RH genero tu perfil egresado con tu puesto e imagen biometrica."
                    campos["razonRechazo"] = ""
                    if vacante:
                        campos["tituloVacante"] = vacante.get("titulo", postulacion_actual.get("tituloVacante", ""))
                        campos["areaVacante"] = vacante.get("area", postulacion_actual.get("areaVacante", ""))
                        campos["horarioVacante"] = vacante.get("horario", postulacion_actual.get("horarioVacante", ""))
                        campos["turnoVacante"] = vacante.get("turno", postulacion_actual.get("turnoVacante", vacante.get("horario", "")))
                        campos["ubicacionVacante"] = vacante.get("ubicacion", postulacion_actual.get("ubicacionVacante", ""))
                        campos["queEsVacante"] = vacante.get("queEs") or vacante.get("area") or postulacion_actual.get("queEsVacante", "Puesto dentro de ContrataT")
                        campos["descripcionVacante"] = vacante.get("descripcion") or postulacion_actual.get("descripcionVacante", "Actividades asignadas al puesto")
                        col("vacantes").update_one({"_id": vacante["_id"]}, {"$set": {"ocupada": True, "ocupadaPor": postulacion_actual.get("nombreRecluta", ""), "ocupadaEn": ahora()}})
                        col("reclutas").update_one({"_id": postulacion_actual["reclutaId"]}, {"$set": {"contratado": True, "tipoUsuario": "empleado", "puestoActual": campos["tituloVacante"], "fechaContratacion": ahora(), "postulacionContratadaId": post_id}})
                if estado == "Asistio a entrevista":
                    campos["asistioEntrevista"] = True
                    campos["mensajeAutomatico"] = "RH registro que asististe a entrevista. Espera el resultado final."
                    campos["razonRechazo"] = ""
                if estado == "No aceptado despues de entrevista":
                    campos["asistioEntrevista"] = True
                    campos["pasoEntrevista"] = False
                    campos["mensajeAutomatico"] = "RH registro que no fuiste aceptado despues de la entrevista."
                if estado == "No asistio a entrevista":
                    campos["asistioEntrevista"] = False
                    campos["pasoEntrevista"] = False
                    campos["mensajeAutomatico"] = "RH registro que no asististe a la entrevista."
                col("postulaciones").update_one({"_id": post_id}, {"$set": campos})
                postulacion_actualizada = agregar_biometria(col("postulaciones").find_one({"_id": post_id}))
                crear_notificacion_postulacion(postulacion_actualizada, campos.get("mensajeAutomatico", ""))
                return self.enviar_json(postulacion_actualizada)
            if ruta.startswith("/api/seguridad/accesos/") and ruta.endswith("/validar"):
                post_id = ObjectId(ruta.split("/")[4])
                post = col("postulaciones").find_one({"_id": post_id})
                if post and fecha_limite_vencida(post):
                    col("postulaciones").update_one(
                        {"_id": post_id},
                        {"$set": {
                            "estado": "Acceso vencido",
                            "razonRechazo": "La hora limite de llegada ya paso",
                            "accesoVencidoEn": ahora(),
                            "actualizadaEn": ahora(),
                        }},
                    )
                    return self.enviar_json({"mensaje": "El acceso ya vencio porque paso la hora limite de llegada"}, 400)
                coincide = bool(datos.get("coincide"))
                estado = "Acceso verificado por Seguridad" if coincide else "Acceso negado por Seguridad"
                campos = {
                    "estado": estado,
                    "rostroCoincide": coincide,
                    "capturaSeguridad": datos.get("capturaSeguridad", ""),
                    "fechaInduccion": fecha_proxima() if coincide else "",
                    "validadoPorSeguridadEn": ahora(),
                    "actualizadaEn": ahora(),
                }
                if not coincide:
                    campos["razonRechazo"] = "El rostro capturado en Seguridad no coincide con la biometria registrada"
                col("postulaciones").update_one({"_id": post_id}, {"$set": campos})
                postulacion_actualizada = agregar_biometria(col("postulaciones").find_one({"_id": post_id}))
                crear_notificacion_postulacion(postulacion_actualizada, campos.get("mensajeAutomatico", ""))
                return self.enviar_json(postulacion_actualizada)
            if ruta.startswith("/api/seguridad/accesos/") and ruta.endswith("/cerrar"):
                post_id = ObjectId(ruta.split("/")[4])
                col("postulaciones").update_one({"_id": post_id}, {"$set": {"estado": "Acceso cerrado", "accesoCerradoEn": ahora(), "actualizadaEn": ahora()}})
                return self.enviar_json(col("postulaciones").find_one({"_id": post_id}))
            if ruta.startswith("/api/postulaciones/") and ruta.endswith("/cancelar"):
                post_id = ObjectId(ruta.split("/")[3])
                cancelada = cancelar_postulacion(post_id)
                if not cancelada:
                    return self.enviar_json({"mensaje": "Postulacion no encontrada"}, 404)
                return self.enviar_json(agregar_biometria(cancelada))
            return self.enviar_json({"mensaje": "Ruta no encontrada"}, 404)
        except Exception as error:
            return self.enviar_json({"mensaje": str(error)}, 500)


if __name__ == "__main__":
    preparar_base()
    servidor = ThreadingHTTPServer(("localhost", PUERTO), Manejador)
    print(f"ContrataT disponible en http://localhost:{PUERTO}")
    print(f"Base de datos: {NOMBRE_BASE}")
    servidor.serve_forever()

















