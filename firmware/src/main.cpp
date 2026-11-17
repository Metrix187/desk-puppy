// Desk Puppy: a CYD companion that reacts to your pulse and breathing.
//
// The PC bridge reads live signals with the Presage SmartSpectra SDK and sends
// one line over USB serial about ten times a second:
//
//   V,<pulse bpm>,<breaths per min>,<state>,<chest -100..100>\n
//
// Any field may be "x" when the SDK has no value yet.
// States: 0 searching, 1 awake, 2 sleepy, 3 breath held, 4 excited.
// Sending "?" makes the board answer "PUPPY 1" so the bridge can find the port.
// Sending "I" toggles colour inversion for CYD panels that need it. The choice
// is remembered across power cycles and the board answers "INVERT 0" or "INVERT 1".

#include <Arduino.h>
#include <Preferences.h>
#include <TFT_eSPI.h>

TFT_eSPI tft;
Preferences prefs;
TFT_eSprite scene(&tft);

static const int SW = 220, SH = 150, SX = 50, SY = 34;
static const uint32_t LINK_TIMEOUT_MS = 4000;

enum State : uint8_t { SEARCH = 0, AWAKE = 1, SLEEPY = 2, HOLD = 3, EXCITED = 4 };

struct Vitals {
  float bpm = 0;
  float br = 0;
  State state = SEARCH;
  bool hasChest = false;
  float chest = 0;
} v;

uint32_t lastMsgMs = 0;
bool linked = false;
bool inverted = false;
float wagPhase = 0, breathPhase = 0, chestNow = 0;
uint32_t lastFrameMs = 0;
char lineBuf[64];
uint8_t lineLen = 0;

uint16_t C_BG, C_FUR, C_EAR, C_CREAM, C_PINK, C_GROUND, C_HEART, C_DIM, C_INK;

void handleLine(char *s) {
  if (s[0] == '?') { Serial.println("PUPPY 1"); return; }
  if (s[0] == 'I') {
    inverted = !inverted;
    tft.invertDisplay(inverted);
    prefs.putBool("inv", inverted);
    Serial.printf("INVERT %d\n", inverted ? 1 : 0);
    return;
  }
  if (s[0] != 'V') return;

  float vals[4] = {0, 0, 0, 0};
  bool present[4] = {false, false, false, false};
  strtok(s, ",");
  for (int i = 0; i < 4; i++) {
    char *tok = strtok(nullptr, ",");
    if (!tok) break;
    if (tok[0] != 'x' && tok[0] != '\0') { vals[i] = atof(tok); present[i] = true; }
  }
  v.bpm = present[0] ? constrain(vals[0], 0.0f, 220.0f) : 0;
  v.br = present[1] ? constrain(vals[1], 0.0f, 60.0f) : 0;
  int st = present[2] ? (int)vals[2] : 0;
  v.state = (st >= 0 && st <= 4) ? (State)st : SEARCH;
  v.hasChest = present[3];
  if (present[3]) v.chest = constrain(vals[3], -100.0f, 100.0f) / 100.0f;
  lastMsgMs = millis();
  linked = true;
}

void readSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen > 0) { lineBuf[lineLen] = '\0'; handleLine(lineBuf); lineLen = 0; }
    } else if (lineLen < sizeof(lineBuf) - 1) {
      lineBuf[lineLen++] = c;
    } else {
      lineLen = 0;
    }
  }
}

const char *statusText(State s) {
  if (!linked) return "waiting for PC...";
  switch (s) {
    case AWAKE: return "hi!! i see you";
    case SLEEPY: return "sleepy pup...";
    case HOLD: return "hey! breathe!";
    case EXCITED: return "zoomies!!";
    default: return "sniffing for you...";
  }
}

