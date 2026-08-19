#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "INFINITUM36B5";
const char* WIFI_PASSWORD = "NgGudY9mNx";

// CAMBIA ESTA IP por la IP REAL de tu ESP32 + SERVO
const char* ESP32_SERVO_IP = "192.168.1.221";

WebServer servidor(80);

// AI Thinker ESP32-CAM
camera_config_t camara = {
  .pin_pwdn = 32,
  .pin_reset = -1,
  .pin_xclk = 0,
  .pin_sscb_sda = 26,
  .pin_sscb_scl = 27,

  .pin_d7 = 35,
  .pin_d6 = 34,
  .pin_d5 = 39,
  .pin_d4 = 36,
  .pin_d3 = 21,
  .pin_d2 = 19,
  .pin_d1 = 18,
  .pin_d0 = 5,

  .pin_vsync = 25,
  .pin_href = 23,
  .pin_pclk = 22,

  .xclk_freq_hz = 20000000,
  .ledc_timer = LEDC_TIMER_0,
  .ledc_channel = LEDC_CHANNEL_0,

  .pixel_format = PIXFORMAT_JPEG,

  // Más rápido que QVGA
  .frame_size = FRAMESIZE_QVGA,
  .jpeg_quality = 25,
  .fb_count = 2,

  .grab_mode = CAMERA_GRAB_LATEST
};

void enviarCors() {
  servidor.sendHeader("Access-Control-Allow-Origin", "*");
  servidor.sendHeader("Cache-Control", "no-store");
}

// ==========================================
// CAPTURA UNA FOTO ACTUAL
// ==========================================

void captura() {

  camera_fb_t* foto = esp_camera_fb_get();

  if (!foto) {

    enviarCors();

    servidor.send(
      503,
      "text/plain",
      "No se pudo capturar la imagen"
    );

    return;
  }

  enviarCors();

  servidor.setContentLength(foto->len);

  servidor.send(
    200,
    "image/jpeg",
    ""
  );

  WiFiClient cliente = servidor.client();

  cliente.write(
    foto->buf,
    foto->len
  );

  esp_camera_fb_return(foto);
}

// ==========================================
// STREAM DE VIDEO
// ==========================================

void stream() {

  WiFiClient cliente = servidor.client();

  cliente.print(
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
    "Cache-Control: no-cache\r\n"
    "Access-Control-Allow-Origin: *\r\n"
    "Connection: close\r\n\r\n"
  );

  while (cliente.connected()) {

    camera_fb_t* foto = esp_camera_fb_get();

    if (!foto) {
      Serial.println("Error capturando frame");
      break;
    }

    cliente.print("--frame\r\n");
    cliente.print("Content-Type: image/jpeg\r\n");
    cliente.print("Content-Length: ");
    cliente.print(foto->len);
    cliente.print("\r\n\r\n");

    cliente.write(
      foto->buf,
      foto->len
    );

    cliente.print("\r\n");

    esp_camera_fb_return(foto);

    delay(50);
  }

  cliente.stop();
}

// ==========================================
// MANDA ORDEN AL ESP32 DEL SERVO
// ==========================================

void abrirPuerta() {

  enviarCors();

  HTTPClient http;

  String url =
    "http://" +
    String(ESP32_SERVO_IP) +
    "/abrir";

  Serial.print("Enviando señal al ESP32: ");
  Serial.println(url);

  http.begin(url);

  int codigo = http.GET();

  if (codigo > 0) {

    Serial.print("Respuesta ESP32: ");
    Serial.println(codigo);

    servidor.send(
      200,
      "application/json",
      "{\"ok\":true,\"mensaje\":\"Señal enviada al ESP32 del servo\"}"
    );

  } else {

    Serial.print("Error conectando al ESP32: ");
    Serial.println(codigo);

    servidor.send(
      500,
      "application/json",
      "{\"ok\":false,\"mensaje\":\"No se pudo conectar con el ESP32 del servo\"}"
    );
  }

  http.end();
}

// ==========================================
// ESTADO
// ==========================================

void estado() {

  enviarCors();

  servidor.send(
    200,
    "application/json",
    "{\"ok\":true,\"equipo\":\"ContrataT ESP32-CAM\"}"
  );
}

// ==========================================
// SETUP
// ==========================================

void setup() {

  Serial.begin(115200);

  Serial.println();
  Serial.println("Iniciando ContrataT ESP32-CAM...");

  if (esp_camera_init(&camara) != ESP_OK) {

    Serial.println(
      "ERROR: no se detecto la camara OV2640."
    );

    while (true) {
      delay(1000);
    }
  }

  Serial.println("Camara OK");

  WiFi.mode(WIFI_STA);

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );

  Serial.print("Conectando a WiFi");

  while (WiFi.status() != WL_CONNECTED) {

    delay(500);

    Serial.print(".");
  }

  Serial.println();

  Serial.println("WiFi conectado");

  Serial.print("ESP32-CAM IP: ");
  Serial.println(WiFi.localIP());

  Serial.println();
  Serial.println("Endpoints:");
  Serial.println("/captura");
  Serial.println("/stream");
  Serial.println("/abrir");

  servidor.on(
    "/",
    HTTP_GET,
    estado
  );

  servidor.on(
    "/captura",
    HTTP_GET,
    captura
  );

  servidor.on(
    "/stream",
    HTTP_GET,
    stream
  );

  servidor.on(
    "/abrir",
    HTTP_GET,
    abrirPuerta
  );

  servidor.onNotFound(
    []() {

      enviarCors();

      servidor.send(
        404,
        "text/plain",
        "Ruta no encontrada"
      );
    }
  );

  servidor.begin();

  Serial.println("Servidor iniciado");
}

void loop() {

  servidor.handleClient();
}