# ContrataT

Aplicacion web para reclutamiento con tres portales:

- Recluta: registro, inicio de sesion, vacantes, postulacion y captura de imagen biometrica con camara.
- RH: revision de CV, aceptacion/rechazo, entrevista, biometria y perfil egresado.
- Seguridad: accesos autorizados, biometria y rechazados.

## Como abrir en Visual Studio Code

1. Abre la carpeta `ContrataT` en Visual Studio Code.
2. Abre una terminal dentro del proyecto.
3. Ejecuta:

```bash
npm install
npm run iniciar
```

4. Entra a:

```text
http://localhost:3000
```

## Publicar solo Recluta en Render

Para que el enlace publico muestre solamente el portal Recluta, configura Render como Web Service:

```text
Build Command: npm install
Start Command: npm start
```

En Render agrega estas variables de entorno:

```text
PORTAL_PUBLICO=recluta
MONGODB_URI=tu_conexion_de_mongodb_atlas
NOMBRE_BASE_DATOS=ContrataT
```

Con `PORTAL_PUBLICO=recluta`, el servidor:

- Muestra solo Recluta en el portal publico.
- Redirige `rh.html` y `seguridad.html` al inicio.
- Bloquea sesiones, registros y APIs internas de RH/Seguridad.

Para usar RH y Seguridad dentro de la empresa, ejecuta el sistema localmente sin `PORTAL_PUBLICO`:

```bash
npm run iniciar
```

## MongoDB Atlas

La base de datos se llama `ContrataT`.

Colecciones por seccion:

- `seccion_reclutas`
- `seccion_rh`
- `seccion_seguridad`
- `seccion_vacantes`
- `seccion_postulaciones`
- `seccion_biometria`
- `seccion_tokens_correo`
- `seccion_bitacora`

La conexion esta en `.env`.

## Envio de token por correo

El registro funciona asi:

1. El usuario escribe nombre, correo y telefono o numero de reloj.
2. Presiona `Enviar token al correo`.
3. Escribe el token recibido.
4. Presiona `Validar token`.
5. Si coincide, aparece el campo para crear contrasena.

Para enviar correos reales configura estas variables en `.env`:

```text
CORREO_HOST=smtp.gmail.com
CORREO_PUERTO=587
CORREO_SEGURO=false
CORREO_USUARIO=tu_correo@gmail.com
CORREO_CONTRASENA=tu_contrasena_de_aplicacion
CORREO_REMITENTE=ContrataT <tu_correo@gmail.com>
```

Si no configuras SMTP, el sistema funciona en modo prueba y muestra el token en la consola del servidor.

## Usuarios de prueba

RH:

- Numero de reloj: `RH100`
- Contrasena: `123456`

Seguridad:

- Numero de reloj: `SEG100`
- Contrasena: `123456`

Tokens de registro:

- Recluta: `NOVA-2026`
- RH: `RH-2026`
- Seguridad: `SEG-2026`