void drawHud(bool force) {
  static int lastBpm = -2, lastBr10 = -2;
  static const char *lastStatus = nullptr;
  int bpm = (linked && v.bpm > 0) ? (int)roundf(v.bpm) : -1;
  int br10 = (linked && v.br > 0) ? (int)roundf(v.br * 10) : -1;
  const char *status = statusText(v.state);
  char buf[24];

  if (force || status != lastStatus) {
    tft.setTextColor(v.state == HOLD && linked ? C_HEART : TFT_WHITE, C_BG);
    tft.setTextDatum(TR_DATUM);
    tft.setTextPadding(190);
    tft.drawString(status, 312, 8, 2);
    lastStatus = status;
  }
  if (force || bpm != lastBpm) {
    if (bpm < 0) snprintf(buf, sizeof(buf), "-- bpm"); else snprintf(buf, sizeof(buf), "%d bpm", bpm);
    tft.setTextColor(C_HEART, C_BG);
    tft.setTextDatum(TL_DATUM);
    tft.setTextPadding(150);
    tft.drawString(buf, 10, 192, 4);
    lastBpm = bpm;
  }
  if (force || br10 != lastBr10) {
    if (br10 < 0) snprintf(buf, sizeof(buf), "-- /min"); else snprintf(buf, sizeof(buf), "%d.%d /min", br10 / 10, br10 % 10);
    tft.setTextColor(TFT_CYAN, C_BG);
    tft.setTextDatum(TR_DATUM);
    tft.setTextPadding(150);
    tft.drawString(buf, 310, 192, 4);
    lastBr10 = br10;
  }
  if (force) {
    tft.setTextPadding(0);
    tft.setTextColor(C_DIM, C_BG);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("desk puppy", 8, 8, 2);
    tft.drawString("pulse", 10, 220, 2);
    tft.setTextDatum(TR_DATUM);
    tft.drawString("breathing", 310, 220, 2);
  }
}

void drawHeart(int cx, int cy, int r, uint16_t col) {
  scene.fillCircle(cx - r / 2, cy - r / 3, r / 2 + 1, col);
  scene.fillCircle(cx + r / 2, cy - r / 3, r / 2 + 1, col);
  scene.fillTriangle(cx - r, cy - r / 6, cx + r, cy - r / 6, cx, cy + r, col);
}

void drawTail(float angDeg) {
  float a = angDeg * DEG_TO_RAD;
  for (int i = 0; i <= 9; i++) {
    float f = i / 9.0f;
    float aa = a + f * 0.4f;
    int x = 62 + (int)(cosf(aa) * 36 * f);
    int y = 112 - (int)(sinf(aa) * 36 * f);
    scene.fillCircle(x, y, 6 - (int)(3 * f), i >= 8 ? C_CREAM : C_FUR);
  }
}

void drawScene(float t) {
  State s = linked ? v.state : SEARCH;
  scene.fillSprite(C_BG);

  // Chest follows the live breathing trace when the bridge sends one.
  float breath = v.hasChest && linked ? chestNow : sinf(breathPhase);
  if (s == HOLD) breath *= 0.15f;
  int bx = (int)roundf(breath * 3), by = (int)roundf(breath * 4);

  float wagAmp = 24, headDrop = 0;
  if (s == EXCITED) wagAmp = 42;
  if (s == SLEEPY) { wagAmp = 4; headDrop = 16; }
  if (s == HOLD) wagAmp = 8;
  if (s == SEARCH) wagAmp = 10;
  float bob = (s == EXCITED) ? fabsf(sinf(wagPhase)) * 4 : 0;

  // Cushion and tail.
  scene.fillEllipse(108, 136, 86, 10, C_GROUND);
  drawTail(125 + wagAmp * sinf(wagPhase));

  // Body, haunch, belly, feet.
  scene.fillEllipse(96, 106 - by / 2, 38 + bx, 30 + by, C_FUR);
  scene.fillEllipse(78, 122, 22, 15, C_FUR);
  scene.fillEllipse(110, 112 - by / 2, 19 + bx, 19 + by, C_CREAM);
  scene.fillEllipse(92, 134, 13, 6, C_CREAM);
  if (s == HOLD) {
    // One front paw taps at the glass.
    float tap = fabsf(sinf(t * 7.0f));
    int px = 150 + (int)(tap * 14), py = 108 - (int)(tap * 10);
    scene.drawWideLine(122, 112, px, py, 9, C_FUR, C_BG);
    scene.fillEllipse(px + 3, py, 9, 7, C_CREAM);
  } else {
    scene.fillEllipse(124, 134, 13, 6, C_CREAM);
  }

  // Head.
  int hx = 138, hy = 62 + (int)headDrop - (int)bob - by / 3;
  if (s == SEARCH) hx += (int)(sinf(t * 1.3f) * 4);
  scene.fillCircle(hx, hy, 30, C_FUR);
  scene.fillEllipse(hx + 22, hy + 10, 16, 12, C_CREAM);
  scene.fillCircle(hx + 35, hy + 6, 4, C_INK);
  scene.drawLine(hx + 24, hy + 16, hx + 34, hy + 15, C_INK);
  float earFlap = (s == EXCITED) ? sinf(wagPhase * 2) * 3 : 0;
  scene.fillEllipse(hx - 18, hy - 2 + (int)earFlap, 10, 23, C_EAR);

  // Eye: closed when sleepy or blinking, wandering while searching.
  bool blink = fmodf(t, 4.2f) < 0.15f;
  int ex = hx + 8, ey = hy - 6;
  if (s == SLEEPY || blink) {
    scene.drawLine(ex - 5, ey, ex + 5, ey, C_INK);
    scene.drawLine(ex - 5, ey + 1, ex + 5, ey + 1, C_INK);
  } else {
    int look = (s == SEARCH) ? (int)(sinf(t * 1.3f) * 2) : 0;
    scene.fillCircle(ex, ey, s == HOLD ? 6 : 5, TFT_WHITE);
    scene.fillCircle(ex + 1 + look, ey, 3, C_INK);
  }
  if (s == EXCITED) scene.fillEllipse(hx + 26, hy + 24, 5, 8, C_PINK);

  // Extras per state.
  scene.setTextDatum(MC_DATUM);
  if (s == SLEEPY) {
    scene.setTextColor(TFT_CYAN, C_BG);
    float f = fmodf(t * 0.5f, 1.0f);
    scene.drawString("z", 176 + (int)(f * 14), 44 - (int)(f * 26), 2);
    scene.drawString("Z", 186 + (int)(f * 10), 26 - (int)(f * 14), 4);
  } else if (s == HOLD) {
    scene.setTextColor(C_HEART, C_BG);
    if (fmodf(t, 0.6f) < 0.4f) scene.drawString("!", 186, 34, 4);
  } else if (s == SEARCH) {
    scene.setTextColor(C_DIM, C_BG);
    scene.drawString("?", 186, 34, 4);
  }

  // Heart in the corner beats once per pulse.
  if (linked && v.bpm > 0) {
    float beat = fmodf(wagPhase / TWO_PI, 1.0f);
    drawHeart(22, 22, beat < 0.25f ? 13 : 10, C_HEART);
  } else {
    drawHeart(22, 22, 10, C_DIM);
  }

  scene.pushSprite(SX, SY);
}

