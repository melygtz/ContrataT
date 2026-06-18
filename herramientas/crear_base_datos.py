from pathlib import Path
from pymongo import MongoClient


RAIZ = Path(__file__).resolve().parents[1]
ARCHIVO_ENV = RAIZ / ".env"


def leer_env():
    valores = {}
    for linea in ARCHIVO_ENV.read_text(encoding="utf-8").splitlines():
        if "=" in linea and not linea.strip().startswith("#"):
            clave, valor = linea.split("=", 1)
            valores[clave.strip()] = valor.strip()
    return valores


def main():
    env = leer_env()
    uri = env["MONGODB_URI"]
    nombre_base = env.get("NOMBRE_BASE_DATOS", "ContrataT")

    cliente = MongoClient(uri, serverSelectionTimeoutMS=15000)
    cliente.admin.command("ping")
    base = cliente[nombre_base]

    colecciones = {
        "seccion_reclutas": {
            "tipo": "seccion_reclutas",
            "descripcion": "Usuarios candidatos registrados desde Recluta",
        },
        "seccion_rh": {
            "tipo": "seccion_rh",
            "nombreCompleto": "Mariana RH",
            "numeroReloj": "RH100",
            "correo": "rh@ContrataT.mx",
            "contrasena": "123456",
            "rol": "rh",
        },
        "seccion_seguridad": {
            "tipo": "seccion_seguridad",
            "nombreCompleto": "Luis Seguridad",
            "numeroReloj": "SEG100",
            "correo": "seguridad@ContrataT.mx",
            "contrasena": "123456",
            "rol": "seguridad",
        },
        "seccion_vacantes": {
            "tipo": "seccion_vacantes",
            "clave": "op-prod",
            "titulo": "Operador de produccion",
            "area": "Manufactura",
            "horario": "Lunes a viernes",
            "ubicacion": "Planta Norte",
            "descripcion": "Operacion de linea, inspeccion de calidad y reporte de incidencias.",
            "activa": True,
        },
        "seccion_postulaciones": {
            "tipo": "seccion_postulaciones",
            "descripcion": "Aqui se guardan las postulaciones enviadas por Recluta",
        },
        "seccion_biometria": {
            "tipo": "seccion_biometria",
            "descripcion": "Aqui se guarda la imagen biometrica capturada por Recluta",
        },
        "seccion_tokens_correo": {
            "tipo": "seccion_tokens_correo",
            "descripcion": "Tokens temporales para validar correo antes de crear contrasena",
        },
        "seccion_bitacora": {
            "tipo": "seccion_bitacora",
            "accion": "base_inicializada",
            "seccion": "sistema",
        },
    }

    for nombre, documento in colecciones.items():
        base.create_collection(nombre) if nombre not in base.list_collection_names() else None
        if base[nombre].count_documents({}) == 0:
            base[nombre].insert_one(documento)

    print(f"Base de datos lista: {nombre_base}")
    print("Colecciones:")
    for nombre in sorted(base.list_collection_names()):
        print(f"- {nombre}")


if __name__ == "__main__":
    main()