void setup() {
  Serial.begin(115200);
  // The CYD's back RGB LED is active low; keep it dark.
  for (int pin : {4, 16, 17}) { pinMode(pin, OUTPUT); digitalWrite(pin, HIGH); }

  prefs.begin("puppy", false);
  inverted = prefs.getBool("inv", false);

  tft.init();
  tft.setRotation(1);
  if (inverted) tft.invertDisplay(true);

  C_BG = tft.color565(14, 16, 34);
  C_FUR = tft.color565(222, 170, 104);
  C_EAR = tft.color565(140, 90, 50);
  C_CREAM = tft.color565(250, 235, 210);
  C_PINK = tft.color565(255, 120, 150);
  C_GROUND = tft.color565(52, 44, 92);
  C_HEART = tft.color565(255, 70, 100);
  C_DIM = tft.color565(120, 124, 150);
  C_INK = tft.color565(20, 16, 20);

  tft.fillScreen(C_BG);
  scene.setColorDepth(16);
  if (scene.createSprite(SW, SH) == nullptr) {
    scene.setColorDepth(8);
    scene.createSprite(SW, SH);
  }
  drawHud(true);
  Serial.println("PUPPY 1");
  lastFrameMs = millis();
}

void loop() {
  readSerial();
  uint32_t now = millis();
  if (linked && now - lastMsgMs > LINK_TIMEOUT_MS) linked = false;
  if (now - lastFrameMs < 40) return;
  float dt = (now - lastFrameMs) / 1000.0f;
  lastFrameMs = now;

  // Tail wags once per heartbeat; idle speed when there is no pulse yet.
  float bpm = (linked && v.bpm > 0) ? v.bpm : 45;
  wagPhase += TWO_PI * (bpm / 60.0f) * dt;
  if (wagPhase > TWO_PI * 1000) wagPhase -= TWO_PI * 1000;
  float br = (linked && v.br > 0) ? v.br : 12;
  breathPhase += TWO_PI * (br / 60.0f) * dt;
  if (breathPhase > TWO_PI * 1000) breathPhase -= TWO_PI * 1000;
  chestNow += (v.chest - chestNow) * min(1.0f, dt * 8.0f);

  drawScene(now / 1000.0f);
  drawHud(false);
}
